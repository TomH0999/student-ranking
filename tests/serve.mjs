/**
 * Serveur statique de développement : sert le dépôt comme GitHub Pages,
 * sous http://127.0.0.1:4174/student-ranking/
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "/student-ranking/";
const port = Number(process.env.PORT || 4174);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith(BASE)) {
        res.writeHead(302, { Location: BASE }).end();
        return;
    }
    let rel = decodeURIComponent(url.pathname.slice(BASE.length)) || "index.html";
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(root, rel);
    const inside = path.relative(root, file);
    if (inside.startsWith("..") || /^(node_modules|tests|\.git)(\/|$)/.test(inside)) {
        res.writeHead(404).end("Not found");
        return;
    }
    try {
        const body = await readFile(file);
        res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }).end(body);
    } catch {
        res.writeHead(404).end("Not found");
    }
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}${BASE}`));
