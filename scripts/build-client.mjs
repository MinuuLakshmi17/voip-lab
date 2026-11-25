/**
 * Copy the client's static files into client/dist after tsc compiles
 * the TypeScript. The signaling server serves client/dist over HTTP.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientDir = join(root, "client");
const distDir = join(clientDir, "dist");

await mkdir(distDir, { recursive: true });
await copyFile(join(clientDir, "index.html"), join(distDir, "index.html"));
await copyFile(join(clientDir, "styles.css"), join(distDir, "styles.css"));
console.log("client static files copied to client/dist");
