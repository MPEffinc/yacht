import { describe, expect, it } from "vitest";
import { BOT_DELAY_RANGES, BotController } from "../src/bot/bot-controller.js";
import { createSeededRandom } from "../src/bot/bot-simulation.js";
import { SCORE_CATEGORIES, type DieValue } from "../src/game/types.js";
import { RoomService } from "../src/room-service.js";

function cyclingRoller(): () => DieValue {
  let value = 0;
  return () => ((value++ % 6) + 1) as DieValue;
}

function humanAndBots(botCount = 1): {
  service: RoomService;
  roomId: string;
  humanId: string;
  humanToken: string;
  botIds: string[];
} {
  const service = new RoomService({ dieRoller: cyclingRoller() });
  const created = service.createRoom("Human", Math.max(2, botCount + 1));
  for (let index = 0; index < botCount; index += 1) {
    service.addBot(created.room.id, created.player.id, created.room.revision);
  }
  service.startGame(created.room.id, created.player.id);
  return {
    service,
    roomId: created.room.id,
    humanId: created.player.id,
    humanToken: created.player.sessionToken!,
    botIds: [...created.room.players.values()]
      .filter((player) => player.kind === "BOT")
      .map((player) => player.id),
  };
}

describe("BotController", () => {
  it("dedupes timers, pauses while the human is disconnected, and resumes", () => {
    const setup = humanAndBots();
    const { service, roomId, humanId, humanToken } = setup;
    const botId = setup.botIds[0]!;
    const room = service.getRoom(roomId)!;
    service.rollDice(roomId, humanId, room.revision);
    service.scoreCategory(roomId, humanId, room.revision, "ONES");

    const tasks: Array<{ callback: () => void; cancelled: boolean; delay: number }> = [];
    const controller = new BotController({
      roomService: service,
      broadcastRoom: () => undefined,
      policyOptions: { random: createSeededRandom(1), samples: 8 },
      presentationRandom: () => .5,
      schedule: (callback, delay) => {
        const task = { callback, cancelled: false, delay };
        tasks.push(task);
        return task as never;
      },
      clearSchedule: (handle) => { (handle as never as { cancelled: boolean }).cancelled = true; },
    });

    controller.scheduleIfNeeded(roomId);
    controller.scheduleIfNeeded(roomId);
    expect(tasks.filter((task) => !task.cancelled)).toHaveLength(1);
    expect(tasks[0]!.delay).toBe(1_600);
    service.markDisconnected(roomId, humanId);
    controller.scheduleIfNeeded(roomId);
    expect(tasks.every((task) => task.cancelled)).toBe(true);
    tasks[0]!.callback();
    expect(service.getRoom(roomId)?.game?.rollsUsed).toBe(0);
    service.reconnectRoom(roomId, humanToken);
    controller.scheduleIfNeeded(roomId);
    const resumed = tasks.find((task) => !task.cancelled)!;
    resumed.callback();
    expect(service.getRoom(roomId)?.game?.currentPlayerId).toBe(botId);
    expect(service.getRoom(roomId)?.game?.rollsUsed).toBe(1);
    const afterRoll = tasks.find((task) => !task.cancelled && task !== resumed)!;
    expect(afterRoll.delay).toBeGreaterThanOrEqual(BOT_DELAY_RANGES.rollThinkNormal[0]);
    expect(afterRoll.delay).toBeLessThanOrEqual(BOT_DELAY_RANGES.rollThinkNormal[1]);
  });

  it("completes a full Human vs BOT game through authoritative RoomService mutations", () => {
    const setup = humanAndBots();
    const { service, roomId, humanId } = setup;
    const queue: Array<() => void> = [];
    const revisions: number[] = [];
    const controller = new BotController({
      roomService: service,
      broadcastRoom: (roomId) => revisions.push(service.getSnapshot(roomId).revision),
      policyOptions: { random: createSeededRandom(17), samples: 12 },
      schedule: (callback) => {
        queue.push(callback);
        return 1 as never;
      },
      clearSchedule: () => undefined,
    });

    for (const category of SCORE_CATEGORIES) {
      const room = service.getRoom(roomId)!;
      expect(room.game?.currentPlayerId).toBe(humanId);
      service.rollDice(room.id, humanId, room.revision);
      service.scoreCategory(room.id, humanId, room.revision, category);
      controller.scheduleIfNeeded(room.id);
      let safety = 0;
      while (service.getRoom(room.id)?.game?.currentPlayerId !== humanId) {
        const callback = queue.shift();
        expect(callback).toBeTypeOf("function");
        callback!();
        safety += 1;
        expect(safety).toBeLessThan(12);
        if (service.getRoom(room.id)?.game?.phase === "FINISHED") break;
      }
    }

    const game = service.getRoom(roomId)?.game;
    expect(game).toMatchObject({ phase: "FINISHED", completedTurns: 24 });
    expect(revisions.length).toBeGreaterThanOrEqual(24);
    expect(queue).toHaveLength(0);
  });

  it("runs consecutive Normal and Hard BOT turns exactly once before the next Human", () => {
    const service = new RoomService({ dieRoller: cyclingRoller() });
    const created = service.createRoom("Human A", 4);
    service.addBot(created.room.id, created.player.id, created.room.revision);
    const normalBot = [...created.room.players.values()].find((player) => player.kind === "BOT")!;
    service.addBot(created.room.id, created.player.id, created.room.revision);
    const hardBot = [...created.room.players.values()].filter((player) => player.kind === "BOT")[1]!;
    service.setBotDifficulty(created.room.id, created.player.id, created.room.revision, hardBot.id, "HARD");
    const humanB = service.joinRoom(created.room.id, "Human B").player;
    service.setReady(created.room.id, humanB.id, true);
    service.startGame(created.room.id, created.player.id);

    const queue: Array<() => void> = [];
    const botTurnRolls: string[] = [];
    const seenRollStarts = new Set<string>();
    const controller = new BotController({
      roomService: service,
      broadcastRoom: (roomId) => {
        const game = service.getSnapshot(roomId).game;
        if (game?.rollsUsed === 1 && game.currentPlayerId) {
          const key = `${game.currentPlayerId}:${game.completedTurns}`;
          if (!seenRollStarts.has(key)) {
            seenRollStarts.add(key);
            botTurnRolls.push(game.currentPlayerId);
          }
        }
      },
      policyOptions: {
        random: createSeededRandom(9),
        decisionRandom: createSeededRandom(10),
        samples: 8,
      },
      presentationRandom: createSeededRandom(11),
      schedule: (callback) => {
        queue.push(callback);
        return 1 as never;
      },
      clearSchedule: () => undefined,
    });

    let room = service.getRoom(created.room.id)!;
    service.rollDice(room.id, created.player.id, room.revision);
    room = service.getRoom(room.id)!;
    service.scoreCategory(room.id, created.player.id, room.revision, "ONES");
    controller.scheduleIfNeeded(room.id);
    let safety = 0;
    while (service.getRoom(room.id)?.game?.currentPlayerId !== humanB.id) {
      const callback = queue.shift();
      expect(callback).toBeTypeOf("function");
      callback!();
      safety += 1;
      expect(safety).toBeLessThan(24);
    }

    expect(service.getSnapshot(room.id).game).toMatchObject({
      currentPlayerId: humanB.id,
      completedTurns: 3,
    });
    expect(botTurnRolls.filter((id) => id === normalBot.id)).toHaveLength(1);
    expect(botTurnRolls.filter((id) => id === hardBot.id)).toHaveLength(1);
    expect(queue).toHaveLength(0);
  });
});
