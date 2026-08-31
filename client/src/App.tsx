import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import { AudioControls, AudioDirector } from "./audio-director";
import { GameBoard } from "./GameBoard";
import type { PublicRoomSnapshot, ScoreCategory, ServerMessage } from "./protocol";

const BASE_PATH = "/yacht/";
const WEBSOCKET_PATH = `${BASE_PATH}ws`;
const ROOM_ID_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const DECORATIVE_DIE_PIPS: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

type View = "HOME" | "JOIN" | "CONNECTING" | "ROOM" | "NOT_FOUND";
type ConnectionStatus = "CONNECTING" | "CONNECTED" | "RECONNECTING";

interface RouteState {
  view: View;
  roomId: string | null;
}

interface NoticeState {
  kind: "info" | "warning";
  message: string;
}

let requestSequence = 0;

function requestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  requestSequence += 1;
  return `${Date.now()}-${requestSequence}`;
}

function sessionKey(roomId: string): string {
  return `yacht:session:${roomId}`;
}

function parseRoute(pathname = window.location.pathname): RouteState {
  if (pathname === "/yacht" || pathname === BASE_PATH) {
    return { view: "HOME", roomId: null };
  }
  const match = pathname.match(/^\/yacht\/r\/([^/]+)\/?$/);
  if (!match) return { view: "NOT_FOUND", roomId: null };
  const roomId = match[1].toUpperCase();
  if (!ROOM_ID_PATTERN.test(roomId)) return { view: "NOT_FOUND", roomId: null };
  return {
    view: localStorage.getItem(sessionKey(roomId)) ? "CONNECTING" : "JOIN",
    roomId,
  };
}

function normalizeRoomId(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function nicknameError(rawNickname: string): string | null {
  const nickname = rawNickname.normalize("NFC").trim();
  const length = [...nickname].length;
  if (length < 1 || length > 20 || /\p{Cc}/u.test(nickname)) {
    return "ENTER A NICKNAME BETWEEN 1 AND 20 CHARACTERS.";
  }
  return null;
}

function webSocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${WEBSOCKET_PATH}`;
}

export function App(): ReactElement {
  const [route, setRoute] = useState<RouteState>(() => parseRoute());
  const [connection, setConnection] = useState<ConnectionStatus>("CONNECTING");
  const [nickname, setNickname] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(2);
  const [room, setRoom] = useState<PublicRoomSnapshot | null>(null);
  const [selfPlayerId, setSelfPlayerId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [copied, setCopied] = useState(false);
  const [serverRejectId, setServerRejectId] = useState<string | null>(null);
  const [audioBaselineVersion, setAudioBaselineVersion] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const routeRef = useRef(route);
  const stoppedRef = useRef(false);
  const retryTimerRef = useRef<number | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const wasDisconnectedRef = useRef(false);
  const rejectSequenceRef = useRef(0);
  const audioBaselinePendingRef = useRef(false);

  const showNotice = useCallback((message: string, kind: NoticeState["kind"] = "info"): void => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setNotice({ kind, message });
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, 3_000);
  }, []);

  const updateRoute = useCallback((next: RouteState): void => {
    routeRef.current = next;
    setRoute(next);
  }, []);

  const goHome = useCallback((): void => {
    window.history.pushState({}, "", BASE_PATH);
    updateRoute({ view: "HOME", roomId: null });
    setRoom(null);
    setSelfPlayerId(null);
    setError(null);
  }, [updateRoute]);

  const goToRoom = useCallback(
    (roomId: string, replace = false): void => {
      const path = `${BASE_PATH}r/${roomId}`;
      if (window.location.pathname !== path) {
        if (replace) window.history.replaceState({}, "", path);
        else window.history.pushState({}, "", path);
      }
      updateRoute({ view: "ROOM", roomId });
    },
    [updateRoute],
  );

  const send = useCallback((message: Record<string, unknown>): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("CONNECTING TO THE SERVER. PLEASE TRY AGAIN IN A MOMENT.");
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  useEffect(() => {
    stoppedRef.current = false;

    const handleMessage = (message: ServerMessage): void => {
      switch (message.event) {
        case "SERVER_READY":
        case "DIAGNOSTIC_PONG":
          break;
        case "SESSION_ESTABLISHED":
          localStorage.setItem(sessionKey(message.roomId), message.sessionToken);
          setSelfPlayerId(message.playerId);
          setError(null);
          audioBaselinePendingRef.current = message.reconnected;
          if (message.reconnected && wasDisconnectedRef.current) {
            showNotice("RECONNECTED TO THE GAME.");
            wasDisconnectedRef.current = false;
          }
          goToRoom(message.roomId, message.reconnected);
          break;
        case "ROOM_VIEW":
          setRoom(message.room);
          if (audioBaselinePendingRef.current) {
            audioBaselinePendingRef.current = false;
            setAudioBaselineVersion((version) => version + 1);
          }
          setBusy(false);
          goToRoom(message.room.id, true);
          break;
        case "COMMAND_OK":
          break;
        case "LEFT":
          localStorage.removeItem(sessionKey(message.roomId));
          setBusy(false);
          goHome();
          break;
        case "GAME_ABORTED":
          setError(null);
          showNotice(message.message, "warning");
          break;
        case "ERROR": {
          rejectSequenceRef.current += 1;
          setServerRejectId(`${message.requestId ?? "server"}:${message.code}:${rejectSequenceRef.current}`);
          if (message.code === "STALE_REVISION") {
            setError(null);
            showNotice("SYNCED TO THE LATEST GAME STATE.");
          } else {
            setBusy(false);
            setError(message.message);
          }
          const activeRoomId = routeRef.current.roomId;
          if (message.code === "INVALID_SESSION" && activeRoomId) {
            localStorage.removeItem(sessionKey(activeRoomId));
            setRoom(null);
            setSelfPlayerId(null);
            updateRoute({ view: "JOIN", roomId: activeRoomId });
          }
          break;
        }
      }
    };

    const connect = (): void => {
      if (stoppedRef.current) return;
      setConnection(socketRef.current ? "RECONNECTING" : "CONNECTING");
      const socket = new WebSocket(webSocketUrl());
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        if (socketRef.current !== socket) return;
        setConnection("CONNECTED");
        const activeRoomId = routeRef.current.roomId;
        const token = activeRoomId
          ? localStorage.getItem(sessionKey(activeRoomId))
          : null;
        if (activeRoomId && token) {
          setBusy(true);
          socket.send(
            JSON.stringify({
              event: "RECONNECT_ROOM",
              requestId: requestId(),
              roomId: activeRoomId,
              sessionToken: token,
            }),
          );
        }
      });
      socket.addEventListener("message", (event) => {
        try {
          handleMessage(JSON.parse(event.data as string) as ServerMessage);
        } catch {
          setError("THE SERVER RETURNED AN UNREADABLE RESPONSE.");
        }
      });
      socket.addEventListener("close", () => {
        if (socketRef.current !== socket || stoppedRef.current) return;
        setConnection("RECONNECTING");
        setBusy(true);
        wasDisconnectedRef.current = true;
        retryTimerRef.current = window.setTimeout(connect, 1_000);
      });
      socket.addEventListener("error", () => {
        // The close handler performs retry.
      });
    };

    connect();
    const onPopState = (): void => window.location.reload();
    window.addEventListener("popstate", onPopState);
    return () => {
      stoppedRef.current = true;
      window.removeEventListener("popstate", onPopState);
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [goHome, goToRoom, showNotice, updateRoute]);

  function requireNickname(): string | null {
    const validationError = nicknameError(nickname);
    if (validationError) {
      setError(validationError);
      return null;
    }
    return nickname.normalize("NFC").trim();
  }

  function createRoom(event: FormEvent): void {
    event.preventDefault();
    const normalizedNickname = requireNickname();
    if (!normalizedNickname) return;
    setError(null);
    setBusy(
      send({
        event: "CREATE_ROOM",
        requestId: requestId(),
        nickname: normalizedNickname,
        maxPlayers,
      }),
    );
  }

  function joinRoom(roomId: string, event?: FormEvent): void {
    event?.preventDefault();
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!ROOM_ID_PATTERN.test(normalizedRoomId)) {
      setError("ENTER AN 8-CHARACTER ROOM CODE.");
      return;
    }
    const savedToken = localStorage.getItem(sessionKey(normalizedRoomId));
    setError(null);
    if (savedToken) {
      updateRoute({ view: "CONNECTING", roomId: normalizedRoomId });
      setBusy(
        send({
          event: "RECONNECT_ROOM",
          requestId: requestId(),
          roomId: normalizedRoomId,
          sessionToken: savedToken,
        }),
      );
      return;
    }
    const normalizedNickname = requireNickname();
    if (!normalizedNickname) return;
    setBusy(
      send({
        event: "JOIN_ROOM",
        requestId: requestId(),
        roomId: normalizedRoomId,
        nickname: normalizedNickname,
      }),
    );
  }

  function leaveRoom(): void {
    if (!route.roomId) return;
    setError(null);
    setBusy(send({ event: "LEAVE_ROOM", requestId: requestId() }));
  }

  function toggleReady(): void {
    if (!room || !selfPlayerId) return;
    const self = room.players.find((player) => player.id === selfPlayerId);
    if (!self || self.id === room.hostPlayerId) return;
    setError(null);
    setBusy(
      send({ event: "SET_READY", requestId: requestId(), ready: !self.ready }),
    );
  }

  function startGame(): void {
    setError(null);
    setBusy(send({ event: "START_GAME", requestId: requestId() }));
  }

  function rollDice(): void {
    if (!room) return;
    setError(null);
    setBusy(
      send({
        event: "ROLL_DICE",
        requestId: requestId(),
        expectedRevision: room.revision,
      }),
    );
  }

  function setHeldDice(heldIndices: number[]): void {
    if (!room) return;
    setError(null);
    setBusy(
      send({
        event: "SET_HELD_DICE",
        requestId: requestId(),
        expectedRevision: room.revision,
        heldIndices,
      }),
    );
  }

  function scoreCategory(category: ScoreCategory): void {
    if (!room) return;
    setError(null);
    setBusy(
      send({
        event: "SCORE_CATEGORY",
        requestId: requestId(),
        expectedRevision: room.revision,
        category,
      }),
    );
  }

  function returnToLobby(): void {
    if (!room) return;
    setError(null);
    setBusy(
      send({
        event: "RETURN_TO_LOBBY",
        requestId: requestId(),
        expectedRevision: room.revision,
      }),
    );
  }

  async function copyInvite(): Promise<void> {
    if (!room) return;
    const url = `${window.location.origin}${BASE_PATH}r/${room.id}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError(`COULD NOT COPY THE INVITE LINK: ${url}`);
    }
  }

  const connectionBanner = connection !== "CONNECTED" && (
    <div className="connection-banner" role="status">
      <span className="connection-dot" />
      {connection === "CONNECTING" ? "CONNECTING TO SERVER..." : "CONNECTION LOST · RECONNECTING..."}
    </div>
  );
  const withAudio = (content: ReactElement): ReactElement => (
    <>
      <AudioDirector
        baselineVersion={audioBaselineVersion}
        room={room}
        selfPlayerId={selfPlayerId}
        serverRejectId={serverRejectId}
      />
      {content}
    </>
  );

  if (route.view === "NOT_FOUND") {
    return withAudio(
      <Shell banner={connectionBanner}>
        <section className="card centered">
          <p className="eyebrow">404</p>
          <h1>INVALID INVITE LINK</h1>
          <a className="button primary" href={BASE_PATH}>RETURN HOME</a>
        </section>
      </Shell>,
    );
  }

  if (route.view === "CONNECTING") {
    return withAudio(
      <Shell banner={connectionBanner}>
        <section className="card centered loading-card">
          <DecorativeDie className="dice-loader" value={5} />
          <h1>RECONNECTING TO TABLE</h1>
          <p className="muted">CHECKING YOUR SAVED SESSION.</p>
          {error && <ErrorNotice message={error} />}
        </section>
      </Shell>,
    );
  }

  if (route.view === "JOIN" && route.roomId) {
    return withAudio(
      <Shell banner={connectionBanner}>
        <section className="card join-card">
          <p className="eyebrow">YACHT DICE INVITE</p>
          <h1>JOIN THE TABLE</h1>
          <div className="room-code"><span>ROOM CODE</span><strong>{route.roomId}</strong></div>
          <form onSubmit={(event) => joinRoom(route.roomId!, event)}>
            <label>
              NICKNAME
              <input
                autoComplete="nickname"
                autoFocus
                maxLength={40}
                placeholder="NAME YOUR FRIENDS WILL RECOGNIZE"
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
              />
            </label>
            <ErrorNotice message={error} />
            <button className="button primary" type="submit" disabled={busy}>
              {busy ? "JOINING..." : "JOIN TABLE"}
            </button>
          </form>
        </section>
      </Shell>,
    );
  }

  if (route.view === "ROOM" && room) {
    const self = room.players.find((player) => player.id === selfPlayerId) ?? null;
    const isHost = self?.id === room.hostPlayerId;
    if (room.status === "STARTED" && room.game) {
      return withAudio(
        <div className="game-app">
          {connectionBanner}
          <ErrorNotice message={error} />
          <TransientNotice notice={notice} />
          <GameBoard
            busy={busy || connection !== "CONNECTED"}
            connected={connection === "CONNECTED"}
            onLeave={leaveRoom}
            onReturnToLobby={returnToLobby}
            onRoll={rollDice}
            onScore={scoreCategory}
            onSetHeld={setHeldDice}
            room={room}
            selfPlayerId={selfPlayerId}
          />
        </div>,
      );
    }
    return withAudio(
      <Shell banner={connectionBanner}>
        <section className="room-layout">
          <div className="room-heading">
            <div>
              <p className="eyebrow">MULTIPLAYER LOBBY</p>
              <h1>ROOM <span>{room.id}</span></h1>
            </div>
            <button className="button ghost" type="button" onClick={() => void copyInvite()}>
              {copied ? "INVITE COPIED" : "COPY INVITE LINK"}
            </button>
          </div>

          <div className="card players-card">
              <div className="section-title">
                <div>
                  <h2>PLAYERS</h2>
                  <p>{room.players.length} / {room.maxPlayers}</p>
                </div>
                <span className={room.canStart ? "start-state ready" : "start-state"}>
                  {room.canStart ? "READY TO START" : "WAITING FOR READY"}
                </span>
              </div>
              <ul className="player-list">
                {room.players.map((player) => (
                  <li key={player.id} className={player.id === selfPlayerId ? "self" : ""}>
                    <div className="player-identity">
                      <span className="avatar">{[...player.nickname][0]?.toUpperCase()}</span>
                      <div>
                        <strong>{player.isHost && <span className="host-star">★ </span>}{player.nickname}</strong>
                        <small>
                          {player.id === selfPlayerId ? "YOU" : `PLAYER ${player.joinOrder}`}
                          {player.connectionState === "DISCONNECTED_GRACE" && " · RECONNECTING"}
                        </small>
                      </div>
                    </div>
                    <span className={player.isHost ? "ready-badge host" : player.ready ? "ready-badge on" : "ready-badge"}>
                      {player.isHost ? "HOST" : player.ready ? "Ready" : "Not Ready"}
                    </span>
                  </li>
                ))}
              </ul>
          </div>

          <ErrorNotice message={error} />
          <TransientNotice notice={notice} />
          <div className="room-actions">
            {room.status === "LOBBY" && !isHost && (
              <button className="button primary" data-audio-no-click type="button" onClick={toggleReady} disabled={busy}>
                {self?.ready ? "CANCEL READY" : "READY"}
              </button>
            )}
            {room.status === "LOBBY" && isHost && (
              <button
                className="button accent"
                data-audio-no-click
                type="button"
                onClick={startGame}
                disabled={busy || !room.canStart}
              >
                START GAME
              </button>
            )}
            <button className="button danger" type="button" onClick={leaveRoom} disabled={busy}>
              LEAVE ROOM
            </button>
          </div>
        </section>
      </Shell>,
    );
  }

  return withAudio(
    <Shell banner={connectionBanner}>
      <section className="home-grid">
        <div className="hero">
          <p className="eyebrow">ROLL TOGETHER</p>
          <h1>Yacht<br /><span>Dice</span></h1>
          <p>ROLL, KEEP, AND SCORE TOGETHER.<br />COMPLETE ALL 12 CATEGORIES AND CLAIM THE YACHT.</p>
          <div className="dice-row" aria-hidden="true">
            <DecorativeDie value={2} />
            <DecorativeDie value={5} />
            <DecorativeDie value={6} />
          </div>
        </div>
        <div className="card home-card">
          <form onSubmit={createRoom}>
            <h2>TAKE A SEAT</h2>
            <label>
              NICKNAME
              <input
                autoComplete="nickname"
                autoFocus
                maxLength={40}
                placeholder="YOUR TABLE NAME"
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
              />
            </label>
            <label>
              MAX PLAYERS
              <select value={maxPlayers} onChange={(event) => setMaxPlayers(Number(event.target.value))}>
                {Array.from({ length: 5 }, (_, index) => index + 2).map((count) => (
                  <option key={count} value={count}>{count}{count === 2 ? " · DEFAULT" : ""}</option>
                ))}
              </select>
            </label>
            <button className="button primary" type="submit" disabled={busy}>CREATE TABLE</button>
          </form>
          <div className="divider"><span>OR</span></div>
          <form onSubmit={(event) => joinRoom(roomCode, event)}>
            <label>
              ROOM CODE
              <input
                autoComplete="off"
                inputMode="text"
                maxLength={8}
                placeholder="ABCD1234"
                value={roomCode}
                onChange={(event) => setRoomCode(normalizeRoomId(event.target.value))}
              />
            </label>
            <button className="button ghost" type="submit" disabled={busy}>JOIN TABLE</button>
          </form>
          <ErrorNotice message={error} />
        </div>
      </section>
    </Shell>,
  );
}

function Shell({
  children,
  banner,
}: {
  children: ReactElement;
  banner: ReactElement | false;
}): ReactElement {
  return (
    <div className="app-shell">
      {banner}
      <header>
        <a className="brand" href={BASE_PATH}>
          <DecorativeDie className="brand-die" value={5} />
          <span><strong>YACHT DICE</strong><small>ONLINE</small></span>
        </a>
        <div className="shell-controls">
          <span className="phase-badge">LIVE TABLE</span>
          <AudioControls />
        </div>
      </header>
      <main>{children}</main>
      <footer>Yacht Dice Online · Server-authoritative tabletop play</footer>
    </div>
  );
}

function DecorativeDie({
  className = "",
  value,
}: {
  className?: string;
  value: number;
}): ReactElement {
  return (
    <span className={`lobby-die ${className}`.trim()} aria-hidden="true">
      {DECORATIVE_DIE_PIPS[value].map((position) => (
        <i className={`lobby-pip lobby-pip-${position}`} key={position} />
      ))}
    </span>
  );
}

function ErrorNotice({ message }: { message: string | null }): ReactElement | null {
  if (!message) return null;
  return <div className="error-notice" role="alert">{message}</div>;
}

function TransientNotice({ notice }: { notice: NoticeState | null }): ReactElement | null {
  if (!notice) return null;
  return (
    <div className={`transient-notice ${notice.kind}`} role="status">
      {notice.message}
    </div>
  );
}
