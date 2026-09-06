(() => {
  "use strict";

  if (globalThis.__gmgnFomoAlertTopicRelay === "1.0.0") return;
  globalThis.__gmgnFomoAlertTopicRelay = "1.0.0";

  document.addEventListener("gmgn-fomo-alert-topic", (event) => {
    const userId = typeof event.detail === "string" ? event.detail.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return;
    chrome.runtime.sendMessage({ type: "recordFomoAlertTopic", userId }).catch(() => {});
  });
})();
