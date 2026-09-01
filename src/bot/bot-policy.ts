import { scoreCardTotals } from "../game/scoring.js";
import {
  SCORE_CATEGORIES,
  UPPER_CATEGORIES,
  type DieValue,
  type ScoreCard,
  type ScoreCategory,
} from "../game/types.js";
import {
  createSimulationRandom,
  enumerateRerollCandidates,
  simulateReroll,
  type SimulationRandom,
} from "./bot-simulation.js";
import type { BotDifficulty } from "../protocol.js";

export const BOT_MONTE_CARLO_SAMPLES = 192;
export const BOT_REROLL_MARGIN = 0.75;
export const NORMAL_BOT_REGRET_CAP = 4;
export const NORMAL_BOT_WEIGHTS = [0.72, 0.2, 0.08] as const;

const ZERO_SCORE_PENALTY: Partial<Record<ScoreCategory, number>> = {
  ONES: 1,
  TWOS: 2,
  THREES: 3,
  FOURS: 4,
  FIVES: 5,
  SIXES: 6,
  SMALL_STRAIGHT: 6,
  FULL_HOUSE: 7,
  FOUR_OF_A_KIND: 8,
  LARGE_STRAIGHT: 12,
  YACHT: 20,
};

const UPPER_MAXIMUM: Record<(typeof UPPER_CATEGORIES)[number], number> = {
  ONES: 5,
  TWOS: 10,
  THREES: 15,
  FOURS: 20,
  FIVES: 25,
  SIXES: 30,
};

export interface BotDecisionContext {
  dice: readonly DieValue[];
  rollsRemaining: number;
  scoreCard: ScoreCard;
}

export interface BotPolicyOptions {
  samples?: number;
  random?: SimulationRandom;
  decisionRandom?: SimulationRandom;
  rerollMargin?: number;
}

export type BotAction =
  | { type: "SCORE"; category: ScoreCategory; utility: number }
  | { type: "REROLL"; heldIndices: number[]; expectedUtility: number };

export interface RankedBotAction {
  action: BotAction;
  utility: number;
}

export interface ScoreChoice {
  category: ScoreCategory;
  score: number;
  utility: number;
}

interface EvaluationContext {
  beforeUpperBonus: number;
  upperSubtotal: number;
  remainingCategories: number;
  opportunityFactor: number;
  remainingUpperMaximum: number;
  scoreCard: ScoreCard;
}

function createEvaluationContext(scoreCard: ScoreCard): EvaluationContext {
  const before = scoreCardTotals(scoreCard);
  const remainingCategories = SCORE_CATEGORIES.reduce(
    (total, category) => total + (scoreCard[category] === null ? 1 : 0),
    0,
  );
  const remainingUpperMaximum = UPPER_CATEGORIES.reduce(
    (total, category) => total + (scoreCard[category] === null ? UPPER_MAXIMUM[category] : 0),
    0,
  );
  return {
    beforeUpperBonus: before.upperBonus,
    upperSubtotal: before.upperSubtotal,
    remainingCategories,
    opportunityFactor: Math.max(0, (remainingCategories - 1) / (SCORE_CATEGORIES.length - 1)),
    remainingUpperMaximum,
    scoreCard,
  };
}

function scoresForDice(dice: readonly DieValue[]): Record<ScoreCategory, number> {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  let sum = 0;
  for (const die of dice) {
    counts[die] += 1;
    sum += die;
  }
  const uniqueCount = counts.reduce((total, count) => total + (count > 0 ? 1 : 0), 0);
  const hasSmallStraight =
    (counts[1] > 0 && counts[2] > 0 && counts[3] > 0 && counts[4] > 0)
    || (counts[2] > 0 && counts[3] > 0 && counts[4] > 0 && counts[5] > 0)
    || (counts[3] > 0 && counts[4] > 0 && counts[5] > 0 && counts[6] > 0);
  const hasLargeStraight = uniqueCount === 5 && (
    (counts[1] > 0 && counts[2] > 0 && counts[3] > 0 && counts[4] > 0 && counts[5] > 0)
    || (counts[2] > 0 && counts[3] > 0 && counts[4] > 0 && counts[5] > 0 && counts[6] > 0)
  );
  const hasFullHouse = counts.some((count) => count === 5)
    || (counts.some((count) => count === 3) && counts.some((count) => count === 2));
  return {
    ONES: counts[1],
    TWOS: counts[2] * 2,
    THREES: counts[3] * 3,
    FOURS: counts[4] * 4,
    FIVES: counts[5] * 5,
    SIXES: counts[6] * 6,
    CHOICE: sum,
    FOUR_OF_A_KIND: counts.some((count) => count >= 4) ? sum : 0,
    FULL_HOUSE: hasFullHouse ? sum : 0,
    SMALL_STRAIGHT: hasSmallStraight ? 15 : 0,
    LARGE_STRAIGHT: hasLargeStraight ? 30 : 0,
    YACHT: counts.some((count) => count === 5) ? 50 : 0,
  };
}

function utilityForScore(
  category: ScoreCategory,
  score: number,
  context: EvaluationContext,
): number {
  const upperCategory = UPPER_CATEGORIES.includes(category as (typeof UPPER_CATEGORIES)[number]);
  let utility = score;
  const gainsBonus = upperCategory
    && context.beforeUpperBonus === 0
    && context.upperSubtotal + score >= 63;
  if (gainsBonus) utility += 35;
  if (
    score > 0
    && upperCategory
    && context.beforeUpperBonus === 0
    && !gainsBonus
    && context.upperSubtotal + score
      + context.remainingUpperMaximum
      - UPPER_MAXIMUM[category as (typeof UPPER_CATEGORIES)[number]] >= 63
  ) utility += score * 0.35;
  if (score === 0) utility -= (ZERO_SCORE_PENALTY[category] ?? 0) * context.opportunityFactor;
  if (category === "CHOICE" && score < 23) utility -= (23 - score) * 0.35;
  return utility;
}

function bestScoreWithContext(
  dice: readonly DieValue[],
  context: EvaluationContext,
): ScoreChoice {
  const best = scoreChoicesWithContext(dice, context)[0];
  if (!best) throw new Error("The bot has no score category available");
  return best;
}

function scoreChoicesWithContext(
  dice: readonly DieValue[],
  context: EvaluationContext,
): ScoreChoice[] {
  const scores = scoresForDice(dice);
  const choices: ScoreChoice[] = [];
  for (const category of SCORE_CATEGORIES) {
    if (context.scoreCard[category] !== null) continue;
    const score = scores[category];
    const utility = utilityForScore(category, score, context);
    choices.push({ category, score, utility });
  }
  return choices.sort((left, right) => right.utility - left.utility);
}

function holdStrategyBonus(
  dice: readonly DieValue[],
  heldIndices: readonly number[],
  scoreCard: ScoreCard,
): number {
  if (scoreCard.LARGE_STRAIGHT !== null || heldIndices.length !== 4) return 0;
  const held = new Set(heldIndices.map((index) => dice[index]));
  const nearLargeStraight = held.size === 4
    && ([1, 2, 3, 4, 5].filter((face) => held.has(face as DieValue)).length === 4
      || [2, 3, 4, 5, 6].filter((face) => held.has(face as DieValue)).length === 4);
  if (!nearLargeStraight) return 0;
  const hasSmallStraightFloor = [
    [1, 2, 3, 4],
    [2, 3, 4, 5],
    [3, 4, 5, 6],
  ].some((straight) => straight.every((face) => held.has(face as DieValue)));
  return hasSmallStraightFloor ? 6 : 2;
}

export function evaluateScoreUtility(
  category: ScoreCategory,
  dice: readonly DieValue[],
  scoreCard: ScoreCard,
): number {
  if (scoreCard[category] !== null) return Number.NEGATIVE_INFINITY;
  const context = createEvaluationContext(scoreCard);
  return utilityForScore(category, scoresForDice(dice)[category], context);
}

export function chooseBestScoreCategory(
  dice: readonly DieValue[],
  scoreCard: ScoreCard,
): ScoreChoice {
  return bestScoreWithContext(dice, createEvaluationContext(scoreCard));
}

export function evaluateBotActions(
  context: BotDecisionContext,
  options: BotPolicyOptions = {},
): RankedBotAction[] {
  const evaluation = createEvaluationContext(context.scoreCard);
  const ranked: RankedBotAction[] = scoreChoicesWithContext(context.dice, evaluation).map(
    (choice) => ({
      action: { type: "SCORE", category: choice.category, utility: choice.utility },
      utility: choice.utility,
    }),
  );
  if (context.rollsRemaining <= 0) {
    return ranked;
  }

  const samples = Math.max(1, Math.floor(options.samples ?? BOT_MONTE_CARLO_SAMPLES));
  const random = options.random ?? createSimulationRandom();
  const rerollMargin = options.rerollMargin ?? BOT_REROLL_MARGIN;

  for (const candidate of enumerateRerollCandidates()) {
    let totalUtility = 0;
    for (let sample = 0; sample < samples; sample += 1) {
      const simulatedDice = simulateReroll(context.dice, candidate, random);
      totalUtility += bestScoreWithContext(simulatedDice, evaluation).utility;
    }
    const expectedUtility = totalUtility / samples
      + holdStrategyBonus(context.dice, candidate.heldIndices, context.scoreCard);
    ranked.push({
      action: {
        type: "REROLL",
        heldIndices: candidate.heldIndices,
        expectedUtility,
      },
      utility: expectedUtility - rerollMargin,
    });
  }

  return ranked.sort((left, right) => right.utility - left.utility);
}

export function chooseHardBotAction(
  context: BotDecisionContext,
  options: BotPolicyOptions = {},
): BotAction {
  const best = evaluateBotActions(context, options)[0];
  if (!best) throw new Error("The bot has no action available");
  return best.action;
}

export function chooseNormalBotAction(
  context: BotDecisionContext,
  options: BotPolicyOptions = {},
): BotAction {
  const ranked = evaluateBotActions(context, options);
  return selectNormalBotAction(
    ranked,
    options.decisionRandom ?? createSimulationRandom(),
  );
}

export function selectNormalBotAction(
  ranked: readonly RankedBotAction[],
  decisionRandom: SimulationRandom = createSimulationRandom(),
): BotAction {
  const best = ranked[0];
  if (!best) throw new Error("The bot has no action available");
  const candidates = ranked
    .slice(0, 3)
    .filter((candidate) => candidate.utility >= best.utility - NORMAL_BOT_REGRET_CAP);
  const weights = NORMAL_BOT_WEIGHTS.slice(0, candidates.length);
  const missingWeight = NORMAL_BOT_WEIGHTS
    .slice(candidates.length)
    .reduce((sum, weight) => sum + weight, 0);
  const effectiveWeights = weights.map((weight, index) =>
    index === 0 ? weight + missingWeight : weight,
  );
  const selection = decisionRandom();
  let cumulative = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    cumulative += effectiveWeights[index] ?? 0;
    if (selection < cumulative) return candidates[index]!.action;
  }
  return best.action;
}

export function chooseBotAction(
  context: BotDecisionContext,
  difficulty: BotDifficulty,
  options: BotPolicyOptions = {},
): BotAction {
  return difficulty === "HARD"
    ? chooseHardBotAction(context, options)
    : chooseNormalBotAction(context, options);
}
