// Minimal static file server for the preview half of the spike (A7).
// Usage: node static-server.mjs <root> <port>. Listens on 0.0.0.0 (required by getTcpPort).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "/workspace/repo");
const port = Number(process.argv[3] ?? 8080);
const types = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".css": "text/css", ".js": "text/javascript" };

process.on("SIGTERM", () => process.exit(0));

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let file = normalize(join(root, path));
    if (!file.startsWith(root) || file.split("/").includes(".git")) {
      res.writeHead(404).end("not found");
      return;
    }
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "x-spike-host": String(req.headers.host ?? "") });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "0.0.0.0");
