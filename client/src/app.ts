/**
 * Browser app for voip-lab: joins a room through the signaling server,
 * then runs a 1:1 audio/video call over RTCPeerConnection.
 *
 * Call flow (two peers in the same room):
 *   1. Each peer joins the room over WebSocket.
 *   2. The peer that sees a `peer-joined` event creates the offer.
 *   3. Offer/answer and ICE candidates are relayed by the signaling
 *      server; media itself is peer-to-peer (host/srflx) or via TURN
 *      (relay) when the direct path is blocked.
 */
import { CallStateMachine, parseStats, type CallStats } from "./call.js";
import { createTestToneStream } from "./tone.js";

type ServerMessage = {
  type: string;
  room?: string;
  peerId?: string;
  peers?: string[];
  from?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit | null;
  name?: string;
  code?: string;
  message?: string;
};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

function logLine(text: string): void {
  const log = $<HTMLPreElement>("log");
  const time = new Date().toISOString().slice(11, 19);
  log.textContent += `[${time}] ${text}\n`;
  log.scrollTop = log.scrollHeight;
}

class SignalingClient {
  private ws: WebSocket | null = null;
  private url: string;

  onMessage: (msg: ServerMessage) => void = () => undefined;
  onOpen: () => void = () => undefined;
  onClose: () => void = () => undefined;

  constructor(url: string) {
    this.url = url;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener("open", () => {
        this.onOpen();
        resolve();
      });
      ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")));
      ws.addEventListener("close", () => this.onClose());
      ws.addEventListener("message", (event) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data as string) as ServerMessage;
        } catch {
          logLine("Received non-JSON message from server; ignoring.");
          return;
        }
        if (msg.type === "ping") {
          this.send({ type: "pong" });
          return;
        }
        this.onMessage(msg);
      });
    });
  }

  send(payload: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}

class CallManager {
  private machine = new CallStateMachine();
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream = new MediaStream();
  private signaling: SignalingClient | null = null;
  private room = "";
  private peerId = "";
  private remotePeerId: string | null = null;
  private statsTimer: number | null = null;
  private iceServers: RTCIceServer[] = [];

  async join(room: string, name: string, useTestTone: boolean): Promise<void> {
    if (this.machine.current !== "idle" && this.machine.current !== "ended") {
      throw new Error(`Cannot join while call state is ${this.machine.current}`);
    }
    this.machine.join();
    this.room = room;
    this.peerId = `peer-${Math.random().toString(36).slice(2, 8)}`;
    this.updateStatus();

    const iceRes = await fetch("/ice-config");
    const iceJson = (await iceRes.json()) as { iceServers: RTCIceServer[] };
    this.iceServers = iceJson.iceServers;

    if (useTestTone) {
      this.localStream = createTestToneStream();
      logLine("Using test tone (oscillator audio + canvas video); no camera or mic.");
    } else {
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      } catch (err) {
        logLine(`getUserMedia failed (${(err as Error).message}); falling back to test tone.`);
        this.localStream = createTestToneStream();
      }
    }
    $<HTMLVideoElement>("local-video").srcObject = this.localStream;
    $<HTMLVideoElement>("remote-video").srcObject = this.remoteStream;

    const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    this.signaling = new SignalingClient(wsUrl);
    this.signaling.onMessage = (msg) => void this.handleServerMessage(msg);
    this.signaling.onClose = () => {
      logLine("Signaling connection closed.");
      this.setSignalingState("disconnected");
    };
    await this.signaling.connect();
    this.setSignalingState("connected");
    this.signaling.send({ type: "join", room, peerId: this.peerId, name });
    logLine(`Joined room '${room}' as ${this.peerId}.`);
  }

  hangup(): void {
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (this.signaling && this.room) {
      this.signaling.send({ type: "leave", room: this.room });
      this.signaling.close();
      this.signaling = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) track.stop();
      this.localStream = null;
    }
    this.remoteStream = new MediaStream();
    $<HTMLVideoElement>("remote-video").srcObject = this.remoteStream;
    this.remotePeerId = null;
    try {
      this.machine.hangup();
    } catch {
      /* already ended */
    }
    this.machine.reset();
    this.updateStatus();
    this.renderStats(null);
    logLine("Call ended.");
  }

  toggleAudioMute(): boolean {
    const track = this.localStream?.getAudioTracks()[0];
    if (!track) return false;
    track.enabled = !track.enabled;
    return !track.enabled;
  }

  toggleVideoMute(): boolean {
    const track = this.localStream?.getVideoTracks()[0];
    if (!track) return false;
    track.enabled = !track.enabled;
    return !track.enabled;
  }

  private createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    }
    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate && this.remotePeerId) {
        this.signaling?.send({
          type: "ice-candidate",
          room: this.room,
          to: this.remotePeerId,
          candidate: event.candidate.toJSON(),
        });
      } else if (!event.candidate && this.remotePeerId) {
        this.signaling?.send({ type: "ice-candidate", room: this.room, to: this.remotePeerId, candidate: null });
      }
    });
    pc.addEventListener("track", (event) => {
      for (const track of event.streams[0]?.getTracks() ?? []) this.remoteStream.addTrack(track);
      logLine(`Remote ${event.track.kind} track received.`);
    });
    pc.addEventListener("iceconnectionstatechange", () => {
      this.updateStatus();
      logLine(`ICE connection state: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        this.machine.connected();
        this.updateStatus();
        this.startStatsPolling();
      }
    });
    pc.addEventListener("connectionstatechange", () => {
      this.updateStatus();
      logLine(`Connection state: ${pc.connectionState}`);
    });
    return pc;
  }

  private async handleServerMessage(msg: ServerMessage): Promise<void> {
    switch (msg.type) {
      case "joined": {
        logLine(`Server confirmed join; peers already here: ${(msg.peers ?? []).join(", ") || "none"}.`);
        // If someone is already in the room, they will see our peer-joined
        // and make the offer; we wait. (See peer-joined below.)
        break;
      }
      case "peer-joined": {
        if (!msg.peerId) break;
        logLine(`Peer ${msg.peerId} joined; creating offer.`);
        this.remotePeerId = msg.peerId;
        this.pc = this.createPeerConnection();
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        this.signaling?.send({ type: "offer", room: this.room, to: msg.peerId, sdp: offer.sdp });
        break;
      }
      case "peer-left": {
        logLine(`Peer ${msg.peerId} left.`);
        if (msg.peerId === this.remotePeerId) {
          this.remotePeerId = null;
          if (this.pc) {
            this.pc.close();
            this.pc = null;
          }
        }
        break;
      }
      case "offer": {
        if (!msg.from || !msg.sdp) break;
        logLine(`Offer received from ${msg.from}; creating answer.`);
        this.remotePeerId = msg.from;
        this.pc = this.createPeerConnection();
        await this.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.signaling?.send({ type: "answer", room: this.room, to: msg.from, sdp: answer.sdp });
        break;
      }
      case "answer": {
        if (!msg.sdp || !this.pc) break;
        logLine(`Answer received from ${msg.from}.`);
        await this.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        break;
      }
      case "ice-candidate": {
        if (!this.pc) break;
        if (msg.candidate) {
          try {
            await this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } catch (err) {
            logLine(`Failed to add ICE candidate: ${(err as Error).message}`);
          }
        }
        break;
      }
      case "error": {
        logLine(`Server error [${msg.code}]: ${msg.message}`);
        break;
      }
      default:
        logLine(`Unknown server message type: ${msg.type}`);
    }
  }

  private startStatsPolling(): void {
    if (this.statsTimer !== null) return;
    const poll = async () => {
      if (!this.pc) return;
      const report = await this.pc.getStats();
      const entries: Array<{ type: string; id: string; [key: string]: unknown }> = [];
      report.forEach((stat) => {
        entries.push({ type: stat.type, id: stat.id, ...(stat as unknown as Record<string, unknown>) });
      });
      this.renderStats(parseStats(entries));
    };
    void poll();
    this.statsTimer = window.setInterval(() => void poll(), 2000);
  }

  private renderStats(stats: CallStats | null): void {
    const set = (id: string, value: string) => {
      $(id).textContent = value;
    };
    set("stat-rtt", stats?.rttMs !== null && stats?.rttMs !== undefined ? `${stats.rttMs.toFixed(1)} ms` : "—");
    set("stat-jitter", stats?.jitterMs !== null && stats?.jitterMs !== undefined ? `${stats.jitterMs.toFixed(2)} ms` : "—");
    set("stat-lost", stats ? String(stats.packetsLost) : "—");
    set("stat-received", stats ? String(stats.packetsReceived) : "—");
    set("stat-sent", stats ? String(stats.packetsSent) : "—");
    set("stat-pair", stats?.candidatePairType ?? "—");
  }

  private setSignalingState(state: string): void {
    $("status-signaling").textContent = state;
  }

  private updateStatus(): void {
    $("status-call").textContent = this.machine.current;
    $("status-ice").textContent = this.pc ? this.pc.iceConnectionState : "—";
    $("status-connection").textContent = this.pc ? this.pc.connectionState : "—";
    $<HTMLButtonElement>("btn-join").disabled = this.machine.current !== "idle" && this.machine.current !== "ended";
    $<HTMLButtonElement>("btn-hangup").disabled = this.machine.current === "idle" || this.machine.current === "ended";
    $<HTMLButtonElement>("btn-mute-audio").disabled = this.machine.current !== "in-call";
    $<HTMLButtonElement>("btn-mute-video").disabled = this.machine.current !== "in-call";
  }
}

const manager = new CallManager();

$("btn-join").addEventListener("click", () => {
  const room = $<HTMLInputElement>("input-room").value.trim();
  const name = $<HTMLInputElement>("input-name").value.trim();
  const useTestTone = $<HTMLInputElement>("input-test-tone").checked;
  if (!room) {
    logLine("Enter a room name first.");
    return;
  }
  void manager.join(room, name, useTestTone).catch((err: Error) => logLine(`Join failed: ${err.message}`));
});

$("btn-hangup").addEventListener("click", () => manager.hangup());

$("btn-mute-audio").addEventListener("click", (event) => {
  const muted = manager.toggleAudioMute();
  (event.target as HTMLButtonElement).textContent = muted ? "Unmute audio" : "Mute audio";
});

$("btn-mute-video").addEventListener("click", (event) => {
  const muted = manager.toggleVideoMute();
  (event.target as HTMLButtonElement).textContent = muted ? "Unmute video" : "Mute video";
});

logLine("voip-lab client ready. Join a room to start a call.");
