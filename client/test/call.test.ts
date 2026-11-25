import { describe, it, expect } from "vitest";
import { CallStateMachine, parseStats, type MinimalStat } from "../src/call.js";

describe("CallStateMachine", () => {
  it("follows the happy path idle -> joining -> in-call -> ended -> idle", () => {
    const m = new CallStateMachine();
    expect(m.current).toBe("idle");
    m.join();
    expect(m.current).toBe("joining");
    m.connected();
    expect(m.current).toBe("in-call");
    m.hangup();
    expect(m.current).toBe("ended");
    m.reset();
    expect(m.current).toBe("idle");
  });

  it("allows hanging up while still joining", () => {
    const m = new CallStateMachine();
    m.join();
    m.hangup();
    expect(m.current).toBe("ended");
  });

  it("rejects invalid transitions", () => {
    const m = new CallStateMachine();
    expect(() => m.connected()).toThrow("Invalid call transition: idle -> in-call");
    expect(() => m.hangup()).toThrow("Invalid call transition: idle -> ended");
    m.join();
    expect(() => m.join()).toThrow("Invalid call transition: joining -> joining");
    expect(() => m.reset()).toThrow("Invalid call transition: joining -> idle");
  });
});

describe("parseStats", () => {
  const fullReport: MinimalStat[] = [
    { type: "candidate-pair", id: "pair-1", state: "succeeded", nominated: true, currentRoundTripTime: 0.042, localCandidateId: "local-1", remoteCandidateId: "remote-1" },
    { type: "local-candidate", id: "local-1", candidateType: "srflx" },
    { type: "remote-candidate", id: "remote-1", candidateType: "host" },
    { type: "inbound-rtp", id: "in-audio", kind: "audio", jitter: 0.004, packetsLost: 3, packetsReceived: 1200, bytesReceived: 96000 },
    { type: "inbound-rtp", id: "in-video", kind: "video", packetsLost: 1, packetsReceived: 800, bytesReceived: 640000 },
    { type: "outbound-rtp", id: "out-audio", kind: "audio", packetsSent: 1190, bytesSent: 95200 },
    { type: "outbound-rtp", id: "out-video", kind: "video", packetsSent: 780, bytesSent: 620000 },
  ];

  it("reduces a full getStats report to the displayed numbers", () => {
    const stats = parseStats(fullReport);
    expect(stats.rttMs).toBeCloseTo(42, 5);
    expect(stats.jitterMs).toBeCloseTo(4, 5);
    expect(stats.packetsLost).toBe(4);
    expect(stats.packetsReceived).toBe(2000);
    expect(stats.packetsSent).toBe(1970);
    expect(stats.bytesReceived).toBe(736000);
    expect(stats.bytesSent).toBe(715200);
    expect(stats.localCandidateType).toBe("srflx");
    expect(stats.remoteCandidateType).toBe("host");
    expect(stats.candidatePairType).toBe("srflx/host");
    expect(stats.selectedPairId).toBe("pair-1");
  });

  it("reports a relay pair when both candidates are relay", () => {
    const report: MinimalStat[] = [
      { type: "candidate-pair", id: "pair-2", state: "succeeded", nominated: true, currentRoundTripTime: 0.18, localCandidateId: "l", remoteCandidateId: "r" },
      { type: "local-candidate", id: "l", candidateType: "relay" },
      { type: "remote-candidate", id: "r", candidateType: "relay" },
    ];
    const stats = parseStats(report);
    expect(stats.candidatePairType).toBe("relay/relay");
    expect(stats.rttMs).toBeCloseTo(180, 5);
  });

  it("degrades to nulls and zeros on an empty report", () => {
    const stats = parseStats([]);
    expect(stats.rttMs).toBeNull();
    expect(stats.jitterMs).toBeNull();
    expect(stats.packetsLost).toBe(0);
    expect(stats.packetsReceived).toBe(0);
    expect(stats.candidatePairType).toBeNull();
    expect(stats.selectedPairId).toBeNull();
  });

  it("falls back to an in-progress pair when no pair has succeeded", () => {
    const report: MinimalStat[] = [
      { type: "candidate-pair", id: "pair-3", state: "in-progress", currentRoundTripTime: 0.09, localCandidateId: "l", remoteCandidateId: "r" },
      { type: "local-candidate", id: "l", candidateType: "host" },
      { type: "remote-candidate", id: "r", candidateType: "host" },
    ];
    const stats = parseStats(report);
    expect(stats.selectedPairId).toBe("pair-3");
    expect(stats.candidatePairType).toBe("host/host");
  });

  it("ignores a stale succeeded pair in favour of the nominated one", () => {
    const report: MinimalStat[] = [
      { type: "candidate-pair", id: "pair-old", state: "succeeded", nominated: false, currentRoundTripTime: 0.5, localCandidateId: "l1", remoteCandidateId: "r1" },
      { type: "candidate-pair", id: "pair-new", state: "succeeded", nominated: true, currentRoundTripTime: 0.03, localCandidateId: "l2", remoteCandidateId: "r2" },
      { type: "local-candidate", id: "l1", candidateType: "host" },
      { type: "remote-candidate", id: "r1", candidateType: "host" },
      { type: "local-candidate", id: "l2", candidateType: "relay" },
      { type: "remote-candidate", id: "r2", candidateType: "relay" },
    ];
    const stats = parseStats(report);
    expect(stats.selectedPairId).toBe("pair-new");
    expect(stats.rttMs).toBeCloseTo(30, 5);
    expect(stats.candidatePairType).toBe("relay/relay");
  });
});
