/**
 * Datadog-oriented SDK performance metrics using the Performance API (Resource Timing, marks).
 * Exposes window.ddSdkMetrics with markSdkReady() and DOM sync to #dd-sdk-metrics.
 */
(function () {
  "use strict";

  var NAV = performance.getEntriesByType("navigation")[0];

  function navStartMs() {
    return NAV ? NAV.startTime : 0;
  }

  function markWithTime(name, startTimeMs) {
    try {
      if (typeof performance.mark === "function") {
        try {
          performance.mark(name, { startTime: startTimeMs });
        } catch (_e) {
          performance.mark(name);
        }
      }
    } catch (_err) {
      /* ignore */
    }
  }

  function defaultSdkScriptMatch(url) {
    try {
      var u = new URL(url, location.href);
      return /websdk\.appsflyersdk\.com$/i.test(u.hostname);
    } catch (_e) {
      return /websdk\.appsflyersdk\.com/i.test(String(url));
    }
  }

  /** Default: first coverdomain or wa.* /events request (AppsFlyer Web SDK). */
  function defaultFirstRequestMatch(url) {
    try {
      var u = new URL(url, location.href);
      var hay = (u.pathname + u.search).toLowerCase();
      if (/coverdomain/i.test(hay)) return true;
      if (/appsflyersdk\.com$/i.test(u.hostname)) {
        var p = u.pathname.toLowerCase();
        if (/\/events(\?|$)/.test(p) || p.endsWith("/events")) return true;
      }
      return false;
    } catch (_e) {
      return false;
    }
  }

  function parseOptions() {
    var g = window.__DD_SDK_METRICS__ || {};
    var first =
      typeof g.firstRequestMatch === "function"
        ? g.firstRequestMatch
        : typeof g.firstRequestPattern === "string"
          ? function (url) {
              try {
                return new RegExp(g.firstRequestPattern, "i").test(String(url));
              } catch (_e) {
                return defaultFirstRequestMatch(url);
              }
            }
          : defaultFirstRequestMatch;
    var sdkScript =
      typeof g.sdkScriptMatch === "function"
        ? g.sdkScriptMatch
        : typeof g.sdkScriptPattern === "string"
          ? function (url) {
              try {
                return new RegExp(g.sdkScriptPattern, "i").test(String(url));
              } catch (_e) {
                return defaultSdkScriptMatch(url);
              }
            }
          : defaultSdkScriptMatch;
    var sdkBundle =
      typeof g.sdkBundleMatch === "function"
        ? g.sdkBundleMatch
        : typeof g.sdkBundlePattern === "string"
          ? function (url) {
              try {
                return new RegExp(g.sdkBundlePattern, "i").test(String(url));
              } catch (_e) {
                return false;
              }
            }
          : null;
    var ft = g.finalizeTimeoutMs;
    var finalizeTimeoutMs =
      typeof ft === "number" && Number.isFinite(ft)
        ? Math.min(120000, Math.max(5000, ft))
        : 30000;

    return {
      firstRequestMatch: first,
      sdkScriptMatch: sdkScript,
      sdkBundleMatch: sdkBundle,
      finalizeTimeoutMs: finalizeTimeoutMs,
    };
  }

  function shortUrlLabel(url) {
    if (!url) return "";
    try {
      var u = new URL(url, location.href);
      var name = u.pathname.split("/").pop() || u.pathname;
      return name + (u.search ? u.search.slice(0, 30) : "");
    } catch (_e) {
      return String(url).slice(0, 60);
    }
  }

  function roundMs(t) {
    if (t == null || Number.isNaN(t)) return null;
    return Math.round(t);
  }

  function DdSdkMetricsCollector() {
    this.opts = parseOptions();
    this._pageStartMarked = false;
    this._cdnDone = false;
    this._sdkBundleDone = false;
    this._sdkReadyDone = false;
    this._firstReqDone = false;
    this._firstResponse200Done = false;
    this._finalized = false;

    this.cdnFetchMs = null;
    this.cdnFetchUrl = null;
    this.cdnReason = null;
    this.sdkBundleFetchMs = null;
    this.sdkBundleUrl = null;
    this.sdkBundleReason = null;
    this.sdkReadyMs = null;
    this.sdkReadyReason = null;
    this.firstRequestStartMs = null;
    this.firstResponse200Ms = null;
    this.firstRequestTtfbMs = null;
    this.firstRequestDownloadMs = null;
    this.firstRequestTotalMs = null;
    this.firstRequestUrl = null;
    this.firstRequestTransferSize = null;
    this.firstRequestInitiatorType = null;
    this.firstRequestResponseStatus = null;
    this.firstRequestReason = null;
    /** "full" | "partial_no_tao" — TTFB/download may be omitted without TAO. */
    this.firstRequestTimingDetail = "full";
    this.response200Reason = null;

    /** @type {Record<string, number>} normalized URL -> HTTP status from fetch/xhr */
    this._statusHintsByUrl = {};

    this._initPageStart();
    this._scanBufferedResources();
    this._setupObserver();
    this._wrapFetchForStatus();
    this._wrapXhrForStatus();
    this._scheduleFinalize();
    this._syncDom();
    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        function () {
          this._syncDom();
        }.bind(this)
      );
    }
  }

  DdSdkMetricsCollector.prototype._scheduleFinalize = function () {
    var self = this;
    var FINAL_MS = this.opts.finalizeTimeoutMs;
    setTimeout(function () {
      if (self._finalized) return;
      self._finalized = true;
      if (!self._cdnDone) {
        if (!self.cdnReason) {
          self.cdnReason =
            "no script resource matched SDK CDN URL pattern (websdk.appsflyersdk.com)";
        }
      }
      if (self.opts.sdkBundleMatch && !self._sdkBundleDone) {
        if (!self.sdkBundleReason) {
          self.sdkBundleReason =
            "no script resource matched SDK bundle pattern within timeout";
        }
      }
      if (!self._firstReqDone) {
        if (!self.firstRequestReason) {
          self.firstRequestReason =
            "no matching fetch/xhr/beacon resource within timeout (adjust __DD_SDK_METRICS__.firstRequestMatch)";
        }
      }
      if (!self._sdkReadyDone) {
        self.sdkReadyReason =
          "SDK not reported ready (AF global missing; call markSdkReady() or load SDK)";
      }
      self._syncDom();
    }, FINAL_MS);
  };

  DdSdkMetricsCollector.prototype._initPageStart = function () {
    if (this._pageStartMarked) return;
    this._pageStartMarked = true;
    markWithTime("page_start", performance.now());
  };

  DdSdkMetricsCollector.prototype._isRelevantInitiator = function (it) {
    return (
      it === "fetch" ||
      it === "xmlhttprequest" ||
      it === "beacon" ||
      it === "ping"
    );
  };

  DdSdkMetricsCollector.prototype._processSdkScript = function (e) {
    if (this._cdnDone) return;
    if (e.initiatorType !== "script") return;
    if (!this.opts.sdkScriptMatch(e.name)) return;
    this._cdnDone = true;
    this.cdnFetchUrl = e.name;
    var re = e.responseEnd;
    this.cdnFetchMs = roundMs(re);
    if (this.cdnFetchMs == null) {
      this.cdnReason = "resource missing responseEnd";
      return;
    }
    markWithTime("sdk_cdn_fetch_done", re);
    try {
      performance.measure("sdk_cdn_fetch", {
        start: navStartMs(),
        end: re,
      });
    } catch (_err) {
      /* ignore */
    }
    this._syncDom();
  };

  DdSdkMetricsCollector.prototype._processSdkBundle = function (e) {
    if (!this.opts.sdkBundleMatch) return;
    if (this._sdkBundleDone) return;
    if (e.initiatorType !== "script") return;
    if (!this.opts.sdkBundleMatch(e.name)) return;
    this._sdkBundleDone = true;
    this.sdkBundleUrl = e.name;
    var re = e.responseEnd;
    this.sdkBundleFetchMs = roundMs(re);
    if (this.sdkBundleFetchMs == null) {
      this.sdkBundleReason = "resource missing responseEnd";
      return;
    }
    markWithTime("sdk_bundle_fetch_done", re);
    try {
      performance.measure("sdk_bundle_fetch", {
        start: navStartMs(),
        end: re,
      });
    } catch (_err) {
      /* ignore */
    }
    this._syncDom();
  };

  DdSdkMetricsCollector.prototype._statusFromEntry = function (e) {
    var rs = e.responseStatus;
    if (typeof rs === "number" && rs > 0) return rs;
    return null;
  };

  DdSdkMetricsCollector.prototype._normUrl = function (url) {
    try {
      return new URL(url, location.href).href;
    } catch (_e) {
      return String(url);
    }
  };

  DdSdkMetricsCollector.prototype._hintStatusForUrl = function (url) {
    if (!url) return null;
    var k = this._normUrl(url);
    var v = this._statusHintsByUrl[k];
    return typeof v === "number" ? v : null;
  };

  DdSdkMetricsCollector.prototype._recordStatusHint = function (url, status) {
    if (!url) return;
    this._statusHintsByUrl[this._normUrl(url)] = status;
  };

  DdSdkMetricsCollector.prototype._captureFirstRequest = function (e) {
    if (this._firstReqDone) return;
    if (!this._isRelevantInitiator(e.initiatorType || "")) return;
    if (!this.opts.firstRequestMatch(e.name)) return;

    this._firstReqDone = true;
    var reqStart = e.requestStart;
    var resStart = e.responseStart;
    var resEnd = e.responseEnd;
    var st = e.startTime;

    this.firstRequestTimingDetail = "full";
    if (reqStart > 0) {
      this.firstRequestStartMs = roundMs(reqStart);
      this.firstRequestReason = null;
    } else if (st > 0) {
      this.firstRequestStartMs = roundMs(st);
      this.firstRequestReason =
        "requestStart not exposed (cross-origin); first-request-start-ms uses resource startTime (Performance API)";
      this.firstRequestTimingDetail = "partial_no_tao";
    } else {
      this.firstRequestStartMs = null;
      this.firstRequestReason =
        "requestStart and startTime not available for this resource";
    }

    this.firstRequestUrl = e.name;
    this.firstRequestTransferSize =
      e.transferSize != null ? e.transferSize : null;
    this.firstRequestInitiatorType = e.initiatorType || "";

    markWithTime("first_request_seen", reqStart > 0 ? reqStart : st);

    var ttfb = resStart - reqStart;
    var download = resEnd - resStart;
    if (reqStart > 0 && resStart > 0) {
      this.firstRequestTtfbMs = roundMs(ttfb);
    } else {
      this.firstRequestTtfbMs = null;
      if (reqStart <= 0 || resStart <= 0) {
        this.firstRequestTimingDetail = "partial_no_tao";
      }
    }
    if (resStart > 0 && resEnd > 0) {
      this.firstRequestDownloadMs = roundMs(download);
    } else {
      this.firstRequestDownloadMs = null;
      if (resStart <= 0 || resEnd <= 0) {
        this.firstRequestTimingDetail = "partial_no_tao";
      }
    }
    if (resEnd > 0) {
      this.firstRequestTotalMs = roundMs(resEnd - st);
    } else {
      this.firstRequestTotalMs = null;
    }

    var entryStatus = this._statusFromEntry(e);
    var hintStatus = this._hintStatusForUrl(e.name);
    var resolvedStatus = entryStatus != null ? entryStatus : hintStatus;
    this.firstRequestResponseStatus = resolvedStatus;

    if (resolvedStatus === 200) {
      this._firstResponse200Done = true;
      this.firstResponse200Ms = roundMs(resEnd);
      markWithTime("first_response_200", resEnd);
      try {
        performance.measure("first_sdk_request_200", {
          start: navStartMs(),
          end: resEnd,
        });
      } catch (_err) {
        /* ignore */
      }
      this.response200Reason = null;
    } else if (resolvedStatus != null) {
      this.response200Reason =
        "first request HTTP status was " +
        resolvedStatus +
        ", not 200";
      this.firstResponse200Ms = null;
    } else {
      this.response200Reason =
        "HTTP status not exposed (cross-origin without Timing-Allow-Origin); use fetch correlation";
      if (hintStatus === 200) {
        this._firstResponse200Done = true;
        this.firstResponse200Ms = roundMs(resEnd);
        markWithTime("first_response_200", resEnd);
        this.response200Reason = null;
      } else {
        this.firstResponse200Ms = null;
      }
    }

    this._applyHintToFirstRequest();
    this._syncDom();
  };

  DdSdkMetricsCollector.prototype._onResource = function (e) {
    if (e.entryType !== "resource") return;
    this._processSdkScript(e);
    this._processSdkBundle(e);
    this._captureFirstRequest(e);
  };

  DdSdkMetricsCollector.prototype._scanBufferedResources = function () {
    var list = performance.getEntriesByType("resource");
    var sorted = list.slice().sort(function (a, b) {
      return a.startTime - b.startTime;
    });
    for (var i = 0; i < sorted.length; i++) {
      this._onResource(sorted[i]);
    }
  };

  DdSdkMetricsCollector.prototype._setupObserver = function () {
    if (!("PerformanceObserver" in window)) {
      if (!this._cdnDone) {
        this.cdnReason = "PerformanceObserver not supported";
      }
      if (this.opts.sdkBundleMatch && !this._sdkBundleDone) {
        this.sdkBundleReason = "PerformanceObserver not supported";
      }
      if (!this._firstReqDone) {
        this.firstRequestReason = "PerformanceObserver not supported";
      }
      this._syncDom();
      return;
    }
    try {
      var obs = new PerformanceObserver(
        function (list) {
          var entries = list.getEntries();
          for (var i = 0; i < entries.length; i++) {
            this._onResource(entries[i]);
          }
        }.bind(this)
      );
      obs.observe({ type: "resource", buffered: true });
    } catch (_err) {
      if (!this._cdnDone) {
        this.cdnReason = "PerformanceObserver resource observation failed";
      }
      this._syncDom();
    }
  };

  DdSdkMetricsCollector.prototype._wrapFetch = function () {
    var self = this;
    var orig = window.fetch;
    if (typeof orig !== "function") return;
    window.fetch = function () {
      var input = arguments[0];
      var url = "";
      if (typeof input === "string") url = input;
      else if (input instanceof URL) url = input.href;
      else if (input && typeof input.url === "string") url = input.url;
      return orig.apply(this, arguments).then(function (res) {
        if (url && self.opts.firstRequestMatch(url)) {
          self._recordStatusHint(url, res.status);
          self._applyHintToFirstRequest();
        }
        return res;
      });
    };
  };

  DdSdkMetricsCollector.prototype._applyHintToFirstRequest = function () {
    if (!this.firstRequestUrl) return;
    var st = this._hintStatusForUrl(this.firstRequestUrl);
    if (st == null) return;

    if (st !== 200) {
      if (this._firstResponse200Done) return;
      if (this.firstRequestResponseStatus === 200) return;
      if (
        this.firstRequestResponseStatus == null ||
        this.firstRequestResponseStatus === 0
      ) {
        this.firstRequestResponseStatus = st;
        this.response200Reason =
          "first request HTTP status was " + st + ", not 200 (from fetch/xhr)";
        this.firstResponse200Ms = null;
      }
      this._syncDom();
      return;
    }

    if (this._firstResponse200Done) return;

    this.firstRequestResponseStatus = 200;
    this._firstResponse200Done = true;
    this.response200Reason = null;
    var entries = performance.getEntriesByName(this.firstRequestUrl, "resource");
    var e = entries.length ? entries[entries.length - 1] : null;
    if (e && e.responseEnd > 0) {
      this.firstResponse200Ms = roundMs(e.responseEnd);
      markWithTime("first_response_200", e.responseEnd);
    }
    this._syncDom();
  };

  DdSdkMetricsCollector.prototype._wrapFetchForStatus = function () {
    this._wrapFetch();
  };

  DdSdkMetricsCollector.prototype._wrapXhrForStatus = function () {
    var self = this;
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__ddMetricsUrl = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      var url = xhr.__ddMetricsUrl;
      xhr.addEventListener("loadend", function () {
        if (!url || !self.opts.firstRequestMatch(url)) {
          return;
        }
        var st = xhr.status || 0;
        self._recordStatusHint(url, st);
        self._applyHintToFirstRequest();
      });
      return origSend.apply(this, arguments);
    };
  };

  DdSdkMetricsCollector.prototype.markSdkReady = function () {
    if (this._sdkReadyDone) return;
    this._sdkReadyDone = true;
    var t = performance.now();
    this.sdkReadyMs = roundMs(t);
    markWithTime("sdk_ready", t);
    try {
      performance.measure("sdk_ready_latency", {
        start: navStartMs(),
        end: t,
      });
    } catch (_err) {
      /* ignore */
    }
    this.sdkReadyReason = null;
    this._syncDom();
  };

  DdSdkMetricsCollector.prototype._overallStatus = function () {
    if (!this._finalized) {
      if (!this._cdnDone && !this.cdnReason) return "pending";
      if (!this._sdkReadyDone && !this.sdkReadyReason) return "pending";
      if (!this._firstReqDone && !this.firstRequestReason) return "pending";
    }

    if (this.cdnFetchMs == null && this.cdnReason) return "unavailable";
    if (this.sdkReadyMs == null && this.sdkReadyReason) return "unavailable";

    if (this._firstReqDone) {
      if (
        this.firstRequestResponseStatus != null &&
        this.firstRequestResponseStatus !== 200
      ) {
        return "fail";
      }
      if (this.firstResponse200Ms == null && this.response200Reason) {
        return "unavailable";
      }
    } else if (this.firstRequestReason) {
      return "unavailable";
    }

    var httpOk =
      this.firstRequestResponseStatus === 200 ||
      (this._firstResponse200Done && this.firstResponse200Ms != null);

    if (
      this.cdnFetchMs != null &&
      this.sdkReadyMs != null &&
      this.firstRequestStartMs != null &&
      this.firstResponse200Ms != null &&
      this.firstRequestTotalMs != null &&
      httpOk
    ) {
      return "pass";
    }

    return "unavailable";
  };

  DdSdkMetricsCollector.prototype._syncDom = function () {
    var root = document.getElementById("dd-sdk-metrics");
    if (!root) return;

    var status = this._overallStatus();

    function setData(name, value) {
      if (value == null || (typeof value === "number" && !Number.isFinite(value))) {
        root.removeAttribute("data-" + name);
        return;
      }
      if (
        value === "" &&
        /-reason$/.test(name)
      ) {
        root.removeAttribute("data-" + name);
        return;
      }
      root.setAttribute("data-" + name, String(value));
    }

    root.setAttribute("data-testid", "dd-sdk-metrics");
    setData("status", status);

    setData("cdn-fetch-ms", this.cdnFetchMs);
    setData("cdn-fetch-state", this.cdnFetchMs != null ? "ok" : "unavailable");
    setData("cdn-fetch-reason", this.cdnReason || "");
    setData("cdn-fetch-url", this.cdnFetchUrl || "");

    setData("sdk-bundle-fetch-ms", this.sdkBundleFetchMs);
    setData(
      "sdk-bundle-fetch-state",
      this.opts.sdkBundleMatch
        ? (this.sdkBundleFetchMs != null ? "ok" : "pending")
        : "n/a"
    );
    setData("sdk-bundle-fetch-reason", this.sdkBundleReason || "");
    setData("sdk-bundle-fetch-url", this.sdkBundleUrl || "");

    setData("sdk-ready-ms", this.sdkReadyMs);
    setData("sdk-ready-state", this.sdkReadyMs != null ? "ok" : "pending");
    setData("sdk-ready-reason", this.sdkReadyReason || "");

    setData("first-request-start-ms", this.firstRequestStartMs);
    setData("first-response-200-ms", this.firstResponse200Ms);
    setData("first-request-ttfb-ms", this.firstRequestTtfbMs);
    setData("first-request-download-ms", this.firstRequestDownloadMs);
    setData("first-request-total-ms", this.firstRequestTotalMs);
    setData("request-url", this.firstRequestUrl ? this.firstRequestUrl : "");
    setData("first-request-transfer-size", this.firstRequestTransferSize);
    setData("first-request-initiator-type", this.firstRequestInitiatorType || "");
    setData("first-request-response-status", this.firstRequestResponseStatus);

    setData("first-request-state", this._firstReqDone ? "ok" : "pending");
    setData("first-request-reason", this.firstRequestReason || "");
    setData("first-response-200-reason", this.response200Reason || "");
    setData(
      "first-request-timing-detail",
      this.firstRequestTimingDetail ? this.firstRequestTimingDetail : null
    );

    var summary = {
      status: status,
      cdn_fetch_ms: this.cdnFetchMs,
      cdn_fetch_url: this.cdnFetchUrl,
      sdk_bundle_fetch_ms: this.sdkBundleFetchMs,
      sdk_bundle_url: this.sdkBundleUrl,
      sdk_ready_ms: this.sdkReadyMs,
      first_request_start_ms: this.firstRequestStartMs,
      first_response_200_ms: this.firstResponse200Ms,
      first_request_ttfb_ms: this.firstRequestTtfbMs,
      first_request_download_ms: this.firstRequestDownloadMs,
      first_request_total_ms: this.firstRequestTotalMs,
      request_url: this.firstRequestUrl,
      first_request_timing_detail: this.firstRequestTimingDetail,
    };
    setData("metrics-json", JSON.stringify(summary));

    var pill = document.getElementById("dd-metrics-status-pill");
    if (pill) {
      pill.textContent = status;
      pill.setAttribute("data-testid", "dd-sdk-metrics-status-pill");
      pill.className = "meta-pill dd-metrics-pill dd-metrics-pill--" + status;
    }

    this._renderHumanTable();
  };

  DdSdkMetricsCollector.prototype._renderHumanTable = function () {
    var tbody = document.getElementById("dd-sdk-metrics-tbody");
    if (!tbody) return;

    function cell(label, value, sub) {
      return (
        '<tr data-testid="dd-sdk-metrics-row-' +
        label +
        '">' +
        '<th scope="row">' +
        label +
        "</th>" +
        "<td>" +
        (value != null ? value : "—") +
        (sub
          ? '<span class="metric-sub" data-testid="dd-sdk-metrics-sub-' +
            label +
            '">' +
            sub +
            "</span>"
          : "") +
        "</td></tr>"
      );
    }

    var st = this._overallStatus();
    var statusNote =
      st === "pass"
        ? ""
        : st === "pending"
          ? " (loading)"
          : st === "fail"
            ? " (check HTTP status)"
            : " (see reasons on #dd-sdk-metrics data attributes)";

    var cdnSub = this.cdnReason
      ? " " + this.cdnReason
      : this.cdnFetchUrl
        ? " " + shortUrlLabel(this.cdnFetchUrl)
        : "";
    var bundleSub = !this.opts.sdkBundleMatch
      ? " not applicable (single-script SDK)"
      : this.sdkBundleReason
        ? " " + this.sdkBundleReason
        : this.sdkBundleUrl
          ? " " + shortUrlLabel(this.sdkBundleUrl)
          : "";
    var sdkReadySub = this.sdkReadyReason
      ? " " + this.sdkReadyReason
      : this.sdkReadyMs != null
        ? " real SDK initialized"
        : "";
    var reqStartSub = this.firstRequestReason
      ? " " + this.firstRequestReason
      : this.firstRequestUrl
        ? " " + shortUrlLabel(this.firstRequestUrl)
        : "";
    var resp200Sub = this.response200Reason
      ? " " + this.response200Reason
      : this.firstRequestUrl
        ? " " + shortUrlLabel(this.firstRequestUrl)
        : "";

    tbody.innerHTML =
      cell("Status", st + statusNote, "") +
      cell(
        "CDN fetch",
        this.cdnFetchMs != null ? this.cdnFetchMs + " ms" : null,
        cdnSub
      ) +
      cell(
        "SDK bundle fetch",
        this.opts.sdkBundleMatch
          ? (this.sdkBundleFetchMs != null ? this.sdkBundleFetchMs + " ms" : null)
          : "N/A",
        bundleSub
      ) +
      cell(
        "SDK ready",
        this.sdkReadyMs != null ? this.sdkReadyMs + " ms" : null,
        sdkReadySub
      ) +
      cell(
        "Request start",
        this.firstRequestStartMs != null ? this.firstRequestStartMs + " ms" : null,
        reqStartSub
      ) +
      cell(
        "Timing detail",
        this.firstRequestTimingDetail || "—",
        ""
      ) +
      cell("TTFB", this.firstRequestTtfbMs != null ? this.firstRequestTtfbMs + " ms" : null,
        this.firstRequestTimingDetail === "partial_no_tao" && this.firstRequestTtfbMs == null
          ? " not exposed without Timing-Allow-Origin"
          : ""
      ) +
      cell(
        "Download",
        this.firstRequestDownloadMs != null ? this.firstRequestDownloadMs + " ms" : null,
        this.firstRequestTimingDetail === "partial_no_tao" && this.firstRequestDownloadMs == null
          ? " not exposed without Timing-Allow-Origin"
          : ""
      ) +
      cell(
        "Total",
        this.firstRequestTotalMs != null ? this.firstRequestTotalMs + " ms" : null,
        ""
      ) +
      cell(
        "First response 200",
        this.firstResponse200Ms != null ? this.firstResponse200Ms + " ms" : null,
        resp200Sub
      );
  };

  window.DdSdkMetricsCollector = DdSdkMetricsCollector;
  window.ddSdkMetrics = new DdSdkMetricsCollector();
})();
