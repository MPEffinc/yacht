import { describe, expect, it } from "vitest";
import type { DieValue } from "../src/game/types.js";
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
  const created = service.createRoom("Host", 8);
  const host = created.player;
  const roomId = created.room.id;
  const guest = service.joinRoom(roomId, "Guest").player;
  service.setReady(roomId, host.id, true);
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
});
