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
export type GamePhase = "PLAYING" | "FINISHED";
export type ScoreCard = Record<ScoreCategory, number | null>;

export interface DieState {
  value: DieValue | null;
  held: boolean;
}

export interface YachtGameState {
  phase: GamePhase;
  playerOrder: string[];
  currentPlayerId: string | null;
  dice: DieState[];
  rollsUsed: number;
  scoreCards: Record<string, ScoreCard>;
  completedTurns: number;
  winnerPlayerIds: string[];
}

export interface ScoreCardTotals {
  upperSubtotal: number;
  upperBonus: number;
  lowerSubtotal: number;
  total: number;
  completedCategories: number;
}

export interface PublicScoreCard extends ScoreCardTotals {
  scores: ScoreCard;
}

export interface PublicGameSnapshot {
  phase: GamePhase;
  playerOrder: string[];
  currentPlayerId: string | null;
  dice: DieState[];
  rollsUsed: number;
  rollsRemaining: number;
  scoreCards: Record<string, PublicScoreCard>;
  availableScores: Partial<Record<ScoreCategory, number>> | null;
  round: number;
  completedTurns: number;
  winnerPlayerIds: string[];
}

export type GameErrorCode =
  | "GAME_NOT_STARTED"
  | "GAME_FINISHED"
  | "NOT_YOUR_TURN"
  | "MUST_ROLL_FIRST"
  | "NO_ROLLS_LEFT"
  | "CATEGORY_ALREADY_USED"
  | "INVALID_HOLD";

export type DieRoller = () => DieValue;
