import {
  LOWER_CATEGORIES,
  SCORE_CATEGORIES,
  UPPER_CATEGORIES,
  type DieValue,
  type ScoreCard,
  type ScoreCardTotals,
  type ScoreCategory,
} from "./types.js";

const upperFace: Record<(typeof UPPER_CATEGORIES)[number], DieValue> = {
  ONES: 1,
  TWOS: 2,
  THREES: 3,
  FOURS: 4,
  FIVES: 5,
  SIXES: 6,
};

export function createEmptyScoreCard(): ScoreCard {
  return Object.fromEntries(SCORE_CATEGORIES.map((category) => [category, null])) as ScoreCard;
}

export function calculateUpperBonus(upperSubtotal: number): number {
  return upperSubtotal >= 63 ? 35 : 0;
}

export function calculateScore(
  category: ScoreCategory,
  dice: readonly DieValue[],
): number {
  if (dice.length !== 5) throw new Error("Yacht scoring requires exactly five dice");
  const sum = dice.reduce<number>((total, die) => total + die, 0);
  const counts = new Map<DieValue, number>();
  for (const die of dice) counts.set(die, (counts.get(die) ?? 0) + 1);

  if (category in upperFace) {
    const face = upperFace[category as keyof typeof upperFace];
    return dice.filter((die) => die === face).reduce<number>((total, die) => total + die, 0);
  }
  if (category === "CHOICE") return sum;
  if (category === "FOUR_OF_A_KIND") {
    return [...counts.values()].some((count) => count >= 4) ? sum : 0;
  }
  if (category === "FULL_HOUSE") {
    const distribution = [...counts.values()].sort((left, right) => left - right);
    const isThreeAndTwo =
      distribution.length === 2 && distribution[0] === 2 && distribution[1] === 3;
    const isYacht = counts.size === 1;
    return isThreeAndTwo || isYacht ? sum : 0;
  }
  const unique = new Set(dice);
  if (category === "SMALL_STRAIGHT") {
    const straights = [
      [1, 2, 3, 4],
      [2, 3, 4, 5],
      [3, 4, 5, 6],
    ];
    return straights.some((straight) => straight.every((face) => unique.has(face as DieValue)))
      ? 15
      : 0;
  }
  if (category === "LARGE_STRAIGHT") {
    const sorted = [...dice].sort((left, right) => left - right).join("");
    return sorted === "12345" || sorted === "23456" ? 30 : 0;
  }
  if (category === "YACHT") return counts.size === 1 ? 50 : 0;
  return 0;
}

export function scoreCardTotals(scoreCard: ScoreCard): ScoreCardTotals {
  let upperSubtotal = 0;
  let lowerSubtotal = 0;
  let completedCategories = 0;
  for (const category of UPPER_CATEGORIES) {
    const score = scoreCard[category];
    if (score !== null) {
      upperSubtotal += score;
      completedCategories += 1;
    }
  }
  for (const category of LOWER_CATEGORIES) {
    const score = scoreCard[category];
    if (score !== null) {
      lowerSubtotal += score;
      completedCategories += 1;
    }
  }
  const upperBonus = calculateUpperBonus(upperSubtotal);
  return {
    upperSubtotal,
    upperBonus,
    lowerSubtotal,
    total: upperSubtotal + upperBonus + lowerSubtotal,
    completedCategories,
  };
}
