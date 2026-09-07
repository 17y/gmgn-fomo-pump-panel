importScripts("runtime-config.js", "core.js", "fomo-api.js", "pump-api.js", "trade-identity.js", "follow-trades.js", "evm-holder-resolver.js", "trade-delivery.js", "trade-receipts.js");

const SESSION_KEY = "fomoApiSessionV1";
const TOKEN_CACHE_KEY = "fomoTokenCacheV1";
const FOLLOWED_TRADES_ENABLED_KEY = "followedTradesEnabledV1";
const LOCAL_DIAGNOSTICS_AVAILABLE = globalThis.GmgnRuntimeConfig?.localDiagnostics === true;
const FOLLOWED_TRADES_DIAGNOSTICS_ENABLED_KEY = "followedTradesDiagnosticsEnabledV1";
const FOLLOWED_TRADES_DIAGNOSTIC_KEY = "followedTradesDiagnosticV1";
const FOLLOWED_TRADES_PIPELINE_KEY = "followedTradesPipelineV1";
const TRADE_RECEIPTS_KEY = "followedTradeReceiptsV1";
const FOLLOWED_TRADES_STORAGE_KEY = "followedTradesCacheV1";
const PUMP_IDENTITY_KEY = "pumpViewerIdentityV1";
const TOKEN_CACHE_INDEX_KEY = "fomoTokenCacheIndexV2";
const TOKEN_CACHE_ENTRY_PREFIX = "fomoTokenCacheEntryV2:";
const TOKEN_CACHE_LIMIT = 50;
const TOKEN_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_SUPPORTED_CHAINS = "1,56,143,4663,8453,1399811149";
const FOMO_PAGE_ORIGIN = "https://fomo.family";
const FOMO_PAGE_URL = `${FOMO_PAGE_ORIGIN}/token`;
const PUMP_API_ORIGIN = "https://frontend-api-v3.pump.fun";
const PUMP_PRESENCE_URL = `${PUMP_API_ORIGIN}/following-positions/alerts/presence`;
const PUMP_PRESENCE_ORIGIN_RULE_ID = 5101;
const PUMP_NATS_CONFIG_URL = "https://pump.fun/?tab=friends";
const SESSION_REFRESH_TIMEOUT_MS = 15_000;
const SESSION_REFRESH_POLL_MS = 250;
const FOMO_REQUEST_TIMEOUT_MS = 10_000;
const FOMO_SHARED_REQUEST_MAX_AGE_MS = FOMO_REQUEST_TIMEOUT_MS + 2_000;
const FOMO_FEED_INITIAL_WAIT_MS = 750;
const FOMO_FOLLOWED_TIMEOUT_MS = 10_000;
const FOMO_FOLLOWED_METADATA_CACHE_MS = 60_000;
const FOMO_ALERT_WS_URL = "wss://prod-api.fomo.family/ws";
const FOMO_ALERT_TOPIC_TYPE = "trading_activity";
const FOMO_ALERT_REST_CACHE_MS = 30_000;
const FOMO_ALERT_RECONCILE_MS = 60_000;
const FOMO_ALERT_RECONNECT_MIN_MS = 1_000;
const FOMO_ALERT_RECONNECT_MAX_MS = 30_000;
const FOMO_ALERT_TOPIC_CAPTURE_COOLDOWN_MS = 5 * 60_000;
const FOMO_FOLLOWED_TRADE_VERIFICATION = "fomo-trading-activity-rest";
const FOMO_FOLLOWED_TRADE_WEBSOCKET = "fomo-trading-activity-websocket";
const FOMO_REST_SEEN_LIMIT = 5_000;
const PUMP_REQUEST_TIMEOUT_MS = 2_000;
const FOLLOWED_TRADES_CACHE_MS = 4_000;
const FOLLOWED_TRADES_POLL_MS = 5_000;
const FOLLOWED_TRADES_PIPELINE_LIMIT = 300;
const FOLLOWED_TRADES_PIPELINE_ITEM_LIMIT = 8;
const PUMP_PROFILE_CACHE_MS = 30_000;
const PUMP_IDENTITY_REFRESH_MS = 60_000;
const PUMP_PROFILE_GRACE_WAIT_MS = 250;
const PUMP_PROFILE_FALLBACK_WAIT_MS = 4_000;
const PUMP_PROFILE_CONCURRENCY = 4;
const PUMP_PROFILE_POLL_LIMIT = 20;
const PUMP_ALERT_USER_CACHE_MS = 5 * 60_000;
const PUMP_NATS_CONFIG_CACHE_MS = 60 * 60_000;
const PUMP_NATS_WALLET_DEBOUNCE_MS = 250;
const PUMP_NATS_INDEX_RETRY_DELAYS_MS = Object.freeze([2_000, 5_000]);
const PUMP_NATS_TRADE_BATCH_MS = 1_000;
const PUMP_NATS_SEEN_EVENT_LIMIT = 512;
const PUMP_REST_SEEN_LIMIT = 5_000;
const PUMP_ALERTS_RECONCILE_MS = 30_000;
const PUMP_FOLLOWING_CACHE_MS = 60_000;
const PUMP_MARKET_CACHE_MS = 60_000;
const PUMP_EVM_SYMBOL_CACHE_MS = 10 * 60_000;
const PUMP_EVM_SYMBOL_NEGATIVE_CACHE_MS = 60_000;
const PUMP_RPC_BATCH_LIMIT = 40;
const PUMP_RPC_CACHE_LIMIT = 500;
const PUMP_RPC_NEGATIVE_CACHE_MS = 4_000;
const FOMO_RATE_LIMIT_DEFAULT_MS = 15_000;
const FOMO_RATE_LIMIT_MAX_MS = 120_000;
const FOMO_API_DIAGNOSTIC_LIMIT = 30;
const LOG_FETCH_CONCURRENCY = 4;
const HOLDER_ADDRESS_CACHE_MS = 5 * 60 * 1000;
const HOLDER_FOLLOW_CACHE_MS = 10_000;
const BLOCKSCOUT_SNAPSHOT_CACHE_MS = 15_000;
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const sidePanelPortsByWindow = new Map();
const sidePanelCloseTimers = new Map();
const overlayLoadsByTab = new Map();
const sidePanelWindowByPort = new WeakMap();
const followedTradesNetworkByPort = new Map();
const followedTradesSurfaceByPort = new WeakMap();
const gmgnFollowTradeEventPorts = new Set();
const visibleGmgnTradePorts = new Set();
const gmgnHistoryRequestsByPort = new WeakMap();
const fomoRequestsByToken = new Map();
const blockscoutSnapshotsByToken = new Map();
const resolvedHolderAddresses = new Map();
const pumpHolderRequestsByToken = new Map();
const holderAddressRequests = new Map();
let sessionRefreshPromise = null;
let pumpPresenceOriginRulePromise = null;
let fomoSessionWritePromise = Promise.resolve();
let tokenCacheWritePromise = Promise.resolve();
let creatingOffscreenDocument = null;
let holderFollowRequest = null;
let fomoRateLimitUntil = 0;
let fomoRateLimitStrikes = 0;
const recentFomoApiRequests = [];
let followedTradesSnapshot = null;
let followedTradesRequest = null;
let followedTradesPollTimer = null;
let followedTradesPollRunning = false;
let followedTradesEnabled = true;
let followedTradesEnabledHydration = null;
let followedTradesEnabledGeneration = 0;
let followedTradesDiagnosticsEnabled = false;
let followedTradesDiagnosticsEnabledHydration = null;
let followedTradesDiagnostic = null;
let followedTradesPipelineWrite = Promise.resolve();
let followedTradesPipelineFlushScheduled = false;
const followedTradesPipelinePendingEvents = [];
let followedTradesPipelineSnapshotFingerprint = "";
const followedTradesHistory = { fomo: [], pump: [] };
let followedTradesHistoryHydration = null;
let followedTradesCacheWritePromise = Promise.resolve();
let followedTradesCacheFingerprint = "";
let followedTradesWindow = null;
const fomoFollowedMetadataCache = new Map();
const fomoFollowedMetadataRequests = new Map();
let fomoAlertRestSnapshot = null;
let fomoAlertSocket = null;
let fomoAlertAuthTimer = null;
let fomoAlertSessionRefreshAt = -Infinity;
let fomoAlertSocketKey = "";
let fomoAlertSocketAuthenticated = false;
let fomoAlertSocketGeneration = 0;
let fomoAlertSocketReconnectTimer = null;
let fomoAlertSocketReconnectAttempts = 0;
let fomoAlertHasSubscribed = false;
let fomoAlertTopicCapturePromise = null;
let fomoAlertTopicCaptureAttemptedAt = 0;
let fomoAlertCatchupRequest = null;
let fomoAlertLastEventAt = 0;
let fomoAlertLastError = "";
let fomoAlertCatchupError = "";
let fomoAlertDeliveryRequest = Promise.resolve();
const seenFomoRestTradeKeys = new Set();
const seenFomoRestTradeOrder = [];
let fomoRestBaselineReady = false;
let pumpPresenceSnapshot = null;
let pumpAlertsPresenceSnapshot = null;
let pumpAlertsPresenceRequest = null;
let pumpAlertsPresenceOperation = Promise.resolve();
let pumpAlertsPresenceGeneration = 0;
let pumpAlertsPresenceRefreshTimer = null;
let pumpSubscriptionRequest = null;
let pumpSubscriptionRetryCount = 0;
let pumpRealtimeError = "";
let pumpRealtimeUpdatedAt = 0;
let pumpActionNeedsLogin = null;
const pumpPresenceAuth = {
  backgroundAttemptAt: 0, backgroundError: "", backgroundSuccessAt: 0,
  pageAttemptAt: 0, pageError: "", pageSuccessAt: 0, lastSuccessTransport: "",
};
const pumpAlertUserCache = new Map();
const pumpAlertUserRequests = new Map();
let pumpProfilePollCursor = 0;
let pumpProfileFollowingSnapshot = null;
let pumpFollowingSnapshot = null;
let holderFollowSnapshot = null;
let pumpProfileTradesSnapshot = null;
let pumpProfileTradesRequest = null;
let pumpSolPriceSnapshot = null;
let pumpNatsConfigSnapshot = null;
let pumpNatsSubscriptionKey = "";
let pumpNatsConnectionStatus = "idle";
let pumpNatsLastEventAt = 0;
let pumpNatsIngestDiagnostics = {};
let pumpNatsHadConnected = false;
let pumpNatsTradeBatchTimer = null;
let pumpNatsTradeBatch = [];
const seenPumpNatsEventIds = new Set();
const seenPumpRestTradeKeys = new Set();
const seenPumpRestTradeOrder = [];
const tradeReceipts = LOCAL_DIAGNOSTICS_AVAILABLE
  ? GmgnTradeReceipts.create({ now: () => Date.now() }) : null;
let tradeReceiptTimer = null;
let tradeReceiptWrite = Promise.resolve();
let tradeReceiptDirty = false;
let tradeReceiptStorageError = "";
const tradeReceiptReady = !LOCAL_DIAGNOSTICS_AVAILABLE ? Promise.resolve() : chrome.storage.session.get(TRADE_RECEIPTS_KEY).then((saved) => {
  tradeReceipts.restore(saved?.[TRADE_RECEIPTS_KEY]);
}).catch(() => { tradeReceiptStorageError = "SESSION_READ_FAILED"; });

function scheduleTradeReceiptWrite() {
  if (!LOCAL_DIAGNOSTICS_AVAILABLE) return;
  tradeReceiptDirty = true;
  if (tradeReceiptTimer !== null) return;
  tradeReceiptTimer = setTimeout(() => { flushTradeReceipts(); }, 250);
}

function flushTradeReceipts() {
  if (!LOCAL_DIAGNOSTICS_AVAILABLE) return Promise.resolve();
  if (tradeReceiptTimer !== null) clearTimeout(tradeReceiptTimer);
  tradeReceiptTimer = null;
  if (!tradeReceiptDirty) return Promise.all([tradeReceiptReady, tradeReceiptWrite]);
  tradeReceiptDirty = false;
  tradeReceiptWrite = tradeReceiptWrite.catch(() => {}).then(async () => {
    await tradeReceiptReady;
    await chrome.storage.session.set({ [TRADE_RECEIPTS_KEY]: tradeReceipts.snapshot() });
    tradeReceiptStorageError = "";
  }).catch(() => { tradeReceiptStorageError = "SESSION_WRITE_FAILED"; });
  return tradeReceiptWrite;
}

function recordTradeSourceEvent(stage, detail) {
  if (!LOCAL_DIAGNOSTICS_AVAILABLE) return;
  tradeReceipts.source(stage, detail);
  scheduleTradeReceiptWrite();
}

const gmgnTradeDelivery = GmgnTradeDelivery.create({
  keyOf: gmgnTradeEventKey,
  now: () => Date.now(),
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (timer) => clearTimeout(timer),
  onResult: (stage, item, detail) => recordFollowedTradePipeline(stage, [item], detail),
});
let pumpRestBaselineReady = false;
let pumpAlertsReconcileTimer = null;
let pumpAlertsReconcileRequest = null;
let pumpAlertsReconcileAt = 0;
let pumpAlertsStartedAt = 0;
let pumpAlertsReconcileError = "";
const pumpNatsWalletRefreshStates = new Map();
const pumpCoinMetadataCache = new Map();
const pumpCoinMetadataRequests = new Map();
const pumpCoinMetadataApplications = new Set();
const pumpSolanaRpcCache = new Map();
const pumpEvmSymbolCache = new Map();
const pumpEvmSymbolRequests = new Set();
const unfollowedTradeIdentities = [];

function disabledFollowedTradesResponse() {
  return {
    ok: true,
    enabled: false,
    items: [],
    sources: {},
    realtimeItemKeys: [],
    notificationItemKeys: [],
    updatedAt: Date.now(),
  };
}

function getFollowedTradesEnabled() {
  if (followedTradesEnabledHydration) return followedTradesEnabledHydration;
  followedTradesEnabledHydration = chrome.storage.local.get(FOLLOWED_TRADES_ENABLED_KEY)
    .then((result) => {
      followedTradesEnabled = result?.[FOLLOWED_TRADES_ENABLED_KEY] !== false;
      return followedTradesEnabled;
    })
    .catch(() => followedTradesEnabled);
  return followedTradesEnabledHydration;
}

async function setFollowedTradesEnabled(value) {
  if (typeof value !== "boolean") throw new Error("INVALID_FOLLOWED_TRADES_ENABLED_STATE");
  await chrome.storage.local.set({ [FOLLOWED_TRADES_ENABLED_KEY]: value });
  followedTradesEnabled = value;
  followedTradesEnabledHydration = Promise.resolve(value);
  followedTradesEnabledGeneration += 1;
  followedTradesSnapshot = null;
  if (!value) {
    gmgnTradeDelivery.clear();
    stopFollowedTradesAcquisition();
    const response = disabledFollowedTradesResponse();
    for (const [port, networkId] of followedTradesNetworkByPort) {
      postFollowedTradesSnapshot(port, response, networkId);
    }
  } else {
    if (followedTradesNetworkByPort.size) startFollowedTradesPolling();
    for (const port of gmgnFollowTradeEventPorts) gmgnTradeDelivery.addPort(port, port.sender?.tab?.id ?? port);
    if (gmgnFollowTradeEventPorts.size) startFollowedTradesRealtime();
  }
  return { ok: true, enabled: value };
}

function getFollowedTradesDiagnosticsEnabled() {
  if (!LOCAL_DIAGNOSTICS_AVAILABLE) return Promise.resolve(false);
  if (followedTradesDiagnosticsEnabledHydration) {
    return followedTradesDiagnosticsEnabledHydration;
  }
  followedTradesDiagnosticsEnabledHydration = chrome.storage.local
    .get(FOLLOWED_TRADES_DIAGNOSTICS_ENABLED_KEY)
    .then(async (result) => {
      followedTradesDiagnosticsEnabled = result?.[FOLLOWED_TRADES_DIAGNOSTICS_ENABLED_KEY] === true;
      if (!followedTradesDiagnosticsEnabled) {
        await chrome.storage.local.remove([
          FOLLOWED_TRADES_DIAGNOSTIC_KEY,
          FOLLOWED_TRADES_PIPELINE_KEY,
        ]).catch(() => {});
      }
      return followedTradesDiagnosticsEnabled;
    })
    .catch(() => false);
  return followedTradesDiagnosticsEnabledHydration;
}

async function broadcastFollowedTradesDiagnosticsEnabled() {
  const tabs = await chrome.tabs.query({
    url: ["https://gmgn.ai/*", "https://www.gmgn.ai/*"],
  }).catch(() => []);
  await Promise.allSettled(tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) => (
    chrome.tabs.sendMessage(tab.id, {
      type: "followedTradeDiagnosticsEnabledChanged",
      enabled: followedTradesDiagnosticsEnabled,
    })
  )));
}

async function clearFollowedTradeDiagnostics() {
  if (!LOCAL_DIAGNOSTICS_AVAILABLE) return;
  await tradeReceiptReady;
  tradeReceipts.clear();
  tradeReceiptDirty = true;
  await flushTradeReceipts();
  pumpNatsIngestDiagnostics = {};
  followedTradesDiagnostic = null;
  recentFomoApiRequests.splice(0);
  followedTradesPipelinePendingEvents.splice(0);
  followedTradesPipelineSnapshotFingerprint = "";
  await followedTradesPipelineWrite.catch(() => {});
  await chrome.storage.local.remove([
    FOLLOWED_TRADES_DIAGNOSTIC_KEY,
    FOLLOWED_TRADES_PIPELINE_KEY,
  ]);
}

async function setFollowedTradesDiagnosticsEnabled(value) {
  if (!LOCAL_DIAGNOSTICS_AVAILABLE) return { ok: false, enabled: false, error: "DIAGNOSTICS_UNAVAILABLE" };
  if (typeof value !== "boolean") throw new Error("INVALID_DIAGNOSTICS_ENABLED_STATE");
  followedTradesDiagnosticsEnabled = value;
  followedTradesDiagnosticsEnabledHydration = Promise.resolve(value);
  await chrome.storage.local.set({ [FOLLOWED_TRADES_DIAGNOSTICS_ENABLED_KEY]: value });
  await queryPumpTransportDiagnostics({ type: "setPumpNatsDiagnostics", enabled: value });
  if (!value) await clearFollowedTradeDiagnostics();
  await broadcastFollowedTradesDiagnosticsEnabled();
  return { ok: true, enabled: value };
}

function sanitizeStoredPumpIdentity(value) {
  const viewerWallet = GmgnFomoCore.normalizeWalletAddress(
    value?.viewerWallet,
    GmgnFomoCore.TOKEN_NETWORK_IDS.sol,
  );
  if (!viewerWallet) return null;
  return {
    userId: typeof value?.userId === "string" ? value.userId.trim() : "",
    viewerWallet,
    updatedAt: GmgnFomoCore.finiteNumber(value?.updatedAt) || 0,
  };
}

async function storedPumpIdentity() {
  const result = await chrome.storage.local.get(PUMP_IDENTITY_KEY);
  return sanitizeStoredPumpIdentity(result?.[PUMP_IDENTITY_KEY]);
}

function useStoredPumpIdentity(identity) {
  pumpPresenceSnapshot = {
    userId: identity.userId,
    viewerWallet: identity.viewerWallet,
    refreshAt: Date.now() + PUMP_IDENTITY_REFRESH_MS,
  };
  return pumpPresenceSnapshot;
}

async function persistPumpIdentity(identity) {
  const stored = {
    userId: identity.userId,
    viewerWallet: identity.viewerWallet,
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ [PUMP_IDENTITY_KEY]: stored });
  return stored;
}

function resetPumpAccountCaches() {
  stopPumpNatsSubscriptions();
  pumpFollowingSnapshot = null;
  pumpProfileFollowingSnapshot = null;
  holderFollowSnapshot = null;
  pumpProfileTradesSnapshot = null;
  followedTradesHistory.pump = [];
}

async function broadcastSidePanelVisibility(windowId, visible) {
  const tabs = await chrome.tabs.query({
    windowId,
    url: ["https://gmgn.ai/*", "https://www.gmgn.ai/*"],
  }).catch(() => []);
  if (sidePanelPortsByWindow.has(windowId) !== visible) return;
  await Promise.allSettled(tabs.map((tab) => (
    chrome.tabs.sendMessage(tab.id, { type: "sidePanelVisibilityChanged", visible })
  )));
}

function removeSidePanelPort(port) {
  const windowId = sidePanelWindowByPort.get(port);
  if (!Number.isInteger(windowId)) return;
  sidePanelWindowByPort.delete(port);
  const ports = sidePanelPortsByWindow.get(windowId);
  if (!ports) return;
  ports.delete(port);
  if (ports.size) return;
  // A port reconnects after 500 ms. Keep the visible state through that gap
  // so an open side panel cannot briefly reveal the floating panel underneath.
  sidePanelCloseTimers.set(windowId, setTimeout(() => {
    sidePanelCloseTimers.delete(windowId);
    if (sidePanelPortsByWindow.get(windowId)?.size) return;
    sidePanelPortsByWindow.delete(windowId);
    broadcastSidePanelVisibility(windowId, false);
  }, 800));
}

function registerSidePanelPort(port, windowId) {
  if (!Number.isInteger(windowId) || sidePanelWindowByPort.get(port) === windowId) return;
  removeSidePanelPort(port);
  clearTimeout(sidePanelCloseTimers.get(windowId));
  sidePanelCloseTimers.delete(windowId);
  const ports = sidePanelPortsByWindow.get(windowId) || new Set();
  ports.add(port);
  sidePanelPortsByWindow.set(windowId, ports);
  sidePanelWindowByPort.set(port, windowId);
  // A content script may be reinjected while another side-panel port already
  // keeps this window marked visible. Announce every new port registration so
  // that the fresh script cannot miss the visible state and create an overlay.
  broadcastSidePanelVisibility(windowId, true);
}

function configureSidePanel() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
}

async function ensureGmgnContentScript(tabId) {
  let relayReady = false;
  let bridgeReady = false;
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "gmgnFollowTradeRelayPing" });
    relayReady = response?.ok === true
      && response?.mode === "event-only"
      && response?.version === chrome.runtime.getManifest().version;
  } catch {}
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (expectedVersion) => (
        globalThis.__gmgnFollowThinBridgeVersion === expectedVersion
        && typeof globalThis.GmgnFollowBridge?.toGmgnFollowSocketTrade === "function"
      ),
      args: [chrome.runtime.getManifest().version],
    });
    bridgeReady = results?.[0]?.result === true;
  } catch {}
  if (!bridgeReady) {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["src/trade-identity.js", "src/gmgn-follow-bridge.js", "src/follow-tracker-main.js"],
    });
  }
  if (!relayReady) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/follow-tracker.js"],
    });
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/core.js", "src/panel-loader.js"],
  });
}

function ensureFomoOverlay(tab) {
  if (sidePanelPortsByWindow.has(tab.windowId)) return Promise.resolve({ ok: true, loaded: false });
  if (overlayLoadsByTab.has(tab.id)) return overlayLoadsByTab.get(tab.id);
  const request = (async () => {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "gmgnFomoPing" }).catch(() => null);
    if (response?.ok && response.version === chrome.runtime.getManifest().version) {
      return { ok: true, loaded: true };
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/core.js", "src/pump-api.js", "src/content.js"],
    });
    return { ok: true, loaded: true };
  })().finally(() => overlayLoadsByTab.delete(tab.id));
  overlayLoadsByTab.set(tab.id, request);
  return request;
}

async function injectIntoOpenGmgnTabs() {
  const tabs = await chrome.tabs.query({
    url: ["https://gmgn.ai/*", "https://www.gmgn.ai/*"],
  }).catch(() => []);
  await Promise.allSettled(
    tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) => ensureGmgnContentScript(tab.id)),
  );
}

configureSidePanel();
injectIntoOpenGmgnTabs();
getFollowedTradesDiagnosticsEnabled();
chrome.runtime.onInstalled.addListener(configureSidePanel);
chrome.runtime.onStartup.addListener(configureSidePanel);
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "fomoSidePanelVisibility") {
    port.onMessage.addListener((message) => {
      if (message?.type === "sidePanelVisible") registerSidePanelPort(port, message.windowId);
    });
    port.onDisconnect.addListener(() => removeSidePanelPort(port));
    return;
  }
  if (port.name === "gmgnFollowTradeEvents") {
    const senderUrl = port.sender?.tab?.url || port.sender?.url || "";
    if (!/^https:\/\/(?:www\.)?gmgn\.ai\//.test(senderUrl)) {
      try { port.disconnect(); } catch {}
      return;
    }
    gmgnFollowTradeEventPorts.add(port);
    getFollowedTradesEnabled().then((enabled) => {
      if (enabled && gmgnFollowTradeEventPorts.has(port)) gmgnTradeDelivery.addPort(port, port.sender?.tab?.id ?? port);
    }).catch(() => {});
    port.onMessage.addListener((message) => {
      if (message?.type === "gmgnFollowTradeVisibility" && typeof message.visible === "boolean") {
        if (message.visible) visibleGmgnTradePorts.add(port);
        else visibleGmgnTradePorts.delete(port);
        schedulePumpAlertsReconciliation();
        return;
      }
      if (message?.type === "gmgnFollowTradeAck") {
        gmgnTradeDelivery.acknowledge(port, message);
        return;
      }
      if (message?.type !== "getGmgnRecentTrades"
        || typeof message.requestId !== "string" || message.requestId.length > 80
        || !Array.isArray(message.chains) || message.chains.length > 16
        || (gmgnHistoryRequestsByPort.get(port) || 0) >= 4) return;
      const networkIds = new Set(message.chains.map((chain) => GmgnFomoCore.TOKEN_NETWORK_IDS[chain])
        .filter((networkId) => Number.isInteger(networkId)));
      if (!networkIds.size) return;
      gmgnHistoryRequestsByPort.set(port, (gmgnHistoryRequestsByPort.get(port) || 0) + 1);
      Promise.all([getFollowedTradesEnabled(), hydrateFollowedTradesHistory()]).then(() => {
        if (!gmgnFollowTradeEventPorts.has(port)) return;
        const sources = followedTradesEnabled ? [
          followedTradesHistory.fomo,
          followedTradesHistory.pump,
          pumpNatsTradeBatch,
        ].map((source) => filterUnfollowedTrades(source.filter((item) => networkIds.has(Number(item.networkId)) && (
          isVerifiedFomoFollowedTrade(item)
          || (item.platform === "pump"
            && [GmgnPumpApi.PUMP_ALERTS_NATS_VERIFICATION, GmgnPumpApi.PUMP_ALERTS_REST_VERIFICATION]
              .includes(item.sourceVerification))
        )))) : [];
        const items = GmgnFollowTrades.mergeFollowedTrades(...sources).slice(0, 30);
        port.postMessage({ type: "gmgnRecentTrades", requestId: message.requestId, items });
      }).catch(() => {}).finally(() => gmgnHistoryRequestsByPort.set(port,
        Math.max(0, (gmgnHistoryRequestsByPort.get(port) || 1) - 1)));
    });
    port.onDisconnect.addListener(() => {
      gmgnFollowTradeEventPorts.delete(port);
      visibleGmgnTradePorts.delete(port);
      schedulePumpAlertsReconciliation();
      gmgnTradeDelivery.removePort(port);
      stopFollowedTradesPollingIfIdle();
    });
    getFollowedTradesEnabled().then((enabled) => {
      if (enabled && gmgnFollowTradeEventPorts.has(port)) startFollowedTradesRealtime();
    }).catch(() => {});
    return;
  }
  if (port.name !== "gmgnFollowedTrades") return;
  const senderUrl = port.sender?.tab?.url || port.sender?.url || "";
  const surface = /^https:\/\/(?:www\.)?gmgn\.ai\//.test(senderUrl)
    ? "gmgn"
    : senderUrl.includes("/diagnostics.html")
      ? "diagnostics"
      : "other";
  followedTradesSurfaceByPort.set(port, surface);
  port.onMessage.addListener((message) => {
    if (message?.type !== "subscribeFollowedTrades") return;
    const networkId = message.networkId === null ? null : Number(message.networkId);
    if (networkId !== null && (!Number.isInteger(networkId) || networkId <= 0)) {
      followedTradesNetworkByPort.delete(port);
      stopFollowedTradesPollingIfIdle();
      return;
    }
    followedTradesNetworkByPort.set(port, networkId);
    recordFollowedTradePipeline("subscriber-connected", [], {
      subscriberCount: followedTradesNetworkByPort.size,
      gmgnSubscriberCount: [...followedTradesNetworkByPort.keys()].filter(
        (candidate) => followedTradesSurfaceByPort.get(candidate) === "gmgn",
      ).length,
      surface,
    });
    getFollowedTradesEnabled().then((enabled) => {
      if (!followedTradesNetworkByPort.has(port)) return;
      if (!enabled) {
        postFollowedTradesSnapshot(port, disabledFollowedTradesResponse(), networkId);
        return;
      }
      if (followedTradesSnapshot?.response
        && Date.now() - followedTradesSnapshot.cachedAt < FOLLOWED_TRADES_CACHE_MS) {
        postFollowedTradesSnapshot(port, followedTradesSnapshot.response, networkId);
      }
      startFollowedTradesPolling();
    }).catch(() => {});
  });
  port.onDisconnect.addListener(() => {
    const disconnectedSurface = followedTradesSurfaceByPort.get(port) || "other";
    followedTradesNetworkByPort.delete(port);
    followedTradesSurfaceByPort.delete(port);
    recordFollowedTradePipeline("subscriber-disconnected", [], {
      subscriberCount: followedTradesNetworkByPort.size,
      gmgnSubscriberCount: [...followedTradesNetworkByPort.keys()].filter(
        (candidate) => followedTradesSurfaceByPort.get(candidate) === "gmgn",
      ).length,
      surface: disconnectedSurface,
    });
    stopFollowedTradesPollingIfIdle();
  });
});

function headerValue(headers, name) {
  const target = name.toLowerCase();
  const match = Array.isArray(headers)
    ? headers.find((header) => String(header?.name).toLowerCase() === target)
    : null;
  return typeof match?.value === "string" && match.value.trim() ? match.value : null;
}

async function notifyFomoSessionChanged() {
  await chrome.runtime.sendMessage({ type: "fomoSessionChanged" }).catch(() => {});
}

function updateFomoSession(patch) {
  const write = fomoSessionWritePromise.then(async () => {
    const result = await chrome.storage.local.get(SESSION_KEY);
    const previousSession = result?.[SESSION_KEY] || {};
    const nextSession = { ...previousSession, ...patch };
    const authorizationChanged = Boolean(
      patch?.authorization && patch.authorization !== previousSession.authorization,
    );
    if (authorizationChanged) {
      holderFollowSnapshot = null;
    }
    await chrome.storage.local.set({ [SESSION_KEY]: nextSession });
    if (authorizationChanged) await notifyFomoSessionChanged();
    return nextSession;
  });
  fomoSessionWritePromise = write.catch(() => {});
  return write;
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.initiator !== FOMO_PAGE_ORIGIN) return;
    const authorization = headerValue(details.requestHeaders, "authorization");
    if (!authorization) return;
    updateFomoSession({
      authorization,
      supportedChains: headerValue(details.requestHeaders, "x-supported-chains"),
      updatedAt: Date.now(),
    }).then(() => ensureFomoAlertSocket()).catch(() => {});
  },
  { urls: ["https://prod-api.fomo.family/*"] },
  ["requestHeaders", "extraHeaders"],
);

chrome.webRequest.onCompleted?.addListener((details) => {
  if (details.initiator !== "https://pump.fun" || details.statusCode < 200 || details.statusCode >= 300
    || !followedTradesEnabled || !hasFollowedTradeConsumers() || !pumpRealtimeError) return;
  pumpSubscriptionRetryCount = 0;
  ensurePumpNatsSubscriptions(undefined, true).catch(() => {});
}, { urls: ["https://frontend-api-v3.pump.fun/following-positions/alerts*"] });

async function getSession() {
  const localResult = await chrome.storage.local.get(SESSION_KEY);
  if (localResult?.[SESSION_KEY]?.authorization) return localResult[SESSION_KEY];

  const sessionResult = await chrome.storage.session.get(SESSION_KEY);
  const previousSession = sessionResult?.[SESSION_KEY];
  if (!previousSession?.authorization) return null;
  await chrome.storage.local.set({ [SESSION_KEY]: previousSession });
  return previousSession;
}

async function clearSession() {
  closeFomoAlertSocket();
  fomoAlertRestSnapshot = null;
  holderFollowSnapshot = null;
  await Promise.all([
    chrome.storage.local.remove(SESSION_KEY),
    chrome.storage.session.remove(SESSION_KEY),
  ]);
}

async function waitForReplacementSession(previousAuthorization) {
  const deadline = Date.now() + SESSION_REFRESH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const session = await getSession();
    if (session?.authorization && session.authorization !== previousAuthorization) return session;
    await new Promise((resolve) => setTimeout(resolve, SESSION_REFRESH_POLL_MS));
  }
  return null;
}

async function refreshSessionInBackground(previousAuthorization) {
  if (sessionRefreshPromise) return sessionRefreshPromise;
  sessionRefreshPromise = (async () => {
    let tab;
    try {
      tab = await chrome.tabs.create({ url: FOMO_PAGE_URL, active: false });
      return await waitForReplacementSession(previousAuthorization);
    } finally {
      if (Number.isInteger(tab?.id)) await chrome.tabs.remove(tab.id).catch(() => {});
      sessionRefreshPromise = null;
    }
  })();
  return sessionRefreshPromise;
}

function tokenCacheId(params) {
  return `${params.networkId}:${String(params.address).toLowerCase()}`;
}

function tokenCacheStorageKey(params) {
  return `${TOKEN_CACHE_ENTRY_PREFIX}${tokenCacheId(params)}`;
}

function holderAddressCacheId(params, holder) {
  const amount = GmgnFomoCore.decimalString(holder?.humanAmountRaw ?? holder?.humanAmount);
  return amount === null
    ? ""
    : `${tokenCacheId(params)}:${holder?.tradeId || ""}:${holder?.userId || ""}:${amount}`;
}

// Bound long-lived worker caches even when old keys are never queried again.
function setBoundedCache(cache, key, value, ttlMs, limit) {
  const now = Date.now();
  for (const [cachedKey, entry] of cache) {
    if (now - entry.cachedAt >= ttlMs) cache.delete(cachedKey);
  }
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value);
}

function getResolvedHolderAddress(key) {
  const cached = key ? resolvedHolderAddresses.get(key) : null;
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > HOLDER_ADDRESS_CACHE_MS) {
    resolvedHolderAddresses.delete(key);
    return null;
  }
  return cached.address;
}

function cacheResolvedHolderAddress(key, address) {
  if (key) setBoundedCache(resolvedHolderAddresses, key, { address, cachedAt: Date.now() }, HOLDER_ADDRESS_CACHE_MS, 1024);
}

async function getCachedToken(params) {
  const storageKey = tokenCacheStorageKey(params);
  const result = await chrome.storage.local.get(storageKey);
  let entry = result?.[storageKey];
  if (!entry) {
    const legacyResult = await chrome.storage.local.get(TOKEN_CACHE_KEY);
    entry = legacyResult?.[TOKEN_CACHE_KEY]?.[tokenCacheId(params)];
  }
  if (!entry?.data || !Number.isFinite(entry.cachedAt)) return null;
  if (Date.now() - entry.cachedAt > TOKEN_CACHE_MAX_AGE_MS) return null;
  return entry;
}

async function writeTokenCacheEntry(params, data) {
  const storageKey = tokenCacheStorageKey(params);
  const cachedAt = Date.now();
  const result = await chrome.storage.local.get(TOKEN_CACHE_INDEX_KEY);
  const currentIndex = Array.isArray(result?.[TOKEN_CACHE_INDEX_KEY])
    ? result[TOKEN_CACHE_INDEX_KEY].filter((entry) => (
      typeof entry?.key === "string" && Number.isFinite(entry.cachedAt)
    ))
    : [];
  const nextIndex = [
    { key: storageKey, cachedAt },
    ...currentIndex.filter((entry) => entry.key !== storageKey),
  ]
    .sort((left, right) => right.cachedAt - left.cachedAt)
    .slice(0, TOKEN_CACHE_LIMIT);
  const retainedKeys = new Set(nextIndex.map((entry) => entry.key));
  const removedKeys = currentIndex
    .map((entry) => entry.key)
    .filter((key) => !retainedKeys.has(key));
  await chrome.storage.local.set({
    [storageKey]: { cachedAt, data },
    [TOKEN_CACHE_INDEX_KEY]: nextIndex,
  });
  if (removedKeys.length) await chrome.storage.local.remove(removedKeys);
}

function cacheToken(params, data) {
  const write = tokenCacheWritePromise.then(() => writeTokenCacheEntry(params, data));
  tokenCacheWritePromise = write.catch(() => {});
  return write;
}

function fomoRetryAfterMs(response) {
  const value = response?.headers?.get?.("retry-after");
  if (typeof value !== "string" || !value.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.max(seconds * 1_000, 1_000), FOMO_RATE_LIMIT_MAX_MS);
  }
  const deadline = Date.parse(value);
  if (!Number.isFinite(deadline)) return null;
  return Math.min(Math.max(deadline - Date.now(), 1_000), FOMO_RATE_LIMIT_MAX_MS);
}

function registerFomoRateLimit(response) {
  const now = Date.now();
  if (now < fomoRateLimitUntil) return;
  fomoRateLimitStrikes += 1;
  const fallback = FOMO_RATE_LIMIT_DEFAULT_MS * (2 ** Math.min(fomoRateLimitStrikes - 1, 3));
  const retryAfterMs = fomoRetryAfterMs(response) || fallback;
  fomoRateLimitUntil = now + Math.min(retryAfterMs, FOMO_RATE_LIMIT_MAX_MS);
}

function fomoRateLimitError() {
  const error = new Error("FOMO_RATE_LIMIT_BACKOFF");
  error.retryAt = fomoRateLimitUntil;
  return error;
}

function cachedResult(entry, reason) {
  return {
    ok: true,
    data: entry.data,
    cached: true,
    cachedAt: entry.cachedAt,
    cacheReason: reason,
  };
}

function recordFomoApiRequestDiagnostic(request, startedAt, status, error) {
  if (!followedTradesDiagnosticsEnabled) return;
  let path = "";
  try {
    path = new URL(request?.url).pathname;
  } catch {
    path = "INVALID_URL";
  }
  recentFomoApiRequests.push({
    at: startedAt,
    method: typeof request?.method === "string" ? request.method : "GET",
    path,
    durationMs: Math.max(0, Date.now() - startedAt),
    status: Number.isInteger(status) ? status : null,
    error: diagnosticError(error),
  });
  if (recentFomoApiRequests.length > FOMO_API_DIAGNOSTIC_LIMIT) {
    recentFomoApiRequests.splice(0, recentFomoApiRequests.length - FOMO_API_DIAGNOSTIC_LIMIT);
  }
}

async function fetchJson(request, session) {
  const startedAt = Date.now();
  let status = null;
  let errorCode = "";
  if (startedAt < fomoRateLimitUntil) {
    const error = fomoRateLimitError();
    recordFomoApiRequestDiagnostic(request, startedAt, status, error.message);
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs || FOMO_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      body: request.body,
      credentials: "omit",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        authorization: session.authorization,
        "content-type": "application/json",
        "x-supported-chains": session.supportedChains || DEFAULT_SUPPORTED_CHAINS,
      },
    });
    status = response.status;
    if (!response.ok) {
      if (response.status === 429) registerFomoRateLimit(response);
      throw new Error(`HTTP_${response.status}`);
    }
    if (Date.now() >= fomoRateLimitUntil) fomoRateLimitStrikes = 0;
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      errorCode = "FOMO_REQUEST_TIMEOUT";
      throw new Error(errorCode);
    }
    errorCode = error?.message || "FOMO_REQUEST_FAILED";
    throw error;
  } finally {
    clearTimeout(timeout);
    recordFomoApiRequestDiagnostic(request, startedAt, status, errorCode);
  }
}

function isPumpPresenceMutation(request) {
  return request.url === PUMP_PRESENCE_URL && ["POST", "DELETE"].includes(request.method);
}

function ensurePumpPresenceOriginRule() {
  if (!pumpPresenceOriginRulePromise) {
    // Pump rejects the extension Origin on presence mutations. Keep the rule
    // restricted to this extension and this endpoint; Chrome still owns cookies.
    pumpPresenceOriginRulePromise = chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [PUMP_PRESENCE_ORIGIN_RULE_ID],
      addRules: [{
        id: PUMP_PRESENCE_ORIGIN_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "origin", operation: "set", value: "https://pump.fun" }],
        },
        condition: {
          urlFilter: `|${PUMP_PRESENCE_URL}|`,
          isUrlFilterCaseSensitive: true,
          initiatorDomains: [chrome.runtime.id],
          requestMethods: ["post", "delete"],
          resourceTypes: ["xmlhttprequest"],
        },
      }],
    }).catch(() => {
      pumpPresenceOriginRulePromise = null;
      throw new Error("PUMP_PRESENCE_TRANSPORT_UNAVAILABLE");
    });
  }
  return pumpPresenceOriginRulePromise;
}

async function fetchPublicJson(request) {
  const presenceMutation = isPumpPresenceMutation(request);
  if (presenceMutation) await ensurePumpPresenceOriginRule();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs || PUMP_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      body: request.body,
      cache: "no-store",
      credentials: request.credentials || "omit",
      ...(request.referrer ? { referrer: request.referrer } : {}),
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(request.body ? { "content-type": "application/json" } : {}),
      },
    });
    if (!response.ok) {
      if (presenceMutation && response.status === 403) {
        const payload = await response.json().catch(() => null);
        if (payload?.message === "Not allowed by CORS") throw new Error("PUMP_CORS_REJECTED");
      }
      throw new Error(`HTTP_${response.status}`);
    }
    if (!request.allowEmptyResponse) return await response.json();
    const text = await response.text();
    return text.trim() ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timeout);
  }
}

async function pumpPageTab(preferredTabId) {
  if (Number.isInteger(preferredTabId)) {
    const preferred = await chrome.tabs.get(preferredTabId).catch(() => null);
    if (String(preferred?.url || "").startsWith("https://pump.fun/")) return preferred;
  }
  const tabs = await chrome.tabs.query({ url: ["https://pump.fun/*"] }).catch(() => []);
  return tabs.find((tab) => Number.isInteger(tab?.id)) || null;
}

async function pumpIdentityFromPage(tabId) {
  if (!Number.isInteger(tabId)) return null;
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const anchor = document.querySelector(
          'a[aria-label^="View your profile"][href*="/profile/"]',
        );
        if (!anchor) return null;
        let url;
        try {
          url = new URL(anchor.href, location.origin);
        } catch {
          return null;
        }
        if (url.origin !== "https://pump.fun") return null;
        const match = /^\/profile\/([^/?#]+)\/?$/.exec(url.pathname);
        if (!match) return null;
        const label = anchor.getAttribute("aria-label") || "";
        const username = /\(([^()]*)\)\s*$/.exec(label)?.[1]?.trim() || "";
        return { viewerWallet: decodeURIComponent(match[1]), username };
      },
    });
  } catch {
    return null;
  }
  const viewerWallet = GmgnFomoCore.normalizeWalletAddress(
    results?.[0]?.result?.viewerWallet,
    GmgnFomoCore.TOKEN_NETWORK_IDS.sol,
  );
  if (!viewerWallet) return null;
  return {
    viewerWallet,
    username: typeof results?.[0]?.result?.username === "string"
      ? results[0].result.username.trim().slice(0, 80)
      : "",
  };
}

async function fetchPumpJsonFromPage(request, preferredTabId) {
  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== PUMP_API_ORIGIN) throw new Error("INVALID_PUMP_REQUEST");
  const tab = await pumpPageTab(preferredTabId);
  if (!Number.isInteger(tab?.id)) throw new Error("PUMP_PAGE_NOT_FOUND");
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: async (url, method, body, timeoutMs, includeWafToken) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const headers = {
            accept: "application/json",
            ...(body ? { "content-type": "application/json" } : {}),
          };
          if (includeWafToken) {
            const wafToken = document.cookie.split(";")
              .map((part) => part.trim())
              .find((part) => part.startsWith("aws-waf-token="))
              ?.slice("aws-waf-token=".length);
            if (wafToken) headers["x-aws-waf-token"] = decodeURIComponent(wafToken);
          }
          const response = await fetch(url, {
            method,
            ...(body ? { body } : {}),
            cache: "no-store",
            credentials: "include",
            headers,
            signal: controller.signal,
          });
          return {
            ok: response.ok,
            status: response.status,
            text: await response.text(),
          };
        } catch (error) {
          return {
            ok: false,
            error: error?.name === "AbortError" ? "PUMP_REQUEST_TIMEOUT" : "PUMP_PAGE_REQUEST_FAILED",
          };
        } finally {
          clearTimeout(timeout);
        }
      },
      args: [
        request.url,
        request.method || "GET",
        request.body || null,
        request.timeoutMs || 4_000,
        request.includeWafToken === true,
      ],
    });
  } catch {
    throw new Error("PUMP_PAGE_REQUEST_FAILED");
  }
  const result = results?.[0]?.result;
  if (!result?.ok) {
    throw new Error(result?.status ? `HTTP_${result.status}` : result?.error || "PUMP_PAGE_REQUEST_FAILED");
  }
  if (request.allowEmptyResponse && !result.text.trim()) return {};
  try {
    return JSON.parse(result.text);
  } catch {
    throw new Error("PUMP_PAGE_RESPONSE_INVALID");
  }
}

async function activeGmgnTabId(preferredTabId) {
  if (Number.isInteger(preferredTabId)) return preferredTabId;
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
    url: ["https://gmgn.ai/*", "https://www.gmgn.ai/*"],
  });
  return tabs.find((tab) => Number.isInteger(tab.id))?.id || null;
}

async function fetchGmgnJsonFromPage(request, preferredTabId) {
  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== GmgnFomoApi.GMGN_API_ORIGIN) {
    throw new Error("INVALID_GMGN_REQUEST");
  }
  const method = String(request.method || "GET").toUpperCase();
  if (!["GET", "POST"].includes(method)) throw new Error("INVALID_GMGN_REQUEST");
  const body = method === "POST" && typeof request.body === "string"
    ? request.body
    : null;
  const tabId = await activeGmgnTabId(preferredTabId);
  if (!Number.isInteger(tabId)) throw new Error("GMGN_PAGE_NOT_FOUND");
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (url, requestMethod, requestBody, timeoutMs) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const target = new URL(url);
        target.protocol = location.protocol;
        target.host = location.host;
        const response = await fetch(target.toString(), {
          method: requestMethod,
          ...(requestBody === null ? {} : { body: requestBody }),
          cache: "no-store",
          credentials: "include",
          headers: {
            accept: "application/json",
            ...(requestBody === null ? {} : { "content-type": "application/json" }),
          },
          signal: controller.signal,
        });
        return {
          ok: response.ok,
          status: response.status,
          text: await response.text(),
        };
      } catch (error) {
        return {
          ok: false,
          error: error?.name === "AbortError" ? "GMGN_PAGE_REQUEST_TIMEOUT" : "GMGN_PAGE_REQUEST_FAILED",
        };
      } finally {
        clearTimeout(timeout);
      }
    },
    args: [request.url, method, body, request.timeoutMs || 8_000],
  });
  const result = results?.[0]?.result;
  if (!result?.ok) {
    throw new Error(result?.status ? `HTTP_${result.status}` : result?.error || "GMGN_PAGE_REQUEST_FAILED");
  }
  try {
    return JSON.parse(result.text);
  } catch {
    throw new Error("GMGN_PAGE_RESPONSE_INVALID");
  }
}

async function fetchGmgnJson(request, preferredTabId) {
  try {
    return await fetchGmgnJsonFromPage(request, preferredTabId);
  } catch {
    return fetchPublicJson(request);
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTransientRpcError(error) {
  return /^(HTTP_(429|502|503|504)|EVM_RPC_-32029)$/.test(error?.message || "");
}

async function fetchEvmRpcResponse(networkId, payload, timeoutMs, attempt = 0) {
  let lastError = new Error("EVM_RPC_INVALID_RESPONSE");
  const endpointCount = GmgnEvmHolderResolver.rpcEndpointCount(networkId);
  for (let endpointIndex = 0; endpointIndex < endpointCount; endpointIndex += 1) {
    try {
      const response = await fetchPublicJson(
        GmgnEvmHolderResolver.buildRpcRequest(
          networkId,
          payload,
          timeoutMs,
          endpointIndex,
        ),
      );
      if (!response || (!Array.isArray(response) && response.error)) {
        throw new Error(`EVM_RPC_${response?.error?.code || "INVALID_RESPONSE"}`);
      }
      return response;
    } catch (error) {
      lastError = error;
    }
  }
  if (attempt < 2 && isTransientRpcError(lastError)) {
    await wait(400 * (2 ** attempt));
    return fetchEvmRpcResponse(networkId, payload, timeoutMs, attempt + 1);
  }
  throw lastError;
}

async function evmRpcCall(networkId, method, params, timeoutMs = 8_000) {
  const payload = { jsonrpc: "2.0", id: 1, method, params };
  const response = await fetchEvmRpcResponse(networkId, payload, timeoutMs);
  if (!("result" in response)) throw new Error("EVM_RPC_INVALID_RESPONSE");
  return response.result;
}

async function evmRpcBatch(networkId, requests) {
  const response = await fetchEvmRpcResponse(networkId, requests, 10_000);
  if (!Array.isArray(response)) throw new Error("EVM_RPC_INVALID_BATCH");
  return response;
}

async function fetchEvmLogRange(params, direction, fromBlock, toBlock) {
  const filter = GmgnEvmHolderResolver.logFilters(params, fromBlock, toBlock)[direction];
  try {
    const logs = await evmRpcCall(params.networkId, "eth_getLogs", [filter], 10_000);
    if (!Array.isArray(logs)) throw new Error("EVM_RPC_INVALID_LOGS");
    return logs;
  } catch (error) {
    const range = toBlock - fromBlock + 1n;
    const canSplit = range > GmgnEvmHolderResolver.MIN_LOG_RANGE
      && (error?.name === "AbortError"
        || /^(EVM_RPC_|HTTP_400|HTTP_413)/.test(error?.message || ""));
    if (!canSplit) throw error;
    const middle = fromBlock + ((toBlock - fromBlock) / 2n);
    const left = await fetchEvmLogRange(params, direction, fromBlock, middle);
    const right = await fetchEvmLogRange(params, direction, middle + 1n, toBlock);
    return [...left, ...right];
  }
}

async function fetchEvmLogs(params, direction, fromBlock, toBlock) {
  const ranges = GmgnEvmHolderResolver.logRanges(params.networkId, fromBlock, toBlock);
  const pages = new Array(ranges.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < ranges.length) {
      const index = nextIndex;
      nextIndex += 1;
      const range = ranges[index];
      pages[index] = await fetchEvmLogRange(
        params,
        direction,
        range.fromBlock,
        range.toBlock,
      );
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(LOG_FETCH_CONCURRENCY, ranges.length) },
    () => worker(),
  ));
  return pages.flat();
}

async function settlementCandidatesNearTrade(params, tip, timestampMs) {
  const centerBlock = GmgnEvmHolderResolver.estimatedBlockAtTimestamp(
    params.networkId,
    tip,
    timestampMs,
  );
  if (centerBlock === null) throw new Error("INVALID_FOMO_SWAP_TIMESTAMP");
  const range = GmgnEvmHolderResolver.tradeLogRange(centerBlock, tip);
  const buyLogs = await fetchEvmLogs(params, 0, range.fromBlock, range.toBlock);
  const candidates = GmgnEvmHolderResolver.candidateAddresses(buyLogs, [], params);
  if (candidates.length > GmgnEvmHolderResolver.MAX_CANDIDATES) {
    throw new Error("HOLDER_CHAIN_CANDIDATE_LIMIT");
  }
  return candidates;
}

async function getInitialBlockscoutSnapshot(params) {
  const key = tokenCacheId(params);
  const cached = blockscoutSnapshotsByToken.get(key);
  if (cached && Date.now() - cached.cachedAt <= BLOCKSCOUT_SNAPSHOT_CACHE_MS) {
    return cached.promise;
  }

  const promise = Promise.all([
    fetchPublicJson(GmgnEvmHolderResolver.buildBlockscoutTokenRequest(params)),
    fetchPublicJson(GmgnEvmHolderResolver.buildBlockscoutHoldersRequest(params, null)),
  ]).then(([token, holders]) => ({ token, holders }));
  setBoundedCache(blockscoutSnapshotsByToken, key, { cachedAt: Date.now(), promise }, BLOCKSCOUT_SNAPSHOT_CACHE_MS, 32);
  promise.catch(() => {
    if (blockscoutSnapshotsByToken.get(key)?.promise === promise) {
      blockscoutSnapshotsByToken.delete(key);
    }
  });
  return promise;
}

async function resolveEvmHolderFromBlockscout(params, currentAmountRaw) {
  const initial = await getInitialBlockscoutSnapshot(params);
  const token = initial.token;
  const decimals = GmgnEvmHolderResolver.blockscoutTokenDecimals(token);
  const targetRawAmount = GmgnFomoCore.decimalToUnits(currentAmountRaw, decimals);
  if (targetRawAmount === null) throw new Error("HOLDER_AMOUNT_PRECISION_MISMATCH");
  const target = BigInt(targetRawAmount);
  const matches = new Set();
  let nextPageParams = null;
  let previousBalance = null;
  let complete = false;

  for (let page = 0; page < GmgnEvmHolderResolver.MAX_HOLDER_PAGES; page += 1) {
    const payload = page === 0
      ? initial.holders
      : await fetchPublicJson(
        GmgnEvmHolderResolver.buildBlockscoutHoldersRequest(params, nextPageParams),
      );
    const holderPage = GmgnEvmHolderResolver.blockscoutHolderPage(payload, params);
    for (const row of holderPage.rows) {
      const balance = BigInt(row.balanceRaw);
      if (previousBalance !== null && balance > previousBalance) {
        throw new Error("BLOCKSCOUT_HOLDERS_UNSORTED");
      }
      previousBalance = balance;
      if (row.isWallet && balance === target) matches.add(row.address);
    }
    if (matches.size > 1) throw new Error("HOLDER_CHAIN_DATA_AMBIGUOUS");
    if (!holderPage.rows.length
      || !holderPage.nextPageParams
      || previousBalance < target) {
      complete = true;
      break;
    }
    nextPageParams = holderPage.nextPageParams;
  }

  if (!complete) throw new Error("BLOCKSCOUT_HOLDER_PAGE_LIMIT");
  if (!matches.size) throw new Error("HOLDER_CHAIN_DATA_NOT_FOUND");
  return [...matches][0];
}

async function resolveEvmCandidateAddress(params, candidates, tipHex, targetRawAmount) {
  if (!candidates.length) throw new Error("HOLDER_CHAIN_DATA_NOT_FOUND");
  const requests = GmgnEvmHolderResolver.balanceRequests(params, candidates, tipHex);
  const responses = [];
  for (let index = 0; index < requests.length; index += 100) {
    responses.push(...await evmRpcBatch(params.networkId, requests.slice(index, index + 100)));
  }
  const address = GmgnEvmHolderResolver.uniqueBalanceMatch(
    candidates,
    responses,
    targetRawAmount,
    2,
  );
  const code = await evmRpcCall(params.networkId, "eth_getCode", [address, tipHex]);
  if (GmgnEvmHolderResolver.classifyWalletCode(code) === "contract") {
    throw new Error("HOLDER_CHAIN_ADDRESS_IS_CONTRACT");
  }
  return address;
}

async function resolveEvmHolderFromChain(params, currentAmountRaw, buyTimestampMs = null) {
  if (!Number.isFinite(buyTimestampMs) || buyTimestampMs <= 0) {
    throw new Error("HOLDER_TRADE_TIMESTAMP_NOT_FOUND");
  }
  const tipHex = await evmRpcCall(params.networkId, "eth_blockNumber", []);
  const tip = GmgnEvmHolderResolver.parseRpcQuantity(tipHex);
  if (tip === null) throw new Error("EVM_RPC_INVALID_BLOCK");

  const decimalsHex = await evmRpcCall(params.networkId, "eth_call", [{
    to: params.address,
    data: GmgnEvmHolderResolver.DECIMALS_DATA,
  }, tipHex]);
  const decimals = GmgnEvmHolderResolver.tokenDecimals(decimalsHex);
  const targetRawAmount = GmgnFomoCore.decimalToUnits(currentAmountRaw, decimals);
  if (targetRawAmount === null) throw new Error("HOLDER_AMOUNT_PRECISION_MISMATCH");

  const nearbyCandidates = await settlementCandidatesNearTrade(
    params,
    tip,
    buyTimestampMs,
  );
  return resolveEvmCandidateAddress(
    params,
    nearbyCandidates,
    tipHex,
    targetRawAmount,
  );
}

async function queryFomoToken(params, allowSessionRefresh = true) {
  const requests = GmgnFomoApi.buildRequests(params);
  const [session, cached] = await Promise.all([getSession(), getCachedToken(params)]);
  if (!session?.authorization) {
    return cached ? cachedResult(cached, "FOMO_NOT_CONNECTED") : { ok: false, error: "FOMO_NOT_CONNECTED" };
  }

  try {
    const feedPromise = fetchJson(requests.feed, session).then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );
    const [metadataResult, holdersResult] = await Promise.allSettled([
      fetchJson(requests.metadata, session),
      fetchJson(requests.holders, session),
    ]);
    const criticalResults = [metadataResult, holdersResult];
    const unauthorized = criticalResults.find((result) => (
      result.status === "rejected" && result.reason?.message === "HTTP_401"
    ));
    if (unauthorized) throw unauthorized.reason;

    const freshMetadata = metadataResult.status === "fulfilled"
      ? GmgnFomoApi.sanitizeMetadata(metadataResult.value, params)
      : null;
    const metadata = freshMetadata || cached?.data?.metadata;
    const freshHolders = holdersResult.status === "fulfilled" && metadata
      ? GmgnFomoApi.sanitizeHolders(holdersResult.value, params, metadata.totalSupply)
      : null;
    const holders = freshHolders || cached?.data?.holders;
    const feedResult = await Promise.race([
      feedPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), FOMO_FEED_INITIAL_WAIT_MS)),
    ]);
    const freshFeed = feedResult?.status === "fulfilled"
      ? GmgnFomoApi.sanitizeFeed(feedResult.value)
      : null;
    const feed = freshFeed || cached?.data?.feed || [];
    const firstFailure = criticalResults.find((result) => result.status === "rejected")?.reason
      || feedResult?.reason;

    if (!metadata || !holders) {
      if (cached) return cachedResult(cached, firstFailure?.message || "TOKEN_NOT_FOUND");
      if (firstFailure) throw firstFailure;
      if (!freshMetadata) return { ok: false, error: "TOKEN_NOT_FOUND" };
      throw new Error("FOMO_REQUEST_FAILED");
    }

    const data = {
      metadata,
      holders,
      feed,
    };
    const criticalSectionsFresh = Boolean(freshMetadata && freshHolders);
    const cachedSections = [
      ...(!freshMetadata ? ["metadata"] : []),
      ...(!freshHolders ? ["holders"] : []),
      ...(!freshFeed && cached?.data?.feed ? ["feed"] : []),
    ];
    if (criticalSectionsFresh) await cacheToken(params, data).catch(() => {});
    if (!feedResult) {
      feedPromise.then(async (settledFeed) => {
        if (settledFeed.status !== "fulfilled") {
          if (settledFeed.reason?.message === "HTTP_401" && allowSessionRefresh) {
            refreshSessionInBackground(session.authorization).catch(() => null);
          }
          return;
        }
        if (!criticalSectionsFresh) return;
        const latest = await getCachedToken(params).catch(() => null);
        if (!latest?.data?.metadata || !latest?.data?.holders) return;
        await cacheToken(params, {
          ...latest.data,
          feed: GmgnFomoApi.sanitizeFeed(settledFeed.value),
        }).catch(() => {});
      }).catch(() => {});
      return {
        ok: true,
        data,
        cached: false,
        partial: true,
        pendingSections: ["feed"],
        ...(cachedSections.length ? { cachedSections } : {}),
      };
    }
    if (feedResult.status === "rejected") {
      if (feedResult.reason?.message === "HTTP_401" && allowSessionRefresh) {
        refreshSessionInBackground(session.authorization).catch(() => null);
      }
      return {
        ok: true,
        data,
        cached: false,
        partial: true,
        failedSections: ["feed"],
        ...(cachedSections.length ? { cachedSections } : {}),
      };
    }
    if (!cachedSections.length) {
      return { ok: true, data, cached: false };
    }
    return { ok: true, data, cached: false, partial: true, cachedSections };
  } catch (error) {
    const reason = error?.message || "FOMO_REQUEST_FAILED";
    if (reason === "HTTP_401" && allowSessionRefresh) {
      if (cached) {
        refreshSessionInBackground(session.authorization).catch(() => null);
        return cachedResult(cached, reason);
      }
      refreshSessionInBackground(session.authorization)
        .then((replacement) => {
          if (replacement?.authorization) queryFomoToken(params, false).catch(() => null);
        })
        .catch(() => null);
      return { ok: false, error: "FOMO_SESSION_REFRESHING" };
    }
    if (reason === "HTTP_401") {
      await clearSession().catch(() => {});
    }
    if (cached) return cachedResult(cached, reason);
    throw error;
  }
}

function queryFomoTokenShared(params) {
  const key = tokenCacheId(params);
  const pending = fomoRequestsByToken.get(key);
  if (pending && Date.now() - pending.startedAt < FOMO_SHARED_REQUEST_MAX_AGE_MS) {
    return pending.promise;
  }
  const entry = { startedAt: Date.now(), promise: null };
  entry.promise = queryFomoToken(params).finally(() => {
    if (fomoRequestsByToken.get(key) === entry) fomoRequestsByToken.delete(key);
  });
  fomoRequestsByToken.set(key, entry);
  return entry.promise;
}

function gmgnFailureAllowsChainFallback(error, responseWasFulfilled) {
  if (!responseWasFulfilled) return true;
  return new Set([
    "HOLDER_CHAIN_DATA_NOT_FOUND",
    "HOLDER_CHAIN_ACTIVITY_MISMATCH",
    "HOLDER_CHAIN_DATA_AMBIGUOUS",
  ]).has(error?.message);
}

function blockscoutFailureAllowsRpcFallback(error) {
  return /^(HTTP_|BLOCKSCOUT_|INVALID_TOKEN_DECIMALS$)/.test(error?.message || "")
    || ["AbortError", "TypeError", "SyntaxError"].includes(error?.name);
}

async function resolveFomoHolderAddress(
  params,
  holder,
  allowSessionRefresh = true,
  gmgnTabId = null,
) {
  const cacheKey = holderAddressCacheId(params, holder);
  const cachedAddress = getResolvedHolderAddress(cacheKey);
  if (cachedAddress) return { ok: true, address: cachedAddress, source: "cache" };

  const tradeRequest = GmgnFomoApi.buildTradeRequest(params, holder);
  const gmgnRequest = GmgnFomoApi.buildGmgnHoldersRequest(params);
  const session = await getSession();
  if (!session?.authorization) return { ok: false, error: "FOMO_NOT_CONNECTED" };

  try {
    const gmgnPayloadPromise = fetchGmgnJson(gmgnRequest, gmgnTabId).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    const amountHint = GmgnFomoCore.decimalString(holder?.humanAmountRaw ?? holder?.humanAmount);
    const blockscoutPromise = GmgnEvmHolderResolver.hasHolderApi(params.networkId) && amountHint !== null
      ? resolveEvmHolderFromBlockscout(params, amountHint).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      )
      : null;
    const tradePayload = await fetchJson(tradeRequest, session);
    const trade = GmgnFomoApi.sanitizeHolderTrade(tradePayload, params, holder);
    let gmgnResponseWasFulfilled = false;

    const attempts = [gmgnPayloadPromise.then((result) => {
      if (!result.ok) throw result.error;
      gmgnResponseWasFulfilled = true;
      return {
        address: GmgnFomoApi.sanitizeVerifiedHolderAddress(
          tradePayload,
          result.value,
          params,
          holder,
        ),
        source: "gmgn",
      };
    })];
    if (blockscoutPromise) {
      attempts.push(blockscoutPromise.then((result) => {
        if (!result.ok) throw result.error;
        return { address: result.value, source: "chain" };
      }));
    }

    try {
      const match = await Promise.any(attempts);
      cacheResolvedHolderAddress(cacheKey, match.address);
      return { ok: true, ...match };
    } catch (aggregateError) {
      const errors = aggregateError?.errors || [];
      const gmgnError = errors[0] || aggregateError;
      const blockscoutError = errors[1] || null;
      if (!GmgnEvmHolderResolver.isSupported(params.networkId)
        || !gmgnFailureAllowsChainFallback(gmgnError, gmgnResponseWasFulfilled)) {
        throw gmgnError;
      }
      if (blockscoutError && !blockscoutFailureAllowsRpcFallback(blockscoutError)) {
        throw blockscoutError;
      }
    }

    const address = await resolveEvmHolderFromChain(
      params,
      trade.currentAmountRaw,
      trade.buyTimestampMs,
    );
    cacheResolvedHolderAddress(cacheKey, address);
    return { ok: true, address, source: "chain" };
  } catch (error) {
    const reason = error?.message || "FOMO_REQUEST_FAILED";
    if (reason === "HTTP_401" && allowSessionRefresh) {
      const replacement = await refreshSessionInBackground(session.authorization).catch(() => null);
      if (replacement?.authorization) {
        return resolveFomoHolderAddress(params, holder, false, gmgnTabId);
      }
    }
    if (reason === "HTTP_401") await clearSession().catch(() => {});
    throw error;
  }
}

function resolveFomoHolderAddressShared(params, holder, gmgnTabId = null) {
  const key = `fomo:${holderAddressCacheId(params, holder)}`;
  const pending = holderAddressRequests.get(key);
  if (pending) return pending;
  const request = resolveFomoHolderAddress(params, holder, true, gmgnTabId).finally(() => {
    if (holderAddressRequests.get(key) === request) holderAddressRequests.delete(key);
  });
  holderAddressRequests.set(key, request);
  return request;
}

async function ensureOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl],
  });
  if (contexts.length) return;
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["CLIPBOARD", "WORKERS"],
      justification: "Copy wallet addresses and maintain realtime subscriptions",
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }
  await creatingOffscreenDocument;
}

async function getPumpNatsConfig() {
  if (pumpNatsConfigSnapshot
    && Date.now() - pumpNatsConfigSnapshot.cachedAt < PUMP_NATS_CONFIG_CACHE_MS) {
    return pumpNatsConfigSnapshot.config;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(PUMP_NATS_CONFIG_URL, {
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const config = GmgnPumpApi.parseCoreNatsConfig(await response.text());
    if (!config) throw new Error("PUMP_NATS_CONFIG_INVALID");
    pumpNatsConfigSnapshot = { cachedAt: Date.now(), config };
    return config;
  } finally {
    clearTimeout(timeout);
  }
}

function serializePumpAlertsPresence(operation) {
  const request = pumpAlertsPresenceOperation.then(operation);
  pumpAlertsPresenceOperation = request.catch(() => {});
  return request;
}

function registerPumpAlertsPresence(preferredTabId) {
  if (pumpAlertsPresenceRequest) return pumpAlertsPresenceRequest;
  const generation = pumpAlertsPresenceGeneration;
  const request = serializePumpAlertsPresence(async () => {
    const payload = await fetchPumpAuthenticatedJson(
      GmgnPumpApi.buildPresenceRequest(),
      preferredTabId,
    );
    if (generation !== pumpAlertsPresenceGeneration) {
      throw new Error("PUMP_PRESENCE_CANCELLED");
    }
    const subject = GmgnPumpApi.sanitizeAlertsSubject(payload?.subject);
    if (!subject) throw new Error("PUMP_PRESENCE_INVALID");
    pumpAlertsPresenceSnapshot = {
      payload,
      subject,
      refreshAt: Date.now() + GmgnPumpApi.presenceRefreshMs(payload),
    };
    return pumpAlertsPresenceSnapshot;
  }).finally(() => {
    if (pumpAlertsPresenceRequest === request) pumpAlertsPresenceRequest = null;
  });
  pumpAlertsPresenceRequest = request;
  return request;
}

async function configurePumpAlertsSubject(subject, generation) {
  if (!subject || subject === pumpNatsSubscriptionKey) return;
  if (pumpNatsSubscriptionKey && pumpNatsSubscriptionKey.split(".")[2] !== subject.split(".")[2]) {
    gmgnTradeDelivery.discard((item) => item.platform === "pump");
  }
  const config = await getPumpNatsConfig();
  if (!followedTradesEnabled || generation !== pumpAlertsPresenceGeneration) return;
  await ensureOffscreenDocument();
  if (!followedTradesEnabled || generation !== pumpAlertsPresenceGeneration) return;
  const result = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "configurePumpNats",
    config,
    subjects: [subject],
    diagnosticsEnabled: await getFollowedTradesDiagnosticsEnabled(),
  });
  if (!followedTradesEnabled || generation !== pumpAlertsPresenceGeneration) return;
  if (!result?.ok) throw new Error("PUMP_NATS_CONFIGURE_FAILED");
  pumpNatsSubscriptionKey = subject;
}

function clearPumpAlertsPresenceRefreshTimer() {
  if (pumpAlertsPresenceRefreshTimer !== null) {
    clearTimeout(pumpAlertsPresenceRefreshTimer);
  }
  pumpAlertsPresenceRefreshTimer = null;
}

function schedulePumpAlertsPresenceRefresh(presence) {
  clearPumpAlertsPresenceRefreshTimer();
  if (!followedTradesEnabled || !hasFollowedTradeConsumers()) return;
  const delay = Math.max(1_000, presence.refreshAt - Date.now());
  pumpAlertsPresenceRefreshTimer = setTimeout(() => {
    pumpAlertsPresenceRefreshTimer = null;
    ensurePumpNatsSubscriptions(undefined, true).catch((error) => {
      recordPumpRealtimeDiagnostic(pumpNatsConnectionStatus, {
        error: diagnosticError(error?.message) || "PUMP_PRESENCE_REFRESH_FAILED",
      });
    });
  }, delay);
}

function ensurePumpNatsSubscriptions(_following, force = false) {
  if (pumpSubscriptionRequest) return pumpSubscriptionRequest;
  const generation = pumpAlertsPresenceGeneration;
  const request = (async () => {
    if (!await getFollowedTradesEnabled()) return;
    try {
      const presence = !force && pumpAlertsPresenceSnapshot
        && Date.now() < pumpAlertsPresenceSnapshot.refreshAt
        ? pumpAlertsPresenceSnapshot : await registerPumpAlertsPresence();
      if (!followedTradesEnabled || generation !== pumpAlertsPresenceGeneration) return;
      await configurePumpAlertsSubject(presence.subject, generation);
      if (!followedTradesEnabled || generation !== pumpAlertsPresenceGeneration) return;
      pumpSubscriptionRetryCount = 0;
      recordPumpRealtimeDiagnostic(pumpNatsConnectionStatus, { error: "" });
      schedulePumpAlertsPresenceRefresh(presence);
    } catch (error) {
      if (!followedTradesEnabled || generation !== pumpAlertsPresenceGeneration) return;
      recordPumpRealtimeDiagnostic(pumpNatsConnectionStatus, {
        error: error?.message || "PUMP_SUBSCRIPTION_FAILED",
      });
      // Retry network/session recovery without depending on the diagnostic page's poll.
      // Keep recovering at a bounded rate, as the website does after failed heartbeats.
      const delays = [1_000, 5_000, 15_000, 30_000, 60_000];
      const delay = delays[Math.min(pumpSubscriptionRetryCount++, delays.length - 1)];
      clearPumpAlertsPresenceRefreshTimer();
      if (delay !== undefined && hasFollowedTradeConsumers()) {
        pumpAlertsPresenceRefreshTimer = setTimeout(() => {
          pumpAlertsPresenceRefreshTimer = null;
          ensurePumpNatsSubscriptions(undefined, true).catch(() => {});
        }, delay);
      }
      throw error;
    }
  })().finally(() => {
    if (pumpSubscriptionRequest === request) pumpSubscriptionRequest = null;
  });
  pumpSubscriptionRequest = request;
  return request;
}

function stopPumpNatsSubscriptions() {
  const hadPresence = Boolean(
    pumpAlertsPresenceSnapshot || pumpAlertsPresenceRequest || pumpNatsSubscriptionKey,
  );
  pumpAlertsPresenceGeneration += 1;
  if (pumpAlertsReconcileTimer !== null) clearTimeout(pumpAlertsReconcileTimer);
  pumpAlertsReconcileTimer = null;
  pumpAlertsReconcileRequest = null;
  pumpAlertsReconcileAt = 0;
  pumpAlertsStartedAt = 0;
  pumpProfilePollCursor = 0;
  pumpAlertsReconcileError = "";
  pumpSubscriptionRequest = null;
  pumpSubscriptionRetryCount = 0;
  clearPumpAlertsPresenceRefreshTimer();
  pumpAlertsPresenceSnapshot = null;
  pumpNatsSubscriptionKey = "";
  pumpNatsHadConnected = false;
  if (pumpNatsTradeBatchTimer !== null) clearTimeout(pumpNatsTradeBatchTimer);
  pumpNatsTradeBatchTimer = null;
  pumpNatsTradeBatch = [];
  seenPumpNatsEventIds.clear();
  seenPumpRestTradeKeys.clear();
  seenPumpRestTradeOrder.length = 0;
  pumpRestBaselineReady = false;
  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "configurePumpNats",
    config: null,
    subjects: [],
  }).catch(() => {});
  if (hadPresence && typeof GmgnPumpApi.buildPresenceDeleteRequest === "function") {
    serializePumpAlertsPresence(() => fetchPumpAuthenticatedJson(
      GmgnPumpApi.buildPresenceDeleteRequest(),
    )).catch(() => {});
  }
}

async function copyHolderAddress(address, networkId) {
  const normalized = GmgnFomoCore.normalizeWalletAddress(address, networkId);
  if (!normalized) throw new Error("INVALID_HOLDER_ADDRESS");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await ensureOffscreenDocument();
      const result = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "copyToClipboard",
        text: normalized,
      });
      if (result?.ok) return { ok: true, address: normalized };
    } catch {
      if (attempt > 0) throw new Error("CLIPBOARD_WRITE_FAILED");
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("CLIPBOARD_WRITE_FAILED");
}

async function resolvePumpHolderAddress(params, holder) {
  const userId = typeof holder?.userId === "string" ? holder.userId.trim() : "";
  if (!userId || !Number.isInteger(params?.networkId)) {
    throw new Error("INVALID_PUMP_USER");
  }
  const cacheKey = `pump:${params.networkId}:${userId}`;
  const cachedAddress = getResolvedHolderAddress(cacheKey);
  if (cachedAddress) return { ok: true, address: cachedAddress, source: "cache" };

  const payload = await fetchPublicJson(GmgnPumpApi.buildUserRequest(userId));
  const address = GmgnPumpApi.sanitizeUserWallet(payload, params.networkId);
  if (!address) throw new Error("PUMP_WALLET_NOT_FOUND");
  cacheResolvedHolderAddress(cacheKey, address);
  return { ok: true, address, source: "pump" };
}

function resolvePumpHolderAddressShared(params, holder) {
  const userId = typeof holder?.userId === "string" ? holder.userId.trim() : "";
  const key = `pump:${Number(params?.networkId)}:${userId}`;
  const pending = holderAddressRequests.get(key);
  if (pending) return pending;
  const request = resolvePumpHolderAddress(params, holder).finally(() => {
    if (holderAddressRequests.get(key) === request) holderAddressRequests.delete(key);
  });
  holderAddressRequests.set(key, request);
  return request;
}

async function queryPumpHolders(params) {
  return fetchPublicJson(GmgnPumpApi.buildPositionsRequest(params));
}

function queryPumpHoldersShared(params) {
  const key = tokenCacheId(params);
  const pending = pumpHolderRequestsByToken.get(key);
  if (pending) return pending;
  const request = queryPumpHolders(params).finally(() => {
    if (pumpHolderRequestsByToken.get(key) === request) pumpHolderRequestsByToken.delete(key);
  });
  pumpHolderRequestsByToken.set(key, request);
  return request;
}

function isFomoAuthError(error) {
  return ["HTTP_401", "HTTP_403", "HTTP_430"].includes(error?.message);
}

async function enrichFomoFollowedTrades(items, session) {
  const cachedMetadata = [];
  const missingMetadataItems = [];
  for (const item of items) {
    const currentSupply = GmgnFomoCore.finiteNumber(item?.totalSupply);
    if (currentSupply !== null && currentSupply > 0 && item?.tokenImageUrl) continue;
    if (!GmgnFomoCore.validTokenAddress(item?.tokenAddress)
      || !Number.isInteger(Number(item?.networkId))) continue;
    const key = `${item.tokenAddress.startsWith("0x") ? item.tokenAddress.toLowerCase() : item.tokenAddress}:${item.networkId}`;
    const cached = fomoFollowedMetadataCache.get(key);
    if (cached && Date.now() - cached.cachedAt < FOMO_FOLLOWED_METADATA_CACHE_MS) {
      cachedMetadata.push(cached.item);
    } else {
      if (cached) fomoFollowedMetadataCache.delete(key);
      missingMetadataItems.push(item);
    }
  }
  let enriched = GmgnFomoApi.withFollowedTradesMetadata(items, cachedMetadata);
  const metadataRequest = GmgnFomoApi.buildFollowedTradesMetadataRequest(missingMetadataItems);
  if (!metadataRequest) return enriched;
  try {
    const requestKey = metadataRequest.body || metadataRequest.url;
    let pending = fomoFollowedMetadataRequests.get(requestKey);
    if (!pending) {
      pending = fetchJson(
        { ...metadataRequest, timeoutMs: FOMO_FOLLOWED_TIMEOUT_MS },
        session,
      ).then((metadataPayload) => {
        const metadata = GmgnFomoApi.sanitizeFollowedTradesMetadata(metadataPayload);
        for (const item of metadata) {
          setBoundedCache(fomoFollowedMetadataCache, item.key, { cachedAt: Date.now(), item }, FOMO_FOLLOWED_METADATA_CACHE_MS, 512);
        }
        return metadata;
      }).finally(() => {
        if (fomoFollowedMetadataRequests.get(requestKey) === pending) {
          fomoFollowedMetadataRequests.delete(requestKey);
        }
      });
      fomoFollowedMetadataRequests.set(requestKey, pending);
    }
    const metadata = await pending;
    enriched = GmgnFomoApi.withFollowedTradesMetadata(enriched, metadata);
  } catch (error) {
    if (isFomoAuthError(error)) throw error;
  }
  return enriched;
}

function withCachedFomoFollowedTradesMetadata(items) {
  const cachedMetadata = [];
  const now = Date.now();
  for (const item of Array.isArray(items) ? items : []) {
    if (!GmgnFomoCore.validTokenAddress(item?.tokenAddress)
      || !Number.isInteger(Number(item?.networkId))) continue;
    const address = item.tokenAddress.startsWith("0x")
      ? item.tokenAddress.toLowerCase()
      : item.tokenAddress;
    const cached = fomoFollowedMetadataCache.get(`${address}:${item.networkId}`);
    if (cached && now - cached.cachedAt < FOMO_FOLLOWED_METADATA_CACHE_MS) {
      cachedMetadata.push(cached.item);
    }
  }
  return GmgnFomoApi.withFollowedTradesMetadata(items, cachedMetadata);
}

async function fetchFomoFollowedTradePages(session) {
  const knownKeys = new Set(followedTradesHistory.fomo.map(GmgnFollowTrades.stableKey));
  const items = [];
  const seenCursors = new Set();
  let cursor = "";
  for (let page = 0; page < GmgnFomoApi.FOLLOWED_TRADES_MAX_PAGES; page += 1) {
    const request = GmgnFomoApi.buildFollowedTradesRequest(cursor);
    let payload;
    try {
      payload = await fetchJson({ ...request, timeoutMs: FOMO_FOLLOWED_TIMEOUT_MS }, session);
    } catch (error) {
      if (page === 0 || isFomoAuthError(error)) throw error;
      break;
    }
    const pageItems = GmgnFomoApi.sanitizeFollowedTrades(payload).map((item) => ({
      ...item,
      sourceVerification: FOMO_FOLLOWED_TRADE_VERIFICATION,
    }));
    items.push(...pageItems);
    if (pageItems.some((item) => knownKeys.has(GmgnFollowTrades.stableKey(item)))) break;
    const nextCursor = GmgnFomoApi.followedTradesNextCursor(payload);
    if (!knownKeys.size || !nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return GmgnFollowTrades.mergeFollowedTrades(items);
}

async function queryFomoFollowedTrades(allowSessionRefresh = true, force = false) {
  if (!force && fomoAlertRestSnapshot
    && Date.now() - fomoAlertRestSnapshot.cachedAt < FOMO_ALERT_REST_CACHE_MS) {
    recordFollowedTradePipeline("fomo-rest-cache", fomoAlertRestSnapshot.items, {
      cacheAgeMs: Date.now() - fomoAlertRestSnapshot.cachedAt,
      count: fomoAlertRestSnapshot.items.length,
      force,
    });
    return fomoAlertRestSnapshot.items;
  }
  const startedAt = Date.now();
  recordFollowedTradePipeline("fomo-rest-request", [], { force });
  const session = await getSession();
  if (!session?.authorization) {
    recordFollowedTradePipeline("fomo-rest-error", [], {
      durationMs: Date.now() - startedAt,
      error: "FOMO_NOT_CONNECTED",
      force,
    });
    throw new Error("FOMO_NOT_CONNECTED");
  }
  try {
    const items = await enrichFomoFollowedTrades(
      await fetchFomoFollowedTradePages(session),
      session,
    );
    fomoAlertRestSnapshot = { cachedAt: Date.now(), items };
    recordFollowedTradePipeline("fomo-rest-response", items, {
      count: items.length,
      durationMs: Date.now() - startedAt,
      force,
    });
    return items;
  } catch (error) {
    if (error?.message === "HTTP_401" && allowSessionRefresh) {
      const replacement = await refreshSessionInBackground(session.authorization).catch(() => null);
      if (replacement?.authorization) {
        fomoAlertRestSnapshot = null;
        ensureFomoAlertSocket(true).catch(() => {});
        return queryFomoFollowedTrades(false, true);
      }
    }
    recordFollowedTradePipeline("fomo-rest-error", [], {
      durationMs: Date.now() - startedAt,
      error: error?.message || "FOMO_REQUEST_FAILED",
      force,
    });
    if (isFomoAuthError(error)) {
      await clearSession().catch(() => {});
      throw new Error("FOMO_SESSION_EXPIRED");
    }
    throw error;
  }
}

// Alerts identify EVM traders by their Pump/Solana profile address. Resolve that
// identity from Pump itself; never pass a profile address off as an EVM wallet.
async function getPumpAlertUser(profileAddress) {
  const cached = pumpAlertUserCache.get(profileAddress);
  if (cached && Date.now() - cached.cachedAt < PUMP_ALERT_USER_CACHE_MS) return cached.payload;
  if (pumpAlertUserRequests.has(profileAddress)) return pumpAlertUserRequests.get(profileAddress);
  const request = fetchPublicJson(GmgnPumpApi.buildUserRequest(profileAddress)).then((payload) => {
    setBoundedCache(pumpAlertUserCache, profileAddress, { payload, cachedAt: Date.now() }, PUMP_ALERT_USER_CACHE_MS, 256);
    return payload;
  }).finally(() => pumpAlertUserRequests.delete(profileAddress));
  pumpAlertUserRequests.set(profileAddress, request);
  return request;
}

async function resolvePumpAlertWallet(row) {
  const core = GmgnFomoCore;
  const rawChain = row?.chainId ?? row?.coin?.chainId;
  const networkId = Number(rawChain) || core.TOKEN_NETWORK_IDS[rawChain];
  if (networkId === core.TOKEN_NETWORK_IDS.sol || !Object.values(core.TOKEN_NETWORK_IDS).includes(networkId)) return row;
  const wallet = row?.walletAddress ?? row?.author?.walletAddress;
  if (core.normalizeWalletAddress(wallet, networkId)) return row;
  const profileAddress = core.normalizeWalletAddress(wallet, core.TOKEN_NETWORK_IDS.sol);
  if (!profileAddress) return row;
  const user = await getPumpAlertUser(profileAddress);
  if (user?.canonical_svm_wallet !== profileAddress
    || (row?.author?.userId && user?.userId !== row.author.userId)) return row;
  const evmWallet = core.normalizeWalletAddress(user?.canonical_evm_wallet, networkId);
  if (!evmWallet) return row;
  return { ...row, walletAddress: evmWallet,
    author: { ...row.author, walletAddress: evmWallet } };
}

async function normalizePumpAlertPage(payload) {
  const rows = Array.isArray(payload?.items) ? payload.items : [];
  const resolved = await mapSettledWithConcurrency(rows, PUMP_PROFILE_CONCURRENCY, resolvePumpAlertWallet);
  return GmgnPumpApi.sanitizeFollowedTrades({ ...payload,
    items: resolved.map((result, index) => result.status === "fulfilled" ? result.value : rows[index]) });
}

async function fetchPumpFollowedTradePages(fetchPage, firstPayload = null, maxPages = GmgnPumpApi.FOLLOWED_TRADES_MAX_PAGES) {
  const items = [];
  const seenCursors = new Set();
  let cursor = "";
  let payload = firstPayload;
  for (let page = 0; page < maxPages; page += 1) {
    if (!payload) {
      payload = await fetchPage(GmgnPumpApi.buildFollowedTradesRequest(cursor));
    }
    items.push(...await normalizePumpAlertPage(payload));
    const nextCursor = GmgnPumpApi.followedTradesNextCursor(payload);
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
    payload = null;
  }
  return GmgnFollowTrades.mergeFollowedTrades(items);
}

async function queryPumpAlertTrades(firstPageOnly = false) {
  const maxPages = firstPageOnly ? 1 : GmgnPumpApi.FOLLOWED_TRADES_MAX_PAGES;
  try {
    return await fetchPumpFollowedTradePages(fetchPublicJson, null, maxPages);
  } catch (error) {
    const reason = error?.message || "";
    if (/^HTTP_(401|403)$/.test(reason)) {
      const tab = await pumpPageTab();
      if (Number.isInteger(tab?.id)) {
        try {
          return await fetchPumpFollowedTradePages(
            (request) => fetchPumpJsonFromPage(request, tab.id),
            null, maxPages,
          );
        } catch (pageError) {
          if (/^HTTP_(401|403)$/.test(pageError?.message || "")) {
            throw new Error("PUMP_SESSION_EXPIRED");
          }
          throw pageError;
        }
      }
      throw new Error("PUMP_SESSION_REQUIRED");
    }
    throw error;
  }
}

function schedulePumpAlertsReconciliation() {
  if (pumpAlertsReconcileTimer !== null) clearTimeout(pumpAlertsReconcileTimer);
  pumpAlertsReconcileTimer = null;
  if (!followedTradesEnabled || !visibleGmgnTradePorts.size || pumpAlertsReconcileRequest) return;
  const delay = pumpAlertsReconcileAt
    ? Math.max(0, pumpAlertsReconcileAt + PUMP_ALERTS_RECONCILE_MS - Date.now()) : 0;
  pumpAlertsReconcileTimer = setTimeout(() => {
    pumpAlertsReconcileTimer = null;
    reconcilePumpAlerts("alerts-rest-poll").catch(() => {});
  }, delay);
}

function reconcilePumpAlerts(transport = "alerts-rest-reconnect") {
  if (pumpAlertsReconcileRequest) return pumpAlertsReconcileRequest;
  if (!followedTradesEnabled || !hasFollowedTradeConsumers()) return Promise.resolve();
  const generation = pumpAlertsPresenceGeneration;
  if (!pumpAlertsStartedAt) pumpAlertsStartedAt = Date.now();
  const request = (async () => {
    // Keep Alerts delivery independent of slower profile indexing/RPC checks.
    const profileCheck = reconcilePumpProfileGaps(generation).catch(() => {});
    try {
      const items = await queryPumpAlertTrades(true);
      if (!followedTradesEnabled || generation !== pumpAlertsPresenceGeneration) return;
      await hydrateFollowedTradesHistory();
      if (!followedTradesEnabled || generation !== pumpAlertsPresenceGeneration) return;
      recordFollowedTradePipeline("pump-source-response", items, { transport, count: items.length });
      const freshItems = observePumpRestItems(items, pumpAlertsStartedAt);
      rememberFollowedTrades("pump", filterUnfollowedTrades(items));
      if (freshItems.length) await publishPumpRestDeltaItems(freshItems, transport, generation);
      pumpAlertsReconcileError = "";
    } catch (error) {
      if (generation !== pumpAlertsPresenceGeneration) return;
      pumpAlertsReconcileError = diagnosticError(error?.message) || "PUMP_ALERTS_RECONCILE_FAILED";
      recordTradeSourceEvent("pump-rest-error", { error: pumpAlertsReconcileError, transport });
    } finally {
      await profileCheck;
      if (pumpAlertsReconcileRequest === request) {
        pumpAlertsReconcileRequest = null;
        pumpAlertsReconcileAt = Date.now();
        schedulePumpAlertsReconciliation();
      }
    }
  })();
  pumpAlertsReconcileRequest = request;
  return request;
}

async function reconcilePumpProfileGaps(generation) {
  const active = () => followedTradesEnabled && hasFollowedTradeConsumers()
    && generation === pumpAlertsPresenceGeneration;
  if (!active()) return;
  const startedAt = pumpAlertsStartedAt;
  const identity = await queryPumpIdentity();
  if (!active()) return;
  if (!pumpProfileFollowingSnapshot || pumpProfileFollowingSnapshot.viewerWallet !== identity.viewerWallet
    || Date.now() - pumpProfileFollowingSnapshot.cachedAt >= PUMP_FOLLOWING_CACHE_MS) {
    const payload = await fetchPublicJson(GmgnPumpApi.buildFollowingRequest(identity.viewerWallet));
    if (!active()) return;
    pumpProfileFollowingSnapshot = { viewerWallet: identity.viewerWallet, cachedAt: Date.now(),
      items: GmgnPumpApi.sanitizeFollowing(payload) };
  }
  const following = pumpProfileFollowingSnapshot.items;
  if (!active() || !following.length) return;
  // A bounded rotating slice avoids an unbounded burst for large follow lists.
  const count = Math.min(following.length, PUMP_PROFILE_POLL_LIMIT);
  const selected = Array.from({ length: count }, (_, i) => following[(pumpProfilePollCursor + i) % following.length]);
  pumpProfilePollCursor = (pumpProfilePollCursor + count) % following.length;
  await mapSettledWithConcurrency(selected, PUMP_PROFILE_CONCURRENCY, async (entry) => {
    if (!active()) return;
    const user = await getPumpAlertUser(entry.address);
    if (!active() || user?.canonical_svm_wallet !== entry.address
      || (entry.userId && user?.userId !== entry.userId)) return;
    const author = GmgnPumpApi.withUserWallets(entry, user);
    if (!author.evmAddress) return;
    const payload = await fetchPublicJson(GmgnPumpApi.buildProfileTransactionsRequest(entry.address));
    if (!active()) return;
    const groups = GmgnPumpApi.profileTransferGroups(payload, author, "evm").filter((group) => (
      group.networkId !== GmgnFomoCore.TOKEN_NETWORK_IDS.sol
      && group.createdAt >= startedAt && Date.now() - group.createdAt < 60_000
      && group.createdAt <= Date.now() + 5_000
    ));
    if (!groups.length) return;
    const items = (await resolvePumpEvmProfileGroups(groups)).filter((item) => (
      item.sourceVerification === GmgnPumpApi.PUMP_CHAIN_RPC_VERIFICATION
      && item.usdAmount >= GmgnPumpApi.FOLLOWED_TRADES_MIN_USD
    ));
    if (!active()) return;
    await publishPumpCollectedItems(items, "profile-rpc-reconcile", GmgnPumpApi.PUMP_CHAIN_RPC_VERIFICATION, generation);
  });
}

function isPumpPresencePost(request) {
  return request.method === "POST"
    && request.url === PUMP_PRESENCE_URL;
}

async function fetchPumpPresenceInBackground(request) {
  pumpPresenceAuth.backgroundAttemptAt = Date.now();
  try {
    const payload = await fetchPublicJson(request);
    pumpPresenceAuth.backgroundError = "";
    pumpPresenceAuth.backgroundSuccessAt = Date.now();
    pumpPresenceAuth.lastSuccessTransport = "background";
    return payload;
  } catch (error) {
    pumpPresenceAuth.backgroundError = diagnosticError(error?.message) || "PUMP_REQUEST_FAILED";
    throw error;
  }
}

async function fetchPumpAuthenticatedJson(request, preferredTabId) {
  const presence = isPumpPresencePost(request);
  try {
    return await (presence ? fetchPumpPresenceInBackground(request) : fetchPublicJson(request));
  } catch (error) {
    if (!/^HTTP_(401|403)$/.test(error?.message || "")) throw error;
    const tab = await pumpPageTab(preferredTabId);
    if (!Number.isInteger(tab?.id)) throw new Error("PUMP_SESSION_REQUIRED");
    if (presence) pumpPresenceAuth.pageAttemptAt = Date.now();
    try {
      const payload = await fetchPumpJsonFromPage(request, tab.id);
      if (presence) {
        pumpPresenceAuth.pageError = "";
        pumpPresenceAuth.pageSuccessAt = Date.now();
        pumpPresenceAuth.lastSuccessTransport = "page";
      }
      return payload;
    } catch (pageError) {
      if (presence) pumpPresenceAuth.pageError = diagnosticError(pageError?.message) || "PUMP_PAGE_REQUEST_FAILED";
      if (/^HTTP_(401|403)$/.test(pageError?.message || "")) {
        throw new Error("PUMP_SESSION_EXPIRED");
      }
      throw pageError;
    }
  }
}

async function queryPumpIdentity() {
  if (pumpPresenceSnapshot && Date.now() < pumpPresenceSnapshot.refreshAt) {
    return pumpPresenceSnapshot;
  }
  const stored = await storedPumpIdentity();
  const tab = await pumpPageTab();
  if (stored && !Number.isInteger(tab?.id)) return useStoredPumpIdentity(stored);
  const pageIdentity = await pumpIdentityFromPage(tab?.id);
  if (pageIdentity) {
    if (stored?.viewerWallet && stored.viewerWallet !== pageIdentity.viewerWallet) {
      resetPumpAccountCaches();
    }
    const identity = {
      userId: stored?.viewerWallet === pageIdentity.viewerWallet ? stored.userId : "",
      viewerWallet: pageIdentity.viewerWallet,
    };
    await persistPumpIdentity(identity);
    return useStoredPumpIdentity(identity);
  }
  if (typeof GmgnPumpApi.buildPresenceRequest !== "function") {
    throw new Error("PUMP_PROFILE_UNAVAILABLE");
  }
  try {
    const presenceState = await registerPumpAlertsPresence(tab?.id);
    const presence = presenceState.payload;
    const userId = GmgnPumpApi.presenceUserId(presence);
    if (!userId) throw new Error("PUMP_PRESENCE_INVALID");
    const user = await fetchPublicJson(GmgnPumpApi.buildUserRequest(userId));
    const viewerWallet = GmgnPumpApi.sanitizeUserWallet(
      user,
      GmgnFomoCore.TOKEN_NETWORK_IDS.sol,
    );
    if (!viewerWallet) throw new Error("PUMP_VIEWER_WALLET_NOT_FOUND");
    if (stored?.viewerWallet && stored.viewerWallet !== viewerWallet) resetPumpAccountCaches();
    await persistPumpIdentity({ userId, viewerWallet });
    pumpPresenceSnapshot = {
      userId,
      viewerWallet,
      refreshAt: Date.now() + GmgnPumpApi.presenceRefreshMs(presence),
    };
    return pumpPresenceSnapshot;
  } catch (error) {
    if (stored) return useStoredPumpIdentity(stored);
    throw error;
  }
}

async function mapSettledWithConcurrency(items, limit, mapper) {
  const values = Array.isArray(items) ? items : [];
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await mapper(values[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  const workerCount = Math.min(Math.max(1, limit), values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function queryPumpFollowing(identity, force = false) {
  if (!force && pumpFollowingSnapshot
    && pumpFollowingSnapshot.viewerWallet === identity.viewerWallet
    && Date.now() - pumpFollowingSnapshot.cachedAt < PUMP_FOLLOWING_CACHE_MS) {
    return pumpFollowingSnapshot.items;
  }
  const payload = await fetchPublicJson(GmgnPumpApi.buildFollowingRequest(identity.viewerWallet));
  const baseItems = GmgnPumpApi.sanitizeFollowing(payload);
  const userResults = await mapSettledWithConcurrency(
    baseItems,
    PUMP_PROFILE_CONCURRENCY,
    (entry) => getPumpAlertUser(entry.address),
  );
  const items = baseItems.map((entry, index) => (
    userResults[index]?.status === "fulfilled"
      ? GmgnPumpApi.withUserWallets(entry, userResults[index].value)
      : entry
  ));
  pumpFollowingSnapshot = { viewerWallet: identity.viewerWallet, cachedAt: Date.now(), items };
  return items;
}

async function queryFomoFollowState(allowSessionRefresh = true) {
  const session = await getSession();
  if (!session?.authorization) throw new Error("FOMO_NOT_CONNECTED");
  try {
    const [currentUserPayload, followingPayload] = await Promise.all([
      fetchJson(GmgnFomoApi.buildCurrentUserRequest(), session),
      fetchJson(GmgnFomoApi.buildFollowingIdsRequest(), session),
    ]);
    const viewerUserId = GmgnFomoApi.currentUserId(currentUserPayload);
    if (!viewerUserId) throw new Error("FOMO_CURRENT_USER_NOT_FOUND");
    return {
      viewerUserId,
      followingIds: GmgnFomoApi.sanitizeFollowingIds(followingPayload),
    };
  } catch (error) {
    if (error?.message === "HTTP_401" && allowSessionRefresh) {
      const replacement = await refreshSessionInBackground(session.authorization).catch(() => null);
      if (replacement?.authorization) return queryFomoFollowState(false);
    }
    if (error?.message === "HTTP_401") await clearSession().catch(() => {});
    throw error;
  }
}

function holderFollowStateResponse(snapshot) {
  return {
    ok: true,
    states: {
      fomo: snapshot.fomo?.followingIds || [],
      pump: (snapshot.pump?.items || []).map((item) => ({
        userId: item.userId || "",
        address: item.address || "",
        evmAddress: item.evmAddress || "",
      })),
    },
    errors: {
      ...(snapshot.fomo?.error ? { fomo: snapshot.fomo.error } : {}),
      ...(snapshot.pump?.error ? { pump: snapshot.pump.error } : {}),
    },
  };
}

async function queryHolderFollowStates(force = false) {
  if (!force && holderFollowSnapshot
    && Date.now() - holderFollowSnapshot.cachedAt < HOLDER_FOLLOW_CACHE_MS) {
    return holderFollowStateResponse(holderFollowSnapshot);
  }
  if (holderFollowRequest) {
    if (!force || holderFollowRequest.force) return holderFollowRequest.promise;
    await holderFollowRequest.promise;
    return queryHolderFollowStates(true);
  }
  const request = (async () => {
    const [fomoResult, pumpResult] = await Promise.allSettled([
      queryFomoFollowState(),
      queryPumpIdentity().then(async (identity) => ({
        identity,
        items: await queryPumpFollowing(identity, force),
      })),
    ]);
    holderFollowSnapshot = {
      cachedAt: Date.now(),
      fomo: fomoResult.status === "fulfilled"
        ? fomoResult.value
        : { error: fomoResult.reason?.message || "FOMO_FOLLOW_STATE_FAILED", followingIds: [] },
      pump: pumpResult.status === "fulfilled"
        ? {
          viewerWallet: pumpResult.value.identity.viewerWallet,
          items: pumpResult.value.items,
        }
        : { error: pumpResult.reason?.message || "PUMP_FOLLOW_STATE_FAILED", items: [] },
    };
    return holderFollowStateResponse(holderFollowSnapshot);
  })().finally(() => {
    if (holderFollowRequest?.promise === request) holderFollowRequest = null;
  });
  holderFollowRequest = { promise: request, force };
  return request;
}

async function mutateFomoHolderFollow(userId, shouldFollow, allowSessionRefresh = true) {
  const state = await queryFomoFollowState();
  const session = await getSession();
  if (!session?.authorization) throw new Error("FOMO_NOT_CONNECTED");
  let payload;
  try {
    payload = await fetchJson(
      GmgnFomoApi.buildFollowMutationRequest(state.viewerUserId, userId, shouldFollow),
      session,
    );
  } catch (error) {
    if (error?.message === "HTTP_401" && allowSessionRefresh) {
      const replacement = await refreshSessionInBackground(session.authorization).catch(() => null);
      if (replacement?.authorization) return mutateFomoHolderFollow(userId, shouldFollow, false);
    }
    if (error?.message === "HTTP_401") {
      await clearSession().catch(() => {});
      throw new Error("FOMO_SESSION_EXPIRED");
    }
    throw error;
  }
  if (payload?.statusCode !== 200) throw new Error(shouldFollow
    ? "FOMO_FOLLOW_FAILED"
    : "FOMO_UNFOLLOW_FAILED");
  const followingIds = new Set(state.followingIds);
  if (shouldFollow) followingIds.add(userId);
  else followingIds.delete(userId);
  const identity = sanitizeFollowIdentity({ platform: "fomo", userId });
  let removed = 0;
  if (shouldFollow) allowFollowedTradeIdentity(identity);
  else removed = await purgeFollowedTradesForIdentity(identity);
  holderFollowSnapshot = {
    ...(holderFollowSnapshot || {}),
    cachedAt: Date.now(),
    fomo: { viewerUserId: state.viewerUserId, followingIds: [...followingIds] },
  };
  fomoAlertRestSnapshot = null;
  closeFomoAlertSocket();
  ensureFomoAlertSocket(true).catch(() => {});
  followedTradesSnapshot = null;
  return { ok: true, following: shouldFollow, removed };
}

async function mutatePumpHolderFollow(userId, walletAddress, shouldFollow) {
  const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
  const userPayload = normalizedUserId
    ? await fetchPublicJson(GmgnPumpApi.buildUserRequest(normalizedUserId)).catch(() => null)
    : null;
  const targetAddress = GmgnFomoCore.normalizeWalletAddress(
    walletAddress,
    GmgnFomoCore.TOKEN_NETWORK_IDS.sol,
  ) || GmgnPumpApi.sanitizeUserWallet(userPayload, GmgnFomoCore.TOKEN_NETWORK_IDS.sol);
  if (!targetAddress) throw new Error("PUMP_WALLET_NOT_FOUND");
  const identity = await queryPumpIdentity();
  const currentItems = await queryPumpFollowing(identity);
  const request = GmgnPumpApi.buildFollowMutationRequest(targetAddress, shouldFollow);
  try {
    await fetchPublicJson(request);
  } catch (directError) {
    const tab = await pumpPageTab();
    if (!Number.isInteger(tab?.id)) {
      if (shouldFollow && directError?.message === "HTTP_405") {
        throw new Error("PUMP_FOLLOW_VERIFICATION_REQUIRED");
      }
      throw new Error("PUMP_SESSION_REQUIRED");
    }
    try {
      await fetchPumpJsonFromPage(request, tab.id);
    } catch (pageError) {
      if (shouldFollow && pageError?.message === "HTTP_405") {
        throw new Error("PUMP_FOLLOW_VERIFICATION_REQUIRED");
      }
      throw pageError;
    }
  }

  const currentTarget = currentItems.find((item) => (
    (normalizedUserId && item?.userId === normalizedUserId)
    || item?.address === targetAddress
  ));
  const target = GmgnPumpApi.withUserWallets({
    address: targetAddress,
    userId: normalizedUserId || currentTarget?.userId || "",
    evmAddress: currentTarget?.evmAddress || "",
    username: currentTarget?.username || "",
    profileImage: currentTarget?.profileImage || "",
  }, userPayload);
  const followIdentity = sanitizeFollowIdentity({ platform: "pump", ...target });
  let items;
  let removed = 0;
  if (shouldFollow) {
    allowFollowedTradeIdentity(followIdentity);
    items = [...currentItems.filter((item) => !followIdentitiesOverlap(
      sanitizeFollowIdentity({ platform: "pump", ...item }),
      followIdentity,
    )), target];
  } else {
    removed = await purgeFollowedTradesForIdentity(followIdentity);
    items = currentItems.filter((item) => !followIdentitiesOverlap(
      sanitizeFollowIdentity({ platform: "pump", ...item }),
      followIdentity,
    ));
  }
  pumpFollowingSnapshot = {
    viewerWallet: identity.viewerWallet,
    cachedAt: Date.now(),
    items,
  };
  pumpProfileFollowingSnapshot = null;
  pumpProfileTradesSnapshot = pumpProfileTradesSnapshot && {
    ...pumpProfileTradesSnapshot,
    items: filterUnfollowedTrades(pumpProfileTradesSnapshot.items),
  };
  holderFollowSnapshot = {
    ...(holderFollowSnapshot || {}),
    cachedAt: Date.now(),
    pump: { viewerWallet: identity.viewerWallet, items },
  };
  followedTradesSnapshot = null;
  return { ok: true, following: shouldFollow, removed };
}

async function toggleHolderFollow(message) {
  const shouldFollow = message?.following;
  if (typeof shouldFollow !== "boolean") throw new Error("INVALID_FOLLOW_STATE");
  const platform = message?.platform;
  const userId = typeof message?.userId === "string" ? message.userId.trim() : "";
  if (platform === "fomo") {
    if (!userId) throw new Error("INVALID_FOMO_USER");
    return mutateFomoHolderFollow(userId, shouldFollow);
  }
  if (platform === "pump") {
    return mutatePumpHolderFollow(userId, message.walletAddress, shouldFollow);
  }
  throw new Error("INVALID_FOLLOW_PLATFORM");
}

async function fetchPumpProfilePages(
  following,
  maxPages = GmgnPumpApi.PROFILE_TRANSACTIONS_MAX_PAGES,
  includeSwapGroups = false,
) {
  const directItems = [];
  const groups = [];
  const seenCursors = new Set();
  let cursor = "";
  for (let page = 0; page < maxPages; page += 1) {
    const payload = await fetchPublicJson(
      GmgnPumpApi.buildProfileTransactionsRequest(following.address, cursor),
    );
    directItems.push(...GmgnPumpApi.sanitizeProfileSwaps(payload, following));
    groups.push(...GmgnPumpApi.profileTransferGroups(payload, following, includeSwapGroups));
    const nextCursor = GmgnPumpApi.profileTransactionsNextCursor(payload);
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return { directItems, groups };
}

async function getPumpSolPrice() {
  if (pumpSolPriceSnapshot
    && Date.now() - pumpSolPriceSnapshot.cachedAt < PUMP_MARKET_CACHE_MS) {
    return pumpSolPriceSnapshot.value;
  }
  const payload = await fetchPublicJson(GmgnPumpApi.buildSolPriceRequest());
  const value = GmgnPumpApi.sanitizeSolPrice(payload);
  pumpSolPriceSnapshot = { cachedAt: Date.now(), value };
  return value;
}

async function getPumpCoinMetadata(tokenAddress) {
  const cached = pumpCoinMetadataCache.get(tokenAddress);
  if (cached && Date.now() - cached.cachedAt < PUMP_MARKET_CACHE_MS) return cached.payload;
  if (pumpCoinMetadataRequests.has(tokenAddress)) return pumpCoinMetadataRequests.get(tokenAddress);
  const request = fetchPublicJson(GmgnPumpApi.buildCoinRequest(tokenAddress)).then((payload) => {
    setBoundedCache(pumpCoinMetadataCache, tokenAddress, { cachedAt: Date.now(), payload }, PUMP_MARKET_CACHE_MS, 512);
    return payload;
  }).finally(() => {
    pumpCoinMetadataRequests.delete(tokenAddress);
  });
  pumpCoinMetadataRequests.set(tokenAddress, request);
  return request;
}

function cachePumpRpcTrade(key, item) {
  pumpSolanaRpcCache.set(key, { item, cachedAt: Date.now() });
  while (pumpSolanaRpcCache.size > PUMP_RPC_CACHE_LIMIT) {
    pumpSolanaRpcCache.delete(pumpSolanaRpcCache.keys().next().value);
  }
}

function getCachedPumpRpcTrade(key) {
  const cached = pumpSolanaRpcCache.get(key);
  if (!cached) return { hit: false, item: null };
  if (cached.item === null && Date.now() - cached.cachedAt >= PUMP_RPC_NEGATIVE_CACHE_MS) {
    pumpSolanaRpcCache.delete(key);
    return { hit: false, item: null };
  }
  return { hit: true, item: cached.item };
}

function pumpProfileRpcCandidates(groups, networkId) {
  const items = [];
  const candidates = [];
  const seenGroups = new Set();
  for (const group of groups.sort((left, right) => right.createdAt - left.createdAt)) {
    if (group.networkId !== networkId) continue;
    const key = `${group.networkId}:${group.walletAddress}:${group.transactionHash}`;
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    if (!GmgnPumpApi.isProfileRpcCandidate(group)) continue;
    const cached = getCachedPumpRpcTrade(key);
    if (cached.hit) {
      if (cached.item) items.push(cached.item);
      continue;
    }
    if (candidates.length < PUMP_RPC_BATCH_LIMIT) candidates.push({ key, group });
  }
  return { items, candidates };
}

async function resolvePumpSolanaProfileGroups(groups, solPrice) {
  const { items, candidates } = pumpProfileRpcCandidates(
    groups,
    GmgnFomoCore.TOKEN_NETWORK_IDS.sol,
  );
  if (!candidates.length) return items;

  const payload = await fetchPublicJson(
    GmgnPumpApi.buildSolanaTransactionsRequest(
      candidates.map((candidate) => candidate.group.transactionHash),
    ),
  );
  const responses = Array.isArray(payload) ? payload : [payload];
  const byId = new Map(responses.map((response) => [String(response?.id || ""), response]));
  for (const candidate of candidates) {
    const response = byId.get(candidate.group.transactionHash);
    if (!response || response.error || !Object.prototype.hasOwnProperty.call(response, "result")) continue;
    const item = GmgnPumpApi.sanitizeSolanaRpcTrade(response, candidate.group, solPrice);
    cachePumpRpcTrade(candidate.key, item);
    if (item) items.push(item);
  }
  return items;
}

async function resolvePumpEvmProfileGroups(groups) {
  const networkIds = [...new Set(groups
    .map((group) => Number(group?.networkId))
    .filter((networkId) => networkId !== GmgnFomoCore.TOKEN_NETWORK_IDS.sol
      && GmgnEvmHolderResolver.isSupported(networkId)))];
  const items = [];
  for (const networkId of networkIds) {
    const resolved = pumpProfileRpcCandidates(groups, networkId);
    items.push(...resolved.items);
    if (!resolved.candidates.length) continue;
    const payload = GmgnPumpApi.buildEvmTransactionsRequest(
      resolved.candidates.map((candidate) => candidate.group.transactionHash),
    );
    const responses = await fetchEvmRpcResponse(networkId, payload, 12_000);
    const rows = Array.isArray(responses) ? responses : [responses];
    const byId = new Map(rows.map((response) => [String(response?.id || ""), response]));
    for (const candidate of resolved.candidates) {
      const hash = candidate.group.transactionHash;
      const transactionResponse = byId.get(`transaction:${hash}`);
      const receiptResponse = byId.get(`receipt:${hash}`);
      if (transactionResponse?.error || receiptResponse?.error
        || !transactionResponse?.result || !receiptResponse?.result) continue;
      const item = GmgnPumpApi.sanitizeEvmRpcTrade({
        transaction: transactionResponse.result,
        receipt: receiptResponse.result,
      }, candidate.group);
      cachePumpRpcTrade(candidate.key, item);
      if (item) items.push(item);
    }
  }
  return items;
}

async function resolvePumpProfileGroups(groups, solPrice) {
  const [solanaResult, evmResult] = await Promise.allSettled([
    resolvePumpSolanaProfileGroups(groups, solPrice),
    resolvePumpEvmProfileGroups(groups),
  ]);
  return [
    ...(solanaResult.status === "fulfilled" ? solanaResult.value : []),
    ...(evmResult.status === "fulfilled" ? evmResult.value : []),
  ];
}

function pumpItemNeedsCoinMetadata(item) {
  return !item?.tokenSymbol
    || !GmgnFomoCore.safeTokenImageUrl(item?.tokenImageUrl)
    || GmgnFomoCore.finiteNumber(item?.marketCap) === null
    || GmgnFomoCore.finiteNumber(item?.totalSupply) === null;
}

function freshPumpCoinMetadata(tokenAddress) {
  const cached = pumpCoinMetadataCache.get(tokenAddress);
  return cached && Date.now() - cached.cachedAt < PUMP_MARKET_CACHE_MS
    ? cached
    : null;
}

async function enrichPumpProfileItems(items) {
  const metadataByToken = new Map();
  const tokens = [...new Set(items
    .filter(pumpItemNeedsCoinMetadata)
    .map((item) => item.tokenAddress))];
  const results = await Promise.allSettled(tokens.map((token) => getPumpCoinMetadata(token)));
  results.forEach((result, index) => {
    if (result.status === "fulfilled") metadataByToken.set(tokens[index], result.value);
  });
  return items.map((item) => (
    metadataByToken.has(item.tokenAddress)
      ? GmgnPumpApi.withCoinMetadata(item, metadataByToken.get(item.tokenAddress))
      : item
  ));
}

function pumpEvmSymbolKey(item) {
  const networkId = Number(item?.networkId);
  if (!GmgnEvmHolderResolver.isSupported(networkId)
    || networkId === GmgnFomoCore.TOKEN_NETWORK_IDS.sol) return "";
  const token = GmgnFomoCore.normalizeWalletAddress(item?.tokenAddress, networkId);
  return token ? `${networkId}:${token}` : "";
}

function cachedPumpEvmSymbol(key) {
  const cached = pumpEvmSymbolCache.get(key);
  if (!cached) return { hit: false, symbol: "" };
  const ttl = cached.symbol ? PUMP_EVM_SYMBOL_CACHE_MS : PUMP_EVM_SYMBOL_NEGATIVE_CACHE_MS;
  if (Date.now() - cached.cachedAt < ttl) return { hit: true, symbol: cached.symbol };
  pumpEvmSymbolCache.delete(key);
  return { hit: false, symbol: "" };
}

function cachePumpEvmSymbol(key, symbol) {
  pumpEvmSymbolCache.set(key, { symbol, cachedAt: Date.now() });
  while (pumpEvmSymbolCache.size > PUMP_RPC_CACHE_LIMIT) {
    pumpEvmSymbolCache.delete(pumpEvmSymbolCache.keys().next().value);
  }
}

function applyPumpEvmSymbols(items, symbols) {
  return (Array.isArray(items) ? items : []).map((item) => {
    if (typeof item?.tokenSymbol === "string" && item.tokenSymbol.trim()) return item;
    const symbol = symbols.get(pumpEvmSymbolKey(item));
    return symbol ? { ...item, tokenSymbol: symbol } : item;
  });
}

function applyCachedPumpEvmSymbols(items) {
  const symbols = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item?.tokenSymbol === "string" && item.tokenSymbol.trim()) continue;
    const key = pumpEvmSymbolKey(item);
    if (!key) continue;
    const cached = cachedPumpEvmSymbol(key);
    if (cached.hit && cached.symbol) symbols.set(key, cached.symbol);
  }
  return symbols.size ? applyPumpEvmSymbols(items, symbols) : items;
}

function schedulePumpEvmSymbolEnrichment(items) {
  const symbols = new Map();
  const missingByNetwork = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item?.tokenSymbol === "string" && item.tokenSymbol.trim()) continue;
    const key = pumpEvmSymbolKey(item);
    if (!key) continue;
    const cached = cachedPumpEvmSymbol(key);
    if (cached.hit) {
      if (cached.symbol) symbols.set(key, cached.symbol);
      continue;
    }
    if (pumpEvmSymbolRequests.has(key)) continue;
    const [networkIdText, token] = key.split(":");
    const networkId = Number(networkIdText);
    const tokens = missingByNetwork.get(networkId) || new Set();
    tokens.add(token);
    missingByNetwork.set(networkId, tokens);
  }
  if (symbols.size && pumpProfileTradesSnapshot) {
    pumpProfileTradesSnapshot.items = applyPumpEvmSymbols(pumpProfileTradesSnapshot.items, symbols);
  }
  if (!missingByNetwork.size) return;

  Promise.all([...missingByNetwork].map(async ([networkId, tokenSet]) => {
    const tokens = [...tokenSet];
    const requests = GmgnPumpApi.buildEvmTokenSymbolRequests(tokens, networkId);
    for (const token of tokens) pumpEvmSymbolRequests.add(`${networkId}:${token}`);
    try {
      const responses = await evmRpcBatch(networkId, requests);
      const byId = new Map(responses.map((response) => [String(response?.id || ""), response]));
      for (const token of tokens) {
        const key = `${networkId}:${token}`;
        const response = byId.get(`symbol:${token}`);
        const symbol = response && !response.error
          ? GmgnPumpApi.decodeEvmTokenSymbol(response.result)
          : "";
        cachePumpEvmSymbol(key, symbol);
        if (symbol) symbols.set(key, symbol);
      }
    } catch {
      for (const token of tokens) cachePumpEvmSymbol(`${networkId}:${token}`, "");
    } finally {
      for (const token of tokens) pumpEvmSymbolRequests.delete(`${networkId}:${token}`);
    }
  })).then(() => {
    if (symbols.size && pumpProfileTradesSnapshot) {
      pumpProfileTradesSnapshot.items = applyPumpEvmSymbols(pumpProfileTradesSnapshot.items, symbols);
    }
  }).catch(() => {});
}

function preparePumpEvmSymbols(items) {
  const source = Array.isArray(items) ? items : [];
  const preparedMetadata = source.map((item) => {
    if (item?.platform !== "pump" || !GmgnFomoCore.validTokenAddress(item?.tokenAddress)) return item;
    if (!pumpItemNeedsCoinMetadata(item)) return item;
    const cached = freshPumpCoinMetadata(item.tokenAddress);
    return cached
      ? GmgnPumpApi.withCoinMetadata(item, cached.payload)
      : item;
  });
  const missingMetadataTokens = [...new Set(preparedMetadata
    .filter((item) => item?.platform === "pump"
      && GmgnFomoCore.validTokenAddress(item?.tokenAddress)
      && pumpItemNeedsCoinMetadata(item)
      && !freshPumpCoinMetadata(item.tokenAddress))
    .map((item) => item.tokenAddress))];
  for (const token of missingMetadataTokens) {
    // Deduplicate the completion work as well as the HTTP request. Publishing
    // one completed token rebuilds the snapshot while other tokens are pending.
    if (pumpCoinMetadataApplications.has(token)) continue;
    pumpCoinMetadataApplications.add(token);
    getPumpCoinMetadata(token).then((payload) => {
      const capturedAt = Date.now();
      const applyMetadata = (currentItems) => GmgnPumpApi.withRealtimeMarketSnapshots(
        (Array.isArray(currentItems) ? currentItems : []).map((item) => (
          item?.platform === "pump" && item.tokenAddress === token
            ? GmgnPumpApi.withCoinMetadata(item, payload)
            : item
        )),
        capturedAt,
      );
      followedTradesHistory.pump = applyMetadata(followedTradesHistory.pump);
      if (pumpProfileTradesSnapshot) {
        pumpProfileTradesSnapshot.items = applyMetadata(pumpProfileTradesSnapshot.items);
      }
      if (followedTradesSnapshot?.response?.ok) {
        followedTradesSnapshot.response.items = applyMetadata(followedTradesSnapshot.response.items);
      }
      const enrichedItems = followedTradesHistory.pump.filter((item) => item.tokenAddress === token);
      if (enrichedItems.length) {
        return publishPumpRealtimeItems(enrichedItems, "coin-metadata", false);
      }
    }).catch(() => {}).finally(() => pumpCoinMetadataApplications.delete(token));
  }
  const prepared = applyCachedPumpEvmSymbols(preparedMetadata);
  schedulePumpEvmSymbolEnrichment(prepared);
  return prepared;
}

async function pumpProfileItemsFromPages(pages) {
  const solPrice = await getPumpSolPrice().catch(() => null);
  const directItems = pages.flatMap((page) => page.directItems);
  const transferItems = await resolvePumpProfileGroups(
    pages.flatMap((page) => page.groups),
    solPrice,
  ).catch(() => []);
  return enrichPumpProfileItems(
    GmgnFollowTrades.mergeFollowedTrades(directItems, transferItems),
  );
}

async function queryPumpProfileFollowedTrades() {
  const identity = await queryPumpIdentity();
  if (pumpProfileTradesSnapshot
    && pumpProfileTradesSnapshot.viewerWallet === identity.viewerWallet
    && Date.now() - pumpProfileTradesSnapshot.cachedAt < PUMP_PROFILE_CACHE_MS) {
    return pumpProfileTradesSnapshot.items;
  }
  if (pumpProfileTradesRequest) return pumpProfileTradesRequest;
  pumpProfileTradesRequest = (async () => {
    const following = await queryPumpFollowing(identity);
    if (!following.length) return [];
    const profileResults = await mapSettledWithConcurrency(
      following,
      PUMP_PROFILE_CONCURRENCY,
      (entry) => fetchPumpProfilePages(entry, GmgnPumpApi.PROFILE_TRANSACTIONS_MAX_PAGES, "evm"),
    );
    const pages = profileResults
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    if (!pages.length) throw new Error("PUMP_PROFILE_REQUEST_FAILED");
    const items = await pumpProfileItemsFromPages(pages);
    pumpProfileTradesSnapshot = { viewerWallet: identity.viewerWallet, cachedAt: Date.now(), items };
    return items;
  })().finally(() => {
    pumpProfileTradesRequest = null;
  });
  return pumpProfileTradesRequest;
}

function pumpFollowingForNatsWallet(walletAddress) {
  const target = String(walletAddress || "").toLowerCase();
  return pumpFollowingSnapshot?.items?.find((entry) => (
    String(entry?.address || "").toLowerCase() === target
      || String(entry?.evmAddress || "").toLowerCase() === target
  )) || null;
}

async function refreshPumpNatsWallet(walletAddress) {
  const following = pumpFollowingForNatsWallet(walletAddress);
  if (!following) return 0;
  const hadProfileBaseline = Boolean(pumpProfileTradesSnapshot);
  const knownIds = new Set(followedTradesHistory.pump.map((item) => item?.id).filter(Boolean));
  const page = await fetchPumpProfilePages(following, 1, true);
  const items = await pumpProfileItemsFromPages([page]);
  const preparedItems = hadProfileBaseline
    && typeof GmgnPumpApi.withRealtimeMarketSnapshots === "function"
    ? GmgnPumpApi.withRealtimeMarketSnapshots(items, Date.now())
    : items;
  const snapshotUpdated = preparedItems.some((item, index) => item !== items[index]);
  const currentItems = pumpProfileTradesSnapshot?.items || [];
  pumpProfileTradesSnapshot = {
    viewerWallet: pumpFollowingSnapshot.viewerWallet,
    cachedAt: pumpProfileTradesSnapshot?.cachedAt || 0,
    items: GmgnFollowTrades.mergeFollowedTrades(preparedItems, currentItems),
  };
  const freshItems = hadProfileBaseline
    ? preparedItems.filter((item) => item?.id && !knownIds.has(item.id))
    : [];
  rememberFollowedTrades("pump", preparedItems);
  if (freshItems.length) await publishPumpRealtimeItems(freshItems);
  else if (snapshotUpdated) {
    await publishPumpRealtimeItems(preparedItems, "nats+profile-rest-snapshot", false);
  } else if (!hadProfileBaseline && preparedItems.length) {
    await publishPumpRealtimeItems(preparedItems, "nats+profile-rest-baseline", false);
  }
  return freshItems.length;
}

function schedulePumpNatsWalletRefresh(walletAddress) {
  const subject = GmgnPumpApi.buildAccountBalanceSubject(walletAddress);
  const wallet = GmgnPumpApi.accountBalanceSubjectWallet(subject);
  if (!wallet) return;
  const state = pumpNatsWalletRefreshStates.get(wallet) || {
    timer: null,
    running: false,
    cancelled: false,
    eventVersion: 0,
    retryIndex: 0,
  };
  state.eventVersion += 1;
  state.retryIndex = 0;
  pumpNatsWalletRefreshStates.set(wallet, state);
  if (state.timer !== null || state.running) return;

  const schedule = (delay) => {
    if (state.cancelled || pumpNatsWalletRefreshStates.get(wallet) !== state) return;
    state.timer = setTimeout(async () => {
      state.timer = null;
      state.running = true;
      const refreshVersion = state.eventVersion;
      try {
        await refreshPumpNatsWallet(wallet);
      } catch {}
      state.running = false;
      if (state.cancelled || pumpNatsWalletRefreshStates.get(wallet) !== state) return;
      if (state.eventVersion !== refreshVersion) state.retryIndex = 0;
      const retryDelay = PUMP_NATS_INDEX_RETRY_DELAYS_MS[state.retryIndex];
      if (retryDelay !== undefined) {
        state.retryIndex += 1;
        schedule(retryDelay);
      } else {
        pumpNatsWalletRefreshStates.delete(wallet);
      }
    }, delay);
  };
  schedule(PUMP_NATS_WALLET_DEBOUNCE_MS);
}

function preferredPumpFailure(alertResult, profileResult) {
  const reasons = [alertResult, profileResult]
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message || "PUMP_REQUEST_FAILED");
  return reasons.find((reason) => ["PUMP_SESSION_REQUIRED", "PUMP_SESSION_EXPIRED"].includes(reason))
    || reasons[0]
    || "PUMP_REQUEST_FAILED";
}

function waitForPumpProfile(promise, timeoutMs = PUMP_PROFILE_FALLBACK_WAIT_MS) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("PUMP_PROFILE_TIMEOUT")), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

async function queryPumpFollowedTradesUninstrumented() {
  ensurePumpNatsSubscriptions().catch((error) => {
    recordPumpRealtimeDiagnostic(pumpNatsConnectionStatus, {
      error: diagnosticError(error?.message) || "PUMP_NATS_CONFIGURE_FAILED",
    });
  });
  let alertItems;
  try {
    alertItems = await queryPumpAlertTrades();
  } catch (alertError) {
    try {
      return preparePumpEvmSymbols(
        await waitForPumpProfile(queryPumpProfileFollowedTrades()),
      );
    } catch (profileError) {
      throw new Error(preferredPumpFailure(
        { status: "rejected", reason: alertError },
        { status: "rejected", reason: profileError },
      ));
    }
  }

  const cachedProfileItems = pumpProfileTradesSnapshot?.items || [];
  const profilePromise = queryPumpProfileFollowedTrades();
  if (!cachedProfileItems.length) {
    try {
      const profileItems = await waitForPumpProfile(profilePromise, PUMP_PROFILE_GRACE_WAIT_MS);
      return preparePumpEvmSymbols(
        GmgnFollowTrades.mergeFollowedTrades(alertItems, profileItems),
      );
    } catch (error) {
      if (error?.message === "PUMP_PROFILE_TIMEOUT") {
        profilePromise.then((profileItems) => {
          if (profileItems.length) publishPumpRealtimeItems(profileItems, "profile-rest", false);
        }).catch((profileError) => {
          persistFollowedTradesDiagnostic({
            pumpProfile: {
              state: "failed",
              updatedAt: Date.now(),
              error: diagnosticError(profileError?.message) || "PUMP_PROFILE_REQUEST_FAILED",
            },
          });
        });
      } else {
        persistFollowedTradesDiagnostic({
          pumpProfile: {
            state: "failed",
            updatedAt: Date.now(),
            error: diagnosticError(error?.message) || "PUMP_PROFILE_REQUEST_FAILED",
          },
        });
      }
    }
  } else {
    profilePromise.catch(() => {});
  }
  return preparePumpEvmSymbols(
    GmgnFollowTrades.mergeFollowedTrades(
      alertItems,
      cachedProfileItems,
    ),
  );
}

async function queryPumpFollowedTrades() {
  const startedAt = Date.now();
  recordFollowedTradePipeline("pump-source-request");
  try {
    const items = await queryPumpFollowedTradesUninstrumented();
    recordFollowedTradePipeline("pump-source-response", items, {
      count: items.length,
      durationMs: Date.now() - startedAt,
    });
    return items;
  } catch (error) {
    recordFollowedTradePipeline("pump-source-error", [], {
      durationMs: Date.now() - startedAt,
      error: error?.message || "PUMP_REQUEST_FAILED",
    });
    throw error;
  }
}

function followedTradesHistoryItems() {
  return GmgnFollowTrades.mergeFollowedTrades(
    followedTradesHistory.fomo,
    followedTradesHistory.pump,
  );
}

function normalizedFollowWallet(value) {
  const solana = GmgnFomoCore.normalizeWalletAddress(
    value,
    GmgnFomoCore.TOKEN_NETWORK_IDS.sol,
  );
  if (solana) return solana;
  return GmgnFomoCore.normalizeWalletAddress(
    value,
    GmgnFomoCore.TOKEN_NETWORK_IDS.eth,
  ) || "";
}

function sanitizeFollowIdentity(value) {
  const platform = value?.platform === "fomo" || value?.platform === "pump"
    ? value.platform
    : "";
  if (!platform) return null;
  const userId = typeof value?.userId === "string" ? value.userId.trim() : "";
  const wallets = [...new Set([
    value?.walletAddress,
    value?.address,
    value?.evmAddress,
  ].map(normalizedFollowWallet).filter(Boolean))];
  return userId || wallets.length ? { platform, userId, wallets } : null;
}

function followIdentitiesOverlap(left, right) {
  if (!left || !right || left.platform !== right.platform) return false;
  if (left.userId && right.userId && left.userId === right.userId) return true;
  const rightWallets = new Set(right.wallets);
  return left.wallets.some((wallet) => rightWallets.has(wallet));
}

function followedTradeMatchesIdentity(item, identity) {
  if (!identity || item?.platform !== identity.platform) return false;
  const itemUserId = typeof item?.userId === "string" ? item.userId.trim() : "";
  if (identity.userId && itemUserId === identity.userId) return true;
  const wallet = normalizedFollowWallet(item?.walletAddress);
  return Boolean(wallet && identity.wallets.includes(wallet));
}

function filterUnfollowedTrades(items) {
  return (Array.isArray(items) ? items : []).filter((item) => (
    !unfollowedTradeIdentities.some((identity) => followedTradeMatchesIdentity(item, identity))
  ));
}

function allowFollowedTradeIdentity(identity) {
  for (let index = unfollowedTradeIdentities.length - 1; index >= 0; index -= 1) {
    if (followIdentitiesOverlap(unfollowedTradeIdentities[index], identity)) {
      unfollowedTradeIdentities.splice(index, 1);
    }
  }
}

async function purgeFollowedTradesForIdentity(rawIdentity) {
  let identity = sanitizeFollowIdentity(rawIdentity);
  if (!identity) throw new Error("INVALID_FOLLOW_IDENTITY");
  if (identity.platform === "pump") {
    for (const item of pumpFollowingSnapshot?.items || []) {
      const candidate = sanitizeFollowIdentity({ platform: "pump", ...item });
      if (!followIdentitiesOverlap(identity, candidate)) continue;
      identity = {
        platform: "pump",
        userId: identity.userId || candidate.userId,
        wallets: [...new Set([...identity.wallets, ...candidate.wallets])],
      };
    }
  }
  await hydrateFollowedTradesHistory();
  allowFollowedTradeIdentity(identity);
  unfollowedTradeIdentities.push(identity);
  gmgnTradeDelivery.discard((item) => !filterUnfollowedTrades([item]).length);

  const before = followedTradesHistoryItems().length;
  for (const platform of ["fomo", "pump"]) {
    followedTradesHistory[platform] = followedTradesHistory[platform]
      .filter((item) => !followedTradeMatchesIdentity(item, identity));
  }
  if (fomoAlertRestSnapshot) {
    fomoAlertRestSnapshot = {
      ...fomoAlertRestSnapshot,
      items: fomoAlertRestSnapshot.items.filter((item) => !followedTradeMatchesIdentity(item, identity)),
    };
  }
  if (pumpProfileTradesSnapshot) {
    pumpProfileTradesSnapshot = {
      ...pumpProfileTradesSnapshot,
      items: pumpProfileTradesSnapshot.items.filter((item) => !followedTradeMatchesIdentity(item, identity)),
    };
  }
  await persistFollowedTradesHistory();
  const removed = before - followedTradesHistoryItems().length;
  publishFollowedTradesResponse(buildCurrentFollowedTradesResponse({
    [identity.platform]: {
      ok: true,
      count: followedTradesHistory[identity.platform].length,
      transport: "unfollow-purge",
    },
  }));
  return removed;
}

function isVerifiedFomoFollowedTrade(item) {
  return item?.platform === "fomo"
    && [FOMO_FOLLOWED_TRADE_VERIFICATION, FOMO_FOLLOWED_TRADE_WEBSOCKET]
      .includes(item?.sourceVerification);
}

function isVerifiedPumpFollowedTrade(item) {
  return item?.platform === "pump"
    && item?.sourceVerification === GmgnPumpApi.PUMP_CHAIN_RPC_VERIFICATION;
}

function followedTradesFingerprint(items) {
  return JSON.stringify(Array.isArray(items) ? items : []);
}

function hydrateFollowedTradesHistory() {
  if (followedTradesHistoryHydration) return followedTradesHistoryHydration;
  followedTradesHistoryHydration = chrome.storage.local.get(FOLLOWED_TRADES_STORAGE_KEY)
    .then((result) => {
      const stored = result?.[FOLLOWED_TRADES_STORAGE_KEY];
      const storedItems = Array.isArray(stored?.items) ? stored.items : [];
      for (const platform of ["fomo", "pump"]) {
        followedTradesHistory[platform] = GmgnFollowTrades.mergeFollowedTrades(
          followedTradesHistory[platform],
          storedItems.filter((item) => (
            item?.platform === platform
            && (platform !== "fomo" || isVerifiedFomoFollowedTrade(item))
          )),
        ).filter((item) => item?.platform === platform);
      }
      followedTradesCacheFingerprint = followedTradesFingerprint(followedTradesHistoryItems());
    })
    .catch(() => {});
  return followedTradesHistoryHydration;
}

function persistFollowedTradesHistory() {
  const items = followedTradesHistoryItems();
  const fingerprint = followedTradesFingerprint(items);
  if (fingerprint === followedTradesCacheFingerprint) return followedTradesCacheWritePromise;
  followedTradesCacheFingerprint = fingerprint;
  const payload = { version: 1, updatedAt: Date.now(), items };
  const write = followedTradesCacheWritePromise.then(() => (
    chrome.storage.local.set({ [FOLLOWED_TRADES_STORAGE_KEY]: payload })
  )).catch((error) => {
    if (followedTradesCacheFingerprint === fingerprint) followedTradesCacheFingerprint = "";
    throw error;
  });
  followedTradesCacheWritePromise = write.catch(() => {});
  return write;
}

function rememberFollowedTrades(platform, items) {
  const acceptedItems = filterUnfollowedTrades(items).filter((item) => (
    platform !== "fomo" || isVerifiedFomoFollowedTrade(item)
  ));
  const merged = GmgnFollowTrades.mergeFollowedTrades(
    acceptedItems,
    followedTradesHistory[platform],
  ).filter((item) => item?.platform === platform);
  followedTradesHistory[platform] = merged;
  persistFollowedTradesHistory().catch(() => {});
  return merged;
}

async function updateFollowedTradesWindow(value) {
  const chains = [...new Set((Array.isArray(value?.chains) ? value.chains : [])
    .filter((chain) => Object.hasOwn(GmgnFomoCore.TOKEN_NETWORK_IDS, chain)))];
  const networkIds = chains.map((chain) => GmgnFomoCore.TOKEN_NETWORK_IDS[chain]);
  const cutoffValue = GmgnFomoCore.finiteNumber(value?.oldestTimestampMs);
  const cutoffMs = cutoffValue !== null && cutoffValue > 0 ? cutoffValue : null;
  if (!networkIds.length) return { ok: false, error: "INVALID_TRACKING_WINDOW" };
  followedTradesWindow = { chains, networkIds, cutoffMs };
  // This is a presentation window owned by the current GMGN page. The MAIN
  // bridge applies it while merging into that page; it must never delete the
  // durable cross-page history used to restore rows after a refresh.
  return { ok: true, removed: 0 };
}

function followedTradeSource(result, platform) {
  if (result.status === "fulfilled") {
    return { ok: true, count: result.value.length };
  }
  const reason = result.reason?.message || `${platform.toUpperCase()}_REQUEST_FAILED`;
  return {
    ok: false,
    error: platform === "pump" && reason === "HTTP_401" ? "PUMP_SESSION_EXPIRED" : reason,
  };
}

function diagnosticCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? Math.min(count, 10_000) : 0;
}

function diagnosticError(value) {
  return typeof value === "string" ? value.slice(0, 160) : "";
}

function diagnosticSource(source) {
  if (!source || typeof source !== "object") return null;
  return source.ok === true
    ? { ok: true, count: diagnosticCount(source.count) }
    : { ok: false, error: diagnosticError(source.error) || "REQUEST_FAILED" };
}

function persistFollowedTradesDiagnostic(patch) {
  if (!followedTradesDiagnosticsEnabled) return;
  followedTradesDiagnostic = {
    ...(followedTradesDiagnostic || {}),
    ...patch,
  };
  chrome.storage.local.set({
    [FOLLOWED_TRADES_DIAGNOSTIC_KEY]: followedTradesDiagnostic,
  }).catch(() => {});
}

function recordFollowedTradesSourceDiagnostic(response) {
  if (!LOCAL_DIAGNOSTICS_AVAILABLE) return;
  const items = response?.ok && Array.isArray(response.items) ? response.items : [];
  const snapshotFingerprint = items.map((item) => GmgnFollowTrades.stableKey(item)).join("|");
  if (snapshotFingerprint !== followedTradesPipelineSnapshotFingerprint) {
    followedTradesPipelineSnapshotFingerprint = snapshotFingerprint;
    recordFollowedTradePipeline("background-snapshot", items, {
      count: items.length,
      deliveryCount: Array.isArray(response?.realtimeItemKeys)
        ? response.realtimeItemKeys.length
        : 0,
      notificationCount: Array.isArray(response?.notificationItemKeys)
        ? response.notificationItemKeys.length
        : 0,
      subscriberCount: followedTradesNetworkByPort.size,
      gmgnSubscriberCount: [...followedTradesNetworkByPort.keys()].filter(
        (port) => followedTradesSurfaceByPort.get(port) === "gmgn",
      ).length,
    });
  }
  persistFollowedTradesDiagnostic({
    sourcePoll: {
      updatedAt: Date.now(),
      ok: response?.ok === true,
      itemCount: items.length,
      platformCounts: {
        fomo: items.filter((item) => item?.platform === "fomo").length,
        pump: items.filter((item) => item?.platform === "pump").length,
      },
      sources: {
        fomo: diagnosticSource(response?.sources?.fomo),
        pump: diagnosticSource(response?.sources?.pump),
      },
      subscriberCount: followedTradesNetworkByPort.size,
    },
  });
}

function validFomoAlertTopicId(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9_-]{1,128}$/.test(value.trim());
}

function recordFomoRealtimeDiagnostic(state, patch = {}) {
  recordTradeSourceEvent("fomo-connection", { reason: state });
  persistFollowedTradesDiagnostic({
    fomoRealtime: {
      state,
      updatedAt: Date.now(),
      authenticated: fomoAlertSocketAuthenticated,
      hasTopicId: Boolean(fomoAlertSocketKey),
      reconnectAttempts: fomoAlertSocketReconnectAttempts,
      lastEventAt: fomoAlertLastEventAt || 0,
      error: fomoAlertLastError.slice(0, 160),
      catchupError: fomoAlertCatchupError.slice(0, 160),
      ...patch,
    },
  });
}

function recordPumpRealtimeDiagnostic(state, patch = {}) {
  pumpNatsConnectionStatus = state;
  pumpRealtimeUpdatedAt = Date.now();
  if (Object.hasOwn(patch, "error")) pumpRealtimeError = diagnosticError(patch.error);
  updatePumpActionState(currentTradeSources().pump);
  persistFollowedTradesDiagnostic({
    pumpRealtime: {
      state,
      updatedAt: Date.now(),
      subjectCount: pumpNatsSubscriptionKey
        ? pumpNatsSubscriptionKey.split("\n").length
        : 0,
      lastEventAt: pumpNatsLastEventAt,
      error: pumpRealtimeError,
      ...patch,
    },
  });
}

function buildCurrentFollowedTradesResponse(sourceOverrides = {}) {
  const previousSources = followedTradesSnapshot?.response?.sources || {};
  const sources = {
    fomo: sourceOverrides.fomo || previousSources.fomo || {
      ok: true,
      count: followedTradesHistory.fomo.length,
    },
    pump: sourceOverrides.pump || previousSources.pump || {
      ok: true,
      count: followedTradesHistory.pump.length,
    },
  };
  return {
    ok: true,
    items: preparePumpEvmSymbols(GmgnFollowTrades.mergeFollowedTrades(
      followedTradesHistory.fomo,
      followedTradesHistory.pump,
    )),
    sources,
    updatedAt: Date.now(),
  };
}

function followedTradeNotificationKey(item) {
  return GmgnFollowTrades.stableKey(item);
}

function diagnosticTradeRef(item) {
  if (!item || typeof item !== "object") return null;
  const text = (value, limit = 200) => (
    typeof value === "string" ? value.trim().slice(0, limit) : ""
  );
  const platform = ["fomo", "pump"].includes(item.platform)
    ? item.platform
    : ["fomo", "pump"].includes(item.extension_source)
      ? item.extension_source
      : "";
  const transactionHash = text(item.transactionHash || item.transaction_hash || item.h);
  const rawId = text(item.id);
  const id = transactionHash || /0x[a-f0-9]{40}/i.test(rawId) ? "" : rawId;
  const tokenAddress = text(item.tokenAddress || item.base_address || item.ba);
  const networkIdValue = item.networkId === null || item.networkId === undefined
    ? NaN
    : Number(item.networkId);
  const chain = ["eth", "bsc", "robinhood", "base", "sol"].includes(item.chain || item.n)
    ? item.chain || item.n
    : "";
  const type = ["buy", "sell"].includes(item.type || item.side || item.s)
    ? item.type || item.side || item.s
    : "";
  let createdAt = Number(item.createdAt);
  if (!Number.isFinite(createdAt)) {
    const seconds = Number(item.timestamp ?? item.ts);
    createdAt = Number.isFinite(seconds) ? seconds * 1_000 : 0;
  }
  const identityParts = [platform, transactionHash, tokenAddress, type, createdAt || ""];
  const key = text(item.key)
    || (id && platform ? `${platform}:${id}` : "")
    || (identityParts.some(Boolean) ? identityParts.join(":") : "");
  if (!key && !transactionHash && !tokenAddress) return null;
  return {
    key,
    platform,
    id,
    transactionHash,
    tokenAddress,
    networkId: Number.isInteger(networkIdValue) ? networkIdValue : null,
    chain,
    type,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0,
  };
}

function sanitizeFollowedTradePipelineDetail(value) {
  const source = value && typeof value === "object" ? value : {};
  const count = (name) => {
    if (source[name] === null || source[name] === undefined || source[name] === "") return null;
    const number = Number(source[name]);
    return Number.isInteger(number) && number >= 0 ? Math.min(number, 10_000) : null;
  };
  const chains = Array.isArray(source.chains)
    ? source.chains.filter((chain) => ["eth", "bsc", "robinhood", "base", "sol"].includes(chain))
    : [];
  return {
    count: count("count"),
    durationMs: count("durationMs"),
    cacheAgeMs: count("cacheAgeMs"),
    force: source.force === true,
    subscriberCount: count("subscriberCount"),
    gmgnSubscriberCount: count("gmgnSubscriberCount"),
    deliveryCount: count("deliveryCount"),
    notificationCount: count("notificationCount"),
    nativeCount: count("nativeCount"),
    externalCount: count("externalCount"),
    insertedCount: count("insertedCount"),
    usdCount: count("usdCount"),
    baseAmountCount: count("baseAmountCount"),
    priceCount: count("priceCount"),
    supplyCount: count("supplyCount"),
    marketCapCount: count("marketCapCount"),
    visibilityState: ["visible", "hidden", "prerender"].includes(source.visibilityState)
      ? source.visibilityState
      : "",
    routeChain: typeof source.routeChain === "string" ? source.routeChain.slice(0, 24) : "",
    surface: ["gmgn", "diagnostics", "other"].includes(source.surface) ? source.surface : "",
    transport: typeof source.transport === "string" ? source.transport.slice(0, 40) : "",
    error: diagnosticError(source.error),
    chains,
  };
}

function recordFollowedTradePipeline(stage, items = [], detail = {}) {
  if (!LOCAL_DIAGNOSTICS_AVAILABLE) return Promise.resolve();
  // Metadata-only history updates must not evict realtime failures/receipts.
  if (detail.transport === "coin-metadata") return Promise.resolve();
  if (tradeReceipts.record(stage, items, detail)) scheduleTradeReceiptWrite();
  if (!followedTradesDiagnosticsEnabled) return Promise.resolve();
  if (typeof stage !== "string" || !stage) return Promise.resolve();
  const refs = (Array.isArray(items) ? items : [])
    .map(diagnosticTradeRef)
    .filter(Boolean)
    .slice(0, FOLLOWED_TRADES_PIPELINE_ITEM_LIMIT);
  const event = {
    at: Date.now(),
    stage: stage.slice(0, 48),
    itemCount: Array.isArray(items) ? items.length : 0,
    refs,
    detail: sanitizeFollowedTradePipelineDetail(detail),
  };
  followedTradesPipelinePendingEvents.push(event);
  if (followedTradesPipelineFlushScheduled) return followedTradesPipelineWrite;
  followedTradesPipelineFlushScheduled = true;
  followedTradesPipelineWrite = followedTradesPipelineWrite.catch(() => {}).then(async () => {
    try {
      while (followedTradesPipelinePendingEvents.length) {
        const batch = followedTradesPipelinePendingEvents.splice(0);
        const stored = await chrome.storage.local.get(FOLLOWED_TRADES_PIPELINE_KEY);
        const previous = stored?.[FOLLOWED_TRADES_PIPELINE_KEY];
        const events = Array.isArray(previous?.events) ? previous.events.slice() : [];
        events.push(...batch);
        await chrome.storage.local.set({
          [FOLLOWED_TRADES_PIPELINE_KEY]: {
            version: 1,
            events: events.slice(-FOLLOWED_TRADES_PIPELINE_LIMIT),
          },
        });
      }
    } finally {
      followedTradesPipelineFlushScheduled = false;
    }
  }).catch(() => {
    followedTradesPipelineFlushScheduled = false;
  });
  return followedTradesPipelineWrite;
}

async function queryPumpTransportDiagnostics(message = { type: "getPumpNatsDiagnostics" }) {
  if (!LOCAL_DIAGNOSTICS_AVAILABLE) return null;
  let timer;
  try {
    const result = await Promise.race([
      chrome.runtime.sendMessage({ target: "offscreen", ...message }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1_000); }),
    ]);
    return result?.ok && result.diagnostic ? result.diagnostic : null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function followedTradeDiagnosticsSnapshot() {
  if (!LOCAL_DIAGNOSTICS_AVAILABLE) return { enabled: false, available: false };
  const enabled = await getFollowedTradesDiagnosticsEnabled();
  const gmgnDelivery = gmgnTradeDelivery.snapshot();
  await flushTradeReceipts();
  const receipts = { ...tradeReceipts.snapshot(), storageError: tradeReceiptStorageError };
  if (!enabled) {
    return {
      enabled: false,
      receipts,
      gmgnDelivery,
      fomoApiRequests: [],
      pipeline: [],
    };
  }
  await followedTradesPipelineWrite.catch(() => {});
  const stored = await chrome.storage.local.get([
    FOLLOWED_TRADES_DIAGNOSTIC_KEY,
    FOLLOWED_TRADES_PIPELINE_KEY,
  ]);
  const diagnostic = {
    ...(stored?.[FOLLOWED_TRADES_DIAGNOSTIC_KEY] || {}),
    ...(followedTradesDiagnostic || {}),
  };
  const pipeline = stored?.[FOLLOWED_TRADES_PIPELINE_KEY];
  const transport = await queryPumpTransportDiagnostics();
  return {
    enabled: true,
    ...diagnostic,
    receipts,
    gmgnDelivery,
    pumpRealtime: {
      state: pumpNatsConnectionStatus,
      updatedAt: pumpRealtimeUpdatedAt,
      subjectCount: pumpNatsSubscriptionKey ? 1 : 0,
      lastEventAt: pumpNatsLastEventAt,
      error: pumpRealtimeError,
      retryCount: pumpSubscriptionRetryCount,
      retryScheduled: pumpAlertsPresenceRefreshTimer !== null,
      automaticSessionPageRecovery: false,
      presenceAuth: { ...pumpPresenceAuth },
      transport,
      ingestion: { ...pumpNatsIngestDiagnostics },
      alertsRest: { intervalMs: PUMP_ALERTS_RECONCILE_MS, visibleConsumers: visibleGmgnTradePorts.size,
        inFlight: Boolean(pumpAlertsReconcileRequest), scheduled: pumpAlertsReconcileTimer !== null,
        lastCompletedAt: pumpAlertsReconcileAt, error: pumpAlertsReconcileError },
    },
    fomoRealtime: {
      ...(diagnostic.fomoRealtime || {}),
      state: !fomoAlertSocket ? "disconnected"
        : fomoAlertSocketAuthenticated ? "subscribed" : "connecting",
      socketState: fomoAlertSocket?.readyState ?? null,
      authenticated: fomoAlertSocketAuthenticated,
      hasTopicId: Boolean(fomoAlertSocketKey),
      lastEventAt: fomoAlertLastEventAt,
      reconnectAttempts: fomoAlertSocketReconnectAttempts,
      error: fomoAlertLastError,
      catchupError: fomoAlertCatchupError,
    },
    fomoApiRequests: recentFomoApiRequests.map((entry) => ({ ...entry })),
    pipeline: Array.isArray(pipeline?.events) ? pipeline.events : [],
  };
}

function followedTradeItemKeys(items) {
  return [...new Set((Array.isArray(items) ? items : [])
    .map(followedTradeNotificationKey)
    .filter(Boolean))];
}

function hasFollowedTradeConsumers() {
  return Boolean(followedTradesNetworkByPort.size || gmgnFollowTradeEventPorts.size);
}

function gmgnTradeEventKey(item) {
  if (!item || !["fomo", "pump"].includes(item.platform)) return "";
  return GmgnFollowTrades.stableKey(item);
}

function broadcastGmgnFollowTradeEvents(items, transport) {
  if (!followedTradesEnabled) return 0;
  return gmgnTradeDelivery.publish(items, transport);
}

// GMGN's page supplies missing token metadata through its own market API.
// The worker only freezes fields present on the incoming live Pump event.
function broadcastPumpLiveTrades(items, transport) {
  broadcastGmgnFollowTradeEvents(GmgnPumpApi.withRealtimeMarketSnapshots(items), transport);
}

function broadcastGmgnFollowTradeMetadata(items) {
  if (followedTradesEnabled) gmgnTradeDelivery.metadata(items);
}

function withFollowedTradeRealtime(response, realtimeItems, notificationItems = realtimeItems) {
  return {
    ...response,
    realtimeItemKeys: followedTradeItemKeys(realtimeItems),
    notificationItemKeys: followedTradeItemKeys(notificationItems),
  };
}

function hasFollowedTradeRealtimeKeys(response) {
  return Boolean(response?.realtimeItemKeys?.length || response?.notificationItemKeys?.length);
}

function hasRenderablePumpAlertTrade(item) {
  const positive = (value) => {
    const number = GmgnFomoCore.finiteNumber(value);
    return number !== null && number > 0 ? number : null;
  };
  const hasTradeValue = positive(item?.usdAmount) !== null
    || positive(item?.quoteAmount) !== null;
  const price = positive(item?.priceUsdAtTrade) ?? positive(item?.priceUsdSnapshot);
  const marketCap = positive(item?.marketCapAtTrade) ?? positive(item?.marketCapSnapshot);
  const totalSupply = positive(item?.totalSupplyAtTrade)
    ?? positive(item?.totalSupplySnapshot)
    ?? positive(item?.totalSupply);
  return hasTradeValue && (price !== null || (marketCap !== null && totalSupply !== null));
}

function publishFollowedTradesResponse(response) {
  const cachedResponse = { ...response, realtimeItemKeys: [], notificationItemKeys: [] };
  followedTradesSnapshot = { cachedAt: Date.now(), response: cachedResponse };
  recordFollowedTradesSourceDiagnostic(response);
  for (const [port, networkId] of followedTradesNetworkByPort) {
    postFollowedTradesSnapshot(port, response, networkId);
  }
}

async function publishFomoRealtimeItems(
  items,
  transport = "websocket",
  notify = true,
  notificationItems = items,
) {
  if (!await getFollowedTradesEnabled()) {
    recordFollowedTradePipeline("fomo-filtered", items, { reason: "PUSH_DISABLED", transport });
    return;
  }
  recordFollowedTradePipeline("fomo-realtime-items", items, {
    count: Array.isArray(items) ? items.length : 0,
    transport,
  });
  await hydrateFollowedTradesHistory();
  const acceptedItems = filterUnfollowedTrades(items);
  rememberFollowedTrades("fomo", acceptedItems);
  const acceptedKeys = new Set(acceptedItems.map(GmgnFollowTrades.stableKey));
  const filteredItems = items.filter((item) => (
    !acceptedKeys.has(GmgnFollowTrades.stableKey(item))
  ));
  if (filteredItems.length) recordFollowedTradePipeline("fomo-filtered", filteredItems, { reason: "UNFOLLOWED", transport });
  const response = buildCurrentFollowedTradesResponse({
    fomo: {
      ok: true,
      count: followedTradesHistory.fomo.length,
      transport,
    },
  });
  const realtimeItems = acceptedItems.filter(isVerifiedFomoFollowedTrade);
  if (notify) broadcastGmgnFollowTradeEvents(realtimeItems, transport);
  else if (transport === "websocket-metadata") broadcastGmgnFollowTradeMetadata(realtimeItems);
  publishFollowedTradesResponse(withFollowedTradeRealtime(
    response,
    realtimeItems,
    notify ? filterUnfollowedTrades(notificationItems) : [],
  ));
}

async function publishPumpRealtimeItems(items, transport = "nats+profile-rest", publishAsRealtime = true) {
  if (!await getFollowedTradesEnabled()) return;
  recordFollowedTradePipeline("pump-realtime-items", items, {
    count: Array.isArray(items) ? items.length : 0,
    transport,
  });
  await hydrateFollowedTradesHistory();
  const acceptedItems = filterUnfollowedTrades(items);
  rememberFollowedTrades("pump", acceptedItems);
  const response = buildCurrentFollowedTradesResponse({
    pump: {
      ok: true,
      count: followedTradesHistory.pump.length,
      transport,
    },
  });
  // This legacy profile/RPC path updates extension history and diagnostics only.
  // GMGN delivery is reserved for the platform's official Alerts NATS event path.
  const realtimeItems = publishAsRealtime
    ? acceptedItems.filter(isVerifiedPumpFollowedTrade)
    : [];
  const notificationItems = realtimeItems.filter(hasRenderablePumpAlertTrade);
  publishFollowedTradesResponse(withFollowedTradeRealtime(
    response,
    realtimeItems,
    notificationItems,
  ));
}

async function publishPumpCollectedItems(items, transport, sourceVerification, generation = pumpAlertsPresenceGeneration) {
  if (!await getFollowedTradesEnabled()) return;
  const source = (Array.isArray(items) ? items : []).filter((item) => (
    item?.platform === "pump"
      && item?.sourceVerification === sourceVerification
  ));
  if (!source.length) return;
  recordFollowedTradePipeline("pump-collected-items", source, {
    count: source.length,
    transport,
  });
  await hydrateFollowedTradesHistory();
  if (!followedTradesEnabled) return;
  if (generation !== pumpAlertsPresenceGeneration) {
    // The last GMGN tab may close while its NATS history batch is flushing.
    // Retain that batch locally, without sending into a replacement session.
    if (!hasFollowedTradeConsumers()) rememberFollowedTrades("pump", filterUnfollowedTrades(source));
    return;
  }
  const acceptedItems = filterUnfollowedTrades(source);
  if (!acceptedItems.length) return;
  rememberObservedPumpItems(acceptedItems);
  rememberFollowedTrades("pump", acceptedItems);
  if ([GmgnPumpApi.PUMP_ALERTS_NATS_VERIFICATION, GmgnPumpApi.PUMP_ALERTS_REST_VERIFICATION,
    GmgnPumpApi.PUMP_CHAIN_RPC_VERIFICATION].includes(sourceVerification)) {
    broadcastPumpLiveTrades(acceptedItems, transport, generation);
  }
  // Event-only GMGN consumers do not need a full snapshot. Building one also
  // invokes legacy metadata enrichment over historical tokens.
  if (!followedTradesNetworkByPort.size) return;
  const response = buildCurrentFollowedTradesResponse({
    pump: {
      ok: true,
      count: followedTradesHistory.pump.length,
      transport,
    },
  });
  // The official Alerts trade already went through the dedicated GMGN bridge above.
  // Keep the snapshot response notification-free so it cannot create a second path.
  publishFollowedTradesResponse(withFollowedTradeRealtime(response, acceptedItems, []));
}

function publishPumpAlertRealtimeItems(items) {
  return publishPumpCollectedItems(
    items,
    "alerts-nats",
    GmgnPumpApi.PUMP_ALERTS_NATS_VERIFICATION,
  );
}

function publishPumpRestDeltaItems(items, transport = "alerts-rest-delta", generation = pumpAlertsPresenceGeneration) {
  return publishPumpCollectedItems(
    items,
    transport,
    GmgnPumpApi.PUMP_ALERTS_REST_VERIFICATION,
    generation,
  );
}

function fomoAlertJwt(authorization) {
  return typeof authorization === "string"
    ? authorization.replace(/^Bearer\s+/i, "").trim()
    : "";
}

function clearFomoAlertReconnectTimer() {
  if (fomoAlertSocketReconnectTimer !== null) {
    clearTimeout(fomoAlertSocketReconnectTimer);
  }
  fomoAlertSocketReconnectTimer = null;
}

function clearFomoAuthTimer() {
  if (fomoAlertAuthTimer !== null) clearTimeout(fomoAlertAuthTimer);
  fomoAlertAuthTimer = null;
}

function closeFomoAlertSocket(resetSubscriptionState = true) {
  clearFomoAuthTimer();
  clearFomoAlertReconnectTimer();
  fomoAlertSocketGeneration += 1;
  const socket = fomoAlertSocket;
  fomoAlertSocket = null;
  fomoAlertSocketKey = "";
  fomoAlertSocketAuthenticated = false;
  if (resetSubscriptionState) fomoAlertHasSubscribed = false;
  if (socket) {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try { socket.close(); } catch {}
  }
}

function scheduleFomoAlertReconnect() {
  if (!followedTradesEnabled || !hasFollowedTradeConsumers()
    || fomoAlertSocketReconnectTimer !== null) return;
  const delay = Math.min(
    FOMO_ALERT_RECONNECT_MIN_MS * (2 ** Math.min(fomoAlertSocketReconnectAttempts, 5)),
    FOMO_ALERT_RECONNECT_MAX_MS,
  );
  fomoAlertSocketReconnectAttempts += 1;
  fomoAlertSocketReconnectTimer = setTimeout(() => {
    fomoAlertSocketReconnectTimer = null;
    ensureFomoAlertSocket().catch(() => {});
  }, delay);
  recordFomoRealtimeDiagnostic("reconnecting", { reconnectInMs: delay });
}

async function waitForFomoAlertTopicId() {
  const deadline = Date.now() + SESSION_REFRESH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const session = await getSession();
    if (validFomoAlertTopicId(session?.userId)) return session.userId.trim();
    await new Promise((resolve) => setTimeout(resolve, SESSION_REFRESH_POLL_MS));
  }
  return "";
}

async function captureFomoAlertTopicId() {
  const currentSession = await getSession();
  if (validFomoAlertTopicId(currentSession?.userId)) return currentSession.userId.trim();
  if (fomoAlertTopicCapturePromise) return fomoAlertTopicCapturePromise;
  if (Date.now() - fomoAlertTopicCaptureAttemptedAt < FOMO_ALERT_TOPIC_CAPTURE_COOLDOWN_MS) {
    return "";
  }
  fomoAlertTopicCaptureAttemptedAt = Date.now();
  fomoAlertTopicCapturePromise = (async () => {
    let tab;
    try {
      recordFomoRealtimeDiagnostic("capturing-topic");
      tab = await chrome.tabs.create({ url: FOMO_PAGE_URL, active: false });
      return await waitForFomoAlertTopicId();
    } finally {
      if (Number.isInteger(tab?.id)) await chrome.tabs.remove(tab.id).catch(() => {});
      fomoAlertTopicCapturePromise = null;
    }
  })();
  return fomoAlertTopicCapturePromise;
}

async function recordFomoAlertTopicId(userId) {
  const topicId = typeof userId === "string" ? userId.trim() : "";
  if (!validFomoAlertTopicId(topicId)) throw new Error("INVALID_FOMO_ALERT_TOPIC");
  const result = await chrome.storage.local.get(SESSION_KEY);
  const current = result?.[SESSION_KEY] || {};
  if (current.userId !== topicId) {
    gmgnTradeDelivery.discard((item) => item.platform === "fomo");
    await updateFomoSession({ userId: topicId, updatedAt: Date.now() });
    fomoAlertRestSnapshot = null;
  }
  fomoAlertTopicCaptureAttemptedAt = 0;
  await ensureFomoAlertSocket(current.userId !== topicId);
  return topicId;
}

function refreshFomoAlertsAfterReconnect() {
  if (fomoAlertCatchupRequest) return fomoAlertCatchupRequest;
  fomoAlertRestSnapshot = null;
  fomoAlertCatchupRequest = queryFomoFollowedTrades(true, true).then((items) => {
    fomoAlertCatchupError = "";
    const freshItems = observeFomoRestItems(items);
    rememberFollowedTrades("fomo", items);
    const response = buildCurrentFollowedTradesResponse({
      fomo: {
        ok: true,
        count: followedTradesHistory.fomo.length,
        transport: "websocket+rest-catchup",
      },
    });
    publishFollowedTradesResponse(withFollowedTradeRealtime(
      response,
      freshItems,
      freshItems,
    ));
  }).catch((error) => {
    fomoAlertCatchupError = error?.message || "FOMO_CATCHUP_FAILED";
    recordFomoRealtimeDiagnostic("subscribed");
  }).finally(() => {
    fomoAlertCatchupRequest = null;
  });
  return fomoAlertCatchupRequest;
}

function observeFomoRestItems(items) {
  const verifiedItems = (Array.isArray(items) ? items : []).filter(isVerifiedFomoFollowedTrade);
  const freshItems = [];
  for (const item of verifiedItems) {
    const key = GmgnFollowTrades.stableKey(item);
    if (seenFomoRestTradeKeys.has(key)) continue;
    seenFomoRestTradeKeys.add(key);
    seenFomoRestTradeOrder.push(key);
    if (fomoRestBaselineReady) freshItems.push(item);
  }
  while (seenFomoRestTradeOrder.length > FOMO_REST_SEEN_LIMIT) {
    seenFomoRestTradeKeys.delete(seenFomoRestTradeOrder.shift());
  }
  fomoRestBaselineReady = true;
  const merged = GmgnFollowTrades.mergeFollowedTrades(freshItems);
  if (merged.length) {
    recordFollowedTradePipeline("fomo-rest-delta", merged, { count: merged.length });
  }
  return merged;
}

function isPumpAlertsRestTrade(item) {
  return item?.platform === "pump"
    && item?.sourceVerification === GmgnPumpApi.PUMP_ALERTS_REST_VERIFICATION;
}

function rememberObservedPumpItems(items) {
  for (const item of Array.isArray(items) ? items : []) {
    const key = GmgnFollowTrades.stableKey(item);
    if (seenPumpRestTradeKeys.has(key)) continue;
    seenPumpRestTradeKeys.add(key);
    seenPumpRestTradeOrder.push(key);
  }
  while (seenPumpRestTradeOrder.length > PUMP_REST_SEEN_LIMIT) {
    seenPumpRestTradeKeys.delete(seenPumpRestTradeOrder.shift());
  }
}

function observePumpRestItems(items, initialSince = Infinity) {
  const freshItems = [];
  for (const item of (Array.isArray(items) ? items : []).filter(isPumpAlertsRestTrade)) {
    const key = GmgnFollowTrades.stableKey(item);
    if (seenPumpRestTradeKeys.has(key)) continue;
    seenPumpRestTradeKeys.add(key);
    seenPumpRestTradeOrder.push(key);
    if (pumpRestBaselineReady || item.createdAt >= initialSince) freshItems.push(item);
  }
  while (seenPumpRestTradeOrder.length > PUMP_REST_SEEN_LIMIT) {
    seenPumpRestTradeKeys.delete(seenPumpRestTradeOrder.shift());
  }
  pumpRestBaselineReady = true;
  const merged = GmgnFollowTrades.mergeFollowedTrades(freshItems);
  if (merged.length) {
    recordFollowedTradePipeline("pump-rest-delta", merged, { count: merged.length });
  }
  return merged;
}

function rememberObservedFomoItems(items) {
  for (const item of Array.isArray(items) ? items : []) {
    const key = GmgnFollowTrades.stableKey(item);
    if (seenFomoRestTradeKeys.has(key)) continue;
    seenFomoRestTradeKeys.add(key);
    seenFomoRestTradeOrder.push(key);
  }
  while (seenFomoRestTradeOrder.length > FOMO_REST_SEEN_LIMIT) {
    seenFomoRestTradeKeys.delete(seenFomoRestTradeOrder.shift());
  }
}

function fomoTradeCompleteness(items) {
  const source = Array.isArray(items) ? items : [];
  const positive = (value) => {
    const number = GmgnFomoCore.finiteNumber(value);
    return number !== null && number > 0;
  };
  return {
    count: source.length,
    usdCount: source.filter((item) => positive(item?.usdAmount)).length,
    baseAmountCount: source.filter((item) => positive(item?.baseAmount)).length,
    priceCount: source.filter((item) => positive(item?.priceUsdAtTrade)).length,
    supplyCount: source.filter((item) => positive(item?.totalSupply)).length,
    marketCapCount: source.filter((item) => positive(item?.marketCapAtTrade)).length,
  };
}

function fomoMarketFingerprint(items) {
  return (Array.isArray(items) ? items : []).map((item) => [
    GmgnFollowTrades.stableKey(item),
    item?.tokenSymbol,
    item?.tokenImageUrl,
    item?.usdAmount,
    item?.baseAmount,
    item?.priceUsdAtTrade,
    item?.totalSupply,
    item?.marketCapAtTrade,
    item?.marketCapSource,
  ].join(":")).join("|");
}

function ingestFomoAlertPayload(payload) {
  if (!followedTradesEnabled) {
    recordTradeSourceEvent("fomo-message-skipped", { reason: "PUSH_DISABLED" });
    return;
  }
  let items;
  try {
    items = GmgnFomoApi.sanitizeFomoRealtimeTrade(payload).map((item) => ({
      ...item, sourceVerification: FOMO_FOLLOWED_TRADE_WEBSOCKET,
    }));
  } catch {
    items = [];
  }
  if (!items.length) {
    // Only the public identifying fields; never retain the rejected payload.
    const rejected = { platform: "fomo", id: typeof payload?.id === "string"
      ? (payload.id.startsWith("fomo:") ? payload.id : `fomo:${payload.id}`) : "",
      tokenAddress: payload?.tokenAddress, networkId: payload?.networkId,
      userHandle: payload?.userHandle || payload?.user?.userHandle,
      displayName: payload?.displayName || payload?.user?.displayName,
      tokenSymbol: payload?.ticker || payload?.symbol || payload?.tokenSymbol,
      tokenName: payload?.tokenName };
    recordTradeSourceEvent("fomo-websocket-rejected", { reason: "NORMALIZATION_EMPTY" });
    recordFollowedTradePipeline("fomo-websocket-rejected", [rejected], { reason: "NORMALIZATION_EMPTY" });
    return;
  }
  fomoAlertLastEventAt = Date.now();
  fomoAlertLastError = "";
  rememberObservedFomoItems(items);
  const cachedItems = withCachedFomoFollowedTradesMetadata(items);
  recordFollowedTradePipeline("fomo-websocket-normalized", cachedItems, {
    transport: "websocket",
    ...fomoTradeCompleteness(cachedItems),
  });
  const enrichmentRequest = getSession().then((session) => (
    session?.authorization ? enrichFomoFollowedTrades(cachedItems, session) : cachedItems
  )).catch((error) => {
    recordFollowedTradePipeline("fomo-metadata-error", cachedItems, {
      transport: "websocket",
      error: error?.message || "FOMO_METADATA_FAILED",
    });
    return cachedItems;
  });
  fomoAlertDeliveryRequest = fomoAlertDeliveryRequest.catch(() => {}).then(async () => {
    const firstItems = cachedItems;
    await publishFomoRealtimeItems(firstItems, "websocket", true, firstItems);
    recordFomoRealtimeDiagnostic("receiving", {
      receivedCount: firstItems.length,
    });
    enrichmentRequest.then(async (enrichedItems) => {
      recordFollowedTradePipeline("fomo-metadata-enriched", enrichedItems, {
        transport: "websocket",
        ...fomoTradeCompleteness(enrichedItems),
      });
      if (fomoMarketFingerprint(enrichedItems) !== fomoMarketFingerprint(firstItems)) {
        await publishFomoRealtimeItems(enrichedItems, "websocket-metadata", false, []);
      }
    }).catch(() => {});
  }).catch((error) => {
    fomoAlertLastError = error?.message || "FOMO_ALERT_DELIVERY_FAILED";
    recordFollowedTradePipeline("fomo-delivery-error", cachedItems, { reason: "DELIVERY_EXCEPTION" });
    recordFomoRealtimeDiagnostic("delivery-error");
  });
}

function handleFomoAlertSocketMessage(socket, generation, session, event) {
  if (socket !== fomoAlertSocket || generation !== fomoAlertSocketGeneration) return;
  let message;
  try {
    message = JSON.parse(typeof event?.data === "string" ? event.data : "");
  } catch {
    recordTradeSourceEvent("fomo-message-skipped", { reason: "INVALID_JSON" });
    return;
  }
  if (message?.type === "challenge") {
    const jwt = fomoAlertJwt(session.authorization);
    if (jwt) socket.send(JSON.stringify({ type: "challengeResponse", jwt }));
    return;
  }
  if (message?.type === "challengeAccepted") {
    clearFomoAuthTimer();
    const isReconnect = fomoAlertHasSubscribed;
    fomoAlertHasSubscribed = true;
    fomoAlertSocketAuthenticated = true;
    fomoAlertSocketReconnectAttempts = 0;
    fomoAlertLastError = "";
    socket.send(JSON.stringify({
      type: "subscribe",
      topicType: FOMO_ALERT_TOPIC_TYPE,
      topicId: session.userId,
    }));
    recordFomoRealtimeDiagnostic("subscribed");
    if (isReconnect) refreshFomoAlertsAfterReconnect();
    return;
  }
  if (message?.type === "data"
    && message.topicType === FOMO_ALERT_TOPIC_TYPE
    && String(message.topicId) === String(session.userId)) {
    ingestFomoAlertPayload(message.payload);
    return;
  }
  if (message?.type === "data") {
    recordTradeSourceEvent("fomo-message-skipped", { reason: message.topicType !== FOMO_ALERT_TOPIC_TYPE
      ? "TOPIC_TYPE_MISMATCH" : "TOPIC_ID_MISMATCH" });
  }
  if (message?.type === "error") {
    fomoAlertLastError = typeof message.message === "string"
      ? message.message
      : "FOMO_WS_SERVER_ERROR";
    recordFomoRealtimeDiagnostic("server-error");
  }
}

function fomoSessionExpiresSoon(authorization) {
  try {
    const payload = fomoAlertJwt(authorization).split(".")[1];
    if (!payload) return false;
    const value = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return Number.isFinite(value.exp) && value.exp * 1_000 <= Date.now() + 30_000;
  } catch { return false; }
}

async function ensureFomoAlertSocket(force = false) {
  if (!await getFollowedTradesEnabled() || !hasFollowedTradeConsumers()) return false;
  let session = await getSession();
  if (session?.authorization && fomoSessionExpiresSoon(session.authorization)
    && Date.now() - fomoAlertSessionRefreshAt >= 5 * 60_000) {
    fomoAlertSessionRefreshAt = Date.now();
    await refreshSessionInBackground(session.authorization).catch(() => null);
    session = await getSession();
  }
  if (!await getFollowedTradesEnabled() || !hasFollowedTradeConsumers()) return false;
  if (!session?.authorization) {
    recordFomoRealtimeDiagnostic("missing-session");
    return false;
  }
  if (!validFomoAlertTopicId(session.userId)) {
    await captureFomoAlertTopicId();
    session = await getSession();
  }
  if (!validFomoAlertTopicId(session?.userId)) {
    recordFomoRealtimeDiagnostic("missing-topic");
    return false;
  }
  const socketKey = `${session.userId}:${session.authorization}`;
  if (!force && fomoAlertSocket && fomoAlertSocketKey === socketKey
    && [WebSocket.CONNECTING, WebSocket.OPEN].includes(fomoAlertSocket.readyState)) {
    return true;
  }
  closeFomoAlertSocket(false);
  const generation = fomoAlertSocketGeneration;
  const socket = new WebSocket(FOMO_ALERT_WS_URL);
  fomoAlertSocket = socket;
  fomoAlertSocketKey = socketKey;
  fomoAlertSocketAuthenticated = false;
  recordFomoRealtimeDiagnostic("connecting", { hasTopicId: true });
  fomoAlertAuthTimer = setTimeout(() => {
    if (socket !== fomoAlertSocket || generation !== fomoAlertSocketGeneration
      || fomoAlertSocketAuthenticated) return;
    fomoAlertLastError = "FOMO_WS_AUTH_TIMEOUT";
    closeFomoAlertSocket(false);
    scheduleFomoAlertReconnect();
  }, 20_000);
  socket.onopen = () => {
    if (socket !== fomoAlertSocket || generation !== fomoAlertSocketGeneration) return;
    const jwt = fomoAlertJwt(session.authorization);
    if (jwt) socket.send(JSON.stringify({ type: "challengeResponse", jwt }));
    recordFomoRealtimeDiagnostic("authenticating", { hasTopicId: true });
  };
  socket.onmessage = (event) => handleFomoAlertSocketMessage(socket, generation, session, event);
  socket.onerror = () => {
    if (socket !== fomoAlertSocket || generation !== fomoAlertSocketGeneration) return;
    fomoAlertLastError = "FOMO_WS_CONNECTION_ERROR";
    recordFomoRealtimeDiagnostic("connection-error");
  };
  socket.onclose = () => {
    if (socket !== fomoAlertSocket || generation !== fomoAlertSocketGeneration) return;
    clearFomoAuthTimer();
    fomoAlertSocket = null;
    fomoAlertSocketKey = "";
    fomoAlertSocketAuthenticated = false;
    scheduleFomoAlertReconnect();
  };
  return true;
}

function sanitizeBridgeDiagnostic(value) {
  if (!value || typeof value !== "object") return null;
  const chains = Array.isArray(value.chains)
    ? value.chains.filter((chain) => ["eth", "bsc", "robinhood", "base", "sol"].includes(chain))
    : [];
  const queryKeys = Array.isArray(value.queryKeys)
    ? value.queryKeys.filter((key) => typeof key === "string").slice(0, 20)
      .map((key) => key.slice(0, 80))
    : [];
  return {
    bridgeVersion: typeof value.bridgeVersion === "string" ? value.bridgeVersion.slice(0, 24) : "",
    transport: [
      "axios",
      "fetch",
      "xhr",
      "browser",
      "query-cache",
      "live-response",
      "native-follow-socket",
      "page-snapshot",
      "bridge-snapshot",
      "bridge-runtime",
    ].includes(value.transport)
      ? value.transport
      : "",
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : Date.now(),
    path: typeof value.path === "string" ? value.path.slice(0, 240) : "",
    queryKeys,
    listPath: typeof value.listPath === "string" ? value.listPath.slice(0, 80) : "",
    nativeCount: diagnosticCount(value.nativeCount),
    externalCount: diagnosticCount(value.externalCount),
    insertedCount: diagnosticCount(value.insertedCount),
    chains,
    notificationCount: diagnosticCount(value.notificationCount),
    visibilityState: ["visible", "hidden", "prerender"].includes(value.visibilityState)
      ? value.visibilityState
      : "",
    routeChain: typeof value.routeChain === "string" ? value.routeChain.slice(0, 24) : "",
    itemRefs: (Array.isArray(value.itemRefs) ? value.itemRefs : [])
      .map(diagnosticTradeRef)
      .filter(Boolean)
      .slice(0, FOLLOWED_TRADES_PIPELINE_ITEM_LIMIT),
    runtime: value.runtime && typeof value.runtime === "object" ? {
      webpackRuntimeCaptured: value.runtime.webpackRuntimeCaptured === true,
      webpackModuleCount: diagnosticCount(value.runtime.webpackModuleCount),
      webpackCacheCount: diagnosticCount(value.runtime.webpackCacheCount),
      axiosBridgeInstalled: value.runtime.axiosBridgeInstalled === true,
      followWalletSocketCaptured: value.runtime.followWalletSocketCaptured === true,
      nativeGmgnSoundCaptured: value.runtime.nativeGmgnSoundCaptured === true,
      nativeGmgnSoundError: typeof value.runtime.nativeGmgnSoundError === "string"
        ? value.runtime.nativeGmgnSoundError.slice(0, 80)
        : "",
      gmgnSoundSettingsCaptured: value.runtime.gmgnSoundSettingsCaptured === true,
      fallbackSoundAvailable: value.runtime.fallbackSoundAvailable === true,
      lastSoundSink: [
        "",
        "disabled",
        "gmgn-native",
        "gmgn-native-deduped",
        "extension-audio",
        "failed",
      ]
        .includes(value.runtime.lastSoundSink)
        ? value.runtime.lastSoundSink
        : "",
      lastSoundError: typeof value.runtime.lastSoundError === "string"
        ? value.runtime.lastSoundError.slice(0, 80)
        : "",
      lastSoundAt: Number.isFinite(Number(value.runtime.lastSoundAt))
        ? Number(value.runtime.lastSoundAt)
        : 0,
      queryStoreChunkBridgeInstalled: value.runtime.queryStoreChunkBridgeInstalled === true,
      queryStoreFactoryCount: diagnosticCount(value.runtime.queryStoreFactoryCount),
      queryStoreFactoryExecutionCount: diagnosticCount(value.runtime.queryStoreFactoryExecutionCount),
      queryStorePrototypePatched: value.runtime.queryStorePrototypePatched === true,
      queryClientCount: diagnosticCount(value.runtime.queryClientCount),
      queryCacheCount: diagnosticCount(value.runtime.queryCacheCount),
      boundTrackingQueryCount: diagnosticCount(value.runtime.boundTrackingQueryCount),
      queryCount: diagnosticCount(value.runtime.queryCount),
      trackingQueryCount: diagnosticCount(value.runtime.trackingQueryCount),
      updatedQueryCount: diagnosticCount(value.runtime.updatedQueryCount),
      queryWriteErrorCount: diagnosticCount(value.runtime.queryWriteErrorCount),
      hasSeenTrackingRequest: value.runtime.hasSeenTrackingRequest === true,
      pendingNativeCount: diagnosticCount(value.runtime.pendingNativeCount),
      pendingNativeSoundCount: diagnosticCount(value.runtime.pendingNativeSoundCount),
      refreshWhenVisible: value.runtime.refreshWhenVisible === true,
    } : null,
  };
}

function currentTradeSources() {
  const sources = followedTradesSnapshot?.response?.sources || {};
  return { ...sources, ...(["PUMP_SESSION_REQUIRED", "PUMP_SESSION_EXPIRED"].includes(pumpRealtimeError) ? {
    pump: { ...(sources.pump || {}), ok: false, error: pumpRealtimeError },
  } : {}) };
}

function updatePumpActionState(source) {
  const needsLogin = ["PUMP_SESSION_REQUIRED", "PUMP_SESSION_EXPIRED"]
    .includes(source?.error);
  if (pumpActionNeedsLogin === needsLogin) return;
  pumpActionNeedsLogin = needsLogin;
  chrome.action.setBadgeText({ text: needsLogin ? "!" : "" }).catch(() => {});
  chrome.action.setTitle({
    title: needsLogin ? "Pump 数据未连接，请打开 Pump 检查会话" : "打开 GMGN Fomo 侧边栏",
  }).catch(() => {});
  if (needsLogin) {
    chrome.action.setBadgeBackgroundColor({ color: "#2f9e63" }).catch(() => {});
  }
}

async function queryFollowedTrades(forceFomo = false) {
  const pumpGeneration = pumpAlertsPresenceGeneration;
  await hydrateFollowedTradesHistory();
  const useFomoRealtimeSnapshot = !forceFomo && fomoAlertSocketAuthenticated
    && (Date.now() < fomoRateLimitUntil || (
      fomoAlertRestSnapshot
      && Date.now() - fomoAlertRestSnapshot.cachedAt < FOMO_ALERT_RECONCILE_MS
    ));
  const [fomoResult, pumpResult] = await Promise.allSettled([
    useFomoRealtimeSnapshot
      ? Promise.resolve(followedTradesHistory.fomo)
      : queryFomoFollowedTrades(true, forceFomo),
    queryPumpFollowedTrades(),
  ]);
  const sources = {
    fomo: useFomoRealtimeSnapshot
      ? {
        ok: true,
        count: followedTradesHistory.fomo.length,
        transport: "websocket",
      }
      : followedTradeSource(fomoResult, "fomo"),
    pump: followedTradeSource(pumpResult, "pump"),
  };
  updatePumpActionState(["PUMP_SESSION_REQUIRED", "PUMP_SESSION_EXPIRED"].includes(pumpRealtimeError)
    ? { error: pumpRealtimeError } : sources.pump);
  const fomoItems = fomoResult.status === "fulfilled"
    ? rememberFollowedTrades("fomo", fomoResult.value)
    : followedTradesHistory.fomo;
  const freshFomoRestItems = !useFomoRealtimeSnapshot && fomoResult.status === "fulfilled"
    ? observeFomoRestItems(fomoResult.value)
    : [];
  const freshPumpRestItems = pumpResult.status === "fulfilled" && pumpGeneration === pumpAlertsPresenceGeneration
    ? observePumpRestItems(pumpResult.value)
    : [];
  if (freshPumpRestItems.length) broadcastGmgnFollowTradeEvents(
    filterUnfollowedTrades(freshPumpRestItems), "alerts-rest-delta",
  );
  const pumpItems = pumpResult.status === "fulfilled"
    ? rememberFollowedTrades("pump", pumpResult.value)
    : followedTradesHistory.pump;
  if (fomoResult.status === "rejected" && pumpResult.status === "rejected"
    && !fomoItems.length && !pumpItems.length) {
    const response = { ok: false, error: "FOLLOWED_TRADES_UNAVAILABLE", sources };
    recordFollowedTradesSourceDiagnostic(response);
    return response;
  }
  const response = withFollowedTradeRealtime({
    ok: true,
    items: preparePumpEvmSymbols(GmgnFollowTrades.mergeFollowedTrades(
      fomoItems,
      pumpItems,
    )),
    sources,
    updatedAt: Date.now(),
  }, [...freshFomoRestItems, ...freshPumpRestItems], freshFomoRestItems);
  recordFollowedTradesSourceDiagnostic(response);
  return response;
}

async function queryFollowedTradesShared() {
  if (!await getFollowedTradesEnabled()) return disabledFollowedTradesResponse();
  if (followedTradesSnapshot
    && Date.now() - followedTradesSnapshot.cachedAt < FOLLOWED_TRADES_CACHE_MS) {
    return followedTradesSnapshot.response;
  }
  if (followedTradesRequest) return followedTradesRequest;
  const generation = followedTradesEnabledGeneration;
  followedTradesRequest = queryFollowedTrades().then((response) => {
    if (!followedTradesEnabled || generation !== followedTradesEnabledGeneration) {
      return disabledFollowedTradesResponse();
    }
    if (hasFollowedTradeRealtimeKeys(response)) publishFollowedTradesResponse(response);
    else {
      followedTradesSnapshot = {
        cachedAt: Date.now(),
        response: { ...response, realtimeItemKeys: [], notificationItemKeys: [] },
      };
    }
    return response;
  }).finally(() => {
    followedTradesRequest = null;
  });
  return followedTradesRequest;
}

function followedTradesForNetwork(response, networkId) {
  if (!response?.ok || !Number.isInteger(networkId)) return response;
  const items = response.items.filter((item) => Number(item?.networkId) === networkId);
  const itemKeys = new Set(items.map(followedTradeNotificationKey).filter(Boolean));
  const sources = Object.fromEntries(["fomo", "pump"].map((platform) => {
    const source = response.sources?.[platform];
    return [platform, source?.ok
      ? { ...source, count: items.filter((item) => item.platform === platform).length }
      : source];
  }));
  return {
    ...response,
    items,
    sources,
    realtimeItemKeys: (response.realtimeItemKeys || []).filter((key) => itemKeys.has(key)),
    notificationItemKeys: (response.notificationItemKeys || []).filter((key) => itemKeys.has(key)),
  };
}

function stopFollowedTradesPollingIfIdle() {
  if (followedTradesEnabled
    && (hasFollowedTradeConsumers() || followedTradesPollRunning)) return;
  if (followedTradesEnabled && pumpNatsTradeBatch.length) flushPumpNatsTradeBatch();
  stopFollowedTradesAcquisition();
}

function stopFollowedTradesAcquisition() {
  if (followedTradesPollTimer !== null) clearTimeout(followedTradesPollTimer);
  followedTradesPollTimer = null;
  closeFomoAlertSocket();
  stopPumpNatsSubscriptions();
  for (const state of pumpNatsWalletRefreshStates.values()) {
    state.cancelled = true;
    if (state.timer !== null) clearTimeout(state.timer);
  }
  pumpNatsWalletRefreshStates.clear();
}

function postFollowedTradesSnapshot(port, response, networkId) {
  const scopedResponse = followedTradesForNetwork(response, networkId);
  try {
    port.postMessage({
      type: "followedTradesSnapshot",
      networkId,
      response: scopedResponse,
    });
    recordFollowedTradePipeline("background-broadcast", scopedResponse?.items, {
      count: Array.isArray(scopedResponse?.items) ? scopedResponse.items.length : 0,
      deliveryCount: Array.isArray(scopedResponse?.realtimeItemKeys)
        ? scopedResponse.realtimeItemKeys.length
        : 0,
      notificationCount: Array.isArray(scopedResponse?.notificationItemKeys)
        ? scopedResponse.notificationItemKeys.length
        : 0,
      subscriberCount: followedTradesNetworkByPort.size,
      gmgnSubscriberCount: [...followedTradesNetworkByPort.keys()].filter(
        (candidate) => followedTradesSurfaceByPort.get(candidate) === "gmgn",
      ).length,
      surface: followedTradesSurfaceByPort.get(port) || "other",
    });
  } catch (error) {
    recordFollowedTradePipeline("background-broadcast-error", scopedResponse?.items, {
      error: error?.message || "PORT_POST_FAILED",
      subscriberCount: followedTradesNetworkByPort.size,
      gmgnSubscriberCount: [...followedTradesNetworkByPort.keys()].filter(
        (candidate) => followedTradesSurfaceByPort.get(candidate) === "gmgn",
      ).length,
      surface: followedTradesSurfaceByPort.get(port) || "other",
    });
    followedTradesNetworkByPort.delete(port);
  }
}

async function pollFollowedTradesSubscribers() {
  if (followedTradesPollRunning || !followedTradesEnabled || !followedTradesNetworkByPort.size) return;
  followedTradesPollRunning = true;
  try {
    const response = await queryFollowedTradesShared();
    if (!hasFollowedTradeRealtimeKeys(response)) {
      for (const [port, networkId] of followedTradesNetworkByPort) {
        postFollowedTradesSnapshot(port, response, networkId);
      }
    }
  } catch (error) {
    const response = {
      ok: false,
      error: error?.message || "FOLLOWED_TRADES_UNAVAILABLE",
      sources: followedTradesSnapshot?.response?.sources || {},
    };
    for (const [port, networkId] of followedTradesNetworkByPort) {
      postFollowedTradesSnapshot(port, response, networkId);
    }
  } finally {
    followedTradesPollRunning = false;
    if (followedTradesEnabled && followedTradesNetworkByPort.size) {
      followedTradesPollTimer = setTimeout(() => {
        followedTradesPollTimer = null;
        pollFollowedTradesSubscribers();
      }, FOLLOWED_TRADES_POLL_MS);
    } else {
      stopFollowedTradesPollingIfIdle();
    }
  }
}

function startFollowedTradesPolling() {
  if (!followedTradesEnabled || !followedTradesNetworkByPort.size) return;
  hydrateFollowedTradesHistory().then(() => {
    if (!followedTradesEnabled || !followedTradesNetworkByPort.size) return;
    if (!followedTradesSnapshot && followedTradesHistoryItems().length) {
      publishFollowedTradesResponse(buildCurrentFollowedTradesResponse({
        fomo: {
          ok: true,
          count: followedTradesHistory.fomo.length,
          transport: "local-cache",
        },
        pump: {
          ok: true,
          count: followedTradesHistory.pump.length,
          transport: "local-cache",
        },
      }));
    }
    ensureFomoAlertSocket().catch(() => {});
    if (!followedTradesPollRunning && followedTradesPollTimer === null) {
      pollFollowedTradesSubscribers();
    }
  }).catch(() => {});
}

function startFollowedTradesRealtime() {
  if (!followedTradesEnabled || !gmgnFollowTradeEventPorts.size) return;
  if (!pumpAlertsStartedAt) pumpAlertsStartedAt = Date.now();
  schedulePumpAlertsReconciliation();
  hydrateFollowedTradesHistory().then(() => {
    if (!followedTradesEnabled || !gmgnFollowTradeEventPorts.size) return;
    ensureFomoAlertSocket().catch(() => {});
    ensurePumpNatsSubscriptions().catch((error) => {
      recordPumpRealtimeDiagnostic(pumpNatsConnectionStatus, {
        error: diagnosticError(error?.message) || "PUMP_NATS_CONFIGURE_FAILED",
      });
    });
  }).catch(() => {});
}

function flushPumpNatsTradeBatch() {
  if (pumpNatsTradeBatchTimer !== null) clearTimeout(pumpNatsTradeBatchTimer);
  pumpNatsTradeBatchTimer = null;
  const items = pumpNatsTradeBatch;
  pumpNatsTradeBatch = [];
  if (!items.length) return;
  publishPumpAlertRealtimeItems(items).catch((error) => {
    recordPumpRealtimeDiagnostic(pumpNatsConnectionStatus, {
      error: diagnosticError(error?.message) || "PUMP_NATS_DELIVERY_FAILED",
    });
  });
}

function ingestPumpNatsAlertEvent(event) {
  if (!followedTradesEnabled || !event || typeof event !== "object") return false;
  const count = (key) => {
    if (followedTradesDiagnosticsEnabled) {
      pumpNatsIngestDiagnostics[key] = (pumpNatsIngestDiagnostics[key] || 0) + 1;
    }
  };
  count("received");
  const eventId = typeof event.id === "string" ? event.id.trim() : "";
  if (eventId && seenPumpNatsEventIds.has(eventId)) {
    count("duplicate");
    return false;
  }
  const item = GmgnPumpApi.sanitizeRealtimeAlertTrade(event, undefined, (reason) => {
    count("rejected");
    count(`rejected:${reason}`);
  });
  if (!item) return false;
  count("accepted");
  recordFollowedTradePipeline("pump-nats-normalized", [item], { transport: "alerts-nats" });
  if (seenPumpNatsEventIds.size >= PUMP_NATS_SEEN_EVENT_LIMIT) seenPumpNatsEventIds.clear();
  seenPumpNatsEventIds.add(eventId);
  pumpNatsLastEventAt = Date.now();
  // Keep history/storage work batched, but never hold the native live row for
  // the one-second history batch. The batch publisher shares this dedupe key.
  const generation = pumpAlertsPresenceGeneration;
  getFollowedTradesEnabled().then((enabled) => {
    if (enabled && generation === pumpAlertsPresenceGeneration) {
      broadcastPumpLiveTrades(filterUnfollowedTrades([item]), "alerts-nats", generation);
    }
  }).catch(() => {});
  pumpNatsTradeBatch = [item, ...pumpNatsTradeBatch].slice(0, 50);
  recordPumpRealtimeDiagnostic(pumpNatsConnectionStatus, {
    lastEventAt: pumpNatsLastEventAt,
    pendingTradeCount: pumpNatsTradeBatch.length,
  });
  if (pumpNatsTradeBatchTimer === null) {
    pumpNatsTradeBatchTimer = setTimeout(flushPumpNatsTradeBatch, PUMP_NATS_TRADE_BATCH_MS);
  }
  return true;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === "offscreen") return false;

  const fromOffscreen = _sender.id === chrome.runtime.id
    && _sender.url === chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  if (message?.type === "pumpNatsStatus") {
    if (!fromOffscreen || !["idle", "connecting", "connected", "disconnected"].includes(message.status)) {
      sendResponse({ ok: false });
      return false;
    }
    if (!followedTradesEnabled) {
      sendResponse({ ok: true, ignored: true });
      return false;
    }
    const reconnected = message.status === "connected" && pumpNatsHadConnected;
    if (message.status === "connected") pumpNatsHadConnected = true;
    recordPumpRealtimeDiagnostic(message.status, { reconnected });
    if (message.status === "connected") {
      followedTradesSnapshot = null;
      if (reconnected) {
        reconcilePumpAlerts("alerts-rest-reconnect").catch(() => {});
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "pumpNatsAlertEvent") {
    if (!fromOffscreen) {
      sendResponse({ ok: false });
      return false;
    }
    if (!followedTradesEnabled) {
      sendResponse({ ok: true, ignored: true });
      return false;
    }
    const generation = pumpAlertsPresenceGeneration;
    resolvePumpAlertWallet(message.event).then((event) => {
      const accepted = generation === pumpAlertsPresenceGeneration && followedTradesEnabled
        && ingestPumpNatsAlertEvent(event);
      sendResponse({ ok: true, accepted });
    }).catch(() => sendResponse({ ok: true, accepted: false }));
    return true;
  }

  if (message?.type === "pumpNatsWalletActivity") {
    const subject = GmgnPumpApi.buildAccountBalanceSubject(message.walletAddress);
    const walletAddress = GmgnPumpApi.accountBalanceSubjectWallet(subject);
    if (!fromOffscreen || !walletAddress) {
      sendResponse({ ok: false });
      return false;
    }
    if (!followedTradesEnabled) {
      sendResponse({ ok: true, ignored: true });
      return false;
    }
    pumpNatsLastEventAt = Date.now();
    recordPumpRealtimeDiagnostic(pumpNatsConnectionStatus, { lastWalletActivityAt: pumpNatsLastEventAt });
    schedulePumpNatsWalletRefresh(walletAddress);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "recordFomoAlertTopic") {
    const senderUrl = _sender.tab?.url || _sender.url || "";
    if (_sender.id !== chrome.runtime.id || !senderUrl.startsWith(`${FOMO_PAGE_ORIGIN}/`)) {
      sendResponse({ ok: false, error: "INVALID_MESSAGE_SENDER" });
      return false;
    }
    recordFomoAlertTopicId(message.userId)
      .then((userId) => sendResponse({ ok: true, userId }))
      .catch((error) => sendResponse({
        ok: false,
        error: error?.message || "FOMO_ALERT_TOPIC_CAPTURE_FAILED",
      }));
    return true;
  }

  if (message?.type === "gmgnFomoPing") {
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "getSidePanelVisibility") {
    const windowId = _sender.tab?.windowId;
    sendResponse({
      ok: true,
      visible: Number.isInteger(windowId) && sidePanelPortsByWindow.has(windowId),
    });
    return false;
  }

  if (message?.type === "ensureFomoOverlay") {
    const tab = _sender.tab;
    if (!Number.isInteger(tab?.id) || !/^https:\/\/(www\.)?gmgn\.ai\//.test(_sender.url || tab.url || "")) {
      sendResponse({ ok: false, error: "INVALID_GMGN_TAB" });
      return false;
    }
    ensureFomoOverlay(tab)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: "OVERLAY_LOAD_FAILED" }));
    return true;
  }

  if (message?.type === "openFomoSidePanel") {
    if (!_sender.tab?.id) {
      sendResponse({ ok: false, error: "NO_ACTIVE_TAB" });
      return false;
    }
    chrome.sidePanel.open({ tabId: _sender.tab.id })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || "SIDE_PANEL_OPEN_FAILED" }));
    return true;
  }

  if (message?.type === "checkFollowedTradeDiagnosticSources") {
    if (!LOCAL_DIAGNOSTICS_AVAILABLE) {
      Promise.resolve().then(() => sendResponse({ ok: false, error: "DIAGNOSTICS_UNAVAILABLE" }));
      return true;
    }
    if (_sender.id !== chrome.runtime.id || _sender.url !== chrome.runtime.getURL("diagnostics.html")) {
      sendResponse({ ok: false, error: "INVALID_MESSAGE_SENDER" });
      return false;
    }
    getFollowedTradesEnabled().then((enabled) => enabled
      ? queryFollowedTrades(true) : disabledFollowedTradesResponse())
      .then(sendResponse).catch(() => sendResponse({ ok: false, error: "SOURCE_CHECK_FAILED" }));
    return true;
  }

  if (message?.type === "getFollowedTradeSources") {
    sendResponse({
      ok: true,
      enabled: followedTradesEnabled,
      sources: currentTradeSources(),
    });
    return false;
  }

  if (message?.type === "getFollowedTradesEnabled") {
    getFollowedTradesEnabled()
      .then((enabled) => sendResponse({ ok: true, enabled }))
      .catch((error) => sendResponse({
        ok: false,
        error: error?.message || "FOLLOWED_TRADES_SETTING_FAILED",
      }));
    return true;
  }

  if (message?.type === "setFollowedTradesEnabled") {
    if (_sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: "INVALID_MESSAGE_SENDER" });
      return false;
    }
    setFollowedTradesEnabled(message.enabled)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error?.message || "FOLLOWED_TRADES_SETTING_FAILED",
      }));
    return true;
  }

  if (message?.type === "getFollowedTradeDiagnosticsEnabled") {
    getFollowedTradesDiagnosticsEnabled()
      .then((enabled) => sendResponse({ ok: true, enabled }))
      .catch((error) => sendResponse({
        ok: false,
        error: error?.message || "DIAGNOSTICS_SETTING_FAILED",
      }));
    return true;
  }

  if (message?.type === "setFollowedTradeDiagnosticsEnabled") {
    if (_sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: "INVALID_MESSAGE_SENDER" });
      return false;
    }
    setFollowedTradesDiagnosticsEnabled(message.enabled)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error?.message || "DIAGNOSTICS_SETTING_FAILED",
      }));
    return true;
  }

  if (message?.type === "recordFollowedTradeBridgeDiagnostic") {
    if (_sender.id !== chrome.runtime.id || !followedTradesDiagnosticsEnabled) {
      sendResponse({ ok: false });
      return false;
    }
    const diagnostic = sanitizeBridgeDiagnostic(message.diagnostic);
    if (diagnostic) {
      const stage = diagnostic.transport === "page-snapshot"
        ? "page-snapshot"
        : diagnostic.transport === "bridge-snapshot"
          ? "bridge-snapshot"
          : diagnostic.transport === "bridge-runtime"
            ? "bridge-runtime"
          : diagnostic.transport === "native-follow-socket"
            ? "native-delivered"
            : "bridge-merged";
      recordFollowedTradePipeline(stage, diagnostic.itemRefs, {
        transport: diagnostic.transport,
        notificationCount: diagnostic.notificationCount,
        nativeCount: diagnostic.nativeCount,
        externalCount: diagnostic.externalCount,
        insertedCount: diagnostic.insertedCount,
        visibilityState: diagnostic.visibilityState,
        routeChain: diagnostic.routeChain,
        chains: diagnostic.chains,
      });
      if (diagnostic.transport === "bridge-runtime") {
        persistFollowedTradesDiagnostic({
          bridgeRuntime: {
            bridgeVersion: diagnostic.bridgeVersion,
            updatedAt: diagnostic.updatedAt,
            visibilityState: diagnostic.visibilityState,
            externalCount: diagnostic.externalCount,
            ...diagnostic.runtime,
          },
        });
      } else if (!["page-snapshot", "bridge-snapshot"].includes(diagnostic.transport)) {
        persistFollowedTradesDiagnostic({ bridge: diagnostic });
      }
    }
    sendResponse({ ok: Boolean(diagnostic) });
    return false;
  }

  if (message?.type === "updateFollowedTradesWindow") {
    const senderUrl = _sender.tab?.url || _sender.url || "";
    if (_sender.id !== chrome.runtime.id || !senderUrl.startsWith("https://gmgn.ai/")) {
      sendResponse({ ok: false, error: "INVALID_MESSAGE_SENDER" });
      return false;
    }
    updateFollowedTradesWindow(message.window)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error?.message || "TRACKING_WINDOW_UPDATE_FAILED",
      }));
    return true;
  }

  if (message?.type === "getFollowedTradeDiagnostics") {
    followedTradeDiagnosticsSnapshot()
      .then((diagnostic) => sendResponse({ ok: true, diagnostic }))
      .catch((error) => sendResponse({
        ok: false,
        error: error?.message || "DIAGNOSTICS_UNAVAILABLE",
      }));
    return true;
  }

  if (message?.type === "gmgnTokenRouteChanged") {
    if (_sender.tab?.active) {
      chrome.runtime.sendMessage({
        type: "sidePanelRouteChanged",
        route: message.route || null,
        tabId: _sender.tab.id,
      }).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  let request;
  if (message?.type === "queryFomoToken") {
    request = queryFomoTokenShared(message.params);
  } else if (message?.type === "resolveFomoHolderAddress") {
    request = resolveFomoHolderAddressShared(message.params, message.holder, _sender.tab?.id);
  } else if (message?.type === "resolvePumpHolderAddress") {
    request = resolvePumpHolderAddressShared(message.params, message.holder);
  } else if (message?.type === "copyHolderAddress") {
    if (_sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: "INVALID_MESSAGE_SENDER" });
      return false;
    }
    request = copyHolderAddress(message.address, message.networkId);
  } else if (message?.type === "queryPumpHolders") {
    request = queryPumpHoldersShared(message.params).then((payload) => ({
      ok: true,
      items: GmgnPumpApi.sanitizePositions(payload, message.metadata),
    }));
  } else if (message?.type === "queryHolderFollowStates") {
    request = queryHolderFollowStates(message.force === true);
  } else if (message?.type === "toggleHolderFollow") {
    if (_sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: "INVALID_MESSAGE_SENDER" });
      return false;
    }
    request = toggleHolderFollow(message);
  } else if (message?.type === "queryFollowedTrades") {
    request = queryFollowedTradesShared().then(
      (response) => followedTradesForNetwork(
        response,
        Number.isInteger(message.networkId) ? message.networkId : null,
      ),
    );
  } else {
    return false;
  }

  request
    .then(sendResponse)
    .catch((error) => {
      const code = error?.message || "FOMO_REQUEST_FAILED";
      const isFomoRequest = ["queryFomoToken", "resolveFomoHolderAddress"]
        .includes(message?.type);
      sendResponse({
        ok: false,
        error: isFomoRequest && code === "HTTP_401" ? "FOMO_SESSION_EXPIRED" : code,
      });
    });
  return true;
});
