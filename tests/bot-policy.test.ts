import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  chooseBestScoreCategory,
  chooseBotAction,
  evaluateScoreUtility,
  selectNormalBotAction,
  type RankedBotAction,
} from "../src/bot/bot-policy.js";
import { createSeededRandom, enumerateRerollCandidates } from "../src/bot/bot-simulation.js";
import { simulateReroll } from "../src/bot/bot-simulation.js";
import { createEmptyScoreCard } from "../src/game/scoring.js";
import { SCORE_CATEGORIES, type ScoreCard } from "../src/game/types.js";

function onlyCategory(category: keyof ScoreCard): ScoreCard {
  const card = createEmptyScoreCard();
  for (const candidate of SCORE_CATEGORIES) {
    if (candidate !== category) card[candidate] = 0;
  }
  return card;
}

describe("Yacht bot policy", () => {
  it("enumerates every legal reroll hold mask except all-held", () => {
    const candidates = enumerateRerollCandidates();
    expect(candidates).toHaveLength(31);
    expect(candidates.map((candidate) => candidate.mask)).toEqual(
      Array.from({ length: 31 }, (_, index) => index),
    );
    expect(candidates.some((candidate) => candidate.heldIndices.length === 5)).toBe(false);
  });

  it("never mutates the authoritative dice during simulation", () => {
    const dice = [1, 2, 3, 4, 5] as const;
    const before = [...dice];
    const candidate = enumerateRerollCandidates().find((entry) => entry.mask === 5)!;
    const simulated = simulateReroll(dice, candidate, createSeededRandom(7));
    expect(dice).toEqual(before);
    expect(simulated).not.toBe(dice);
    expect(simulated[0]).toBe(1);
    expect(simulated[2]).toBe(3);
  });

  it.each([
    [[6, 6, 6, 6, 6], "YACHT"],
    [[1, 2, 3, 4, 5], "LARGE_STRAIGHT"],
    [[2, 2, 2, 3, 3], "FULL_HOUSE"],
  ] as const)("scores a made combination %j as %s", (dice, category) => {
    expect(chooseBestScoreCategory(dice, createEmptyScoreCard()).category).toBe(category);
  });

  it("pursues a high triple by keeping the matching dice", () => {
    const action = chooseBotAction(
      { dice: [6, 6, 6, 2, 3], rollsRemaining: 2, scoreCard: createEmptyScoreCard() },
      "HARD",
      { random: createSeededRandom(42), samples: 384 },
    );
    expect(action).toMatchObject({ type: "REROLL", heldIndices: [0, 1, 2] });
  });

  it("pursues a large straight by keeping 1-2-3-4", () => {
    const action = chooseBotAction(
      { dice: [1, 2, 3, 4, 6], rollsRemaining: 1, scoreCard: createEmptyScoreCard() },
      "HARD",
      { random: createSeededRandom(91), samples: 384 },
    );
    expect(action).toMatchObject({ type: "REROLL", heldIndices: [0, 1, 2, 3] });
  });

  it("includes the exact upper bonus when ONES reaches 63", () => {
    const card = createEmptyScoreCard();
    card.TWOS = 10;
    card.FOURS = 20;
    card.SIXES = 30;
    expect(evaluateScoreUtility("ONES", [1, 1, 1, 2, 3], card)).toBe(38);
  });

  it("records a forced zero in the final Yacht category", () => {
    expect(
      chooseBotAction({
        dice: [1, 2, 3, 4, 6],
        rollsRemaining: 0,
        scoreCard: onlyCategory("YACHT"),
      }, "HARD"),
    ).toMatchObject({ type: "SCORE", category: "YACHT", utility: 0 });
  });

  it("keeps a production-sized decision comfortably interactive", () => {
    const durations: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      chooseBotAction(
        { dice: [6, 6, 3, 2, 1], rollsRemaining: 2, scoreCard: createEmptyScoreCard() },
        "HARD",
        { random: createSeededRandom(run + 1) },
      );
      durations.push(performance.now() - started);
    }
    const average = durations.reduce((total, duration) => total + duration, 0) / durations.length;
    expect(average).toBeLessThan(75);
  });

  it("lets Normal choose nearby second and third actions with seeded weights", () => {
    const ranked: RankedBotAction[] = [
      { action: { type: "SCORE", category: "SIXES", utility: 25 }, utility: 25 },
      { action: { type: "SCORE", category: "CHOICE", utility: 24 }, utility: 24 },
      { action: { type: "SCORE", category: "FOURS", utility: 22 }, utility: 22 },
    ];
    expect(selectNormalBotAction(ranked, () => .1)).toMatchObject({ category: "SIXES" });
    expect(selectNormalBotAction(ranked, () => .75)).toMatchObject({ category: "CHOICE" });
    expect(selectNormalBotAction(ranked, () => .95)).toMatchObject({ category: "FOURS" });
  });

  it("returns excluded Normal probability to best and never exceeds the regret cap", () => {
    const ranked: RankedBotAction[] = [
      { action: { type: "SCORE", category: "YACHT", utility: 50 }, utility: 50 },
      { action: { type: "SCORE", category: "ONES", utility: 0 }, utility: 0 },
      { action: { type: "SCORE", category: "TWOS", utility: -2 }, utility: -2 },
    ];
    expect(selectNormalBotAction(ranked, () => .999)).toMatchObject({ category: "YACHT" });
  });

  it("makes the same Normal decision for the same injected seed", () => {
    const context = {
      dice: [1, 2, 3, 4, 6] as const,
      rollsRemaining: 0,
      scoreCard: createEmptyScoreCard(),
    };
    const first = chooseBotAction(context, "NORMAL", {
      random: createSeededRandom(31),
      decisionRandom: createSeededRandom(77),
    });
    const second = chooseBotAction(context, "NORMAL", {
      random: createSeededRandom(31),
      decisionRandom: createSeededRandom(77),
    });
    expect(first).toEqual(second);
  });

  it("never throws away a made Yacht for a zero category on Normal", () => {
    expect(chooseBotAction({
      dice: [6, 6, 6, 6, 6],
      rollsRemaining: 0,
      scoreCard: createEmptyScoreCard(),
    }, "NORMAL", { decisionRandom: () => .999 })).toMatchObject({
      type: "SCORE",
      category: "YACHT",
    });
  });
});
