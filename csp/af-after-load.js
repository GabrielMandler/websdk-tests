/**
 * Runs after AppsFlyer loader (same as small inline block in index.html).
 */
(function () {
  "use strict";
  if (typeof AF === "function") {
    AF("pba", "event", { eventType: "EVENT", eventName: "gabriel" });
  } else {
    console.error(
      "[AppsFlyer] AF is not defined — loader may be blocked by CSP or failed to load."
    );
  }
})();
