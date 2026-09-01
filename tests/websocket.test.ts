import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createYachtApplication,
  type YachtApplication,
} from "../src/app.js";
import { SCORE_CATEGORIES } from "../src/game/types.js";

interface WireMessage {
  event?: string;
  [key: string]: unknown;
}

class TestClient {
  private readonly queue: WireMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: WireMessage) => boolean;
    resolve: (message: WireMessage) => void;
  }> = [];

  private constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as WireMessage;
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex < 0) {
        this.queue.push(message);
        return;
      }
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      waiter.resolve(message);
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const socket = new WebSocket(url);
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return client;
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  sendRaw(message: string): void {
    this.socket.send(message);
  }

  waitFor(predicate: (message: WireMessage) => boolean): Promise<WireMessage> {
    const queuedIndex = this.queue.findIndex(predicate);
    if (queuedIndex >= 0) {
      const [message] = this.queue.splice(queuedIndex, 1);
      return Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("Timed out waiting for WebSocket message"));
      }, 2_000);
      timer.unref();
      waiter.resolve = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
    });
  }

  terminate(): void {
    this.socket.terminate();
  }
}

function roomView(
  predicate: (room: Record<string, unknown>) => boolean,
): (message: WireMessage) => boolean {
  return (message) =>
    message.event === "ROOM_VIEW" &&
    typeof message.room === "object" &&
    message.room !== null &&
    predicate(message.room as Record<string, unknown>);
}

describe("Yacht WebSocket lobby", () => {
  let application: YachtApplication;
  let url: string;
  let clients: TestClient[];

  beforeEach(async () => {
    application = createYachtApplication({ reconnectGraceMs: 500 });
    const port = await application.listen(0, "127.0.0.1");
    url = `ws://127.0.0.1:${port}/yacht/ws`;
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.terminate();
    await application.close();
  });

  async function connect(): Promise<TestClient> {
    const client = await TestClient.connect(url);
    clients.push(client);
    await client.waitFor((message) => message.event === "SERVER_READY");
    return client;
  }

  it("validates diagnostic and malformed messages without closing the socket", async () => {
    const client = await connect();
    client.sendRaw("not-json");
    expect(await client.waitFor((message) => message.event === "ERROR")).toMatchObject({
      code: "INVALID_MESSAGE",
    });
    client.send({ event: "DIAGNOSTIC_PING", id: "health-1" });
    expect(await client.waitFor((message) => message.event === "DIAGNOSTIC_PONG")).toEqual({
      event: "DIAGNOSTIC_PONG",
      id: "health-1",
    });
  });

  it("adds and configures a server-owned BOT through the normal lobby", async () => {
    const human = await connect();
    human.send({
      event: "CREATE_ROOM",
      requestId: "bot-create",
      nickname: "Alice",
      maxPlayers: 2,
    });
    const session = await human.waitFor(
      (message) => message.event === "SESSION_ESTABLISHED" && message.requestId === "bot-create",
    );
    const roomId = session.roomId as string;
    await human.waitFor(roomView((room) => room.revision === 1));

    human.send({ event: "ADD_BOT", requestId: "bot-add", expectedRevision: 1 });
    const [added] = await Promise.all([
      human.waitFor(roomView((room) => room.revision === 2)),
      human.waitFor((message) => message.event === "COMMAND_OK" && message.requestId === "bot-add"),
    ]);
    expect(added.room).toMatchObject({
      id: roomId,
      revision: 2,
      status: "LOBBY",
      hostPlayerId: session.playerId,
      canStart: true,
      players: [
        { id: session.playerId, kind: "HUMAN", botDifficulty: null, isHost: true },
        { nickname: "YACHT BOT 1", kind: "BOT", botDifficulty: "NORMAL", isHost: false },
      ],
    });
    const botId = (added.room as { players: Array<{ id: string; kind: string }> }).players
      .find((player) => player.kind === "BOT")!.id;

    human.send({
      event: "SET_BOT_DIFFICULTY",
      requestId: "bot-hard",
      expectedRevision: 2,
      botPlayerId: botId,
      difficulty: "HARD",
    });
    const [hardened] = await Promise.all([
      human.waitFor(roomView((room) => room.revision === 3)),
      human.waitFor((message) => message.event === "COMMAND_OK" && message.requestId === "bot-hard"),
    ]);
    expect(hardened.room).toMatchObject({
      players: [{ kind: "HUMAN" }, { id: botId, kind: "BOT", botDifficulty: "HARD" }],
    });

    human.send({
      event: "REMOVE_BOT",
      requestId: "bot-remove",
      expectedRevision: 3,
      botPlayerId: botId,
    });
    await Promise.all([
      human.waitFor(roomView((room) => room.revision === 4 && (room.players as unknown[]).length === 1)),
      human.waitFor((message) => message.event === "COMMAND_OK" && message.requestId === "bot-remove"),
    ]);

    human.send({ event: "ADD_BOT", requestId: "bot-add-again", expectedRevision: 4 });
    await Promise.all([
      human.waitFor(roomView((room) => room.revision === 5 && room.canStart === true)),
      human.waitFor((message) => message.event === "COMMAND_OK" && message.requestId === "bot-add-again"),
    ]);
    human.send({ event: "START_GAME", requestId: "bot-start" });
    const started = await human.waitFor(roomView((room) => room.revision === 6 && room.status === "STARTED"));
    expect(started.room).toMatchObject({
      game: { phase: "PLAYING", currentPlayerId: session.playerId, rollsUsed: 0 },
    });
  });

  it("runs authoritative Start → Roll → Hold → Roll → Score across two clients", async () => {
    const a = await connect();
    a.send({
      event: "CREATE_ROOM",
      requestId: "create-a",
      nickname: "Alice",
      maxPlayers: 4,
    });
    const aSession = await a.waitFor((message) => message.event === "SESSION_ESTABLISHED");
    const roomId = aSession.roomId as string;
    await a.waitFor(roomView((room) => (room.players as unknown[]).length === 1));

    const b = await connect();
    b.send({
      event: "JOIN_ROOM",
      requestId: "join-b",
      roomId,
      nickname: "Bob",
    });
    const bSession = await b.waitFor((message) => message.event === "SESSION_ESTABLISHED");
    await Promise.all([
      a.waitFor(roomView((room) => (room.players as unknown[]).length === 2)),
      b.waitFor(roomView((room) => (room.players as unknown[]).length === 2)),
    ]);

    b.send({ event: "SET_READY", requestId: "ready-b", ready: true });
    await b.waitFor((message) => message.event === "COMMAND_OK" && message.requestId === "ready-b");
    const allReady = roomView((room) => room.canStart === true);
    await Promise.all([a.waitFor(allReady), b.waitFor(allReady)]);

    a.send({ event: "START_GAME", requestId: "start-a" });
    await a.waitFor(
      (message) => message.event === "COMMAND_OK" && message.requestId === "start-a",
    );
    const started = roomView((room) => room.status === "STARTED");
    const [aView, bView] = await Promise.all([a.waitFor(started), b.waitFor(started)]);
    expect(aView.room).toEqual(bView.room);
    expect(aView.room).toMatchObject({
      id: roomId,
      status: "STARTED",
      revision: 4,
      game: { rollsUsed: 0, currentPlayerId: aSession.playerId },
    });

    b.send({ event: "ROLL_DICE", requestId: "wrong-turn", expectedRevision: 4 });
    expect(
      await b.waitFor(
        (message) => message.event === "ERROR" && message.requestId === "wrong-turn",
      ),
    ).toMatchObject({ code: "NOT_YOUR_TURN" });

    a.send({ event: "ROLL_DICE", requestId: "stale-roll", expectedRevision: 3 });
    expect(
      await a.waitFor(
        (message) => message.event === "ERROR" && message.requestId === "stale-roll",
      ),
    ).toMatchObject({ code: "STALE_REVISION" });
    await a.waitFor(roomView((room) => room.revision === 4));

    a.send({ event: "ROLL_DICE", requestId: "roll-a-1", expectedRevision: 4 });
    await a.waitFor(
      (message) => message.event === "COMMAND_OK" && message.requestId === "roll-a-1",
    );
    const rolledRevision5 = roomView((room) => room.revision === 5);
    const [aRolled, bRolled] = await Promise.all([
      a.waitFor(rolledRevision5),
      b.waitFor(rolledRevision5),
    ]);
    expect(aRolled.room).toEqual(bRolled.room);
    const firstDice = (
      (aRolled.room as { game: { dice: Array<{ value: number; held: boolean }> } }).game.dice
    );
    expect(firstDice).toHaveLength(5);
    expect(firstDice.every((die) => die.value >= 1 && die.value <= 6)).toBe(true);

    a.send({
      event: "SET_HELD_DICE",
      requestId: "hold-a",
      expectedRevision: 5,
      heldIndices: [0, 2],
    });
    await a.waitFor(
      (message) => message.event === "COMMAND_OK" && message.requestId === "hold-a",
    );
    const heldRevision6 = roomView((room) => room.revision === 6);
    await Promise.all([a.waitFor(heldRevision6), b.waitFor(heldRevision6)]);

    a.send({ event: "ROLL_DICE", requestId: "roll-a-2", expectedRevision: 6 });
    await a.waitFor(
      (message) => message.event === "COMMAND_OK" && message.requestId === "roll-a-2",
    );
    const rolledRevision7 = roomView((room) => room.revision === 7);
    const [aRerolled, bRerolled] = await Promise.all([
      a.waitFor(rolledRevision7),
      b.waitFor(rolledRevision7),
    ]);
    expect(aRerolled.room).toEqual(bRerolled.room);
    const secondDice = (
      (aRerolled.room as { game: { dice: Array<{ value: number; held: boolean }> } }).game.dice
    );
    expect(secondDice[0]).toEqual({ value: firstDice[0]?.value, held: true });
    expect(secondDice[2]).toEqual({ value: firstDice[2]?.value, held: true });

    a.send({
      event: "SCORE_CATEGORY",
      requestId: "score-a",
      expectedRevision: 7,
      category: "CHOICE",
    });
    await a.waitFor(
      (message) => message.event === "COMMAND_OK" && message.requestId === "score-a",
    );
    const scoredRevision8 = roomView((room) => room.revision === 8);
    const [aScored, bScored] = await Promise.all([
      a.waitFor(scoredRevision8),
      b.waitFor(scoredRevision8),
    ]);
    expect(aScored.room).toEqual(bScored.room);
    expect(aScored.room).toMatchObject({
      revision: 8,
      game: {
        currentPlayerId: bSession.playerId,
      },
    });
    const scoredGame = (aScored.room as {
      game: {
        currentPlayerId: string;
        rollsUsed: number;
        dice: Array<{ value: number | null; held: boolean }>;
        scoreCards: Record<string, { scores: { CHOICE: number | null } }>;
      };
    }).game;
    expect(scoredGame.currentPlayerId).not.toBe(aSession.playerId);
    expect(scoredGame.rollsUsed).toBe(0);
    expect(scoredGame.dice.every((die) => die.value === null && !die.held)).toBe(true);
    expect(scoredGame.scoreCards[aSession.playerId as string]?.scores.CHOICE).toBeGreaterThanOrEqual(5);
  });

  it("finishes a match, returns to the same lobby, and starts a clean rematch", async () => {
    const a = await connect();
    a.send({ event: "CREATE_ROOM", requestId: "rematch-create", nickname: "Alice", maxPlayers: 2 });
    const aSession = await a.waitFor((message) => message.event === "SESSION_ESTABLISHED");
    const roomId = aSession.roomId as string;
    await a.waitFor(roomView((room) => room.revision === 1));

    const b = await connect();
    b.send({ event: "JOIN_ROOM", requestId: "rematch-join", roomId, nickname: "Bob" });
    const bSession = await b.waitFor((message) => message.event === "SESSION_ESTABLISHED");
    await Promise.all([
      a.waitFor(roomView((room) => room.revision === 2)),
      b.waitFor(roomView((room) => room.revision === 2)),
    ]);

    async function mutate(
      client: TestClient,
      request: Record<string, unknown>,
      nextRevision: number,
    ): Promise<Record<string, unknown>> {
      client.send(request);
      const [aView, bView] = await Promise.all([
        a.waitFor(roomView((room) => room.revision === nextRevision)),
        b.waitFor(roomView((room) => room.revision === nextRevision)),
        client.waitFor(
          (message) => message.event === "COMMAND_OK" && message.requestId === request.requestId,
        ),
      ]);
      expect(aView.room).toEqual(bView.room);
      return aView.room as Record<string, unknown>;
    }

    let revision = 2;
    await mutate(
      b,
      { event: "SET_READY", requestId: "rematch-ready-b", ready: true },
      ++revision,
    );
    let latest = await mutate(
      a,
      { event: "START_GAME", requestId: "rematch-start" },
      ++revision,
    );

    const clientsByPlayer = new Map<string, TestClient>([
      [aSession.playerId as string, a],
      [bSession.playerId as string, b],
    ]);
    for (const category of SCORE_CATEGORIES) {
      for (let playerTurn = 0; playerTurn < 2; playerTurn += 1) {
        const game = latest.game as { currentPlayerId: string };
        const actor = clientsByPlayer.get(game.currentPlayerId)!;
        latest = await mutate(
          actor,
          {
            event: "ROLL_DICE",
            requestId: `rematch-roll-${revision}`,
            expectedRevision: revision,
          },
          ++revision,
        );
        latest = await mutate(
          actor,
          {
            event: "SCORE_CATEGORY",
            requestId: `rematch-score-${revision}`,
            expectedRevision: revision,
            category,
          },
          ++revision,
        );
      }
    }
    expect(latest).toMatchObject({
      id: roomId,
      status: "STARTED",
      game: { phase: "FINISHED", completedTurns: 24 },
    });

    latest = await mutate(
      a,
      {
        event: "RETURN_TO_LOBBY",
        requestId: "rematch-return",
        expectedRevision: revision,
      },
      ++revision,
    );
    expect(latest).toMatchObject({
      id: roomId,
      status: "LOBBY",
      game: null,
      hostPlayerId: aSession.playerId,
    });
    expect(
      (latest.players as Array<{ id: string; ready: boolean }>).map((player) => player.id),
    ).toEqual([aSession.playerId, bSession.playerId]);
    expect(
      (latest.players as Array<{ ready: boolean }>).every((player) => !player.ready),
    ).toBe(true);

    await mutate(
      b,
      { event: "SET_READY", requestId: "rematch-ready-again-b", ready: true },
      ++revision,
    );
    latest = await mutate(
      a,
      { event: "START_GAME", requestId: "rematch-start-again" },
      ++revision,
    );
    const newGame = latest.game as {
      phase: string;
      completedTurns: number;
      rollsUsed: number;
      dice: Array<{ value: number | null; held: boolean }>;
      scoreCards: Record<string, { scores: Record<string, number | null> }>;
      winnerPlayerIds: string[];
    };
    expect(newGame.phase).toBe("PLAYING");
    expect(newGame.completedTurns).toBe(0);
    expect(newGame.rollsUsed).toBe(0);
    expect(newGame.dice.every((die) => die.value === null && !die.held)).toBe(true);
    expect(newGame.winnerPlayerIds).toEqual([]);
    expect(
      Object.values(newGame.scoreCards).every((card) =>
        Object.values(card.scores).every((score) => score === null),
      ),
    ).toBe(true);
  });
});
