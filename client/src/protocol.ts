export type RoomStatus = "LOBBY" | "STARTED";
export type ConnectionState = "CONNECTED" | "DISCONNECTED_GRACE";

export interface PublicPlayer {
  id: string;
  nickname: string;
  ready: boolean;
  connectionState: ConnectionState;
  joinOrder: number;
  isHost: boolean;
}

export interface PublicRoomSnapshot {
  id: string;
  revision: number;
  status: RoomStatus;
  createdAt: string;
  hostPlayerId: string | null;
  minPlayers: number;
  maxPlayers: number;
  canStart: boolean;
  players: PublicPlayer[];
}

export type ServerMessage =
  | { event: "SERVER_READY"; serverTime: string }
  | { event: "DIAGNOSTIC_PONG"; id: string }
  | {
      event: "SESSION_ESTABLISHED";
      requestId: string;
      roomId: string;
      playerId: string;
      sessionToken: string;
      reconnected: boolean;
    }
  | { event: "ROOM_VIEW"; room: PublicRoomSnapshot }
  | {
      event: "COMMAND_OK";
      requestId: string;
      command: "SET_READY" | "START_GAME";
    }
  | { event: "LEFT"; requestId: string; roomId: string }
  | {
      event: "ERROR";
      code: string;
      message: string;
      requestId?: string;
    };
