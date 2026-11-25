/**
 * Wire protocol for voip-lab signaling.
 *
 * Every message is a JSON object with a string `type`. Messages that fail
 * validation are answered with an `error` message and the connection is
 * left open: a bad client must never be able to crash the server.
 *
 * Client -> server:
 *   { type: "join", room, peerId, name? }
 *   { type: "leave", room }
 *   { type: "offer", room, to, sdp }
 *   { type: "answer", room, to, sdp }
 *   { type: "ice-candidate", room, to, candidate }
 *   { type: "pong" }                     (answer to the server heartbeat)
 *
 * Server -> client:
 *   { type: "joined", room, peerId, peers: [peerId, ...] }
 *   { type: "peer-joined", room, peerId, name? }
 *   { type: "peer-left", room, peerId }
 *   { type: "offer", room, from, sdp }
 *   { type: "answer", room, from, sdp }
 *   { type: "ice-candidate", room, from, candidate }
 *   { type: "ping" }                     (heartbeat; client must answer "pong")
 *   { type: "error", code, message }
 *
 * `candidate` follows RTCIceCandidateInit: an object with a string
 * `candidate` field, or null to signal end-of-candidates.
 */

export type ClientMessageType =
  | "join"
  | "leave"
  | "offer"
  | "answer"
  | "ice-candidate"
  | "pong";

export type ServerMessageType =
  | "joined"
  | "peer-joined"
  | "peer-left"
  | "offer"
  | "answer"
  | "ice-candidate"
  | "ping"
  | "error";

export interface IceCandidateInit {
  candidate: string | null;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface JoinMessage {
  type: "join";
  room: string;
  peerId: string;
  name?: string;
}

export interface LeaveMessage {
  type: "leave";
  room: string;
}

export interface SdpMessage {
  type: "offer" | "answer";
  room: string;
  to: string;
  sdp: string;
}

export interface IceCandidateMessage {
  type: "ice-candidate";
  room: string;
  to: string;
  candidate: IceCandidateInit | null;
}

export type ClientMessage =
  | JoinMessage
  | LeaveMessage
  | SdpMessage
  | IceCandidateMessage
  | { type: "pong" };

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export const ERROR_CODES = {
  MALFORMED: "MALFORMED",
  UNKNOWN_TYPE: "UNKNOWN_TYPE",
  INVALID_ROOM: "INVALID_ROOM",
  INVALID_PEER_ID: "INVALID_PEER_ID",
  NOT_IN_ROOM: "NOT_IN_ROOM",
  PEER_NOT_FOUND: "PEER_NOT_FOUND",
  INVALID_SDP: "INVALID_SDP",
  INVALID_CANDIDATE: "INVALID_CANDIDATE",
  DUPLICATE_PEER_ID: "DUPLICATE_PEER_ID",
} as const;

const MAX_ID_LENGTH = 64;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** A room or peer id is a short token: letters, digits, `-` and `_`. */
export function isValidId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_ID_LENGTH &&
    ID_PATTERN.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidCandidate(value: unknown): value is IceCandidateInit | null {
  if (value === null) return true; // end-of-candidates
  if (!isRecord(value)) return false;
  if (typeof value.candidate !== "string" && value.candidate !== null) return false;
  if (value.sdpMid !== undefined && value.sdpMid !== null && typeof value.sdpMid !== "string") return false;
  if (
    value.sdpMLineIndex !== undefined &&
    value.sdpMLineIndex !== null &&
    typeof value.sdpMLineIndex !== "number"
  )
    return false;
  return true;
}

export type ValidationResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; code: string; message: string };

/**
 * Parse and validate one raw WebSocket payload. Never throws: every
 * failure is reported as a ValidationResult the caller turns into an
 * `error` message for the sender.
 */
export function validateMessage(raw: unknown): ValidationResult {
  let parsed: unknown = raw;
  if (typeof raw === "string" || Buffer.isBuffer(raw)) {
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return { ok: false, code: ERROR_CODES.MALFORMED, message: "Message is not valid JSON." };
    }
  }
  if (!isRecord(parsed)) {
    return { ok: false, code: ERROR_CODES.MALFORMED, message: "Message must be a JSON object." };
  }
  const type = parsed.type;
  if (typeof type !== "string") {
    return { ok: false, code: ERROR_CODES.MALFORMED, message: "Message has no string 'type' field." };
  }

  if (type === "pong") {
    return { ok: true, message: { type: "pong" } };
  }

  if (type === "join") {
    if (!isValidId(parsed.room)) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_ROOM,
        message: "Room must be 1-64 chars: letters, digits, '-' and '_'.",
      };
    }
    if (!isValidId(parsed.peerId)) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_PEER_ID,
        message: "peerId must be 1-64 chars: letters, digits, '-' and '_'.",
      };
    }
    if (parsed.name !== undefined && (typeof parsed.name !== "string" || parsed.name.length > 64)) {
      return { ok: false, code: ERROR_CODES.MALFORMED, message: "name, when present, must be a string of at most 64 chars." };
    }
    const msg: JoinMessage = { type: "join", room: parsed.room, peerId: parsed.peerId };
    if (typeof parsed.name === "string") msg.name = parsed.name;
    return { ok: true, message: msg };
  }

  if (type === "leave") {
    if (!isValidId(parsed.room)) {
      return { ok: false, code: ERROR_CODES.INVALID_ROOM, message: "Room must be 1-64 chars: letters, digits, '-' and '_'." };
    }
    return { ok: true, message: { type: "leave", room: parsed.room } };
  }

  if (type === "offer" || type === "answer") {
    if (!isValidId(parsed.room)) {
      return { ok: false, code: ERROR_CODES.INVALID_ROOM, message: "Room must be 1-64 chars: letters, digits, '-' and '_'." };
    }
    if (!isValidId(parsed.to)) {
      return { ok: false, code: ERROR_CODES.INVALID_PEER_ID, message: "'to' must be a valid peer id." };
    }
    if (typeof parsed.sdp !== "string" || parsed.sdp.length === 0 || parsed.sdp.length > 65536) {
      return { ok: false, code: ERROR_CODES.INVALID_SDP, message: "sdp must be a non-empty string of at most 65536 chars." };
    }
    return { ok: true, message: { type, room: parsed.room, to: parsed.to, sdp: parsed.sdp } };
  }

  if (type === "ice-candidate") {
    if (!isValidId(parsed.room)) {
      return { ok: false, code: ERROR_CODES.INVALID_ROOM, message: "Room must be 1-64 chars: letters, digits, '-' and '_'." };
    }
    if (!isValidId(parsed.to)) {
      return { ok: false, code: ERROR_CODES.INVALID_PEER_ID, message: "'to' must be a valid peer id." };
    }
    if (!("candidate" in parsed) || !isValidCandidate(parsed.candidate)) {
      return { ok: false, code: ERROR_CODES.INVALID_CANDIDATE, message: "candidate must be an RTCIceCandidateInit object or null." };
    }
    return {
      ok: true,
      message: { type: "ice-candidate", room: parsed.room, to: parsed.to, candidate: parsed.candidate },
    };
  }

  return { ok: false, code: ERROR_CODES.UNKNOWN_TYPE, message: `Unknown message type '${type}'.` };
}
