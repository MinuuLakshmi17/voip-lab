/**
 * Pure client-side logic for voip-lab. Nothing in this file touches the
 * DOM, WebRTC, or the network, so it is unit-testable in Node.
 */

export type CallState = "idle" | "joining" | "in-call" | "ended";

const TRANSITIONS: Record<CallState, CallState[]> = {
  idle: ["joining"],
  joining: ["in-call", "ended"],
  "in-call": ["ended"],
  ended: ["idle"],
};

/** The call lifecycle as a strict state machine. Invalid transitions throw. */
export class CallStateMachine {
  private state: CallState = "idle";

  get current(): CallState {
    return this.state;
  }

  join(): void {
    this.transition("joining");
  }

  connected(): void {
    this.transition("in-call");
  }

  hangup(): void {
    this.transition("ended");
  }

  reset(): void {
    this.transition("idle");
  }

  private transition(next: CallState): void {
    if (!TRANSITIONS[this.state].includes(next)) {
      throw new Error(`Invalid call transition: ${this.state} -> ${next}`);
    }
    this.state = next;
  }
}

export interface MinimalStat {
  type: string;
  id: string;
  [key: string]: unknown;
}

export interface CallStats {
  /** Round-trip time of the selected candidate pair, milliseconds. */
  rttMs: number | null;
  /** Jitter of the inbound audio stream, milliseconds. */
  jitterMs: number | null;
  packetsLost: number;
  packetsReceived: number;
  packetsSent: number;
  bytesReceived: number;
  bytesSent: number;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  /** e.g. "host", "srflx", "relay" pair summary, or null when unknown. */
  candidatePairType: string | null;
  selectedPairId: string | null;
}

/**
 * Reduce a getStats report to the numbers the UI shows. Takes plain stat
 * objects (not the live RTCStatsReport), so tests can feed it fixtures.
 * Missing entries degrade to null/0 instead of throwing.
 */
export function parseStats(stats: MinimalStat[]): CallStats {
  const byId = new Map<string, MinimalStat>(stats.map((s) => [s.id, s]));

  let pair: MinimalStat | undefined;
  const pairs = stats.filter((s) => s.type === "candidate-pair");
  // Prefer the nominated pair (the one actually carrying media), then any
  // succeeded pair, then an in-progress pair.
  pair = pairs.find((s) => s.nominated === true);
  if (!pair) pair = pairs.find((s) => s.state === "succeeded");
  if (!pair) pair = pairs.find((s) => s.state === "in-progress");

  let inboundAudio: MinimalStat | undefined;
  let inboundVideo: MinimalStat | undefined;
  let outboundAudio: MinimalStat | undefined;
  let outboundVideo: MinimalStat | undefined;
  for (const s of stats) {
    if (s.type === "inbound-rtp") {
      if (s.kind === "audio" && !inboundAudio) inboundAudio = s;
      if (s.kind === "video" && !inboundVideo) inboundVideo = s;
    }
    if (s.type === "outbound-rtp") {
      if (s.kind === "audio" && !outboundAudio) outboundAudio = s;
      if (s.kind === "video" && !outboundVideo) outboundVideo = s;
    }
  }

  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);

  const localCandidate =
    pair && typeof pair.localCandidateId === "string" ? byId.get(pair.localCandidateId) : undefined;
  const remoteCandidate =
    pair && typeof pair.remoteCandidateId === "string" ? byId.get(pair.remoteCandidateId) : undefined;

  const localType = typeof localCandidate?.candidateType === "string" ? (localCandidate.candidateType as string) : null;
  const remoteType =
    typeof remoteCandidate?.candidateType === "string" ? (remoteCandidate.candidateType as string) : null;

  const rtt = pair ? num(pair.currentRoundTripTime) : null;

  return {
    rttMs: rtt !== null ? rtt * 1000 : null,
    jitterMs: inboundAudio ? num(inboundAudio.jitter) !== null ? (num(inboundAudio.jitter) as number) * 1000 : null : null,
    packetsLost: int(inboundAudio?.packetsLost) + int(inboundVideo?.packetsLost),
    packetsReceived: int(inboundAudio?.packetsReceived) + int(inboundVideo?.packetsReceived),
    packetsSent: int(outboundAudio?.packetsSent) + int(outboundVideo?.packetsSent),
    bytesReceived: int(inboundAudio?.bytesReceived) + int(inboundVideo?.bytesReceived),
    bytesSent: int(outboundAudio?.bytesSent) + int(outboundVideo?.bytesSent),
    localCandidateType: localType,
    remoteCandidateType: remoteType,
    candidatePairType: localType && remoteType ? `${localType}/${remoteType}` : null,
    selectedPairId: pair ? pair.id : null,
  };
}
