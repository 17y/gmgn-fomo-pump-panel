(function installGmgnFollowEventRelay() {
  "use strict";

  const RELAY_VERSION = "1.0.5";
  const MESSAGE_CHANNEL = "gmgn-follow-trade-event-v1";
  const RECONNECT_DELAYS_MS = Object.freeze([1_000, 2_000, 5_000]);
  const PLATFORM_IMAGE_SELECTOR = 'img[src*="gmgn-follow-source"]';
  const PLATFORM_STYLE_ID = "gmgn-follow-event-platform-style";
  const PLATFORM_HOST_ATTRIBUTE = "data-gmgn-follow-platform";
  const PLATFORM_MAKER_SELECTOR = '[data-testid="follow-tracking-row-maker"]';
  const PLATFORM_DECORATION_DELAYS_MS = Object.freeze([80, 250, 700, 1_400]);
  const FOMO_LOGO_URL = "https://fomo.family/logo.png";
  if (globalThis.__gmgnFollowEventRelayVersion === RELAY_VERSION) return;
  globalThis.__gmgnFollowEventRelayVersion = RELAY_VERSION;

  let port = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let active = true;
  const decorationTimers = new Map();
  const awaitingRender = new Map();
  const platformLogos = Object.freeze({
    fomo: FOMO_LOGO_URL,
    pump: chrome.runtime.getURL("assets/pump.svg"),
  });

  function validTradeMessage(message) {
    return ["gmgnFollowTradeEvent", "gmgnFollowTradeMetadata"].includes(message?.type)
      && message.item
      && typeof message.item === "object"
      && ["fomo", "pump"].includes(message.item.platform)
      && ["buy", "sell"].includes(message.item.type);
  }

  function tradeWithPlatformLogo(item) {
    const platformLogoUrl = platformLogos[item.platform] || "";
    return platformLogoUrl && !item.platformLogoUrl
      ? { ...item, platformLogoUrl }
      : item;
  }

  function markerValue(value, markerName) {
    let source = String(value || "");
    for (let decodeIndex = 0; decodeIndex < 3; decodeIndex += 1) {
      const match = new RegExp(`(?:#|&)${markerName}=([^&#]*)`).exec(source);
      if (match) {
        let decoded = match[1];
        for (let valueIndex = 0; valueIndex < 3; valueIndex += 1) {
          try {
            const next = decodeURIComponent(decoded);
            if (next === decoded) break;
            decoded = next;
          } catch {
            break;
          }
        }
        return decoded;
      }
      try {
        const next = decodeURIComponent(source);
        if (next === source) break;
        source = next;
      } catch {
        break;
      }
    }
    return "";
  }

  function imageMarkers(image) {
    const candidates = [image?.getAttribute?.("src"), image?.currentSrc, image?.src];
    for (const candidate of candidates) {
      const platform = markerValue(candidate, "gmgn-follow-source");
      if (!["fomo", "pump"].includes(platform)) continue;
      return {
        platform,
        displayName: markerValue(candidate, "gmgn-follow-name").trim(),
      };
    }
    return null;
  }

  function avatarHost(avatar) {
    const parent = avatar?.parentElement;
    return parent?.tagName === "PICTURE" ? parent.parentElement : parent;
  }

  function nameText(value) {
    return String(value || "")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^@/, "");
  }

  function matchesDisplayName(value, expected) {
    const actual = nameText(value);
    if (actual === expected) return true;
    const truncated = actual.replace(/(?:\.{3}|…)$/, "").trimEnd();
    return Boolean(truncated) && truncated !== actual && expected.startsWith(truncated);
  }

  function childElements(root, limit = 128) {
    const result = [];
    const pending = [...(root?.children || [])].reverse();
    while (pending.length && result.length < limit) {
      const element = pending.pop();
      result.push(element);
      pending.push(...[...(element?.children || [])].reverse());
    }
    return result;
  }

  function platformNameHost(imageHost, displayName) {
    const expected = nameText(displayName);
    if (!imageHost || !expected || typeof document !== "object") return null;
    let root = imageHost.parentElement;
    for (let depth = 0; root && depth < 6; depth += 1, root = root.parentElement) {
      if (root === document.body || root === document.documentElement) break;
      const candidates = childElements(root).filter((element) => {
        if (element === imageHost || element.contains?.(imageHost)) return false;
        if (!matchesDisplayName(element.textContent, expected)) return false;
        return ![...(element.children || [])]
          .some((child) => matchesDisplayName(child.textContent, expected));
      });
      if (!candidates.length) continue;
      if (candidates.length === 1 || typeof imageHost.getBoundingClientRect !== "function") {
        return candidates[0];
      }
      const imageRect = imageHost.getBoundingClientRect();
      return candidates.sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        const distance = (rect) => Math.abs(rect.y - imageRect.y)
          + Math.max(0, imageRect.x - rect.x);
        return distance(leftRect) - distance(rightRect);
      })[0];
    }
    return null;
  }

  function ensurePlatformStyle() {
    if (typeof document !== "object" || document.getElementById(PLATFORM_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = PLATFORM_STYLE_ID;
    // Hover replaces GMGN's maker children. Match the source in the avatar URL
    // so the badge survives that render without decorating the new name node.
    const makerSelector = (platform) => `${PLATFORM_MAKER_SELECTOR}:has(${[
      "=", "%3D", "%253D", "%25253D",
    ].map((separator) => `img[src*="gmgn-follow-source${separator}${platform}" i]`).join(", ")})`;
    const legacySelector = (platform) =>
      `[${PLATFORM_HOST_ATTRIBUTE}${platform ? `="${platform}"` : ""}]:not(${PLATFORM_MAKER_SELECTOR} *)`;
    const fomoMaker = makerSelector("fomo");
    const pumpMaker = makerSelector("pump");
    style.textContent = `
      ${legacySelector()}::after, ${fomoMaker}::after, ${pumpMaker}::after {
        content: "";
        display: inline-block;
        width: 16px;
        height: 16px;
        margin-left: 4px;
        border-radius: 3px;
        background-position: center;
        background-repeat: no-repeat;
        background-size: contain;
        vertical-align: -3px;
        pointer-events: none;
      }
      ${fomoMaker}::after, ${pumpMaker}::after {
        flex: 0 0 16px;
      }
      ${legacySelector("fomo")}::after, ${fomoMaker}::after {
        background-image: url("${platformLogos.fomo}");
        border-radius: 50%;
      }
      ${legacySelector("pump")}::after, ${pumpMaker}::after {
        background-image: url("${platformLogos.pump}");
      }
    `;
    document.documentElement.append(style);
  }

  function decoratePlatformRows() {
    if (typeof document !== "object" || document.visibilityState === "hidden") return;
    const images = document.querySelectorAll?.(PLATFORM_IMAGE_SELECTOR) || [];
    if (!images.length) return;
    ensurePlatformStyle();
    for (const image of images) {
      // A positive observation only: virtualized/hidden rows remain unverified.
      const deliveryId = [image.getAttribute?.("src"), image.currentSrc, image.src]
        .map((value) => markerValue(value, "gmgn-follow-delivery")).find(Boolean);
      if (deliveryId && awaitingRender.has(deliveryId) && image.closest?.(PLATFORM_MAKER_SELECTOR) && image.isConnected
        && image.getClientRects?.().length > 0) {
        awaitingRender.delete(deliveryId);
        window.postMessage({ channel: MESSAGE_CHANNEL, type: "trade-rendered", deliveryId }, location.origin);
      }
      if (image.closest?.(PLATFORM_MAKER_SELECTOR)) continue;
      const markers = imageMarkers(image);
      const nameHost = markers
        ? platformNameHost(avatarHost(image), markers.displayName)
        : null;
      if (nameHost) nameHost.setAttribute(PLATFORM_HOST_ATTRIBUTE, markers.platform);
    }
  }

  function schedulePlatformDecorations() {
    for (const [id, expiresAt] of awaitingRender) if (Date.now() >= expiresAt) awaitingRender.delete(id);
    if (typeof document !== "object") return;
    for (const delay of PLATFORM_DECORATION_DELAYS_MS) {
      if (decorationTimers.has(delay)) continue;
      const timer = setTimeout(() => {
        decorationTimers.delete(delay);
        if (active) decoratePlatformRows();
      }, delay);
      decorationTimers.set(delay, timer);
    }
  }

  function relayTrade(message) {
    if (active && ["gmgnFollowTradeReset", "gmgnFollowTradeCancel"].includes(message?.type)) {
      if (message.type === "gmgnFollowTradeReset") awaitingRender.clear();
      else awaitingRender.delete(message.deliveryId);
      window.postMessage({ channel: MESSAGE_CHANNEL,
        type: message.type === "gmgnFollowTradeReset" ? "trade-reset" : "trade-cancel",
        deliveryId: message.deliveryId }, location.origin);
      return;
    }
    if (active && message?.type === "gmgnRecentTrades"
      && typeof message.requestId === "string" && Array.isArray(message.items)) {
      window.postMessage({
        channel: MESSAGE_CHANNEL,
        type: "recent-trades",
        requestId: message.requestId,
        items: message.items.slice(0, 30).map(tradeWithPlatformLogo),
      }, location.origin);
      if (message.items.length) schedulePlatformDecorations();
      return;
    }
    if (!active || !validTradeMessage(message)) return;
    if (typeof message.deliveryId === "string" && message.deliveryId.length <= 100) {
      awaitingRender.set(message.deliveryId, Date.now() + 5_000);
      while (awaitingRender.size > 128) awaitingRender.delete(awaitingRender.keys().next().value);
    }
    const item = tradeWithPlatformLogo(message.item);
    window.postMessage({
      channel: MESSAGE_CHANNEL,
      type: message.type === "gmgnFollowTradeMetadata" ? "trade-metadata" : "trade",
      item,
      deliveryId: message.deliveryId,
    }, location.origin);
    schedulePlatformDecorations();
  }

  function scheduleReconnect() {
    if (!active || reconnectTimer !== null
      || reconnectAttempt >= RECONNECT_DELAYS_MS.length) return;
    const delay = RECONNECT_DELAYS_MS[reconnectAttempt];
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (!active || port) return;
    try {
      const current = chrome.runtime.connect({ name: "gmgnFollowTradeEvents" });
      port = current;
      current.onMessage.addListener(relayTrade);
      reportVisibility();
      current.onDisconnect.addListener(() => {
        if (port !== current) return;
        port = null;
        scheduleReconnect();
      });
      reconnectAttempt = 0;
    } catch {
      active = false;
    }
  }

  function reportVisibility() {
    if (!active || !port) return;
    try { port.postMessage({ type: "gmgnFollowTradeVisibility", visible: document.visibilityState !== "hidden" }); } catch {}
  }
  if (typeof document === "object") document.addEventListener?.("visibilitychange", reportVisibility);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "gmgnFollowTradeRelayPing") return false;
    sendResponse({ ok: true, mode: "event-only", version: RELAY_VERSION });
    return false;
  });

  window.addEventListener("message", (event) => {
    if (active && event.source === window && event.origin === location.origin
      && event.data?.channel === MESSAGE_CHANNEL && event.data?.type === "request-render-check"
      && awaitingRender.has(event.data.deliveryId)) {
      schedulePlatformDecorations();
      return;
    }
    if (active && port && event.source === window && event.origin === location.origin
      && event.data?.channel === MESSAGE_CHANNEL && event.data?.type === "trade-ack"
      && typeof event.data.deliveryId === "string" && event.data.deliveryId.length <= 100
      && ["submitted", "decoded", "accepted", "unverified", "expired", "invalid", "unavailable", "overflow"].includes(event.data.status)) {
      try { port.postMessage({ type: "gmgnFollowTradeAck",
        deliveryId: event.data.deliveryId, status: event.data.status,
        reason: ["NATIVE_SOCKET_MISSING", "NATIVE_STREAM_UNOBSERVED", "NATIVE_STREAM_ERROR",
          "CHAIN_NOT_SUBSCRIBED", "NATIVE_HANDLE_DATA_THROW", "ROW_RENDERED",
          "NATIVE_ROW_NOT_OBSERVED", "NATIVE_DECODED_ROW_NOT_OBSERVED"].includes(event.data.reason) ? event.data.reason : "",
        routeChain: ["eth", "bsc", "sol", "base", "robinhood", "hyperevm", "arc"].includes(event.data.routeChain) ? event.data.routeChain : "",
      }); } catch {}
      return;
    }
    if (!active || !port || event.source !== window || event.origin !== location.origin
      || event.data?.channel !== MESSAGE_CHANNEL || event.data?.type !== "request-recent-trades"
      || typeof event.data.requestId !== "string" || event.data.requestId.length > 80
      || !Array.isArray(event.data.chains) || event.data.chains.length > 16) return;
    try {
      port.postMessage({
        type: "getGmgnRecentTrades",
        requestId: event.data.requestId,
        chains: event.data.chains,
      });
    } catch {}
  });

  connect();
})();
