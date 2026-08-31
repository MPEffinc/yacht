import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUDIO_ASSETS,
  AUDIO_POOLS,
  DEFAULT_AUDIO_VOLUMES,
  type AudioId,
} from "../client/src/audio-assets";
import {
  audioScene,
  finishedAudioAsset,
  isFinishTransition,
  isGameStartTransition,
  isRollTransition,
  isSelfTurnTransition,
  joinedPlayerIds,
  readyAudioChanges,
} from "../client/src/audio-event-policy";
import { chooseAudioPoolSample } from "../client/src/audio-manager";
import type { PublicGameSnapshot, PublicPlayer, PublicRoomSnapshot } from "../client/src/protocol";

const audioFiles = [
  "client/src/audio/bgm_lobby.mp3",
  "client/src/audio/bgm_main.mp3",
  ...[1, 2, 3].flatMap((index) => [
    `client/src/audio/dice/dice-shake-${index}.ogg`,
    `client/src/audio/dice/dice-throw-${index}.ogg`,
  ]),
  "client/src/audio/system/player_in.ogg",
  "client/src/audio/system/game_start.ogg",
  "client/src/audio/system/victory.mp3",
  "client/src/audio/system/ui_hovering.ogg",
  "client/src/audio/system/ready_off.ogg",
  "client/src/audio/system/ready_on.ogg",
  "client/src/audio/system/your_turn_alert.mp3",
  "client/src/audio/system/Lose_restart.mp3",
  "client/src/audio/system/click_002.ogg",
  "client/src/audio/system/error_001.ogg",
];

function player(id: string, ready = false, isHost = false): PublicPlayer {
  return {
    id,
    nickname: id,
    ready,
    connectionState: "CONNECTED",
    joinOrder: isHost ? 1 : 2,
    isHost,
  };
}

function game(overrides: Partial<PublicGameSnapshot> = {}): PublicGameSnapshot {
  return {
    phase: "PLAYING",
    playerOrder: ["host", "guest"],
    currentPlayerId: "host",
    dice: Array.from({ length: 5 }, () => ({ value: null, held: false })),
    rollsUsed: 0,
    rollsRemaining: 3,
    scoreCards: {},
    availableScores: null,
    matchedCombinations: [],
    round: 1,
    completedTurns: 0,
    winnerPlayerIds: [],
    ...overrides,
  };
}

function room(overrides: Partial<PublicRoomSnapshot> = {}): PublicRoomSnapshot {
  return {
    id: "ABCDEFGH",
    revision: 1,
    status: "LOBBY",
    createdAt: "2026-08-31T00:00:00.000Z",
    hostPlayerId: "host",
    minPlayers: 2,
    maxPlayers: 2,
    canStart: false,
    players: [player("host", false, true), player("guest")],
    game: null,
    ...overrides,
  };
}

describe("Yacht audio registry", () => {
  it("registers only the 18 archived Yacht assets and keeps every source file", () => {
    expect(Object.keys(AUDIO_ASSETS)).toHaveLength(18);
    expect(audioFiles).toHaveLength(18);
    for (const file of audioFiles) expect(existsSync(file), file).toBe(true);
    for (const asset of Object.values(AUDIO_ASSETS)) {
      expect(asset.url.startsWith("/audio/")).toBe(false);
    }
  });

  it("has exactly three shake and three throw variations", () => {
    expect(AUDIO_POOLS.diceShake).toEqual(["dice_shake_01", "dice_shake_02", "dice_shake_03"]);
    expect(AUDIO_POOLS.diceThrow).toEqual(["dice_throw_01", "dice_throw_02", "dice_throw_03"]);
  });

  it("never immediately repeats a pool sample when alternatives exist", () => {
    let previous: AudioId | undefined;
    for (let index = 0; index < 12; index += 1) {
      const selected = chooseAudioPoolSample(AUDIO_POOLS.diceShake, previous, () => 0);
      expect(selected).not.toBe(previous);
      previous = selected ?? undefined;
    }
  });

  it("keeps BGM below dice and system in the default mix", () => {
    expect(DEFAULT_AUDIO_VOLUMES.BGM).toBeLessThan(DEFAULT_AUDIO_VOLUMES.DICE);
    expect(DEFAULT_AUDIO_VOLUMES.BGM).toBeLessThan(DEFAULT_AUDIO_VOLUMES.SYSTEM);
  });
});

describe("Yacht audio event policy", () => {
  it("maps lobby, playing and finished snapshots to their BGM scenes", () => {
    expect(audioScene(null)).toBe("LOBBY");
    expect(audioScene(room())).toBe("LOBBY");
    expect(audioScene(room({ status: "STARTED", game: game() }))).toBe("PLAYING");
    expect(audioScene(room({ status: "STARTED", game: game({ phase: "FINISHED" }) }))).toBe("FINISHED");
  });

  it("detects a fresh start and only the self initial turn", () => {
    const previous = room();
    const next = room({ revision: 2, status: "STARTED", game: game() });
    expect(isGameStartTransition(previous, next)).toBe(true);
    expect(isSelfTurnTransition(previous, next, "host")).toBe(true);
    expect(isSelfTurnTransition(previous, next, "guest")).toBe(false);
  });

  it("detects authoritative roll increments but not reconnect baselines", () => {
    const previous = room({ status: "STARTED", game: game({ rollsUsed: 0 }) });
    const rolled = room({ revision: 2, status: "STARTED", game: game({ rollsUsed: 1, rollsRemaining: 2 }) });
    const reconnectBaseline = room({ revision: 2, status: "STARTED", game: game({ rollsUsed: 2, rollsRemaining: 1 }) });
    expect(isRollTransition(previous, rolled)).toBe(true);
    expect(isRollTransition(reconnectBaseline, reconnectBaseline)).toBe(false);
  });

  it("emits player-in and guest ready changes without treating the host as ready", () => {
    const previous = room({ players: [player("host", false, true), player("guest")] });
    const joined = room({ revision: 2, players: [...previous.players, player("third")] });
    expect(joinedPlayerIds(previous, joined)).toEqual(["third"]);

    const ready = room({ revision: 3, players: [player("host", true, true), player("guest", true)] });
    expect(readyAudioChanges(previous, ready)).toEqual([{ playerId: "guest", ready: true }]);
    expect(readyAudioChanges(ready, previous)).toEqual([{ playerId: "guest", ready: false }]);
  });

  it("selects victory for every winner and loss for another player only on a real finish", () => {
    const previous = room({ status: "STARTED", game: game() });
    const finished = room({
      revision: 2,
      status: "STARTED",
      game: game({ phase: "FINISHED", currentPlayerId: null, winnerPlayerIds: ["host"] }),
    });
    expect(isFinishTransition(previous, finished)).toBe(true);
    expect(finishedAudioAsset(finished, "host")).toBe("victory");
    expect(finishedAudioAsset(finished, "guest")).toBe("lose_restart");
    expect(finishedAudioAsset(finished, null)).toBeNull();
  });
});
