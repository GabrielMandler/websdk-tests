/**
 * Runs all harness tests in hidden iframes and aggregates results on index.html.
 */
(function () {
  const HARNESS_TESTS = [
    { id: "simple", label: "Simple", path: "./simple-test.html", expectAf: true },
    {
      id: "old",
      label: "Old integration",
      path: "./old-test-integration.html",
      expectAf: true,
      /** Uses cdn …/wa-staging/testSdk.unmin.js (not manifestLoader); staging beacons may fail while script OK. */
      loader: "cdnTestSdk",
    },
    { id: "gtm", label: "GTM", path: "./gtm/index.html", expectAf: true },
    { id: "adobe1", label: "Adobe test 1", path: "./adobe/adobe-1.html", expectAf: false },
    { id: "adobe2", label: "Adobe test 2", path: "./adobe/adobe-2.html", expectAf: false },
    { id: "adobe3", label: "Adobe test 3", path: "./adobe/adobe-3.html", expectAf: false },
    {
      id: "csp-baseline",
      label: "CSP baseline",
      path: "./csp/case-baseline.html",
      expectAf: true,
    },
    {
      id: "csp-external",
      label: "CSP external-only",
      path: "./csp/case-external-only.html",
      expectAf: true,
    },
  ];

  const root = document.getElementById("harness-root");
  const summaryEl = document.getElementById("harness-summary");
  const tbody = document.getElementById("harness-tbody");
  const statusLine = document.getElementById("harness-status-line");

  if (!root || !tbody) return;

  const state = new Map();
  let messageListenerAttached = false;

  function formatNetworkProfile(p) {
    if (!p) return "";
    const parts = [];
    if (p.manifestJson2xx) parts.push("manifest.json");
    if (p.manifestSig2xx) parts.push(".sig");
    if (p.coverdomain2xx) parts.push("coverdomain");
    if (p.events2xx) parts.push(`events×${p.events2xx}`);
    return parts.join(" · ");
  }

  function latencyMsText(m) {
    if (m.firstEvents2xxMs != null) {
      return `${Math.round(m.firstEvents2xxMs)} ms`;
    }
    if (m.firstAf2xxMs != null) {
      return `${Math.round(m.firstAf2xxMs)} ms (any AF)`;
    }
    return "—";
  }

  function verdict(test, m) {
    /** Adobe pages: same bar as DevTools — manifestLoader + wa.appsflyersdk.com coverdomain & events must be HTTP 2xx. */
    if (test.id && String(test.id).startsWith("adobe")) {
      if (m.relativeManifestLoaderFailed) {
        return {
          pass: false,
          detail:
            "manifestLoader.v1.js did not return HTTP 2xx (e.g. 403 relative URL — use full https://websdk-stg.appsflyer.com/… in Launch)",
        };
      }
      if (m.manifestLoaderRequestSeen && !m.manifestLoaderHttp2xx) {
        return {
          pass: false,
          detail: "manifestLoader.v1.js did not return HTTP 2xx (check Network → manifestLoader row)",
        };
      }
      const p = m.networkProfile || {};
      const hasCore = p.coverdomain2xx && p.events2xx >= 1;
      const hasFull =
        p.manifestJson2xx &&
        p.manifestSig2xx &&
        p.coverdomain2xx &&
        p.events2xx >= 1;
      if (hasFull || hasCore) {
        return {
          pass: true,
          detail: `Network OK: ${formatNetworkProfile(p)}`,
        };
      }
      return {
        pass: false,
        detail:
          "AppsFlyer Web SDK traffic missing HTTP 2xx: need coverdomain + events on wa.appsflyersdk.com (manifest JSON/.sig when not served from cache).",
      };
    }

    if (!test.expectAf) {
      if (m.relativeManifestLoaderFailed) {
        return {
          pass: false,
          detail:
            "manifestLoader.v1.js returned 4xx (relative URL on this origin — set full https://websdk-stg.appsflyer.com/… URL in Adobe Launch)",
        };
      }
      const loaded = m && typeof m.path === "string";
      return {
        pass: loaded,
        detail: loaded ? "Page completed (no AppsFlyer assertion)" : "No data",
      };
    }
    if (!m.afSdk) {
      return { pass: false, detail: "AF stub/SDK not detected" };
    }

    /** CDN testSdk page: script can 2xx while /message ping fails — any AF-tracked failure fails the row. */
    if (test.id === "old" && m.afFailCount > 0) {
      return {
        pass: false,
        detail:
          "AppsFlyer staging traffic failed (e.g. /message ping net::ERR_*). SDK script may still show 200.",
      };
    }

    const p = m.networkProfile || {};
    const fullChain =
      p.manifestJson2xx &&
      p.manifestSig2xx &&
      p.coverdomain2xx &&
      p.events2xx >= 1;
    const coreSdkTraffic = p.coverdomain2xx && p.events2xx >= 1;

    if (fullChain) {
      return {
        pass: true,
        detail: `Network OK: ${formatNetworkProfile(p)}`,
      };
    }
    if (coreSdkTraffic) {
      return {
        pass: true,
        detail: `Network OK: ${formatNetworkProfile(p)} (manifest may be cache-only)`,
      };
    }
    if (m.firstAf2xxMs != null && m.af2xxCount > 0) {
      return {
        pass: true,
        detail: `Alternate loader: ${m.af2xxCount}× AF 2xx; ${formatNetworkProfile(p) || "no manifest/coverdomain/events match"}`,
      };
    }
    if (m.afFailCount > 0 && m.af2xxCount === 0) {
      return { pass: false, detail: "SDK present; AF requests failed or non-2xx" };
    }
    return {
      pass: false,
      detail: `No healthy chain (${formatNetworkProfile(p) || "no mft/cov/events"}); check DNS / staging`,
    };
  }

  function rowTemplate(test) {
    return `
      <tr data-harness-id="${test.id}">
        <td>${escapeHtml(test.label)}</td>
        <td class="harness-cell-status"><span class="harness-pill harness-pending">…</span></td>
        <td class="harness-sdk">—</td>
        <td class="harness-lat">—</td>
        <td class="harness-detail muted">Waiting…</td>
      </tr>
    `;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setRow(testId, { status, sdkText, latText, detail, pillClass }) {
    const tr = tbody.querySelector(`tr[data-harness-id="${testId}"]`);
    if (!tr) return;
    const pill = tr.querySelector(".harness-pill");
    if (pill) {
      pill.textContent = status;
      pill.className = `harness-pill ${pillClass || ""}`;
    }
    const sdk = tr.querySelector(".harness-sdk");
    if (sdk) sdk.textContent = sdkText;
    const lat = tr.querySelector(".harness-lat");
    if (lat) lat.textContent = latText;
    const det = tr.querySelector(".harness-detail");
    if (det) {
      det.textContent = detail;
      det.className = "harness-detail" + (pillClass === "harness-fail" ? " harness-err" : "");
    }
  }

  function updateSummary() {
    let pass = 0;
    let fail = 0;
    let pending = 0;
    for (const t of HARNESS_TESTS) {
      const s = state.get(t.id);
      if (!s || s.running) pending += 1;
      else if (s.pass) pass += 1;
      else fail += 1;
    }
    if (summaryEl) {
      summaryEl.textContent = `${pass} passed, ${fail} failed, ${pending} pending`;
    }
  }

  function onMessage(ev) {
    if (ev.origin !== window.location.origin) return;
    const d = ev.data;
    if (!d || d.source !== "websdk-harness") return;
    const testId = d.testId;
    if (!testId) return;

    const test = HARNESS_TESTS.find((x) => x.id === testId);
    if (!test) return;

    const cur = state.get(testId) || { running: true };
    if (d.phase === "sdk" && d.metrics) {
      const m = d.metrics;
      const sdkMs = m.sdkReadyMs != null ? `${Math.round(m.sdkReadyMs)} ms` : "—";
      setRow(testId, {
        status: "Running",
        sdkText: m.afSdk ? sdkMs : "—",
        latText: latencyMsText(m),
        detail: "Collecting…",
        pillClass: "harness-run",
      });
    }
    if (d.phase === "af-network" && d.metrics) {
      const m = d.metrics;
      const sdkMs = m.afSdk && m.sdkReadyMs != null ? `${Math.round(m.sdkReadyMs)} ms` : "—";
      const prof = formatNetworkProfile(m.networkProfile);
      let detail = prof
        ? `${prof} · ok ${m.af2xxCount}/${m.afFailCount} fail`
        : `AF ok: ${m.af2xxCount}, fail: ${m.afFailCount}`;
      if (m.relativeManifestLoaderFailed) {
        detail = "manifestLoader.v1.js failed (4xx) — will fail";
      }
      setRow(testId, {
        status: "Running",
        sdkText: sdkMs,
        latText: latencyMsText(m),
        detail,
        pillClass: "harness-run",
      });
    }
    if (d.phase === "done" && d.metrics) {
      const m = d.metrics;
      cur.running = false;
      cur.metrics = m;
      const v = verdict(test, m);
      cur.pass = v.pass;
      state.set(testId, cur);

      const sdkMs = m.afSdk && m.sdkReadyMs != null ? `${Math.round(m.sdkReadyMs)} ms` : "—";
      setRow(testId, {
        status: v.pass ? "Pass" : "Fail",
        sdkText: sdkMs,
        latText: latencyMsText(m),
        detail: v.detail,
        pillClass: v.pass ? "harness-pass" : "harness-fail",
      });
      updateSummary();
      if (statusLine) {
        const pend = [...state.values()].filter((x) => x.running).length;
        if (pend === 0) {
          statusLine.textContent = "All tests finished.";
        }
      }
    }
  }

  function run() {
    if (!messageListenerAttached) {
      window.addEventListener("message", onMessage);
      messageListenerAttached = true;
    }
    state.clear();
    tbody.innerHTML = HARNESS_TESTS.map((t) => rowTemplate(t)).join("");
    HARNESS_TESTS.forEach((t) => state.set(t.id, { running: true }));
    updateSummary();
    if (statusLine) {
      statusLine.textContent = "Running tests in hidden frames…";
    }

    const host = document.getElementById("harness-iframes");
    if (!host) return;
    host.innerHTML = "";

    HARNESS_TESTS.forEach((test, i) => {
      const sep = test.path.includes("?") ? "&" : "?";
      const src = `${test.path}${sep}harness=1&harnessId=${encodeURIComponent(test.id)}`;
      const iframe = document.createElement("iframe");
      iframe.setAttribute("title", `Harness: ${test.label}`);
      iframe.setAttribute("aria-hidden", "true");
      iframe.style.cssText =
        "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;border:0;left:-9999px;";
      iframe.src = src;
      host.appendChild(iframe);
      setRow(test.id, {
        status: "Running",
        sdkText: "—",
        latText: "—",
        detail: "Loading…",
        pillClass: "harness-run",
      });

      iframe.addEventListener("load", () => {
        setRow(test.id, {
          status: "Running",
          sdkText: "—",
          latText: "—",
          detail: "Loaded, waiting for SDK…",
          pillClass: "harness-run",
        });
      });

      setTimeout(() => {
        const s = state.get(test.id);
        if (!s || !s.running) return;
        s.running = false;
        s.pass = false;
        state.set(test.id, s);
        setRow(test.id, {
          status: "Fail",
          sdkText: "—",
          latText: "—",
          detail: "Timeout (no harness result — 404 or blocked frame?)",
          pillClass: "harness-fail",
        });
        updateSummary();
        if (statusLine) {
          const pend = [...state.values()].filter((x) => x.running).length;
          if (pend === 0) {
            statusLine.textContent = "All tests finished.";
          }
        }
      }, 20000);
    });

    updateSummary();
  }

  const btn = document.getElementById("harness-rerun");
  if (btn) {
    btn.addEventListener("click", run);
  }
  run();
})();
