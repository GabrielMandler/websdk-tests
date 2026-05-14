/**
 * Same-origin bootstrap for CSP "external scripts only" tests.
 * Keep in sync with inline bootstrap in index.html when changing IDs/plugins.
 */
(function () {
  "use strict";
  (function (t, e, n, s, a, c, i) {
    t.AppsFlyerSdkObject = a;
    t.AF =
      t.AF ||
      function () {
        (t.AF.q = t.AF.q || []).push(
          [Date.now()].concat(Array.prototype.slice.call(arguments))
        );
      };
    t.AF.id = t.AF.id || i;
    t.AF.plugins = {};
  })(window, document, "script", 0, "AF", "pba", {
    pba: {
      webAppId: "d588b909-9c27-46c6-be34-5a2415a4f6e8",
      measurementStatus: true,
    },
  });
  /* Banners: SDK touches cross-origin iframes → SecurityError in strict browsers / iframes. Opt-in: ?banners=1 */
  var _afPlugins =
    new URLSearchParams(window.location.search).get("banners") === "1"
      ? ["pba", "banners"]
      : ["pba"];
  window.AF_LOADER_CONFIG = {
    baseUrl: "https://websdk-stg.appsflyer.com",
    plugins: _afPlugins,
    af_id: "d588b909-9c27-46c6-be34-5a2415a4f6e8",
    webAppId: "d588b909-9c27-46c6-be34-5a2415a4f6e8",
  };
})();
