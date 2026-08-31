import type { ScoreCard, DieValue } from "../game/types.js";
import { RoomService, type RoomRecord } from "../room-service.js";
import { chooseBotAction, type BotPolicyOptions } from "./bot-policy.js";

export const BOT_TURN_START_DELAY = 700;
export const BOT_AFTER_ROLL_DELAY = 1_300;
export const BOT_AFTER_KEEP_DELAY = 550;
export const BOT_BEFORE_SCORE_DELAY = 850;

type TimerHandle = ReturnType<typeof setTimeout>;
type Schedule = (callback: () => void, delay: number) => TimerHandle;

export interface BotControllerOptions {
  roomService: RoomService;
  broadcastRoom: (roomId: string) => void;
  policyOptions?: BotPolicyOptions;
  schedule?: Schedule;
  clearSchedule?: (handle: TimerHandle) => void;
}

interface PendingAction {
  handle: TimerHandle;
  revision: number;
}

export class BotController {
  private readonly roomService: RoomService;
  private readonly broadcastRoom: (roomId: string) => void;
  private readonly policyOptions: BotPolicyOptions;
  private readonly schedule: Schedule;
  private readonly clearSchedule: (handle: TimerHandle) => void;
  private readonly pending = new Map<string, PendingAction>();

  constructor(options: BotControllerOptions) {
    this.roomService = options.roomService;
    this.broadcastRoom = options.broadcastRoom;
    this.policyOptions = options.policyOptions ?? {};
    this.schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearSchedule = options.clearSchedule ?? clearTimeout;
  }

  scheduleIfNeeded(roomId: string): void {
    const room = this.roomService.getRoom(roomId);
    const bot = room ? this.activeBot(room) : null;
    if (!room || !bot) {
      this.cancelRoom(roomId);
      return;
    }
    if (this.pending.has(roomId)) return;
    if (room.game!.rollsUsed === 0) {
      this.queue(room, BOT_TURN_START_DELAY, () => this.roll(roomId, bot.id));
    } else {
      this.queue(room, BOT_AFTER_ROLL_DELAY, () => this.decide(roomId, bot.id));
    }
  }

  cancelRoom(roomId: string): void {
    const pending = this.pending.get(roomId);
    if (pending) this.clearSchedule(pending.handle);
    this.pending.delete(roomId);
  }

  cancelAll(): void {
    for (const roomId of this.pending.keys()) this.cancelRoom(roomId);
  }

  private activeBot(room: RoomRecord) {
    if (
      room.mode !== "BOT" ||
      room.status !== "STARTED" ||
      room.game?.phase !== "PLAYING" ||
      ![...room.players.values()].some(
        (player) => player.kind === "HUMAN" && player.connectionState === "CONNECTED",
      )
    ) return null;
    const current = room.game.currentPlayerId
      ? room.players.get(room.game.currentPlayerId)
      : undefined;
    return current?.kind === "BOT" ? current : null;
  }

  private queue(room: RoomRecord, delay: number, callback: () => void): void {
    const revision = room.revision;
    const handle = this.schedule(() => {
      const pending = this.pending.get(room.id);
      this.pending.delete(room.id);
      if (!pending || pending.revision !== revision || !this.isFresh(room.id, revision)) return;
      callback();
    }, delay);
    if (typeof handle === "object" && "unref" in handle) handle.unref();
    this.pending.set(room.id, { handle, revision });
  }

  private isFresh(roomId: string, revision: number): boolean {
    const room = this.roomService.getRoom(roomId);
    return Boolean(room && room.revision === revision && this.activeBot(room));
  }

  private roll(roomId: string, botId: string): void {
    const room = this.roomService.getRoom(roomId);
    if (!room || !this.activeBot(room) || room.game?.currentPlayerId !== botId) return;
    this.roomService.rollDice(roomId, botId, room.revision);
    this.broadcastRoom(roomId);
    const next = this.roomService.getRoom(roomId);
    if (next) this.queue(next, BOT_AFTER_ROLL_DELAY, () => this.decide(roomId, botId));
  }

  private decide(roomId: string, botId: string): void {
    const room = this.roomService.getRoom(roomId);
    if (!room || !this.activeBot(room) || room.game?.currentPlayerId !== botId) return;
    const dice = room.game.dice.map((die) => die.value);
    if (dice.some((die) => die === null)) return;
    const action = chooseBotAction(
      {
        dice: dice as DieValue[],
        rollsRemaining: Math.max(0, 3 - room.game.rollsUsed),
        scoreCard: room.game.scoreCards[botId] as ScoreCard,
      },
      this.policyOptions,
    );

    if (action.type === "SCORE") {
      this.queue(room, BOT_BEFORE_SCORE_DELAY, () => this.score(roomId, botId, action.category));
      return;
    }

    const currentHeld = room.game.dice.flatMap((die, index) => die.held ? [index] : []);
    const sameHeld =
      currentHeld.length === action.heldIndices.length &&
      currentHeld.every((index, position) => index === action.heldIndices[position]);
    if (!sameHeld) {
      this.roomService.setHeldDice(roomId, botId, room.revision, action.heldIndices);
      this.broadcastRoom(roomId);
    }
    const next = this.roomService.getRoom(roomId);
    if (next) this.queue(next, BOT_AFTER_KEEP_DELAY, () => this.roll(roomId, botId));
  }

  private score(roomId: string, botId: string, category: Parameters<RoomService["scoreCategory"]>[3]): void {
    const room = this.roomService.getRoom(roomId);
    if (!room || !this.activeBot(room) || room.game?.currentPlayerId !== botId) return;
    this.roomService.scoreCategory(roomId, botId, room.revision, category);
    this.broadcastRoom(roomId);
    this.scheduleIfNeeded(roomId);
  }
}
