export type RoomStatus = "LOBBY" | "STARTED";
export type ConnectionState = "CONNECTED" | "DISCONNECTED_GRACE";
export const UPPER_CATEGORIES = [
  "ONES",
  "TWOS",
  "THREES",
  "FOURS",
  "FIVES",
  "SIXES",
] as const;
export const LOWER_CATEGORIES = [
  "CHOICE",
  "FOUR_OF_A_KIND",
  "FULL_HOUSE",
  "SMALL_STRAIGHT",
  "LARGE_STRAIGHT",
  "YACHT",
] as const;
export const SCORE_CATEGORIES = [...UPPER_CATEGORIES, ...LOWER_CATEGORIES] as const;
export type ScoreCategory = (typeof SCORE_CATEGORIES)[number];
export type DieValue = 1 | 2 | 3 | 4 | 5 | 6;
export type ScoreCard = Record<ScoreCategory, number | null>;

export interface PublicGameSnapshot {
  phase: "PLAYING" | "FINISHED";
  playerOrder: string[];
  currentPlayerId: string | null;
  dice: Array<{ value: DieValue | null; held: boolean }>;
  rollsUsed: number;
  rollsRemaining: number;
  scoreCards: Record<
    string,
    {
      scores: ScoreCard;
      upperSubtotal: number;
      upperBonus: number;
      lowerSubtotal: number;
      total: number;
      completedCategories: number;
    }
  >;
  availableScores: Partial<Record<ScoreCategory, number>> | null;
  round: number;
  completedTurns: number;
  winnerPlayerIds: string[];
}

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
        | "SCORE_CATEGORY";
    }
  | { event: "LEFT"; requestId: string; roomId: string }
  | { event: "GAME_ABORTED"; message: string }
  | {
      event: "ERROR";
      code: string;
      message: string;
      requestId?: string;
    };
