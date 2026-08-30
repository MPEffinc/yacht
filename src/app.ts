import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { resolve, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { YachtGameError } from "./game/game.js";
import {
  clientMessageSchema,
  makeErrorMessage,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.js";
import {
  DEFAULT_MAX_PLAYERS,
  DEFAULT_RECONNECT_GRACE_MS,
  RoomError,
  RoomService,
  type JoinResult,
} from "./room-service.js";

export const BASE_PATH = "/yacht/";
export const HEALTH_PATH = `${BASE_PATH}api/health`;
export const WEBSOCKET_PATH = `${BASE_PATH}ws`;

const MAX_MESSAGE_BYTES = 16 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;

interface SessionBinding {
  roomId: string;
  playerId: string;
}

interface SocketContext {
  binding?: SessionBinding;
}

export interface YachtApplicationOptions {
  reconnectGraceMs?: number;
  roomService?: RoomService;
  clientRoot?: string;
}

export interface YachtApplication {
  httpServer: HttpServer;
  roomService: RoomService;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function extension(pathname: string): string {
  const index = pathname.lastIndexOf(".");
  return index < 0 ? "" : pathname.slice(index);
}

function sendBody(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: Buffer | string,
  cacheControl = "no-store",
): void {
  const length = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
  response.writeHead(statusCode, {
    ...securityHeaders,
    "Cache-Control": cacheControl,
    "Content-Type": contentType,
    "Content-Length": length,
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  sendBody(
    request,
    response,
    statusCode,
    "application/json; charset=utf-8",
    JSON.stringify(body),
  );
}

function requestIdFrom(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("requestId" in value)) return undefined;
  return typeof value.requestId === "string" && value.requestId.length <= 64
    ? value.requestId
    : undefined;
}

export function createYachtApplication(
  options: YachtApplicationOptions = {},
): YachtApplication {
  const clientRoot = resolve(options.clientRoot ?? resolve(process.cwd(), "dist/client"));
  const roomService =
    options.roomService ??
    new RoomService({
      reconnectGraceMs: options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS,
    });
  const webSocketServer = new WebSocketServer({ noServer: true });
  const socketContexts = new WeakMap<WebSocket, SocketContext>();
  const playerSockets = new Map<string, WebSocket>();
  const expiryTimers = new Map<string, NodeJS.Timeout>();
  const liveSockets = new WeakSet<WebSocket>();
  let closing = false;

  function sendMessage(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  async function serveFile(
    request: IncomingMessage,
    response: ServerResponse,
    filePath: string,
    cacheControl = "no-store",
  ): Promise<boolean> {
    try {
      const contents = await readFile(filePath);
      sendBody(
        request,
        response,
        200,
        contentTypes[extension(filePath)] ?? "application/octet-stream",
        contents,
        cacheControl,
      );
      return true;
    } catch {
      return false;
    }
  }

  const httpServer = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const readable = request.method === "GET" || request.method === "HEAD";

      if (readable && url.pathname === "/yacht") {
        response.writeHead(308, { Location: BASE_PATH });
        response.end();
        return;
      }
      if (readable && url.pathname === HEALTH_PATH) {
        sendJson(request, response, 200, { ok: true });
        return;
      }
      if (!readable || !url.pathname.startsWith(BASE_PATH)) {
        sendJson(request, response, 404, { ok: false, message: "Not found" });
        return;
      }

      const relativePath = url.pathname.slice(BASE_PATH.length);
      if (relativePath && relativePath.includes(".")) {
        const filePath = resolve(clientRoot, relativePath);
        const insideClientRoot = filePath.startsWith(`${clientRoot}${sep}`);
        if (
          insideClientRoot &&
          (await serveFile(request, response, filePath, "public, max-age=31536000, immutable"))
        ) {
          return;
        }
      }

      const isSpaRoute =
        url.pathname === BASE_PATH ||
        /^\/yacht\/r\/[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}\/?$/.test(url.pathname);
      if (isSpaRoute && (await serveFile(request, response, resolve(clientRoot, "index.html")))) {
        return;
      }
      sendJson(request, response, 404, { ok: false, message: "Not found" });
    })().catch(() => {
      if (!response.headersSent) {
        sendJson(request, response, 500, { ok: false, message: "Internal server error" });
      } else {
        response.destroy();
      }
    });
  });

  function clearExpiry(playerId: string): void {
    const timer = expiryTimers.get(playerId);
    if (timer) clearTimeout(timer);
    expiryTimers.delete(playerId);
  }

  function broadcastRoom(roomId: string): void {
    const room = roomService.getRoom(roomId);
    if (!room) return;
    const message: ServerMessage = { event: "ROOM_VIEW", room: roomService.getSnapshot(roomId) };
    for (const player of room.players.values()) {
      const socket = playerSockets.get(player.id);
      if (socket) sendMessage(socket, message);
    }
  }

  function broadcastGameAborted(roomId: string): void {
    const room = roomService.getRoom(roomId);
    if (!room) return;
    const message: ServerMessage = {
      event: "GAME_ABORTED",
      message:
        "플레이어가 게임에서 나가 현재 게임이 종료되었습니다. 다시 Ready 후 시작할 수 있습니다.",
    };
    for (const player of room.players.values()) {
      const socket = playerSockets.get(player.id);
      if (socket) sendMessage(socket, message);
    }
  }

  function sendRoomView(socket: WebSocket, roomId: string): void {
    if (!roomService.getRoom(roomId)) return;
    sendMessage(socket, { event: "ROOM_VIEW", room: roomService.getSnapshot(roomId) });
  }

  function scheduleExpiry(
    roomId: string,
    playerId: string,
    reconnectDeadline: number,
  ): void {
    clearExpiry(playerId);
    const timer = setTimeout(() => {
      expiryTimers.delete(playerId);
      const removal = roomService.expireDisconnected(
        roomId,
        playerId,
        reconnectDeadline,
        Date.now(),
      );
      if (removal?.room) {
        if (removal.gameAborted) broadcastGameAborted(roomId);
        broadcastRoom(roomId);
      }
    }, Math.max(0, reconnectDeadline - Date.now()) + 5);
    timer.unref();
    expiryTimers.set(playerId, timer);
  }

  function bindSession(
    socket: WebSocket,
    context: SocketContext,
    result: JoinResult,
    requestId: string,
    reconnected: boolean,
  ): void {
    const oldSocket = playerSockets.get(result.player.id);
    if (oldSocket && oldSocket !== socket) {
      const oldContext = socketContexts.get(oldSocket);
      if (oldContext) oldContext.binding = undefined;
      oldSocket.close(4001, "Session replaced");
    }
    clearExpiry(result.player.id);
    context.binding = { roomId: result.room.id, playerId: result.player.id };
    playerSockets.set(result.player.id, socket);
    sendMessage(socket, {
      event: "SESSION_ESTABLISHED",
      requestId,
      roomId: result.room.id,
      playerId: result.player.id,
      sessionToken: result.player.sessionToken,
      reconnected,
    });
  }

  function requireBinding(context: SocketContext): SessionBinding {
    if (!context.binding) throw new RoomError("INVALID_SESSION");
    return context.binding;
  }

  function processMessage(socket: WebSocket, context: SocketContext, message: ClientMessage): void {
    if (message.event === "DIAGNOSTIC_PING") {
      sendMessage(socket, { event: "DIAGNOSTIC_PONG", id: message.id });
      return;
    }

    try {
      switch (message.event) {
        case "CREATE_ROOM": {
          if (context.binding) throw new RoomError("INVALID_SESSION");
          const result = roomService.createRoom(
            message.nickname,
            message.maxPlayers ?? DEFAULT_MAX_PLAYERS,
          );
          bindSession(socket, context, result, message.requestId, false);
          broadcastRoom(result.room.id);
          break;
        }
        case "JOIN_ROOM": {
          if (context.binding) throw new RoomError("INVALID_SESSION");
          const result = roomService.joinRoom(message.roomId, message.nickname);
          bindSession(socket, context, result, message.requestId, false);
          broadcastRoom(result.room.id);
          break;
        }
        case "RECONNECT_ROOM": {
          if (context.binding) throw new RoomError("INVALID_SESSION");
          const result = roomService.reconnectRoom(message.roomId, message.sessionToken);
          bindSession(socket, context, result, message.requestId, true);
          broadcastRoom(result.room.id);
          break;
        }
        case "LEAVE_ROOM": {
          const binding = requireBinding(context);
          const result = roomService.leaveRoom(binding.roomId, binding.playerId);
          clearExpiry(binding.playerId);
          playerSockets.delete(binding.playerId);
          context.binding = undefined;
          sendMessage(socket, {
            event: "LEFT",
            requestId: message.requestId,
            roomId: binding.roomId,
          });
          if (result.room) {
            if (result.gameAborted) broadcastGameAborted(binding.roomId);
            broadcastRoom(binding.roomId);
          }
          break;
        }
        case "SET_READY": {
          const binding = requireBinding(context);
          roomService.setReady(binding.roomId, binding.playerId, message.ready);
          broadcastRoom(binding.roomId);
          sendMessage(socket, {
            event: "COMMAND_OK",
            requestId: message.requestId,
            command: message.event,
          });
          break;
        }
        case "START_GAME": {
          const binding = requireBinding(context);
          roomService.startGame(binding.roomId, binding.playerId);
          broadcastRoom(binding.roomId);
          sendMessage(socket, {
            event: "COMMAND_OK",
            requestId: message.requestId,
            command: message.event,
          });
          break;
        }
        case "ROLL_DICE": {
          const binding = requireBinding(context);
          roomService.rollDice(
            binding.roomId,
            binding.playerId,
            message.expectedRevision,
          );
          broadcastRoom(binding.roomId);
          sendMessage(socket, {
            event: "COMMAND_OK",
            requestId: message.requestId,
            command: message.event,
          });
          break;
        }
        case "SET_HELD_DICE": {
          const binding = requireBinding(context);
          roomService.setHeldDice(
            binding.roomId,
            binding.playerId,
            message.expectedRevision,
            message.heldIndices,
          );
          broadcastRoom(binding.roomId);
          sendMessage(socket, {
            event: "COMMAND_OK",
            requestId: message.requestId,
            command: message.event,
          });
          break;
        }
        case "SCORE_CATEGORY": {
          const binding = requireBinding(context);
          roomService.scoreCategory(
            binding.roomId,
            binding.playerId,
            message.expectedRevision,
            message.category,
          );
          broadcastRoom(binding.roomId);
          sendMessage(socket, {
            event: "COMMAND_OK",
            requestId: message.requestId,
            command: message.event,
          });
          break;
        }
        case "RETURN_TO_LOBBY": {
          const binding = requireBinding(context);
          roomService.returnToLobby(
            binding.roomId,
            binding.playerId,
            message.expectedRevision,
          );
          broadcastRoom(binding.roomId);
          sendMessage(socket, {
            event: "COMMAND_OK",
            requestId: message.requestId,
            command: message.event,
          });
          break;
        }
      }
    } catch (error) {
      const code =
        error instanceof RoomError || error instanceof YachtGameError
          ? error.code
          : "INVALID_MESSAGE";
      sendMessage(socket, makeErrorMessage(code, message.requestId));
      if (code === "STALE_REVISION" && context.binding) {
        sendRoomView(socket, context.binding.roomId);
      }
    }
  }

  webSocketServer.on("connection", (socket) => {
    const context: SocketContext = {};
    socketContexts.set(socket, context);
    liveSockets.add(socket);
    sendMessage(socket, { event: "SERVER_READY", serverTime: new Date().toISOString() });

    socket.on("pong", () => liveSockets.add(socket));
    socket.on("message", (data, isBinary) => {
      if (isBinary || Buffer.byteLength(data.toString()) > MAX_MESSAGE_BYTES) {
        sendMessage(socket, makeErrorMessage("INVALID_MESSAGE"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        sendMessage(socket, makeErrorMessage("INVALID_MESSAGE"));
        return;
      }
      const validation = clientMessageSchema.safeParse(parsed);
      if (!validation.success) {
        sendMessage(socket, makeErrorMessage("INVALID_MESSAGE", requestIdFrom(parsed)));
        return;
      }
      processMessage(socket, context, validation.data);
    });

    socket.on("close", () => {
      const binding = context.binding;
      if (!binding || closing || playerSockets.get(binding.playerId) !== socket) return;
      playerSockets.delete(binding.playerId);
      const result = roomService.markDisconnected(binding.roomId, binding.playerId);
      if (!result) return;
      broadcastRoom(binding.roomId);
      scheduleExpiry(binding.roomId, binding.playerId, result.reconnectDeadline);
    });
    socket.on("error", () => {
      // The close event owns the session transition.
    });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== WEBSOCKET_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });

  const heartbeatTimer = setInterval(() => {
    for (const socket of webSocketServer.clients) {
      if (!liveSockets.has(socket)) {
        socket.terminate();
        continue;
      }
      liveSockets.delete(socket);
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  return {
    httpServer,
    roomService,
    listen(port = 3000, host = "0.0.0.0") {
      return new Promise<number>((resolveListen, reject) => {
        const onError = (error: Error): void => reject(error);
        httpServer.once("error", onError);
        httpServer.listen(port, host, () => {
          httpServer.off("error", onError);
          const address = httpServer.address();
          resolveListen(typeof address === "object" && address ? address.port : port);
        });
      });
    },
    async close() {
      closing = true;
      clearInterval(heartbeatTimer);
      for (const timer of expiryTimers.values()) clearTimeout(timer);
      expiryTimers.clear();
      for (const socket of webSocketServer.clients) socket.terminate();
      await Promise.all([
        new Promise<void>((resolveClose) => webSocketServer.close(() => resolveClose())),
        new Promise<void>((resolveClose, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolveClose()));
        }),
      ]);
    },
  };
}
