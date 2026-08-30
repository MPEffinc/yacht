import { describe, expect, it } from "vitest";
import {
  RoomError,
  RoomService,
  normalizeNickname,
  type PlayerRecord,
} from "../src/room-service.js";

function expectRoomError(action: () => unknown, code: RoomError["code"]): void {
  try {
    action();
    throw new Error(`Expected RoomError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RoomError);
    expect((error as RoomError).code).toBe(code);
  }
}

function createTwoPlayerRoom(): {
  service: RoomService;
  roomId: string;
  host: PlayerRecord;
  guest: PlayerRecord;
} {
  const service = new RoomService();
  const created = service.createRoom("Host", 8);
  const joined = service.joinRoom(created.room.id, "Guest");
  return {
    service,
    roomId: created.room.id,
    host: created.player,
    guest: joined.player,
  };
}

describe("RoomService", () => {
  it("creates a room with secure identifiers and an authoritative host", () => {
    const service = new RoomService();
    const roomIds = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      const result = service.createRoom(`Host ${index}`, 8);
      expect(result.room.id).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
      expect(result.player.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.player.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(result.room.hostPlayerId).toBe(result.player.id);
      expect(result.room.revision).toBe(1);
      roomIds.add(result.room.id);
    }
    expect(roomIds.size).toBe(100);
  });

  it("normalizes Unicode nicknames and rejects invalid values", () => {
    expect(normalizeNickname("  민수  ").nickname).toBe("민수");
    expect(normalizeNickname("e\u0301").nickname).toBe("é");
    expectRoomError(() => normalizeNickname("  "), "INVALID_NICKNAME");
    expectRoomError(() => normalizeNickname("bad\nname"), "INVALID_NICKNAME");
    expectRoomError(() => normalizeNickname("123456789012345678901"), "INVALID_NICKNAME");
  });

  it("rejects duplicate normalized nicknames", () => {
    const service = new RoomService();
    const created = service.createRoom("Alice", 8);
    expectRoomError(
      () => service.joinRoom(created.room.id, " alice "),
      "DUPLICATE_NICKNAME",
    );
  });

  it("rejects a join when the room is full", () => {
    const service = new RoomService();
    const created = service.createRoom("A", 2);
    service.joinRoom(created.room.id, "B");
    expectRoomError(() => service.joinRoom(created.room.id, "C"), "ROOM_FULL");
  });

  it("changes each player's Ready state and computes the start condition", () => {
    const { service, roomId, host, guest } = createTwoPlayerRoom();
    expect(service.getSnapshot(roomId).canStart).toBe(false);
    service.setReady(roomId, host.id, true);
    expect(service.getSnapshot(roomId).canStart).toBe(false);
    service.setReady(roomId, guest.id, true);
    expect(service.getSnapshot(roomId).canStart).toBe(true);
    expect(service.getSnapshot(roomId).revision).toBe(4);
    service.setReady(roomId, guest.id, false);
    expect(service.getSnapshot(roomId).canStart).toBe(false);
  });

  it("rejects START_GAME from a non-host", () => {
    const { service, roomId, host, guest } = createTwoPlayerRoom();
    service.setReady(roomId, host.id, true);
    service.setReady(roomId, guest.id, true);
    expectRoomError(() => service.startGame(roomId, guest.id), "NOT_HOST");
  });

  it("rejects START_GAME with only one player", () => {
    const service = new RoomService();
    const created = service.createRoom("Solo");
    service.setReady(created.room.id, created.player.id, true);
    expectRoomError(
      () => service.startGame(created.room.id, created.player.id),
      "NOT_ENOUGH_PLAYERS",
    );
  });

  it("starts normally after every player is ready", () => {
    const { service, roomId, host, guest } = createTwoPlayerRoom();
    expectRoomError(() => service.startGame(roomId, host.id), "PLAYERS_NOT_READY");
    service.setReady(roomId, host.id, true);
    service.setReady(roomId, guest.id, true);
    service.startGame(roomId, host.id);
    expect(service.getSnapshot(roomId).status).toBe("STARTED");
    expectRoomError(() => service.joinRoom(roomId, "Late"), "GAME_ALREADY_STARTED");
  });

  it("transfers host to the earliest connected player when the host leaves", () => {
    const { service, roomId, host, guest } = createTwoPlayerRoom();
    const third = service.joinRoom(roomId, "Third").player;
    service.leaveRoom(roomId, host.id);
    expect(service.getRoom(roomId)?.hostPlayerId).toBe(guest.id);
    expect(service.getRoom(roomId)?.hostPlayerId).not.toBe(third.id);
  });

  it("reconnects a disconnected player with the room-specific token", () => {
    const { service, roomId, guest } = createTwoPlayerRoom();
    service.setReady(roomId, guest.id, true);
    const disconnected = service.markDisconnected(roomId, guest.id, 1_000);
    expect(disconnected?.reconnectDeadline).toBe(61_000);
    expect(service.getSnapshot(roomId).players[1]).toMatchObject({
      ready: false,
      connectionState: "DISCONNECTED_GRACE",
    });
    const result = service.reconnectRoom(roomId, guest.sessionToken, 2_000);
    expect(result.player.connectionState).toBe("CONNECTED");
    expect(result.player.ready).toBe(false);
  });

  it("rejects an invalid session without exposing tokens in snapshots", () => {
    const { service, roomId, host } = createTwoPlayerRoom();
    expectRoomError(() => service.reconnectRoom(roomId, "x".repeat(43)), "INVALID_SESSION");
    expect(JSON.stringify(service.getSnapshot(roomId))).not.toContain(host.sessionToken);
    expect(service.getSnapshot(roomId).players[0]).not.toHaveProperty("sessionToken");
  });

  it("expires a player after the reconnect grace period and deletes an empty room", () => {
    const service = new RoomService({ reconnectGraceMs: 100 });
    const created = service.createRoom("Host", 8, 1_000);
    const state = service.markDisconnected(created.room.id, created.player.id, 2_000);
    expect(state?.reconnectDeadline).toBe(2_100);
    expect(
      service.expireDisconnected(created.room.id, created.player.id, 2_100, 2_099),
    ).toBeNull();
    const expired = service.expireDisconnected(
      created.room.id,
      created.player.id,
      2_100,
      2_100,
    );
    expect(expired?.room).toBeNull();
    expect(service.roomCount).toBe(0);
    expectRoomError(
      () => service.reconnectRoom(created.room.id, created.player.sessionToken, 2_101),
      "ROOM_NOT_FOUND",
    );
  });

  it("transfers host authority when a disconnected host expires", () => {
    const service = new RoomService({ reconnectGraceMs: 100 });
    const created = service.createRoom("Host", 8, 1_000);
    const guest = service.joinRoom(created.room.id, "Guest").player;
    const disconnected = service.markDisconnected(created.room.id, created.player.id, 2_000);
    expectRoomError(
      () => service.reconnectRoom(created.room.id, created.player.sessionToken, 2_101),
      "INVALID_SESSION",
    );
    expect(service.getRoom(created.room.id)?.hostPlayerId).toBe(created.player.id);
    service.expireDisconnected(
      created.room.id,
      created.player.id,
      disconnected!.reconnectDeadline,
      2_101,
    );
    expect(service.getRoom(created.room.id)?.hostPlayerId).toBe(guest.id);
  });
});
