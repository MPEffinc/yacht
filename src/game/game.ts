import { randomInt } from "node:crypto";
import { calculateScore, createEmptyScoreCard, scoreCardTotals } from "./scoring.js";
import {
  SCORE_CATEGORIES,
  type DieRoller,
  type DieState,
  type DieValue,
  type GameErrorCode,
  type PublicGameSnapshot,
  type ScoreCategory,
  type YachtGameState,
} from "./types.js";

export class YachtGameError extends Error {
  constructor(public readonly code: GameErrorCode) {
    super(code);
    this.name = "YachtGameError";
  }
}

export const cryptoDieRoller: DieRoller = () => randomInt(1, 7) as DieValue;

export function initializeYachtGame(playerOrder: readonly string[]): YachtGameState {
  if (playerOrder.length < 2) throw new Error("A Yacht game requires at least two players");
  return {
    phase: "PLAYING",
    playerOrder: [...playerOrder],
    currentPlayerId: playerOrder[0] ?? null,
    dice: Array.from({ length: 5 }, (): DieState => ({ value: null, held: false })),
    rollsUsed: 0,
    scoreCards: Object.fromEntries(
      playerOrder.map((playerId) => [playerId, createEmptyScoreCard()]),
    ),
    completedTurns: 0,
    winnerPlayerIds: [],
  };
}

function requirePlayingTurn(game: YachtGameState, playerId: string): void {
  if (game.phase === "FINISHED") throw new YachtGameError("GAME_FINISHED");
  if (game.currentPlayerId !== playerId) throw new YachtGameError("NOT_YOUR_TURN");
}

export function rollGameDice(
  game: YachtGameState,
  playerId: string,
  dieRoller: DieRoller = cryptoDieRoller,
): void {
  requirePlayingTurn(game, playerId);
  if (game.rollsUsed >= 3) throw new YachtGameError("NO_ROLLS_LEFT");
  const firstRoll = game.rollsUsed === 0;
  for (const die of game.dice) {
    if (firstRoll || !die.held) die.value = dieRoller();
  }
  game.rollsUsed += 1;
}

export function setGameHeldDice(
  game: YachtGameState,
  playerId: string,
  heldIndices: readonly number[],
): boolean {
  requirePlayingTurn(game, playerId);
  if (game.rollsUsed === 0) throw new YachtGameError("MUST_ROLL_FIRST");
  if (game.rollsUsed >= 3) throw new YachtGameError("INVALID_HOLD");
  const indices = new Set(heldIndices);
  if (
    indices.size !== heldIndices.length ||
    heldIndices.some((index) => !Number.isInteger(index) || index < 0 || index > 4)
  ) {
    throw new YachtGameError("INVALID_HOLD");
  }
  let changed = false;
  game.dice.forEach((die, index) => {
    const held = indices.has(index);
    if (die.held !== held) changed = true;
    die.held = held;
  });
  return changed;
}

function completed(game: YachtGameState): boolean {
  return game.playerOrder.every((playerId) =>
    SCORE_CATEGORIES.every((category) => game.scoreCards[playerId]?.[category] !== null),
  );
}

function calculateWinners(game: YachtGameState): string[] {
  const totals = game.playerOrder.map((playerId) => ({
    playerId,
    total: scoreCardTotals(game.scoreCards[playerId]!).total,
  }));
  const winningTotal = Math.max(...totals.map((entry) => entry.total));
  return totals.filter((entry) => entry.total === winningTotal).map((entry) => entry.playerId);
}

export function scoreGameCategory(
  game: YachtGameState,
  playerId: string,
  category: ScoreCategory,
): number {
  requirePlayingTurn(game, playerId);
  if (game.rollsUsed === 0) throw new YachtGameError("MUST_ROLL_FIRST");
  const scoreCard = game.scoreCards[playerId];
  if (!scoreCard) throw new YachtGameError("NOT_YOUR_TURN");
  if (scoreCard[category] !== null) throw new YachtGameError("CATEGORY_ALREADY_USED");
  const dice = game.dice.map((die) => die.value);
  if (dice.some((value) => value === null)) throw new YachtGameError("MUST_ROLL_FIRST");
  const score = calculateScore(category, dice as DieValue[]);
  scoreCard[category] = score;
  game.completedTurns += 1;
  game.dice = Array.from({ length: 5 }, (): DieState => ({ value: null, held: false }));
  game.rollsUsed = 0;

  if (completed(game)) {
    game.phase = "FINISHED";
    game.currentPlayerId = null;
    game.winnerPlayerIds = calculateWinners(game);
  } else {
    const currentIndex = game.playerOrder.indexOf(playerId);
    game.currentPlayerId = game.playerOrder[(currentIndex + 1) % game.playerOrder.length] ?? null;
  }
  return score;
}

export function toPublicGameSnapshot(game: YachtGameState): PublicGameSnapshot {
  const scoreCards = Object.fromEntries(
    game.playerOrder.map((playerId) => {
      const scores = game.scoreCards[playerId]!;
      return [playerId, { scores: { ...scores }, ...scoreCardTotals(scores) }];
    }),
  );
  let availableScores: PublicGameSnapshot["availableScores"] = null;
  if (game.phase === "PLAYING" && game.rollsUsed > 0 && game.currentPlayerId) {
    const currentScoreCard = game.scoreCards[game.currentPlayerId]!;
    const values = game.dice.map((die) => die.value) as DieValue[];
    availableScores = Object.fromEntries(
      SCORE_CATEGORIES.filter((category) => currentScoreCard[category] === null).map(
        (category) => [category, calculateScore(category, values)],
      ),
    );
  }
  const round =
    game.phase === "FINISHED"
      ? SCORE_CATEGORIES.length
      : Math.floor(game.completedTurns / game.playerOrder.length) + 1;
  return {
    phase: game.phase,
    playerOrder: [...game.playerOrder],
    currentPlayerId: game.currentPlayerId,
    dice: game.dice.map((die) => ({ ...die })),
    rollsUsed: game.rollsUsed,
    rollsRemaining: Math.max(0, 3 - game.rollsUsed),
    scoreCards,
    availableScores,
    round,
    completedTurns: game.completedTurns,
    winnerPlayerIds: [...game.winnerPlayerIds],
  };
}
