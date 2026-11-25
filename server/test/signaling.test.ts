import { describe, it, expect, afterEach } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { SignalingServer, type SignalingOptions } from "../src/signaling.js";

interface AnyMsg {
  type: string;
  [key: string]: unknown;
}

async function startServer(options: SignalingOptions = {}) {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, "listening");
  const port = (wss.address() as AddressInfo).port;
  const signaling = new SignalingServer(wss, options);
  return { signaling, port };
}

class TestClient {
  ws: WebSocket;
  messages: AnyMsg[] = [];
  closed = false;

  constructor(url: string, autoPong = true) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as AnyMsg;
      this.messages.push(msg);
      if (autoPong && msg.type === "ping") {
        this.ws.send(JSON.stringify({ type: "pong" }));
      }
    });
    this.ws.on("close", () => {
      this.closed = true;
    });
  }

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await once(this.ws, "open");
  }

  send(payload: unknown): void {
    this.ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  }

  async waitFor(predicate: (msg: AnyMsg) => boolean, timeoutMs = 5000): Promise<AnyMsg> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for message; received: ${JSON.stringify(this.messages)}`);
  }

  async waitClosed(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.closed) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for connection close");
  }

  close(): void {
    this.ws.close();
  }
}

const servers: Array<{ signaling: SignalingServer; port: number }> = [];
const clients: TestClient[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) {
    try {
      c.close();
    } catch {
      /* already closed */
    }
  }
  for (const s of servers.splice(0)) s.signaling.close();
});

async function makeServer(options: SignalingOptions = {}) {
  const s = await startServer(options);
  servers.push(s);
  return s;
}

async function makeClient(port: number, autoPong = true): Promise<TestClient> {
  const c = new TestClient(`ws://127.0.0.1:${port}/ws`, autoPong);
  clients.push(c);
  await c.open();
  return c;
}

describe("signaling server", () => {
  it("joins two peers and notifies both", async () => {
    const { port } = await makeServer();
    const alice = await makeClient(port);
    const bob = await makeClient(port);

    alice.send({ type: "join", room: "room-a", peerId: "alice", name: "Alice" });
    const aliceJoined = await alice.waitFor((m) => m.type === "joined");
    expect(aliceJoined.room).toBe("room-a");
    expect(aliceJoined.peers).toEqual([]);

    bob.send({ type: "join", room: "room-a", peerId: "bob", name: "Bob" });
    const bobJoined = await bob.waitFor((m) => m.type === "joined");
    expect(bobJoined.peers).toEqual(["alice"]);

    const aliceSeesBob = await alice.waitFor((m) => m.type === "peer-joined");
    expect(aliceSeesBob.peerId).toBe("bob");
    expect(aliceSeesBob.name).toBe("Bob");
  });

  it("relays offer, answer, and ICE candidates between peers in the same room", async () => {
    const { port } = await makeServer();
    const alice = await makeClient(port);
    const bob = await makeClient(port);
    alice.send({ type: "join", room: "room-a", peerId: "alice" });
    bob.send({ type: "join", room: "room-a", peerId: "bob" });
    await alice.waitFor((m) => m.type === "joined");
    await bob.waitFor((m) => m.type === "joined");

    alice.send({ type: "offer", room: "room-a", to: "bob", sdp: "v=0 fake-offer" });
    const offer = await bob.waitFor((m) => m.type === "offer");
    expect(offer.from).toBe("alice");
    expect(offer.sdp).toBe("v=0 fake-offer");
    // The sender must not receive its own relayed message.
    expect(alice.messages.some((m) => m.type === "offer")).toBe(false);

    bob.send({ type: "answer", room: "room-a", to: "alice", sdp: "v=0 fake-answer" });
    const answer = await alice.waitFor((m) => m.type === "answer");
    expect(answer.from).toBe("bob");
    expect(answer.sdp).toBe("v=0 fake-answer");

    alice.send({
      type: "ice-candidate",
      room: "room-a",
      to: "bob",
      candidate: { candidate: "candidate:1 1 udp 2122260223 192.0.2.1 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 },
    });
    const ice = await bob.waitFor((m) => m.type === "ice-candidate");
    expect(ice.from).toBe("alice");
    expect((ice.candidate as { candidate: string }).candidate).toContain("typ host");

    alice.send({ type: "ice-candidate", room: "room-a", to: "bob", candidate: null });
    const endOfCandidates = await bob.waitFor(
      (m) => m.type === "ice-candidate" && m.candidate === null,
    );
    expect(endOfCandidates.from).toBe("alice");
  });

  it("rejects malformed messages with an error and keeps the connection alive", async () => {
    const { port } = await makeServer();
    const alice = await makeClient(port);

    alice.send("this is not json{");
    const err = await alice.waitFor((m) => m.type === "error");
    expect(err.code).toBe("MALFORMED");

    alice.send({ type: "teleport", room: "room-a" });
    const err2 = await alice.waitFor((m) => m.type === "error" && m.code === "UNKNOWN_TYPE");
    expect(err2.code).toBe("UNKNOWN_TYPE");

    alice.send({ type: "join", room: "room-a", peerId: "alice" });
    const joined = await alice.waitFor((m) => m.type === "joined");
    expect(joined.room).toBe("room-a");
    expect(alice.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects invalid room and peer ids, and an offer from outside the room", async () => {
    const { port } = await makeServer();
    const alice = await makeClient(port);

    alice.send({ type: "join", room: "bad room!", peerId: "alice" });
    const err = await alice.waitFor((m) => m.type === "error");
    expect(err.code).toBe("INVALID_ROOM");

    alice.send({ type: "offer", room: "room-a", to: "bob", sdp: "v=0" });
    const err2 = await alice.waitFor((m) => m.type === "error" && m.code === "NOT_IN_ROOM");
    expect(err2.code).toBe("NOT_IN_ROOM");
  });

  it("rejects a duplicate peer id in the same room", async () => {
    const { port } = await makeServer();
    const alice = await makeClient(port);
    const impostor = await makeClient(port);

    alice.send({ type: "join", room: "room-a", peerId: "alice" });
    await alice.waitFor((m) => m.type === "joined");
    impostor.send({ type: "join", room: "room-a", peerId: "alice" });
    const err = await impostor.waitFor((m) => m.type === "error");
    expect(err.code).toBe("DUPLICATE_PEER_ID");
  });

  it("isolates rooms: a peer in room B is unreachable from room A", async () => {
    const { port } = await makeServer();
    const alice = await makeClient(port);
    const carol = await makeClient(port);
    alice.send({ type: "join", room: "room-a", peerId: "alice" });
    carol.send({ type: "join", room: "room-b", peerId: "carol" });
    await alice.waitFor((m) => m.type === "joined");
    await carol.waitFor((m) => m.type === "joined");

    alice.send({ type: "offer", room: "room-a", to: "carol", sdp: "v=0" });
    const err = await alice.waitFor((m) => m.type === "error");
    expect(err.code).toBe("PEER_NOT_FOUND");

    // Carol must receive nothing at all from Alice's room.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(carol.messages.some((m) => m.type === "offer")).toBe(false);
  });

  it("notifies the room when a peer leaves and when a peer disconnects", async () => {
    const { port } = await makeServer();
    const alice = await makeClient(port);
    const bob = await makeClient(port);
    alice.send({ type: "join", room: "room-a", peerId: "alice" });
    bob.send({ type: "join", room: "room-a", peerId: "bob" });
    await alice.waitFor((m) => m.type === "joined");
    await bob.waitFor((m) => m.type === "joined");

    bob.send({ type: "leave", room: "room-a" });
    const left = await alice.waitFor((m) => m.type === "peer-left" && m.peerId === "bob");
    expect(left.room).toBe("room-a");

    bob.send({ type: "join", room: "room-a", peerId: "bob" });
    await bob.waitFor((m) => m.type === "joined");
    bob.close();
    const leftAgain = await alice.waitFor((m) => m.type === "peer-left" && m.peerId === "bob");
    expect(leftAgain.room).toBe("room-a");
  });

  it("keeps a peer that answers heartbeats and drops one that does not", async () => {
    const { port } = await makeServer({ heartbeatIntervalMs: 50, heartbeatTimeoutMs: 50 });
    const good = await makeClient(port, true);
    const silent = await makeClient(port, false);

    good.send({ type: "join", room: "room-a", peerId: "good" });
    silent.send({ type: "join", room: "room-a", peerId: "silent" });
    await good.waitFor((m) => m.type === "joined");
    await silent.waitFor((m) => m.type === "joined");

    await silent.waitClosed(5000);
    expect(silent.closed).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(good.ws.readyState).toBe(WebSocket.OPEN);
    expect(good.messages.some((m) => m.type === "ping")).toBe(true);
  });

  it("reports room stats on the signaling server", async () => {
    const { signaling, port } = await makeServer();
    const alice = await makeClient(port);
    alice.send({ type: "join", room: "room-a", peerId: "alice" });
    await alice.waitFor((m) => m.type === "joined");
    const stats = signaling.stats();
    expect(stats.rooms).toBe(1);
    expect(stats.peers).toBe(1);
    expect(stats.roomsSnapshot).toEqual({ "room-a": ["alice"] });
  });
});
