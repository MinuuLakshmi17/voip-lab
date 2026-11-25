import { describe, it, expect } from "vitest";
import { validateMessage, ERROR_CODES } from "../src/protocol.js";
import { RoomManager } from "../src/rooms.js";
import { generateTurnCredentials, buildIceServers } from "../src/ice.js";

describe("validateMessage", () => {
  it("accepts a well-formed join", () => {
    const r = validateMessage(JSON.stringify({ type: "join", room: "room-a", peerId: "alice", name: "Alice" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toEqual({ type: "join", room: "room-a", peerId: "alice", name: "Alice" });
    }
  });

  it("rejects non-JSON text", () => {
    const r = validateMessage("not json{");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ERROR_CODES.MALFORMED);
  });

  it("rejects a non-object payload", () => {
    const r = validateMessage(JSON.stringify([1, 2, 3]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ERROR_CODES.MALFORMED);
  });

  it("rejects a missing type", () => {
    const r = validateMessage(JSON.stringify({ room: "room-a" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ERROR_CODES.MALFORMED);
  });

  it("rejects an unknown type", () => {
    const r = validateMessage(JSON.stringify({ type: "teleport" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ERROR_CODES.UNKNOWN_TYPE);
  });

  it("rejects a room id with spaces", () => {
    const r = validateMessage(JSON.stringify({ type: "join", room: "bad room", peerId: "alice" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ERROR_CODES.INVALID_ROOM);
  });

  it("rejects an empty peer id", () => {
    const r = validateMessage(JSON.stringify({ type: "join", room: "room-a", peerId: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ERROR_CODES.INVALID_PEER_ID);
  });

  it("rejects an offer with an empty sdp", () => {
    const r = validateMessage(JSON.stringify({ type: "offer", room: "room-a", to: "bob", sdp: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ERROR_CODES.INVALID_SDP);
  });

  it("accepts a null ICE candidate (end-of-candidates)", () => {
    const r = validateMessage(JSON.stringify({ type: "ice-candidate", room: "room-a", to: "bob", candidate: null }));
    expect(r.ok).toBe(true);
  });

  it("rejects a malformed ICE candidate", () => {
    const r = validateMessage(JSON.stringify({ type: "ice-candidate", room: "room-a", to: "bob", candidate: { candidate: 42 } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ERROR_CODES.INVALID_CANDIDATE);
  });

  it("accepts a pong with no other fields", () => {
    const r = validateMessage(JSON.stringify({ type: "pong" }));
    expect(r.ok).toBe(true);
  });
});

describe("RoomManager", () => {
  it("tracks joins, leaves, and empty-room cleanup", () => {
    const rooms = new RoomManager();
    expect(rooms.join("room-a", { peerId: "alice" })).toBe(true);
    expect(rooms.join("room-a", { peerId: "alice" })).toBe(false); // duplicate
    expect(rooms.join("room-a", { peerId: "bob" })).toBe(true);
    expect(rooms.peersIn("room-a")).toEqual(["alice", "bob"]);
    expect(rooms.peersIn("room-a", "alice")).toEqual(["bob"]);
    expect(rooms.isMember("room-a", "alice")).toBe(true);
    expect(rooms.isMember("room-b", "alice")).toBe(false);

    expect(rooms.leave("room-a", "alice")).toBe(true);
    expect(rooms.leave("room-a", "alice")).toBe(false);
    expect(rooms.roomCount()).toBe(1);
    expect(rooms.leave("room-a", "bob")).toBe(true);
    expect(rooms.roomCount()).toBe(0);
  });

  it("leaveAll removes a peer from every room", () => {
    const rooms = new RoomManager();
    rooms.join("room-a", { peerId: "alice" });
    rooms.join("room-b", { peerId: "alice" });
    rooms.join("room-b", { peerId: "bob" });
    expect(rooms.leaveAll("alice")).toEqual(["room-a", "room-b"]);
    expect(rooms.peersIn("room-b")).toEqual(["bob"]);
  });
});

describe("TURN credentials", () => {
  it("derives a time-limited username/password from the shared secret", () => {
    const creds = generateTurnCredentials("test-secret", 3600, 1_700_000_000);
    expect(creds.username).toBe("1700003600");
    expect(creds.ttlSeconds).toBe(3600);
    expect(creds.expiresAt).toBe(1_700_003_600);
    // Same inputs give the same password; a different secret does not.
    expect(generateTurnCredentials("test-secret", 3600, 1_700_000_000).password).toBe(creds.password);
    expect(generateTurnCredentials("other-secret", 3600, 1_700_000_000).password).not.toBe(creds.password);
  });

  it("builds STUN-only servers without a TURN secret, and TURN servers with one", () => {
    const stunOnly = buildIceServers({});
    expect(stunOnly).toHaveLength(1);
    expect(stunOnly[0].urls[0]).toContain("stun:");

    const withTurn = buildIceServers({ turnSecret: "s3cret", turnHost: "turn.example.com" });
    expect(withTurn).toHaveLength(2);
    expect(withTurn[1].urls).toEqual([
      "turn:turn.example.com:3478?transport=udp",
      "turn:turn.example.com:3478?transport=tcp",
    ]);
    expect(typeof withTurn[1].username).toBe("string");
    expect(typeof withTurn[1].credential).toBe("string");
  });

  it("advertises the turns: URL only when TLS is enabled", () => {
    const withTls = buildIceServers({ turnSecret: "s3cret", turnHost: "turn.example.com", turnTls: true });
    expect(withTls[1].urls).toContain("turns:turn.example.com:5349?transport=tcp");
  });
});
