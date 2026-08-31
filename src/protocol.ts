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
      maxPlayers: z.number().int().min(2).max(6).optional(),
    })
    .strict(),
  z
    .object({
      event: z.literal("CREATE_BOT_GAME"),
      requestId: requestIdSchema,
      nickname: nicknameSchema,
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
  z
    .object({
      event: z.literal("REMATCH_BOT_GAME"),
      requestId: requestIdSchema,
      expectedRevision: expectedRevisionSchema,
    })
    .strict(),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type RoomStatus = "LOBBY" | "STARTED";
export type RoomMode = "MULTIPLAYER" | "BOT";
export type PlayerKind = "HUMAN" | "BOT";
export type ConnectionState = "CONNECTED" | "DISCONNECTED_GRACE";

export interface PublicPlayer {
  id: string;
  nickname: string;
  kind: PlayerKind;
  ready: boolean;
  connectionState: ConnectionState;
  joinOrder: number;
  isHost: boolean;
}

export interface PublicRoomSnapshot {
  id: string;
  mode: RoomMode;
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
  | "ROOM_NOT_JOINABLE"
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
  INVALID_MESSAGE: "THE REQUEST FORMAT IS INVALID.",
  INVALID_NICKNAME: "ENTER A NICKNAME BETWEEN 1 AND 20 CHARACTERS.",
  ROOM_NOT_FOUND: "THIS ROOM DOES NOT EXIST.",
  ROOM_NOT_JOINABLE: "THIS IS A PRIVATE BOT TABLE.",
  ROOM_FULL: "THIS ROOM IS FULL.",
  DUPLICATE_NICKNAME: "THAT NICKNAME IS ALREADY IN USE.",
  INVALID_SESSION: "THIS SESSION IS INVALID. PLEASE JOIN AGAIN.",
  NOT_HOST: "ONLY THE HOST CAN DO THAT.",
  NOT_ENOUGH_PLAYERS: "AT LEAST 2 PLAYERS ARE REQUIRED.",
  PLAYERS_NOT_READY: "ALL GUESTS MUST BE CONNECTED AND READY.",
  GAME_ALREADY_STARTED: "THIS GAME HAS ALREADY STARTED.",
  GAME_NOT_FINISHED: "FINISH THE CURRENT GAME BEFORE STARTING A REMATCH.",
  STALE_REVISION: "THE GAME STATE CHANGED. PLEASE TRY AGAIN.",
  GAME_NOT_STARTED: "THE GAME HAS NOT STARTED.",
  GAME_FINISHED: "THIS GAME HAS ALREADY FINISHED.",
  NOT_YOUR_TURN: "IT IS NOT YOUR TURN.",
  MUST_ROLL_FIRST: "ROLL THE DICE FIRST.",
  NO_ROLLS_LEFT: "NO ROLLS REMAIN THIS TURN.",
  NO_DICE_TO_ROLL: "NO DICE CAN BE ROLLED. RELEASE A DIE OR CHOOSE A SCORE.",
  CATEGORY_ALREADY_USED: "THIS SCORE CATEGORY HAS ALREADY BEEN USED.",
  INVALID_HOLD: "THE SELECTED KEEP DICE ARE INVALID.",
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
        | "RETURN_TO_LOBBY"
        | "REMATCH_BOT_GAME";
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
