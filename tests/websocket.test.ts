import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createYachtApplication,
  type YachtApplication,
} from "../src/app.js";

interface WireMessage {
  event?: string;
  [key: string]: unknown;
}

class TestClient {
  private readonly queue: WireMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: WireMessage) => boolean;
    resolve: (message: WireMessage) => void;
  }> = [];

  private constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as WireMessage;
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex < 0) {
        this.queue.push(message);
        return;
      }
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      waiter.resolve(message);
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const socket = new WebSocket(url);
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return client;
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  sendRaw(message: string): void {
    this.socket.send(message);
  }

  waitFor(predicate: (message: WireMessage) => boolean): Promise<WireMessage> {
    const queuedIndex = this.queue.findIndex(predicate);
    if (queuedIndex >= 0) {
      const [message] = this.queue.splice(queuedIndex, 1);
      return Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("Timed out waiting for WebSocket message"));
      }, 2_000);
      timer.unref();
      waiter.resolve = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
    });
  }

  terminate(): void {
    this.socket.terminate();
  }
}

function roomView(
  predicate: (room: Record<string, unknown>) => boolean,
): (message: WireMessage) => boolean {
  return (message) =>
    message.event === "ROOM_VIEW" &&
    typeof message.room === "object" &&
    message.room !== null &&
    predicate(message.room as Record<string, unknown>);
}

describe("Yacht WebSocket lobby", () => {
  let application: YachtApplication;
  let url: string;
  let clients: TestClient[];

  beforeEach(async () => {
    application = createYachtApplication({ reconnectGraceMs: 500 });
    const port = await application.listen(0, "127.0.0.1");
    url = `ws://127.0.0.1:${port}/yacht/ws`;
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.terminate();
    await application.close();
  });

  async function connect(): Promise<TestClient> {
    const client = await TestClient.connect(url);
    clients.push(client);
    await client.waitFor((message) => message.event === "SERVER_READY");
    return client;
  }

  it("validates diagnostic and malformed messages without closing the socket", async () => {
    const client = await connect();
    client.sendRaw("not-json");
    expect(await client.waitFor((message) => message.event === "ERROR")).toMatchObject({
      code: "INVALID_MESSAGE",
    });
    client.send({ event: "DIAGNOSTIC_PING", id: "health-1" });
    expect(await client.waitFor((message) => message.event === "DIAGNOSTIC_PONG")).toEqual({
      event: "DIAGNOSTIC_PONG",
      id: "health-1",
    });
  });

  it("broadcasts the same authoritative STARTED snapshot to two clients", async () => {
    const a = await connect();
    a.send({
      event: "CREATE_ROOM",
      requestId: "create-a",
      nickname: "Alice",
      maxPlayers: 4,
    });
    const aSession = await a.waitFor((message) => message.event === "SESSION_ESTABLISHED");
    const roomId = aSession.roomId as string;
    await a.waitFor(roomView((room) => (room.players as unknown[]).length === 1));

    const b = await connect();
    b.send({
      event: "JOIN_ROOM",
      requestId: "join-b",
      roomId,
      nickname: "Bob",
    });
    await b.waitFor((message) => message.event === "SESSION_ESTABLISHED");
    await Promise.all([
      a.waitFor(roomView((room) => (room.players as unknown[]).length === 2)),
      b.waitFor(roomView((room) => (room.players as unknown[]).length === 2)),
    ]);

    a.send({ event: "SET_READY", requestId: "ready-a", ready: true });
    b.send({ event: "SET_READY", requestId: "ready-b", ready: true });
    await Promise.all([
      a.waitFor((message) => message.event === "COMMAND_OK" && message.requestId === "ready-a"),
      b.waitFor((message) => message.event === "COMMAND_OK" && message.requestId === "ready-b"),
    ]);
    const allReady = roomView((room) => room.canStart === true);
    await Promise.all([a.waitFor(allReady), b.waitFor(allReady)]);

    a.send({ event: "START_GAME", requestId: "start-a" });
    await a.waitFor(
      (message) => message.event === "COMMAND_OK" && message.requestId === "start-a",
    );
    const started = roomView((room) => room.status === "STARTED");
    const [aView, bView] = await Promise.all([a.waitFor(started), b.waitFor(started)]);
    expect(aView.room).toEqual(bView.room);
    expect(aView.room).toMatchObject({ id: roomId, status: "STARTED", revision: 5 });
  });
});
