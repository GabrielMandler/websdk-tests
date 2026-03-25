/**
 * AppsFlyer test harness (child frame). Enable with ?harness=1&harnessId=<id>.
 * Posts metrics to parent via postMessage. Load before script.js so fetch wraps chain correctly.
 */
(function () {
  const params = new URLSearchParams(window.location.search);
  if (params.get("harness") !== "1") return;

  const testId = params.get("harnessId") || "";
  const inFrame = window.parent !== window;
  if (!inFrame) return;

  function post(payload) {
    window.parent.postMessage(
      { source: "websdk-harness", testId, ...payload },
      window.location.origin
    );
  }

  const metrics = {
    path: window.location.pathname,
    afSdk: false,
    sdkReadyMs: null,
    firstAf2xxMs: null,
    /** Time to first HTTP 2xx on wa.appsflyersdk.com/.../events (SDK “fire” in DevTools). */
    firstEvents2xxMs: null,
    af2xxCount: 0,
    afFailCount: 0,
    samples: [],
    /**
     * Matches a healthy manifestLoader flow: manifest JSON + .sig, then coverdomain + events XHRs.
     */
    networkProfile: {
      manifestJson2xx: false,
      manifestSig2xx: false,
      coverdomain2xx: false,
      events2xx: 0,
    },
    /** CDN wa-staging testSdk bundle loaded (script tag; may be opaque responseStatus 0). */
    cdnTestSdkScriptOk: false,
    /**
     * manifestLoader.v1.js returned 4xx (e.g. relative URL resolves to localhost → 403).
     * Not an AppsFlyer host, so tracked separately from afFailCount.
     */
    relativeManifestLoaderFailed: false,
    /** Saw a resource timing entry for manifestLoader.v1.js (any initiator). */
    manifestLoaderRequestSeen: false,
    /** That request reported HTTP 2xx (responseStatus or inferred). */
    manifestLoaderHttp2xx: false,
  };

  function isAfHost(hostname) {
    return /appsflyer\.com$/i.test(hostname) || /appsflyersdk\.com$/i.test(hostname);
  }

  function isAfUrl(url) {
    try {
      const u = typeof url === "string" ? new URL(url, location.href) : url;
      return isAfHost(u.hostname);
    } catch {
      return false;
    }
  }

  function isCdnWaStagingTestSdk(url) {
    try {
      const u = new URL(url, location.href);
      return (
        /cdn\.appsflyer\.com$/i.test(u.hostname) &&
        /\/wa-staging\/|testSdk\./i.test(u.pathname + u.search)
      );
    } catch {
      return false;
    }
  }

  function isManifestLoaderV1Url(url) {
    try {
      return /manifestLoader\.v1\.js$/i.test(new URL(url, location.href).pathname);
    } catch {
      return false;
    }
  }

  function markManifestLoaderHttpFailure(url, status) {
    if (!isManifestLoaderV1Url(url)) return;
    metrics.manifestLoaderRequestSeen = true;
    if (typeof status === "number" && status >= 200 && status < 300) {
      metrics.manifestLoaderHttp2xx = true;
    } else if (typeof status === "number" && status >= 400) {
      metrics.relativeManifestLoaderFailed = true;
    }
    post({ phase: "af-network", metrics: { ...metrics } });
  }

  function recordManifestLoaderResourceEntry(e) {
    if (!isManifestLoaderV1Url(e.name)) return;
    metrics.manifestLoaderRequestSeen = true;
    const rs = e.responseStatus;
    if (typeof rs === "number") {
      if (rs >= 200 && rs < 300) {
        metrics.manifestLoaderHttp2xx = true;
      } else if (rs >= 400) {
        metrics.relativeManifestLoaderFailed = true;
      }
    }
    post({ phase: "af-network", metrics: { ...metrics } });
  }

  /**
   * Classify AppsFlyer Web SDK URLs like DevTools: manifest json/sig, coverdomain, events on wa.appsflyersdk.com.
   */
  function classifyAfRequest(url) {
    try {
      const u = new URL(url, location.href);
      const path = u.pathname;
      const pathLower = path.toLowerCase();
      const hay = (path + u.search).toLowerCase();
      if (/\.json\.sig$/i.test(path) || (/manifest/i.test(path) && /\.sig$/i.test(path))) {
        return "manifestSig";
      }
      if (/manifest/i.test(path) && /\.json$/i.test(path) && !/\.sig$/i.test(path)) {
        return "manifestJson";
      }
      if (/coverdomain/i.test(hay)) {
        return "coverdomain";
      }
      if (
        /appsflyersdk\.com$/i.test(u.hostname) &&
        (/\/events(\?|$)/i.test(path) || pathLower.endsWith("/events"))
      ) {
        return "events";
      }
    } catch {
      return null;
    }
    return null;
  }

  function bumpNetworkProfile(url, status, ok) {
    if (!ok || status < 200 || status >= 300) return;
    const kind = classifyAfRequest(url);
    if (!kind) return;
    const ms = performance.now();
    const p = metrics.networkProfile;
    if (kind === "manifestJson") {
      p.manifestJson2xx = true;
    } else if (kind === "manifestSig") {
      p.manifestSig2xx = true;
    } else if (kind === "coverdomain") {
      p.coverdomain2xx = true;
    } else if (kind === "events") {
      p.events2xx += 1;
      if (metrics.firstEvents2xxMs === null) {
        metrics.firstEvents2xxMs = ms;
      }
    }
  }

  function recordAf(url, status, ok, kind) {
    if (!isAfUrl(url)) return;

    const ms = performance.now();
    if (metrics.samples.length < 24) {
      metrics.samples.push({
        kind,
        status,
        ok,
        ms: Math.round(ms),
        url: String(url).slice(0, 120),
      });
    }

    if (ok && status >= 200 && status < 300) {
      metrics.af2xxCount += 1;
      if (metrics.firstAf2xxMs === null) {
        metrics.firstAf2xxMs = ms;
      }
      bumpNetworkProfile(url, status, true);
    } else if (!ok || status === 0 || status >= 400) {
      metrics.afFailCount += 1;
    }

    post({
      phase: "af-network",
      metrics: { ...metrics },
    });
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const input = args[0];
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input && typeof input.url === "string"
            ? input.url
            : "";
    try {
      const res = await origFetch.apply(this, args);
      if (url) {
        markManifestLoaderHttpFailure(url, res.status);
        if (isAfUrl(url)) {
          recordAf(url, res.status, res.ok, "fetch");
        }
      }
      return res;
    } catch (_err) {
      if (url && isAfUrl(url)) {
        recordAf(url, 0, false, "fetch");
      }
      throw _err;
    }
  };

  const origBeacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = function (url, data) {
    const ok = origBeacon(url, data);
    if (url && isAfUrl(url)) {
      post({
        phase: "beacon-queued",
        url: String(url).slice(0, 160),
        queued: ok,
        testId,
      });
    }
    return ok;
  };

  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__harnessUrl = url;
    return origXhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const url = this.__harnessUrl;
    this.addEventListener("loadend", () => {
      if (url) {
        const st = this.status || 0;
        markManifestLoaderHttpFailure(url, st);
        if (isAfUrl(url)) {
          recordAf(url, st, st >= 200 && st < 400, "xhr");
        }
      }
    });
    return origXhrSend.apply(this, args);
  };

  // Beacon/ping: no fetch wrapper. Script tags (manifestLoader, testSdk.unmin.js) are not fetch —
  // cross-origin scripts often report responseStatus 0 without TAO; use transfer/decoded size to infer OK.
  if ("PerformanceObserver" in window) {
    try {
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.entryType !== "resource") continue;
          if (isManifestLoaderV1Url(e.name)) {
            recordManifestLoaderResourceEntry(e);
          }
          const it = e.initiatorType || "";
          if (!isAfUrl(e.name)) continue;
          if (it === "beacon" || it === "ping") {
            const rs = e.responseStatus;
            if (typeof rs !== "number") continue;
            const ok = rs >= 200 && rs < 300;
            recordAf(e.name, rs, ok, it);
            continue;
          }
          if (it !== "script") continue;
          const rs = e.responseStatus;
          const hasBody =
            (e.decodedBodySize != null && e.decodedBodySize > 0) ||
            (e.transferSize != null && e.transferSize > 0);
          const okHttp = typeof rs === "number" && rs >= 200 && rs < 300;
          const opaqueLoaded = rs === 0 && hasBody;
          const ok = okHttp || opaqueLoaded;
          if (!ok) {
            if (typeof rs === "number" && rs >= 400) {
              recordAf(e.name, rs, false, "script");
            }
            continue;
          }
          const statusForRow = okHttp ? rs : 200;
          recordAf(e.name, statusForRow, true, "script");
          if (isCdnWaStagingTestSdk(e.name)) {
            metrics.cdnTestSdkScriptOk = true;
          }
        }
      });
      obs.observe({ type: "resource", buffered: true });
    } catch (_err) {
      // ignore
    }
  }

  const afPoll = setInterval(() => {
    if (typeof window.AF === "function" && !metrics.afSdk) {
      metrics.afSdk = true;
      metrics.sdkReadyMs = performance.now();
      post({ phase: "sdk", metrics: { ...metrics } });
    }
  }, 40);

  post({ phase: "start", metrics: { ...metrics } });

  const DONE_MS = 14000;
  setTimeout(() => {
    clearInterval(afPoll);
    if (typeof window.AF === "function") {
      metrics.afSdk = true;
      if (metrics.sdkReadyMs === null) {
        metrics.sdkReadyMs = performance.now();
      }
    }
    post({ phase: "done", metrics: { ...metrics } });
  }, DONE_MS);
})();
