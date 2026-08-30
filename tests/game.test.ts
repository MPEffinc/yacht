import { describe, expect, it } from "vitest";
import {
  initializeYachtGame,
  rollGameDice,
  scoreGameCategory,
  setGameHeldDice,
  toPublicGameSnapshot,
  YachtGameError,
} from "../src/game/game.js";
import { SCORE_CATEGORIES, type DieValue } from "../src/game/types.js";

function sequenceRoller(values: DieValue[]): () => DieValue {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? 1;
}

function expectGameError(action: () => unknown, code: YachtGameError["code"]): void {
  try {
    action();
    throw new Error(`Expected YachtGameError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(YachtGameError);
    expect((error as YachtGameError).code).toBe(code);
  }
}

describe("Yacht game state machine", () => {
  it("initializes join order, the first turn, empty dice, and empty score cards", () => {
    const game = initializeYachtGame(["alice", "bob"]);
    expect(game.playerOrder).toEqual(["alice", "bob"]);
    expect(game.currentPlayerId).toBe("alice");
    expect(game.rollsUsed).toBe(0);
    expect(game.dice).toEqual(Array.from({ length: 5 }, () => ({ value: null, held: false })));
    expect(Object.values(game.scoreCards.alice!)).toHaveLength(12);
    expect(Object.values(game.scoreCards.alice!).every((score) => score === null)).toBe(true);
  });

  it("rolls all dice first, preserves held dice, and enforces three rolls", () => {
    const game = initializeYachtGame(["alice", "bob"]);
    const roller = sequenceRoller([1, 2, 3, 4, 5, 6, 6, 6, 2, 2, 2]);
    rollGameDice(game, "alice", roller);
    expect(game.dice.map((die) => die.value)).toEqual([1, 2, 3, 4, 5]);
    expect(game.dice.every((die) => die.value! >= 1 && die.value! <= 6)).toBe(true);
    setGameHeldDice(game, "alice", [0, 2]);
    rollGameDice(game, "alice", roller);
    expect(game.dice.map((die) => die.value)).toEqual([1, 6, 3, 6, 6]);
    expect(game.dice.map((die) => die.held)).toEqual([true, false, true, false, false]);
    rollGameDice(game, "alice", roller);
    expect(game.rollsUsed).toBe(3);
    expect(game.dice[0]?.value).toBe(1);
    expect(game.dice[2]?.value).toBe(3);
    expectGameError(() => rollGameDice(game, "alice", roller), "NO_ROLLS_LEFT");
    expectGameError(() => setGameHeldDice(game, "alice", [1]), "INVALID_HOLD");
  });

  it("rejects a reroll when every die is held without changing game state", () => {
    const game = initializeYachtGame(["alice", "bob"]);
    rollGameDice(game, "alice", sequenceRoller([1, 2, 3, 4, 5]));
    setGameHeldDice(game, "alice", [0, 1, 2, 3, 4]);
    const before = structuredClone(game);
    expectGameError(() => rollGameDice(game, "alice", () => 6), "NO_DICE_TO_ROLL");
    expect(game).toEqual(before);
  });

  it("rejects actions before roll and actions from another player", () => {
    const game = initializeYachtGame(["alice", "bob"]);
    expectGameError(() => scoreGameCategory(game, "alice", "CHOICE"), "MUST_ROLL_FIRST");
    expectGameError(() => setGameHeldDice(game, "alice", [0]), "MUST_ROLL_FIRST");
    expectGameError(() => rollGameDice(game, "bob"), "NOT_YOUR_TURN");
    rollGameDice(game, "alice", () => 1);
    expectGameError(() => setGameHeldDice(game, "bob", [0]), "NOT_YOUR_TURN");
    expectGameError(() => scoreGameCategory(game, "bob", "ONES"), "NOT_YOUR_TURN");
  });

  it("locks a zero score, resets the turn, advances, and rejects category reuse", () => {
    const game = initializeYachtGame(["alice", "bob"]);
    rollGameDice(game, "alice", sequenceRoller([1, 2, 3, 4, 5]));
    expect(scoreGameCategory(game, "alice", "YACHT")).toBe(0);
    expect(game.scoreCards.alice?.YACHT).toBe(0);
    expect(game.currentPlayerId).toBe("bob");
    expect(toPublicGameSnapshot(game).round).toBe(1);
    expect(game.rollsUsed).toBe(0);
    expect(game.dice.every((die) => die.value === null && !die.held)).toBe(true);
    rollGameDice(game, "bob", () => 2);
    scoreGameCategory(game, "bob", "CHOICE");
    expect(toPublicGameSnapshot(game).round).toBe(2);
    rollGameDice(game, "alice", () => 6);
    expectGameError(() => scoreGameCategory(game, "alice", "YACHT"), "CATEGORY_ALREADY_USED");
  });

  it("progresses through 12 rounds, finishes, and supports tied winners", () => {
    const game = initializeYachtGame(["alice", "bob"]);
    for (let turn = 0; turn < SCORE_CATEGORIES.length * 2; turn += 1) {
      const actor = game.currentPlayerId!;
      const category = SCORE_CATEGORIES[Math.floor(turn / 2)]!;
      rollGameDice(game, actor, () => 6);
      scoreGameCategory(game, actor, category);
    }
    const view = toPublicGameSnapshot(game);
    expect(view.phase).toBe("FINISHED");
    expect(view.currentPlayerId).toBeNull();
    expect(view.completedTurns).toBe(24);
    expect(view.round).toBe(12);
    expect(view.winnerPlayerIds).toEqual(["alice", "bob"]);
    expect(view.scoreCards.alice?.completedCategories).toBe(12);
    expectGameError(() => rollGameDice(game, "alice"), "GAME_FINISHED");
  });

  it("selects the sole highest-total winner", () => {
    const game = initializeYachtGame(["alice", "bob"]);
    for (let turn = 0; turn < SCORE_CATEGORIES.length * 2; turn += 1) {
      const actor = game.currentPlayerId!;
      const category = SCORE_CATEGORIES[Math.floor(turn / 2)]!;
      rollGameDice(game, actor, () => (actor === "alice" ? 6 : 1));
      scoreGameCategory(game, actor, category);
    }
    expect(game.winnerPlayerIds).toEqual(["alice"]);
    expect(toPublicGameSnapshot(game).scoreCards.alice!.total).toBeGreaterThan(
      toPublicGameSnapshot(game).scoreCards.bob!.total,
    );
  });
});
