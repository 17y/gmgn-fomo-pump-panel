(function installGmgnFollowThinBridge() {
  "use strict";

  const BRIDGE_VERSION = "1.0.6";
  const MESSAGE_CHANNEL = "gmgn-follow-trade-event-v1";
  const RETRY_OFFSETS_MS = Object.freeze([0, 100, 250, 500, 1_000, 2_000, 4_000]);
  const EVENT_TTL_MS = 5_000;
  const MAX_EVENT_AGE_MS = 60_000;
  const MAX_PENDING_EVENTS = 64;
  const MAX_FLUSH_BATCH = 16;
  const HISTORY_REPLY_TIMEOUT_MS = 250;
  const SEEN_EVENT_LIMIT = 512;
  const bridge = globalThis.GmgnFollowBridge;
  // A MAIN-world bridge outlives an extension reload. Keep that document's
  // existing instance, including in-flight deliveries, until page navigation.
  // Legacy instances expose no disposer; adding another version duplicates
  // listeners and interceptors. A fresh document installs the current version.
  if (!bridge || globalThis.__gmgnFollowThinBridgeVersion) return;
  globalThis.__gmgnFollowThinBridgeVersion = BRIDGE_VERSION;

  let webpackRequire = null;
  let followWalletSocket = null;
  let decodeSubscription = null;
  const settledSounds = new Map();
  const gmgnSupplyCache = new Map();
  const gmgnSupplyRequests = new Map();
  let gmgnTokenBriefApi = null;
  let nativeSound = null;
  let nativeSoundSettings = null;
  let flushTimer = null;
  let flushScheduledAt = 0;
  const pendingEvents = new Map();
  const seenEvents = new Map();
  const webpackFactoryMatches = new WeakMap();
  const historyReplies = new Map();
  const historyByScope = new Map();
  let historySequence = 0;
  let historyAdapterInstalled = false;
  let historySetupTimer = null;
  let historySetupStartedAt = 0;

  function ownValues(value) {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return [];
    try {
      return Object.values(Object.getOwnPropertyDescriptors(value))
        .filter((descriptor) => "value" in descriptor)
        .map((descriptor) => descriptor.value);
    } catch {
      return [];
    }
  }

  function webpackFactoryMarkers(factory) {
    if (typeof factory !== "function") return "";
    if (webpackFactoryMatches.has(factory)) return webpackFactoryMatches.get(factory);
    let source = "";
    try { source = Function.prototype.toString.call(factory); } catch {}
    // Keep only discovery markers, not the full GMGN module source. Webpack
    // retains factory keys, so WeakMap alone does not release cached strings.
    const matches = ["getQuotationSocketMgr", "audio_played_uuids", "audio_channel",
      "REQUEST_TRY_PLAY", "followingType", "followingState", "notificationVolume",
      "getAxios=function", ".Network", "/api/v1/token_info_brief"].filter((marker) => source.includes(marker)).join(" ");
    webpackFactoryMatches.set(factory, matches);
    return matches;
  }

  function webpackModuleFromFactoryMarkers(markers, accepts) {
    if (typeof webpackRequire !== "function") return null;
    for (const [moduleId, factory] of Object.entries(webpackRequire.m || {})) {
      const source = webpackFactoryMarkers(factory);
      if (!markers.every((marker) => source.includes(marker))) continue;
      try {
        const value = webpackRequire(moduleId);
        if (accepts(value)) return value;
      } catch {}
    }
    return null;
  }

  function followWalletSocketFromExport(value) {
    const candidates = [value, value?.default, ...ownValues(value)];
    for (const candidate of candidates) {
      if (typeof candidate?.getQuotationSocketMgr !== "function") continue;
      try {
        const socket = candidate.getQuotationSocketMgr()?.getFollowWalletSocket?.();
        if (typeof socket?.handleData === "function"
          && typeof socket?.getFollowWalletObservable === "function") return socket;
      } catch {}
    }
    return null;
  }

  function discoverFollowWalletSocket() {
    if (followWalletSocket || typeof webpackRequire !== "function") {
      return Boolean(followWalletSocket);
    }
    for (const module of Object.values(webpackRequire.c || {})) {
      const socket = followWalletSocketFromExport(module?.exports);
      if (socket) {
        followWalletSocket = socket;
        return true;
      }
    }
    for (const [moduleId, factory] of Object.entries(webpackRequire.m || {})) {
      if (!webpackFactoryMarkers(factory).includes("getQuotationSocketMgr")) continue;
      try {
        const socket = followWalletSocketFromExport(webpackRequire(moduleId));
        if (!socket) continue;
        followWalletSocket = socket;
        return true;
      } catch {}
    }
    return false;
  }

  function discoverNativeSound() {
    if (nativeSound && nativeSoundSettings) return true;
    if (typeof webpackRequire !== "function") return false;
    const sound = nativeSound || webpackModuleFromFactoryMarkers([
      "audio_played_uuids",
      "audio_channel",
      "REQUEST_TRY_PLAY",
    ], (value) => ["AE", "Jb", "Nr", "xL"].every((key) => typeof value?.[key] === "function"));
    const settings = nativeSoundSettings || webpackModuleFromFactoryMarkers([
      "followingType",
      "followingState",
      "notificationVolume",
    ], (value) => typeof value?.CC === "function");
    if (typeof sound?.AE !== "function"
      || typeof sound?.Jb !== "function"
      || typeof sound?.Nr !== "function"
      || typeof sound?.xL !== "function"
      || typeof settings?.CC !== "function") return false;
    nativeSound = sound;
    nativeSoundSettings = settings;
    return true;
  }

  function selectedFollowingSound(chain) {
    if (!nativeSoundSettings || !chain) return { resolved: false, soundType: "" };
    try {
      const settings = nativeSoundSettings.CC(chain);
      if (settings?.followingState !== true) return { resolved: true, soundType: "" };
      const soundType = typeof settings.followingType === "string"
        ? settings.followingType.trim()
        : "";
      if (!soundType || soundType === "Off") return { resolved: true, soundType: "" };
      return { resolved: true, soundType };
    } catch {
      return { resolved: false, soundType: "" };
    }
  }

  function sendSoundToMainController(soundType, uuid) {
    if (!nativeSound?.VW || !nativeSound?.fZ?.PLAY_SOUND) return false;
    try {
      nativeSound.VW.postMessage({
        command: nativeSound.fZ.PLAY_SOUND,
        params: {
          type: "FOLLOWING",
          uuid,
          enabled: true,
          actualSoundType: soundType,
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  async function playNativeFollowingSound(row, expiresAt) {
    if (!discoverNativeSound()) return "retry";
    const selection = selectedFollowingSound(row.n);
    if (!selection.resolved) return "retry";
    if (!selection.soundType) return "disabled";
    const uuid = row.id;
    let claimed = false;
    try {
      if (!nativeSound.Jb()) {
        return sendSoundToMainController(selection.soundType, uuid) ? "played" : "retry";
      }
      if (!await nativeSound.Nr(uuid)) return "deduped";
      claimed = true;
      if (Date.now() >= expiresAt) {
        nativeSound.xL(uuid);
        return "expired";
      }
      if (await nativeSound.AE(selection.soundType)) return "played";
      nativeSound.xL(uuid);
      claimed = false;
    } catch {
      if (claimed) {
        try { nativeSound.xL(uuid); } catch {}
      }
    }
    return "retry";
  }

  function socketBlockReason(row) {
    if (!followWalletSocket) return "NATIVE_SOCKET_MISSING";
    // A chain may already be registered while its decoded stream has no
    // listener yet. Subject.next() silently discards messages in that state.
    try {
      if (followWalletSocket.statCacheData?.getDataSubject?.()?.observed === false) return "NATIVE_STREAM_UNOBSERVED";
    } catch { return "NATIVE_STREAM_ERROR"; }
    const chains = followWalletSocket.subscribedChains;
    if (!chains || typeof chains.has !== "function") return "";
    return chains.size > 0 && chains.has(row.n) ? "" : "CHAIN_NOT_SUBSCRIBED";
  }

  function socketReadyForChain(row) {
    return !socketBlockReason(row);
  }

  function acknowledge(deliveryId, status, reason = "") {
    if (typeof deliveryId !== "string" || deliveryId.length > 100) return;
    const routeChain = location.pathname?.split("/")[1] || "";
    window.postMessage({ channel: MESSAGE_CHANNEL, type: "trade-ack", deliveryId, status, reason,
      routeChain: ["eth", "bsc", "sol", "base", "robinhood", "hyperevm", "arc"].includes(routeChain) ? routeChain : "" }, location.origin);
  }

  function observeDecodedStream() {
    if (decodeSubscription || typeof followWalletSocket?.getFollowWalletShareObservable !== "function") return;
    try {
      decodeSubscription = followWalletSocket.getFollowWalletShareObservable().subscribe((rows) => {
        if (!Array.isArray(rows)) return;
        const ids = new Set(rows.map((row) => row?.id));
        for (const entry of pendingEvents.values()) {
          if (!entry.decoded && ids.has(entry.row.id)) {
            entry.decoded = true;
            acknowledge(entry.deliveryId, "decoded");
          }
        }
      });
    } catch { decodeSubscription = null; }
  }

  function releaseDecodeObserver() {
    if (pendingEvents.size) return;
    try { decodeSubscription?.unsubscribe(); } catch {}
    decodeSubscription = null;
  }

  function deliverToNativeSocket(entry) {
    if (entry.delivered && (entry.confirmed || entry.decoded || Date.now() - entry.submittedAt < 700)) return true;
    entry.blockReason = socketBlockReason(entry.row);
    if (entry.blockReason) return false;
    try {
      // The socket buffers for 200ms. Returning from handleData is not delivery.
      observeDecodedStream();
      followWalletSocket.handleData([entry.row]);
      entry.submittedAt = Date.now();
      if (!entry.delivered) acknowledge(entry.deliveryId, "submitted");
      entry.delivered = true;
      entry.metadataPending = false;
      if (entry.deliveryId) window.postMessage({ channel: MESSAGE_CHANNEL,
        type: "request-render-check", deliveryId: entry.deliveryId }, location.origin);
      return true;
    } catch {
      entry.blockReason = "NATIVE_HANDLE_DATA_THROW";
      try { decodeSubscription?.unsubscribe(); } catch {}
      decodeSubscription = null;
      followWalletSocket = null;
      return false;
    }
  }

  function markRendered(deliveryId) {
    const entry = [...pendingEvents.values()].find((entry) => entry.deliveryId === deliveryId);
    if (!entry?.delivered || entry.confirmed || Date.now() >= entry.expiresAt) return;
    entry.confirmed = true;
    if ((entry.pumpMarketPending && !entry.metadataResolved) || entry.pumpQuotePending) entry.expiresAt = entry.queuedAt + 30_000;
    acknowledge(deliveryId, "accepted", "ROW_RENDERED");
    finishResolvedEntry(entry.key, entry);
    scheduleNextRetry();
  }


  function rememberSeen(key, now = Date.now()) {
    seenEvents.delete(key);
    seenEvents.set(key, now);
    while (seenEvents.size > SEEN_EVENT_LIMIT) {
      seenEvents.delete(seenEvents.keys().next().value);
    }
  }

  function pruneSeen(now = Date.now()) {
    for (const [key, at] of seenEvents) {
      if (now - at <= MAX_EVENT_AGE_MS * 2) break;
      seenEvents.delete(key);
    }
  }

  function finishEntry(key, reason = "unavailable") {
    const entry = pendingEvents.get(key);
    pendingEvents.delete(key);
    if (entry && !entry.confirmed) acknowledge(entry.deliveryId, entry.decoded && reason === "unavailable" ? "unverified" : reason,
      entry.delivered ? (entry.decoded ? "NATIVE_DECODED_ROW_NOT_OBSERVED" : "NATIVE_ROW_NOT_OBSERVED") : entry.blockReason || "");
    if (entry?.confirmed && entry.delivered) rememberSeen(key);
    releaseDecodeObserver();
  }

  function finishResolvedEntry(key, entry) {
    if (entry.delivered && entry.confirmed && entry.soundResolved && entry.metadataResolved
      && !entry.pumpQuotePending && !entry.metadataPending) finishEntry(key);
  }

  function retryAt(entry, now) {
    const offset = RETRY_OFFSETS_MS.find((value) => value > now - entry.queuedAt);
    return offset === undefined ? entry.expiresAt : entry.queuedAt + offset;
  }

  function flushPendingEvents() {
    flushTimer = null;
    flushScheduledAt = 0;
    const now = Date.now();
    for (const [key, entry] of pendingEvents) if (entry.expiresAt <= now) finishEntry(key);
    if (!pendingEvents.size) return;
    discoverFollowWalletSocket();
    const soundReady = discoverNativeSound();
    let attempted = 0;
    for (const [key, entry] of pendingEvents) {
      if (entry.expiresAt <= now) {
        finishEntry(key);
        continue;
      }
      if (entry.nextAttemptAt > now || attempted >= MAX_FLUSH_BATCH) continue;
      attempted += 1;
      if (now >= entry.queuedAt + EVENT_TTL_MS) entry.soundResolved = true;
      const delivered = deliverToNativeSocket(entry);
      if (delivered && entry.metadataPending && socketReadyForChain(entry.row)) {
        try {
          // The native tracking store merges repeated ids. Only this already
          // delivered row is enriched; it does not enter our sound path again.
          followWalletSocket.handleData([entry.row]);
          entry.metadataPending = false;
        } catch { followWalletSocket = null; }
      }
      if (delivered && soundReady && !entry.soundResolved && !entry.soundPending) {
        // Keep retryable sound failures within this event's deadline without
        // awaiting audio in the delivery loop or re-inserting the native row.
        entry.soundPending = true;
        playNativeFollowingSound(entry.row, entry.queuedAt + EVENT_TTL_MS).catch(() => "retry").then((result) => {
          if (pendingEvents.get(key) !== entry) return;
          entry.soundPending = false;
          if (result !== "retry") {
            entry.soundResolved = true;
            settledSounds.set(key, Date.now());
            while (settledSounds.size > SEEN_EVENT_LIMIT) settledSounds.delete(settledSounds.keys().next().value);
          }
          if (Date.now() >= entry.expiresAt) finishEntry(key);
          else {
            finishResolvedEntry(key, entry);
            entry.nextAttemptAt = entry.confirmed && entry.soundResolved && !entry.metadataPending
              ? entry.expiresAt : retryAt(entry, Date.now());
          }
          scheduleNextRetry();
        });
      }
      finishResolvedEntry(key, entry);
      entry.nextAttemptAt = entry.confirmed && !entry.metadataPending
        && (entry.soundResolved || entry.soundPending) ? entry.expiresAt : retryAt(entry, now);
    }
    scheduleNextRetry();
  }

  function scheduleNextRetry() {
    if (!pendingEvents.size) {
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
      flushScheduledAt = 0;
      return;
    }
    let nextAt = Infinity;
    for (const entry of pendingEvents.values()) {
      nextAt = Math.min(nextAt, entry.nextAttemptAt, entry.expiresAt);
    }
    scheduleFlush(nextAt);
  }

  function scheduleFlush(at = Date.now()) {
    if (flushTimer !== null && flushScheduledAt <= at) return;
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushScheduledAt = at;
    flushTimer = setTimeout(flushPendingEvents, Math.max(0, at - Date.now()));
  }

  function deliveryAvatar(avatar, deliveryId) {
    if (!avatar || typeof deliveryId !== "string" || deliveryId.length > 100) return avatar;
    const clean = avatar.replace(/([#&])gmgn-follow-delivery=[^&#]*/g, "$1").replace(/[&#]$/, "");
    return `${clean}${clean.includes("#") ? "&" : "#"}gmgn-follow-delivery=${encodeURIComponent(deliveryId)}`;
  }

  function discoverGmgnTokenBriefApi() {
    if (gmgnTokenBriefApi) return gmgnTokenBriefApi;
    // Use GMGN's own API wrapper, including its session and response decoding.
    // This exact endpoint returns human-unit total_supply (do not divide it by decimals).
    const accepts = value => {
      try {
        return Object.values(value || {}).find(candidate => typeof candidate === "function"
          && /["']\/api\/v1\/token_info_brief["']/.test(Function.prototype.toString.call(candidate)));
      } catch { return null; }
    };
    const module = webpackModuleFromFactoryMarkers(["/api/v1/token_info_brief"], accepts);
    gmgnTokenBriefApi = accepts(module);
    return gmgnTokenBriefApi;
  }

  globalThis.__gmgnFollowTokenMetadata = (chain, addresses) => new Promise(resolve => {
    if (!Object.values(bridge.NETWORK_CHAINS).includes(chain) || !Array.isArray(addresses)
      || !addresses.length || addresses.length > 50
      || addresses.some(address => typeof address !== "string"
        || !(chain === "sol" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) : /^0x[0-9a-fA-F]{40}$/.test(address)))) return resolve([]);
    let subscription = null, finished = false;
    const finish = rows => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      try { subscription?.unsubscribe(); } catch {}
      resolve(rows);
    };
    const timer = setTimeout(() => finish(null), 6_000);
    try {
      const response = discoverGmgnTokenBriefApi()?.(chain, addresses);
      if (typeof response?.subscribe !== "function") return finish(null);
      subscription = response.subscribe({
        next(payload) {
          const rows = (Array.isArray(payload?.tokens) ? payload.tokens : []).filter(token => token?.chain === chain
            && typeof token.address === "string" && addresses.some(address => supplyKey(chain, address) === supplyKey(chain, token.address)));
          finish(rows.map(token => ({ chain, address: token.address,
            symbol: typeof token.symbol === "string" ? token.symbol.slice(0, 120) : "",
            name: typeof token.name === "string" ? token.name.slice(0, 120) : "",
            logo: typeof token.logo === "string" ? token.logo.slice(0, 2_048) : "",
            total_supply: bridge.finiteNumber(token.total_supply),
          })));
        },
        error: () => finish(null), complete: () => finish([]),
      });
      if (finished) subscription?.unsubscribe();
    } catch { finish(null); }
  });

  function supplyKey(chain, address) {
    return `${chain}:${chain === "sol" ? address : address.toLowerCase()}`;
  }

  function cachedGmgnSupply(chain, address) {
    const entry = gmgnSupplyCache.get(supplyKey(chain, address));
    return entry && Date.now() - entry.at < (entry.supply ? 30_000 : 3_000) ? entry : null;
  }

  function requestGmgnSupply(chain, address) {
    const cached = cachedGmgnSupply(chain, address);
    if (cached) return Promise.resolve(cached);
    const key = supplyKey(chain, address);
    if (gmgnSupplyRequests.has(key)) return gmgnSupplyRequests.get(key).promise;
    if (gmgnSupplyRequests.size >= 16) return Promise.resolve(null);
    let resolvePromise, subscription = null, timeout = null, finished = false;
    const promise = new Promise(resolve => { resolvePromise = resolve; });
    const record = { promise, cancel: () => finish(null, false) };
    function finish(supply, cache = true) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try { subscription?.unsubscribe(); } catch {}
      gmgnSupplyRequests.delete(key);
      const result = { supply, at: Date.now() };
      if (cache) {
        gmgnSupplyCache.delete(key);
        gmgnSupplyCache.set(key, result);
        while (gmgnSupplyCache.size > 256) gmgnSupplyCache.delete(gmgnSupplyCache.keys().next().value);
      }
      resolvePromise(result);
    }
    gmgnSupplyRequests.set(key, record);
    timeout = setTimeout(() => finish(null), 6_000);
    try {
      const api = discoverGmgnTokenBriefApi();
      const response = api?.(chain, [address]);
      if (typeof response?.subscribe !== "function") finish(null);
      else {
        subscription = response.subscribe({
          next(payload) {
            const token = Array.isArray(payload?.tokens) && payload.tokens.find(token => (
              token?.chain === chain && typeof token.address === "string"
              && supplyKey(chain, token.address) === key
            ));
            const supply = bridge.finiteNumber(token?.total_supply);
            finish(supply > 0 ? supply : null);
          },
          error: () => finish(null),
          complete: () => finish(null),
        });
        // Observable responses may emit synchronously (native cache hit).
        if (finished) subscription?.unsubscribe();
      }
    } catch { finish(null); }
    return promise;
  }

  function withGmgnSupply(item, metadata) {
    if (!(metadata?.supply > 0)) return item;
    const price = bridge.finiteNumber(item.priceUsdAtTrade ?? item.priceUsdSnapshot);
    return { ...item, totalSupplySnapshot: metadata.supply,
      marketCapSnapshot: price > 0 ? price * metadata.supply : item.marketCapSnapshot,
      marketSnapshotCapturedAt: metadata.at, marketSnapshotSource: "gmgn-token-info-brief" };
  }

  function completePumpMarketData(item, entry) {
    if (item.platform !== "pump" || entry.metadataResolved) return;
    requestGmgnSupply(entry.row.n, item.tokenAddress).then(metadata => {
      if (pendingEvents.get(entry.key) !== entry || Date.now() >= entry.expiresAt) return;
      updateTradeMetadata(withGmgnSupply(item, metadata));
    }).catch(() => {});
  }

  function queueTradeEvent(item, deliveryId) {
    if (item?.platform === "pump"
      && !(Number(item.totalSupplyAtTrade ?? item.totalSupplySnapshot ?? item.totalSupply) > 0)) {
      const chain = bridge.NETWORK_CHAINS[Number(item.networkId)];
      if (chain && typeof item.tokenAddress === "string") item = withGmgnSupply(item, cachedGmgnSupply(chain, item.tokenAddress));
    }
    const row = bridge.toGmgnFollowSocketTrade(item);
    const key = bridge.trackingItemKey(item);
    const timestampMs = bridge.seconds(item?.createdAt) * 1_000;
    const now = Date.now();
    pruneSeen(now);
    for (const [key, at] of settledSounds) if (now - at > MAX_EVENT_AGE_MS * 2) settledSounds.delete(key);
    if (!row || !key || !Number.isFinite(timestampMs)
      || now - timestampMs > MAX_EVENT_AGE_MS
      || timestampMs - now > 5_000) {
      acknowledge(deliveryId, row && key ? "expired" : "invalid");
      return false;
    }
    if (seenEvents.has(key) || pendingEvents.get(key)?.confirmed) {
      acknowledge(deliveryId, "accepted", "ROW_RENDERED");
      return false;
    }
    if (pendingEvents.has(key)) {
      const entry = pendingEvents.get(key);
      entry.deliveryId = deliveryId;
      entry.row.avatar = deliveryAvatar(entry.row.avatar, deliveryId);
      return false;
    }
    while (pendingEvents.size >= MAX_PENDING_EVENTS) {
      finishEntry(pendingEvents.keys().next().value, "overflow");
    }
    row.avatar = deliveryAvatar(row.avatar, deliveryId);
    pendingEvents.set(key, {
      key,
      row,
      deliveryId,
      delivered: false,
      confirmed: !deliveryId,
      decoded: false,
      submittedAt: 0,
      soundPending: false,
      soundResolved: settledSounds.has(key),
      metadataResolved: Number(row.bts) > 0 && Number(row.pu) > 0,
      metadataPending: false,
      pumpMarketPending: item.platform === "pump",
      pumpQuotePending: item.platform === "pump" && !(Number(row.qa) > 0 && row.qad),
      queuedAt: now,
      nextAttemptAt: now,
      expiresAt: now + EVENT_TTL_MS,
    });
    scheduleFlush();
    completePumpMarketData(item, pendingEvents.get(key));
    return true;
  }

  function updateTradeMetadata(item) {
    const key = bridge.trackingItemKey(item);
    const entry = pendingEvents.get(key);
    if (!entry || Date.now() >= entry.expiresAt) return false;
    const row = bridge.toGmgnFollowSocketTrade(item);
    if (!row || row.id !== entry.row.id) return false;
    const fillMarket = !entry.metadataResolved && Number(row.bts) > 0 && Number(row.pu) > 0;
    const fillQuote = item.platform === "pump" && entry.pumpQuotePending && Number(row.qa) > 0 && row.qad;
    if (!fillMarket && !fillQuote) return false;
    entry.row = {
      ...entry.row,
      bs: entry.row.bs || row.bs,
      bn: entry.row.bn || row.bn,
      bl: entry.row.bl || row.bl,
      ...(fillMarket ? {
        bts: row.bts,
        pu: Number(entry.row.pu) > 0 ? entry.row.pu : row.pu,
        bp: Number(entry.row.bp) > 0 ? entry.row.bp : row.bp,
      } : {}),
      ...(fillQuote ? { qa: row.qa, qad: row.qad, qs: row.qs } : {}),
    };
    if (fillMarket) entry.metadataResolved = true;
    if (fillQuote) entry.pumpQuotePending = false;
    entry.metadataPending = entry.delivered;
    entry.nextAttemptAt = Date.now();
    scheduleFlush();
    return true;
  }

  function receiveTradeEvent(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.channel !== MESSAGE_CHANNEL) return;
    if (event.data?.type === "trade-rendered") {
      if (typeof event.data.deliveryId === "string" && event.data.deliveryId.length <= 100) markRendered(event.data.deliveryId);
      return;
    }
    if (["trade-reset", "trade-cancel"].includes(event.data?.type)) {
      for (const [key, entry] of pendingEvents) {
        if (event.data.type === "trade-reset" || entry.deliveryId === event.data.deliveryId) {
          entry.expiresAt = 0;
          pendingEvents.delete(key);
        }
      }
      if (event.data.type === "trade-reset") {
        for (const request of gmgnSupplyRequests.values()) request.cancel();
      }
      releaseDecodeObserver();
      if (!pendingEvents.size && flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
      return;
    }
    if (event.data?.type === "recent-trades") {
      const reply = historyReplies.get(event.data.requestId);
      if (reply && Array.isArray(event.data.items)) reply(event.data.items.slice(0, 30));
      return;
    }
    if (event.data?.type === "trade-metadata") {
      updateTradeMetadata(event.data.item);
      return;
    }
    if (event.data?.type !== "trade") return;
    queueTradeEvent(event.data.item, event.data.deliveryId);
  }

  function requestRecentTrades(request) {
    const chains = [...request.chains].sort();
    const scope = chains.join(",");
    if (historyByScope.has(scope)) return historyByScope.get(scope);
    if (historyReplies.size >= 4) return Promise.resolve([]);
    const requestId = `recent-${++historySequence}`;
    const pending = new Promise((resolve) => {
      const finish = (items) => {
        clearTimeout(timer);
        historyReplies.delete(requestId);
        resolve(items);
      };
      const timer = setTimeout(() => finish([]), HISTORY_REPLY_TIMEOUT_MS);
      historyReplies.set(requestId, finish);
      try {
        window.postMessage({ channel: MESSAGE_CHANNEL, type: "request-recent-trades", requestId, chains }, location.origin);
      } catch { finish([]); }
    });
    historyByScope.set(scope, pending);
    pending.finally(() => historyByScope.delete(scope));
    return pending;
  }

  function networkExport(value) {
    for (const candidate of [value, value?.default]) {
      try {
        if (typeof candidate?.Network?.getAxios === "function") return candidate.Network;
      } catch {}
    }
    return null;
  }

  function installHistoryAdapter() {
    if (historyAdapterInstalled || typeof webpackRequire !== "function") return historyAdapterInstalled;
    let network = null;
    for (const module of Object.values(webpackRequire.c || {})) {
      network = networkExport(module?.exports);
      if (network) break;
    }
    if (!network) {
      for (const [id, factory] of Object.entries(webpackRequire.m || {})) {
        const source = webpackFactoryMarkers(factory);
        if (!source.includes("getAxios=function") || !source.includes(".Network")) continue;
        try { network = networkExport(webpackRequire(id)); } catch {}
        if (network) break;
      }
    }
    try {
      const axios = network?.getAxios();
      if (typeof axios?.interceptors?.response?.use !== "function") return false;
      axios.interceptors.response.use((response) => {
        const rawUrl = response?.config?.url;
        // All unrelated requests return their original object synchronously.
        if (typeof rawUrl !== "string" || !rawUrl.includes("follow_wallet_trade_list")) return response;
        let request;
        try { request = bridge.trackingRequest(axios.getUri(response.config)); } catch { return response; }
        if (!request) return response;
        return requestRecentTrades(request).then((items) => {
          const data = bridge.mergeRecentTrackingPayload(response.data, request, bridge.recentTrackingItems(items));
          return data === response.data ? response : { ...response, data };
        }).catch(() => response);
      });
      historyAdapterInstalled = true;
      return true;
    } catch { return false; }
  }

  function setupHistoryAdapter() {
    historySetupTimer = null;
    if (installHistoryAdapter()) return;
    if (!historySetupStartedAt) historySetupStartedAt = Date.now();
    const elapsed = Date.now() - historySetupStartedAt;
    const offset = RETRY_OFFSETS_MS.find((value) => value > elapsed);
    if (offset !== undefined) historySetupTimer = setTimeout(setupHistoryAdapter, offset - elapsed);
  }

  function captureWebpackRuntime() {
    const chunks = globalThis.webpackChunk_N_E = globalThis.webpackChunk_N_E || [];
    try {
      chunks.push([[`gmgn-follow-thin-bridge-${BRIDGE_VERSION}`], {}, (runtime) => {
        webpackRequire = runtime;
        if (historySetupTimer !== null) clearTimeout(historySetupTimer);
        setupHistoryAdapter();
        if (pendingEvents.size) scheduleFlush();
      }]);
    } catch {}
  }

  window.addEventListener("message", receiveTradeEvent);
  captureWebpackRuntime();
})();
