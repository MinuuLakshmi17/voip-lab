/**
 * Headless WebRTC test client for the Docker NAT lab.
 *
 * Runs inside a container (where UDP works) and makes a real WebRTC call
 * through the voip-lab signaling server, using the ICE servers from
 * /ice-config (STUN + time-limited TURN credentials). Reports which
 * candidate types were gathered and which pair was selected, as JSON.
 *
 * Env: SIGNALING_URL (ws://...), ICE_CONFIG_URL (http://...),
 *      ROOM, PEER_ID, ROLE (caller | callee)
 *
 * Exit 0 when the data channel opens and a message crosses; exit 1 on
 * timeout or failure. Prints exactly one JSON report line on stdout.
 */
import { RTCPeerConnection } from "werift";
import WebSocket from "ws";

const SIGNALING_URL = process.env.SIGNALING_URL ?? "ws://signaling:3000/ws";
const ICE_CONFIG_URL = process.env.ICE_CONFIG_URL ?? "http://signaling:3000/ice-config";
const ROOM = process.env.ROOM ?? "lab-room";
const PEER_ID = process.env.PEER_ID ?? "lab-a";
const ROLE = process.env.ROLE ?? "caller";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 30_000);

function fail(report, message) {
  console.log(JSON.stringify({ ...report, success: false, error: message }));
  process.exit(1);
}

const startedAt = Date.now();
const report = {
  peerId: PEER_ID,
  role: ROLE,
  room: ROOM,
  success: false,
  dataChannelOpenMs: null,
  localCandidateTypes: [],
  remoteCandidateTypes: [],
  selectedPair: null,
  rttMs: null,
  error: null,
};

const iceRes = await fetch(ICE_CONFIG_URL);
if (!iceRes.ok) fail(report, `ice-config fetch failed: HTTP ${iceRes.status}`);
const { iceServers } = await iceRes.json();

const pc = new RTCPeerConnection({ iceServers });
const gatheredLocal = new Set();
const gatheredRemote = new Set();

const ws = new WebSocket(SIGNALING_URL);
const wsOpen = new Promise((resolve, reject) => {
  ws.on("open", resolve);
  ws.on("error", reject);
});
await wsOpen;
ws.send(JSON.stringify({ type: "join", room: ROOM, peerId: PEER_ID }));

let remotePeerId = null;
let dataChannel = null;
const messageReceived = new Promise((resolve) => {
  pc.ondatachannel = (event) => {
    event.channel.onmessage = (msg) => resolve(msg.data);
  };
});
const channelOpened = new Promise((resolve) => {
  const check = () => {
    if (dataChannel && dataChannel.readyState === "open") resolve(Date.now() - startedAt);
  };
  // werift fires onopen on the channel; poll as a backstop.
  const timer = setInterval(check, 100);
  setTimeout(() => clearInterval(timer), TIMEOUT_MS);
});

pc.onicecandidate = (event) => {
  if (!event.candidate || !remotePeerId) return;
  ws.send(JSON.stringify({ type: "ice-candidate", room: ROOM, to: remotePeerId, candidate: event.candidate }));
};

ws.on("message", async (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "ping") {
    ws.send(JSON.stringify({ type: "pong" }));
    return;
  }
  if (msg.type === "peer-joined" && ROLE === "caller") {
    remotePeerId = msg.peerId;
    dataChannel = pc.createDataChannel("lab");
    dataChannel.onopen = () => {};
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: "offer", room: ROOM, to: remotePeerId, sdp: offer.sdp }));
    return;
  }
  if (msg.type === "offer" && ROLE === "callee") {
    remotePeerId = msg.from;
    await pc.setRemoteDescription(msg.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: "answer", room: ROOM, to: remotePeerId, sdp: answer.sdp }));
    return;
  }
  if (msg.type === "answer" && ROLE === "caller") {
    await pc.setRemoteDescription(msg.sdp);
    return;
  }
  if (msg.type === "ice-candidate" && msg.candidate) {
    await pc.addIceCandidate(msg.candidate);
  }
});

// Wait for the data channel to open, then exchange one message.
const openedMs = await Promise.race([
  channelOpened,
  new Promise((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
]);
if (openedMs === null) fail(report, "data channel did not open within timeout");
report.dataChannelOpenMs = openedMs;

if (ROLE === "caller") {
  dataChannel.send("ping from caller");
  const reply = await Promise.race([
    messageReceived,
    new Promise((resolve) => setTimeout(() => resolve(null), 10_000)),
  ]);
  if (reply === null) fail(report, "no reply on data channel");
} else {
  const ping = await Promise.race([
    messageReceived,
    new Promise((resolve) => setTimeout(() => resolve(null), 10_000)),
  ]);
  if (ping === null) fail(report, "no message received on data channel");
}

// Read the selected candidate pair from getStats.
const stats = await pc.getStats();
stats.forEach((s) => {
  if (s.type === "local-candidate") gatheredLocal.add(s.candidateType);
  if (s.type === "remote-candidate") gatheredRemote.add(s.candidateType);
  if (s.type === "candidate-pair" && s.state === "succeeded") {
    report.selectedPair = { localCandidateId: s.localCandidateId, remoteCandidateId: s.remoteCandidateId };
    if (typeof s.currentRoundTripTime === "number") report.rttMs = s.currentRoundTripTime * 1000;
  }
});
report.localCandidateTypes = [...gatheredLocal].sort();
report.remoteCandidateTypes = [...gatheredRemote].sort();
// Resolve the pair's candidate types from the gathered stats.
let localType = null;
let remoteType = null;
stats.forEach((s) => {
  if (report.selectedPair && s.id === report.selectedPair.localCandidateId) localType = s.candidateType;
  if (report.selectedPair && s.id === report.selectedPair.remoteCandidateId) remoteType = s.candidateType;
});
report.selectedPair = localType && remoteType ? `${localType}/${remoteType}` : report.selectedPair;
report.success = true;

console.log(JSON.stringify(report));
await pc.close();
ws.close();
process.exit(0);
