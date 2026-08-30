import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import type { PublicRoomSnapshot, ServerMessage } from "./protocol";

const BASE_PATH = "/yacht/";
const WEBSOCKET_PATH = `${BASE_PATH}ws`;
const ROOM_ID_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

type View = "HOME" | "JOIN" | "CONNECTING" | "ROOM" | "NOT_FOUND";
type ConnectionStatus = "CONNECTING" | "CONNECTED" | "RECONNECTING";

interface RouteState {
  view: View;
  roomId: string | null;
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
    return "닉네임은 제어 문자 없이 1~20자로 입력해 주세요.";
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
  const [maxPlayers, setMaxPlayers] = useState(8);
  const [room, setRoom] = useState<PublicRoomSnapshot | null>(null);
  const [selfPlayerId, setSelfPlayerId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const routeRef = useRef(route);
  const stoppedRef = useRef(false);
  const retryTimerRef = useRef<number | null>(null);

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
      setError("서버에 연결 중입니다. 잠시 후 다시 시도해 주세요.");
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
          setBusy(false);
          setError(null);
          goToRoom(message.roomId, message.reconnected);
          break;
        case "ROOM_VIEW":
          setRoom(message.room);
          setBusy(false);
          goToRoom(message.room.id, true);
          break;
        case "COMMAND_OK":
          setBusy(false);
          break;
        case "LEFT":
          localStorage.removeItem(sessionKey(message.roomId));
          setBusy(false);
          goHome();
          break;
        case "ERROR": {
          setBusy(false);
          setError(message.message);
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
          setError("서버에서 해석할 수 없는 응답을 받았습니다.");
        }
      });
      socket.addEventListener("close", () => {
        if (socketRef.current !== socket || stoppedRef.current) return;
        setConnection("RECONNECTING");
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
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [goHome, goToRoom, updateRoute]);

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
      setError("방 코드는 8자리 영문 대문자와 숫자로 입력해 주세요.");
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
    if (!self) return;
    setError(null);
    setBusy(
      send({ event: "SET_READY", requestId: requestId(), ready: !self.ready }),
    );
  }

  function startGame(): void {
    setError(null);
    setBusy(send({ event: "START_GAME", requestId: requestId() }));
  }

  async function copyInvite(): Promise<void> {
    if (!room) return;
    const url = `${window.location.origin}${BASE_PATH}r/${room.id}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError(`초대 링크를 복사하지 못했습니다: ${url}`);
    }
  }

  const connectionBanner = connection !== "CONNECTED" && (
    <div className="connection-banner" role="status">
      <span className="connection-dot" />
      {connection === "CONNECTING" ? "서버에 연결하는 중..." : "연결이 끊겨 재접속 중..."}
    </div>
  );

  if (route.view === "NOT_FOUND") {
    return (
      <Shell banner={connectionBanner}>
        <section className="card centered">
          <p className="eyebrow">404</p>
          <h1>올바르지 않은 초대 링크입니다.</h1>
          <a className="button primary" href={BASE_PATH}>홈으로 돌아가기</a>
        </section>
      </Shell>
    );
  }

  if (route.view === "CONNECTING") {
    return (
      <Shell banner={connectionBanner}>
        <section className="card centered loading-card">
          <div className="dice-loader" aria-hidden="true">⚄</div>
          <h1>방에 다시 연결하고 있습니다</h1>
          <p className="muted">저장된 세션을 확인하는 중입니다.</p>
          {error && <ErrorNotice message={error} />}
        </section>
      </Shell>
    );
  }

  if (route.view === "JOIN" && route.roomId) {
    return (
      <Shell banner={connectionBanner}>
        <section className="card join-card">
          <p className="eyebrow">Yacht Dice 초대</p>
          <h1>방에 참가하세요</h1>
          <div className="room-code"><span>방 코드</span><strong>{route.roomId}</strong></div>
          <form onSubmit={(event) => joinRoom(route.roomId!, event)}>
            <label>
              닉네임
              <input
                autoComplete="nickname"
                autoFocus
                maxLength={40}
                placeholder="친구들이 알아볼 이름"
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
              />
            </label>
            <ErrorNotice message={error} />
            <button className="button primary" type="submit" disabled={busy}>
              {busy ? "참가하는 중..." : "방 참가"}
            </button>
          </form>
        </section>
      </Shell>
    );
  }

  if (route.view === "ROOM" && room) {
    const self = room.players.find((player) => player.id === selfPlayerId) ?? null;
    const isHost = self?.id === room.hostPlayerId;
    return (
      <Shell banner={connectionBanner}>
        <section className="room-layout">
          <div className="room-heading">
            <div>
              <p className="eyebrow">멀티플레이 로비</p>
              <h1>방 코드 <span>{room.id}</span></h1>
            </div>
            <button className="button ghost" type="button" onClick={() => void copyInvite()}>
              {copied ? "복사 완료" : "초대 링크 복사"}
            </button>
          </div>

          {room.status === "STARTED" ? (
            <div className="started-panel" role="status">
              <div className="started-icon">⚄</div>
              <div>
                <p className="eyebrow">LOBBY COMPLETE</p>
                <h2>게임 시작 준비 완료</h2>
                <p>Phase 2에서 Yacht 게임이 연결됩니다.</p>
              </div>
            </div>
          ) : (
            <div className="card players-card">
              <div className="section-title">
                <div>
                  <h2>플레이어</h2>
                  <p>{room.players.length} / {room.maxPlayers}명</p>
                </div>
                <span className={room.canStart ? "start-state ready" : "start-state"}>
                  {room.canStart ? "시작 가능" : "Ready 대기 중"}
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
                          {player.id === selfPlayerId ? "나" : `참가 순서 ${player.joinOrder}`}
                          {player.connectionState === "DISCONNECTED_GRACE" && " · 재접속 대기"}
                        </small>
                      </div>
                    </div>
                    <span className={player.ready ? "ready-badge on" : "ready-badge"}>
                      {player.ready ? "Ready" : "Not Ready"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ErrorNotice message={error} />
          <div className="room-actions">
            {room.status === "LOBBY" && (
              <button className="button primary" type="button" onClick={toggleReady} disabled={busy}>
                {self?.ready ? "Ready 취소" : "Ready"}
              </button>
            )}
            {room.status === "LOBBY" && isHost && (
              <button
                className="button accent"
                type="button"
                onClick={startGame}
                disabled={busy || !room.canStart}
              >
                게임 시작
              </button>
            )}
            <button className="button danger" type="button" onClick={leaveRoom} disabled={busy}>
              방 나가기
            </button>
          </div>
        </section>
      </Shell>
    );
  }

  return (
    <Shell banner={connectionBanner}>
      <section className="home-grid">
        <div className="hero">
          <p className="eyebrow">ROLL TOGETHER</p>
          <h1>Yacht<br /><span>Dice</span></h1>
          <p>친구들과 함께하는 실시간 Yacht Dice.<br />지금은 멀티플레이 로비를 먼저 준비했습니다.</p>
          <div className="dice-row" aria-hidden="true"><span>⚁</span><span>⚄</span><span>⚅</span></div>
        </div>
        <div className="card home-card">
          <form onSubmit={createRoom}>
            <h2>게임 준비하기</h2>
            <label>
              닉네임
              <input
                autoComplete="nickname"
                autoFocus
                maxLength={40}
                placeholder="사용할 닉네임"
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
              />
            </label>
            <label>
              방 최대 인원
              <select value={maxPlayers} onChange={(event) => setMaxPlayers(Number(event.target.value))}>
                {Array.from({ length: 7 }, (_, index) => index + 2).map((count) => (
                  <option key={count} value={count}>{count}명{count === 8 ? " · 기본" : ""}</option>
                ))}
              </select>
            </label>
            <button className="button primary" type="submit" disabled={busy}>방 만들기</button>
          </form>
          <div className="divider"><span>또는</span></div>
          <form onSubmit={(event) => joinRoom(roomCode, event)}>
            <label>
              방 코드
              <input
                autoComplete="off"
                inputMode="text"
                maxLength={8}
                placeholder="ABCD1234"
                value={roomCode}
                onChange={(event) => setRoomCode(normalizeRoomId(event.target.value))}
              />
            </label>
            <button className="button ghost" type="submit" disabled={busy}>방 참가</button>
          </form>
          <ErrorNotice message={error} />
        </div>
      </section>
    </Shell>
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
          <span className="brand-die">⚄</span>
          <span><strong>YACHT DICE</strong><small>ONLINE</small></span>
        </a>
        <span className="phase-badge">PHASE 1</span>
      </header>
      <main>{children}</main>
      <footer>Yacht Dice Online · Multiplayer lobby foundation</footer>
    </div>
  );
}

function ErrorNotice({ message }: { message: string | null }): ReactElement | null {
  if (!message) return null;
  return <div className="error-notice" role="alert">{message}</div>;
}
