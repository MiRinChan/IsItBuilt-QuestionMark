/** Dev server: serve the already-generated site. Run `bun run scan` to refresh data. */

import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SITE = path.join(ROOT, "site");
const PORT = Number(process.env.PORT ?? 8123);

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    const file = Bun.file(path.join(SITE, pathname));
    if (await file.exists()) return new Response(file);
    return new Response("not found", { status: 404 });
  },
});

console.log(`serving ${SITE} at http://localhost:${PORT}`);
