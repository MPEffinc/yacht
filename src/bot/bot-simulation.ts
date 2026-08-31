import { randomBytes } from "node:crypto";
import type { DieValue } from "../game/types.js";

export type SimulationRandom = () => number;

export interface HoldCandidate {
  mask: number;
  heldIndices: number[];
}

export function createSimulationRandom(): SimulationRandom {
  let state = randomBytes(4).readUInt32LE(0) || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function createSeededRandom(seed: number): SimulationRandom {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

export function enumerateRerollCandidates(): HoldCandidate[] {
  return Array.from({ length: 31 }, (_, mask) => ({
    mask,
    heldIndices: Array.from({ length: 5 }, (_unused, index) => index).filter(
      (index) => (mask & (1 << index)) !== 0,
    ),
  }));
}

export function simulateReroll(
  dice: readonly DieValue[],
  candidate: HoldCandidate,
  random: SimulationRandom,
): DieValue[] {
  return dice.map((die, index) =>
    (candidate.mask & (1 << index)) !== 0
      ? die
      : (Math.floor(random() * 6) + 1) as DieValue,
  );
}
