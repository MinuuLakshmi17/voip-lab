import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { SignalingServer } from "./signaling.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const TURN_SECRET = process.env.TURN_SECRET;
const TURN_HOST = process.env.TURN_HOST ?? process.env.TURN_HOSTNAME;
const TURN_TLS = process.env.TURN_TLS === "true";
const CLIENT_DIR = resolve(process.env.CLIENT_DIR ?? join(__dirname, "..", "..", "client", "dist"));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = join(CLIENT_DIR, pathname);
  // No directory traversal: the resolved path must stay inside CLIENT_DIR.
  if (!filePath.startsWith(CLIENT_DIR + "/") && filePath !== CLIENT_DIR) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const signaling = new SignalingServer(new WebSocketServer({ noServer: true }), {
  turnSecret: TURN_SECRET,
  turnHost: TURN_HOST,
  turnTls: TURN_TLS,
});

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/health") {
    sendJson(res, 200, { status: "ok", ...signaling.stats() });
    return;
  }
  if (url.pathname === "/ice-config") {
    sendJson(res, 200, { iceServers: signaling.iceServers() });
    return;
  }
  void serveStatic(req, res);
});

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  // Hand the upgrade to the signaling server's WebSocket server.
  signaling.handleUpgrade(req, socket, head);
});

httpServer.listen(PORT, HOST, () => {
  console.log(`voip-lab signaling server listening on http://${HOST}:${PORT}`);
  console.log(`  client:  http://${HOST}:${PORT}/`);
  console.log(`  health:  http://${HOST}:${PORT}/health`);
  console.log(`  ice:     http://${HOST}:${PORT}/ice-config`);
  console.log(`  TURN:    ${TURN_SECRET && TURN_HOST ? `enabled (${TURN_HOST})` : "not configured (set TURN_SECRET and TURN_HOST to enable)"}`);
});
