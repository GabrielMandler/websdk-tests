const MAX_EVENTS = 150;

const consoleList = document.getElementById("console-log");
const networkBody = document.getElementById("network-log");
const clearConsoleBtn = document.getElementById("clear-console");
const clearNetworkBtn = document.getElementById("clear-network");
const healthBtn = document.getElementById("health-btn");
const consoleCountEl = document.getElementById("console-count");
const networkCountEl = document.getElementById("network-count");

let consoleTotal = 0;
let networkTotal = 0;
const seenResourceEntries = new Set();

/**
 * VConsole walks the DOM and can touch cross-origin iframes (e.g. AppsFlyer), which throws
 * SecurityError — including after init. Only load on localhost or ?vconsole=1 (not on GitHub Pages / Datadog).
 */
(function loadVConsoleOptional() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("vconsole") === "0") return;
  const enabled =
    params.get("vconsole") === "1" ||
    /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname);
  if (!enabled) return;

  const s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/vconsole@3.15.1/dist/vconsole.min.js";
  s.crossOrigin = "anonymous";
  s.async = true;
  s.onload = function () {
    try {
      if (typeof window.VConsole === "function") {
        window.__vconsole = new window.VConsole();
      }
    } catch (_err) {
      /* ignore */
    }
  };
  document.head.appendChild(s);
})();

function now() {
  return new Date().toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortUrl(url) {
  try {
    const u = new URL(url, window.location.origin);
    return u.pathname + u.search || url;
  } catch {
    return url;
  }
}

function stringifyArg(arg) {
  if (typeof arg === "string") {
    return arg;
  }
  try {
    return JSON.stringify(arg);
  } catch (_err) {
    return String(arg);
  }
}

function callerInitiator() {
  const stack = new Error().stack || "";
  const lines = stack.split("\n").slice(2);
  for (const line of lines) {
    const m =
      line.match(/([^/\\]+\.(?:js|mjs|tsx?|jsx)):(\d+)/) ||
      line.match(/@([^:]+):(\d+)/);
    if (m) {
      return `${m[1]}:${m[2]}`;
    }
  }
  return "script.js";
}

function formatSize(bytes) {
  if (bytes == null || Number.isNaN(bytes)) {
    return "-";
  }
  if (bytes === 0) {
    return "0 B";
  }
  const u = ["B", "KB", "MB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

function bumpConsoleCount() {
  consoleTotal += 1;
  consoleCountEl.textContent = String(consoleTotal);
}

function bumpNetworkCount() {
  networkTotal += 1;
  networkCountEl.textContent = String(networkTotal);
}

function appendConsoleRow(message, level = "log") {
  const li = document.createElement("li");
  li.className = `level-${level}`;
  li.innerHTML = `
    <span class="brand-icon" aria-hidden="true"></span>
    <span class="row-main">${escapeHtml(message)}</span>
    <span class="row-meta">${escapeHtml(now())}</span>
  `;
  consoleList.prepend(li);
  bumpConsoleCount();
  while (consoleList.children.length > MAX_EVENTS) {
    consoleList.removeChild(consoleList.lastChild);
  }
}

function makeNetworkRowEl() {
  const row = document.createElement("div");
  row.className = "net-row";
  row.setAttribute("role", "listitem");
  row.innerHTML = `
    <span class="col-name"></span>
    <span class="col-status"></span>
    <span class="col-type"></span>
    <span class="col-initiator"></span>
    <span class="col-size"></span>
    <span class="col-time"></span>
  `;
  return row;
}

function prependNetworkRow(row) {
  networkBody.prepend(row);
  bumpNetworkCount();
  while (networkBody.children.length > MAX_EVENTS) {
    networkBody.removeChild(networkBody.lastChild);
  }
}

function setNetworkRowPending(row, url, method, initiator, type = "fetch") {
  row.querySelector(".col-name").textContent = shortUrl(url);
  row.querySelector(".col-status").textContent = "...";
  row.querySelector(".col-status").classList.add("col-muted");
  row.querySelector(".col-type").textContent = type;
  row.querySelector(".col-initiator").textContent = initiator || method;
  row.querySelector(".col-size").textContent = "-";
  row.querySelector(".col-time").textContent = "-";
}

function setNetworkRowDone(row, { status, type, initiator, size, timeMs, ok }) {
  row.querySelector(".col-status").textContent = String(status);
  row.querySelector(".col-status").classList.toggle("col-muted", status === 0);
  row.querySelector(".col-type").textContent = type;
  row.querySelector(".col-initiator").textContent = initiator;
  row.querySelector(".col-size").textContent = formatSize(size);
  row.querySelector(".col-time").textContent = `${timeMs} ms`;
  if (!ok) {
    row.classList.add("status-err");
  }
}

async function responseByteLength(response) {
  const len = response.headers.get("content-length");
  if (len) {
    return Number(len);
  }
  try {
    const buf = await response.clone().arrayBuffer();
    return buf.byteLength;
  } catch {
    return null;
  }
}

function addResourceEntry(entry) {
  const key = `${entry.name}|${entry.startTime}|${entry.initiatorType}`;
  if (seenResourceEntries.has(key)) {
    return;
  }
  seenResourceEntries.add(key);

  // fetch/xhr are already captured with richer details from wrappers.
  if (entry.initiatorType === "fetch" || entry.initiatorType === "xmlhttprequest") {
    return;
  }

  const row = makeNetworkRowEl();
  row.querySelector(".col-name").textContent = shortUrl(entry.name);
  const rs = entry.responseStatus;
  const initiator = entry.initiatorType || "";
  // Cross-origin script/link/img often report responseStatus 0 without Timing-Allow-Origin,
  // even when the load succeeded — do not mark those as failed.
  const opaqueOkTypes = new Set(["script", "link", "css", "img", "font", "other"]);
  let statusText;
  let isErr = false;
  if (typeof rs === "number") {
    if (rs >= 400) {
      statusText = String(rs);
      isErr = true;
    } else if (rs === 0) {
      if (opaqueOkTypes.has(initiator)) {
        statusText = "—";
        isErr = false;
      } else {
        statusText = "0";
        isErr = true;
      }
    } else {
      statusText = String(rs);
    }
  } else {
    statusText = "—";
  }
  if (isErr) {
    row.classList.add("status-err");
  }
  row.querySelector(".col-status").textContent = statusText;
  row.querySelector(".col-type").textContent = entry.initiatorType || "resource";
  row.querySelector(".col-initiator").textContent = entry.nextHopProtocol || "browser";
  row.querySelector(".col-size").textContent = formatSize(entry.transferSize || entry.encodedBodySize);
  row.querySelector(".col-time").textContent = `${Math.round(entry.duration)} ms`;
  prependNetworkRow(row);
}

function setupResourceObserver() {
  if (!("PerformanceObserver" in window)) {
    return;
  }

  for (const entry of performance.getEntriesByType("resource")) {
    addResourceEntry(entry);
  }

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        addResourceEntry(entry);
      }
    });
    observer.observe({ type: "resource", buffered: true });
  } catch (_err) {
    // Some browsers do not support observe({type, buffered}).
  }
}

function getHealthCheckUrl() {
  const host = window.location.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1") {
    return "/health";
  }
  if (host.endsWith(".github.io")) {
    return "./health.json";
  }
  return "/health";
}

function setupConsoleCapture() {
  const methods = ["log", "info", "warn", "error", "debug"];
  for (const method of methods) {
    const original = console[method];
    console[method] = (...args) => {
      appendConsoleRow(
        `${method.toUpperCase()} ${args.map(stringifyArg).join(" ")}`,
        method
      );
      original.apply(console, args);
    };
  }

  window.addEventListener("error", (event) => {
    appendConsoleRow(`ERROR ${event.message}`, "error");
  });
}

function setupNetworkCapture() {
  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const [input, init] = args;
    let url;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else if (input && typeof input.url === "string") {
      url = input.url;
    } else {
      url = String(input);
    }
    const method =
      init?.method ||
      (typeof input !== "string" && input?.method) ||
      "GET";
    const started = performance.now();
    const initiator = callerInitiator();

    const row = makeNetworkRowEl();
    setNetworkRowPending(row, url, method, initiator);
    prependNetworkRow(row);

    try {
      const response = await originalFetch(...args);
      const timeMs = Math.round(performance.now() - started);
      const size = await responseByteLength(response);
      setNetworkRowDone(row, {
        status: response.status,
        type: "fetch",
        initiator,
        size,
        timeMs,
        ok: response.ok,
      });
      return response;
    } catch (err) {
      const timeMs = Math.round(performance.now() - started);
      setNetworkRowDone(row, {
        status: 0,
        type: "fetch",
        initiator,
        size: null,
        timeMs,
        ok: false,
      });
      row.querySelector(".col-name").textContent = `${shortUrl(url)} (${String(err)})`;
      throw err;
    }
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
    this.__debugMethod = method;
    this.__debugUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function send(...args) {
    const started = performance.now();
    const initiator = callerInitiator();
    const url = this.__debugUrl || "<unknown>";
    const method = this.__debugMethod || "GET";

    const row = makeNetworkRowEl();
    setNetworkRowPending(row, url, method, initiator, "xhr");
    prependNetworkRow(row);

    this.addEventListener("loadend", () => {
      const timeMs = Math.round(performance.now() - started);
      const ok = this.status >= 200 && this.status < 400;
      let size = null;
      const len = this.getResponseHeader("content-length");
      if (len) {
        size = Number(len);
      } else if (typeof this.responseText === "string") {
        size = new Blob([this.responseText]).size;
      }
      setNetworkRowDone(row, {
        status: this.status || 0,
        type: "xhr",
        initiator,
        size,
        timeMs,
        ok,
      });
    });
    return originalSend.call(this, ...args);
  };
}

clearConsoleBtn.addEventListener("click", () => {
  consoleList.innerHTML = "";
  consoleTotal = 0;
  consoleCountEl.textContent = "0";
});

clearNetworkBtn.addEventListener("click", () => {
  networkBody.innerHTML = "";
  networkTotal = 0;
  networkCountEl.textContent = "0";
});

if (healthBtn) {
  healthBtn.addEventListener("click", async () => {
    const healthUrl = getHealthCheckUrl();
    console.info(`Triggering health request: ${healthUrl}`);
    const res = await fetch(healthUrl);
    const data = await res.json();
    console.log("Health response:", data);
  });
}

setupConsoleCapture();
setupNetworkCapture();
setupResourceObserver();

function setupDdSdkMetrics() {
  if (
    !window.ddSdkMetrics ||
    typeof window.ddSdkMetrics.markSdkReady !== "function"
  ) {
    return;
  }
  const g = window.__DD_SDK_METRICS__ || {};
  const finalizeMs =
    typeof g.finalizeTimeoutMs === "number" && Number.isFinite(g.finalizeTimeoutMs)
      ? Math.min(120000, Math.max(5000, g.finalizeTimeoutMs))
      : 30000;
  const poll = setInterval(() => {
    if (typeof window.AF === "function") {
      clearInterval(poll);
      window.ddSdkMetrics.markSdkReady();
    }
  }, 40);
  setTimeout(() => {
    clearInterval(poll);
  }, finalizeMs + 5000);
}

setupDdSdkMetrics();

console.log("Console and network monitor initialized.");
