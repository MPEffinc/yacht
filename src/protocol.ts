import { z } from "zod";
import {
  SCORE_CATEGORIES,
  type GameErrorCode,
  type PublicGameSnapshot,
} from "./game/types.js";

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
const expectedRevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const heldIndicesSchema = z
  .array(z.number().int().min(0).max(4))
  .max(5)
  .refine((indices) => new Set(indices).size === indices.length, "Held indices must be unique");

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
  z
    .object({
      event: z.literal("ROLL_DICE"),
      requestId: requestIdSchema,
      expectedRevision: expectedRevisionSchema,
    })
    .strict(),
  z
    .object({
      event: z.literal("SET_HELD_DICE"),
      requestId: requestIdSchema,
      expectedRevision: expectedRevisionSchema,
      heldIndices: heldIndicesSchema,
    })
    .strict(),
  z
    .object({
      event: z.literal("SCORE_CATEGORY"),
      requestId: requestIdSchema,
      expectedRevision: expectedRevisionSchema,
      category: z.enum(SCORE_CATEGORIES),
    })
    .strict(),
  z
    .object({
      event: z.literal("RETURN_TO_LOBBY"),
      requestId: requestIdSchema,
      expectedRevision: expectedRevisionSchema,
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
  game: PublicGameSnapshot | null;
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
  | "GAME_ALREADY_STARTED"
  | "GAME_NOT_FINISHED"
  | "STALE_REVISION"
  | GameErrorCode;

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
  GAME_NOT_FINISHED: "게임이 끝난 뒤에만 같은 방에서 다시 시작할 수 있습니다.",
  STALE_REVISION: "게임 상태가 변경되었습니다. 최신 상태로 다시 시도해 주세요.",
  GAME_NOT_STARTED: "아직 게임이 시작되지 않았습니다.",
  GAME_FINISHED: "이미 종료된 게임입니다.",
  NOT_YOUR_TURN: "현재 플레이어의 차례가 아닙니다.",
  MUST_ROLL_FIRST: "먼저 주사위를 굴려 주세요.",
  NO_ROLLS_LEFT: "이번 턴의 주사위 굴리기를 모두 사용했습니다.",
  NO_DICE_TO_ROLL: "다시 굴릴 주사위가 없습니다. KEEP을 해제하거나 점수를 선택해 주세요.",
  CATEGORY_ALREADY_USED: "이미 기록한 점수 항목입니다.",
  INVALID_HOLD: "Hold할 주사위 선택이 올바르지 않습니다.",
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
  | {
      event: "COMMAND_OK";
      requestId: string;
      command:
        | "SET_READY"
        | "START_GAME"
        | "ROLL_DICE"
        | "SET_HELD_DICE"
        | "SCORE_CATEGORY"
        | "RETURN_TO_LOBBY";
    }
  | { event: "LEFT"; requestId: string; roomId: string }
  | { event: "GAME_ABORTED"; message: string }
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
