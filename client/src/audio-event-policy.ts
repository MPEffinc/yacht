import {
  SCORE_CATEGORIES,
  type PublicRoomSnapshot,
  type ScoreCategory,
} from "./protocol";

export type AudioScene = "LOBBY" | "PLAYING" | "FINISHED";

export interface ReadyAudioChange {
  readonly playerId: string;
  readonly ready: boolean;
}

export interface ScoreWriteAudioChange {
  readonly playerId: string;
  readonly category: ScoreCategory;
  readonly score: number;
}

const SPECIAL_COMBINATIONS = new Set<ScoreCategory>([
  "SMALL_STRAIGHT",
  "LARGE_STRAIGHT",
  "FULL_HOUSE",
  "FOUR_OF_A_KIND",
]);

export function audioScene(room: PublicRoomSnapshot | null): AudioScene {
  if (room?.status !== "STARTED" || !room.game) return "LOBBY";
  return room.game.phase === "FINISHED" ? "FINISHED" : "PLAYING";
}

export function isGameStartTransition(
  previous: PublicRoomSnapshot,
  next: PublicRoomSnapshot,
): boolean {
  return previous.id === next.id && previous.status === "LOBBY" && next.status === "STARTED";
}

export function joinedPlayerIds(
  previous: PublicRoomSnapshot,
  next: PublicRoomSnapshot,
): string[] {
  if (previous.id !== next.id || previous.status !== "LOBBY" || next.status !== "LOBBY") return [];
  const previousIds = new Set(previous.players.map((player) => player.id));
  return next.players
    .filter((player) => !previousIds.has(player.id))
    .map((player) => player.id);
}

export function readyAudioChanges(
  previous: PublicRoomSnapshot,
  next: PublicRoomSnapshot,
): ReadyAudioChange[] {
  if (previous.id !== next.id || previous.status !== "LOBBY" || next.status !== "LOBBY") return [];
  const previousReady = new Map(previous.players.map((player) => [player.id, player.ready]));
  return next.players
    .filter((player) => !player.isHost && previousReady.has(player.id) && previousReady.get(player.id) !== player.ready)
    .map((player) => ({ playerId: player.id, ready: player.ready }));
}

export function isRollTransition(
  previous: PublicRoomSnapshot,
  next: PublicRoomSnapshot,
): boolean {
  const previousGame = previous.game;
  const nextGame = next.game;
  return previous.id === next.id
    && next.revision > previous.revision
    && previous.status === "STARTED"
    && next.status === "STARTED"
    && previousGame?.phase === "PLAYING"
    && nextGame?.phase === "PLAYING"
    && previousGame.currentPlayerId !== null
    && previousGame.currentPlayerId === nextGame.currentPlayerId
    && nextGame.rollsUsed === previousGame.rollsUsed + 1;
}

export function rollResultAudioAsset(
  room: PublicRoomSnapshot,
): "alert_normal_combination" | "alert_special_combination" | "alert_yacht" | null {
  const game = room.game;
  if (game?.phase !== "PLAYING" || game.rollsUsed < 1) return null;
  if (game.matchedCombinations.includes("YACHT")) return "alert_yacht";
  if (game.matchedCombinations.some((category) => SPECIAL_COMBINATIONS.has(category))) {
    return "alert_special_combination";
  }
  return "alert_normal_combination";
}

export function scoreWriteAudioChanges(
  previous: PublicRoomSnapshot,
  next: PublicRoomSnapshot,
): ScoreWriteAudioChange[] {
  const previousGame = previous.game;
  const nextGame = next.game;
  if (
    previous.id !== next.id
    || next.revision <= previous.revision
    || previous.status !== "STARTED"
    || next.status !== "STARTED"
    || previousGame?.phase !== "PLAYING"
    || !nextGame
    || nextGame.completedTurns !== previousGame.completedTurns + 1
  ) return [];

  const changes: ScoreWriteAudioChange[] = [];
  for (const playerId of nextGame.playerOrder) {
    const previousScores = previousGame.scoreCards[playerId]?.scores;
    const nextScores = nextGame.scoreCards[playerId]?.scores;
    if (!previousScores || !nextScores) continue;
    for (const category of SCORE_CATEGORIES) {
      const score = nextScores[category];
      if (previousScores[category] === null && typeof score === "number") {
        changes.push({ playerId, category, score });
      }
    }
  }
  return changes;
}

export function isSelfTurnTransition(
  previous: PublicRoomSnapshot,
  next: PublicRoomSnapshot,
  selfPlayerId: string | null,
): boolean {
  if (!selfPlayerId || next.game?.phase !== "PLAYING" || next.game.currentPlayerId !== selfPlayerId) return false;
  if (isGameStartTransition(previous, next)) return true;
  return previous.id === next.id
    && previous.game?.phase === "PLAYING"
    && previous.game.currentPlayerId !== next.game.currentPlayerId;
}

export function isFinishTransition(
  previous: PublicRoomSnapshot,
  next: PublicRoomSnapshot,
): boolean {
  return previous.id === next.id
    && previous.game?.phase === "PLAYING"
    && next.game?.phase === "FINISHED";
}

export function finishedAudioAsset(
  room: PublicRoomSnapshot,
  selfPlayerId: string | null,
): "victory" | "lose_restart" | null {
  if (!selfPlayerId || room.game?.phase !== "FINISHED") return null;
  if (!room.game.playerOrder.includes(selfPlayerId)) return null;
  return room.game.winnerPlayerIds.includes(selfPlayerId) ? "victory" : "lose_restart";
}
