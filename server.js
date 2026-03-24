const http = require("http");
const fs = require("fs");
const path = require("path");

const initialPort = Number(process.env.PORT) || 3000;
const publicDir = __dirname;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === "ENOENT") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Failed to load file");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      contentTypes[ext] || "application/octet-stream; charset=utf-8";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

function requestHandler(req, res) {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const url = new URL(req.url, "http://localhost");
  let requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;

  // Friendly routes for HTML pages.
  if (url.pathname === "/index-gtm" || url.pathname === "/gtm") {
    requestedPath = "/index-gtm.html";
  }
  if (url.pathname === "/index-csp" || url.pathname === "/csp") {
    requestedPath = "/index-csp.html";
  }
  if (url.pathname === "/nonce-test") {
    requestedPath = "/csp/nonce-test.html";
  }

  const normalizedPath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, normalizedPath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  sendFile(res, filePath);
}

function startServer(port) {
  const server = http.createServer(requestHandler);

  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && !process.env.PORT) {
      const nextPort = port + 1;
      console.warn(
        `Port ${port} is in use, trying http://localhost:${nextPort} instead...`
      );
      startServer(nextPort);
      return;
    }

    console.error("Failed to start server:", err.message);
    process.exit(1);
  });

  server.once("listening", () => {
    console.log(`Server running at http://localhost:${port}`);
  });

  server.listen(port);
}

startServer(initialPort);
