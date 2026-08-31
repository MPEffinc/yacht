import { describe, expect, it } from "vitest";
import { YachtGameError } from "../src/game/game.js";
import { SCORE_CATEGORIES, type DieValue } from "../src/game/types.js";
import { RoomError, RoomService } from "../src/room-service.js";

function expectRoomError(action: () => unknown, code: RoomError["code"]): void {
  try {
    action();
    throw new Error(`Expected RoomError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RoomError);
    expect((error as RoomError).code).toBe(code);
  }
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

function startedRoom(reconnectGraceMs = 60_000): {
  service: RoomService;
  roomId: string;
  hostId: string;
  hostToken: string;
  guestId: string;
  guestToken: string;
} {
  const values: DieValue[] = [1, 2, 3, 4, 5, 6, 6, 6, 6, 6];
  let rollIndex = 0;
  const service = new RoomService({
    reconnectGraceMs,
    dieRoller: () => values[rollIndex++] ?? 6,
  });
  const created = service.createRoom("Host", 6);
  const host = created.player;
  const roomId = created.room.id;
  const guest = service.joinRoom(roomId, "Guest").player;
  service.setReady(roomId, guest.id, true);
  service.startGame(roomId, host.id);
  return {
    service,
    roomId,
    hostId: host.id,
    hostToken: host.sessionToken,
    guestId: guest.id,
    guestToken: guest.sessionToken,
  };
}

function finishGame(context: ReturnType<typeof startedRoom>): void {
  const { service, roomId } = context;
  while (service.getSnapshot(roomId).game?.phase === "PLAYING") {
    let snapshot = service.getSnapshot(roomId);
    const game = snapshot.game!;
    const actor = game.currentPlayerId!;
    const category = SCORE_CATEGORIES[Math.floor(game.completedTurns / game.playerOrder.length)]!;
    service.rollDice(roomId, actor, snapshot.revision);
    snapshot = service.getSnapshot(roomId);
    service.scoreCategory(roomId, actor, snapshot.revision, category);
  }
}

describe("RoomService Phase 2 integration", () => {
  it("creates game state in join order when START_GAME succeeds", () => {
    const { service, roomId, hostId, guestId } = startedRoom();
    const snapshot = service.getSnapshot(roomId);
    expect(snapshot.status).toBe("STARTED");
    expect(snapshot.game?.playerOrder).toEqual([hostId, guestId]);
    expect(snapshot.game?.currentPlayerId).toBe(hostId);
    expect(snapshot.game?.dice.every((die) => die.value === null)).toBe(true);
    expect(snapshot.game?.rollsUsed).toBe(0);
  });

  it("rejects stale and duplicate game commands without consuming another roll", () => {
    const { service, roomId, hostId } = startedRoom();
    const revision = service.getSnapshot(roomId).revision;
    expectRoomError(() => service.rollDice(roomId, hostId, revision - 1), "STALE_REVISION");
    expect(service.getSnapshot(roomId).game?.rollsUsed).toBe(0);
    service.rollDice(roomId, hostId, revision);
    const afterRoll = service.getSnapshot(roomId);
    expect(afterRoll.game?.rollsUsed).toBe(1);
    expectRoomError(() => service.rollDice(roomId, hostId, revision), "STALE_REVISION");
    expect(service.getSnapshot(roomId).game?.rollsUsed).toBe(1);
  });

  it("rejects an all-kept reroll without changing dice, rolls, or revision", () => {
    const { service, roomId, hostId } = startedRoom();
    let revision = service.getSnapshot(roomId).revision;
    service.rollDice(roomId, hostId, revision);
    revision = service.getSnapshot(roomId).revision;
    service.setHeldDice(roomId, hostId, revision, [0, 1, 2, 3, 4]);
    const before = service.getSnapshot(roomId);
    expectGameError(
      () => service.rollDice(roomId, hostId, before.revision),
      "NO_DICE_TO_ROLL",
    );
    expect(service.getSnapshot(roomId)).toEqual(before);
  });

  it("preserves game state through disconnect and reconnect", () => {
    const { service, roomId, hostId, hostToken } = startedRoom();
    let revision = service.getSnapshot(roomId).revision;
    service.rollDice(roomId, hostId, revision);
    revision = service.getSnapshot(roomId).revision;
    service.setHeldDice(roomId, hostId, revision, [0, 2]);
    const before = service.getSnapshot(roomId).game;
    service.markDisconnected(roomId, hostId, 1_000);
    expect(service.getSnapshot(roomId).game).toEqual(before);
    expect(service.getSnapshot(roomId).game?.currentPlayerId).toBe(hostId);
    service.reconnectRoom(roomId, hostToken, 2_000);
    expect(service.getSnapshot(roomId).game).toEqual(before);
  });

  it("aborts a started game to a clean lobby on explicit leave", () => {
    const { service, roomId, hostId, guestId } = startedRoom();
    const removal = service.leaveRoom(roomId, hostId);
    const snapshot = service.getSnapshot(roomId);
    expect(removal.gameAborted).toBe(true);
    expect(snapshot.status).toBe("LOBBY");
    expect(snapshot.game).toBeNull();
    expect(snapshot.hostPlayerId).toBe(guestId);
    expect(snapshot.players.every((player) => !player.ready)).toBe(true);
  });

  it("aborts a started game when reconnect grace expires", () => {
    const { service, roomId, guestId } = startedRoom(100);
    const disconnected = service.markDisconnected(roomId, guestId, 1_000)!;
    const removal = service.expireDisconnected(
      roomId,
      guestId,
      disconnected.reconnectDeadline,
      1_100,
    );
    const snapshot = service.getSnapshot(roomId);
    expect(removal?.gameAborted).toBe(true);
    expect(snapshot.status).toBe("LOBBY");
    expect(snapshot.game).toBeNull();
    expect(snapshot.players.every((player) => !player.ready)).toBe(true);
  });

  it("returns a finished game to the same lobby while preserving room and sessions", () => {
    const context = startedRoom();
    const { service, roomId, hostId, hostToken, guestId, guestToken } = context;
    const originalHost = service.getRoom(roomId)?.hostPlayerId;
    finishGame(context);
    const finished = service.getSnapshot(roomId);
    expect(finished.game?.phase).toBe("FINISHED");

    service.returnToLobby(roomId, hostId, finished.revision);
    const lobby = service.getSnapshot(roomId);
    expect(lobby.id).toBe(roomId);
    expect(lobby.revision).toBe(finished.revision + 1);
    expect(lobby.status).toBe("LOBBY");
    expect(lobby.game).toBeNull();
    expect(lobby.hostPlayerId).toBe(originalHost);
    expect(lobby.players.map((player) => player.id)).toEqual([hostId, guestId]);
    expect(lobby.players.every((player) => !player.ready)).toBe(true);
    expect(service.getRoom(roomId)?.players.get(hostId)?.sessionToken).toBe(hostToken);
    expect(service.getRoom(roomId)?.players.get(guestId)?.sessionToken).toBe(guestToken);
  });

  it("enforces rematch host, finished-game, and revision permissions", () => {
    const context = startedRoom();
    const { service, roomId, hostId, guestId } = context;
    const before = service.getSnapshot(roomId);
    expectRoomError(
      () => service.returnToLobby(roomId, guestId, before.revision),
      "NOT_HOST",
    );
    expectRoomError(
      () => service.returnToLobby(roomId, hostId, before.revision),
      "GAME_NOT_FINISHED",
    );
    expectRoomError(
      () => service.returnToLobby(roomId, hostId, before.revision - 1),
      "STALE_REVISION",
    );
    expect(service.getSnapshot(roomId)).toEqual(before);
  });

  it("starts a clean game after returning to the lobby and readying again", () => {
    const context = startedRoom();
    const { service, roomId, hostId, guestId } = context;
    finishGame(context);
    service.returnToLobby(roomId, hostId, service.getSnapshot(roomId).revision);
    service.setReady(roomId, guestId, true);
    service.startGame(roomId, hostId);
    const game = service.getSnapshot(roomId).game!;
    expect(game.phase).toBe("PLAYING");
    expect(game.completedTurns).toBe(0);
    expect(game.rollsUsed).toBe(0);
    expect(game.dice.every((die) => die.value === null && !die.held)).toBe(true);
    expect(game.winnerPlayerIds).toEqual([]);
    expect(
      Object.values(game.scoreCards).every((card) =>
        Object.values(card.scores).every((score) => score === null),
      ),
    ).toBe(true);
  });

  it("does not label a finished-game leave as GAME_ABORTED", () => {
    const context = startedRoom();
    const { service, roomId, guestId } = context;
    finishGame(context);
    const removal = service.leaveRoom(roomId, guestId);
    const lobby = service.getSnapshot(roomId);
    expect(removal.gameAborted).toBe(false);
    expect(lobby.status).toBe("LOBBY");
    expect(lobby.game).toBeNull();
    expect(lobby.players.every((player) => !player.ready)).toBe(true);
  });
});
