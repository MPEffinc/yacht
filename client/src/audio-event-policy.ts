import type { PublicRoomSnapshot } from "./protocol";

export type AudioScene = "LOBBY" | "PLAYING" | "FINISHED";

export interface ReadyAudioChange {
  readonly playerId: string;
  readonly ready: boolean;
}

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
