const http = require("http");
const fs = require("fs");
const path = require("path");

const initialPort = Number(process.env.PORT) || 3000;
const publicDir = __dirname;

/** Dev harness: avoid stale HTML/JS/CSS when iterating on tests (browser HTTP cache). */
const NO_CACHE = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
};

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
        res.writeHead(404, {
          "Content-Type": "text/plain; charset=utf-8",
          ...NO_CACHE,
        });
        res.end("Not found");
        return;
      }

      res.writeHead(500, {
        "Content-Type": "text/plain; charset=utf-8",
        ...NO_CACHE,
      });
      res.end("Failed to load file");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      contentTypes[ext] || "application/octet-stream; charset=utf-8";
    res.writeHead(200, { "Content-Type": contentType, ...NO_CACHE });
    res.end(data);
  });
}

function requestHandler(req, res) {
  if (req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      ...NO_CACHE,
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8",
      ...NO_CACHE,
    });
    res.end("Not found");
    return;
  }

  const url = new URL(req.url, "http://localhost");
  let requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;

  // Friendly routes for HTML pages.
  if (url.pathname === "/index-gtm" || url.pathname === "/gtm" || url.pathname === "/gtm/") {
    requestedPath = "/gtm/index.html";
  }
  if (url.pathname === "/index-csp" || url.pathname === "/csp" || url.pathname === "/csp/") {
    requestedPath = "/csp/index.html";
  }
  if (url.pathname === "/nonce-test") {
    requestedPath = "/csp/nonce-test.html";
  }
  if (url.pathname === "/index-adobe" || url.pathname === "/adobe" || url.pathname === "/adobe/") {
    requestedPath = "/adobe/index.html";
  }
  if (url.pathname === "/index-adobe-1" || url.pathname === "/adobe-1") {
    requestedPath = "/adobe/adobe-1.html";
  }
  if (url.pathname === "/index-adobe-2" || url.pathname === "/adobe-2") {
    requestedPath = "/adobe/adobe-2.html";
  }
  if (url.pathname === "/index-adobe-3" || url.pathname === "/adobe-3") {
    requestedPath = "/adobe/adobe-3.html";
  }
  if (url.pathname === "/simple") {
    requestedPath = "/simple-test.html";
  }
  if (url.pathname === "/old-test-integration") {
    requestedPath = "/old-test-integration.html";
  }

  const normalizedPath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, normalizedPath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, {
      "Content-Type": "text/plain; charset=utf-8",
      ...NO_CACHE,
    });
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
