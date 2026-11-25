import { WebSocket, WebSocketServer } from "ws";
import { RoomManager } from "./rooms.js";
import { buildIceServers, type IceServerConfig } from "./ice.js";
import { ERROR_CODES, validateMessage, type ClientMessage } from "./protocol.js";

export interface SignalingOptions {
  /** Application-level heartbeat: how often the server pings clients (ms). */
  heartbeatIntervalMs?: number;
  /** How long after a missed pong a peer is dropped (ms). */
  heartbeatTimeoutMs?: number;
  turnSecret?: string;
  turnHost?: string;
  /** Advertise the turns: (TLS) endpoint. Only true when coturn has a
   * certificate configured; see turn/turnserver.conf. */
  turnTls?: boolean;
}

interface ConnectedPeer {
  ws: WebSocket;
  peerId: string | null;
  name?: string;
  rooms: Set<string>;
  lastPongAt: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;

export class SignalingServer {
  private wss: WebSocketServer;
  private rooms = new RoomManager();
  private peers = new Set<ConnectedPeer>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly turnSecret?: string;
  private readonly turnHost?: string;
  private readonly turnTls: boolean;

  constructor(wss: WebSocketServer, options: SignalingOptions = {}) {
    this.wss = wss;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.turnSecret = options.turnSecret;
    this.turnHost = options.turnHost;
    this.turnTls = options.turnTls ?? false;

    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  /** ICE servers for clients (STUN always, TURN when a secret is configured). */
  iceServers(): IceServerConfig[] {
    return buildIceServers({ turnSecret: this.turnSecret, turnHost: this.turnHost, turnTls: this.turnTls });
  }

  stats(): { rooms: number; peers: number; connections: number; roomsSnapshot: Record<string, string[]> } {
    return {
      rooms: this.rooms.roomCount(),
      peers: this.rooms.peerCount(),
      connections: this.peers.size,
      roomsSnapshot: this.rooms.roomsSnapshot(),
    };
  }

  /** Accept a WebSocket upgrade that was routed here by the HTTP server. */
  handleUpgrade(req: unknown, socket: unknown, head: unknown): void {
    this.wss.handleUpgrade(
      req as Parameters<WebSocketServer["handleUpgrade"]>[0],
      socket as Parameters<WebSocketServer["handleUpgrade"]>[1],
      head as Parameters<WebSocketServer["handleUpgrade"]>[2],
      (ws) => this.wss.emit("connection", ws, req),
    );
  }

  close(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const peer of this.peers) {
      try {
        peer.ws.close();
      } catch {
        /* already gone */
      }
    }
    this.wss.close();
  }

  private send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    this.send(ws, { type: "error", code, message });
  }

  private onConnection(ws: WebSocket): void {
    const peer: ConnectedPeer = { ws, peerId: null, rooms: new Set(), lastPongAt: Date.now() };
    this.peers.add(peer);

    ws.on("message", (data) => {
      const result = validateMessage(data.toString());
      if (!result.ok) {
        this.sendError(ws, result.code, result.message);
        return;
      }
      this.handleMessage(peer, result.message);
    });

    ws.on("close", () => this.onDisconnect(peer));
    ws.on("error", () => this.onDisconnect(peer));
  }

  private onDisconnect(peer: ConnectedPeer): void {
    if (!this.peers.has(peer)) return;
    this.peers.delete(peer);
    const leftRooms = this.rooms.leaveAll(peer.peerId ?? "");
    for (const room of leftRooms) {
      this.broadcast(room, { type: "peer-left", room, peerId: peer.peerId }, peer.peerId);
    }
  }

  /** Heartbeat: ping every client, drop any that missed its pong window. */
  private heartbeat(): void {
    const now = Date.now();
    for (const peer of [...this.peers]) {
      if (now - peer.lastPongAt > this.heartbeatIntervalMs + this.heartbeatTimeoutMs) {
        try {
          peer.ws.terminate();
        } catch {
          /* already gone */
        }
        this.onDisconnect(peer);
        continue;
      }
      this.send(peer.ws, { type: "ping" });
    }
  }

  private broadcast(room: string, payload: unknown, exceptPeerId?: string | null): void {
    for (const peer of this.peers) {
      if (peer.peerId === exceptPeerId) continue;
      if (!peer.rooms.has(room)) continue;
      this.send(peer.ws, payload);
    }
  }

  private handleMessage(peer: ConnectedPeer, msg: ClientMessage): void {
    switch (msg.type) {
      case "pong": {
        peer.lastPongAt = Date.now();
        return;
      }
      case "join": {
        if (peer.peerId !== null && peer.peerId !== msg.peerId) {
          this.sendError(peer.ws, ERROR_CODES.INVALID_PEER_ID, "This connection already joined as a different peer id.");
          return;
        }
        if (!this.rooms.join(msg.room, { peerId: msg.peerId, name: msg.name })) {
          this.sendError(peer.ws, ERROR_CODES.DUPLICATE_PEER_ID, `Peer id '${msg.peerId}' is already taken in room '${msg.room}'.`);
          return;
        }
        peer.peerId = msg.peerId;
        if (msg.name) peer.name = msg.name;
        peer.rooms.add(msg.room);
        const others = this.rooms.peersIn(msg.room, msg.peerId);
        this.send(peer.ws, { type: "joined", room: msg.room, peerId: msg.peerId, peers: others });
        this.broadcast(msg.room, { type: "peer-joined", room: msg.room, peerId: msg.peerId, name: msg.name }, msg.peerId);
        return;
      }
      case "leave": {
        if (!peer.rooms.has(msg.room)) {
          this.sendError(peer.ws, ERROR_CODES.NOT_IN_ROOM, `You are not in room '${msg.room}'.`);
          return;
        }
        peer.rooms.delete(msg.room);
        this.rooms.leave(msg.room, peer.peerId ?? "");
        this.broadcast(msg.room, { type: "peer-left", room: msg.room, peerId: peer.peerId }, peer.peerId);
        return;
      }
      case "offer":
      case "answer":
      case "ice-candidate": {
        if (!peer.rooms.has(msg.room)) {
          this.sendError(peer.ws, ERROR_CODES.NOT_IN_ROOM, `You are not in room '${msg.room}'.`);
          return;
        }
        const target = this.rooms.getPeer(msg.room, msg.to);
        if (!target) {
          this.sendError(peer.ws, ERROR_CODES.PEER_NOT_FOUND, `Peer '${msg.to}' is not in room '${msg.room}'.`);
          return;
        }
        // Deliver only to the addressed peer, only within the same room.
        for (const other of this.peers) {
          if (other.peerId === msg.to && other.rooms.has(msg.room)) {
            this.send(other.ws, { ...msg, from: peer.peerId });
          }
        }
        return;
      }
    }
  }
}
