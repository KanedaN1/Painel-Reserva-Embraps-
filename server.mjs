import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  if (parsedUrl.pathname === "/api/colaboradores") {
    const sheetId = parsedUrl.searchParams.get("sheetId") || "19z_Zx40ibDudBRrQwBJ2o2hWTyTQXPpMwCTuxsLPCrA";
    const googleUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=csv`;
    try {
      const response = await fetch(googleUrl);
      const csvText = await response.text();
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(csvText);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  let filePath = path.join(__dirname, parsedUrl.pathname === "/" ? "index.html" : parsedUrl.pathname);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Arquivo não encontrado");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`Servidor Controle de Reserva EMBRAPS rodando em http://localhost:${PORT}`);
});

