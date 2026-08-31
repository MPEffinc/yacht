import { randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  cryptoDieRoller,
  initializeYachtGame,
  rollGameDice,
  scoreGameCategory,
  setGameHeldDice,
  toPublicGameSnapshot,
} from "./game/game.js";
import type {
  DieRoller,
  ScoreCategory,
  YachtGameState,
} from "./game/types.js";
import {
  ROOM_ID_ALPHABET,
  ROOM_ID_LENGTH,
  type ConnectionState,
  type PublicRoomSnapshot,
  type PlayerKind,
  type RoomErrorCode,
  type RoomMode,
  type RoomStatus,
} from "./protocol.js";

export const MIN_PLAYERS = 2;
export const DEFAULT_MAX_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const DEFAULT_RECONNECT_GRACE_MS = 60_000;

export class RoomError extends Error {
  constructor(public readonly code: RoomErrorCode) {
    super(code);
    this.name = "RoomError";
  }
}

export interface PlayerRecord {
  id: string;
  nickname: string;
  nicknameKey: string;
  kind: PlayerKind;
  sessionToken: string | null;
  ready: boolean;
  connectionState: ConnectionState;
  reconnectDeadline: number | null;
  joinOrder: number;
}

export interface RoomRecord {
  id: string;
  mode: RoomMode;
  revision: number;
  status: RoomStatus;
  createdAt: number;
  hostPlayerId: string | null;
  maxPlayers: number;
  nextJoinOrder: number;
  players: Map<string, PlayerRecord>;
  game: YachtGameState | null;
}

export interface RoomServiceOptions {
  reconnectGraceMs?: number;
  roomIdFactory?: () => string;
  playerIdFactory?: () => string;
  sessionTokenFactory?: () => string;
  dieRoller?: DieRoller;
}

export interface JoinResult {
  room: RoomRecord;
  player: PlayerRecord;
}

export interface RemovalResult {
  room: RoomRecord | null;
  removedPlayer: PlayerRecord;
  gameAborted: boolean;
}

function generateRoomId(): string {
  let roomId = "";
  for (let index = 0; index < ROOM_ID_LENGTH; index += 1) {
    roomId += ROOM_ID_ALPHABET[randomInt(ROOM_ID_ALPHABET.length)];
  }
  return roomId;
}

function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function normalizeNickname(
  rawNickname: string,
): { nickname: string; nicknameKey: string } {
  const nickname = rawNickname.normalize("NFC").trim();
  const length = [...nickname].length;
  if (length < 1 || length > 20 || /\p{Cc}/u.test(nickname)) {
    throw new RoomError("INVALID_NICKNAME");
  }
  return { nickname, nicknameKey: nickname.toLocaleLowerCase() };
}

export class RoomService {
  readonly reconnectGraceMs: number;
  private readonly roomIdFactory: () => string;
  private readonly playerIdFactory: () => string;
  private readonly sessionTokenFactory: () => string;
  private readonly dieRoller: DieRoller;
  private readonly rooms = new Map<string, RoomRecord>();

  constructor(options: RoomServiceOptions = {}) {
    this.reconnectGraceMs = options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
    this.roomIdFactory = options.roomIdFactory ?? generateRoomId;
    this.playerIdFactory = options.playerIdFactory ?? randomUUID;
    this.sessionTokenFactory = options.sessionTokenFactory ?? generateSessionToken;
    this.dieRoller = options.dieRoller ?? cryptoDieRoller;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  createRoom(
    rawNickname: string,
    maxPlayers = DEFAULT_MAX_PLAYERS,
    now = Date.now(),
  ): JoinResult {
    if (!Number.isInteger(maxPlayers) || maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) {
      throw new RoomError("INVALID_MESSAGE");
    }
    const { nickname, nicknameKey } = normalizeNickname(rawNickname);
    const host = this.createPlayer(nickname, nicknameKey, 1);
    const room: RoomRecord = {
      id: this.createUniqueRoomId(),
      mode: "MULTIPLAYER",
      revision: 1,
      status: "LOBBY",
      createdAt: now,
      hostPlayerId: host.id,
      maxPlayers,
      nextJoinOrder: 2,
      players: new Map([[host.id, host]]),
      game: null,
    };
    this.rooms.set(room.id, room);
    return { room, player: host };
  }

  createBotGame(rawNickname: string, now = Date.now()): JoinResult {
    const { nickname, nicknameKey } = normalizeNickname(rawNickname);
    const human = this.createPlayer(nickname, nicknameKey, 1);
    const bot = this.createPlayer("YACHT BOT", "yacht bot", 2, "BOT");
    const room: RoomRecord = {
      id: this.createUniqueRoomId(),
      mode: "BOT",
      revision: 1,
      status: "STARTED",
      createdAt: now,
      hostPlayerId: human.id,
      maxPlayers: 2,
      nextJoinOrder: 3,
      players: new Map([
        [human.id, human],
        [bot.id, bot],
      ]),
      game: initializeYachtGame([human.id, bot.id]),
    };
    this.rooms.set(room.id, room);
    return { room, player: human };
  }

  joinRoom(roomId: string, rawNickname: string): JoinResult {
    const room = this.requireRoom(roomId);
    if (room.mode === "BOT") throw new RoomError("ROOM_NOT_JOINABLE");
    if (room.status === "STARTED") throw new RoomError("GAME_ALREADY_STARTED");
    const { nickname, nicknameKey } = normalizeNickname(rawNickname);
    if ([...room.players.values()].some((player) => player.nicknameKey === nicknameKey)) {
      throw new RoomError("DUPLICATE_NICKNAME");
    }
    if (room.players.size >= room.maxPlayers) throw new RoomError("ROOM_FULL");

    const player = this.createPlayer(nickname, nicknameKey, room.nextJoinOrder);
    room.nextJoinOrder += 1;
    room.players.set(player.id, player);
    this.bump(room);
    return { room, player };
  }

  reconnectRoom(roomId: string, sessionToken: string, now = Date.now()): JoinResult {
    const room = this.requireRoom(roomId);
    const player = [...room.players.values()].find(
      (candidate) => candidate.kind === "HUMAN" && candidate.sessionToken === sessionToken,
    );
    if (!player) throw new RoomError("INVALID_SESSION");

    if (
      player.connectionState === "DISCONNECTED_GRACE" &&
      player.reconnectDeadline !== null &&
      player.reconnectDeadline <= now
    ) {
      throw new RoomError("INVALID_SESSION");
    }

    if (player.connectionState !== "CONNECTED") {
      player.connectionState = "CONNECTED";
      player.reconnectDeadline = null;
      if (room.hostPlayerId === null) room.hostPlayerId = player.id;
      this.bump(room);
    }
    return { room, player };
  }

  setReady(roomId: string, playerId: string, ready: boolean): RoomRecord {
    const room = this.requireRoom(roomId);
    const player = this.requirePlayer(room, playerId);
    if (room.status === "STARTED") throw new RoomError("GAME_ALREADY_STARTED");
    if (player.connectionState !== "CONNECTED") throw new RoomError("INVALID_SESSION");
    if (player.ready !== ready) {
      player.ready = ready;
      this.bump(room);
    }
    return room;
  }

  startGame(roomId: string, playerId: string): RoomRecord {
    const room = this.requireRoom(roomId);
    if (room.mode === "BOT") throw new RoomError("GAME_ALREADY_STARTED");
    this.requirePlayer(room, playerId);
    if (room.hostPlayerId !== playerId) throw new RoomError("NOT_HOST");
    if (room.status === "STARTED") throw new RoomError("GAME_ALREADY_STARTED");
    const players = [...room.players.values()];
    const connected = players.filter((player) => player.connectionState === "CONNECTED");
    if (connected.length < MIN_PLAYERS) throw new RoomError("NOT_ENOUGH_PLAYERS");
    if (
      players.some((player) => player.connectionState !== "CONNECTED") ||
      players.some((player) => player.id !== room.hostPlayerId && !player.ready)
    ) {
      throw new RoomError("PLAYERS_NOT_READY");
    }
    room.status = "STARTED";
    room.game = initializeYachtGame(
      players.sort((left, right) => left.joinOrder - right.joinOrder).map((player) => player.id),
    );
    this.bump(room);
    return room;
  }

  rollDice(
    roomId: string,
    playerId: string,
    expectedRevision: number,
  ): RoomRecord {
    const room = this.requireGameRoom(roomId, playerId, expectedRevision);
    rollGameDice(room.game!, playerId, this.dieRoller);
    this.bump(room);
    return room;
  }

  setHeldDice(
    roomId: string,
    playerId: string,
    expectedRevision: number,
    heldIndices: readonly number[],
  ): RoomRecord {
    const room = this.requireGameRoom(roomId, playerId, expectedRevision);
    if (setGameHeldDice(room.game!, playerId, heldIndices)) this.bump(room);
    return room;
  }

  scoreCategory(
    roomId: string,
    playerId: string,
    expectedRevision: number,
    category: ScoreCategory,
  ): RoomRecord {
    const room = this.requireGameRoom(roomId, playerId, expectedRevision);
    scoreGameCategory(room.game!, playerId, category);
    this.bump(room);
    return room;
  }

  returnToLobby(
    roomId: string,
    playerId: string,
    expectedRevision: number,
  ): RoomRecord {
    const room = this.requireRoom(roomId);
    if (room.mode === "BOT") throw new RoomError("ROOM_NOT_JOINABLE");
    this.requirePlayer(room, playerId);
    if (room.revision !== expectedRevision) throw new RoomError("STALE_REVISION");
    if (room.hostPlayerId !== playerId) throw new RoomError("NOT_HOST");
    if (room.status !== "STARTED" || !room.game) throw new RoomError("GAME_NOT_STARTED");
    if (room.game.phase !== "FINISHED") throw new RoomError("GAME_NOT_FINISHED");
    room.status = "LOBBY";
    room.game = null;
    for (const player of room.players.values()) player.ready = false;
    this.bump(room);
    return room;
  }

  rematchBotGame(
    roomId: string,
    playerId: string,
    expectedRevision: number,
  ): RoomRecord {
    const room = this.requireRoom(roomId);
    const player = this.requirePlayer(room, playerId);
    if (room.mode !== "BOT" || player.kind !== "HUMAN") {
      throw new RoomError("INVALID_SESSION");
    }
    if (room.revision !== expectedRevision) throw new RoomError("STALE_REVISION");
    if (room.hostPlayerId !== playerId) throw new RoomError("NOT_HOST");
    if (room.status !== "STARTED" || !room.game) throw new RoomError("GAME_NOT_STARTED");
    if (room.game.phase !== "FINISHED") throw new RoomError("GAME_NOT_FINISHED");
    const playerOrder = [...room.players.values()]
      .sort((left, right) => left.joinOrder - right.joinOrder)
      .map((candidate) => candidate.id);
    room.game = initializeYachtGame(playerOrder);
    this.bump(room);
    return room;
  }

  markDisconnected(
    roomId: string,
    playerId: string,
    now = Date.now(),
  ): { room: RoomRecord; reconnectDeadline: number } | null {
    const room = this.rooms.get(roomId);
    const player = room?.players.get(playerId);
    if (
      !room ||
      !player ||
      player.kind !== "HUMAN" ||
      player.connectionState === "DISCONNECTED_GRACE"
    ) return null;
    const reconnectDeadline = now + this.reconnectGraceMs;
    player.connectionState = "DISCONNECTED_GRACE";
    player.reconnectDeadline = reconnectDeadline;
    player.ready = false;
    this.bump(room);
    return { room, reconnectDeadline };
  }

  expireDisconnected(
    roomId: string,
    playerId: string,
    expectedDeadline: number,
    now = Date.now(),
  ): RemovalResult | null {
    const room = this.rooms.get(roomId);
    const player = room?.players.get(playerId);
    if (
      !room ||
      !player ||
      player.connectionState !== "DISCONNECTED_GRACE" ||
      player.reconnectDeadline !== expectedDeadline ||
      expectedDeadline > now
    ) {
      return null;
    }
    return this.removePlayer(room, playerId);
  }

  leaveRoom(roomId: string, playerId: string): RemovalResult {
    return this.removePlayer(this.requireRoom(roomId), playerId);
  }

  getRoom(roomId: string): RoomRecord | undefined {
    return this.rooms.get(roomId);
  }

  getSnapshot(roomId: string): PublicRoomSnapshot {
    return this.toSnapshot(this.requireRoom(roomId));
  }

  private createUniqueRoomId(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = this.roomIdFactory();
      if (!this.rooms.has(candidate)) return candidate;
    }
    throw new RoomError("INVALID_MESSAGE");
  }

  private createPlayer(
    nickname: string,
    nicknameKey: string,
    joinOrder: number,
    kind: PlayerKind = "HUMAN",
  ): PlayerRecord {
    return {
      id: this.playerIdFactory(),
      nickname,
      nicknameKey,
      kind,
      sessionToken: kind === "HUMAN" ? this.sessionTokenFactory() : null,
      ready: false,
      connectionState: "CONNECTED",
      reconnectDeadline: null,
      joinOrder,
    };
  }

  private requireRoom(roomId: string): RoomRecord {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomError("ROOM_NOT_FOUND");
    return room;
  }

  private requirePlayer(room: RoomRecord, playerId: string): PlayerRecord {
    const player = room.players.get(playerId);
    if (!player) throw new RoomError("INVALID_SESSION");
    return player;
  }

  private requireGameRoom(
    roomId: string,
    playerId: string,
    expectedRevision: number,
  ): RoomRecord {
    const room = this.requireRoom(roomId);
    this.requirePlayer(room, playerId);
    if (room.revision !== expectedRevision) throw new RoomError("STALE_REVISION");
    if (room.status !== "STARTED" || !room.game) throw new RoomError("GAME_NOT_STARTED");
    return room;
  }

  private removePlayer(room: RoomRecord, playerId: string): RemovalResult {
    const player = this.requirePlayer(room, playerId);
    const wasActivelyPlaying = room.status === "STARTED" && room.game?.phase === "PLAYING";
    const hadGame = room.status === "STARTED" && room.game !== null;
    if (room.mode === "BOT") {
      if (player.kind !== "HUMAN") throw new RoomError("INVALID_SESSION");
      this.rooms.delete(room.id);
      return { room: null, removedPlayer: player, gameAborted: wasActivelyPlaying };
    }
    room.players.delete(playerId);
    if (room.hostPlayerId === playerId) {
      room.hostPlayerId = this.selectNextHost(room)?.id ?? null;
    }
    this.bump(room);
    if (room.players.size === 0) {
      this.rooms.delete(room.id);
      return { room: null, removedPlayer: player, gameAborted: wasActivelyPlaying };
    }
    if (hadGame) {
      room.status = "LOBBY";
      room.game = null;
      for (const remainingPlayer of room.players.values()) remainingPlayer.ready = false;
    }
    return { room, removedPlayer: player, gameAborted: wasActivelyPlaying };
  }

  private selectNextHost(room: RoomRecord): PlayerRecord | undefined {
    return [...room.players.values()]
      .filter((player) => player.kind === "HUMAN" && player.connectionState === "CONNECTED")
      .sort((left, right) => left.joinOrder - right.joinOrder)[0];
  }

  private bump(room: RoomRecord): void {
    room.revision += 1;
  }

  private toSnapshot(room: RoomRecord): PublicRoomSnapshot {
    const players = [...room.players.values()].sort(
      (left, right) => left.joinOrder - right.joinOrder,
    );
    return {
      id: room.id,
      mode: room.mode,
      revision: room.revision,
      status: room.status,
      createdAt: new Date(room.createdAt).toISOString(),
      hostPlayerId: room.hostPlayerId,
      minPlayers: MIN_PLAYERS,
      maxPlayers: room.maxPlayers,
      canStart:
        room.mode === "MULTIPLAYER" &&
        room.status === "LOBBY" &&
        players.length >= MIN_PLAYERS &&
        players.every((player) => player.connectionState === "CONNECTED") &&
        players.every((player) => player.id === room.hostPlayerId || player.ready),
      players: players.map((player) => ({
        id: player.id,
        nickname: player.nickname,
        kind: player.kind,
        ready: player.ready,
        connectionState: player.connectionState,
        joinOrder: player.joinOrder,
        isHost: player.id === room.hostPlayerId,
      })),
      game: room.game ? toPublicGameSnapshot(room.game) : null,
    };
  }
}
