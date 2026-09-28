const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const core = require("../src/core");
const fomoApi = require("../src/fomo-api");
const evmResolver = require("../src/evm-holder-resolver");
const pumpApi = require("../src/pump-api");
const followTrades = require("../src/follow-trades");

const SESSION_KEY = "fomoApiSessionV1";
const TOKEN_CACHE_KEY = "fomoTokenCacheV1";
const TOKEN_CACHE_INDEX_KEY = "fomoTokenCacheIndexV2";
const TOKEN_CACHE_ENTRY_PREFIX = "fomoTokenCacheEntryV2:";
const FOLLOWED_TRADES_ENABLED_KEY = "followedTradesEnabledV1";
const FOLLOWED_TRADES_DIAGNOSTICS_ENABLED_KEY = "followedTradesDiagnosticsEnabledV1";
const FOLLOWED_TRADES_DIAGNOSTIC_KEY = "followedTradesDiagnosticV1";
const FOLLOWED_TRADES_PIPELINE_KEY = "followedTradesPipelineV1";
const FOLLOWED_TRADES_STORAGE_KEY = "followedTradesCacheV1";
const PUMP_IDENTITY_KEY = "pumpViewerIdentityV1";
const harnessTimers = new Set();
test.afterEach(() => {
  for (const timer of harnessTimers) clearTimeout(timer);
  harnessTimers.clear();
});

function storageArea(data, setCalls = [], removeCalls = []) {
  return {
    async get(key) {
      if (typeof key === "string") return { [key]: data[key] };
      if (Array.isArray(key)) {
        return Object.fromEntries(key.filter((item) => Object.hasOwn(data, item)).map((item) => [item, data[item]]));
      }
      return { ...data };
    },
    async set(values) {
      setCalls.push(values);
      Object.assign(data, values);
    },
    async remove(key) {
      const keys = Array.isArray(key) ? key : [key];
      removeCalls.push(...keys);
      for (const item of keys) delete data[item];
    },
  };
}

function runtimePort(name, senderUrl = "") {
  const messageListeners = [];
  const disconnectListeners = [];
  const messages = [];
  const waiters = [];
  return {
    name,
    ...(senderUrl ? { sender: { tab: { url: senderUrl } } } : {}),
    onMessage: { addListener(listener) { messageListeners.push(listener); } },
    onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
    postMessage(message) {
      messages.push(message);
      waiters.splice(0).forEach((resolve) => resolve(message));
    },
    send(message) { messageListeners.forEach((listener) => listener(message)); },
    disconnect() { disconnectListeners.forEach((listener) => listener()); },
    nextMessage() {
      if (messages.length) return Promise.resolve(messages.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    drainMessages() {
      return messages.splice(0);
    },
  };
}

function createHarness({
  publicRuntime = false,
  initialAuthorization,
  responseStatus,
  responseHeaders = {},
  backoffState = null,
  tokenAwareRequests = false,
  replacementAuthorization = null,
  pumpStatus = 200,
  pumpPresenceStatus = null,
  updateSessionRules = async () => {},
  pumpTabStatus = "complete",
  pumpReplacementStatus = null,
  pumpUserPayload = null,
  pumpTradePayload = null,
  pumpProfileEnabled = false,
  pumpPresencePayload = null,
  pumpFollowingPayload = null,
  pumpProfilePayload = null,
  pumpCoinPayload = null,
  solanaRpcPayload = null,
  pumpResponseDelayMs = 0,
  pumpProfileDelayMs = 0,
  existingPumpTab = true,
  pumpPageIdentity = null,
  pumpIdentity = null,
  pumpPublicStatus = null,
  pumpNatsHtml = null,
  gmgnStatus = 200,
  gmgnPageStatus = 200,
  gmgnPagePayload = null,
  blockscoutStatus = 200,
  blockscoutPayload = null,
  rpcPayload = null,
  deferGmgn = false,
  cachedData = null,
  followedTradesCache = null,
  followedTradesEnabled,
  diagnosticsEnabled = true,
  receiptSessionData = null,
  responseDelayMs = 0,
  responseJsonDelayMs = 0,
  responseJsonNeverSettles = false,
  tokenRequestTimeoutMs = null,
  accelerateTokenFeedGrace = false,
  accelerateFomoAuthTimeout = false,
  accelerateFomoFollowedTimeout = false,
  acceleratePumpNatsRefresh = false,
  responsePayload = () => ({ responseObject: [] }),
}) {
  let clockNow = Date.now();
  class HarnessDate extends Date {
    static now() { return clockNow; }
  }
  const localData = {
    [SESSION_KEY]: {
      authorization: initialAuthorization,
      userId: "viewer-user",
      supportedChains: "1,56",
      updatedAt: 1,
    },
  };
  if (pumpIdentity) localData[PUMP_IDENTITY_KEY] = pumpIdentity;
  if (followedTradesCache) localData[FOLLOWED_TRADES_STORAGE_KEY] = followedTradesCache;
  if (typeof followedTradesEnabled === "boolean") {
    localData[FOLLOWED_TRADES_ENABLED_KEY] = followedTradesEnabled;
  }
  if (typeof diagnosticsEnabled === "boolean") {
    localData[FOLLOWED_TRADES_DIAGNOSTICS_ENABLED_KEY] = diagnosticsEnabled;
  }
  if (cachedData) {
    localData[TOKEN_CACHE_KEY] = {
      "56:0x1234": { cachedAt: clockNow, data: cachedData },
    };
  }
  const sessionData = receiptSessionData ? { followedTradeReceiptsV1: receiptSessionData } : {};
  if (backoffState) sessionData.fomoApiBackoffV1 = backoffState;
  const fomoBodies = [];
  const requestedAuthorizations = [];
  const requestedUrls = [];
  const requestedRpcUrls = [];
  const requestedRpcPayloads = [];
  const pumpRequestCredentials = [];
  const pumpRequestMethods = [];
  const removedTabIds = [];
  const createdTabDetails = [];
  const updatedTabs = [];
  const actionState = { badgeText: "", title: "", badgeColor: null };
  const createdTabs = new Map();
  if (existingPumpTab) {
    createdTabs.set(70, { id: 70, url: "https://pump.fun/?tab=friends", active: false });
  }
  let createdTabCount = 0;
  let pumpSessionOpened = false;
  let fomoRequestCount = 0;
  let pumpRequestCount = 0;
  let pumpPageRequestCount = 0;
  let gmgnRequestCount = 0;
  let gmgnPageRequestCount = 0;
  let blockscoutRequestCount = 0;
  let rpcRequestCount = 0;
  let solanaRpcRequestCount = 0;
  let offscreenCreateCount = 0;
  const offscreenMessages = [];
  const runtimeMessages = [];
  const localSetCalls = [];
  const localRemoveCalls = [];
  let releaseGmgn;
  const gmgnGate = new Promise((resolve) => { releaseGmgn = resolve; });
  let requestHeaderListener;
  let requestCompletedListener;
  let messageListener;
  let connectListener;
  const webSockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      webSockets.push(this);
    }

    send(data) {
      this.sent.push(JSON.parse(data));
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.({});
    }

    receive(message) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({});
    }
  }

  const scheduledTimers = new Map();
  const context = {
    AbortController,
    atob,
    Date: HarnessDate,
    URL,
    WebSocket: FakeWebSocket,
    clearTimeout,
    console,
    // Instrumented unit tests use an isolated config; publicRuntime loads the shipped config.
    GmgnRuntimeConfig: { localDiagnostics: true },
    importScripts() {},
    setTimeout(handler, delay, ...args) {
      const authDelay = accelerateFomoAuthTimeout && delay === 20_000 ? 5 : delay;
      const tokenDelay = accelerateTokenFeedGrace && authDelay === 750 ? 20 : authDelay;
      const effectiveDelay = accelerateFomoFollowedTimeout && tokenDelay === 10_000 ? 20 : tokenDelay;
      const pumpDelay = acceleratePumpNatsRefresh
        && [250, 1_000, 2_000, 5_000].includes(effectiveDelay)
        ? 5
        : effectiveDelay;
      const timer = setTimeout(handler, pumpDelay, ...args);
      scheduledTimers.set(timer, { handler, delay });
      harnessTimers.add(timer);
      return timer;
    },
    GmgnTradeDelivery: require("../src/trade-delivery"),
    GmgnTradeReceipts: require("../src/trade-receipts"),
    GmgnFomoCore: core,
    GmgnFomoApi: {
      GMGN_API_ORIGIN: "https://gmgn.ai",
      FOLLOWED_TRADES_MAX_PAGES: 3,
      buildRequests(params) {
        const timeout = Number.isFinite(tokenRequestTimeoutMs)
          ? { timeoutMs: tokenRequestTimeoutMs }
          : {};
        const query = tokenAwareRequests ? `?token=${params.address}&network=${params.networkId}` : "";
        return {
          metadata: { url: `https://prod-api.fomo.family/metadata${query}`, method: "GET", ...timeout },
          holders: { url: `https://prod-api.fomo.family/holders${query}`, method: "GET", ...timeout },
          feed: { url: `https://prod-api.fomo.family/feed${query}`, method: "GET", ...timeout },
        };
      },
      buildTradeRequest(_params, holder) {
        return { url: `https://prod-api.fomo.family/trades/${holder.tradeId}`, method: "GET" };
      },
      buildGmgnHoldersRequest(params) {
        return { url: `https://gmgn.ai/vas/api/v1/token_holders/bsc/${params.address}`, method: "GET" };
      },
      sanitizeMetadata(payload) {
        return payload.metadata || { name: "Token", totalSupply: 1_000_000 };
      },
      sanitizeHolders(payload) {
        return payload.holders || { items: [] };
      },
      sanitizeFeed(payload) {
        return payload.feed || [];
      },
      buildFollowedTradesRequest(lastId = "") {
        return {
          url: `https://prod-api.fomo.family/feed/tradingActivity?threshold=0${lastId ? `&lastId=${encodeURIComponent(lastId)}` : ""}`,
          method: "GET",
        };
      },
      buildCurrentUserRequest() {
        return { url: "https://prod-api.fomo.family/v2/users/current", method: "GET" };
      },
      currentUserId(payload) {
        return typeof payload?.responseObject?.id === "string" ? payload.responseObject.id : "";
      },
      buildFollowingIdsRequest() {
        return { url: "https://prod-api.fomo.family/v2/users/current/followingIds", method: "GET" };
      },
      sanitizeFollowingIds(payload) {
        return payload?.responseObject?.followingIds || [];
      },
      buildFollowMutationRequest(viewerUserId, followingUserId, shouldFollow) {
        return {
          url: "https://prod-api.fomo.family/follows",
          method: shouldFollow ? "POST" : "DELETE",
          body: JSON.stringify({ user_id: viewerUserId, following_id: followingUserId }),
        };
      },
      followedTradesNextCursor(payload) {
        return payload?.hasNextPage && typeof payload?.nextCursor === "string"
          ? payload.nextCursor
          : "";
      },
      buildFollowedTradesMetadataRequest(items) {
        const keys = (Array.isArray(items) ? items : []).filter(
          (item) => typeof item?.tokenAddress === "string" && Number.isInteger(Number(item?.networkId)),
        ).map((item) => {
          const address = item.tokenAddress.startsWith("0x")
            ? item.tokenAddress.toLowerCase()
            : item.tokenAddress;
          return `${address}:${item.networkId}`;
        });
        return keys.length ? {
          url: "https://prod-api.fomo.family/proxy/filterTokens",
          method: "POST",
          body: JSON.stringify(keys),
        } : null;
      },
      sanitizeFollowedTrades(payload) {
        return payload.trades || payload?.responseObject?.items || [];
      },
      sanitizeFomoRealtimeTrade(payload) {
        if (payload?.platform === "fomo" && ["buy", "sell"].includes(payload?.type)) {
          return [payload];
        }
        return fomoApi.sanitizeFomoRealtimeTrade(payload);
      },
      sanitizeFollowedTradesMetadata(payload) {
        return payload.tradeMetadata || [];
      },
      withFollowedTradesMetadata(items, metadataItems) {
        return fomoApi.withFollowedTradesMetadata(items, metadataItems);
      },
      sanitizeHolderTrade(_tradePayload, _params, holder) {
        return {
          currentAmountRaw: String(holder.humanAmountRaw ?? holder.humanAmount),
          buyTimestampMs: holder.buyTimestampMs ?? null,
        };
      },
      sanitizeVerifiedHolderAddress(_tradePayload, gmgnPayload) {
        if (!gmgnPayload.address) throw new Error("HOLDER_ADDRESS_NOT_FOUND");
        return gmgnPayload.address;
      },
    },
    GmgnEvmHolderResolver: evmResolver,
    GmgnPumpApi: pumpProfileEnabled ? pumpApi : {
      FOLLOWED_TRADES_MAX_PAGES: 2,
      PUMP_CHAIN_RPC_VERIFICATION: pumpApi.PUMP_CHAIN_RPC_VERIFICATION,
      PUMP_ALERTS_NATS_VERIFICATION: pumpApi.PUMP_ALERTS_NATS_VERIFICATION,
      PUMP_ALERTS_REST_VERIFICATION: pumpApi.PUMP_ALERTS_REST_VERIFICATION,
      sanitizeRealtimeAlertTrade: pumpApi.sanitizeRealtimeAlertTrade,
      withRealtimeMarketSnapshots: pumpApi.withRealtimeMarketSnapshots,
      SOLANA_RPC_ORIGIN: pumpApi.SOLANA_RPC_ORIGIN,
      buildPositionsRequest(params) {
        return { url: `https://frontend-api-v3.pump.fun/mint-positions/${params.address}`, method: "GET" };
      },
      buildUserRequest(userId) {
        return { url: `https://frontend-api-v3.pump.fun/users/${userId}`, method: "GET" };
      },
      buildFollowedTradesRequest(cursor = "") {
        return {
          url: `https://frontend-api-v3.pump.fun/following-positions/alerts?kinds=trade${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          method: "GET",
          credentials: "include",
        };
      },
      followedTradesNextCursor(payload) {
        return typeof payload?.nextCursor === "string" ? payload.nextCursor : "";
      },
      sanitizeUserWallet(payload, networkId) {
        return core.normalizeWalletAddress(payload?.canonical_evm_wallet, networkId);
      },
      sanitizePositions() {
        return [];
      },
      sanitizeFollowedTrades(payload) {
        return payload.items || [];
      },
      mergeHolderItems(fomoItems, pumpItems) {
        return [...fomoItems, ...pumpItems];
      },
    },
    GmgnFollowTrades: {
      mergeFollowedTrades(...sources) {
        return followTrades.mergeFollowedTrades(...sources);
      },
      stableKey: followTrades.stableKey,
      pruneFollowedTrades(items, networkIds, cutoffMs) {
        const active = new Set(networkIds);
        if (!active.size || cutoffMs === null) return items;
        return items.filter((item) => (
          !active.has(Number(item.networkId)) || Number(item.createdAt) >= cutoffMs
        ));
      },
    },
    fetch: async (_url, options) => {
      if (_url === "https://pump.fun/?tab=friends" && pumpNatsHtml !== null) {
        return {
          ok: true,
          status: 200,
          async text() { return pumpNatsHtml; },
        };
      }
      if (_url === pumpApi.SOLANA_RPC_ORIGIN) {
        solanaRpcRequestCount += 1;
        const payload = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          async json() {
            return typeof solanaRpcPayload === "function"
              ? solanaRpcPayload(payload)
              : solanaRpcPayload || [];
          },
        };
      }
      if (_url.startsWith(`${pumpApi.PROFILE_ORIGIN}/`)) {
        return {
          ok: true,
          status: 200,
          async json() {
            if (pumpProfileDelayMs) {
              await new Promise((resolve) => setTimeout(resolve, pumpProfileDelayMs));
            }
            return typeof pumpProfilePayload === "function"
              ? pumpProfilePayload(_url)
              : pumpProfilePayload || { transactions: [], pagination: {} };
          },
        };
      }
      if (Object.values([
        "https://rpc.hyperliquid.xyz/evm",
        "https://ethereum-rpc.publicnode.com",
        "https://bsc-rpc.publicnode.com",
        "https://rpc-bsc.blockmachine.io",
        "https://bsc.drpc.org",
        "https://mainnet.base.org/",
        "https://rpc.mainnet.chain.robinhood.com",
      ]).includes(_url)) {
        rpcRequestCount += 1;
        requestedRpcUrls.push(_url);
        const payload = JSON.parse(options.body);
        requestedRpcPayloads.push(payload);
        return {
          ok: true,
          status: 200,
          async json() { return rpcPayload ? rpcPayload(payload, _url) : {}; },
        };
      }
      if (_url.startsWith("https://gmgn.ai/vas/api/v1/token_holders/")) {
        gmgnRequestCount += 1;
        requestedUrls.push(_url);
        if (deferGmgn) await gmgnGate;
        return {
          ok: gmgnStatus >= 200 && gmgnStatus < 300,
          status: gmgnStatus,
          async json() { return responsePayload(_url); },
        };
      }
      if (_url.startsWith("https://robinhoodchain.blockscout.com/api/v2/")) {
        blockscoutRequestCount += 1;
        return {
          ok: blockscoutStatus >= 200 && blockscoutStatus < 300,
          status: blockscoutStatus,
          async json() { return blockscoutPayload ? blockscoutPayload(_url) : {}; },
        };
      }
      if (_url.startsWith("https://frontend-api-v3.pump.fun/")) {
        pumpRequestCount += 1;
        pumpRequestCredentials.push(options.credentials);
        pumpRequestMethods.push({ method: options.method || "GET", url: _url });
        const publicRequest = _url.includes("/following/")
          || _url.includes("/users/")
          || _url.includes("/sol-price")
          || _url.includes("/coins-v3/");
        const currentStatus = _url.includes("/following-positions/alerts/presence") && pumpPresenceStatus !== null
          ? (typeof pumpPresenceStatus === "function" ? pumpPresenceStatus(pumpSessionOpened) : pumpPresenceStatus)
          : publicRequest && pumpPublicStatus !== null
          ? pumpPublicStatus
          : pumpSessionOpened && pumpReplacementStatus !== null
            ? pumpReplacementStatus
            : pumpStatus;
        return {
          ok: currentStatus >= 200 && currentStatus < 300,
          status: currentStatus,
          async text() { return ""; },
          async json() {
            if (pumpResponseDelayMs) {
              await new Promise((resolve) => setTimeout(resolve, pumpResponseDelayMs));
            }
            if (_url.includes("/following-positions/alerts/presence")) {
              return pumpPresencePayload || {};
            }
            if (_url.includes("/users/")) {
              return typeof pumpUserPayload === "function"
                ? pumpUserPayload(_url)
                : pumpUserPayload || {};
            }
            if (_url.includes("/following/")) return pumpFollowingPayload || [];
            if (_url.includes("/sol-price")) return { solPrice: 100 };
            if (_url.includes("/coins-v3/")) return pumpCoinPayload || {};
            if (_url.includes("/following-positions/alerts")) {
              return typeof pumpTradePayload === "function"
                ? pumpTradePayload(_url, pumpRequestCount)
                : pumpTradePayload || { items: [] };
            }
            return { positions: [] };
          },
        };
      }
      fomoRequestCount += 1;
      fomoBodies.push(options.body);
      requestedUrls.push(_url);
      const responseDelay = typeof responseDelayMs === "function"
        ? responseDelayMs(_url)
        : responseDelayMs;
      if (responseDelay) {
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          const timer = setTimeout(() => {
            options.signal?.removeEventListener("abort", onAbort);
            resolve();
          }, responseDelay);
          options.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      const authorization = options.headers.authorization;
      requestedAuthorizations.push(authorization);
      const status = responseStatus(authorization, _url);
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get(name) { return responseHeaders[name.toLowerCase()] ?? null; } },
        async json() {
          if (responseJsonNeverSettles) return new Promise(() => {});
          const jsonDelay = typeof responseJsonDelayMs === "function"
            ? responseJsonDelayMs(_url)
            : responseJsonDelayMs;
          if (jsonDelay) {
            await new Promise((resolve, reject) => {
              const onAbort = () => {
                clearTimeout(timer);
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              };
              const timer = setTimeout(() => {
                options.signal?.removeEventListener("abort", onAbort);
                resolve();
              }, jsonDelay);
              options.signal?.addEventListener("abort", onAbort, { once: true });
            });
          }
          return responsePayload(_url, options);
        },
      };
    },
  };

  context.chrome = {
    declarativeNetRequest: { updateSessionRules },
    action: {
      async setBadgeText({ text }) { actionState.badgeText = text; },
      async setTitle({ title }) { actionState.title = title; },
      async setBadgeBackgroundColor({ color }) { actionState.badgeColor = color; },
    },
    runtime: {
      id: "extension-id",
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onConnect: { addListener(listener) { connectListener = listener; } },
      onMessage: { addListener(listener) { messageListener = listener; } },
      getURL(path) { return `chrome-extension://extension-id/${path}`; },
      async getContexts() { return offscreenCreateCount ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : []; },
      async sendMessage(message) {
        if (message?.target === "offscreen") {
          offscreenMessages.push(message);
          return { ok: true };
        }
        runtimeMessages.push(message);
        return undefined;
      },
    },
    offscreen: {
      async createDocument() { offscreenCreateCount += 1; },
    },
    scripting: {
      async executeScript(details) {
        const requestUrl = details?.args?.[0];
        if (typeof requestUrl === "string" && requestUrl.startsWith("https://frontend-api-v3.pump.fun/")) {
          pumpRequestCount += 1;
          pumpPageRequestCount += 1;
          pumpRequestCredentials.push("include");
          const currentStatus = (pumpSessionOpened || pumpRequestCount > 1)
            && pumpReplacementStatus !== null
            ? pumpReplacementStatus
            : pumpStatus;
          return [{ result: {
            ok: currentStatus >= 200 && currentStatus < 300,
            status: currentStatus,
            text: JSON.stringify(
              typeof pumpTradePayload === "function"
                ? pumpTradePayload(requestUrl, pumpRequestCount)
                : pumpTradePayload || { items: [] },
            ),
          } }];
        }
        if (details?.world === "MAIN" && details?.target?.tabId === 70
          && !Array.isArray(details?.args)) {
          return [{ result: pumpPageIdentity }];
        }
        if (details?.world !== "MAIN" || gmgnPagePayload === null) return undefined;
        gmgnPageRequestCount += 1;
        return [{ result: {
          ok: gmgnPageStatus >= 200 && gmgnPageStatus < 300,
          status: gmgnPageStatus,
          text: JSON.stringify(gmgnPagePayload),
        } }];
      },
    },
    sidePanel: {
      async setPanelBehavior() {},
      async open() {},
    },
    storage: {
      local: storageArea(localData, localSetCalls, localRemoveCalls),
      session: storageArea(sessionData),
    },
    tabs: {
      async query(details = {}) {
        const urls = Array.isArray(details.url) ? details.url : [details.url];
        if (urls.some((url) => String(url || "").startsWith("https://pump.fun/"))) {
          return [...createdTabs.values()].filter((tab) => String(tab.url || "").startsWith("https://pump.fun/"));
        }
        return [];
      },
      async sendMessage() {},
      async create(details = {}) {
        createdTabCount += 1;
        createdTabDetails.push(details);
        const tab = { id: 72 + createdTabCount, status: pumpTabStatus, ...details };
        createdTabs.set(tab.id, tab);
        if (String(details.url || "").startsWith("https://pump.fun/")) {
          pumpSessionOpened = true;
        }
        if (replacementAuthorization && String(details.url || "").startsWith("https://fomo.family/")) {
          requestHeaderListener({
            initiator: "https://fomo.family",
            requestHeaders: [{ name: "authorization", value: replacementAuthorization }],
          });
          await Promise.resolve();
        }
        return tab;
      },
      async get(tabId) {
        if (!createdTabs.has(tabId)) throw new Error("TAB_NOT_FOUND");
        return createdTabs.get(tabId);
      },
      async update(tabId, details) {
        updatedTabs.push({ tabId, details });
        const tab = createdTabs.get(tabId);
        if (!tab) throw new Error("TAB_NOT_FOUND");
        Object.assign(tab, details);
        return tab;
      },
      async remove(tabId) {
        removedTabIds.push(tabId);
        createdTabs.delete(tabId);
      },
    },
    webRequest: {
      onCompleted: { addListener(listener) { requestCompletedListener = listener; } },
      onBeforeSendHeaders: {
        addListener(listener) { requestHeaderListener = listener; },
      },
    },
  };

  if (publicRuntime) {
    delete context.GmgnRuntimeConfig;
    vm.runInNewContext(fs.readFileSync("src/runtime-config.js", "utf8"), context);
  }
  vm.runInNewContext(fs.readFileSync("src/background.js", "utf8"), context);

  return {
    actionState,
    closePumpPages() { createdTabs.clear(); },
    createdTabCount: () => createdTabCount,
    createdTabDetails,
    localData,
    localRemoveCalls,
    localSetCalls,
    fomoBodies,
    sessionData,
    runtimeContext: context,
    enrichFomo(items) { return context.enrichFomoFollowedTrades(items, localData[SESSION_KEY]); },
    queryFomoRest(force = false) { return context.queryFomoFollowedTrades(true, force); },
    query(params = { address: "0x1234", networkId: 56 }, options = {}) {
      return new Promise((resolve) => {
        const pending = messageListener({ type: "queryFomoToken", params, ...options }, {}, resolve);
        assert.equal(pending, true);
      });
    },
    queryPump(params = { address: "0x1234", networkId: 56 }) {
      return new Promise((resolve) => {
        const pending = messageListener({
          type: "queryPumpHolders",
          params,
          metadata: { totalSupply: 1_000_000 },
        }, {}, resolve);
        assert.equal(pending, true);
      });
    },
    checkDiagnosticSources() {
      return new Promise((resolve) => {
        const pending = messageListener({ type: "checkFollowedTradeDiagnosticSources" },
          { id: "extension-id", url: "chrome-extension://extension-id/diagnostics.html" }, resolve);
        assert.equal(pending, true);
      });
    },
    queryFollowedTrades(networkId = null) {
      return new Promise((resolve) => {
        const pending = messageListener({ type: "queryFollowedTrades", networkId }, {}, resolve);
        assert.equal(pending, true);
      });
    },
    queryHolderFollowStates(force = false) {
      return new Promise((resolve) => {
        const pending = messageListener({ type: "queryHolderFollowStates", force }, { id: "extension-id" }, resolve);
        assert.equal(pending, true);
      });
    },
    toggleHolderFollow(message) {
      return new Promise((resolve) => {
        const pending = messageListener({ type: "toggleHolderFollow", ...message }, { id: "extension-id" }, resolve);
        assert.equal(pending, true);
      });
    },
    connectFollowedTrades(networkId) {
      const port = runtimePort("gmgnFollowedTrades");
      connectListener(port);
      port.send({ type: "subscribeFollowedTrades", networkId });
      return port;
    },
    connectGmgnTradeEvents() {
      const port = runtimePort(
        "gmgnFollowTradeEvents",
        "https://gmgn.ai/sol/token/example",
      );
      connectListener(port);
      return port;
    },
    pumpNatsWalletActivity(walletAddress) {
      return new Promise((resolve) => {
        const pending = messageListener({
          type: "pumpNatsWalletActivity",
          walletAddress,
        }, {
          id: "extension-id",
          url: "chrome-extension://extension-id/offscreen.html",
        }, resolve);
        assert.equal(pending, false);
      });
    },
    pumpNatsAlertEvent(event) {
      return new Promise((resolve) => {
        const pending = messageListener({
          type: "pumpNatsAlertEvent",
          event,
        }, {
          id: "extension-id",
          url: "chrome-extension://extension-id/offscreen.html",
        }, resolve);
        assert.equal(pending, true);
      });
    },
    pumpNatsStatus(status) {
      return new Promise((resolve) => {
        const pending = messageListener({
          type: "pumpNatsStatus",
          status,
        }, {
          id: "extension-id",
          url: "chrome-extension://extension-id/offscreen.html",
        }, resolve);
        assert.equal(pending, false);
      });
    },
    publishPumpRealtimeItems(items, transport = "test", notify = true) {
      return context.publishPumpRealtimeItems(items, transport, notify);
    },
    sanitizeFollowIdentity(value) {
      return context.sanitizeFollowIdentity(value);
    },
    getFollowedTradeSources() {
      return new Promise((resolve) => {
        const pending = messageListener({ type: "getFollowedTradeSources" }, {}, resolve);
        assert.equal(pending, false);
      });
    },
    getFollowedTradesEnabled() {
      return new Promise((resolve) => {
        const pending = messageListener({ type: "getFollowedTradesEnabled" }, { id: "extension-id" }, resolve);
        assert.equal(pending, true);
      });
    },
    setFollowedTradesEnabled(enabled) {
      return new Promise((resolve) => {
        const pending = messageListener({
          type: "setFollowedTradesEnabled",
          enabled,
        }, { id: "extension-id" }, resolve);
        assert.equal(pending, true);
      });
    },
    getFollowedTradeDiagnosticsEnabled() {
      return new Promise((resolve) => {
        const pending = messageListener({
          type: "getFollowedTradeDiagnosticsEnabled",
        }, { id: "extension-id" }, resolve);
        assert.equal(pending, true);
      });
    },
    setFollowedTradeDiagnosticsEnabled(enabled) {
      return new Promise((resolve) => {
        const pending = messageListener({
          type: "setFollowedTradeDiagnosticsEnabled",
          enabled,
        }, { id: "extension-id" }, resolve);
        assert.equal(pending, true);
      });
    },
    getFollowedTradeDiagnostics() {
      return new Promise((resolve) => {
        const pending = messageListener({ type: "getFollowedTradeDiagnostics" }, {}, resolve);
        assert.equal(pending, true);
      });
    },
    recordFollowedTradeBridgeDiagnostic(diagnostic) {
      return new Promise((resolve) => {
        const pending = messageListener({
          type: "recordFollowedTradeBridgeDiagnostic",
          diagnostic,
        }, { id: "extension-id" }, resolve);
        assert.equal(pending, false);
      });
    },
    updateFollowedTradesWindow(window) {
      return new Promise((resolve) => {
        const pending = messageListener({
          type: "updateFollowedTradesWindow",
          window,
        }, {
          id: "extension-id",
          tab: { url: "https://gmgn.ai/?chain=all" },
        }, resolve);
        assert.equal(pending, true);
      });
    },
    resolveHolder(params = { address: "0x1234", networkId: 56 }, holder = {
      tradeId: "trade-1",
      userId: "user-1",
      humanAmount: 100,
    }) {
      return new Promise((resolve) => {
        const pending = messageListener({
          type: "resolveFomoHolderAddress",
          params,
          holder,
        }, { tab: { id: 99 } }, resolve);
        assert.equal(pending, true);
      });
    },
    resolvePumpHolder(params = { address: "0x1234", networkId: 56 }, holder = {
      userId: "pump-user-1",
    }) {
      return new Promise((resolve) => {
        const pending = messageListener({
          type: "resolvePumpHolderAddress",
          params,
          holder,
        }, { tab: { id: 99 } }, resolve);
        assert.equal(pending, true);
      });
    },
    copyAddress(address, networkId = 56) {
      return new Promise((resolve) => {
        const pending = messageListener({
          type: "copyHolderAddress",
          address,
          networkId,
        }, { id: "extension-id" }, resolve);
        assert.equal(pending, true);
      });
    },
    fomoRequestCount: () => fomoRequestCount,
    pumpRequestCount: () => pumpRequestCount,
    pumpPageRequestCount: () => pumpPageRequestCount,
    gmgnRequestCount: () => gmgnRequestCount,
    gmgnPageRequestCount: () => gmgnPageRequestCount,
    blockscoutRequestCount: () => blockscoutRequestCount,
    rpcRequestCount: () => rpcRequestCount,
    solanaRpcRequestCount: () => solanaRpcRequestCount,
    advanceTime(ms) { clockNow += ms; },
    now: () => clockNow,
    reconcilePumpAlerts: () => context.reconcilePumpAlerts(),
    runPumpReconcileTimer() {
      const timer = vm.runInContext("pumpAlertsReconcileTimer", context);
      const scheduled = scheduledTimers.get(timer);
      if (!scheduled) return false;
      clearTimeout(timer);
      scheduled.handler();
      return true;
    },
    runPumpPresenceTimer() {
      const timer = vm.runInContext("pumpAlertsPresenceRefreshTimer", context);
      const scheduled = scheduledTimers.get(timer);
      assert.ok(scheduled);
      clearTimeout(timer);
      scheduled.handler();
      return scheduled.delay;
    },
    pumpReconcileState() {
      return vm.runInContext("({ scheduled: pumpAlertsReconcileTimer !== null, inFlight: Boolean(pumpAlertsReconcileRequest), lastAt: pumpAlertsReconcileAt, error: pumpAlertsReconcileError })", context);
    },
    ensurePumpSubscriptions(force = false) { return context.ensurePumpNatsSubscriptions(undefined, force); },
    fetchPublicJson(request) { return context.fetchPublicJson(request); },
    notifyPumpPageRequest(details = {}) { requestCompletedListener({
      initiator: "https://pump.fun", statusCode: 200, ...details,
    }); },
    resolvePumpSolanaGroups(groups, solPrice = null) {
      return context.resolvePumpSolanaProfileGroups(groups, solPrice);
    },
    offscreenCreateCount: () => offscreenCreateCount,
    offscreenMessages,
    runtimeMessages,
    releaseGmgn,
    removedTabIds,
    requestHeaderListener,
    requestedAuthorizations,
    pumpRequestCredentials,
    pumpRequestMethods,
    requestedRpcPayloads,
    requestedRpcUrls,
    requestedUrls,
    updatedTabs,
    webSockets,
  };
}

function officialPumpEvent(id, createdAt) {
  return { id, kind: "trade", createdAt: new Date(createdAt).toISOString(),
    walletAddress: "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm",
    coinMint: "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump",
    author: { userId: "friend", userName: "Friend", walletAddress: "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm" },
    coin: { mint: "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump", chainId: core.TOKEN_NETWORK_IDS.sol, symbol: "LIVE" },
    trade: { tx: `tx-${id}`, isBuy: true, baseAmount: 100, amountUsd: 25, priceUsd: 0.25 } };
}

test("Pump 正常 GMGN 页面无需诊断：首屏基线、30 秒增量、双来源去重和最终回执", async () => {
  let items = [officialPumpEvent("old", Date.now() - 120_000)];
  const h = createHarness(realtimePumpOptions({ diagnosticsEnabled: false,
    pumpTradePayload: () => ({ items, nextCursor: "must-not-fetch-page-2" }) }));
  const p = h.connectGmgnTradeEvents();
  const p2 = h.connectGmgnTradeEvents();
  const alerts = () => h.pumpRequestMethods.map((r) => r.url).filter((url) => /\/following-positions\/alerts\?/.test(url));
  try {
    await new Promise(setImmediate);
    p.send({ type: "gmgnFollowTradeVisibility", visible: true });
    p2.send({ type: "gmgnFollowTradeVisibility", visible: true });
    assert.equal(h.runPumpReconcileTimer(), true);
    await h.reconcilePumpAlerts();
    assert.equal(alerts().length, 1, "多个页面共用首屏请求，忽略 nextCursor");
    assert.deepEqual(p.drainMessages(), [], "启动前的历史不制造实时提醒");
    assert.equal(h.pumpReconcileState().scheduled, true);
    h.advanceTime(30_000);
    const restFirst = officialPumpEvent("rest-first", h.now());
    items = [restFirst, ...items];
    assert.equal(h.runPumpReconcileTimer(), true);
    await h.reconcilePumpAlerts();
    const received = p.drainMessages().filter((m) => m.type === "gmgnFollowTradeEvent");
    assert.equal(received.length, 1, "REST 新交易必须真正投递到 GMGN 端口");
    assert.equal(received[0].item.transactionHash, restFirst.trade.tx);
    assert.equal(received[0].item.sourceVerification, pumpApi.PUMP_ALERTS_REST_VERIFICATION);
    p2.drainMessages();
    await h.pumpNatsAlertEvent(restFirst);
    await new Promise(setImmediate);
    assert.deepEqual(p.drainMessages(), [], "REST 先到后 NATS 不能重复投递");
    const ticket = received[0].deliveryId;
    p.send({ type: "gmgnFollowTradeAck", deliveryId: ticket, status: "decoded" });
    let d = (await h.getFollowedTradeDiagnostics()).diagnostic;
    assert.equal(d.gmgnDelivery.acknowledged, 0, "解码不是列表显示成功");
    p.send({ type: "gmgnFollowTradeAck", deliveryId: ticket, status: "accepted", reason: "ROW_RENDERED" });
    d = (await h.getFollowedTradeDiagnostics()).diagnostic;
    const receipt = d.receipts.trades.find((r) => r.transactionHash === restFirst.trade.tx);
    assert.ok(receipt.stages["pump-nats-normalized"]);
    assert.ok(receipt.stages["gmgn-row-rendered"]);
    const natsFirst = officialPumpEvent("nats-first", h.now());
    await h.pumpNatsAlertEvent(natsFirst);
    await new Promise(setImmediate);
    assert.equal(p.drainMessages().filter((m) => m.type === "gmgnFollowTradeEvent").length, 1);
    items = [natsFirst, ...items];
    h.advanceTime(30_000);
    h.runPumpReconcileTimer();
    await h.reconcilePumpAlerts();
    assert.deepEqual(p.drainMessages(), [], "NATS 先到后 REST 不能重复投递");
    assert.equal(alerts().length, 3);
    assert.equal(h.solanaRpcRequestCount(), 0, "市值由 GMGN 页面补齐，不额外查链");
    assert.equal(h.pumpRequestMethods.some((r) => /\/sol-price|\/coins-v3\//.test(r.url)), false, JSON.stringify(h.pumpRequestMethods));
    assert.equal(h.localData[FOLLOWED_TRADES_DIAGNOSTIC_KEY], undefined);
    p.send({ type: "gmgnFollowTradeVisibility", visible: false });
    assert.equal(h.pumpReconcileState().scheduled, true, "另一个可见页面仍需对账");
    p2.send({ type: "gmgnFollowTradeVisibility", visible: false });
    assert.equal(h.pumpReconcileState().scheduled, false, "全部隐藏立即取消周期任务");
  } finally { p.disconnect(); p2.disconnect(); }
  assert.equal(h.pumpReconcileState().scheduled, false);
});

test("Pump 对账关闭/重启时丢弃旧响应，隐藏页不周期拉取，重连仍补首屏", async () => {
  let release;
  let items = [];
  let blocked = false;
  const h = createHarness(realtimePumpOptions({ diagnosticsEnabled: false,
    pumpTradePayload: () => blocked ? new Promise((resolve) => { release = resolve; }) : { items } }));
  const p = h.connectGmgnTradeEvents();
  try {
    await new Promise(setImmediate);
    await h.reconcilePumpAlerts();
    await h.pumpNatsStatus("connected");
    await h.pumpNatsStatus("disconnected");
    h.advanceTime(1_000);
    items = [officialPumpEvent("reconnected", h.now())];
    await h.pumpNatsStatus("connected");
    await h.reconcilePumpAlerts();
    assert.equal(p.drainMessages().filter((m) => m.type === "gmgnFollowTradeEvent").length, 1);
    assert.equal(h.pumpReconcileState().scheduled, false);
    blocked = true;
    const pending = h.reconcilePumpAlerts();
    await new Promise(setImmediate);
    assert.equal(typeof release, "function");
    await h.setFollowedTradesEnabled(false);
    await h.setFollowedTradesEnabled(true);
    p.drainMessages();
    release({ items: [officialPumpEvent("stale-response", h.now())] });
    await pending;
    assert.deepEqual(p.drainMessages(), []);
    assert.equal(h.localData[FOLLOWED_TRADES_STORAGE_KEY]?.items?.some((i) => i.transactionHash === "tx-stale-response"), false);
  } finally { p.disconnect(); }
});

test("401 时立即结束 Token 加载并在后台换取新 Authorization", async () => {
  const harness = createHarness({
    initialAuthorization: "old-token",
    replacementAuthorization: "new-token",
    responseStatus: (authorization) => authorization === "new-token" ? 200 : 401,
  });

  const result = await harness.query();

  assert.equal(result.ok, false);
  assert.equal(result.error, "FOMO_SESSION_REFRESHING");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(harness.localData[SESSION_KEY].authorization, "new-token");
  assert.equal(harness.createdTabCount(), 1);
  assert.deepEqual(harness.removedTabIds, [73]);
  assert.equal(harness.requestedAuthorizations.includes("old-token"), true);
  assert.equal(harness.requestedAuthorizations.includes("new-token"), true);
  assert.equal(
    harness.runtimeMessages.some((message) => message?.type === "fomoSessionChanged"),
    true,
  );
});

test("扩展自己的 API 请求不会覆盖 Fomo 页面会话", async () => {
  const harness = createHarness({
    initialAuthorization: "page-token",
    responseStatus: () => 200,
  });

  harness.requestHeaderListener({
    initiator: "chrome-extension://extension-id",
    requestHeaders: [{ name: "authorization", value: "replayed-token" }],
  });
  await Promise.resolve();

  assert.equal(harness.localData[SESSION_KEY].authorization, "page-token");
});

test("403 不再清除会话或强制打开 Fomo", async () => {
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 403,
  });

  const result = await harness.query();

  assert.equal(result.ok, false);
  assert.equal(result.error, "HTTP_403");
  assert.equal(harness.localData[SESSION_KEY].authorization, "stable-token");
  assert.equal(harness.createdTabCount(), 0);
  assert.deepEqual(harness.removedTabIds, []);
});

test("Fomo Token 请求诊断只暴露路径、状态、错误和耗时", async () => {
  const harness = createHarness({
    initialAuthorization: "Bearer must-not-appear",
    responseStatus: () => 403,
  });

  await harness.query();
  const response = await harness.getFollowedTradeDiagnostics();
  const requests = Array.from(response.diagnostic.fomoApiRequests)
    .sort((left, right) => left.path.localeCompare(right.path));

  assert.deepEqual(requests.map((entry) => entry.path), ["/feed", "/holders", "/metadata"]);
  assert.equal(requests.every((entry) => entry.status === 403), true);
  assert.equal(requests.every((entry) => entry.error === "HTTP_403"), true);
  assert.equal(requests.every((entry) => Number.isFinite(entry.durationMs)), true);
  assert.equal(JSON.stringify(requests).includes("must-not-appear"), false);
  assert.equal(JSON.stringify(requests).includes("authorization"), false);
});

test("Fomo 返回 429 后在退避窗口内不继续撞接口", async () => {
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 429,
  });

  const first = await harness.query();
  const second = await harness.query();

  assert.equal(first.ok, false);
  assert.equal(first.error, "HTTP_429");
  assert.equal(second.error, "FOMO_RATE_LIMIT_BACKOFF");
  assert.equal(harness.fomoRequestCount(), 3);

  harness.advanceTime(15_001);
  await harness.query();
  assert.equal(harness.fomoRequestCount(), 6);
});

test("Fomo 首屏请求不再等待或触发 Pump 请求", async () => {
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 503,
  });

  const result = await harness.query();

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.holders.items, []);
  assert.equal(harness.pumpRequestCount(), 0);
  assert.equal(harness.requestedAuthorizations.every((value) => value === "stable-token"), true);
});

test("Fomo 持仓首屏不等待慢 Feed，Feed 完成后独立补入缓存", async () => {
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    responseDelayMs: (url) => url.endsWith("/feed") ? 100 : 0,
    accelerateTokenFeedGrace: true,
    responsePayload: (url) => {
      if (url.endsWith("/holders")) return { holders: { items: [{ id: "fresh-holder" }] } };
      if (url.endsWith("/feed")) return { feed: [{ id: "fresh-feed" }] };
      return { metadata: { name: "Fresh token", totalSupply: 1_000_000 } };
    },
  });

  const result = await Promise.race([
    harness.query(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("WAITED_FOR_FEED")), 70)),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.deepEqual(Array.from(result.pendingSections), ["feed"]);
  assert.equal(result.data.holders.items[0].id, "fresh-holder");
  assert.deepEqual(Array.from(result.data.feed), []);

  await new Promise((resolve) => setTimeout(resolve, 120));
  const entry = harness.localData[`${TOKEN_CACHE_ENTRY_PREFIX}56:0x1234`];
  assert.equal(entry.data.feed[0].id, "fresh-feed");
});

test("独立 Pump 请求失败时不影响已经返回的 Fomo 数据", async () => {
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 503,
  });

  const fomoResult = await harness.query();
  const pumpResult = await harness.queryPump();

  assert.equal(fomoResult.ok, true);
  assert.equal(pumpResult.ok, false);
  assert.equal(pumpResult.error, "HTTP_503");
  assert.equal(harness.pumpRequestCount(), 1);
});

test("同一 Token 的重叠 Pump holder 查询复用一个在途请求", async () => {
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpResponseDelayMs: 25,
  });

  const [first, second] = await Promise.all([harness.queryPump(), harness.queryPump()]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(harness.pumpRequestCount(), 1);
});

test("追踪流并发查询 Fomo 与 Pump，单边失败仍返回另一边交易", async () => {
  const fomoTrade = { id: "fomo:trade-1", platform: "fomo", type: "buy", createdAt: 100 };
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 503,
    responsePayload: (url) => url.includes("/feed/tradingActivity?")
      ? { trades: [fomoTrade] }
      : { responseObject: [] },
  });

  const result = await harness.queryFollowedTrades();

  assert.equal(result.ok, true);
  assert.deepEqual(result.items, [{
    ...fomoTrade,
    sourceVerification: "fomo-trading-activity-rest",
  }]);
  assert.equal(result.sources.fomo.ok, true);
  assert.equal(result.sources.pump.ok, false);
  assert.equal(result.sources.pump.error, "HTTP_503");
  assert.deepEqual(harness.pumpRequestCredentials, ["include"]);
});

test("扩展后台重启后先从本地缓存恢复交易时市值", async () => {
  const cachedTrade = {
    id: "fomo:cached-snapshot",
    platform: "fomo",
    sourceVerification: "fomo-trading-activity-rest",
    type: "buy",
    createdAt: 1_788_000_000_000,
    networkId: 56,
    tokenAddress: "0x7777777777777777777777777777777777777777",
    marketCapAtTrade: 367_700,
    totalSupply: 1_000_000_000,
  };
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 503,
    pumpStatus: 503,
    followedTradesCache: { version: 1, updatedAt: Date.now(), items: [cachedTrade] },
  });

  const result = await harness.queryFollowedTrades();

  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, cachedTrade.id);
  assert.equal(result.items[0].marketCapAtTrade, 367_700);
});

test("GMGN 历史请求只读缓存，合并两平台最近 30 条并遵守链和开关", async () => {
  const cached = Array.from({ length: 45 }, (_, index) => ({
    id: `cached-${index}`, platform: index % 2 ? "pump" : "fomo", type: "buy",
    createdAt: Date.now() - index * 1000, networkId: 56,
    sourceVerification: index % 2 ? pumpApi.PUMP_ALERTS_REST_VERIFICATION : "fomo-trading-activity-rest",
  }));
  const harness = createHarness({
    initialAuthorization: null, responseStatus: () => 503, pumpStatus: 503,
    followedTradesCache: { items: [...cached,
      { ...cached[0], id: "wrong-chain", networkId: 8453 },
      { ...cached[1], id: "profile-only", sourceVerification: pumpApi.PUMP_CHAIN_RPC_VERIFICATION },
    ] },
  });
  const port = harness.connectGmgnTradeEvents();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const counts = [harness.fomoRequestCount(), harness.pumpRequestCount()];
    port.send({ type: "getGmgnRecentTrades", requestId: "first", chains: ["bsc"] });
    const reply = await port.nextMessage();
    port.drainMessages();
    assert.equal(reply.type, "gmgnRecentTrades");
    assert.deepEqual(reply.items.map((item) => item.id), cached.slice(0, 30).map((item) => item.id));
    assert.deepEqual([harness.fomoRequestCount(), harness.pumpRequestCount()], counts);
    await harness.setFollowedTradesEnabled(false);
    assert.equal((await port.nextMessage()).type, "gmgnFollowTradeReset");
    port.drainMessages();
    port.send({ type: "getGmgnRecentTrades", requestId: "disabled", chains: ["bsc"] });
    assert.equal((await port.nextMessage()).items.length, 0);
  } finally { port.disconnect(); }
});

test("Pump 新事件无需等待历史批次，刷新断开后仍持久化待存交易", async () => {
  const harness = createHarness({
    initialAuthorization: null, responseStatus: () => 503, pumpStatus: 503,
  });
  const port = harness.connectGmgnTradeEvents();
  await new Promise((resolve) => setImmediate(resolve));
  const event = {
    id: "before-refresh", kind: "trade", createdAt: new Date().toISOString(),
    author: { userId: "friend", userName: "Friend", walletAddress: "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm" },
    coin: { mint: "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump", chainId: core.TOKEN_NETWORK_IDS.sol, symbol: "LIVE" },
    trade: { tx: "refresh-tx", isBuy: true, baseAmount: 100, amountUsd: 25, priceUsd: 0.25 },
  };
  try {
    assert.equal((await harness.pumpNatsAlertEvent({ id: event.id, kind: "trade" })).accepted, false);
    assert.equal((await harness.pumpNatsAlertEvent(event)).accepted, true, "无效的早期消息不能占用去重键");
    await new Promise((resolve) => setImmediate(resolve));
    const live = port.drainMessages();
    assert.equal(live.length, 1, "本轮微任务即投递，不等一秒批次");
    assert.equal(live[0].item.pumpEventId, event.id);
    assert.equal(harness.localData[FOLLOWED_TRADES_STORAGE_KEY]?.items?.length || 0, 0);
    port.send({ type: "getGmgnRecentTrades", requestId: "pending", chains: ["sol"] });
    const reply = await port.nextMessage();
    assert.equal(reply.items[0].pumpEventId, event.id, "历史读取应包括尚未落盘的批次");
  } finally { port.disconnect(); }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.localData[FOLLOWED_TRADES_STORAGE_KEY].items[0].pumpEventId, event.id);
});

test("Fomo 取消关注后清空该用户全部插件交易且保留其他用户与 Pump 同名记录", async () => {
  const cachedItems = [{
    id: "fomo-target-bsc",
    platform: "fomo",
    type: "sell",
    userId: "target-user",
    networkId: 56,
    createdAt: 10,
    sourceVerification: "fomo-trading-activity-rest",
  }, {
    id: "fomo-other-base",
    platform: "fomo",
    type: "buy",
    userId: "other-user",
    networkId: 8453,
    createdAt: 9,
    sourceVerification: "fomo-trading-activity-rest",
  }, {
    id: "pump-same-user-id",
    platform: "pump",
    type: "buy",
    userId: "target-user",
    networkId: 56,
    createdAt: 8,
  }];
  const harness = createHarness({
    initialAuthorization: "Bearer live",
    responseStatus: () => 200,
    followedTradesCache: { version: 1, updatedAt: 1, items: cachedItems },
    responsePayload(url) {
      if (url.endsWith("/v2/users/current/followingIds")) {
        return { responseObject: { followingIds: ["target-user", "other-user"] } };
      }
      if (url.endsWith("/v2/users/current")) {
        return { responseObject: { id: "viewer-user" } };
      }
      if (url.endsWith("/follows")) return { statusCode: 200, responseObject: {} };
      return { responseObject: { items: [] } };
    },
  });

  const state = await harness.queryHolderFollowStates();
  assert.deepEqual([...state.states.fomo], ["target-user", "other-user"]);

  const result = await harness.toggleHolderFollow({
    platform: "fomo",
    userId: "target-user",
    following: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.following, false);
  assert.equal(result.removed, 1);
  assert.deepEqual(
    harness.localData[FOLLOWED_TRADES_STORAGE_KEY].items.map((item) => item.id),
    ["fomo-other-base", "pump-same-user-id"],
  );
});

test("首次进入 Token 强制刷新时绕过 Pump 关注列表缓存", async () => {
  const viewer = "A1EbAYSRyWCUgRi3Q9iphNtRD3pAqTrm2sq79CR5J4v8";
  const harness = createHarness({
    initialAuthorization: "Bearer live",
    responseStatus: () => 200,
    existingPumpTab: false,
    pumpProfileEnabled: true,
    pumpIdentity: { viewerWallet: viewer, userId: "viewer-pump", updatedAt: Date.now() },
    pumpPublicStatus: 200,
    pumpFollowingPayload: [],
    responsePayload(url) {
      if (url.endsWith("/v2/users/current/followingIds")) {
        return { responseObject: { followingIds: [] } };
      }
      if (url.endsWith("/v2/users/current")) {
        return { responseObject: { id: "viewer-user" } };
      }
      return { responseObject: [] };
    },
  });

  await harness.queryHolderFollowStates();
  assert.equal(harness.pumpRequestCount(), 1);
  await harness.queryHolderFollowStates();
  assert.equal(harness.pumpRequestCount(), 1, "普通刷新应复用关注状态快照");
  await harness.queryHolderFollowStates(true);
  assert.equal(harness.pumpRequestCount(), 2, "强制刷新必须重新请求 Pump 关注列表");
});

test("Pump 取消关注后按 userId 和 canonical 钱包清掉跨链记录", async () => {
  const viewer = "A1EbAYSRyWCUgRi3Q9iphNtRD3pAqTrm2sq79CR5J4v8";
  const target = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const targetEvm = "0x1160079f1463dc5f9f20b1f1b9cf628718649c18";
  const other = "Hv3a4PaPvMPE5inwNoS27uFBRoeoJJMRSCJsKtExNH54";
  const cachedItems = [{
    id: "pump-target-sol",
    platform: "pump",
    type: "buy",
    userId: "pump-target",
    walletAddress: target,
    networkId: core.TOKEN_NETWORK_IDS.sol,
    createdAt: 10,
  }, {
    id: "pump-target-evm-legacy",
    platform: "pump",
    type: "sell",
    userId: "",
    walletAddress: targetEvm,
    networkId: core.TOKEN_NETWORK_IDS.robinhood,
    createdAt: 9,
  }, {
    id: "pump-other",
    platform: "pump",
    type: "buy",
    userId: "pump-other",
    walletAddress: other,
    networkId: core.TOKEN_NETWORK_IDS.sol,
    createdAt: 8,
  }, {
    id: "fomo-same-user-id",
    platform: "fomo",
    type: "buy",
    userId: "pump-target",
    networkId: 56,
    createdAt: 7,
    sourceVerification: "fomo-trading-activity-rest",
  }];
  const harness = createHarness({
    initialAuthorization: "Bearer live",
    responseStatus: () => 200,
    existingPumpTab: false,
    pumpProfileEnabled: true,
    pumpIdentity: { viewerWallet: viewer, userId: "viewer-pump", updatedAt: Date.now() },
    pumpPublicStatus: 200,
    pumpFollowingPayload: [{
      address: target,
      userId: "pump-target",
      canonical_evm_wallet: targetEvm,
    }],
    pumpUserPayload: {
      userId: "pump-target",
      canonical_svm_wallet: target,
      canonical_evm_wallet: targetEvm,
    },
    followedTradesCache: { version: 1, updatedAt: 1, items: cachedItems },
  });

  const state = await harness.queryHolderFollowStates();
  assert.deepEqual(JSON.parse(JSON.stringify(state.states.pump)), [{
    userId: "pump-target",
    address: target,
    evmAddress: targetEvm,
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.sanitizeFollowIdentity({
    platform: "pump",
    ...state.states.pump[0],
  }))), {
    platform: "pump",
    userId: "pump-target",
    wallets: [target, targetEvm],
  });

  const result = await harness.toggleHolderFollow({
    platform: "pump",
    userId: "pump-target",
    walletAddress: target,
    following: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.removed, 2);
  assert.deepEqual(
    harness.localData[FOLLOWED_TRADES_STORAGE_KEY].items.map((item) => item.id).sort(),
    ["fomo-same-user-id", "pump-other"],
  );
});

test("新交易快照持久化，重复 REST 数据不会用空值覆盖成交时市值", async () => {
  const trade = {
    id: "fomo:persisted-snapshot",
    platform: "fomo",
    sourceVerification: "fomo-trading-activity-rest",
    type: "buy",
    createdAt: 1_788_000_000_000,
    networkId: 56,
    tokenAddress: "0x7777777777777777777777777777777777777777",
    marketCapAtTrade: 456_700,
  };
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 503,
    followedTradesCache: {
      version: 1,
      updatedAt: Date.now(),
      items: [{ ...trade, marketCapAtTrade: null }],
    },
    responsePayload: (url) => url.includes("/feed/tradingActivity?")
      ? { trades: [trade] }
      : { responseObject: [] },
  });

  await harness.queryFollowedTrades();
  await new Promise((resolve) => setImmediate(resolve));

  const stored = harness.localData[FOLLOWED_TRADES_STORAGE_KEY];
  assert.equal(stored.items.length, 1, JSON.stringify(stored.items));
  assert.equal(stored.items[0].marketCapAtTrade, 456_700);
});

test("当前多链列表时间门槛只限制页面展示，不删除跨刷新历史", async () => {
  const cached = [{
    id: "fomo:bsc-before",
    platform: "fomo",
    sourceVerification: "fomo-trading-activity-rest",
    type: "buy",
    createdAt: 199_000,
    networkId: 56,
    tokenAddress: "0x7777777777777777777777777777777777777777",
  }, {
    id: "fomo:bsc-at",
    platform: "fomo",
    sourceVerification: "fomo-trading-activity-rest",
    type: "buy",
    createdAt: 200_000,
    networkId: 56,
    tokenAddress: "0x7777777777777777777777777777777777777777",
  }, {
    id: "pump:robinhood-after",
    platform: "pump",
    type: "sell",
    createdAt: 250_000,
    networkId: 4663,
    tokenAddress: "0x8888888888888888888888888888888888888888",
  }, {
    id: "pump:sol-hidden-before",
    platform: "pump",
    type: "buy",
    createdAt: 100_000,
    networkId: core.TOKEN_NETWORK_IDS.sol,
    tokenAddress: "11111111111111111111111111111111",
  }];
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 503,
    pumpStatus: 503,
    followedTradesCache: { version: 1, updatedAt: Date.now(), items: cached },
  });
  await harness.queryFollowedTrades();

  const result = await harness.updateFollowedTradesWindow({
    chains: ["bsc", "robinhood"],
    oldestTimestampMs: 200_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.removed, 0);
  assert.deepEqual(
    harness.localData[FOLLOWED_TRADES_STORAGE_KEY].items.map((item) => item.id).sort(),
    ["fomo:bsc-before", "fomo:bsc-at", "pump:robinhood-after", "pump:sol-hidden-before"].sort(),
  );
});

test("Fomo 追踪通过 Fomo metadata 补总供应量并保留交易市值", async () => {
  const token = "0x7777777777777777777777777777777777777777";
  const key = `${token}:${core.TOKEN_NETWORK_IDS.robinhood}`;
  const trade = {
    id: "fomo:metadata-supply",
    platform: "fomo",
    type: "buy",
    createdAt: 100,
    networkId: core.TOKEN_NETWORK_IDS.robinhood,
    tokenAddress: token,
    totalSupply: null,
    marketCapAtTrade: 367_700,
  };
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 503,
    responsePayload: (url) => {
      if (url.includes("/feed/tradingActivity?")) return { trades: [trade] };
      if (url.endsWith("/proxy/filterTokens")) {
        return { tradeMetadata: [{ key, totalSupply: 1_000_000_000 }] };
      }
      return { responseObject: [] };
    },
  });

  const result = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.robinhood);

  assert.equal(result.ok, true);
  assert.equal(result.items[0].totalSupply, 1_000_000_000);
  assert.equal(result.items[0].marketCapAtTrade, 367_700);
  assert.equal(harness.fomoRequestCount(), 2);
});

test("Fomo 交易已有供应量但缺图片时仍请求 token metadata 补图", async () => {
  const token = "0xbd99c569001bd6bad33f5cd954c6fadaf4298201";
  const key = `${token}:${core.TOKEN_NETWORK_IDS.robinhood}`;
  const image = "https://ipfs.io/ipfs/bafkreiduxzar2onubb6oudbuibb7vip6am6nujj3sau6iftolmzt3rycaa";
  const trade = {
    id: "fomo:oilinu",
    platform: "fomo",
    type: "buy",
    createdAt: 100,
    networkId: core.TOKEN_NETWORK_IDS.robinhood,
    tokenAddress: token,
    totalSupply: 1_000_000_000,
    tokenImageUrl: "",
  };
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 503,
    responsePayload: (url) => {
      if (url.includes("/feed/tradingActivity?")) return { trades: [trade] };
      if (url.endsWith("/proxy/filterTokens")) {
        return { tradeMetadata: [{ key, totalSupply: 1_000_000_000, tokenImageUrl: image }] };
      }
      return { responseObject: [] };
    },
  });

  const result = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.robinhood);

  assert.equal(result.ok, true);
  assert.equal(result.items[0].tokenImageUrl, image);
  assert.equal(harness.fomoRequestCount(), 2);
});

test("Fomo Alerts REST 超时会中止，不阻塞已就绪的 Pump 消息", async () => {
  const pumpTrade = { id: "pump:fast", platform: "pump", type: "buy", createdAt: 200 };
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    responseDelayMs: 100,
    accelerateFomoFollowedTimeout: true,
    pumpTradePayload: { items: [pumpTrade] },
  });
  const startedAt = Date.now();

  const result = await harness.queryFollowedTrades();

  assert.equal(Date.now() - startedAt < 400, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [pumpTrade]);
  assert.equal(result.sources.fomo.error, "FOMO_REQUEST_TIMEOUT");
  assert.equal(result.sources.pump.ok, true);
});

test("Pump alerts 已返回时慢 profile 最多只占用短暂补漏窗口", async () => {
  const fomoTrade = { id: "fomo:fast", platform: "fomo", type: "buy", createdAt: 100 };
  const viewer = "A1EbAYSRyWCUgRi3Q9iphNtRD3pAqTrm2sq79CR5J4v8";
  const followed = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    responsePayload: (url) => url.includes("/feed/tradingActivity?")
      ? { trades: [fomoTrade] }
      : { responseObject: [] },
    pumpProfileEnabled: true,
    pumpTradePayload: { items: [] },
    pumpPresencePayload: {
      subject: "alertsFeed.user.viewer-user.*",
      heartbeatIntervalSeconds: 60,
      presenceTtlSeconds: 180,
    },
    pumpUserPayload: (url) => ({
      canonical_svm_wallet: url.endsWith("/users/viewer-user") ? viewer : followed,
    }),
    pumpFollowingPayload: [{ username: "slow-profile", address: followed }],
    pumpProfileDelayMs: 500,
    pumpProfilePayload: { transactions: [], pagination: {} },
  });

  const result = await Promise.race([
    harness.queryFollowedTrades(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("PROFILE_BLOCKED_ALERTS")), 400)),
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [{
    ...fomoTrade,
    sourceVerification: "fomo-trading-activity-rest",
  }]);
  assert.equal(result.sources.pump.ok, true);
});

test("每个 GMGN 页面只接收当前链的 Fomo/Pump 交易", async () => {
  const fomoBsc = {
    id: "fomo:bsc",
    platform: "fomo",
    type: "buy",
    createdAt: 100,
    networkId: 56,
  };
  const pumpSol = {
    id: "pump:sol",
    platform: "pump",
    type: "sell",
    createdAt: 200,
    networkId: 1399811149,
  };
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    responsePayload: (url) => url.includes("/feed/tradingActivity?")
      ? { trades: [fomoBsc] }
      : { responseObject: [] },
    pumpTradePayload: { items: [pumpSol] },
  });

  const result = await harness.queryFollowedTrades(56);

  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [{
    ...fomoBsc,
    sourceVerification: "fomo-trading-activity-rest",
  }]);
  assert.equal(result.sources.fomo.count, 1);
  assert.equal(result.sources.pump.count, 0);
});

test("单链和全部链标签共享一次后台轮询并接收对应快照", async () => {
  const fomoBsc = {
    id: "fomo:bsc-push",
    platform: "fomo",
    type: "buy",
    createdAt: 100,
    networkId: 56,
  };
  const pumpSol = {
    id: "pump:sol-push",
    platform: "pump",
    type: "sell",
    createdAt: 200,
    networkId: 1399811149,
  };
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    responsePayload: (url) => url.includes("/feed/tradingActivity?")
      ? { trades: [fomoBsc] }
      : { responseObject: [] },
    pumpTradePayload: { items: [pumpSol] },
  });

  const bscPort = harness.connectFollowedTrades(56);
  const solPort = harness.connectFollowedTrades(1399811149);
  const allPort = harness.connectFollowedTrades(null);
  const [bscMessage, solMessage, allMessage] = await Promise.all([
    bscPort.nextMessage(),
    solPort.nextMessage(),
    allPort.nextMessage(),
  ]);

  assert.equal(bscMessage.type, "followedTradesSnapshot");
  assert.equal(bscMessage.networkId, 56);
  assert.deepEqual(JSON.parse(JSON.stringify(bscMessage.response.items)), [{
    ...fomoBsc,
    sourceVerification: "fomo-trading-activity-rest",
  }]);
  assert.equal(solMessage.networkId, 1399811149);
  assert.deepEqual(JSON.parse(JSON.stringify(solMessage.response.items)), [pumpSol]);
  assert.equal(allMessage.networkId, null);
  assert.deepEqual(JSON.parse(JSON.stringify(allMessage.response.items)), [pumpSol, {
    ...fomoBsc,
    sourceVerification: "fomo-trading-activity-rest",
  }]);
  assert.equal(harness.fomoRequestCount(), 1);
  assert.equal(harness.pumpRequestCount(), 1);

  bscPort.disconnect();
  solPort.disconnect();
  allPort.disconnect();
});

test("诊断链路默认关闭，显式开启后才采集，关闭时清除记录", async () => {
  const harness = createHarness({
    initialAuthorization: "Bearer must-not-be-recorded-by-default",
    responseStatus: () => 403,
    diagnosticsEnabled: null,
  });

  const initialState = await harness.getFollowedTradeDiagnosticsEnabled();
  assert.equal(initialState.ok, true);
  assert.equal(initialState.enabled, false);
  await harness.query();
  const disabledSnapshot = await harness.getFollowedTradeDiagnostics();
  assert.equal(disabledSnapshot.diagnostic.enabled, false);
  assert.equal(disabledSnapshot.diagnostic.fomoApiRequests.length, 0);
  assert.equal(disabledSnapshot.diagnostic.pipeline.length, 0);
  assert.equal(FOLLOWED_TRADES_DIAGNOSTIC_KEY in harness.localData, false);
  assert.equal(FOLLOWED_TRADES_PIPELINE_KEY in harness.localData, false);

  const enabled = await harness.setFollowedTradeDiagnosticsEnabled(true);
  assert.equal(enabled.ok, true);
  assert.equal(enabled.enabled, true);
  harness.advanceTime(300_001);
  await harness.query();
  const enabledSnapshot = await harness.getFollowedTradeDiagnostics();
  assert.equal(enabledSnapshot.diagnostic.enabled, true);
  assert.equal(enabledSnapshot.diagnostic.fomoApiRequests.length, 3);

  const disabled = await harness.setFollowedTradeDiagnosticsEnabled(false);
  assert.equal(disabled.ok, true);
  assert.equal(disabled.enabled, false);
  assert.equal(FOLLOWED_TRADES_DIAGNOSTIC_KEY in harness.localData, false);
  assert.equal(FOLLOWED_TRADES_PIPELINE_KEY in harness.localData, false);
  assert.equal(harness.localData[FOLLOWED_TRADES_DIAGNOSTICS_ENABLED_KEY], false);
});

test("关闭关注交易推送后不再获取，重新开启时恢复后台订阅", async () => {
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    responsePayload: (url) => url.includes("/feed/tradingActivity?")
      ? { trades: [] }
      : { responseObject: [] },
    pumpTradePayload: { items: [] },
    followedTradesEnabled: false,
  });

  const port = harness.connectFollowedTrades(null);
  const disabledSnapshot = await port.nextMessage();
  port.drainMessages();
  assert.equal(disabledSnapshot.response.enabled, false);
  assert.deepEqual(JSON.parse(JSON.stringify(disabledSnapshot.response.items)), []);
  assert.equal(harness.fomoRequestCount(), 0);
  assert.equal(harness.pumpRequestCount(), 0);
  const storedDisabled = await harness.getFollowedTradesEnabled();
  assert.equal(storedDisabled.ok, true);
  assert.equal(storedDisabled.enabled, false);

  const enabledResult = await harness.setFollowedTradesEnabled(true);
  assert.equal(enabledResult.ok, true);
  assert.equal(enabledResult.enabled, true);
  const enabledSnapshot = await port.nextMessage();
  port.drainMessages();
  assert.equal(enabledSnapshot.response.enabled, undefined);
  assert.ok(harness.fomoRequestCount() > 0);
  assert.ok(harness.pumpRequestCount() > 0);

  const requestCounts = [harness.fomoRequestCount(), harness.pumpRequestCount()];
  const disabledResult = await harness.setFollowedTradesEnabled(false);
  assert.equal(disabledResult.ok, true);
  assert.equal(disabledResult.enabled, false);
  const stoppedSnapshot = await port.nextMessage();
  port.drainMessages();
  assert.equal(stoppedSnapshot.response.enabled, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual([harness.fomoRequestCount(), harness.pumpRequestCount()], requestCounts);
  assert.equal(harness.localData[FOLLOWED_TRADES_ENABLED_KEY], false);
  port.disconnect();
});

test("Fomo trading_activity WebSocket 新事件不等待 REST 即推送到 GMGN 端口", async () => {
  const trade = {
    id: "fomo:ws-alert-1",
    platform: "fomo",
    type: "buy",
    createdAt: Date.now(),
    networkId: 56,
    tokenAddress: "0x7777777777777777777777777777777777777777",
    userId: "followed-user",
    displayName: "Followed Trader",
    usdAmount: 25.5,
    baseAmount: 100_000,
  };
  let fomoRestItems = [];
  const harness = createHarness({
    initialAuthorization: "Bearer fomo-jwt",
    responseStatus: () => 200,
    responsePayload: (url) => url.includes("/feed/tradingActivity?")
      ? { trades: fomoRestItems }
      : { responseObject: [] },
    pumpTradePayload: { items: [] },
  });

  const gmgnPort = harness.connectGmgnTradeEvents();
  const port = harness.connectFollowedTrades(56);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.webSockets.length, 1);
  const socket = harness.webSockets[0];
  assert.equal(socket.url, "wss://prod-api.fomo.family/ws");

  socket.open();
  assert.deepEqual(socket.sent[0], { type: "challengeResponse", jwt: "fomo-jwt" });
  socket.receive({ type: "challengeAccepted" });
  assert.deepEqual(socket.sent[1], {
    type: "subscribe",
    topicType: "trading_activity",
    topicId: "viewer-user",
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.fomoRequestCount(), 1);
  port.drainMessages();
  socket.receive({
    type: "data",
    topicType: "trading_activity",
    topicId: "viewer-user",
    payload: trade,
  });
  const gmgnPushed = await gmgnPort.nextMessage();
  assert.equal(gmgnPushed.type, "gmgnFollowTradeEvent");
  assert.equal(gmgnPushed.item.id, trade.id);
  assert.equal(gmgnPushed.item.sourceVerification, "fomo-trading-activity-websocket");
  gmgnPort.drainMessages();
  const pushed = await port.nextMessage();
  assert.equal(pushed.type, "followedTradesSnapshot");
  assert.equal(pushed.response.items.length, 1);
  assert.equal(pushed.response.items[0].id, trade.id);
  assert.equal(
    pushed.response.items[0].sourceVerification,
    "fomo-trading-activity-websocket",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(pushed.response.realtimeItemKeys)),
    ["fomo:fomo:ws-alert-1"],
  );

  socket.receive({
    type: "data",
    topicType: "trading_activity",
    topicId: "viewer-user",
    payload: trade,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(gmgnPort.drainMessages(), [], "同一 Fomo 事件不得向 GMGN 重复投递");
  assert.deepEqual(
    JSON.parse(JSON.stringify(pushed.response.notificationItemKeys)),
    ["fomo:fomo:ws-alert-1"],
  );

  const refreshedPort = harness.connectFollowedTrades(56);
  const refreshedSnapshot = await refreshedPort.nextMessage();
  assert.deepEqual(JSON.parse(JSON.stringify(refreshedSnapshot.response.items)), [{
    ...trade,
    sourceVerification: "fomo-trading-activity-websocket",
  }]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(refreshedSnapshot.response.realtimeItemKeys)),
    [],
    "刷新页面重新订阅时，不得把缓存交易重放到原生实时流",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(refreshedSnapshot.response.notificationItemKeys)),
    [],
    "刷新页面重新订阅时，缓存交易只用于列表展示",
  );

  const diagnostics = await harness.getFollowedTradeDiagnostics();
  assert.equal(diagnostics.diagnostic.fomoRealtime.state, "subscribed");
  assert.equal(diagnostics.diagnostic.fomoRealtime.authenticated, true);
  assert.equal(
    harness.requestedUrls.filter((url) => url.includes("/feed/tradingActivity?")).length,
    1,
    "实时事件可以补 token metadata，但不得额外触发 tradingActivity REST",
  );
  refreshedPort.disconnect();
  port.disconnect();
  gmgnPort.disconnect();
  assert.equal(socket.readyState, 3);
});

test("Fomo alert 早于 REST 落库时直接展示，低频校准按交易哈希去重", async () => {
  const transactionHash = `0x${"71".repeat(32)}`;
  const websocketTrade = {
    id: "fomo:ws-event-id",
    platform: "fomo",
    type: "buy",
    createdAt: Date.now(),
    networkId: 56,
    tokenAddress: "0x7777777777777777777777777777777777777777",
    transactionHash,
    usdAmount: 25.5,
    baseAmount: 100_000,
    totalSupply: 1_000_000_000,
    tokenImageUrl: "https://example.com/token.png",
  };
  const restTrade = {
    ...websocketTrade,
    id: "fomo:rest-activity-id",
  };
  let activityRequests = 0;
  let restReady = false;
  const harness = createHarness({
    initialAuthorization: "Bearer fomo-jwt",
    responseStatus: () => 200,
    responsePayload: (url) => {
      if (!url.includes("/feed/tradingActivity?")) return { responseObject: [] };
      activityRequests += 1;
      return { trades: restReady ? [restTrade] : [] };
    },
    pumpTradePayload: { items: [] },
  });

  const port = harness.connectFollowedTrades(56);
  await port.nextMessage();
  const socket = harness.webSockets[0];
  socket.open();
  socket.receive({ type: "challengeAccepted" });
  port.drainMessages();
  socket.receive({
    type: "data",
    topicType: "trading_activity",
    topicId: "viewer-user",
    payload: websocketTrade,
  });

  const realtime = await port.nextMessage();
  assert.equal(activityRequests, 1, "实时事件不得额外请求 REST");
  assert.equal(realtime.response.items[0].id, websocketTrade.id);
  assert.deepEqual(
    JSON.parse(JSON.stringify(realtime.response.notificationItemKeys)),
    [followTrades.stableKey(websocketTrade)],
  );

  restReady = true;
  harness.advanceTime(60_001);
  const recovered = await harness.queryFollowedTrades(56);
  assert.equal(recovered.items.length, 1, "同一交易不同事件 ID 不得生成重复卡片");
  assert.equal(recovered.items[0].id, restTrade.id);
  assert.deepEqual(
    JSON.parse(JSON.stringify(recovered.notificationItemKeys)),
    [],
    "WebSocket 已交付的交易不得在 REST 校准时重复通知",
  );
  assert.equal(activityRequests, 2);
  port.disconnect();
});

test("Fomo WebSocket 缺少市值字段时仍按真实新交易通知", async () => {
  const trade = {
    id: "fomo:ws-confirmed-without-price",
    platform: "fomo",
    type: "buy",
    createdAt: 200,
    networkId: 56,
    tokenAddress: "0x7777777777777777777777777777777777777777",
    usdAmount: 0.811,
  };
  let fomoRestItems = [];
  const harness = createHarness({
    initialAuthorization: "Bearer fomo-jwt",
    responseStatus: () => 200,
    responsePayload: (url) => url.includes("/feed/tradingActivity?")
      ? { trades: fomoRestItems }
      : { responseObject: [] },
    pumpTradePayload: { items: [] },
  });

  const port = harness.connectFollowedTrades(56);
  await port.nextMessage();
  const socket = harness.webSockets[0];
  socket.open();
  socket.receive({ type: "challengeAccepted" });
  port.drainMessages();
  socket.receive({
    type: "data",
    topicType: "trading_activity",
    topicId: "viewer-user",
    payload: trade,
  });
  const pushed = await port.nextMessage();

  assert.equal(pushed.response.items.some((item) => item.id === trade.id), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(pushed.response.realtimeItemKeys)),
    [`fomo:${trade.id}`],
    "缺少成交价只影响通知，不得影响列表实时投递",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(pushed.response.notificationItemKeys)),
    [`fomo:${trade.id}`],
    "通知资格由实时交易身份决定，不得再被市值字段完整度阻断",
  );
  await new Promise((resolve) => setImmediate(resolve));
  const diagnostics = await harness.getFollowedTradeDiagnostics();
  assert.equal(diagnostics.diagnostic.fomoRealtime.receivedCount, 1);
  port.disconnect();
});

test("Fomo 元数据请求未结束时，后续实时交易仍立即投递", async () => {
  let releaseMetadata;
  let metadataRequested = false;
  const gate = new Promise((resolve) => { releaseMetadata = resolve; });
  const harness = createHarness({
    initialAuthorization: "Bearer fomo-jwt", responseStatus: () => 200, pumpStatus: 503,
    responsePayload: (url) => {
      if (url.includes("/proxy/filterTokens")) {
        metadataRequested = true;
        return gate;
      }
      return { trades: [], responseObject: [] };
    },
  });
  const port = harness.connectGmgnTradeEvents();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const socket = harness.webSockets[0];
    socket.open();
    socket.receive({ type: "challengeAccepted" });
    await new Promise((resolve) => setImmediate(resolve));
    for (const id of ["first", "second"]) socket.receive({
      type: "data", topicType: "trading_activity", topicId: "viewer-user",
      payload: { id, platform: "fomo", type: "buy", createdAt: Date.now(), networkId: 56,
        tokenAddress: "0x7777777777777777777777777777777777777777", userId: "friend",
        baseAmount: 100, usdAmount: 25 },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(port.drainMessages().map((message) => message.item.id), ["first", "second"]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(metadataRequested, true);
  } finally {
    releaseMetadata({ tradeMetadata: [] });
    port.disconnect();
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test("Fomo WebSocket 原始 swap 在同一流水线计算成交价并补齐成交市值", async () => {
  const cash = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";
  const tokenAddress = "0x7777777777777777777777777777777777777777";
  const tokenKey = `${tokenAddress}:56`;
  const harness = createHarness({
    initialAuthorization: "Bearer fomo-jwt",
    responseStatus: () => 200,
    responsePayload: (url) => {
      if (url.includes("/feed/tradingActivity?")) return { trades: [] };
      if (url.includes("/proxy/filterTokens")) {
        return {
          tradeMetadata: [{
            key: tokenKey,
            tokenAddress,
            networkId: 56,
            tokenSymbol: "LIVE",
            tokenName: "Live Token",
            tokenImageUrl: "https://example.com/live.png",
            totalSupply: 1_000_000_000,
          }],
        };
      }
      return { responseObject: [] };
    },
    pumpTradePayload: { items: [] },
  });

  const gmgnPort = harness.connectGmgnTradeEvents();
  const port = harness.connectFollowedTrades(56);
  await port.nextMessage();
  const socket = harness.webSockets[0];
  socket.open();
  socket.receive({ type: "challengeAccepted" });
  port.drainMessages();
  socket.receive({
    type: "data",
    topicType: "trading_activity",
    topicId: "viewer-user",
    payload: {
      id: "swap-live",
      createdAt: new Date().toISOString(),
      userId: "followed-user",
      displayName: "Followed Trader",
      inNetworkId: 56,
      inTokenAddress: cash,
      inHumanAmount: "25",
      humanUsdAmountIn: "25",
      outNetworkId: 56,
      outTokenAddress: tokenAddress,
      outHumanAmount: "100000",
      outTradeId: "trade-live",
    },
  });

  const pushed = await port.nextMessage();
  const item = pushed.response.items.find((candidate) => candidate.id === "fomo:swap-live");
  assert.ok(item);
  assert.equal(item.type, "buy");
  assert.equal(item.baseAmount, 100_000);
  assert.equal(item.usdAmount, 25);
  assert.equal(item.priceUsdAtTrade, 0.00025);
  assert.deepEqual(
    JSON.parse(JSON.stringify(pushed.response.notificationItemKeys)),
    ["fomo:fomo:swap-live"],
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  const enriched = port.drainMessages().find((message) => message.response.items
    .some((candidate) => candidate.id === "fomo:swap-live" && candidate.totalSupply === 1_000_000_000));
  assert.ok(enriched, "元数据在后台补齐，不阻塞第一条交易消息");
  const enrichedItem = enriched.response.items.find((candidate) => candidate.id === "fomo:swap-live");
  assert.equal(enrichedItem.totalSupply, 1_000_000_000);
  assert.equal(enrichedItem.marketCapAtTrade, 250_000);
  assert.equal(enrichedItem.marketCapSource, "fomo-swap-price+token-supply");
  assert.deepEqual(JSON.parse(JSON.stringify(enriched.response.notificationItemKeys)), []);
  const gmgnMessages = gmgnPort.drainMessages();
  assert.deepEqual(gmgnMessages.map((message) => message.type), [
    "gmgnFollowTradeEvent", "gmgnFollowTradeMetadata",
  ]);
  assert.equal(gmgnMessages[0].item.totalSupply, null);
  assert.equal(gmgnMessages[1].item.totalSupply, 1_000_000_000);
  assert.equal(gmgnMessages[1].item.marketCapAtTrade, 250_000);
  assert.equal(gmgnMessages[1].item.id, gmgnMessages[0].item.id);
  gmgnPort.disconnect();
  port.disconnect();
});

test("Fomo WebSocket 事件不依赖 tradingActivity REST 即进入追踪", async () => {
  const trade = {
    id: "fomo:ws-unverified",
    platform: "fomo",
    type: "buy",
    createdAt: 200,
    networkId: 56,
    tokenAddress: "0x7777777777777777777777777777777777777777",
    usdAmount: 0.811,
  };
  const harness = createHarness({
    initialAuthorization: "Bearer fomo-jwt",
    responseStatus: () => 200,
    responsePayload: (url) => url.includes("/feed/tradingActivity?")
      ? { trades: [] }
      : { responseObject: [] },
    pumpTradePayload: { items: [] },
  });

  const port = harness.connectFollowedTrades(56);
  await port.nextMessage();
  const socket = harness.webSockets[0];
  socket.open();
  socket.receive({ type: "challengeAccepted" });
  port.drainMessages();

  socket.receive({
    type: "data",
    topicType: "trading_activity",
    topicId: "viewer-user",
    payload: trade,
  });
  const pushed = await port.nextMessage();
  assert.deepEqual(
    JSON.parse(JSON.stringify(pushed.response.realtimeItemKeys)),
    [`fomo:${trade.id}`],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(pushed.response.notificationItemKeys)),
    [`fomo:${trade.id}`],
  );
  assert.equal(pushed.response.items.some((item) => item.id === trade.id), true);
  assert.equal(
    (harness.localData[FOLLOWED_TRADES_STORAGE_KEY]?.items || [])
      .some((item) => item.id === trade.id),
    true,
  );
  const diagnostics = await harness.getFollowedTradeDiagnostics();
  assert.equal(diagnostics.diagnostic.fomoRealtime.state, "subscribed");
  port.disconnect();
});

test("Fomo REST 处于 429 退避时 WebSocket 事件仍立即交付", async () => {
  const trade = {
    id: "fomo:deferred-rest-confirmation",
    platform: "fomo",
    type: "sell",
    createdAt: Date.now(),
    networkId: 56,
    tokenAddress: "0x7777777777777777777777777777777777777777",
    transactionHash: `0x${"72".repeat(32)}`,
    usdAmount: 30,
    baseAmount: 1_000,
  };
  const harness = createHarness({
    initialAuthorization: "Bearer fomo-jwt",
    responseStatus: (_authorization, url) => (
      url.includes("/feed/tradingActivity?") ? 429 : 200
    ),
    responsePayload: () => ({ responseObject: [] }),
    pumpTradePayload: { items: [] },
  });

  const port = harness.connectFollowedTrades(56);
  await port.nextMessage();
  const socket = harness.webSockets[0];
  socket.open();
  socket.receive({ type: "challengeAccepted" });
  port.drainMessages();
  socket.receive({
    type: "data",
    topicType: "trading_activity",
    topicId: "viewer-user",
    payload: trade,
  });
  const pushed = await port.nextMessage();
  assert.equal(pushed.response.items.some((item) => item.id === trade.id), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(pushed.response.notificationItemKeys)),
    [followTrades.stableKey(trade)],
  );
  port.disconnect();
});

test("Fomo WebSocket 漏事件时后续 REST 增量仍无需刷新进入实时通道", async () => {
  const trade = {
    id: "fomo:rest-delta-without-websocket",
    platform: "fomo",
    type: "buy",
    createdAt: Date.now(),
    networkId: 56,
    tokenAddress: "0x7373737373737373737373737373737373737373",
    transactionHash: `0x${"73".repeat(32)}`,
    usdAmount: 42,
    baseAmount: 2_000,
  };
  let fomoRestItems = [];
  let activityRequests = 0;
  const harness = createHarness({
    initialAuthorization: "Bearer fomo-jwt",
    responseStatus: () => 200,
    responsePayload: (url) => {
      if (!url.includes("/feed/tradingActivity?")) return { responseObject: [] };
      activityRequests += 1;
      return { trades: fomoRestItems };
    },
    pumpTradePayload: { items: [] },
  });

  const port = harness.connectFollowedTrades(56);
  await port.nextMessage();
  port.drainMessages();

  fomoRestItems = [trade];
  harness.advanceTime(60_001);
  const recovered = await harness.queryFollowedTrades(56);
  const pushed = await port.nextMessage();
  port.disconnect();

  assert.equal(recovered.items.some((item) => item.id === trade.id), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(recovered.realtimeItemKeys)),
    [followTrades.stableKey(trade)],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(recovered.notificationItemKeys)),
    [followTrades.stableKey(trade)],
    "REST 轮询识别出的增量必须复用原生实时通知通道",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(pushed.response.notificationItemKeys)),
    [followTrades.stableKey(trade)],
    "无论哪一个调用方先触发 REST 增量查询，都必须主动广播到 GMGN 端口",
  );
  assert.equal(activityRequests, 2, "WebSocket 健康时只允许低频 REST 校准");
});

test("Fomo 首页出现已知 ID 时停止补页，避免重复撞接口", async () => {
  const known = {
    id: "fomo:known-first-page",
    platform: "fomo",
    sourceVerification: "fomo-trading-activity-rest",
    type: "buy",
    createdAt: 200,
    networkId: 56,
    tokenAddress: "0x7777777777777777777777777777777777777777",
  };
  const delayed = {
    id: "fomo:delayed-second-page",
    platform: "fomo",
    type: "sell",
    createdAt: 199,
    networkId: 56,
    tokenAddress: "0x8888888888888888888888888888888888888888",
  };
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    followedTradesCache: { version: 1, updatedAt: Date.now(), items: [known] },
    responsePayload: (url) => {
      if (!url.includes("/feed/tradingActivity?")) return { responseObject: [] };
      return url.includes("lastId=page-2")
        ? { trades: [delayed], hasNextPage: false }
        : { trades: [known], hasNextPage: true, nextCursor: "page-2" };
    },
    pumpTradePayload: { items: [] },
  });

  const result = await harness.queryFollowedTrades(56);

  assert.equal(result.items.some((item) => item.id === known.id), true);
  assert.equal(result.items.some((item) => item.id === delayed.id), false);
  assert.equal(
    harness.requestedUrls.some((url) => url.includes("lastId=page-2")),
    false,
  );
});

test("Fomo 后续补页失败时保留已成功取得的首页交易卡", async () => {
  const firstPageTrade = {
    id: "fomo:first-page-survives",
    platform: "fomo",
    sourceVerification: "fomo-trading-activity-rest",
    type: "buy",
    createdAt: Date.now(),
    networkId: 4663,
    tokenAddress: "0x9999999999999999999999999999999999999999",
  };
  const harness = createHarness({
    initialAuthorization: "stable-token",
    followedTradesCache: {
      version: 1,
      updatedAt: Date.now(),
      items: [firstPageTrade],
    },
    responseStatus: (_authorization, url) => url.includes("lastId=page-2") ? 503 : 200,
    responsePayload: (url) => {
      if (!url.includes("/feed/tradingActivity?")) return { responseObject: [] };
      return {
        trades: [firstPageTrade],
        hasNextPage: true,
        nextCursor: "page-2",
      };
    },
    pumpTradePayload: { items: [] },
  });

  const result = await harness.queryFollowedTrades(4663);

  assert.equal(result.sources.fomo.ok, true);
  assert.equal(result.items.some((item) => item.id === firstPageTrade.id), true);
});

test("关注数据源与 GMGN 插入结果只记录脱敏计数诊断", async () => {
  const fomoTrade = {
    id: "fomo:diagnostic",
    platform: "fomo",
    type: "buy",
    createdAt: 100,
    networkId: 56,
  };
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    responsePayload: (url) => url.includes("/feed/tradingActivity?")
      ? { trades: [fomoTrade] }
      : { responseObject: [] },
    pumpTradePayload: { items: [] },
  });

  await harness.queryFollowedTrades();
  await harness.recordFollowedTradeBridgeDiagnostic({
    bridgeVersion: "1.0.0",
    transport: "query-cache",
    updatedAt: 123,
    path: "/vas/api/v1/follow/follow_wallet_trade_list",
    queryKeys: ["chain", "filters"],
    listPath: "data.list",
    nativeCount: 3,
    externalCount: 1,
    insertedCount: 1,
    chains: ["bsc", "invalid"],
    authorization: "must-not-be-recorded",
  });
  await harness.recordFollowedTradeBridgeDiagnostic({
    bridgeVersion: "1.0.0",
    transport: "bridge-runtime",
    updatedAt: 124,
    externalCount: 1,
    visibilityState: "hidden",
    runtime: {
      webpackRuntimeCaptured: true,
      webpackModuleCount: 842,
      webpackCacheCount: 0,
      axiosBridgeInstalled: true,
      followWalletSocketCaptured: false,
      nativeGmgnSoundCaptured: true,
      nativeGmgnSoundError: "",
      queryStoreChunkBridgeInstalled: true,
      queryStoreFactoryCount: 2,
      queryStoreFactoryExecutionCount: 1,
      queryStorePrototypePatched: true,
      queryClientCount: 1,
      queryCacheCount: 1,
      boundTrackingQueryCount: 1,
      queryCount: 12,
      trackingQueryCount: 1,
      updatedQueryCount: 0,
      queryWriteErrorCount: 0,
      hasSeenTrackingRequest: true,
      pendingNativeCount: 0,
      pendingNativeSoundCount: 0,
      refreshWhenVisible: true,
      authorization: "must-not-be-recorded",
    },
  });

  const diagnostic = harness.localData[FOLLOWED_TRADES_DIAGNOSTIC_KEY];
  assert.equal(diagnostic.sourcePoll.itemCount, 1);
  assert.equal(diagnostic.sourcePoll.platformCounts.fomo, 1);
  assert.equal(diagnostic.sourcePoll.sources.fomo.ok, true);
  assert.equal(diagnostic.bridge.insertedCount, 1);
  assert.equal(diagnostic.bridge.transport, "query-cache");
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostic.bridge.chains)), ["bsc"]);
  assert.equal("authorization" in diagnostic.bridge, false);
  assert.equal(diagnostic.bridgeRuntime.webpackRuntimeCaptured, true);
  assert.equal(diagnostic.bridgeRuntime.webpackModuleCount, 842);
  assert.equal(diagnostic.bridgeRuntime.followWalletSocketCaptured, false);
  assert.equal(diagnostic.bridgeRuntime.nativeGmgnSoundCaptured, true);
  assert.equal(diagnostic.bridgeRuntime.nativeGmgnSoundError, "");
  assert.equal(diagnostic.bridgeRuntime.pendingNativeSoundCount, 0);
  assert.equal(diagnostic.bridgeRuntime.queryStoreFactoryExecutionCount, 1);
  assert.equal(diagnostic.bridgeRuntime.boundTrackingQueryCount, 1);
  assert.equal(diagnostic.bridgeRuntime.trackingQueryCount, 1);
  assert.equal(diagnostic.bridgeRuntime.refreshWhenVisible, true);
  assert.equal("authorization" in diagnostic.bridgeRuntime, false);
  const response = await harness.getFollowedTradeDiagnostics();
  assert.equal(response.diagnostic.bridge.listPath, "data.list");
  assert.equal(response.diagnostic.bridgeRuntime.queryCount, 12);
});

test("同一笔交易持久记录从 Fomo REST 到 GMGN 原生 Socket 的脱敏链路", async () => {
  const firstTrade = {
    id: "fomo:pipeline-baseline",
    platform: "fomo",
    type: "buy",
    createdAt: 100,
    networkId: 56,
    tokenAddress: "0x1111111111111111111111111111111111111111",
    transactionHash: `0x${"11".repeat(32)}`,
    usdAmount: 10,
    baseAmount: 100,
  };
  const newTrade = {
    id: "fomo:pipeline-new",
    platform: "fomo",
    type: "sell",
    createdAt: 200,
    networkId: 56,
    tokenAddress: "0x2222222222222222222222222222222222222222",
    transactionHash: `0x${"22".repeat(32)}`,
    usdAmount: 20,
    baseAmount: 200,
  };
  let trades = [firstTrade];
  const harness = createHarness({
    initialAuthorization: "Bearer secret-diagnostic-token",
    responseStatus: () => 200,
    responsePayload: (url) => url.includes("/feed/tradingActivity?")
      ? { trades }
      : { responseObject: [] },
    pumpTradePayload: { items: [] },
  });

  const port = harness.connectFollowedTrades(null);
  await port.nextMessage();
  await new Promise((resolve) => setImmediate(resolve));
  trades = [newTrade, firstTrade];
  harness.advanceTime(30_001);
  await harness.queryFollowedTrades();
  await harness.recordFollowedTradeBridgeDiagnostic({
    bridgeVersion: "1.0.0",
    transport: "page-snapshot",
    externalCount: 2,
    insertedCount: 1,
    notificationCount: 1,
    visibilityState: "hidden",
    chains: ["bsc"],
    itemRefs: [{ ...newTrade, walletAddress: "0xprivate-wallet" }],
    authorization: "must-not-be-recorded",
  });
  await harness.recordFollowedTradeBridgeDiagnostic({
    bridgeVersion: "1.0.0",
    transport: "bridge-snapshot",
    externalCount: 2,
    insertedCount: 1,
    notificationCount: 1,
    chains: ["bsc"],
    itemRefs: [newTrade],
  });
  await harness.recordFollowedTradeBridgeDiagnostic({
    bridgeVersion: "1.0.0",
    transport: "native-follow-socket",
    externalCount: 2,
    insertedCount: 1,
    notificationCount: 1,
    chains: ["bsc"],
    itemRefs: [newTrade],
  });

  const response = await harness.getFollowedTradeDiagnostics();
  const events = response.diagnostic.pipeline;
  const stages = new Set(events.map((event) => event.stage));
  for (const stage of [
    "fomo-rest-request",
    "fomo-rest-response",
    "fomo-rest-delta",
    "background-broadcast",
    "page-snapshot",
    "bridge-snapshot",
    "native-delivered",
  ]) assert.equal(stages.has(stage), true, `缺少 ${stage} 阶段`);
  const pipelineText = JSON.stringify(harness.localData[FOLLOWED_TRADES_PIPELINE_KEY]);
  assert.equal(pipelineText.includes("secret-diagnostic-token"), false);
  assert.equal(pipelineText.includes("0xprivate-wallet"), false);
  assert.equal(pipelineText.includes("must-not-be-recorded"), false);
  assert.equal(pipelineText.includes(newTrade.transactionHash), true);
  port.disconnect();
});

test("没有 Pump 页面时跳过 Pump 数据，不自动创建标签页", async () => {
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 401,
    pumpReplacementStatus: 200,
    existingPumpTab: false,
    responsePayload: () => ({ trades: [] }),
  });

  const result = await harness.queryFollowedTrades();

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), []);
  assert.equal(result.sources.fomo.ok, true);
  assert.equal(result.sources.pump.error, "PUMP_SESSION_REQUIRED");
  assert.deepEqual(JSON.parse(JSON.stringify(harness.createdTabDetails)), []);
  assert.deepEqual(harness.removedTabIds, []);
  assert.deepEqual(harness.updatedTabs, []);
  assert.deepEqual(harness.pumpRequestCredentials, ["include"]);
  assert.equal(harness.pumpPageRequestCount(), 0);
  const sourceState = await harness.getFollowedTradeSources();
  assert.equal(sourceState.ok, true);
  assert.equal(sourceState.sources.pump.error, "PUMP_SESSION_REQUIRED");
  assert.equal(harness.actionState.badgeText, "!");
  assert.match(harness.actionState.title, /Pump 数据未连接/);
});

test("Pump 后台凭据和现有页面都失效时只返回明确状态", async () => {
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 401,
    pumpReplacementStatus: 401,
    responsePayload: () => ({ trades: [] }),
  });

  const result = await harness.queryFollowedTrades();

  assert.equal(result.ok, true);
  assert.equal(result.sources.fomo.ok, true);
  assert.equal(result.sources.pump.error, "PUMP_SESSION_EXPIRED");
  assert.deepEqual(JSON.parse(JSON.stringify(harness.createdTabDetails)), []);
  assert.deepEqual(harness.removedTabIds, []);
  assert.deepEqual(harness.updatedTabs, []);
  assert.equal(harness.pumpPageRequestCount(), 1);
});

test("没有 Pump 页面时后台 Cookie 仍可直接取得追踪数据", async () => {
  const pumpTrade = { id: "pump:trade-existing", platform: "pump", type: "buy", createdAt: 300 };
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 200,
    pumpTradePayload: { items: [pumpTrade] },
    existingPumpTab: false,
    responsePayload: () => ({ trades: [] }),
  });

  const result = await harness.queryFollowedTrades();

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [pumpTrade]);
  assert.equal(result.sources.pump.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.createdTabDetails)), []);
  assert.deepEqual(harness.removedTabIds, []);
  assert.deepEqual(harness.updatedTabs, []);
  assert.deepEqual(harness.pumpRequestCredentials, ["include"]);
  assert.equal(harness.pumpPageRequestCount(), 0);
  assert.equal(harness.actionState.badgeText, "");
  assert.equal(harness.actionState.title, "打开 GMGN Fomo 侧边栏");
});

test("后台 Cookie 失效但已有 Pump 页面时静默回退页面请求", async () => {
  const pumpTrade = { id: "pump:page-fallback", platform: "pump", type: "buy", createdAt: 310 };
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 401,
    pumpReplacementStatus: 200,
    pumpTradePayload: { items: [pumpTrade] },
    responsePayload: () => ({ trades: [] }),
  });

  const result = await harness.queryFollowedTrades();

  assert.equal(result.sources.pump.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [pumpTrade]);
  assert.equal(harness.pumpRequestCount(), 2);
  assert.equal(harness.pumpPageRequestCount(), 1);
  assert.deepEqual(harness.createdTabDetails, []);
  assert.deepEqual(harness.updatedTabs, []);
});

test("Pump 登录态识别成功后只持久化公开账号标识", async () => {
  const viewer = "A1EbAYSRyWCUgRi3Q9iphNtRD3pAqTrm2sq79CR5J4v8";
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 200,
    pumpProfileEnabled: true,
    pumpTradePayload: { items: [] },
    pumpPresencePayload: {
      subject: "alertsFeed.user.viewer-user.instance",
      heartbeatIntervalSeconds: 60,
    },
    pumpUserPayload: { canonical_svm_wallet: viewer },
    pumpFollowingPayload: [],
    responsePayload: () => ({ trades: [] }),
  });

  await harness.queryFollowedTrades();

  const stored = harness.localData[PUMP_IDENTITY_KEY];
  assert.equal(stored.userId, "viewer-user");
  assert.equal(stored.viewerWallet, viewer);
  assert.equal(Number.isFinite(stored.updatedAt), true);
  assert.equal("authorization" in stored, false);
});

test("Pump 页面公开 profile 链接可直接识别当前账号，不依赖 presence", async () => {
  const viewer = "A1EbAYSRyWCUgRi3Q9iphNtRD3pAqTrm2sq79CR5J4v8";
  const wallet = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const token = "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump";
  const tx = "3".repeat(88);
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 200,
    pumpProfileEnabled: true,
    pumpPageIdentity: { viewerWallet: viewer, username: "tokencrab30086" },
    pumpTradePayload: { items: [] },
    pumpFollowingPayload: [{ username: "hexiecs", address: wallet }],
    pumpUserPayload: { canonical_svm_wallet: wallet },
    pumpProfilePayload: { transactions: [{
      tx_hash: tx,
      block_time: 1788095419,
      type: "SWAP",
      chain: "solana",
      token_in: { mint: token, amount: "100", metadata: { symbol: "MEME" } },
      token_out: {
        mint: pumpApi.WRAPPED_SOL_MINT,
        amount: "1",
        metadata: { symbol: "SOL" },
      },
    }], pagination: {} },
    responsePayload: () => ({ trades: [] }),
  });

  const result = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.sol);

  assert.equal(result.sources.pump.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, `pump:${tx}:${wallet}:${token}:buy`);
  assert.equal(harness.localData[PUMP_IDENTITY_KEY].viewerWallet, viewer);
  assert.equal(harness.localData[PUMP_IDENTITY_KEY].userId, "");
  assert.equal(harness.pumpPageRequestCount(), 0);
});

test("已有公开 Pump 身份时关闭 Pump 页面仍从关注 profile 同步交易", async () => {
  const viewer = "A1EbAYSRyWCUgRi3Q9iphNtRD3pAqTrm2sq79CR5J4v8";
  const wallet = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const token = "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump";
  const tx = "2".repeat(88);
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 401,
    pumpPublicStatus: 200,
    pumpProfileEnabled: true,
    existingPumpTab: false,
    pumpIdentity: { userId: "viewer-user", viewerWallet: viewer, updatedAt: 1 },
    pumpFollowingPayload: [{ username: "page-free", address: wallet }],
    pumpUserPayload: { canonical_svm_wallet: wallet },
    pumpProfilePayload: { transactions: [{
      tx_hash: tx,
      block_time: 1788095419,
      type: "SWAP",
      chain: "solana",
      token_in: { mint: token, amount: "100", metadata: { symbol: "MEME" } },
      token_out: {
        mint: pumpApi.WRAPPED_SOL_MINT,
        amount: "1",
        metadata: { symbol: "SOL" },
      },
    }], pagination: {} },
    responsePayload: () => ({ trades: [] }),
  });

  const result = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.sol);

  assert.equal(result.sources.pump.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, `pump:${tx}:${wallet}:${token}:buy`);
  assert.equal(harness.pumpPageRequestCount(), 0);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.createdTabDetails)), []);
});

test("Pump presence 返回专属 subject 后只配置官方 Alerts NATS 订阅", async () => {
  const viewer = "A1EbAYSRyWCUgRi3Q9iphNtRD3pAqTrm2sq79CR5J4v8";
  const wallet = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const configs = {
    CORE: {
      servers: "wss://prod-v2.nats.realtime.pump.fun",
      user: "subscriber",
      pass: "public-read-password",
      pingInterval: 5_000,
      timeout: 5_000,
    },
  };
  const pumpNatsHtml = `<script>self.__next_f.push([1,"{\\"configs\\":${JSON.stringify(configs).replaceAll('"', '\\"')},\\"instances\\":{}}"])</script>`;
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 200,
    pumpPublicStatus: 200,
    pumpProfileEnabled: true,
    existingPumpTab: true,
    pumpIdentity: { userId: "viewer-user", viewerWallet: viewer, updatedAt: 1 },
    pumpFollowingPayload: [{ username: "realtime", address: wallet }],
    pumpPresencePayload: {
      subject: "alertsFeed.user.viewer-user.instance-1",
      heartbeatIntervalSeconds: 60,
    },
    pumpUserPayload: { canonical_svm_wallet: wallet },
    pumpProfilePayload: { transactions: [], pagination: {} },
    pumpNatsHtml,
    responsePayload: () => ({ trades: [] }),
  });

  await harness.queryFollowedTrades();
  await new Promise((resolve) => setImmediate(resolve));

  const configure = harness.offscreenMessages.find((message) => message.type === "configurePumpNats");
  assert.equal(harness.offscreenCreateCount(), 1);
  assert.equal(configure.config.server, "wss://prod-v2.nats.realtime.pump.fun");
  assert.deepEqual(JSON.parse(JSON.stringify(configure.subjects)), [
    "alertsFeed.user.viewer-user.instance-1",
  ]);
  await harness.setFollowedTradesEnabled(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.pumpRequestMethods.some((request) => (
    request.method === "DELETE"
      && request.url.endsWith("/following-positions/alerts/presence")
  )), true);
});

test("Pump 官方 NATS trade 不经 profile/RPC 重建即可进入 GMGN 投递集合", async () => {
  const viewer = "A1EbAYSRyWCUgRi3Q9iphNtRD3pAqTrm2sq79CR5J4v8";
  const wallet = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const token = "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump";
  const configs = {
    CORE: {
      servers: "wss://prod-v2.nats.realtime.pump.fun",
      user: "subscriber",
      pass: "public-read-password",
    },
  };
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 200,
    pumpProfileEnabled: true,
    pumpTradePayload: { items: [] },
    pumpPresencePayload: {
      subject: "alertsFeed.user.viewer-user.instance-1",
      heartbeatIntervalSeconds: 60,
    },
    pumpUserPayload: { canonical_svm_wallet: viewer },
    pumpFollowingPayload: [],
    pumpProfilePayload: { transactions: [], pagination: {} },
    pumpNatsHtml: `<script>self.__next_f.push([1,"{\\"configs\\":${JSON.stringify(configs).replaceAll('"', '\\"')},\\"instances\\":{}}"])</script>`,
    acceleratePumpNatsRefresh: true,
    responsePayload: () => ({ trades: [] }),
  });

  await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.sol);
  const gmgnPort = harness.connectGmgnTradeEvents();
  const port = harness.connectFollowedTrades(core.TOKEN_NETWORK_IDS.sol);
  await port.nextMessage();
  port.drainMessages();
  const event = {
    id: "event-direct-1",
    kind: "trade",
    createdAt: new Date().toISOString(),
    author: {
      userId: "pump-friend",
      userName: "Pump Friend",
      walletAddress: wallet,
    },
    coin: {
      mint: token,
      chainId: core.TOKEN_NETWORK_IDS.sol,
      imageUri: "https://example.com/live.png",
      symbol: "LIVE",
    },
    trade: {
      tx: "live-tx-1",
      isBuy: true,
      baseAmount: 250_000,
      amountUsd: 25.5,
      priceUsd: 0.000102,
    },
  };

  const accepted = await harness.pumpNatsAlertEvent(event);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.accepted, true);
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const pushed = port.drainMessages().find((message) => (
      message.response?.items?.some((entry) => entry.pumpEventId === event.id)
    ));
    assert.ok(pushed, "官方 NATS trade 应在一秒批次后广播");
    const item = pushed.response.items.find((entry) => entry.pumpEventId === event.id);
    assert.equal(item.transactionHash, event.trade.tx);
    assert.equal(item.baseAmount, event.trade.baseAmount);
    assert.equal(item.sourceVerification, pumpApi.PUMP_ALERTS_NATS_VERIFICATION);
    const gmgnPushed = await gmgnPort.nextMessage();
    assert.equal(gmgnPushed.type, "gmgnFollowTradeEvent");
    assert.equal(gmgnPushed.item.pumpEventId, event.id);
    assert.equal(gmgnPushed.item.transactionHash, event.trade.tx);
    assert.deepEqual(
      JSON.parse(JSON.stringify(pushed.response.realtimeItemKeys)),
      [followTrades.stableKey(item)],
    );
    assert.deepEqual(JSON.parse(JSON.stringify(pushed.response.notificationItemKeys)), []);
    assert.equal(harness.solanaRpcRequestCount(), 0, "市值由 GMGN 页面补齐，不额外查链");

    const duplicate = await harness.pumpNatsAlertEvent(event);
    assert.equal(duplicate.ok, true);
    const rejected = await harness.pumpNatsAlertEvent({ ...event, id: "event-low", trade: {
      ...event.trade, amountUsd: 9.99,
    } });
    assert.equal(rejected.accepted, false);
    const ingestion = (await harness.getFollowedTradeDiagnostics()).diagnostic.pumpRealtime.ingestion;
    assert.deepEqual(JSON.parse(JSON.stringify(ingestion)), {
      received: 3, accepted: 1, duplicate: 1, rejected: 1, "rejected:below-minimum-usd": 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(gmgnPort.drainMessages(), [], "同一 Pump 事件不得向 GMGN 重复投递");
  } finally {
    port.disconnect();
    gmgnPort.disconnect();
  }
});

test("Pump REST 对账只投递基线之后的新交易且不触发通知", async () => {
  const viewer = "A1EbAYSRyWCUgRi3Q9iphNtRD3pAqTrm2sq79CR5J4v8";
  const wallet = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const token = "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump";
  let live = false;
  const trade = {
    kind: "trade",
    createdAt: "2026-09-04T08:30:00.000Z",
    walletAddress: wallet,
    coinMint: token,
    coinSymbol: "REST",
    author: { userId: "pump-friend", userName: "Pump Friend" },
    trade: {
      tx: "rest-tx-1",
      isBuy: false,
      baseAmount: 100_000,
      amountUsd: 20,
      priceUsd: 0.0002,
    },
  };
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 200,
    pumpProfileEnabled: true,
    pumpTradePayload: () => ({ items: live ? [trade] : [] }),
    pumpPresencePayload: {
      subject: "alertsFeed.user.viewer-user.instance-1",
      heartbeatIntervalSeconds: 60,
    },
    pumpUserPayload: { canonical_svm_wallet: viewer },
    pumpFollowingPayload: [],
    pumpProfilePayload: { transactions: [], pagination: {} },
    responsePayload: () => ({ trades: [] }),
  });

  const baseline = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.sol);
  assert.deepEqual(JSON.parse(JSON.stringify(baseline.realtimeItemKeys)), []);
  live = true;
  harness.advanceTime(5_000);
  const delta = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.sol);
  const item = delta.items.find((entry) => entry.transactionHash === trade.trade.tx);
  assert.equal(item.sourceVerification, pumpApi.PUMP_ALERTS_REST_VERIFICATION);
  assert.deepEqual(
    JSON.parse(JSON.stringify(delta.realtimeItemKeys)),
    [followTrades.stableKey(item)],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(delta.notificationItemKeys)), []);
});

test("Pump NATS 重连后立即用 Alerts REST 补齐断线交易", async () => {
  const viewer = "A1EbAYSRyWCUgRi3Q9iphNtRD3pAqTrm2sq79CR5J4v8";
  const wallet = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const token = "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump";
  let live = false;
  const trade = {
    kind: "trade",
    createdAt: "2026-09-04T08:31:00.000Z",
    walletAddress: wallet,
    coinMint: token,
    coinSymbol: "RECOVER",
    author: { userId: "pump-friend", userName: "Pump Friend" },
    trade: {
      tx: "reconnect-tx-1",
      isBuy: true,
      baseAmount: 200_000,
      amountUsd: 20,
      priceUsd: 0.0001,
    },
  };
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 200,
    pumpProfileEnabled: true,
    pumpTradePayload: () => ({ items: live ? [trade] : [] }),
    pumpPresencePayload: {
      subject: "alertsFeed.user.viewer-user.instance-1",
      heartbeatIntervalSeconds: 60,
    },
    pumpUserPayload: { canonical_svm_wallet: viewer },
    pumpFollowingPayload: [],
    pumpProfilePayload: { transactions: [], pagination: {} },
    responsePayload: () => ({ trades: [] }),
  });

  await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.sol);
  const port = harness.connectFollowedTrades(core.TOKEN_NETWORK_IDS.sol);
  await port.nextMessage();
  port.drainMessages();
  try {
    await harness.pumpNatsStatus("connected");
    await harness.pumpNatsStatus("disconnected");
    live = true;
    await harness.pumpNatsStatus("connected");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const recovered = port.drainMessages().find((message) => (
      message.response?.items?.some((entry) => entry.transactionHash === trade.trade.tx)
    ));
    assert.ok(recovered, "重连应主动触发 REST 对账，不等待下一轮轮询");
    assert.equal(recovered.response.sources.pump.transport, "alerts-rest-reconnect");
    assert.equal(recovered.response.realtimeItemKeys.length, 1);
    assert.equal(recovered.response.notificationItemKeys.length, 0);
  } finally {
    port.disconnect();
  }
});

test("Pump 同钱包快速连续事件即使首轮已有新交易仍执行尾随补漏", async () => {
  const viewer = "A1EbAYSRyWCUgRi3Q9iphNtRD3pAqTrm2sq79CR5J4v8";
  const wallet = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const token = "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump";
  const buyTx = "4".repeat(88);
  const sellTx = "5".repeat(88);
  const buy = {
    tx_hash: buyTx,
    block_time: Math.trunc(Date.now() / 1000),
    type: "SWAP",
    chain: "solana",
    token_in: { mint: token, amount: "1000", metadata: { symbol: "FAST" } },
    token_out: {
      mint: pumpApi.WRAPPED_SOL_MINT,
      amount: "1",
      metadata: { symbol: "SOL" },
    },
  };
  const sell = {
    tx_hash: sellTx,
    block_time: Math.trunc(Date.now() / 1000) + 1,
    type: "SWAP",
    chain: "solana",
    token_in: {
      mint: pumpApi.WRAPPED_SOL_MINT,
      amount: "0.9",
      metadata: { symbol: "SOL" },
    },
    token_out: { mint: token, amount: "900", metadata: { symbol: "FAST" } },
  };
  let live = false;
  let liveProfileRequests = 0;
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 200,
    pumpPublicStatus: 200,
    pumpProfileEnabled: true,
    pumpTradePayload: { items: [] },
    pumpPresencePayload: {
      subject: "alertsFeed.user.viewer-user.*",
      heartbeatIntervalSeconds: 60,
      presenceTtlSeconds: 180,
    },
    pumpUserPayload: (url) => url.endsWith("/users/viewer-user")
      ? { canonical_svm_wallet: viewer }
      : { canonical_svm_wallet: wallet },
    pumpFollowingPayload: [{ username: "fast", address: wallet }],
    pumpProfilePayload: () => {
      if (!live) return { transactions: [], pagination: {} };
      liveProfileRequests += 1;
      return {
        transactions: liveProfileRequests === 1 ? [buy] : [sell, buy],
        pagination: {},
      };
    },
    pumpCoinPayload: {
      symbol: "FAST",
      totalSupply: 1_000_000_000,
      usd_market_cap: 100_000,
    },
    acceleratePumpNatsRefresh: true,
    responsePayload: () => ({ trades: [] }),
  });

  await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.sol);
  live = true;
  await Promise.all([
    harness.pumpNatsWalletActivity(wallet),
    harness.pumpNatsWalletActivity(wallet),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const ids = new Set((harness.localData[FOLLOWED_TRADES_STORAGE_KEY]?.items || [])
    .map((item) => item.id));
  assert.equal(ids.has(`pump:${buyTx}:${wallet}:${token}:buy`), true);
  assert.equal(ids.has(`pump:${sellTx}:${wallet}:${token}:sell`), true);
  assert.equal(liveProfileRequests >= 2, true, "首轮已命中买入也必须继续尾随检查卖出");
});

test("Pump NATS 未经链上确认的 profile swap 只保存快照但不触发通知", async () => {
  const viewer = "A1EbAYSRyWCUgRi3Q9iphNtRD3pAqTrm2sq79CR5J4v8";
  const wallet = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const token = "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump";
  const tx = "4".repeat(88);
  let transactions = [];
  const coin = {
    symbol: "GTA",
    totalSupply: 1_000_000_000,
    usd_market_cap: 367_700,
  };
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 200,
    pumpPublicStatus: 200,
    pumpProfileEnabled: true,
    pumpTradePayload: { items: [] },
    pumpPresencePayload: {
      subject: "alertsFeed.user.viewer-user.*",
      heartbeatIntervalSeconds: 60,
      presenceTtlSeconds: 180,
    },
    pumpUserPayload: (url) => url.endsWith("/users/viewer-user")
      ? { canonical_svm_wallet: viewer }
      : { canonical_svm_wallet: wallet },
    pumpFollowingPayload: [{ username: "snapshot-user", address: wallet }],
    pumpProfilePayload: () => ({ transactions, pagination: {} }),
    pumpCoinPayload: coin,
    responsePayload: () => ({ trades: [] }),
  });

  const baseline = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.sol);
  assert.equal(baseline.items.length, 0);
  const port = harness.connectFollowedTrades(core.TOKEN_NETWORK_IDS.sol);
  await port.nextMessage();
  port.drainMessages();

  transactions = [{
    tx_hash: tx,
    block_time: Math.trunc(Date.now() / 1000),
    type: "SWAP",
    chain: "solana",
    token_in: { mint: token, amount: "1000000", metadata: { symbol: "GTA" } },
    token_out: {
      mint: pumpApi.WRAPPED_SOL_MINT,
      amount: "1",
      metadata: { symbol: "SOL" },
    },
  }];
  const accepted = await harness.pumpNatsWalletActivity(wallet);
  assert.equal(accepted.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const stored = harness.localData[FOLLOWED_TRADES_STORAGE_KEY];
  const item = stored.items.find((entry) => entry.id === `pump:${tx}:${wallet}:${token}:buy`);
  assert.equal(item.marketCapSnapshot, 367_700);
  assert.equal(item.totalSupplySnapshot, 1_000_000_000);
  assert.equal(item.priceUsdSnapshot, 0.0003677);
  assert.equal(item.marketSnapshotSource, "pump-realtime-observed");
  assert.equal(Number.isFinite(item.marketSnapshotCapturedAt), true);
  const pushes = port.drainMessages().filter((message) => (
    message.response?.items?.some((entry) => entry.id === item.id)
  ));
  assert.equal(pushes.length > 0, true);
  assert.equal(pushes.every((message) => message.response.notificationItemKeys.length === 0), true);
  port.disconnect();
});

test("Pump 通知同时要求链上确认和非零成交价格", async () => {
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpTradePayload: { items: [] },
    responsePayload: () => ({ trades: [] }),
  });
  const port = harness.connectFollowedTrades(core.TOKEN_NETWORK_IDS.robinhood);
  await port.nextMessage();
  port.drainMessages();
  const base = {
    platform: "pump",
    type: "sell",
    createdAt: Date.now(),
    networkId: core.TOKEN_NETWORK_IDS.robinhood,
    transactionHash: `0x${"61".repeat(32)}`,
    walletAddress: "0x1160079f1463dc5f9f20b1f1b9cf628718649c18",
    tokenAddress: "0x98096d17e191b3da1d5f99a6d7b3584351b11e18",
    quoteAmount: 6.05,
    sourceVerification: pumpApi.PUMP_CHAIN_RPC_VERIFICATION,
  };

  await harness.publishPumpRealtimeItems([{ ...base, id: "pump:verified-at-zero" }]);
  const atZero = await port.nextMessage();
  assert.deepEqual(
    JSON.parse(JSON.stringify(atZero.response.realtimeItemKeys)),
    [followTrades.stableKey(base)],
    "已确认但缺价格的 Pump 交易仍必须实时进入列表",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(atZero.response.notificationItemKeys)), []);

  await harness.publishPumpRealtimeItems([{
    ...base,
    id: "pump:verified-baseline",
    marketCapSnapshot: 250_000,
    totalSupplySnapshot: 1_000_000_000,
  }], "profile-rest-baseline", false);
  const baseline = await port.nextMessage();
  assert.deepEqual(
    JSON.parse(JSON.stringify(baseline.response.realtimeItemKeys)),
    [],
    "历史基线只更新快照，不能重放进 GMGN 实时列表",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(baseline.response.notificationItemKeys)), []);

  await harness.publishPumpRealtimeItems([{
    ...base,
    id: "pump:verified-priced",
    marketCapSnapshot: 250_000,
    totalSupplySnapshot: 1_000_000_000,
  }]);
  const priced = await port.nextMessage();
  assert.deepEqual(
    JSON.parse(JSON.stringify(priced.response.realtimeItemKeys)),
    [followTrades.stableKey(base)],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(priced.response.notificationItemKeys)),
    [followTrades.stableKey(base)],
  );
  port.disconnect();
});

test("Pump 追踪按 nextCursor 补齐第二页交易", async () => {
  const firstTrade = { id: "pump:newer", platform: "pump", type: "sell", createdAt: 400 };
  const secondTrade = { id: "pump:older", platform: "pump", type: "sell", createdAt: 300 };
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 200,
    pumpTradePayload: (url) => url.includes("cursor=page-2")
      ? { items: [secondTrade] }
      : { items: [firstTrade], nextCursor: "page-2" },
    responsePayload: () => ({ trades: [] }),
  });

  const result = await harness.queryFollowedTrades();

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [firstTrade, secondTrade]);
  assert.equal(harness.pumpRequestCount(), 2);
  assert.deepEqual(harness.pumpRequestCredentials, ["include", "include"]);
});

test("Pump alerts 漏报时通过 presence、关注 profile 与 Solana 收据补进追踪流", async () => {
  const viewer = "A1EbAYSRyWCUgRi3Q9iphNtRD3pAqTrm2sq79CR5J4v8";
  const wallet = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const token = "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump";
  const tx = "2WHiUQCbxhg5YfS79PPH3xfWZ5LfaGdycqR2vqmotjkUonfox1U8ue6nSWcDE2NYkmhrsNb1bT2H9XKKEVKx5Jfv";
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 200,
    pumpProfileEnabled: true,
    pumpTradePayload: { items: [] },
    pumpPresencePayload: {
      subject: "alertsFeed.user.viewer-user.*",
      heartbeatIntervalSeconds: 60,
      presenceTtlSeconds: 180,
    },
    pumpUserPayload: { canonical_svm_wallet: viewer },
    pumpFollowingPayload: [{
      username: "hexiecs",
      profile_image: "https://example.com/hexiecs.png",
      address: wallet,
    }],
    pumpProfilePayload: { transactions: [{
      tx_hash: tx,
      block_time: 1788095419,
      type: "TRANSFER",
      direction: "IN",
      token_transferred: {
        mint: pumpApi.SOLANA_USDC_MINT,
        amount: "2533.850574",
        metadata: { symbol: "USDC", decimals: "6" },
      },
    }], pagination: {} },
    solanaRpcPayload: (requests) => requests.map((request) => ({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        blockTime: 1788095419,
        meta: {
          err: null,
          logMessages: ["Program log: Instruction: PumpSwapV3", "Program log: Instruction: Sell"],
          preTokenBalances: [{
            owner: wallet,
            mint: token,
            uiTokenAmount: { amount: "9173160413968", decimals: 6 },
          }, {
            owner: wallet,
            mint: pumpApi.SOLANA_USDC_MINT,
            uiTokenAmount: { amount: "114359996952", decimals: 6 },
          }],
          postTokenBalances: [{
            owner: wallet,
            mint: token,
            uiTokenAmount: { amount: "4586580206984", decimals: 6 },
          }, {
            owner: wallet,
            mint: pumpApi.SOLANA_USDC_MINT,
            uiTokenAmount: { amount: "116893847526", decimals: 6 },
          }],
        },
      },
    })),
    pumpCoinPayload: {
      symbol: "GTA",
      name: "GTA memes",
      image_uri: "https://example.com/gta.png",
      usd_market_cap: 552688.53,
    },
    responsePayload: () => ({ trades: [] }),
  });

  const result = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.sol);

  assert.equal(result.ok, true);
  assert.equal(result.sources.pump.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, `pump:${tx}:${wallet}:${token}:sell`);
  assert.equal(result.items[0].displayName, "hexiecs");
  assert.equal(result.items[0].type, "sell");
  assert.equal(result.items[0].tokenSymbol, "GTA");
  assert.equal(result.items[0].usdAmount, 2533.850574);
});

test("Pump alerts 缺少 symbol 和市值时异步复用 coin metadata 补齐", async () => {
  const token = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6U3M3zXjvB7mbonk";
  const wallet = "PumpWallet111111111111111111111111111111111";
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpProfileEnabled: true,
    pumpTradePayload: { items: [{
      kind: "trade",
      createdAt: "2026-08-28T08:30:00.000Z",
      walletAddress: wallet,
      coinMint: token,
      author: { userName: "Pump Friend" },
      trade: { tx: "solana-alert-tx", isBuy: true, amountUsd: "42" },
    }] },
    pumpCoinPayload: {
      symbol: "BONK",
      name: "Bonk",
      image_uri: "https://example.com/bonk.png",
      usd_market_cap: 777000,
    },
    responsePayload: () => ({ responseObject: { items: [] } }),
  });

  const first = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.sol);
  assert.equal(first.items.length, 1, JSON.stringify(first));
  assert.equal(first.items[0].tokenSymbol, "");
  assert.equal(first.items[0].marketCap, null);

  await new Promise((resolve) => setImmediate(resolve));
  const enriched = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.sol);
  assert.equal(enriched.items[0].tokenSymbol, "BONK");
  assert.equal(enriched.items[0].marketCap, 777000);
});

test("Pump alerts 已有 ticker 市值和供应量但缺图时仍补 metadata 并冻结近期市值", async () => {
  const token = "ETHc1Ksoq6TC94Bprc5iXcQpvGwTe7MnWRNJ3MTTTovq";
  const wallet = "PumpWallet111111111111111111111111111111111";
  const tx = "3".repeat(88);
  const image = "https://ipfs.io/ipfs/bafybeid52g3njfejwrugskdxjf3m2cbqj7jb32xhhpjvyhus7llcbuta4y";
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpProfileEnabled: true,
    pumpTradePayload: { items: [{
      kind: "trade",
      createdAt: new Date().toISOString(),
      walletAddress: wallet,
      coinMint: token,
      coinSymbol: "GG",
      coin: { marketCap: 11_400 },
      author: { userName: "Pump Friend" },
      trade: {
        tx,
        isBuy: true,
        amountUsd: "42",
        totalSupplyAtTrade: 1_000_000_000,
      },
    }] },
    pumpCoinPayload: {
      symbol: "GG",
      name: "Golden Goose",
      image_uri: image,
      total_supply_str: "1000000000000000",
      base_decimals: 6,
      usd_market_cap: 11_485,
    },
    responsePayload: () => ({ responseObject: { items: [] } }),
  });

  const first = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.sol);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].tokenImageUrl, null);

  await new Promise((resolve) => setImmediate(resolve));
  const enriched = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.sol);
  assert.equal(enriched.items[0].tokenImageUrl, image);
  assert.equal(enriched.items[0].marketCapSnapshot, 11_485);
  assert.equal(enriched.items[0].totalSupplySnapshot, 1_000_000_000);
  assert.equal(enriched.items[0].marketSnapshotSource, "pump-realtime-observed");
  assert.deepEqual(JSON.parse(JSON.stringify(enriched.notificationItemKeys)), []);
});

test("Solana RPC 暂时返回 null 只做短暂阴性缓存，下一轮会重试", async () => {
  const transactionHash = "2".repeat(88);
  const walletAddress = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpProfileEnabled: true,
    solanaRpcPayload: (requests) => requests.map((request) => ({
      jsonrpc: "2.0",
      id: request.id,
      result: null,
    })),
  });
  const groups = [{
    transactionHash,
    walletAddress,
    networkId: core.TOKEN_NETWORK_IDS.sol,
    createdAt: 100,
    author: { username: "rpc-retry" },
    rows: [{ type: "TRANSFER" }],
  }];

  assert.equal((await harness.resolvePumpSolanaGroups(groups)).length, 0);
  assert.equal((await harness.resolvePumpSolanaGroups(groups)).length, 0);
  assert.equal(harness.solanaRpcRequestCount(), 1);

  harness.advanceTime(4_001);
  assert.equal((await harness.resolvePumpSolanaGroups(groups)).length, 0);
  assert.equal(harness.solanaRpcRequestCount(), 2);
});

test("Pump profile 的 Robinhood TRANSFER 经 EVM receipt 还原成真实卖出", async () => {
  const viewer = "A1EbAYSRyWCUgRi3Q9iphNtRD3pAqTrm2sq79CR5J4v8";
  const svmWallet = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const evmWallet = "0x1160079f1463dc5f9f20b1f1b9cf628718649c18";
  const token = "0x98096d17e191b3da1d5f99a6d7b3584351b11e18";
  const usdg = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
  const router = "0x1111111111111111111111111111111111111111";
  const pool = "0x2222222222222222222222222222222222222222";
  const tx = `0x${"ab".repeat(32)}`;
  const topic = (address) => `0x${address.slice(2).padStart(64, "0")}`;
  const transfer = (address, from, to, amount) => ({
    address,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      topic(from),
      topic(to),
    ],
    data: `0x${BigInt(amount).toString(16).padStart(64, "0")}`,
  });
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 200,
    pumpProfileEnabled: true,
    pumpTradePayload: { items: [] },
    pumpPresencePayload: {
      subject: "alertsFeed.user.viewer-user.*",
      heartbeatIntervalSeconds: 60,
      presenceTtlSeconds: 180,
    },
    pumpUserPayload: (url) => url.endsWith("/users/viewer-user")
      ? { canonical_svm_wallet: viewer }
      : { canonical_svm_wallet: svmWallet, canonical_evm_wallet: evmWallet },
    pumpFollowingPayload: [{
      username: "evm-trader",
      profile_image: "https://example.com/evm.png",
      address: svmWallet,
    }],
    pumpProfilePayload: { transactions: [{
      tx_hash: tx,
      block_time: 1788097100,
      type: "TRANSFER",
      transaction_type: "SEND",
      network_id: 4663,
      direction: "OUT",
      token_transferred: {
        mint: token,
        amount: "1000",
        metadata: { symbol: "MEME" },
      },
    }, {
      tx_hash: tx,
      block_time: 1788097100,
      type: "TRANSFER",
      transaction_type: "RECEIVE",
      network_id: 4663,
      direction: "IN",
      token_transferred: {
        mint: usdg,
        amount: "321.5",
        metadata: { symbol: "USDG" },
      },
    }], pagination: {} },
    rpcPayload: (requests, url) => {
      assert.equal(url, "https://rpc.mainnet.chain.robinhood.com");
      return requests.map((request) => ({
        jsonrpc: "2.0",
        id: request.id,
        result: request.method === "eth_getTransactionByHash"
          ? { hash: tx, from: router, to: router, value: "0x0", input: "0x12345678" }
          : {
            status: "0x1",
            transactionHash: tx,
            logs: [
              transfer(token, evmWallet, pool, 1000),
              transfer(usdg, pool, router, 321_500_000),
              {
                address: pool,
                topics: ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"],
                data: "0x",
              },
            ],
          },
      }));
    },
    responsePayload: () => ({ trades: [] }),
  });

  const result = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.robinhood);

  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].type, "sell");
  assert.equal(result.items[0].networkId, 4663);
  assert.equal(result.items[0].walletAddress, evmWallet);
  assert.equal(result.items[0].tokenAddress, token);
  assert.equal(result.items[0].usdAmount, 321.5);
});

const ROBINHOOD_VIEWER = "A1EbAYSRyWCUgRi3Q9iphNtRD3pAqTrm2sq79CR5J4v8";
const ROBINHOOD_SVM_WALLET = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
const ROBINHOOD_EVM_WALLET = "0x1160079f1463dc5f9f20b1f1b9cf628718649c18";
const ROBINHOOD_USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

function robinhoodSwap(tx, token, symbol = "") {
  return {
    tx_hash: tx,
    block_time: 1788097200,
    type: "SWAP",
    network_id: 4663,
    token_in: { mint: token, amount: "1000", metadata: { symbol } },
    token_out: { mint: ROBINHOOD_USDG, amount: "250", metadata: { symbol: "USDG" } },
  };
}

function robinhoodProfileHarness(
  transactions,
  rpcPayload,
  pumpTradePayload = { items: [] },
  fomoTrades = [],
  pumpCoinPayload = null,
) {
  return createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpStatus: 200,
    pumpProfileEnabled: true,
    pumpTradePayload,
    pumpPresencePayload: {
      subject: "alertsFeed.user.viewer-user.*",
      heartbeatIntervalSeconds: 60,
      presenceTtlSeconds: 180,
    },
    pumpUserPayload: (url) => url.endsWith("/users/viewer-user")
      ? { canonical_svm_wallet: ROBINHOOD_VIEWER }
      : {
        canonical_svm_wallet: ROBINHOOD_SVM_WALLET,
        canonical_evm_wallet: ROBINHOOD_EVM_WALLET,
      },
    pumpFollowingPayload: [{
      userId: "followed-user",
      username: "evm-trader",
      address: ROBINHOOD_SVM_WALLET,
    }],
    pumpProfilePayload: { transactions, pagination: {} },
    pumpCoinPayload,
    rpcPayload,
    responsePayload: (url) => url.includes("/feed/tradingActivity?")
      ? { trades: fomoTrades }
      : { responseObject: [] },
  });
}

test("Robinhood Pump profile 用 Pump coin metadata 补真实总供应量", async () => {
  const token = "0x3e7f2c3a81a1c8302eace254928e0fba5a3bc447";
  const tx = `0x${"29".repeat(32)}`;
  const harness = robinhoodProfileHarness(
    [robinhoodSwap(tx, token, "NAV")],
    () => [],
    { items: [] },
    [],
    {
      symbol: "NAV",
      total_supply_str: "1000000000000000000000000000",
      base_decimals: 18,
      usd_market_cap: 19_462.28,
    },
  );

  const result = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.robinhood);

  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].totalSupply, 1_000_000_000);
  assert.equal(result.items[0].baseAmount, 1000);
  assert.equal(result.items[0].usdAmount, 250);
});

function abiDynamicString(value) {
  const bytes = Buffer.from(value, "utf8");
  const paddedLength = Math.ceil(bytes.length / 32) * 32;
  return `0x${(32n).toString(16).padStart(64, "0")}${BigInt(bytes.length).toString(16).padStart(64, "0")}${bytes.toString("hex").padEnd(paddedLength * 2, "0")}`;
}

test("Robinhood ticker RPC 在首个快照后异步补齐且不阻塞交易卡", async () => {
  const token = "0x3333333333333333333333333333333333333333";
  const tx = `0x${"31".repeat(32)}`;
  const alertTx = `0x${"32".repeat(32)}`;
  let releaseSymbol;
  const symbolGate = new Promise((resolve) => { releaseSymbol = resolve; });
  const harness = robinhoodProfileHarness([robinhoodSwap(tx, token)], (requests, url) => {
    assert.equal(url, "https://rpc.mainnet.chain.robinhood.com");
    if (requests.some((request) => request.method !== "eth_call")) {
      return requests.map((request) => ({ id: request.id, result: null }));
    }
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "eth_call");
    assert.deepEqual(requests[0].params, [{ to: token, data: pumpApi.EVM_SYMBOL_DATA }, "latest"]);
    return symbolGate;
  }, { items: [{
    kind: "trade",
    chainId: 4663,
    createdAt: "2026-08-30T16:20:00.000Z",
    walletAddress: ROBINHOOD_EVM_WALLET,
    coinMint: token,
    trade: { tx: alertTx, isBuy: true, amountUsd: "100" },
  }] });

  const first = await Promise.race([
    harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.robinhood),
    new Promise((_, reject) => setTimeout(() => reject(new Error("TICKER_BLOCKED_TRADE")), 100)),
  ]);
  assert.equal(first.items.length, 2);
  assert.deepEqual(first.items.map((item) => item.tokenSymbol), ["", ""]);
  const symbolRequestCount = () => harness.requestedRpcPayloads.flat()
    .filter((request) => request.method === "eth_call").length;
  assert.equal(symbolRequestCount(), 1);

  harness.advanceTime(4_001);
  const whilePending = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.robinhood);
  assert.equal(whilePending.items.every((item) => item.tokenSymbol === ""), true);
  assert.equal(symbolRequestCount(), 1, "慢 symbol RPC 未完成时不得被下一轮轮询重复发起");

  releaseSymbol([{ id: `symbol:${token}`, result: abiDynamicString("MEME") }]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  harness.advanceTime(4_001);
  const enriched = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.robinhood);
  const enrichedById = new Map();
  for (const item of enriched.items) {
    if (!enrichedById.has(item.id)) enrichedById.set(item.id, item);
  }
  assert.equal(enrichedById.get(`pump:${tx}:${ROBINHOOD_EVM_WALLET}:${token}:buy`).tokenSymbol, "MEME");
  assert.equal(enrichedById.get(`pump:${alertTx}:${ROBINHOOD_EVM_WALLET}:${token}:buy`).tokenSymbol, "MEME");

  harness.advanceTime(26_001);
  const cached = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.robinhood);
  const cachedById = new Map();
  for (const item of cached.items) {
    if (!cachedById.has(item.id)) cachedById.set(item.id, item);
  }
  assert.equal([...cachedById.values()].every((item) => item.tokenSymbol === "MEME"), true);
  assert.equal(symbolRequestCount(), 1);
});

test("Fomo EVM 追踪复用异步 ticker RPC，首屏不阻塞且下一轮补齐", async () => {
  const token = "0x7777777777777777777777777777777777777777";
  const trade = {
    id: "fomo:robinhood-symbol",
    platform: "fomo",
    type: "buy",
    createdAt: 1_788_097_200_000,
    networkId: core.TOKEN_NETWORK_IDS.robinhood,
    walletAddress: ROBINHOOD_EVM_WALLET,
    tokenAddress: token,
    tokenSymbol: "",
  };
  const harness = robinhoodProfileHarness([], (requests, url) => {
    assert.equal(url, "https://rpc.mainnet.chain.robinhood.com");
    assert.deepEqual(requests.map((request) => request.id), [`symbol:${token}`]);
    return requests.map((request) => ({
      id: request.id,
      result: abiDynamicString("FOMO"),
    }));
  }, { items: [] }, [trade]);

  const first = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.robinhood);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].tokenSymbol, "");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.rpcRequestCount(), 1);

  harness.advanceTime(4_001);
  const enriched = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.robinhood);
  assert.equal(enriched.items.length >= 1, true);
  assert.equal(enriched.items.every((item) => item.tokenSymbol === "FOMO"), true);
  assert.equal(harness.rpcRequestCount(), 1);
});

test("Robinhood ticker malformed/revert 只做负缓存并保留全部交易卡", async () => {
  const firstToken = "0x4444444444444444444444444444444444444444";
  const secondToken = "0x5555555555555555555555555555555555555555";
  const transactions = [
    robinhoodSwap(`0x${"41".repeat(32)}`, firstToken),
    robinhoodSwap(`0x${"42".repeat(32)}`, firstToken),
    robinhoodSwap(`0x${"43".repeat(32)}`, secondToken),
  ];
  const harness = robinhoodProfileHarness(transactions, (requests) => requests.map((request) => (
    request.method !== "eth_call"
      ? { id: request.id, result: null }
      : request.id === `symbol:${firstToken}`
      ? { id: request.id, error: { code: 3, message: "execution reverted" } }
      : { id: request.id, result: "0x1234" }
  )));

  const first = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.robinhood);
  assert.equal(first.items.length, 3);
  assert.deepEqual(first.items.map((item) => item.tokenSymbol), ["", "", ""]);
  await new Promise((resolve) => setImmediate(resolve));
  const symbolBatches = () => harness.requestedRpcPayloads.filter((batch) => (
    batch.some((request) => request.method === "eth_call")
  ));
  assert.equal(symbolBatches().length, 1);
  const [batch] = symbolBatches();
  assert.equal(batch.length, 2);
  assert.deepEqual(batch.map((request) => request.method), ["eth_call", "eth_call"]);

  harness.advanceTime(30_001);
  const cached = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.robinhood);
  const current = [...new Map(cached.items.map((item) => [item.id, item])).values()];
  assert.equal(current.length, 3);
  assert.deepEqual(current.map((item) => item.tokenSymbol), ["", "", ""]);
  assert.equal(symbolBatches().length, 1);
});

test("Robinhood profile 已有 ticker 时不请求 metadata RPC", async () => {
  const token = "0x6666666666666666666666666666666666666666";
  const harness = robinhoodProfileHarness([
    robinhoodSwap(`0x${"51".repeat(32)}`, token, "KNOWN"),
  ], (requests) => {
    assert.equal(requests.some((request) => request.method === "eth_call"), false);
    return requests.map((request) => ({ id: request.id, result: null }));
  });

  const result = await harness.queryFollowedTrades(core.TOKEN_NETWORK_IDS.robinhood);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.items[0].tokenSymbol, "KNOWN");
  assert.equal(harness.requestedRpcPayloads.flat()
    .filter((request) => request.method === "eth_call").length, 0);
});

test("Fomo 与 Pump 追踪流都失败时返回明确的整体状态", async () => {
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 503,
    pumpStatus: 503,
  });

  const result = await harness.queryFollowedTrades();

  assert.equal(result.ok, false);
  assert.equal(result.error, "FOLLOWED_TRADES_UNAVAILABLE");
  assert.equal(result.sources.fomo.error, "HTTP_503");
  assert.equal(result.sources.pump.error, "HTTP_503");
});

test("点击 Fomo holder 时按该行 tradeId 与 GMGN 当前持仓联合解析地址", async () => {
  const holderAddress = "0x2222222222222222222222222222222222222222";
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    responsePayload: (url) => url.includes("/token_holders/")
      ? { address: holderAddress }
      : { responseObject: [] },
  });

  const result = await harness.resolveHolder(undefined, {
    tradeId: "trade-2",
    userId: "user-2",
    humanAmount: 24548940.15,
  });

  assert.equal(result.ok, true);
  assert.equal(result.address, holderAddress);
  assert.equal(harness.requestedUrls.includes("https://prod-api.fomo.family/trades/trade-2"), true);
  assert.equal(
    harness.requestedUrls.includes("https://gmgn.ai/vas/api/v1/token_holders/bsc/0x1234"),
    true,
  );
  assert.equal(harness.requestedAuthorizations.at(-1), "stable-token");
  assert.equal(harness.gmgnRequestCount(), 1);
});

test("优先在当前 GMGN 页面同源请求 holder API，成功后不走后台或链上", async () => {
  const holderAddress = "0x2222222222222222222222222222222222222222";
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    gmgnPagePayload: { address: holderAddress },
  });

  const result = await harness.resolveHolder(undefined, {
    tradeId: "trade-page",
    userId: "user-page",
    humanAmountRaw: "12.34",
  });

  assert.equal(result.address, holderAddress);
  assert.equal(result.source, "gmgn");
  assert.equal(harness.gmgnPageRequestCount(), 1);
  assert.equal(harness.gmgnRequestCount(), 0);
  assert.equal(harness.rpcRequestCount(), 0);
});

test("复制地址由扩展 Offscreen 文档写入系统剪贴板", async () => {
  const address = "0x2222222222222222222222222222222222222222";
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
  });

  const result = await harness.copyAddress(address);

  assert.equal(result.ok, true);
  assert.equal(harness.offscreenCreateCount(), 1);
  assert.equal(harness.offscreenMessages.length, 1);
  assert.equal(harness.offscreenMessages[0].text, address);
});

test("Pump BSC holder 按 userId 直接解析 canonical EVM 钱包", async () => {
  const address = "0x2222222222222222222222222222222222222222";
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    pumpUserPayload: {
      userId: "pump-user-1",
      canonical_svm_wallet: "AusMtCwzrPnPoJUSHYUH9iogVwpWh2ESHC6xWU75tBDo",
      canonical_evm_wallet: address,
    },
  });

  const first = await harness.resolvePumpHolder();
  const second = await harness.resolvePumpHolder();

  assert.equal(first.address, address);
  assert.equal(first.source, "pump");
  assert.equal(second.address, address);
  assert.equal(second.source, "cache");
  assert.equal(harness.pumpRequestCount(), 1);
  assert.equal(harness.gmgnRequestCount(), 0);
  assert.equal(harness.rpcRequestCount(), 0);
});

test("GMGN 不可用时仅在 EVM 链按结算日志候选和固定区块余额唯一兜底", async () => {
  const token = "0x1111111111111111111111111111111111111111";
  const holderAddress = "0x2222222222222222222222222222222222222222";
  const addressTopic = (address) => `0x${address.slice(2).padStart(64, "0")}`;
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    gmgnStatus: 503,
    rpcPayload(payload) {
      if (Array.isArray(payload)) {
        return payload.map((request) => ({
          jsonrpc: "2.0",
          id: request.id,
          result: "0xde0b6b3a7640000",
        }));
      }
      if (payload.method === "eth_blockNumber") return { jsonrpc: "2.0", id: 1, result: "0x64" };
      if (payload.method === "eth_getLogs") {
        const isBuy = payload.params[0].topics[1] !== null;
        return {
          jsonrpc: "2.0",
          id: 1,
          result: isBuy ? [{ topics: [
            "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
            addressTopic(evmResolver.FOMO_SETTLEMENT),
            addressTopic(holderAddress),
          ] }] : [],
        };
      }
      if (payload.method === "eth_call") return { jsonrpc: "2.0", id: 1, result: "0x12" };
      if (payload.method === "eth_getCode") return { jsonrpc: "2.0", id: 1, result: "0x" };
      throw new Error(`Unexpected RPC method ${payload.method}`);
    },
  });

  const result = await harness.resolveHolder({ address: token, networkId: 56 }, {
    tradeId: "trade-1",
    userId: "user-1",
    humanAmount: 1,
    humanAmountRaw: "1.000000000000000000",
    buyTimestampMs: Date.now(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.address, holderAddress);
  assert.equal(result.source, "chain");
  assert.equal(harness.gmgnRequestCount(), 1);
  assert.equal(harness.rpcRequestCount(), 5);
});

test("Fomo 买入时间可用时只扫成交区块附近，不先扫最近 15 万块", async () => {
  const token = "0x1111111111111111111111111111111111111111";
  const holderAddress = "0x2222222222222222222222222222222222222222";
  const addressTopic = (address) => `0x${address.slice(2).padStart(64, "0")}`;
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    gmgnStatus: 503,
    rpcPayload(payload) {
      if (Array.isArray(payload)) {
        return payload.map((request) => ({
          jsonrpc: "2.0",
          id: request.id,
          result: "0xde0b6b3a7640000",
        }));
      }
      if (payload.method === "eth_blockNumber") {
        return { jsonrpc: "2.0", id: 1, result: "0xf4240" };
      }
      if (payload.method === "eth_call") {
        return { jsonrpc: "2.0", id: 1, result: "0x12" };
      }
      if (payload.method === "eth_getLogs") {
        return { jsonrpc: "2.0", id: 1, result: [{ topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          addressTopic(evmResolver.FOMO_SETTLEMENT),
          addressTopic(holderAddress),
        ] }] };
      }
      if (payload.method === "eth_getCode") {
        return { jsonrpc: "2.0", id: 1, result: "0x" };
      }
      throw new Error(`Unexpected RPC method ${payload.method}`);
    },
  });

  const result = await harness.resolveHolder({ address: token, networkId: 56 }, {
    tradeId: "trade-timed",
    userId: "user-timed",
    humanAmountRaw: "1.000000000000000000",
    buyTimestampMs: Date.now() - 225_000_000,
  });

  const logRequests = harness.requestedRpcPayloads.filter((payload) => (
    !Array.isArray(payload) && payload.method === "eth_getLogs"
  ));
  assert.equal(result.address, holderAddress);
  assert.equal(result.source, "chain");
  assert.equal(logRequests.length, 1);
  assert.equal(harness.requestedRpcPayloads.some((payload) => (
    !Array.isArray(payload) && payload.method === "eth_getBlockByNumber"
  )), false);
  const filter = logRequests[0].params[0];
  assert.ok(BigInt(filter.fromBlock) >= 494_990n && BigInt(filter.fromBlock) <= 495_010n);
  assert.equal(BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n, 9_999n);
});

test("没有成交时间时不会在点击链路回退扫描 15 万块", async () => {
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    gmgnStatus: 503,
  });

  const result = await harness.resolveHolder(undefined, {
    tradeId: "trade-without-time",
    userId: "user-without-time",
    humanAmountRaw: "1",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "HOLDER_TRADE_TIMESTAMP_NOT_FOUND");
  assert.equal(harness.rpcRequestCount(), 0);
});

test("BSC 归档主 RPC 不可用时自动切换另一个归档节点", async () => {
  const token = "0x1111111111111111111111111111111111111111";
  const holderAddress = "0x2222222222222222222222222222222222222222";
  const addressTopic = (address) => `0x${address.slice(2).padStart(64, "0")}`;
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    gmgnStatus: 503,
    rpcPayload(payload, url) {
      if (url === "https://rpc-bsc.blockmachine.io") {
        return { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "archive required" } };
      }
      if (Array.isArray(payload)) {
        return payload.map((request) => ({
          jsonrpc: "2.0",
          id: request.id,
          result: "0xde0b6b3a7640000",
        }));
      }
      if (payload.method === "eth_blockNumber") return { jsonrpc: "2.0", id: 1, result: "0x64" };
      if (payload.method === "eth_getLogs") {
        return { jsonrpc: "2.0", id: 1, result: [{ topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          addressTopic(evmResolver.FOMO_SETTLEMENT),
          addressTopic(holderAddress),
        ] }] };
      }
      if (payload.method === "eth_call") return { jsonrpc: "2.0", id: 1, result: "0x12" };
      if (payload.method === "eth_getCode") return { jsonrpc: "2.0", id: 1, result: "0x" };
      throw new Error(`Unexpected RPC method ${payload.method}`);
    },
  });

  const result = await harness.resolveHolder({ address: token, networkId: 56 }, {
    tradeId: "trade-fallback",
    userId: "user-fallback",
    humanAmountRaw: "1.000000000000000000",
    buyTimestampMs: Date.now(),
  });

  assert.equal(result.address, holderAddress);
  assert.equal(result.source, "chain");
  assert.equal(harness.requestedRpcUrls.includes("https://rpc-bsc.blockmachine.io"), true);
  assert.equal(harness.requestedRpcUrls.includes("https://bsc.drpc.org"), true);
  assert.equal(harness.rpcRequestCount(), 10);
});

test("BSC 日志分片超时时自动二分，不让单个慢分片拖垮复制", async () => {
  const token = "0x1111111111111111111111111111111111111111";
  const holderAddress = "0x2222222222222222222222222222222222222222";
  const addressTopic = (address) => `0x${address.slice(2).padStart(64, "0")}`;
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    gmgnStatus: 503,
    rpcPayload(payload) {
      if (Array.isArray(payload)) {
        return payload.map((request) => ({
          jsonrpc: "2.0",
          id: request.id,
          result: "0xde0b6b3a7640000",
        }));
      }
      if (payload.method === "eth_blockNumber") return { jsonrpc: "2.0", id: 1, result: "0x2710" };
      if (payload.method === "eth_getLogs") {
        const filter = payload.params[0];
        const range = BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n;
        if (range > 5_000n) {
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          throw error;
        }
        const includesCandidate = BigInt(filter.fromBlock) <= 5_000n
          && BigInt(filter.toBlock) >= 5_000n;
        return { jsonrpc: "2.0", id: 1, result: includesCandidate ? [{ topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          addressTopic(evmResolver.FOMO_SETTLEMENT),
          addressTopic(holderAddress),
        ] }] : [] };
      }
      if (payload.method === "eth_call") return { jsonrpc: "2.0", id: 1, result: "0x12" };
      if (payload.method === "eth_getCode") return { jsonrpc: "2.0", id: 1, result: "0x" };
      throw new Error(`Unexpected RPC method ${payload.method}`);
    },
  });

  const result = await harness.resolveHolder({ address: token, networkId: 56 }, {
    tradeId: "trade-timeout",
    userId: "user-timeout",
    humanAmountRaw: "1.000000000000000000",
    buyTimestampMs: Date.now() - 2_250_000,
  });

  assert.equal(result.address, holderAddress);
  assert.equal(result.source, "chain");
});

test("Robinhood 优先用 Blockscout 原始余额解析，不触发限流 RPC", async () => {
  const token = "0x1111111111111111111111111111111111111111";
  const holderAddress = "0x2222222222222222222222222222222222222222";
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    gmgnStatus: 503,
    blockscoutPayload(url) {
      if (!url.includes("/holders")) return { decimals: "18" };
      return {
        items: [{
          address: { hash: holderAddress, is_contract: true, proxy_type: "eip7702" },
          value: "1000000000000000000",
        }],
        next_page_params: null,
      };
    },
  });

  const result = await harness.resolveHolder({ address: token, networkId: 4663 }, {
    tradeId: "trade-1",
    userId: "user-1",
    humanAmount: 1,
    humanAmountRaw: "1.000000000000000000",
  });

  assert.equal(result.ok, true);
  assert.equal(result.address, holderAddress);
  assert.equal(result.source, "chain");
  assert.equal(harness.blockscoutRequestCount(), 2);
  assert.equal(harness.rpcRequestCount(), 0);
});

test("Robinhood 的 Blockscout 命中不等待卡住的 GMGN 请求", async () => {
  const token = "0x1111111111111111111111111111111111111111";
  const holderAddress = "0x2222222222222222222222222222222222222222";
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    deferGmgn: true,
    blockscoutPayload(url) {
      if (!url.includes("/holders")) return { decimals: "18" };
      return {
        items: [{
          address: { hash: holderAddress, is_contract: true, proxy_type: "eip7702" },
          value: "1000000000000000000",
        }],
        next_page_params: null,
      };
    },
  });

  const pending = harness.resolveHolder({ address: token, networkId: 4663 }, {
    tradeId: "trade-fast",
    userId: "user-fast",
    humanAmountRaw: "1.000000000000000000",
  });
  const result = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error("WAITED_FOR_GMGN")), 25)),
  ]);
  harness.releaseGmgn();

  assert.equal(result.address, holderAddress);
  assert.equal(result.source, "chain");
});

test("同一 holder 首次解析期间的重复点击复用一个在途请求", async () => {
  const holderAddress = "0x2222222222222222222222222222222222222222";
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    deferGmgn: true,
    responsePayload(url) {
      return url.startsWith("https://gmgn.ai/") ? { address: holderAddress } : {};
    },
  });
  const params = { address: "0x1111111111111111111111111111111111111111", networkId: 56 };
  const holder = {
    tradeId: "trade-shared",
    userId: "user-shared",
    humanAmountRaw: "1.000000000000000000",
  };

  const first = harness.resolveHolder(params, holder);
  await new Promise((resolve) => setImmediate(resolve));
  const second = harness.resolveHolder(params, holder);
  harness.releaseGmgn();
  const [left, right] = await Promise.all([first, second]);

  assert.equal(left.address, holderAddress);
  assert.equal(right.address, holderAddress);
  assert.equal(harness.fomoRequestCount(), 1);
  assert.equal(harness.gmgnRequestCount(), 1);
});

test("相同 holder 的已验证地址直接命中短缓存", async () => {
  const holderAddress = "0x2222222222222222222222222222222222222222";
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    responsePayload: (url) => url.includes("/token_holders/")
      ? { address: holderAddress }
      : { responseObject: [] },
  });
  const holder = {
    tradeId: "trade-cache",
    userId: "user-cache",
    humanAmountRaw: "12.34",
  };

  const first = await harness.resolveHolder(undefined, holder);
  const second = await harness.resolveHolder(undefined, holder);

  assert.equal(first.address, holderAddress);
  assert.equal(second.address, holderAddress);
  assert.equal(second.source, "cache");
  assert.equal(harness.fomoRequestCount(), 1);
  assert.equal(harness.gmgnRequestCount(), 1);
});

test("持仓数量相同但稳定标识不同的 holder 不会串用地址缓存", async () => {
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    responsePayload: (url) => url.includes("/token_holders/")
      ? { address: "0x2222222222222222222222222222222222222222" }
      : { responseObject: [] },
  });
  const sharedAmount = "12.34";

  await harness.resolveHolder(undefined, {
    tradeId: "trade-row-1",
    userId: "user-row-1",
    humanAmountRaw: sharedAmount,
  });
  const second = await harness.resolveHolder(undefined, {
    tradeId: "trade-row-2",
    userId: "user-row-2",
    humanAmountRaw: sharedAmount,
  });

  assert.equal(second.source, "gmgn");
  assert.equal(harness.fomoRequestCount(), 2);
  assert.equal(harness.gmgnRequestCount(), 2);
});

test("同一 Token 的重叠 Fomo 刷新复用同一组请求", async () => {
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    responseDelayMs: 5,
  });

  const [first, second] = await Promise.all([harness.query(), harness.query()]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(harness.fomoRequestCount(), 3);

  const third = await harness.query();
  assert.equal(third.ok, true);
  assert.equal(harness.fomoRequestCount(), 3);
  harness.advanceTime(5_000);
  await harness.query();
  assert.equal(harness.fomoRequestCount(), 6);
});

test("Fomo 请求超时覆盖响应体读取，失败后 Retry 会真正重发", async () => {
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    responseJsonDelayMs: 100,
    tokenRequestTimeoutMs: 20,
  });

  const first = await harness.query();
  assert.equal(first.ok, false);
  assert.equal(first.error, "FOMO_REQUEST_TIMEOUT");
  assert.equal(harness.fomoRequestCount(), 3);

  const second = await harness.query(undefined, { force: true });
  assert.equal(second.ok, false);
  assert.equal(second.error, "FOMO_REQUEST_TIMEOUT");
  assert.equal(harness.fomoRequestCount(), 6);
});

test("永久悬挂的同 Token 请求超过共享期限后不会毒化后续 Retry", async () => {
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
    responseJsonNeverSettles: true,
    tokenRequestTimeoutMs: 20,
  });

  void harness.query();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.fomoRequestCount(), 3);

  harness.advanceTime(12_001);
  void harness.query();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.fomoRequestCount(), 6);
});

test("Fomo 实时刷新只持久化当前 Token，不重写旧的整包缓存", async () => {
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
  });
  harness.localData[TOKEN_CACHE_KEY] = {
    "56:0x9999": {
      cachedAt: Date.now(),
      data: { marker: "legacy-entry-must-not-be-rewritten" },
    },
  };

  const result = await harness.query();

  assert.equal(result.ok, true);
  const entryKey = `${TOKEN_CACHE_ENTRY_PREFIX}56:0x1234`;
  const cacheWrites = harness.localSetCalls.filter((values) => Object.hasOwn(values, TOKEN_CACHE_INDEX_KEY));
  assert.equal(cacheWrites.length, 1);
  assert.deepEqual(Object.keys(cacheWrites[0]).sort(), [TOKEN_CACHE_INDEX_KEY, entryKey].sort());
  assert.equal(JSON.stringify(cacheWrites[0]).includes("legacy-entry-must-not-be-rewritten"), false);
  assert.equal(harness.localData[TOKEN_CACHE_KEY]["56:0x9999"].data.marker, "legacy-entry-must-not-be-rewritten");
});

test("Fomo 分项缓存仍限制为最近 50 个 Token", async () => {
  const harness = createHarness({
    initialAuthorization: "stable-token",
    responseStatus: () => 200,
  });
  const existingIndex = Array.from({ length: 50 }, (_, index) => ({
    key: `${TOKEN_CACHE_ENTRY_PREFIX}56:0x${String(index).padStart(4, "0")}`,
    cachedAt: index + 1,
  }));
  harness.localData[TOKEN_CACHE_INDEX_KEY] = existingIndex;
  for (const entry of existingIndex) harness.localData[entry.key] = { cachedAt: entry.cachedAt, data: {} };

  const result = await harness.query({ address: "0x9999", networkId: 56 });

  assert.equal(result.ok, true);
  const nextIndex = harness.localData[TOKEN_CACHE_INDEX_KEY];
  const nextKey = `${TOKEN_CACHE_ENTRY_PREFIX}56:0x9999`;
  assert.equal(nextIndex.length, 50);
  assert.equal(nextIndex.some((entry) => entry.key === nextKey), true);
  assert.equal(nextIndex.some((entry) => entry.key === existingIndex[0].key), false);
  assert.equal(harness.localRemoveCalls.includes(existingIndex[0].key), true);
  assert.equal(Object.hasOwn(harness.localData, existingIndex[0].key), false);
});

test("单个 Fomo 接口失败时保留该部分缓存并更新其余数据", async () => {
  const cachedData = {
    metadata: { name: "Cached token", totalSupply: 1_000_000 },
    holders: { items: [{ id: "cached-holder" }] },
    feed: [{ id: "cached-feed" }],
  };
  const harness = createHarness({
    initialAuthorization: "stable-token",
    cachedData,
    responseStatus: (_authorization, url) => url.endsWith("/holders") ? 503 : 200,
    responsePayload: (url) => {
      if (url.endsWith("/metadata")) return { metadata: { name: "Fresh token", totalSupply: 2_000_000 } };
      if (url.endsWith("/feed")) return { feed: [{ id: "fresh-feed" }] };
      return {};
    },
  });

  const result = await harness.query();

  assert.equal(result.ok, true);
  assert.equal(result.cached, false);
  assert.equal(result.partial, true);
  assert.deepEqual(Array.from(result.cachedSections), ["holders"]);
  assert.equal(result.data.metadata.name, "Fresh token");
  assert.equal(result.data.holders.items[0].id, "cached-holder");
  assert.equal(result.data.feed[0].id, "fresh-feed");
});

test("超过五分钟的 Token 快照不会在实时持仓请求失败时继续冒充当前数据", async () => {
  const harness = createHarness({
    initialAuthorization: "stable-token",
    cachedData: {
      metadata: { name: "Stale token", totalSupply: 1_000_000 },
      holders: { items: [{ id: "stale-holder" }] },
      feed: [{ id: "stale-feed" }],
    },
    responseStatus: () => 503,
  });
  harness.advanceTime((5 * 60 * 1_000) + 1);

  const result = await harness.query();

  assert.equal(result.ok, false);
  assert.equal(result.error, "HTTP_503");
});

function realtimePumpOptions(extra = {}) {
  const configs = { CORE: { servers: "wss://prod-v2.nats.realtime.pump.fun", user: "test", pass: "test" } };
  return {
    initialAuthorization: "stable-token", responseStatus: () => 200,
    pumpProfileEnabled: true, existingPumpTab: false,
    pumpPresencePayload: { subject: "alertsFeed.user.viewer-user.test", heartbeatIntervalSeconds: 60 },
    pumpNatsHtml: `<script>{"configs":${JSON.stringify(configs)},"instances":{}}</script>`,
    responsePayload: () => ({ trades: [] }), ...extra,
  };
}

test("Pump 网页兜底不能掩盖后台认证失败，诊断保留关页前后续期路径", async () => {
  const subject = "alertsFeed.user.viewer-user.test";
  const h = createHarness(realtimePumpOptions({ existingPumpTab: true, pumpPresenceStatus: 403,
    pumpTradePayload: (url) => url.includes("/presence") ? { subject, heartbeatIntervalSeconds: 60 } : { items: [] } }));
  await h.ensurePumpSubscriptions(true);
  const before = (await h.getFollowedTradeDiagnostics()).diagnostic.pumpRealtime;
  assert.equal(before.error, "");
  assert.equal(before.presenceAuth.backgroundError, "HTTP_403");
  assert.equal(before.presenceAuth.backgroundSuccessAt, 0);
  assert.equal(before.presenceAuth.lastSuccessTransport, "page");
  h.closePumpPages();
  await assert.rejects(h.ensurePumpSubscriptions(true), /PUMP_SESSION_REQUIRED/);
  const after = (await h.getFollowedTradeDiagnostics()).diagnostic.pumpRealtime;
  assert.equal(after.error, "PUMP_SESSION_REQUIRED");
  assert.equal(after.presenceAuth.backgroundError, "HTTP_403");
  assert.equal(after.presenceAuth.lastSuccessTransport, "page");
});

test("Pump 实时认证失败不被历史成功覆盖，诊断关闭时仍显示会话提示", async () => {
  const h = createHarness(realtimePumpOptions({ pumpPresenceStatus: 401, diagnosticsEnabled: false }));
  const result = await h.queryFollowedTrades();
  assert.equal(result.sources.pump.ok, true, "历史查询仍可成功");
  await new Promise((resolve) => setImmediate(resolve));
  const source = await h.getFollowedTradeSources();
  assert.equal(source.sources.pump.error, "PUMP_SESSION_REQUIRED");
  assert.equal(h.actionState.badgeText, "!");
  assert.equal(h.localData[FOLLOWED_TRADES_DIAGNOSTIC_KEY], undefined);
});

test("Pump 后台成功时无需打开网页即可注册和续期", async () => {
  const h = createHarness(realtimePumpOptions({ pumpPresenceStatus: 200 }));
  const p = h.connectGmgnTradeEvents();
  await new Promise((resolve) => setImmediate(resolve));
  await h.ensurePumpSubscriptions(true);
  assert.equal(h.createdTabDetails.length, 0);
  const d = (await h.getFollowedTradeDiagnostics()).diagnostic;
  assert.equal(d.pumpRealtime.error, "");
  assert.equal(d.pumpRealtime.subjectCount, 1);
  assert.equal(d.pumpRealtime.retryScheduled, true);
  assert.equal(d.pumpRealtime.presenceAuth.lastSuccessTransport, "background");
  p.disconnect();
});

test("Pump 持续认证失败跨过五分钟也不自动开页，保留提示并可恢复", async () => {
  let authenticated = false;
  const h = createHarness(realtimePumpOptions({ pumpPresenceStatus: () => authenticated ? 200 : 401,
    acceleratePumpNatsRefresh: true }));
  const p = h.connectGmgnTradeEvents();
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    h.advanceTime(5 * 60_000 + 1);
    await assert.rejects(h.ensurePumpSubscriptions(true), /PUMP_SESSION_REQUIRED/);
  }
  assert.equal(h.createdTabDetails.length, 0);
  assert.equal(h.removedTabIds.length, 0);
  assert.equal(h.actionState.badgeText, "!");
  const failed = (await h.getFollowedTradeDiagnostics()).diagnostic.pumpRealtime;
  assert.equal(failed.automaticSessionPageRecovery, false);
  assert.equal(failed.retryScheduled, true, "持续失败后仍按封顶间隔恢复，不永久停订阅");
  assert.equal(failed.presenceAuth.backgroundError, "HTTP_401");
  authenticated = true;
  assert.equal(h.runPumpPresenceTimer(), 60_000, "达到重试上限仍按每分钟自动恢复");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await h.getFollowedTradeDiagnostics()).diagnostic.pumpRealtime.error, "");
  assert.equal(h.actionState.badgeText, "");
  assert.equal(h.createdTabDetails.length, 0);
  p.disconnect();
});

test("开启诊断时即时读取 Fomo socket 和 GMGN 端口，不依赖之前有日志", async () => {
  const h = createHarness({ initialAuthorization: "token", responseStatus: () => 200, diagnosticsEnabled: false });
  const p = h.connectGmgnTradeEvents();
  await new Promise((resolve) => setImmediate(resolve));
  const ws = h.webSockets[0]; ws.open(); ws.receive({ type: "challengeAccepted" });
  await h.setFollowedTradeDiagnosticsEnabled(true);
  const d = (await h.getFollowedTradeDiagnostics()).diagnostic;
  assert.equal(d.fomoRealtime.authenticated, true);
  assert.equal(d.fomoRealtime.socketState, 1);
  assert.equal(d.gmgnDelivery.portCount, 1);
  assert.equal(d.gmgnDelivery.acknowledged, 0);
  p.disconnect();
});

test("Fomo 过期凭据在后台恢复后重建订阅，不要求用户常驻网页", async () => {
  const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
  const h = createHarness({ initialAuthorization: `Bearer ${expired}`, replacementAuthorization: "renewed-token",
    responseStatus: () => 200, acceleratePumpNatsRefresh: true });
  const p = h.connectGmgnTradeEvents();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.localData[SESSION_KEY].authorization, "renewed-token");
  assert.equal(h.createdTabDetails.length, 1);
  assert.equal(h.removedTabIds.length, 1);
  assert.equal(h.webSockets.length, 1);
  h.webSockets[0].open();
  assert.equal(h.webSockets[0].sent[0].jwt, "renewed-token");
  p.disconnect();
});

test("Fomo 长时间不完成认证时关闭旧连接并重连，不永远卡在 OPEN", async () => {
  const h = createHarness({ initialAuthorization: "token", responseStatus: () => 200,
    accelerateFomoAuthTimeout: true, acceleratePumpNatsRefresh: true });
  const p = h.connectGmgnTradeEvents();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(h.webSockets.length >= 2);
  assert.equal(h.webSockets[0].readyState, 3);
  p.disconnect();
});

test("Pump 失败重试期间关闭推送会取消重试，不开启页面或重新订阅", async () => {
  const h = createHarness(realtimePumpOptions({ pumpPresenceStatus: 401,
    acceleratePumpNatsRefresh: true }));
  const p = h.connectGmgnTradeEvents();
  await new Promise((resolve) => setImmediate(resolve));
  await h.setFollowedTradesEnabled(false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.createdTabDetails.length, 0);
  assert.equal(h.offscreenMessages.filter((m) => m.subjects?.length).length, 0);
  assert.equal((await h.getFollowedTradeDiagnostics()).diagnostic.pumpRealtime.retryScheduled, false);
  p.disconnect();
});

test("presence 并发请求等待同一来源规则安装，续期和退出复用规则", async () => {
  let release;
  const installed = new Promise((resolve) => { release = resolve; });
  const rules = [];
  const h = createHarness(realtimePumpOptions({ updateSessionRules: async (rule) => {
    rules.push(rule);
    await installed;
  } }));
  const request = pumpApi.buildPresenceRequest();
  const first = h.fetchPublicJson(request);
  const second = h.fetchPublicJson(request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.pumpRequestCount(), 0, "规则生效前不能发请求");
  assert.equal(rules.length, 1);
  release();
  await Promise.all([first, second]);
  await h.fetchPublicJson({ ...request, method: "DELETE", allowEmptyResponse: true });
  assert.equal(h.pumpRequestCount(), 3);
  assert.equal(rules.length, 1);
  const rule = JSON.parse(JSON.stringify(rules[0].addRules[0]));
  assert.deepEqual(rule.condition, {
    urlFilter: "|https://frontend-api-v3.pump.fun/following-positions/alerts/presence|",
    isUrlFilterCaseSensitive: true,
    initiatorDomains: ["extension-id"],
    requestMethods: ["post", "delete"],
    resourceTypes: ["xmlhttprequest"],
  });
  assert.deepEqual(rule.action.requestHeaders, [{ header: "origin", operation: "set", value: "https://pump.fun" }]);
});

test("presence 规则安装失败不误报登录，下一次可以重新安装", async () => {
  let installs = 0;
  const h = createHarness(realtimePumpOptions({ updateSessionRules: async () => {
    if (++installs === 1) throw new Error("rule unavailable");
  } }));
  await assert.rejects(h.ensurePumpSubscriptions(true), /PUMP_PRESENCE_TRANSPORT_UNAVAILABLE/);
  assert.equal(h.pumpRequestCount(), 0);
  assert.equal(h.actionState.badgeText, "");
  await h.ensurePumpSubscriptions(true);
  assert.equal(installs, 2);
  assert.equal((await h.getFollowedTradeDiagnostics()).diagnostic.pumpRealtime.error, "");
});

test("明确的 presence CORS 拒绝不再变成登录提示或调用网页兜底", async () => {
  const h = createHarness(realtimePumpOptions({ existingPumpTab: true, pumpPresenceStatus: 403,
    pumpPresencePayload: { message: "Not allowed by CORS", error: "Forbidden" } }));
  await assert.rejects(h.ensurePumpSubscriptions(true), /PUMP_CORS_REJECTED/);
  assert.equal(h.pumpPageRequestCount(), 0);
  assert.equal(h.actionState.badgeText, "");
  assert.equal((await h.getFollowedTradeDiagnostics()).diagnostic.pumpRealtime.error, "PUMP_CORS_REJECTED");
});

test("历史 GET 与其他 Pump 路径不安装 presence 来源规则", async () => {
  let installs = 0;
  const h = createHarness(realtimePumpOptions({ updateSessionRules: async () => { installs++; } }));
  await h.fetchPublicJson(pumpApi.buildFollowedTradesRequest());
  await h.fetchPublicJson({ url: "https://frontend-api-v3.pump.fun/following-positions/alerts/presence/other", method: "POST" });
  assert.equal(installs, 0);
});

test("事后打开诊断仍能导出 Fomo 卖出的逐笔收发回执和名称，不保存凭据或钱包", async () => {
  const h = createHarness({ initialAuthorization: "Bearer receipt-secret", responseStatus: () => 200,
    diagnosticsEnabled: false, responsePayload: () => ({ trades: [] }) });
  const p = h.connectGmgnTradeEvents();
  await new Promise((resolve) => setImmediate(resolve));
  const ws = h.webSockets[0]; ws.open(); ws.receive({ type: "challengeAccepted" });
  const item = { id: "fomo:missing-sell", platform: "fomo", type: "sell", createdAt: Date.now(),
    tokenAddress: "0xc73e1b136c576d1429cb84522a8c35c81d9d7777", networkId: 56,
    userHandle: "iruletrenches", displayName: "iruletrenches", tokenSymbol: "月薪喵",
    walletAddress: "wallet-must-not-leak", authorization: "raw-payload-secret", usdAmount: 10 };
  ws.receive({ type: "data", topicType: "trading_activity", topicId: "viewer-user", payload: item });
  const message = await p.nextMessage();
  p.send({ type: "gmgnFollowTradeAck", deliveryId: message.deliveryId, status: "accepted", reason: "ROW_RENDERED" });
  await h.setFollowedTradeDiagnosticsEnabled(true);
  const d = (await h.getFollowedTradeDiagnostics()).diagnostic;
  const receipt = d.receipts.trades.find((row) => row.id === item.id);
  assert.equal(receipt.userHandle, "iruletrenches");
  assert.equal(receipt.tokenSymbol, "月薪喵");
  assert.ok(receipt.stages["fomo-websocket-normalized"]);
  assert.ok(receipt.stages["gmgn-event-broadcast"]);
  assert.ok(receipt.stages["gmgn-event-ack"]);
  assert.ok(receipt.stages["gmgn-row-rendered"]);
  assert.equal(d.pipeline.some((event) => event.stage === "fomo-websocket-normalized"), false,
    "详细诊断没有过去日志，收发记录仍应独立保存");
  const output = JSON.stringify(d.receipts);
  for (const secret of ["receipt-secret", "wallet-must-not-leak", "raw-payload-secret"]) {
    assert.equal(output.includes(secret), false);
  }
  assert.equal(h.localData.followedTradeReceiptsV1, undefined, "收发结果不能写入持久 local storage");
  p.disconnect();
});

test("REST 查到卖出但无实时证据，保留 REST-only 路径且不补发历史通知", async () => {
  const item = { id: "fomo:rest-only-sell", platform: "fomo", type: "sell", createdAt: Date.now(),
    tokenAddress: "0xc73e1b136c576d1429cb84522a8c35c81d9d7777", networkId: 56,
    userHandle: "iruletrenches", tokenSymbol: "月薪喵" };
  const h = createHarness({ initialAuthorization: "token", responseStatus: () => 200,
    diagnosticsEnabled: false, responsePayload: (url) => url.includes("/feed/tradingActivity?")
      ? { trades: [item] } : { responseObject: [] } });
  await h.queryFollowedTrades();
  const d = (await h.getFollowedTradeDiagnostics()).diagnostic;
  assert.equal(d.enabled, false);
  const receipt = d.receipts.trades.find((row) => row.id === item.id);
  assert.ok(receipt.stages["fomo-rest-response"]);
  assert.equal(receipt.stages["fomo-websocket-normalized"], undefined);
  assert.equal(d.gmgnDelivery.sent, 0);
  await h.setFollowedTradeDiagnosticsEnabled(false);
  assert.equal((await h.getFollowedTradeDiagnostics()).diagnostic.receipts.trades.length, 0);
});

test("Fomo 无法解析及 topic 不匹配必须留下原因，原始消息不进入收发记录", async () => {
  const h = createHarness({ initialAuthorization: "token", responseStatus: () => 200, diagnosticsEnabled: false });
  const p = h.connectGmgnTradeEvents();
  await new Promise((resolve) => setImmediate(resolve));
  const ws = h.webSockets[0]; ws.open(); ws.receive({ type: "challengeAccepted" });
  ws.receive({ type: "data", topicType: "trading_activity", topicId: "viewer-user",
    payload: { id: "bad-sell", userHandle: "iruletrenches", tokenName: "月薪喵", secret: "hidden-raw-payload" } });
  ws.receive({ type: "data", topicType: "trading_activity", topicId: "wrong-account-secret", payload: {} });
  const receipts = (await h.getFollowedTradeDiagnostics()).diagnostic.receipts;
  assert.ok(receipts.trades.find((row) => row.id === "fomo:bad-sell").stages["fomo-websocket-rejected"]);
  assert.ok(receipts.sourceEvents.some((event) => event.reason === "TOPIC_ID_MISMATCH"));
  assert.equal(JSON.stringify(receipts).includes("hidden-raw-payload"), false);
  assert.equal(JSON.stringify(receipts).includes("wrong-account-secret"), false);
  p.disconnect();
});

test('后台重建后从 browser session 恢复已收到的逐笔回执', async () => {
  const recorder = require('../src/trade-receipts').create();
  recorder.record('gmgn-event-ack', [{ id: 'fomo:before-worker-restart', platform: 'fomo',
    type: 'sell', createdAt: Date.now(), userHandle: 'iruletrenches', tokenSymbol: '月薪喵' }]);
  const h = createHarness({ initialAuthorization: 'token', responseStatus: () => 200, diagnosticsEnabled: false,
    receiptSessionData: JSON.parse(JSON.stringify(recorder.snapshot())) });
  const result = (await h.getFollowedTradeDiagnostics()).diagnostic.receipts;
  assert.equal(result.trades[0].id, 'fomo:before-worker-restart');
  assert.ok(result.trades[0].stages['gmgn-event-ack']);
});

test('诊断页单次核对绕过 Fomo 缓存，可发现缓存窗口内漏掉的卖出且不通知', async () => {
  let trades = [];
  const h = createHarness({ initialAuthorization: 'token', responseStatus: () => 200, diagnosticsEnabled: false,
    responsePayload: (url) => url.includes('/feed/tradingActivity?') ? { trades } : { responseObject: [] } });
  const p = h.connectGmgnTradeEvents();
  await new Promise((resolve) => setImmediate(resolve));
  const ws = h.webSockets[0]; ws.open(); ws.receive({ type: 'challengeAccepted' });
  await h.queryFollowedTrades();
  const before = h.fomoRequestCount();
  trades = [{ id: 'fomo:missed-within-cache', platform: 'fomo', type: 'sell', createdAt: Date.now(),
    networkId: 56, tokenAddress: '0xc73e1b136c576d1429cb84522a8c35c81d9d7777', userHandle: 'iruletrenches' }];
  await h.checkDiagnosticSources();
  assert.ok(h.fomoRequestCount() > before);
  const d = (await h.getFollowedTradeDiagnostics()).diagnostic;
  assert.ok(d.receipts.trades.find((row) => row.id === 'fomo:missed-within-cache').stages['fomo-rest-response']);
  assert.equal(d.gmgnDelivery.sent, 0);
  p.disconnect();
});


test("公开配置忽略旧诊断开关，拒绝开启和来源检查，正常查询与 Fomo 投递不写诊断", async () => {
  const h = createHarness({ publicRuntime: true, diagnosticsEnabled: true,
    initialAuthorization: "public-test-token", responseStatus: () => 200,
    responsePayload: () => ({ trades: [] }) });
  await new Promise(setImmediate);
  assert.equal((await h.getFollowedTradeDiagnosticsEnabled()).enabled, false);
  assert.equal((await h.setFollowedTradeDiagnosticsEnabled(true)).error, "DIAGNOSTICS_UNAVAILABLE");
  assert.equal((await h.checkDiagnosticSources()).error, "DIAGNOSTICS_UNAVAILABLE");
  const queried = await h.query();
  assert.equal(queried.ok, true);
  const p = h.connectGmgnTradeEvents();
  try {
    await new Promise(setImmediate);
    const ws = h.webSockets[0]; ws.open(); ws.receive({ type: "challengeAccepted" });
    const item = { id: "fomo:public-release", platform: "fomo", type: "sell", createdAt: h.now(),
      tokenAddress: "0x1111111111111111111111111111111111111111", networkId: 56, usdAmount: 10 };
    ws.receive({ type: "data", topicType: "trading_activity", topicId: "viewer-user", payload: item });
    const message = await p.nextMessage();
    assert.equal(message.item.id, item.id);
    p.send({ type: "gmgnFollowTradeAck", deliveryId: message.deliveryId, status: "accepted", reason: "ROW_RENDERED" });
    await new Promise(setImmediate);
    assert.equal(vm.runInContext("gmgnTradeDelivery.snapshot().acknowledged", h.runtimeContext), 1);
    assert.equal(vm.runInContext("tradeReceipts", h.runtimeContext), null);
    assert.equal(vm.runInContext("tradeReceiptTimer", h.runtimeContext), null);
    assert.equal(vm.runInContext("followedTradesPipelinePendingEvents.length", h.runtimeContext), 0);
    assert.equal(h.sessionData.followedTradeReceiptsV1, undefined);
    assert.equal(h.localSetCalls.some((entry) => Object.keys(entry).some((key) => /Diagnostic|Pipeline|Receipts/.test(key))), false);
    const snapshot = (await h.getFollowedTradeDiagnostics()).diagnostic;
    assert.equal(JSON.stringify(snapshot), JSON.stringify({ enabled: false, available: false }));
  } finally { p.disconnect(); }
});

for (const [chain, networkId] of Object.entries(core.TOKEN_NETWORK_IDS)) {
  test(`公开配置关闭诊断后 Pump ${chain} 实时投递并按两种到达顺序去重`, async () => {
    let items = [];
    const h = createHarness(realtimePumpOptions({ publicRuntime: true, diagnosticsEnabled: true,
      pumpTradePayload: () => ({ items }) }));
    const p = h.connectGmgnTradeEvents();
    const makeEvent = (id, hex) => {
      const event = officialPumpEvent(id, h.now());
      event.coin.chainId = String(networkId);
      if (chain !== "sol") {
        event.walletAddress = event.author.walletAddress = `0x${"Ab".repeat(20)}`;
        event.coinMint = event.coin.mint = `0x${"Cd".repeat(20)}`;
        event.trade.tx = `0x${hex.repeat(64)}`;
      }
      return event;
    };
    const acknowledge = (message) => p.send({ type: "gmgnFollowTradeAck", deliveryId: message.deliveryId,
      status: "accepted", reason: "ROW_RENDERED" });
    try {
      await new Promise(setImmediate);
      p.send({ type: "gmgnFollowTradeVisibility", visible: true });
      h.runPumpReconcileTimer();
      await h.reconcilePumpAlerts();
      assert.deepEqual(p.drainMessages(), []);
      h.advanceTime(30_000);
      const restFirst = makeEvent("rest-first", "a");
      items = [restFirst];
      h.runPumpReconcileTimer();
      await h.reconcilePumpAlerts();
      const restMessages = p.drainMessages();
      assert.equal(restMessages.length, 1);
      assert.equal(restMessages[0].item.networkId, networkId);
      acknowledge(restMessages[0]);
      await h.pumpNatsAlertEvent(restFirst);
      await new Promise(setImmediate);
      assert.deepEqual(p.drainMessages(), [], "REST 先到后 NATS 不重复投递");
      const natsFirst = makeEvent("nats-first", "b");
      assert.equal((await h.pumpNatsAlertEvent(natsFirst)).accepted, true);
      await new Promise(setImmediate);
      const natsMessages = p.drainMessages();
      assert.equal(natsMessages.length, 1);
      assert.equal(natsMessages[0].item.networkId, networkId);
      assert.equal(natsMessages[0].item.transactionHash, natsFirst.trade.tx);
      assert.equal(natsMessages[0].item.sourceVerification, pumpApi.PUMP_ALERTS_NATS_VERIFICATION);
      acknowledge(natsMessages[0]);
      await h.pumpNatsAlertEvent(natsFirst);
      items = [natsFirst, ...items];
      h.advanceTime(30_000);
      h.runPumpReconcileTimer();
      await h.reconcilePumpAlerts();
      assert.deepEqual(p.drainMessages(), [], "NATS 重复和随后 REST 均不重复投递");
      assert.equal(vm.runInContext("gmgnTradeDelivery.snapshot().acknowledged", h.runtimeContext), 2);
      assert.equal(h.sessionData.followedTradeReceiptsV1, undefined);
      assert.equal(vm.runInContext("tradeReceipts", h.runtimeContext), null);
      assert.equal(vm.runInContext("tradeReceiptTimer", h.runtimeContext), null);
    } finally { p.disconnect(); }
  });
}

const pumpRealAlert = require('./fixtures/pump-evm-alert.json');
const pumpRealAlertUser = require('./fixtures/pump-evm-alert-user.json');
const pumpSunFixture = require('./fixtures/pump-0xsun-rkst.json');

test('Pump quote completion shares one profile request and only updates the matching original trade', async () => {
  let releaseProfile, profileCalls = 0;
  const gate = new Promise(resolve => { releaseProfile = resolve; });
  const h = createHarness(realtimePumpOptions({ publicRuntime: true,
    pumpProfilePayload: async () => { profileCalls++; return gate; } }));
  const p = h.connectGmgnTradeEvents();
  try {
    await new Promise(setImmediate);
    const first = officialPumpEvent('quote-a', h.now());
    const second = officialPumpEvent('quote-b', h.now());
    await h.pumpNatsAlertEvent(first); await h.pumpNatsAlertEvent(second);
    await new Promise(setImmediate);
    const events = p.drainMessages().filter(m => m.type === 'gmgnFollowTradeEvent');
    assert.equal(events.length, 2, 'profile response must not block delivery');
    assert.equal(profileCalls, 1, 'same wallet shares the in-flight first page');
    for (const m of events) p.send({ type: 'gmgnFollowTradeAck', deliveryId: m.deliveryId,
      status: 'accepted', reason: 'ROW_RENDERED' });
    await h.runtimeContext.publishFomoRealtimeItems([{ id: 'fomo-during-quote', platform: 'fomo',
      type: 'buy', networkId: 56, createdAt: h.now(), tokenAddress: '0x' + '11'.repeat(20),
      userId: 'fomo-friend', sourceVerification: 'fomo-trading-activity-websocket' }]);
    assert.ok(p.drainMessages().some(m => m.type === 'gmgnFollowTradeEvent' && m.item.platform === 'fomo'));
    releaseProfile({ transactions: [first, second].map((event, i) => ({
      type: 'SWAP', chain: 'solana', tx_hash: event.trade.tx, block_time: h.now(),
      token_in: { mint: event.coin.mint, amount: '100' },
      token_out: { mint: pumpApi.WRAPPED_SOL_MINT, amount: String(0.15 + i), metadata: { symbol: 'SOL' } },
    })), pagination: { next_cursor: 'must-not-follow' } });
    for (let i = 0; i < 8; i++) await new Promise(setImmediate);
    const updates = p.drainMessages();
    assert.equal(updates.filter(m => m.type === 'gmgnFollowTradeEvent').length, 0);
    const metadata = updates.filter(m => m.type === 'gmgnFollowTradeMetadata');
    assert.equal(metadata.length, 2);
    assert.equal(metadata[0].item.quoteAmount, 0.15);
    assert.equal(metadata[1].item.quoteAmount, 1.15);
    assert.equal(metadata[0].item.usdAmount, first.trade.amountUsd);
    assert.equal(metadata[0].item.createdAt, Date.parse(first.createdAt));
    assert.equal(profileCalls, 1);
    await h.pumpNatsAlertEvent(first); await new Promise(setImmediate);
    assert.equal(profileCalls, 1, 'duplicate delivery cannot restart quote enrichment');
  } finally { p.disconnect(); releaseProfile({ transactions: [] }); }
});

test('Pump quote enrichment limits concurrency and queue size, and drops all results after disconnect', async () => {
  const pending = [];
  const h = createHarness(realtimePumpOptions({ publicRuntime: true,
    pumpProfilePayload: () => new Promise(resolve => pending.push(resolve)) }));
  const p = h.connectGmgnTradeEvents();
  await new Promise(setImmediate);
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  for (let i = 0; i < 80; i++) {
    h.runtimeContext.schedulePumpQuoteEnrichment({ platform: 'pump', type: 'buy', createdAt: h.now(),
      networkId: core.TOKEN_NETWORK_IDS.sol, transactionHash: `quote-${i}`,
      walletAddress: '2'.repeat(42) + alphabet[Math.floor(i / 58)] + alphabet[i % 58],
      tokenAddress: 'BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump',
      sourceVerification: pumpApi.PUMP_ALERTS_NATS_VERIFICATION });
  }
  await new Promise(setImmediate);
  assert.equal(pending.length, 2);
  assert.equal(vm.runInContext('pumpQuoteInFlight', h.runtimeContext), 2);
  assert.equal(vm.runInContext('pumpQuoteQueue.size', h.runtimeContext), 32);
  assert.ok(vm.runInContext('pumpQuoteAttempts.size', h.runtimeContext) <= 128);
  p.disconnect();
  for (const resolve of pending) resolve({ transactions: [] });
  for (let i = 0; i < 20; i++) await new Promise(setImmediate);
  assert.equal(pending.length, 2, 'queued jobs do not issue requests after disconnect');
  assert.equal(vm.runInContext('pumpQuoteInFlight', h.runtimeContext), 0);
  assert.equal(vm.runInContext('pumpQuoteQueue.size + pumpQuoteProfileRequests.size', h.runtimeContext), 0);
});

test('Pump complete quote does not fetch a profile and unrelated profile transactions cannot fill a missing quote', async () => {
  let calls = 0;
  const h = createHarness(realtimePumpOptions({ publicRuntime: true, pumpProfilePayload: () => {
    calls++; return { transactions: [{ type: 'SWAP', chain: 'solana', tx_hash: 'unrelated', block_time: h.now(),
      token_in: { mint: 'BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump', amount: 100 },
      token_out: { mint: pumpApi.WRAPPED_SOL_MINT, amount: 777, metadata: { symbol: 'SOL' } } }] };
  } }));
  const p = h.connectGmgnTradeEvents();
  try {
    await new Promise(setImmediate);
    const complete = officialPumpEvent('quote-complete', h.now());
    Object.assign(complete.trade, { quoteAmount: 0.1, quoteAddress: pumpApi.WRAPPED_SOL_MINT, quoteSymbol: 'SOL' });
    await h.pumpNatsAlertEvent(complete); await new Promise(setImmediate);
    assert.equal(calls, 0);
    await h.pumpNatsAlertEvent(officialPumpEvent('quote-missing', h.now()));
    for (let i = 0; i < 8; i++) await new Promise(setImmediate);
    assert.equal(calls, 1);
    assert.equal(p.drainMessages().filter(m => m.type === 'gmgnFollowTradeMetadata').length, 0);
  } finally { p.disconnect(); }
});
test('HyperEVM quote completion verifies the EVM profile identity and reuses the alert user lookup', async () => {
  const token = '0xf09703969cf55aa8a05ee9c76ab3013477283666';
  const tx = '0xb7d0adf6d64544ba4b0698bfba36a0c8e7935a09ce263f7e2140a7faac0d672e';
  const usdc = '0xb88339cb7199b77e23db6e890353e22632ba630f';
  for (const mismatch of [false, true]) {
    let profileCalls = 0;
    const h = createHarness(realtimePumpOptions({ publicRuntime: true, pumpUserPayload: pumpRealAlertUser,
      pumpProfilePayload: () => { profileCalls++; return { transactions: [{
        type: 'SWAP', chain: 'hyperevm', tx_hash: tx, block_time: h.now(),
        wallet_address: mismatch ? '0x' + '11'.repeat(20) : pumpRealAlertUser.canonical_evm_wallet,
        token_in: { mint: token, amount: 510197.07 },
        token_out: { mint: usdc, amount: '2049.798341', metadata: { symbol: 'USDC' } },
      }] }; } }));
    const p = h.connectGmgnTradeEvents();
    try {
      await new Promise(setImmediate);
      const event = { ...pumpRealAlert, id: 'synthetic-hyperevm-quote', chainId: 999, coinMint: token,
        createdAt: new Date(h.now()).toISOString(), coin: { mint: token, chainId: 999, symbol: 'FIXTURE' },
        trade: { ...pumpRealAlert.trade, tx } };
      assert.equal((await h.pumpNatsAlertEvent(event)).accepted, true);
      for (let i = 0; i < 10; i++) await new Promise(setImmediate);
      const messages = p.drainMessages();
      assert.equal(messages.filter(m => m.type === 'gmgnFollowTradeEvent').length, 1);
      const metadata = messages.filter(m => m.type === 'gmgnFollowTradeMetadata');
      assert.equal(metadata.length, mismatch ? 0 : 1);
      if (!mismatch) {
        assert.equal(metadata[0].item.quoteAmount, 2049.798341);
        assert.equal(metadata[0].item.quoteAddress, usdc);
        assert.equal(metadata[0].item.usdAmount, event.trade.amountUsd);
      }
      assert.equal(profileCalls, 1);
      assert.equal(h.pumpRequestMethods.filter(r => r.url.includes('/users/')).length, 1);
    } finally { p.disconnect(); }
  }
});

function pumpGapHarness(extra = {}) {
  const f = pumpSunFixture;
  return createHarness(realtimePumpOptions({ publicRuntime: true,
    pumpIdentity: { userId: 'viewer-user', viewerWallet: 'A1EbAYSRyWCUgRi3Q9iphNtRD3pAqTrm2sq79CR5J4v8' },
    pumpFollowingPayload: [{ address: f.user.canonical_svm_wallet, username: f.user.username, user_id: f.user.userId }],
    pumpUserPayload: f.user,
    pumpTradePayload: { items: [] },
    rpcPayload: (requests) => requests.map((r) => ({ jsonrpc: '2.0', id: r.id,
      result: r.params[0] === f.transaction.hash
        ? r.method === 'eth_getTransactionByHash' ? f.transaction : f.receipt
        : null })),
    ...extra,
  }));
}
async function startPumpGapHarness(h) {
  const p = h.connectGmgnTradeEvents();
  await new Promise(setImmediate);
  p.send({ type: 'gmgnFollowTradeVisibility', visible: true });
  h.runPumpReconcileTimer();
  await h.reconcilePumpAlerts();
  return p;
}

test('真实 Pump EVM Alerts 的 Solana 主页地址映射为 EVM 钱包，REST 与 NATS 只投递一次', async () => {
  let items = [];
  const h = createHarness(realtimePumpOptions({ publicRuntime: true,
    pumpUserPayload: pumpRealAlertUser, pumpTradePayload: () => ({ items }) }));
  const p = await startPumpGapHarness(h);
  try {
    h.advanceTime(30_000);
    const row = { ...pumpRealAlert, createdAt: new Date(h.now()).toISOString() };
    items = [row];
    h.runPumpReconcileTimer(); await h.reconcilePumpAlerts();
    const received = p.drainMessages();
    assert.equal(received.length, 1);
    assert.equal(received[0].item.walletAddress, pumpRealAlertUser.canonical_evm_wallet.toLowerCase());
    assert.equal(received[0].item.transactionHash, row.trade.tx);
    assert.ok(require('../src/gmgn-follow-bridge').toGmgnTrade(received[0].item));
    p.send({ type: 'gmgnFollowTradeAck', deliveryId: received[0].deliveryId, status: 'accepted', reason: 'ROW_RENDERED' });
    const event = { ...row, id: 'actual-shape-nats', coin: { mint: row.coinMint, chainId: row.chainId, symbol: row.symbol } };
    assert.equal((await h.pumpNatsAlertEvent(event)).accepted, true);
    await new Promise(setImmediate);
    assert.deepEqual(p.drainMessages(), []);
    assert.equal(h.pumpRequestMethods.filter(r => r.url.endsWith('/users/' + pumpRealAlertUser.canonical_svm_wallet)).length, 1, '跨来源共享用户映射');
    assert.equal(h.sessionData.followedTradeReceiptsV1, undefined);
  } finally { p.disconnect(); }
});

test('真实 EVM NATS 并发首条消息共享钱包查询，重复事件不重复推送', async () => {
  const h = createHarness(realtimePumpOptions({ publicRuntime: true, pumpUserPayload: pumpRealAlertUser }));
  const p = h.connectGmgnTradeEvents();
  try {
    await new Promise(setImmediate);
    const row = pumpRealAlert;
    const event = { ...row, id: 'nats-first-profile-wallet', createdAt: new Date(h.now()).toISOString(),
      coin: { mint: row.coinMint, chainId: row.chainId, symbol: row.symbol } };
    const responses = await Promise.all([h.pumpNatsAlertEvent(event), h.pumpNatsAlertEvent(event)]);
    assert.equal(responses.filter(r => r.accepted).length, 1);
    await new Promise(setImmediate);
    const received = p.drainMessages();
    assert.equal(received.length, 1);
    assert.equal(received[0].item.walletAddress, pumpRealAlertUser.canonical_evm_wallet.toLowerCase());
    assert.equal(h.pumpRequestMethods.filter(r => r.url.includes('/users/')).length, 1);
  } finally { p.disconnect(); }
});

for (const badUser of [
  { ...pumpRealAlertUser, canonical_svm_wallet: '21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm' },
  { ...pumpRealAlertUser, userId: 'wrong-user' },
  { ...pumpRealAlertUser, canonical_evm_wallet: '' },
]) {
  test(`EVM Alerts 拒绝不匹配的用户钱包映射 ${JSON.stringify(badUser)}`, async () => {
    const h = createHarness(realtimePumpOptions({ publicRuntime: true, pumpUserPayload: badUser }));
    const p = h.connectGmgnTradeEvents();
    try {
      await new Promise(setImmediate);
      const row = pumpRealAlert;
      const response = await h.pumpNatsAlertEvent({ ...row, id: 'invalid-user', createdAt: new Date(h.now()).toISOString(),
        coin: { mint: row.coinMint, chainId: row.chainId } });
      assert.equal(response.accepted, false);
      assert.deepEqual(p.drainMessages(), []);
    } finally { p.disconnect(); }
  });
}

test('0xSun RKST 真实个人动态与回执：Alerts 缺失时补推，之后 Alerts/NATS 到达仍只显示一次', async () => {
  let transactions = [];
  let alerts = [];
  const h = pumpGapHarness({ pumpProfilePayload: () => ({ transactions }), pumpTradePayload: () => ({ items: alerts }) });
  h.advanceTime(pumpSunFixture.profile.transactions[0].block_time * 1000 - h.now() - 30_000);
  const p = await startPumpGapHarness(h);
  try {
    assert.deepEqual(p.drainMessages(), []);
    h.advanceTime(30_000);
    transactions = pumpSunFixture.profile.transactions;
    h.runPumpReconcileTimer(); await h.reconcilePumpAlerts();
    const received = p.drainMessages();
    assert.equal(received.length, 1, '缺失的官方 Alerts 由个人动态和回执共同验证后补推');
    const item = received[0].item;
    assert.equal(item.transactionHash, pumpSunFixture.transaction.hash);
    assert.equal(item.walletAddress, pumpSunFixture.user.canonical_evm_wallet);
    assert.equal(item.type, 'sell');
    assert.equal(item.baseAmount, 1_500_000);
    assert.equal(item.usdAmount, 12165.521068);
    assert.equal(item.sourceVerification, pumpApi.PUMP_CHAIN_RPC_VERIFICATION);
    assert.equal(item.createdAt, pumpSunFixture.profile.transactions[0].block_time * 1000);
    assert.ok(require('../src/gmgn-follow-bridge').toGmgnTrade(item));
    p.send({ type: 'gmgnFollowTradeAck', deliveryId: received[0].deliveryId, status: 'accepted', reason: 'ROW_RENDERED' });
    const event = { id: 'sun-late-nats', kind: 'trade', createdAt: new Date(item.createdAt).toISOString(),
      author: { userId: item.userId, userName: item.displayName, walletAddress: pumpSunFixture.user.canonical_svm_wallet },
      coin: { chainId: 4663, mint: item.tokenAddress, symbol: 'RKST' },
      trade: { tx: item.transactionHash, isBuy: false, amountUsd: item.usdAmount, baseAmount: item.baseAmount } };
    assert.equal((await h.pumpNatsAlertEvent(event)).accepted, true);
    alerts = [{ ...event, chainId: 4663, coinMint: item.tokenAddress, walletAddress: event.author.walletAddress }];
    h.advanceTime(20_000); h.runPumpReconcileTimer(); await h.reconcilePumpAlerts();
    assert.deepEqual(p.drainMessages(), []);
    assert.equal(vm.runInContext('gmgnTradeDelivery.snapshot().acknowledged', h.runtimeContext), 1);
    assert.equal(h.sessionData.followedTradeReceiptsV1, undefined);
    assert.equal(vm.runInContext('tradeReceipts', h.runtimeContext), null);
    assert.equal(h.pumpRequestMethods.some(r => /coins-v3|sol-price/.test(r.url)), false);
  } finally { p.disconnect(); }
});

test('个人动态补漏忽略启动前交易，不把旧交易改时间重推', async () => {
  const h = pumpGapHarness({ pumpProfilePayload: pumpSunFixture.profile });
  h.advanceTime(pumpSunFixture.profile.transactions[0].block_time * 1000 - h.now() + 10_000);
  const p = await startPumpGapHarness(h);
  try {
    assert.deepEqual(p.drainMessages(), []);
    assert.equal(h.requestedRpcPayloads.length, 0);
  } finally { p.disconnect(); }
});

test('个人动态回执失败时不推送，后续回执可用时自动恢复', async () => {
  let transactions = [], ready = false;
  const f = pumpSunFixture;
  const h = pumpGapHarness({ pumpProfilePayload: () => ({ transactions }),
    rpcPayload: requests => requests.map(r => ({ id: r.id,
      result: !ready ? null : r.method === 'eth_getTransactionByHash' ? f.transaction : f.receipt })) });
  h.advanceTime(f.profile.transactions[0].block_time * 1000 - h.now() - 10_000);
  const p = await startPumpGapHarness(h);
  try {
    transactions = f.profile.transactions; h.advanceTime(10_000);
    h.runPumpReconcileTimer(); await h.reconcilePumpAlerts();
    assert.deepEqual(p.drainMessages(), []);
    ready = true; h.advanceTime(10_000);
    h.runPumpReconcileTimer(); await h.reconcilePumpAlerts();
    assert.equal(p.drainMessages().length, 1);
  } finally { p.disconnect(); }
});

test('个人动态查询期间关闭推送：旧响应不得投递，重启也不串入新会话', async () => {
  let release, blocked = false;
  const h = pumpGapHarness({ pumpProfilePayload: () => blocked
    ? new Promise(resolve => { release = resolve; }) : { transactions: [] } });
  h.advanceTime(pumpSunFixture.profile.transactions[0].block_time * 1000 - h.now() - 10_000);
  const p = await startPumpGapHarness(h);
  try {
    blocked = true; h.advanceTime(10_000);
    const pending = h.reconcilePumpAlerts();
    await new Promise(setImmediate);
    assert.equal(typeof release, 'function');
    await h.setFollowedTradesEnabled(false);
    const oldRelease = release;
    blocked = false;
    h.advanceTime(1_000);
    await h.setFollowedTradesEnabled(true);
    oldRelease(pumpSunFixture.profile); await pending;
    assert.deepEqual(p.drainMessages().filter(m => m.type === 'gmgnFollowTradeEvent'), []);
    assert.equal(h.requestedRpcPayloads.length, 0);
  } finally { p.disconnect(); }
});

test('Alerts 接口失败时，独立的个人动态回执补漏仍能投递', async () => {
  let transactions = [];
  const h = pumpGapHarness({ pumpStatus: 503, pumpPublicStatus: 200, pumpPresenceStatus: 200,
    pumpProfilePayload: () => ({ transactions }) });
  h.advanceTime(pumpSunFixture.profile.transactions[0].block_time * 1000 - h.now() - 10_000);
  const p = await startPumpGapHarness(h);
  try {
    transactions = pumpSunFixture.profile.transactions; h.advanceTime(10_000);
    h.runPumpReconcileTimer(); await h.reconcilePumpAlerts();
    assert.equal(p.drainMessages().filter(m => m.type === 'gmgnFollowTradeEvent').length, 1);
  } finally { p.disconnect(); }
});

test('EVM 主页钱包查询失败不会占用事件去重键，相同事件可重试', async () => {
  let ready = false;
  const h = createHarness(realtimePumpOptions({ publicRuntime: true, pumpUserPayload: () => {
    if (!ready) throw new Error('TEMPORARY_NETWORK_FAILURE');
    return pumpRealAlertUser;
  } }));
  const p = h.connectGmgnTradeEvents();
  try {
    await new Promise(setImmediate);
    const event = { ...pumpRealAlert, id: 'mapping-retry', createdAt: new Date(h.now()).toISOString(),
      coin: { mint: pumpRealAlert.coinMint, chainId: 4663 } };
    assert.equal((await h.pumpNatsAlertEvent(event)).accepted, false);
    ready = true;
    assert.equal((await h.pumpNatsAlertEvent(event)).accepted, true);
    await new Promise(setImmediate);
    assert.equal(p.drainMessages().length, 1);
  } finally { p.disconnect(); }
});

test('个人动态轮换限制为每轮 20 人，关闭后不再安排周期检查', async () => {
  const addresses = Array.from({ length: 25 }, (_, i) => '1'.repeat(31) + 'ABCDEFGHJKLMNPQRSTUVWXYZab'[i]);
  const profiles = [];
  const h = pumpGapHarness({ pumpFollowingPayload: addresses.map(address => ({ address, username: address })),
    pumpUserPayload: url => ({ canonical_svm_wallet: url.split('/').at(-1), canonical_evm_wallet: '0x' + 'ab'.repeat(20) }),
    pumpProfilePayload: url => { profiles.push(url); return { transactions: [] }; } });
  const p = await startPumpGapHarness(h);
  try {
    assert.equal(profiles.length, 20);
    h.advanceTime(30_000); h.runPumpReconcileTimer(); await h.reconcilePumpAlerts();
    assert.equal(profiles.length, 40);
    assert.equal(new Set(profiles).size, 25);
    await h.setFollowedTradesEnabled(false);
    assert.equal(h.pumpReconcileState().scheduled, false);
  } finally { p.disconnect(); }
});

test("Fomo Holders keeps 5-second live data but omits unused Feed and repeated viewer lookups", async () => {
  const h = createHarness({ initialAuthorization: "stable", responseStatus: () => 200,
    responsePayload: (url) => url.endsWith("/v2/users/current")
      ? { responseObject: { id: "viewer-user" } } : { responseObject: [] } });
  for (let i = 0; i < 12; i++) {
    if (i) h.advanceTime(5_000);
    assert.equal((await h.query(undefined, { includeFeed: false })).ok, true);
    await h.queryHolderFollowStates(i === 0);
  }
  const count = (suffix) => h.requestedUrls.filter((url) => url.endsWith(suffix)).length;
  assert.equal(count("/metadata"), 12);
  assert.equal(count("/holders"), 12);
  assert.equal(count("/feed"), 0);
  assert.equal(count("/v2/users/current"), 1);
  assert.equal(count("/followingIds"), 6);
  assert.equal(h.fomoRequestCount(), 31);
  const before = h.fomoRequestCount();
  await h.query(undefined, { includeFeed: true });
  assert.equal(h.fomoRequestCount() - before, 1, "opening Feed reuses the just-loaded holder/price data");
});

for (const status of [403, 430]) test(`Fomo ${status} pauses all REST reads and survives worker restart`, async () => {
  const h = createHarness({ initialAuthorization: "stable", responseStatus: () => status });
  await h.query();
  for (let i = 0; i < 12; i++) {
    h.advanceTime(5_000);
    await h.query(undefined, { force: true });
    await h.queryHolderFollowStates(true);
  }
  assert.equal(h.fomoRequestCount(), 3);
  assert.equal(h.createdTabCount(), 0);
  assert.equal(h.localData[SESSION_KEY].authorization, "stable");
  const restarted = createHarness({ initialAuthorization: "stable", responseStatus: () => 200,
    backoffState: h.sessionData.fomoApiBackoffV1 });
  assert.equal((await restarted.query()).error, "FOMO_ACCESS_COOLDOWN");
  assert.equal(restarted.fomoRequestCount(), 0);
});

for (const header of ["600", new Date(Date.now() + 600_000).toUTCString()]) {
  test(`Fomo honors the full Retry-After value: ${header}`, async () => {
    const h = createHarness({ initialAuthorization: "stable", responseStatus: () => 429,
      responseHeaders: { "retry-after": header } });
    await h.query();
    const delay = h.sessionData.fomoApiBackoffV1.until - h.now();
    assert.equal(delay, header === "600" ? 600_000 : Date.parse(header) - h.now());
    h.advanceTime(120_001);
    assert.equal((await h.query(undefined, { force: true })).error, "FOMO_RATE_LIMIT_BACKOFF");
    assert.equal(h.fomoRequestCount(), 3);
    h.advanceTime(480_000);
    await h.query();
    assert.equal(h.fomoRequestCount(), 6);
  });
}

test("Fomo successful endpoints do not reset repeated 429 strikes", async () => {
  const h = createHarness({ initialAuthorization: "stable",
    responseStatus: (_auth, url) => url.endsWith("/holders") ? 429 : 200 });
  await h.query();
  assert.equal(h.sessionData.fomoApiBackoffV1.until - h.now(), 15_000);
  h.advanceTime(15_001);
  await h.query();
  assert.equal(h.sessionData.fomoApiBackoffV1.until - h.now(), 30_000);
});

test("failed Fomo renewal clears only the unusable session and does not reopen a page each poll", async () => {
  const h = createHarness({ initialAuthorization: "expired", responseStatus: () => 401 });
  await h.query();
  await new Promise((resolve) => setImmediate(resolve));
  h.advanceTime(15_001);
  await new Promise((resolve) => setTimeout(resolve, 280));
  for (let i = 0; i < 3; i++) {
    h.advanceTime(5_000);
    assert.equal((await h.query()).error, "FOMO_NOT_CONNECTED");
  }
  assert.equal(h.createdTabCount(), 1);
  assert.equal(h.fomoRequestCount(), 3);
});

test("Fomo session notification and recovery share the replacement-token reads", async () => {
  const h = createHarness({ initialAuthorization: "expired", replacementAuthorization: "fresh",
    responseStatus: (auth) => auth === "fresh" ? 200 : 401 });
  await h.query();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.localData[SESSION_KEY].authorization, "fresh");
  await h.query();
  await new Promise((resolve) => setTimeout(resolve, 280));
  assert.equal(h.fomoRequestCount(), 6);
  assert.equal(h.createdTabCount(), 1);
});

test("Fomo reconnect and diagnostic catch-up share one in-flight REST request", async () => {
  const h = createHarness({ initialAuthorization: "stable", responseStatus: () => 200, responseDelayMs: 15 });
  await Promise.all([h.queryFomoRest(), h.queryFomoRest(true)]);
  assert.equal(h.requestedUrls.filter((url) => url.includes("tradingActivity")).length, 1);
});

const metadataTestItem = (i) => ({ tokenAddress: `0x${i.toString(16).padStart(40, "0")}`,
  networkId: 56, totalSupply: null, tokenImageUrl: "" });

test("Fomo batches overlapping metadata requests and briefly caches empty results", async () => {
  const h = createHarness({ initialAuthorization: "stable", responseStatus: () => 200 });
  await Promise.all(Array.from({ length: 20 }, (_, i) => h.enrichFomo([metadataTestItem(i + 1)])));
  assert.equal(h.fomoRequestCount(), 1);
  assert.equal(JSON.parse(h.fomoBodies[0]).length, 20);
  await h.enrichFomo([metadataTestItem(1)]);
  assert.equal(h.fomoRequestCount(), 1);
  h.advanceTime(15_001);
  await Promise.all([h.enrichFomo([metadataTestItem(1), metadataTestItem(2)]),
    h.enrichFomo([metadataTestItem(2), metadataTestItem(3)])]);
  assert.equal(h.fomoRequestCount(), 2);
  assert.equal(JSON.parse(h.fomoBodies[1]).length, 3);
});

test("Fomo metadata batch concurrency is bounded while every requested token completes", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = createHarness({ initialAuthorization: "stable", responseStatus: () => 200,
    responsePayload: () => gate });
  const pending = Promise.all(Array.from({ length: 130 }, (_, i) => h.enrichFomo([metadataTestItem(i + 1)])));
  await new Promise((resolve) => setTimeout(resolve, 85));
  assert.equal(h.fomoRequestCount(), 2);
  assert.ok(h.fomoBodies.every((body) => JSON.parse(body).length <= 50));
  release({ responseObject: [] });
  assert.equal((await pending).length, 130);
  assert.equal(h.fomoRequestCount(), 3);
});

test("Fomo access cooldown preserves an existing live stream but suppresses new connections", async () => {
  const h = createHarness({ initialAuthorization: "stable", responseStatus: () => 403 });
  const port = h.connectGmgnTradeEvents();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.webSockets.length, 1);
  const socket = h.webSockets[0];
  socket.open();
  socket.receive({ type: "challengeAccepted" });
  await h.query();
  socket.receive({ type: "data", topicType: "trading_activity", topicId: "viewer-user",
    payload: { id: "live-during-cooldown", platform: "fomo", type: "buy", createdAt: Date.now(),
      networkId: 56, tokenAddress: "0x7777777777777777777777777777777777777777",
      userId: "friend", baseAmount: 100, usdAmount: 25,
      totalSupply: 1000000, tokenImageUrl: "https://example.com/token.png" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(port.drainMessages().some((message) => message.item?.id === "live-during-cooldown"));
  socket.close();
  const secondPort = h.connectGmgnTradeEvents();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.webSockets.length, 1);
  port.disconnect();
  secondPort.disconnect();
});

test("disabling followed trades cancels queued Fomo metadata without losing the original items", async () => {
  const h = createHarness({ initialAuthorization: "stable", responseStatus: () => 200 });
  const item = metadataTestItem(1);
  const pending = h.enrichFomo([item]);
  await h.setFollowedTradesEnabled(false);
  assert.equal((await pending)[0].tokenAddress, item.tokenAddress);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(h.fomoRequestCount(), 0);
});

test("30 distinct token visits in 60 seconds reuse account state without suppressing new-token data", async () => {
  const h = createHarness({ initialAuthorization: "stable", responseStatus: () => 200,
    tokenAwareRequests: true, responsePayload: (url) => url.endsWith("/v2/users/current")
      ? { responseObject: { id: "viewer-user" } } : { responseObject: [] } });
  for (let i = 0; i < 30; i++) {
    if (i) h.advanceTime(2_000);
    await h.query({ address: `0x${(i + 1).toString(16).padStart(40, "0")}`, networkId: 56 },
      { includeFeed: false, force: false });
    await h.queryHolderFollowStates(false);
  }
  const count = (path) => h.requestedUrls.filter((url) => new URL(url).pathname === path).length;
  assert.equal(count("/metadata"), 30);
  assert.equal(count("/holders"), 30);
  assert.equal(count("/v2/users/current"), 1);
  assert.equal(count("/v2/users/current/followingIds"), 6);
  assert.equal(h.fomoRequestCount(), 67);
});

test("rapid A-B-A navigation reuses only fresh A data; manual refresh and expiry still fetch", async () => {
  const h = createHarness({ initialAuthorization: "stable", responseStatus: () => 200, tokenAwareRequests: true });
  const a = { address: "0x1111111111111111111111111111111111111111", networkId: 56 };
  const b = { address: "0x2222222222222222222222222222222222222222", networkId: 56 };
  for (const params of [a, b, a]) {
    h.advanceTime(100);
    await h.query(params, { includeFeed: false, force: false });
  }
  assert.equal(h.fomoRequestCount(), 4);
  await h.query(a, { includeFeed: false, force: true });
  assert.equal(h.fomoRequestCount(), 6);
  h.advanceTime(5_000);
  await h.query(a, { includeFeed: false, force: false });
  assert.equal(h.fomoRequestCount(), 8);
});


test("manual follow refresh bypasses short reads and cached failures in the public runtime", async () => {
  let followingIds = ["original"], status = 200;
  const h = createHarness({ publicRuntime: true, initialAuthorization: "stable", responseStatus: (_auth, url) => url.endsWith("/followingIds") ? status : 200,
    responsePayload: url => url.endsWith("/v2/users/current") ? { responseObject: { id: "viewer-user" } }
      : { responseObject: { followingIds: [...followingIds] } } });
  assert.deepEqual(Array.from((await h.queryHolderFollowStates()).states.fomo), ["original"]);
  followingIds = ["new-follow"];
  assert.deepEqual(Array.from((await h.queryHolderFollowStates()).states.fomo), ["original"], "automatic reads keep the snapshot");
  assert.deepEqual(Array.from((await h.queryHolderFollowStates(true)).states.fomo), ["new-follow"], "explicit refresh reaches the server within the 1-second read cache");
  status = 500;
  assert.equal((await h.queryHolderFollowStates(true)).errors.fomo, "HTTP_500");
  status = 200;
  followingIds = ["recovered"];
  assert.deepEqual(Array.from((await h.queryHolderFollowStates(true)).states.fomo), ["recovered"], "explicit refresh also bypasses cached transient failures");
  assert.equal(h.localSetCalls.some(entry => Object.keys(entry).some(key => /Diagnostic|Pipeline|Receipts/.test(key))), false);
});
