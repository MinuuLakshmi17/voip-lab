/**
 * Live smoke test for the signaling server. Two plain `ws` clients join
 * the same room and exercise the full relay path: join/presence,
 * offer -> answer, ICE candidate relay, then leave. No browser and no
 * WebRTC stack is needed: the SDP and candidate payloads are fixtures,
 * which is enough to prove the server routes them correctly.
 *
 * Usage: npm run build && npm start & then: node scripts/smoke-test.mjs
 * Env: SIGNALING_URL (default ws://127.0.0.1:3000/ws)
 *
 * Prints a step-by-step transcript and exits 0 when every step passes.
 */
import WebSocket from "ws";

const URL = process.env.SIGNALING_URL ?? "ws://127.0.0.1:3000/ws";

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const messages = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      messages.push(msg);
      if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    });
    ws.on("open", () => resolve({ ws, messages }));
    ws.on("error", reject);
  });
}

async function waitFor(messages, predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

const t0 = Date.now();
const step = (n, text) => console.log(`[${String(Date.now() - t0).padStart(5)} ms] ${n} ${text}`);

const alice = await connect("alice");
const bob = await connect("bob");
step("1.", "both clients connected to the signaling server");

alice.ws.send(JSON.stringify({ type: "join", room: "smoke-room", peerId: "alice", name: "Alice" }));
const aliceJoined = await waitFor(alice.messages, (m) => m.type === "joined", "alice joined");
step("2.", `alice joined room '${aliceJoined.room}', peers already there: ${aliceJoined.peers.length}`);

bob.ws.send(JSON.stringify({ type: "join", room: "smoke-room", peerId: "bob", name: "Bob" }));
const bobJoined = await waitFor(bob.messages, (m) => m.type === "joined", "bob joined");
step("3.", `bob joined, sees peers: ${bobJoined.peers.join(", ")}`);
const aliceSeesBob = await waitFor(alice.messages, (m) => m.type === "peer-joined", "alice sees bob");
step("4.", `alice received peer-joined for ${aliceSeesBob.peerId}`);

const offerAt = Date.now();
alice.ws.send(JSON.stringify({ type: "offer", room: "smoke-room", to: "bob", sdp: "v=0\r\nsmoke-offer" }));
const offer = await waitFor(bob.messages, (m) => m.type === "offer", "bob receives offer");
step("5.", `offer relayed alice -> bob in ${Date.now() - offerAt} ms (from: ${offer.from})`);

bob.ws.send(JSON.stringify({ type: "answer", room: "smoke-room", to: "alice", sdp: "v=0\r\nsmoke-answer" }));
const answer = await waitFor(alice.messages, (m) => m.type === "answer", "alice receives answer");
step("6.", `answer relayed bob -> alice (from: ${answer.from})`);

alice.ws.send(
  JSON.stringify({
    type: "ice-candidate",
    room: "smoke-room",
    to: "bob",
    candidate: { candidate: "candidate:1 1 udp 2122260223 192.0.2.10 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 },
  }),
);
const ice = await waitFor(bob.messages, (m) => m.type === "ice-candidate", "bob receives ICE candidate");
step("7.", `ICE candidate relayed (candidate: ${ice.candidate.candidate.split(" ").slice(-2).join(" ")})`);

bob.ws.send(JSON.stringify({ type: "ice-candidate", room: "smoke-room", to: "alice", candidate: null }));
const eoc = await waitFor(
  alice.messages,
  (m) => m.type === "ice-candidate" && m.candidate === null,
  "alice receives end-of-candidates",
);
step("8.", `end-of-candidates relayed bob -> alice (from: ${eoc.from})`);

bob.ws.send(JSON.stringify({ type: "leave", room: "smoke-room" }));
const left = await waitFor(alice.messages, (m) => m.type === "peer-left" && m.peerId === "bob", "alice sees bob leave");
step("9.", `bob left room '${left.room}'; alice notified`);

alice.ws.close();
bob.ws.close();
console.log(`\nSmoke test passed: 9 steps in ${Date.now() - t0} ms.`);
process.exit(0);
