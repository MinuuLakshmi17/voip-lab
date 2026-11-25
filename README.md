# voip-lab

<h1 align="center">voip-lab</h1>

<p align="center">WebRTC audio/video calls in the browser, with a TypeScript signaling server, coturn STUN/TURN, and a Docker Compose lab that tests NAT and firewall behavior.</p>

<p align="justify">voip-lab is a complete, small WebRTC system built to be read and run, not just demoed. Two browsers join a room through a WebSocket signaling server, negotiate a peer connection directly, and talk over whatever path ICE finds: a direct host candidate, a server-reflexive address learned from STUN, or a TURN relay when the network blocks the direct path. A Docker Compose lab puts two headless clients on separate networks with no route between them, so the relay path is exercised for real instead of assumed. Every number in this README was measured from a real run on the machine described below; nothing here is a benchmark claim, a projection, or a figure taken from another tool.</p>

## Contents

- [Architecture](#architecture)
- [Signaling protocol](#signaling-protocol)
- [Running the signaling server](#running-the-signaling-server)
- [Running the client](#running-the-client)
- [ICE, STUN, and TURN](#ice-stun-and-turn)
- [The Docker Compose NAT lab](#the-docker-compose-nat-lab)
- [Testing](#testing)
- [Measured results](#measured-results)
- [Limitations](#limitations)

## Architecture

<p align="justify">The project is plain TypeScript throughout: a Node.js signaling server, a framework-free browser client, and a headless lab client that runs inside Docker. The signaling server has no runtime dependencies beyond <code>ws</code>; the client has no runtime dependencies at all. Media never touches the server: it only relays the session descriptions and ICE candidates that let two peers find each other, and then gets out of the way.</p>

| Part | Files | Responsibility |
| --- | --- | --- |
| Signaling server | `server/src/` | WebSocket rooms, presence, offer/answer/ICE relay, message validation, heartbeat, TURN credential minting, static file serving for the client. |
| Browser client | `client/src/` | Room join, `RTCPeerConnection` lifecycle, mute/unmute, hang up, connection-state display, `getStats` parsing, test-tone mode. |
| TURN | `turn/turnserver.conf` | coturn STUN/TURN configuration: port 3478, long-term credentials from a shared secret, loopback and multicast relay denied. |
| NAT lab | `lab/` | Docker Compose stack (signaling + coturn + two clients on isolated networks) and a headless werift client that reports candidate types. |
| Scripts | `scripts/` | Live smoke test against the real server, NAT lab runner, client build helper. |

<p align="justify">The server is split into one small module per concern. <code>protocol.ts</code> owns message validation and never throws: every malformed payload is answered with an <code>error</code> message and the connection stays open, so a bad client cannot crash the server. <code>rooms.ts</code> owns membership and makes isolation structural: relaying only ever addresses a peer that is a member of the same room. <code>signaling.ts</code> owns the WebSocket lifecycle and the heartbeat. <code>ice.ts</code> mints time-limited TURN credentials. <code>index.ts</code> owns HTTP: the client bundle, <code>/health</code>, and <code>/ice-config</code>.</p>

## Signaling protocol

<p align="justify">All signaling is JSON over a single WebSocket at <code>/ws</code>. The server never trusts a message: each one is validated before it is acted on, and a validation failure is answered with <code>{ "type": "error", "code", "message" }</code> while the connection stays alive.</p>

**Client to server**

| Message | Meaning |
| --- | --- |
| `{ "type": "join", "room", "peerId", "name"? }` | Join a room. Room and peer ids are 1–64 chars: letters, digits, `-`, `_`. A peer id already taken in that room is rejected with `DUPLICATE_PEER_ID`. |
| `{ "type": "leave", "room" }` | Leave a room. The remaining members receive `peer-left`. |
| `{ "type": "offer", "room", "to", "sdp" }` | Relay an SDP offer to one peer in the same room. |
| `{ "type": "answer", "room", "to", "sdp" }` | Relay an SDP answer to one peer in the same room. |
| `{ "type": "ice-candidate", "room", "to", "candidate" }` | Relay one ICE candidate (`RTCIceCandidateInit`, or `null` for end-of-candidates). |
| `{ "type": "pong" }` | Answer to the server heartbeat. |

**Server to client**

| Message | Meaning |
| --- | --- |
| `{ "type": "joined", "room", "peerId", "peers": [...] }` | Join confirmed; `peers` lists the ids already in the room. |
| `{ "type": "peer-joined", "room", "peerId", "name"? }` | A peer joined the room. The client that sees this creates the offer. |
| `{ "type": "peer-left", "room", "peerId" }` | A peer left, or its connection dropped. |
| `{ "type": "offer" / "answer" / "ice-candidate", "room", "from", ... }` | Relayed message, with the sender's id in `from`. |
| `{ "type": "ping" }` | Heartbeat. The client must answer `pong`; a peer that misses its pong window is dropped. |
| `{ "type": "error", "code", "message" }` | Validation or routing failure. Codes: `MALFORMED`, `UNKNOWN_TYPE`, `INVALID_ROOM`, `INVALID_PEER_ID`, `NOT_IN_ROOM`, `PEER_NOT_FOUND`, `INVALID_SDP`, `INVALID_CANDIDATE`, `DUPLICATE_PEER_ID`. |

<p align="justify">Room isolation is enforced twice: the relay path looks the target up in the sender's room and refuses with <code>PEER_NOT_FOUND</code> when it is not a member, and delivery only happens to a connection that is itself a member of that room. A message addressed to a peer in another room never reaches it, and the test suite proves it.</p>

## Running the signaling server

```console
npm install
npm run build
npm start
```

<p align="justify">The server listens on <code>PORT</code> (default 3000) and serves the client at <code>/</code>, a JSON health endpoint at <code>/health</code> (rooms, peers, connections), and the ICE server list at <code>/ice-config</code>. TURN is enabled by setting <code>TURN_SECRET</code> and <code>TURN_HOST</code>; without them the server hands out STUN only and the client still works wherever a direct or reflexive path exists.</p>

```console
PORT=3000 TURN_SECRET=<shared-secret> TURN_HOST=turn.example.com npm start
```

## Running the client

<p align="justify">Open <code>http://localhost:3000/</code> in two browser windows, enter the same room name in both, and join. The peer that sees the other's <code>peer-joined</code> event creates the offer; the call connects when ICE finds a path. The page shows signaling state, call state, ICE and peer-connection state, the selected candidate pair type, and live stats (round-trip time, jitter, packets lost, received, and sent, refreshed from <code>getStats</code> every 2 seconds). Mute and unmute toggle the local audio and video tracks; hang up closes the peer connection and leaves the room.</p>

<p align="justify"><b>Test tone mode.</b> The "Use test tone" checkbox is on by default: instead of a camera and microphone, the client generates a 440 Hz sine from an <code>OscillatorNode</code> and a 320x240 canvas painted once a second with a moving gradient and timestamp, captured with <code>canvas.captureStream()</code>. The far end hears the tone and sees the moving frame, which proves media is flowing end to end with no hardware at all. Uncheck it to use a real camera and microphone; if <code>getUserMedia</code> fails or is denied, the client falls back to the test tone and says so in the log.</p>

## ICE, STUN, and TURN

<p align="justify">The client fetches its ICE servers from <code>/ice-config</code> when it joins. STUN is always included (<code>stun:stun.l.google.com:19302</code>). When a TURN secret is configured, the server mints time-limited TURN credentials in the coturn long-term-credential style: the username is a Unix expiry timestamp and the password is <code>base64(HMAC-SHA1(secret, username))</code>, valid for one hour. The shared secret is never sent to a client, and the credentials expire on their own, so there are no static TURN accounts to leak. The same secret is passed to coturn as <code>--static-auth-secret</code>, so the two sides agree without any other coordination.</p>

<p align="justify">TURN over TLS (port 5349) is off by default: coturn needs a certificate and key to serve TLS, and this repository ships none. To enable it, provision a real certificate, uncomment the <code>tls-listening-port</code>, <code>cert</code>, and <code>pkey</code> lines in <code>turn/turnserver.conf</code>, and set <code>TURN_TLS=true</code> on the signaling server so it advertises the <code>turns:</code> URL. The server deliberately does not advertise a TLS endpoint it cannot serve.</p>

## The Docker Compose NAT lab

<p align="justify">The lab is the part of this project that answers the question the Sorenson role actually asks: what happens when the direct path is blocked? <code>lab/docker-compose.yml</code> runs the signaling server, coturn, and two headless clients. The signaling server and coturn sit on every network so both clients can reach them, but client A lives only on <code>net-a</code> and client B only on <code>net-b</code>, and the two client networks have no route between them. Each client container is also behind Docker's own NAT, so each peer's host candidate is a private container address. There is no direct path between the peers, so host and srflx candidates cannot connect and the call can only succeed through the TURN relay.</p>

```console
./scripts/nat-test.sh
```

<p align="justify">The script brings the stack up, waits for the signaling server's health endpoint, runs both clients, prints each client's JSON report, and tears the stack down. The headless client (<code>lab/lab-client.mjs</code>, werift plus <code>ws</code>) joins the room, exchanges offer/answer/ICE through the signaling server, opens a data channel, exchanges one message, and reports the candidate types it gathered and the pair that was selected. The expected outcome is a <code>relay/relay</code> selected pair on both sides. If the pair comes back <code>host/*</code> or <code>srflx/*</code>, the networks are not isolated and the lab is not testing what it claims to test.</p>

| Candidate type | What it means |
| --- | --- |
| `host` | A local address of the peer itself. Works only when the peers can reach each other directly. |
| `srflx` | The peer's public address, learned from STUN. Works when both sides have a reachable public mapping. |
| `relay` | Media flows through TURN. Works when direct and reflexive paths are blocked, at the cost of a hop through the relay. |
| `prflx` | A peer-reflexive address learned from a peer's connectivity check. |

## Testing

<p align="justify">The test suite is vitest, run with <code>npm test</code>. It passes in full: <b>33 tests, 0 failures</b>, run 24 November 2026 on a Linux sandbox with Node v24.22.1. Coverage is:</p>

- **Signaling server, integration** (9 tests, against a real `ws` server on an ephemeral port): two peers join and see each other; offer, answer, and ICE relay between peers, including end-of-candidates; malformed and unknown messages are rejected with an error and the connection stays usable; invalid room and peer ids are rejected; an offer from outside a room is rejected; a duplicate peer id in one room is rejected; room isolation (a peer in room B is unreachable from room A, and receives nothing); leave and disconnect both notify the room; a peer that answers heartbeats stays connected while one that never answers is dropped; room stats.
- **Protocol, rooms, and TURN credentials** (16 tests): message validation for every failure mode in the protocol table; room join/leave/duplicate/cleanup and `leaveAll`; TURN credential derivation (same secret and timestamp give the same password, a different secret does not, expiry is exactly the TTL); ICE server lists with and without TURN, and the `turns:` URL appearing only when TLS is enabled.
- **Client logic** (8 tests): the call state machine through its happy path and every invalid transition; `getStats` parsing against fixture reports, including a full report, a relay pair, an empty report, an in-progress pair fallback, and a stale succeeded pair losing to the nominated one.

<p align="justify">Two bugs were found by the tests and fixed in this build: the stats parser picked the first succeeded candidate pair instead of the nominated one, so a stale pair could be reported as selected; and a test literal for the TURN expiry timestamp was wrong (<code>1_700_000_3600</code> instead of <code>1_700_003_600</code>), which the implementation caught.</p>

## Measured results

<p align="justify">All figures below come from real runs on 24 November 2026 on a Linux sandbox with Node v24.22.1 and 4 vCPUs. The signaling relay numbers are single-run measurements, not averages or benchmarks.</p>

| Check | Result |
| --- | --- |
| `npm run build` | Clean, 0 errors (server and client `tsc`, plus static-file copy). |
| `npm test` | 33 tests, 0 failures, in 2.14 s. |
| Live smoke test (`scripts/smoke-test.mjs`) | 9 steps in 91 ms: two clients connected, both joined, presence delivered, offer relayed in 10 ms, answer relayed, ICE candidate relayed, end-of-candidates relayed, leave notified. An earlier run took 94 ms with the offer relayed in 11 ms. |
| `GET /health` | `{"status":"ok","rooms":0,"peers":0,"connections":0,"roomsSnapshot":{}}` with the server idle, and room counts returning to 0 after both smoke clients left. |
| `GET /ice-config` | STUN plus TURN (UDP and TCP on 3478) with a time-limited username (Unix expiry, one hour out) and an HMAC-derived password, generated live from the configured secret. |
| `GET /` | HTTP 200, 3,053 bytes; `app.js` HTTP 200, 13,218 bytes. |

## Limitations

<p align="justify">What this project is honest about is as much a part of it as what it does, and the limits below are properties of the tool, the environment it was verified in, or both.</p>

<p align="justify"><b>No real browser call has been verified here.</b> The signaling path is verified live (see Measured results), the client logic is unit-tested, and the client bundle compiles and serves, but no headless browser runs in this sandbox, so no two-browser call has been observed end to end. The first thing to do on a real machine is open the page in two windows and make a call, with and without test-tone mode.</p>

<p align="justify"><b>The Docker Compose lab has not been run.</b> There is no Docker daemon in this sandbox, so <code>lab/docker-compose.yml</code> and <code>scripts/nat-test.sh</code> are provided, not verified: the YAML parses, the scripts pass a syntax check, and the lab client's dependencies install, but no container has been started and no <code>relay/relay</code> result has been observed. Run <code>./scripts/nat-test.sh</code> on a machine with Docker to verify it.</p>

<p align="justify"><b>No Node-side WebRTC peer test exists, because the sandbox drops UDP.</b> A werift peer test was attempted: werift 0.20.1 installed cleanly, but two peer connections never opened a data channel, and a plain Node <code>dgram</code> test showed why — a UDP datagram sent to 127.0.0.1 never arrives in this sandbox (3-second timeout). ICE needs UDP, so no in-process peer connection can complete here. The werift dependency was removed rather than left in place unused, and the lab client (which runs inside Docker, where UDP works) is the place a real peer connection is exercised. On a normal machine, a werift smoke test through the signaling server is a one-file addition.</p>

<p align="justify"><b>TURN over TLS is not configured.</b> The TLS listener and the <code>turns:</code> URL are disabled until a real certificate is provisioned; see the ICE section above. The lab exercises TURN over UDP and TCP only.</p>

<p align="justify"><b>coturn itself has not been run here.</b> The configuration is written from coturn's documented options and the compose file pins <code>coturn/coturn:4.6.2</code>, but no turnserver process has started in this environment. The first Docker run will confirm the config loads and allocations succeed.</p>

<p align="justify"><b>Scale and security are deliberately small.</b> This is a lab, not a production service: rooms are in memory and lost on restart, there is no authentication on room join (anyone who knows a room name can join it), peer ids are client-chosen, and there is no rate limiting on the signaling socket. The relay is also unmetered: anyone with the TURN credentials can relay traffic until the credentials expire, which is why the credentials are time-limited to one hour.</p>
