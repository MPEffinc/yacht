import { z } from "zod";

export const ROOM_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_ID_LENGTH = 8;
export const ROOM_ID_PATTERN = new RegExp(
  `^[${ROOM_ID_ALPHABET}]{${ROOM_ID_LENGTH}}$`,
);

const requestIdSchema = z.string().min(1).max(64);
const roomIdSchema = z.string().regex(ROOM_ID_PATTERN);
const nicknameSchema = z.string().max(100);
const sessionTokenSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const clientMessageSchema = z.discriminatedUnion("event", [
  z
    .object({
      event: z.literal("DIAGNOSTIC_PING"),
      id: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({
      event: z.literal("CREATE_ROOM"),
      requestId: requestIdSchema,
      nickname: nicknameSchema,
      maxPlayers: z.number().int().min(2).max(8).optional(),
    })
    .strict(),
  z
    .object({
      event: z.literal("JOIN_ROOM"),
      requestId: requestIdSchema,
      roomId: roomIdSchema,
      nickname: nicknameSchema,
    })
    .strict(),
  z
    .object({
      event: z.literal("RECONNECT_ROOM"),
      requestId: requestIdSchema,
      roomId: roomIdSchema,
      sessionToken: sessionTokenSchema,
    })
    .strict(),
  z
    .object({
      event: z.literal("LEAVE_ROOM"),
      requestId: requestIdSchema,
    })
    .strict(),
  z
    .object({
      event: z.literal("SET_READY"),
      requestId: requestIdSchema,
      ready: z.boolean(),
    })
    .strict(),
  z
    .object({
      event: z.literal("START_GAME"),
      requestId: requestIdSchema,
    })
    .strict(),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type RoomStatus = "LOBBY" | "STARTED";
export type ConnectionState = "CONNECTED" | "DISCONNECTED_GRACE";

export interface PublicPlayer {
  id: string;
  nickname: string;
  ready: boolean;
  connectionState: ConnectionState;
  joinOrder: number;
  isHost: boolean;
}

export interface PublicRoomSnapshot {
  id: string;
  revision: number;
  status: RoomStatus;
  createdAt: string;
  hostPlayerId: string | null;
  minPlayers: number;
  maxPlayers: number;
  canStart: boolean;
  players: PublicPlayer[];
}

export type RoomErrorCode =
  | "INVALID_MESSAGE"
  | "INVALID_NICKNAME"
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "DUPLICATE_NICKNAME"
  | "INVALID_SESSION"
  | "NOT_HOST"
  | "NOT_ENOUGH_PLAYERS"
  | "PLAYERS_NOT_READY"
  | "GAME_ALREADY_STARTED";

const errorMessages: Record<RoomErrorCode, string> = {
  INVALID_MESSAGE: "요청 형식이 올바르지 않습니다.",
  INVALID_NICKNAME: "닉네임은 제어 문자 없이 1~20자로 입력해 주세요.",
  ROOM_NOT_FOUND: "존재하지 않는 방입니다.",
  ROOM_FULL: "방에 빈 자리가 없습니다.",
  DUPLICATE_NICKNAME: "이미 사용 중인 닉네임입니다.",
  INVALID_SESSION: "세션이 유효하지 않습니다. 다시 입장해 주세요.",
  NOT_HOST: "방장만 실행할 수 있습니다.",
  NOT_ENOUGH_PLAYERS: "게임을 시작하려면 최소 2명이 필요합니다.",
  PLAYERS_NOT_READY: "모든 플레이어가 접속하고 Ready 상태여야 합니다.",
  GAME_ALREADY_STARTED: "이미 시작된 방에는 새로 참가할 수 없습니다.",
};

export type ServerMessage =
  | { event: "SERVER_READY"; serverTime: string }
  | { event: "DIAGNOSTIC_PONG"; id: string }
  | {
      event: "SESSION_ESTABLISHED";
      requestId: string;
      roomId: string;
      playerId: string;
      sessionToken: string;
      reconnected: boolean;
    }
  | { event: "ROOM_VIEW"; room: PublicRoomSnapshot }
  | { event: "COMMAND_OK"; requestId: string; command: "SET_READY" | "START_GAME" }
  | { event: "LEFT"; requestId: string; roomId: string }
  | {
      event: "ERROR";
      code: RoomErrorCode;
      message: string;
      requestId?: string;
    };

export function makeErrorMessage(
  code: RoomErrorCode,
  requestId?: string,
): ServerMessage {
  return {
    event: "ERROR",
    code,
    message: errorMessages[code],
    ...(requestId === undefined ? {} : { requestId }),
  };
}
