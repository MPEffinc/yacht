import { describe, expect, it } from "vitest";
import { BotController } from "../src/bot/bot-controller.js";
import { createSeededRandom } from "../src/bot/bot-simulation.js";
import { SCORE_CATEGORIES, type DieValue } from "../src/game/types.js";
import { RoomService } from "../src/room-service.js";

function cyclingRoller(): () => DieValue {
  let value = 0;
  return () => ((value++ % 6) + 1) as DieValue;
}

describe("BotController", () => {
  it("dedupes timers, pauses while the human is disconnected, and resumes", () => {
    const service = new RoomService({ dieRoller: cyclingRoller() });
    const created = service.createBotGame("Human");
    const human = created.player;
    const bot = [...created.room.players.values()].find((player) => player.kind === "BOT")!;
    service.rollDice(created.room.id, human.id, created.room.revision);
    service.scoreCategory(created.room.id, human.id, created.room.revision, "ONES");

    const tasks: Array<{ callback: () => void; cancelled: boolean }> = [];
    const controller = new BotController({
      roomService: service,
      broadcastRoom: () => undefined,
      policyOptions: { random: createSeededRandom(1), samples: 8 },
      schedule: (callback) => {
        const task = { callback, cancelled: false };
        tasks.push(task);
        return task as never;
      },
      clearSchedule: (handle) => { (handle as never as { cancelled: boolean }).cancelled = true; },
    });

    controller.scheduleIfNeeded(created.room.id);
    controller.scheduleIfNeeded(created.room.id);
    expect(tasks.filter((task) => !task.cancelled)).toHaveLength(1);
    service.markDisconnected(created.room.id, human.id);
    controller.scheduleIfNeeded(created.room.id);
    expect(tasks.every((task) => task.cancelled)).toBe(true);
    tasks[0]!.callback();
    expect(service.getRoom(created.room.id)?.game?.rollsUsed).toBe(0);
    service.reconnectRoom(created.room.id, human.sessionToken!);
    controller.scheduleIfNeeded(created.room.id);
    const resumed = tasks.find((task) => !task.cancelled)!;
    resumed.callback();
    expect(service.getRoom(created.room.id)?.game?.currentPlayerId).toBe(bot.id);
    expect(service.getRoom(created.room.id)?.game?.rollsUsed).toBe(1);
  });

  it("completes a full Human vs BOT game through authoritative RoomService mutations", () => {
    const service = new RoomService({ dieRoller: cyclingRoller() });
    const created = service.createBotGame("Human");
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
      const room = service.getRoom(created.room.id)!;
      expect(room.game?.currentPlayerId).toBe(created.player.id);
      service.rollDice(room.id, created.player.id, room.revision);
      service.scoreCategory(room.id, created.player.id, room.revision, category);
      controller.scheduleIfNeeded(room.id);
      let safety = 0;
      while (service.getRoom(room.id)?.game?.currentPlayerId !== created.player.id) {
        const callback = queue.shift();
        expect(callback).toBeTypeOf("function");
        callback!();
        safety += 1;
        expect(safety).toBeLessThan(12);
        if (service.getRoom(room.id)?.game?.phase === "FINISHED") break;
      }
    }

    const game = service.getRoom(created.room.id)?.game;
    expect(game).toMatchObject({ phase: "FINISHED", completedTurns: 24 });
    expect(revisions.length).toBeGreaterThanOrEqual(24);
    expect(queue).toHaveLength(0);
  });
});
