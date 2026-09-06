(function installFomoPanelLoader() {
  "use strict";

  const version = chrome.runtime.getManifest().version;
  if (globalThis.__gmgnFomoPanelLoader?.version === version) return;
  globalThis.__gmgnFomoPanelLoader?.dispose();
  let active = true;
  let loading = false;
  let rerun = false;

  function dispose() {
    active = false;
    window.removeEventListener("popstate", maybeLoad);
    window.navigation?.removeEventListener?.("navigatesuccess", maybeLoad);
    document.removeEventListener("visibilitychange", onVisibility);
    chrome.runtime.onMessage.removeListener(onMessage);
  }

  async function maybeLoad() {
    if (!active || document.visibilityState !== "visible"
      || !globalThis.GmgnFomoCore?.parseTokenRoute(location.pathname)) return;
    if (loading) {
      rerun = true;
      return;
    }
    loading = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: "ensureFomoOverlay" });
      // The panel takes over route and visibility events after its one-time load.
      if (result?.ok && result.loaded) dispose();
    } catch {
      // Retry only on a real navigation, tab visibility or side-panel event.
    } finally {
      loading = false;
      if (rerun) {
        rerun = false;
        maybeLoad();
      }
    }
  }

  function onVisibility(event) {
    if (event.isTrusted) maybeLoad();
  }

  function onMessage(message) {
    if (message?.type === "sidePanelVisibilityChanged" && !message.visible) maybeLoad();
    return false;
  }

  globalThis.__gmgnFomoPanelLoader = { version, dispose };
  window.addEventListener("popstate", maybeLoad);
  window.navigation?.addEventListener?.("navigatesuccess", maybeLoad);
  document.addEventListener("visibilitychange", onVisibility);
  chrome.runtime.onMessage.addListener(onMessage);
  maybeLoad();
})();
