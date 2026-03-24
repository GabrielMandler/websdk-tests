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
      webAppId: "04fe1c0e-a88e-417c-908f-8cd8d53cdb3f",
      measurementStatus: true,
    },
  });
  window.AF_LOADER_CONFIG = {
    baseUrl: "https://websdk-stg.appsflyer.com",
    plugins: ["pba", "banners"],
    af_id: "04fe1c0e-a88e-417c-908f-8cd8d53cdb3f",
    webAppId: "04fe1c0e-a88e-417c-908f-8cd8d53cdb3f",
  };
})();
