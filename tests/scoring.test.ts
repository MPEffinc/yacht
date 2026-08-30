import { describe, expect, it } from "vitest";
import {
  calculateScore,
  calculateUpperBonus,
  createEmptyScoreCard,
  scoreCardTotals,
} from "../src/game/scoring.js";

describe("RULESET_V1 scoring", () => {
  it("scores the upper section", () => {
    const dice = [1, 1, 1, 4, 6] as const;
    expect(calculateScore("ONES", dice)).toBe(3);
    expect(calculateScore("FOURS", dice)).toBe(4);
    expect(calculateScore("SIXES", dice)).toBe(6);
  });

  it("scores Choice", () => {
    expect(calculateScore("CHOICE", [6, 6, 5, 4, 3])).toBe(24);
  });

  it("scores Four of a Kind using all five dice", () => {
    expect(calculateScore("FOUR_OF_A_KIND", [4, 4, 4, 4, 6])).toBe(22);
    expect(calculateScore("FOUR_OF_A_KIND", [6, 6, 6, 6, 6])).toBe(30);
    expect(calculateScore("FOUR_OF_A_KIND", [4, 4, 4, 5, 6])).toBe(0);
  });

  it("requires an exact 2+3 Full House distribution", () => {
    expect(calculateScore("FULL_HOUSE", [3, 3, 3, 5, 5])).toBe(19);
    expect(calculateScore("FULL_HOUSE", [6, 6, 6, 5, 5])).toBe(28);
    expect(calculateScore("FULL_HOUSE", [4, 4, 4, 4, 4])).toBe(0);
    expect(calculateScore("FULL_HOUSE", [3, 3, 3, 3, 5])).toBe(0);
  });

  it("scores Small Straights with duplicate dice", () => {
    expect(calculateScore("SMALL_STRAIGHT", [1, 2, 3, 4, 4])).toBe(15);
    expect(calculateScore("SMALL_STRAIGHT", [2, 3, 4, 5, 5])).toBe(15);
    expect(calculateScore("SMALL_STRAIGHT", [3, 4, 5, 6, 6])).toBe(15);
    expect(calculateScore("SMALL_STRAIGHT", [1, 2, 3, 5, 6])).toBe(0);
  });

  it("scores only exact Large Straights", () => {
    expect(calculateScore("LARGE_STRAIGHT", [1, 2, 3, 4, 5])).toBe(30);
    expect(calculateScore("LARGE_STRAIGHT", [2, 3, 4, 5, 6])).toBe(30);
    expect(calculateScore("LARGE_STRAIGHT", [1, 2, 3, 4, 4])).toBe(0);
  });

  it("scores Yacht without an additional bonus", () => {
    expect(calculateScore("YACHT", [5, 5, 5, 5, 5])).toBe(50);
    expect(calculateScore("YACHT", [5, 5, 5, 5, 4])).toBe(0);
  });

  it("derives the 63-point upper bonus boundary", () => {
    expect(calculateUpperBonus(62)).toBe(0);
    expect(calculateUpperBonus(63)).toBe(35);
    expect(calculateUpperBonus(64)).toBe(35);
  });

  it("distinguishes unused null from a locked zero and reaches the 323 maximum", () => {
    const card = createEmptyScoreCard();
    card.ONES = 5;
    card.TWOS = 10;
    card.THREES = 15;
    card.FOURS = 20;
    card.FIVES = 25;
    card.SIXES = 30;
    card.CHOICE = 30;
    card.FOUR_OF_A_KIND = 30;
    card.FULL_HOUSE = 28;
    card.SMALL_STRAIGHT = 15;
    card.LARGE_STRAIGHT = 30;
    card.YACHT = 50;
    expect(scoreCardTotals(card)).toEqual({
      upperSubtotal: 105,
      upperBonus: 35,
      lowerSubtotal: 183,
      total: 323,
      completedCategories: 12,
    });
    card.YACHT = 0;
    expect(card.YACHT).toBe(0);
    expect(card.FULL_HOUSE).not.toBeNull();
  });
});
