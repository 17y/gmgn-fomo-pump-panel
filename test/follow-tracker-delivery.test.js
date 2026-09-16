const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const bridge = require("../src/gmgn-follow-bridge");

function eventTarget(properties = {}) {
  const listeners = new Map();
  return Object.assign(properties, {
    addEventListener(type, listener) {
      const current = listeners.get(type) || [];
      current.push(listener);
      listeners.set(type, current);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener.call(this, event);
    },
  });
}

function trade(overrides = {}) {
  return {
    id: "fomo-live-1",
    platform: "fomo",
    type: "buy",
    createdAt: Date.now(),
    tokenAddress: "0x1111111111111111111111111111111111111111",
    networkId: 56,
    transactionHash: `0x${"ab".repeat(32)}`,
    walletAddress: "0x2222222222222222222222222222222222222222",
    displayName: "Alice",
    tokenSymbol: "LIVE",
    usdAmount: 50,
    baseAmount: 100_000,
    quoteAmount: 0.25,
    quoteAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    quoteSymbol: "WBNB",
    priceUsdAtTrade: 0.0005,
    totalSupply: 1_000_000_000,
    ...overrides,
  };
}

function mainBridgeHarness(options = {}) {
  const rows = [];
  const receipts = [];
  const sounds = [];
  const soundAttempts = [];
  const claims = new Set();
  const subscribedChains = new Set(options.subscribedChains || ["bsc"]);
  const socket = {
    subscribedChains,
    statCacheData: { getDataSubject: () => ({ observed: options.observed !== false }) },
    handleData(value) { rows.push(...value); },
    getFollowWalletObservable() { return { subscribe() {} }; },
  };
  const factories = {
    unrelatedSettings(_module, exports) {
      void "followingType followingState notificationVolume";
      exports.a = {};
    },
    sound(_module, exports) {
      void "audio_played_uuids audio_channel REQUEST_TRY_PLAY";
      exports.AE = async (soundType) => {
        soundAttempts.push(soundType);
        if (options.soundFails) return false;
        sounds.push(soundType);
        return true;
      };
      exports.Jb = () => true;
      exports.Nr = async (uuid) => {
        if (options.soundHangs) return new Promise(() => {});
        if (options.soundClaim && !await options.soundClaim(uuid)) return false;
        if (claims.has(uuid)) return false;
        claims.add(uuid);
        return true;
      };
      exports.xL = (uuid) => claims.delete(uuid);
      exports.fZ = { PLAY_SOUND: "playSound" };
      exports.VW = { postMessage() {} };
    },
    settings(_module, exports) {
      void "followingType followingState notificationVolume";
      exports.CC = () => ({
        followingState: options.soundEnabled !== false,
        followingType: options.soundType || "Cheer",
      });
    },
  };
  if (options.tokenBrief) factories.tokenBrief = (_module, exports) => {
    void "/api/v1/token_info_brief";
    exports.brief = function(chain, addresses) {
      void "/api/v1/token_info_brief";
      return options.tokenBrief(chain, addresses);
    };
  };

  const cache = {
    quotation: {
      exports: {
        getQuotationSocketMgr() {
          return { getFollowWalletSocket: () => socket };
        },
      },
    },
  };
  function webpackRequire(id) {
    if (cache[id]) return cache[id].exports;
    const module = { exports: {} };
    cache[id] = module;
    factories[id](module, module.exports, webpackRequire);
    return module.exports;
  }
  webpackRequire.m = factories;
  webpackRequire.c = cache;

  const window = eventTarget();
  window.postMessage = options.postMessage || ((message) => receipts.push(message));
  if (!options.noNetwork) cache.network = { exports: { Network: { getAxios: () => options.axios || {
    interceptors: { response: { use() {} } },
  } } } };
  const context = vm.createContext({
    GmgnFollowBridge: bridge,
    window,
    location: { origin: "https://gmgn.ai" },
    Date: options.clock?.Date || Date,
    URL,
    Object,
    Function,
    Map,
    Set,
    WeakMap,
    Number,
    String,
    Array,
    Math,
    setTimeout: options.clock?.setTimeout || setTimeout,
    clearTimeout: options.clock?.clearTimeout || clearTimeout,
    webpackChunk_N_E: {
      push(chunk) { chunk[2]?.(webpackRequire); },
    },
  });
  vm.runInContext(fs.readFileSync("src/follow-tracker-main.js", "utf8"), context);

  function emit(item, type = "trade", deliveryId) {
    window.dispatchEvent({
      type: "message",
      source: window,
      origin: "https://gmgn.ai",
      data: { channel: "gmgn-follow-trade-event-v1", type, item, deliveryId },
    });
  }
  return { context, emit, rows, sounds, soundAttempts, claims, subscribedChains, socket, receipts };
}

test("MAIN 薄桥对一条来源事件只调用一次原生列表和一次原生声音", async () => {
  const harness = mainBridgeHarness();
  const item = trade();
  harness.emit(item);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.rows.length, 1);
  assert.equal(harness.rows[0].id, `external:${bridge.trackingItemKey(item)}`);
  assert.equal(harness.rows[0].m, item.walletAddress);
  assert.deepEqual(harness.sounds, ["Cheer"]);

  harness.emit(item);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.rows.length, 1, "重复来源事件不得再次进入 handleData");
  assert.deepEqual(harness.sounds, ["Cheer"], "重复来源事件不得再次发声");
});

test("Pump 两种来源经过 MAIN 后只新增一行并发声一次", async () => {
  const h = mainBridgeHarness({ subscribedChains: ["sol"] });
  const item = trade({ platform: "pump", networkId: 1399811149,
    transactionHash: "PumpSignature", walletAddress: "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm",
    tokenAddress: "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump", sourceVerification: "pump-alerts-rest" });
  h.emit(item);
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.emit({ ...item, pumpEventId: "official-event", sourceVerification: "pump-alerts-nats" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].m, item.walletAddress);
  assert.deepEqual(h.sounds, ["Cheer"]);
});

test("页面仅在连接和真实可见性变化时上报，无空闲计时器或 DOM 扫描", () => {
  const messages = [];
  const document = eventTarget({ visibilityState: "hidden", querySelectorAll() { assert.fail("不得扫描 DOM"); } });
  const context = vm.createContext({ document, window: eventTarget(), location: { origin: "https://gmgn.ai" },
    chrome: { runtime: { getURL: (p) => p, onMessage: { addListener() {} }, connect: () => ({
      postMessage: (m) => messages.push(m), onMessage: { addListener() {} }, onDisconnect: { addListener() {} },
    }) } }, setTimeout() { assert.fail("空闲时不得启动计时器"); } });
  vm.runInContext(fs.readFileSync("src/follow-tracker.js", "utf8"), context);
  document.visibilityState = "visible";
  document.dispatchEvent({ type: "visibilitychange" });
  document.visibilityState = "hidden";
  document.dispatchEvent({ type: "visibilitychange" });
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [false, true, false].map((visible) => ({
    type: "gmgnFollowTradeVisibility", visible,
  })));
});

test("订阅链尚未就绪时只做事件触发的短重试，就绪后交付一次", async () => {
  const harness = mainBridgeHarness({ subscribedChains: [] });
  harness.emit(trade({ id: "late-chain", transactionHash: `0x${"cd".repeat(32)}` }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(harness.rows.length, 0);
  harness.subscribedChains.add("bsc");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(harness.rows.length, 1);
  assert.deepEqual(harness.sounds, ["Cheer"]);
});

test("GMGN 全局 following 声音关闭时仍写列表但不播放任何声音", async () => {
  const harness = mainBridgeHarness({ soundEnabled: false });
  harness.emit(trade({ id: "silent", transactionHash: `0x${"ef".repeat(32)}` }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.rows.length, 1);
  assert.deepEqual(harness.sounds, []);
});

test("声音查找跳过包含相同设置字段但没有原生接口的模块", async () => {
  const clock = fakeClock();
  const harness = mainBridgeHarness({ clock });
  harness.emit(trade());
  await clock.advance(0);
  assert.deepEqual(harness.sounds, ["Cheer"]);
  assert.equal(clock.pending, 0);
});

test("市值元数据只更新已发送的同一条记录，不重复声音或重写成交字段", async () => {
  const clock = fakeClock();
  const harness = mainBridgeHarness({ clock });
  const item = trade({ totalSupply: null, tokenSymbol: "" });
  harness.emit(item);
  await clock.advance(0);
  assert.equal(harness.rows.length, 1);
  assert.equal(harness.rows[0].bts, undefined);
  assert.equal(harness.sounds.length, 1);
  const enriched = { ...item, totalSupply: 1_000_000_000, tokenSymbol: "LIVE", usdAmount: 999, createdAt: item.createdAt + 1000 };
  harness.emit(enriched, "trade-metadata");
  await clock.advance(0);
  assert.equal(harness.rows.length, 2, "第二次是相同 id 的原生更新");
  assert.equal(new Set(harness.rows.map((row) => row.id)).size, 1);
  assert.equal(harness.rows[1].bts, "1000000000");
  assert.equal(harness.rows[1].bs, "LIVE");
  assert.equal(harness.rows[1].au, item.usdAmount);
  assert.equal(harness.rows[1].ts, Math.floor(item.createdAt / 1000));
  assert.equal(harness.sounds.length, 1);
  harness.emit(enriched, "trade-metadata");
  harness.emit(trade({ transactionHash: `0x${"ef".repeat(32)}` }), "trade-metadata");
  await clock.advance(5000);
  assert.equal(harness.rows.length, 2, "重复和未发送过的元数据不能产生额外更新");
  assert.equal(clock.pending, 0);
});

test("列表未就绪时市值并入待发记录，过期元数据不会补发新交易", async () => {
  const clock = fakeClock();
  const harness = mainBridgeHarness({ clock, subscribedChains: [] });
  const item = trade({ totalSupply: null });
  harness.emit(item);
  await clock.advance(0);
  harness.emit({ ...item, totalSupply: 1_000_000_000 }, "trade-metadata");
  harness.subscribedChains.add("bsc");
  await clock.advance(0);
  assert.equal(harness.rows.length, 1);
  assert.equal(harness.rows[0].bts, "1000000000");
  const missing = trade({ totalSupply: null, transactionHash: `0x${"ef".repeat(32)}` });
  harness.emit(missing);
  await clock.advance(5000);
  harness.emit({ ...missing, totalSupply: 1_000_000_000 }, "trade-metadata");
  await clock.advance(0);
  assert.equal(harness.rows.length, 2);
  assert.equal(clock.pending, 0);
});

test("过期、跨源伪造和缺字段事件静默失败", async () => {
  const harness = mainBridgeHarness();
  harness.emit(trade({ createdAt: Date.now() - 61_000 }));
  harness.emit(trade({ walletAddress: "" }));
  harness.context.window.dispatchEvent({
    type: "message",
    source: {},
    origin: "https://gmgn.ai",
    data: { channel: "gmgn-follow-trade-event-v1", type: "trade", item: trade() },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.rows.length, 0);
  assert.deepEqual(harness.sounds, []);
});

test("isolated relay 只转发后台单事件并附加平台 Logo 资源", () => {
  const portMessageListeners = [];
  const portDisconnectListeners = [];
  const runtimeMessageListeners = [];
  const posted = [];
  const port = {
    onMessage: { addListener(listener) { portMessageListeners.push(listener); } },
    onDisconnect: { addListener(listener) { portDisconnectListeners.push(listener); } },
  };
  const connections = [];
  const backgroundRequests = [];
  port.postMessage = (message) => backgroundRequests.push(message);
  const window = eventTarget({
    postMessage(message, origin) { posted.push({ message, origin }); },
  });
  const context = vm.createContext({
    window,
    location: { origin: "https://gmgn.ai" },
    chrome: {
      runtime: {
        getURL(path) { return `chrome-extension://test/${path}`; },
        connect(details) { connections.push(details); return port; },
        onMessage: { addListener(listener) { runtimeMessageListeners.push(listener); } },
      },
    },
    setTimeout,
  });
  vm.runInContext(fs.readFileSync("src/follow-tracker.js", "utf8"), context);
  assert.deepEqual(JSON.parse(JSON.stringify(connections)), [{ name: "gmgnFollowTradeEvents" }]);

  portMessageListeners[0]({ type: "gmgnFollowTradeEvent", item: trade() });
  portMessageListeners[0]({ type: "followedTradesSnapshot", response: { items: [trade()] } });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].origin, "https://gmgn.ai");
  assert.equal(posted[0].message.type, "trade");
  assert.equal(posted[0].message.item.platformLogoUrl, "https://fomo.family/logo.png");
  portMessageListeners[0]({ type: "gmgnFollowTradeMetadata", item: trade() });
  assert.equal(posted[1].message.type, "trade-metadata");
  assert.equal(posted[1].message.item.platformLogoUrl, "https://fomo.family/logo.png");

  const historyRequest = { type: "message", source: window, origin: "https://gmgn.ai",
    data: { channel: "gmgn-follow-trade-event-v1", type: "request-recent-trades", requestId: "recent-1", chains: ["bsc"] } };
  window.dispatchEvent({ ...historyRequest, origin: "https://example.com" });
  assert.equal(backgroundRequests.length, 0);
  window.dispatchEvent(historyRequest);
  assert.equal(backgroundRequests[0].type, "getGmgnRecentTrades");
  portMessageListeners[0]({ type: "gmgnRecentTrades", requestId: "recent-1", items: [trade()] });
  assert.equal(posted[2].message.type, "recent-trades");
  assert.equal(posted[2].message.item, undefined);
  assert.equal(posted[2].message.items[0].platformLogoUrl, "https://fomo.family/logo.png");

  let ping;
  runtimeMessageListeners[0]({ type: "gmgnFollowTradeRelayPing" }, {}, (value) => { ping = value; });
  assert.deepEqual(JSON.parse(JSON.stringify(ping)), {
    ok: true,
    mode: "event-only",
    version: JSON.parse(fs.readFileSync("manifest.json", "utf8")).version,
  });
});

test("平台 Logo DOM 定位只由新事件触发，突发事件合并为四个有界批次", () => {
  const portMessageListeners = [];
  const timers = [];
  const appended = [];
  const attributes = new Map();
  const imageHost = {
    tagName: "DIV",
    children: [],
    contains(value) { return value === this; },
    parentElement: null,
  };
  const nameHost = {
    textContent: "Alice",
    children: [],
    contains() { return false; },
    setAttribute(name, value) { attributes.set(name, value); },
    parentElement: null,
  };
  const row = {
    children: [imageHost, nameHost],
    parentElement: null,
  };
  imageHost.parentElement = row;
  nameHost.parentElement = row;
  const image = {
    getAttribute(name) {
      return name === "src"
        ? "https://example.com/alice.png#gmgn-follow-source=fomo&gmgn-follow-name=Alice"
        : "";
    },
    currentSrc: "",
    src: "",
    parentElement: imageHost,
  };
  let queryCount = 0;
  const documentElement = { append(element) { appended.push(element); } };
  const document = {
    visibilityState: "visible",
    body: {},
    documentElement,
    querySelectorAll(selector) {
      queryCount += 1;
      assert.equal(selector, 'img[src*="gmgn-follow-source"]');
      return [image];
    },
    getElementById() { return null; },
    createElement(tagName) { return { tagName, id: "", textContent: "" }; },
  };
  const port = {
    onMessage: { addListener(listener) { portMessageListeners.push(listener); } },
    onDisconnect: { addListener() {} },
  };
  const context = vm.createContext({
    document,
    window: { postMessage() {}, addEventListener() {} },
    location: { origin: "https://gmgn.ai" },
    chrome: {
      runtime: {
        getURL(path) { return `chrome-extension://test/${path}`; },
        connect() { return port; },
        onMessage: { addListener() {} },
      },
    },
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
  });
  vm.runInContext(fs.readFileSync("src/follow-tracker.js", "utf8"), context);

  assert.equal(queryCount, 0);
  portMessageListeners[0]({ type: "gmgnFollowTradeEvent", item: trade() });
  portMessageListeners[0]({ type: "gmgnFollowTradeEvent", item: trade({ id: "trade-2" }) });
  assert.deepEqual(timers.map(({ delay }) => delay), [80, 250, 700, 1_400]);
  assert.equal(queryCount, 0);

  timers[0].callback();
  assert.equal(queryCount, 1);
  assert.equal(attributes.get("data-gmgn-follow-platform"), "fomo");
  assert.equal(appended.length, 1);
});

test("GMGN 页面脚本不含空闲热路径和非原生声音 fallback", () => {
  const relay = fs.readFileSync("src/follow-tracker.js", "utf8");
  const main = fs.readFileSync("src/follow-tracker-main.js", "utf8");
  const combined = `${relay}\n${main}`;
  assert.doesNotMatch(combined, /setInterval|MutationObserver/);
  assert.doesNotMatch(combined, /XMLHttpRequest|QueryCache|createOscillator|AudioContext/);
  assert.doesNotMatch(combined, /new Event\(["'](?:focus|visibilitychange)/);
  assert.doesNotMatch(combined, /gmgn-followed-trades-data|followedTradesSnapshot/);
  assert.match(main, /RETRY_OFFSETS_MS = Object\.freeze\(\[0, 100, 250, 500, 1_000, 2_000, 4_000\]\)/);
  assert.match(main, /MAX_PENDING_EVENTS = 64/);
  assert.match(relay, /PLATFORM_DECORATION_DELAYS_MS = Object\.freeze\(\[80, 250, 700, 1_400\]\)/);
});

function fakeClock() {
  let now = Date.now();
  let sequence = 0;
  let runs = 0;
  const timers = new Map();
  return {
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay = 0) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    get pending() { return timers.size; },
    get runs() { return runs; },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        assert.ok(++runs < 1000, "定时器不能形成无界循环");
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      }
      now = end;
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    },
  };
}

test("50 条突发事件分段交付，声音仲裁挂起也不阻塞后续交易", async () => {
  const clock = fakeClock();
  const harness = mainBridgeHarness({ clock, soundHangs: true });
  for (let index = 0; index < 50; index++) harness.emit(trade({
    transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
  }));
  assert.equal(clock.pending, 1, "整批交易共用一个调度器");
  await clock.advance(0);
  assert.equal(harness.rows.length, 50);
  assert.equal(new Set(harness.rows.map((row) => row.id)).size, 50);
  assert.equal(clock.runs, 4, "每轮最多处理 16 条");
  assert.equal(clock.pending, 1, "只保留同一个有期限的重试调度器");
  await clock.advance(5000);
  assert.equal(clock.pending, 0);
  const finishedRuns = clock.runs;
  await clock.advance(60_000);
  assert.equal(clock.runs, finishedRuns, "结束后没有空闲任务");
});

test("原生声音暂时失败后独立重试，列表不重插且不阻塞后续消息", async () => {
  const clock = fakeClock();
  const options = { clock, soundFails: true };
  const harness = mainBridgeHarness(options);
  harness.emit(trade());
  harness.emit(trade({ transactionHash: `0x${"cd".repeat(32)}` }));
  await clock.advance(0);
  assert.equal(harness.rows.length, 2);
  assert.equal(harness.soundAttempts.length, 2);
  assert.equal(harness.sounds.length, 0);
  options.soundFails = false;
  await clock.advance(100);
  assert.equal(harness.rows.length, 2);
  assert.equal(harness.sounds.length, 2);
  assert.equal(clock.pending, 0);
  const finishedRuns = clock.runs;
  await clock.advance(60_000);
  assert.equal(clock.runs, finishedRuns);
  assert.equal(harness.sounds.length, 2);
});

test("持续声音失败在五秒内停止，过期后完成的仲裁不会迟到播放", async () => {
  const clock = fakeClock();
  const failed = mainBridgeHarness({ clock, soundFails: true });
  failed.emit(trade());
  await clock.advance(5000);
  assert.equal(failed.rows.length, 1);
  assert.equal(failed.soundAttempts.length, 7);
  assert.equal(clock.pending, 0);
  let resolveClaim;
  const late = mainBridgeHarness({ clock, soundClaim: () => new Promise((resolve) => { resolveClaim = resolve; }) });
  late.emit(trade({ createdAt: clock.Date.now() }));
  await clock.advance(5000);
  assert.equal(late.rows.length, 1);
  resolveClaim(true);
  await clock.advance(0);
  assert.equal(late.soundAttempts.length, 0);
  assert.equal(late.claims.size, 0);
  assert.equal(clock.pending, 0);
});

test("1.25 秒后就绪的链仍能交付，最终失败的消息不会误记为已成功", async () => {
  const clock = fakeClock();
  const harness = mainBridgeHarness({ clock, subscribedChains: [] });
  const item = trade();
  harness.emit(item);
  await clock.advance(1250);
  harness.subscribedChains.add("bsc");
  await clock.advance(750);
  assert.equal(harness.rows.length, 1);
  assert.equal(clock.pending, 0);
  harness.subscribedChains.clear();
  const second = trade({ transactionHash: `0x${"cd".repeat(32)}`, createdAt: clock.Date.now() });
  harness.emit(second);
  await clock.advance(5000);
  assert.equal(clock.pending, 0);
  harness.subscribedChains.add("bsc");
  harness.emit(second);
  await clock.advance(0);
  assert.equal(harness.rows.length, 2);
});

test("链已登记但原生流还没有监听者时保留消息", async () => {
  const clock = fakeClock();
  const options = { clock, observed: false };
  const harness = mainBridgeHarness(options);
  harness.emit(trade());
  await clock.advance(250);
  assert.equal(harness.rows.length, 0);
  options.observed = true;
  await clock.advance(250);
  assert.equal(harness.rows.length, 1);
});

test("历史只在精确追踪响应触发并在 250ms 内退出，不进入 Socket 或声音", async () => {
  const clock = fakeClock();
  let interceptor;
  const requests = [];
  const axios = {
    getUri: (config) => config.url,
    interceptors: { response: { use(fn) { interceptor = fn; } } },
  };
  const harness = mainBridgeHarness({ clock, axios, postMessage: (message) => requests.push(message) });
  assert.equal(clock.pending, 0, "初始化成功后不保留发现定时器");
  const unrelated = { config: { url: "/vas/api/v1/rank/hot_trades?chain=bsc" }, data: { list: [] } };
  assert.equal(interceptor(unrelated), unrelated);
  assert.equal(requests.length, 0);
  const response = { config: { url: "/vas/api/v1/follow/follow_wallet_trade_list?chain=bsc" }, data: { list: [
    { id: "native", timestamp: Math.trunc(clock.Date.now() / 1000) - 100 },
  ] } };
  const pending = interceptor(response);
  assert.equal(requests.length, 1);
  harness.context.window.dispatchEvent({ type: "message", source: harness.context.window,
    origin: "https://gmgn.ai", data: { channel: "gmgn-follow-trade-event-v1", type: "recent-trades",
      requestId: requests[0].requestId, items: [trade()] } });
  const result = await pending;
  assert.equal(result.data.list.length, 2);
  assert.equal(harness.rows.length, 0);
  assert.equal(harness.sounds.length, 0);
  assert.equal(clock.pending, 0);
  const timeout = interceptor(response);
  await clock.advance(250);
  assert.equal(await timeout, response);
  assert.equal(clock.pending, 0);
  harness.emit(trade());
  await clock.advance(0);
  const disabled = interceptor(response);
  harness.context.window.dispatchEvent({ type: "message", source: harness.context.window,
    origin: "https://gmgn.ai", data: { channel: "gmgn-follow-trade-event-v1", type: "recent-trades",
      requestId: requests.at(-1).requestId, items: [] } });
  assert.equal(await disabled, response, "禁用或空缓存回复不能复用页面旧消息回填");
});

test("原生网络模块不可用时初始化重试有界，之后空闲 60 秒无额外工作", async () => {
  const clock = fakeClock();
  mainBridgeHarness({ clock, noNetwork: true });
  await clock.advance(5000);
  assert.equal(clock.pending, 0);
  const runs = clock.runs;
  await clock.advance(60_000);
  assert.equal(clock.runs, runs);
  assert.ok(runs <= 6);
});

test("并发历史请求复用同链读取且至多四个等待，迟到回复不改列表", async () => {
  const clock = fakeClock();
  const requests = [];
  let interceptor;
  const harness = mainBridgeHarness({ clock, postMessage: (message) => requests.push(message), axios: {
    getUri: (config) => config.url, interceptors: { response: { use(fn) { interceptor = fn; } } },
  } });
  const responses = ["bsc", "bsc", "bsc", "eth", "sol", "base", "arbitrum"].map((chain) => ({
    config: { url: `/vas/api/v1/follow/follow_wallet_trade_list?chain=${chain}` },
    data: { list: [{ id: "native", timestamp: Math.floor(clock.Date.now() / 1000) - 100 }] },
  }));
  const pending = responses.map(interceptor);
  assert.equal(requests.length, 4);
  assert.equal(clock.pending, 4);
  await clock.advance(250);
  const results = await Promise.all(pending);
  results.forEach((result, index) => assert.equal(result, responses[index]));
  harness.context.window.dispatchEvent({ type: "message", source: harness.context.window,
    origin: "https://gmgn.ai", data: { channel: "gmgn-follow-trade-event-v1", type: "recent-trades",
      requestId: requests[0].requestId, items: [trade()] } });
  assert.equal(clock.pending, 0);
  assert.equal(harness.rows.length, 0);
});

test("入口回执不确认成功，渲染回执后才确认且重发不重复列表或声音", async () => {
  const clock = fakeClock();
  const h = mainBridgeHarness({ clock });
  const item = trade();
  h.emit(item, "trade", "ticket-a");
  assert.equal(h.receipts.length, 0);
  await clock.advance(0);
  assert.equal(h.receipts[0].status, "submitted");
  assert.equal(h.receipts.some((r) => r.status === "accepted"), false);
  renderReceipt(h, "ticket-a");
  assert.equal(h.receipts.find((r) => r.status === "accepted").reason, "ROW_RENDERED");
  assert.equal(h.receipts[0].deliveryId, "ticket-a");
  h.emit(item, "trade", "ticket-a");
  await clock.advance(0);
  assert.equal(h.rows.length, 1);
  assert.equal(h.sounds.length, 1);
  assert.equal(h.receipts.filter((r) => r.status === "accepted").length, 2);
});

test("页面过期返回不可用，后台下一次重试可恢复；关闭推送撤销待插入", async () => {
  const clock = fakeClock();
  const h = mainBridgeHarness({ clock, subscribedChains: [] });
  const item = trade();
  h.emit(item, "trade", "ticket-b");
  await clock.advance(5000);
  assert.equal(h.rows.length, 0);
  assert.equal(h.receipts.at(-1).status, "unavailable");
  assert.equal(h.receipts.at(-1).reason, "CHAIN_NOT_SUBSCRIBED");
  h.subscribedChains.add("bsc");
  h.emit(item, "trade", "ticket-b");
  await clock.advance(0);
  assert.equal(h.rows.length, 1);
  renderReceipt(h, "ticket-b");
  assert.equal(h.receipts.at(-1).status, "accepted");
  const second = trade({ transactionHash: `0x${"ef".repeat(32)}` });
  h.emit(second, "trade", "ticket-c");
  h.emit(null, "trade-reset");
  await clock.advance(30_000);
  assert.equal(h.rows.length, 1);
  assert.equal(clock.pending, 0);
});

function renderReceipt(h, deliveryId, origin = "https://gmgn.ai") {
  h.context.window.dispatchEvent({ type: "message", source: h.context.window, origin,
    data: { channel: "gmgn-follow-trade-event-v1", type: "trade-rendered", deliveryId } });
}

test('Pump missing spend updates the existing rendered row once without changing USD, timestamp or sound', async () => {
  const clock = fakeClock(), h = mainBridgeHarness({ clock });
  const item = trade({ platform: 'pump', quoteAmount: null, quoteAddress: '', quoteSymbol: '' });
  h.emit(item, 'trade', 'quote-ticket'); await clock.advance(0);
  renderReceipt(h, 'quote-ticket');
  assert.equal(h.rows[0].qa, undefined);
  assert.equal(h.sounds.length, 1);
  await clock.advance(6000);
  const filled = { ...item, quoteAmount: 0.123456, quoteAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    quoteSymbol: 'WBNB', usdAmount: 999, createdAt: item.createdAt + 1000 };
  h.emit(filled, 'trade-metadata'); await clock.advance(0);
  assert.equal(h.rows.length, 2);
  assert.equal(h.rows[1].id, h.rows[0].id);
  assert.equal(h.rows[1].qa, '0.123456');
  assert.equal(h.rows[1].qad, filled.quoteAddress);
  assert.equal(h.rows[1].qs, 'WBNB');
  assert.equal(h.rows[1].au, item.usdAmount);
  assert.equal(h.rows[1].ts, h.rows[0].ts);
  h.emit({ ...filled, quoteAmount: 999 }, 'trade-metadata'); await clock.advance(0);
  assert.equal(h.rows.length, 2);
  assert.equal(h.sounds.length, 1);
  assert.equal(clock.pending, 0);
});

test('Pump missing spend expires at 30 seconds without replaying the row or leaking an idle timer', async () => {
  const clock = fakeClock(), h = mainBridgeHarness({ clock });
  const item = trade({ platform: 'pump', quoteAmount: null, quoteAddress: '' });
  h.emit(item, 'trade', 'missing-quote'); await clock.advance(0); renderReceipt(h, 'missing-quote');
  await clock.advance(30_000);
  const runs = clock.runs;
  h.emit({ ...item, quoteAmount: 1, quoteAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' }, 'trade-metadata');
  await clock.advance(60_000);
  assert.equal(h.rows.length, 1);
  assert.equal(h.sounds.length, 1);
  assert.equal(clock.pending, 0);
  assert.equal(clock.runs, runs);
});

test("原生入口静默丢弃首笔时保持未确认，后续同 ID 重试恢复且只响一次", async () => {
  const clock = fakeClock();
  const h = mainBridgeHarness({ clock });
  const rendered = new Map();
  let calls = 0;
  h.socket.handleData = (rows) => {
    calls += 1;
    if (calls === 1) return; // Simulated native consumer remount drops buffered data.
    for (const row of rows) rendered.set(row.id, row);
    clock.setTimeout(() => renderReceipt(h, "dropped-first"), 200);
  };
  h.emit(trade(), "trade", "dropped-first");
  await clock.advance(500);
  assert.equal(rendered.size, 0);
  assert.equal(h.receipts.some((r) => r.status === "accepted"), false);
  await clock.advance(1000);
  assert.equal(rendered.size, 1);
  assert.equal(calls, 2);
  assert.equal(h.sounds.length, 1);
  assert.equal(h.receipts.filter((r) => r.status === "accepted").length, 1);
  await clock.advance(60_000);
  assert.equal(calls, 2);
  assert.equal(clock.pending, 0);
});

test("解码成功但行未被观察到不能报成功；过期后重试不重复声音，流观察器释放", async () => {
  const clock = fakeClock();
  const h = mainBridgeHarness({ clock });
  let observer = null, released = 0, submitted = 0;
  h.socket.getFollowWalletShareObservable = () => ({ subscribe(fn) {
    observer = fn;
    return { unsubscribe() { observer = null; released += 1; } };
  } });
  h.socket.handleData = (rows) => { submitted += 1; clock.setTimeout(() => observer?.(rows), 200); };
  const item = trade();
  h.emit(item, "trade", "never-rendered");
  await clock.advance(5000);
  assert.equal(h.receipts.some((r) => r.status === "decoded"), true);
  assert.equal(h.receipts.some((r) => r.status === "accepted"), false);
  assert.equal(h.receipts.at(-1).reason, "NATIVE_DECODED_ROW_NOT_OBSERVED");
  assert.equal(h.receipts.at(-1).status, "unverified");
  assert.equal(submitted, 1, "解码后不能重放导致原生通知重复累计");
  assert.equal(released, 1);
  assert.equal(clock.pending, 0);
  h.emit(item, "trade", "never-rendered");
  await clock.advance(5000);
  assert.equal(h.sounds.length, 1);
  assert.equal(released, 2);
  assert.equal(clock.pending, 0);
});

test("渲染回执必须对应已提交且未过期的投递；相同用户名不互相确认", async () => {
  const clock = fakeClock();
  const h = mainBridgeHarness({ clock });
  h.emit(trade({ profilePictureLink: "https://example.com/avatar.png" }), "trade", "render-a");
  renderReceipt(h, "render-a"); // Not submitted yet.
  await clock.advance(0);
  assert.match(h.rows[0].avatar, /gmgn-follow-delivery=render-a/);
  renderReceipt(h, "render-b");
  renderReceipt(h, "render-a", "https://other.example");
  assert.equal(h.receipts.some((r) => r.status === "accepted"), false);
  await clock.advance(5000);
  renderReceipt(h, "render-a");
  assert.equal(h.receipts.some((r) => r.status === "accepted"), false);
});

test("isolated relay 对编码后的精确投递头像回执，隐藏/断开/其他交易均不误确认", () => {
  const clock = fakeClock(), sent = [], background = [];
  let receive;
  const window = eventTarget({ postMessage(message) { sent.push(message); } });
  const images = [
    { id: "ticket-visible", visible: true, connected: true },
    { id: "ticket-hidden", visible: false, connected: true },
    { id: "ticket-detached", visible: true, connected: false },
    { id: "not-our-ticket", visible: true, connected: true },
  ].map(({id, visible, connected}) => ({
    isConnected: connected,
    getClientRects: () => visible ? [{}] : [],
    getAttribute: () => "https://image.example/?url=" + encodeURIComponent(
      `https://avatar.example/a.png#gmgn-follow-source=fomo&gmgn-follow-delivery=${id}`),
    closest: () => ({}),
  }));
  const context = vm.createContext({ window, Date: clock.Date, location: { origin: "https://gmgn.ai" },
    document: { visibilityState: "visible", querySelectorAll: () => images, getElementById: () => ({}) },
    chrome: { runtime: { getURL: (p) => p, onMessage: { addListener() {} }, connect: () => ({
      postMessage: (m) => background.push(m), onMessage: { addListener(fn) { receive = fn; } },
      onDisconnect: { addListener() {} },
    }) } }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  vm.runInContext(fs.readFileSync("src/follow-tracker.js", "utf8"), context);
  for (const deliveryId of ["ticket-visible", "ticket-hidden", "ticket-detached"]) {
    receive({ type: "gmgnFollowTradeEvent", item: trade(), deliveryId });
  }
  return clock.advance(1500).then(() => {
    assert.deepEqual(sent.filter((m) => m.type === "trade-rendered").map((m) => m.deliveryId), ["ticket-visible"]);
    for (const status of ["submitted", "decoded", "accepted"]) window.dispatchEvent({ type: "message", source: window,
      origin: "https://gmgn.ai", data: { channel: "gmgn-follow-trade-event-v1", type: "trade-ack",
        deliveryId: "ticket-visible", status, reason: "ROW_RENDERED" } });
    assert.deepEqual(background.filter((m) => m.type === "gmgnFollowTradeAck").map((m) => m.status), ["submitted", "decoded", "accepted"]);
    assert.equal(background.at(-1).reason, "ROW_RENDERED");
    assert.equal(clock.pending, 0);
  });
});

for (const version of [require('../manifest.json').version, 'fixture-next-version']) {
  test(`MAIN reinjection ${version} retains pending trades, receipts and one interceptor`, async () => {
    const clock = fakeClock();
    const interceptors = [];
    const h = mainBridgeHarness({clock, subscribedChains: [], axios: {
      interceptors: {response: {use: fn => interceptors.push(fn)}},
    }});
    const item = trade({platform: 'pump', createdAt: clock.Date.now()});
    h.emit(item, 'trade', 'before-upgrade');
    await clock.advance(100);
    const installed = h.context.__gmgnFollowThinBridgeVersion;
    const next = fs.readFileSync('src/follow-tracker-main.js', 'utf8')
      .replace(/const BRIDGE_VERSION = "[^"]+"/, `const BRIDGE_VERSION = "${version}"`);
    vm.runInContext(next, h.context);
    assert.equal(h.context.__gmgnFollowThinBridgeVersion, installed);
    assert.equal(interceptors.length, 1);
    h.subscribedChains.add('bsc');
    await clock.advance(400);
    assert.equal(h.rows.length, 1, 'pre-upgrade queue must survive');
    renderReceipt(h, 'before-upgrade');
    assert.ok(h.receipts.some(r => r.deliveryId === 'before-upgrade' && r.status === 'accepted'));
    h.emit(item, 'trade', 'before-upgrade');
    h.emit(trade({transactionHash: `0x${'cd'.repeat(32)}`, createdAt: clock.Date.now()}), 'trade', 'after-upgrade');
    await clock.advance(0);
    assert.equal(h.rows.length, 2, 'retry stays deduplicated and new trade is still delivered');
    assert.equal(h.sounds.length, 2);
    renderReceipt(h, 'after-upgrade');
    assert.ok(h.receipts.some(r => r.deliveryId === 'after-upgrade' && r.status === 'accepted'));
    await clock.advance(5000);
    assert.equal(clock.pending, 0);
  });
}

test('MAIN cross-version reinjection retains an in-flight history reply', async () => {
  const clock = fakeClock();
  let intercept;
  const requests = [];
  const h = mainBridgeHarness({clock, postMessage: message => requests.push(message), axios: {
    getUri: config => config.url,
    interceptors: {response: {use(fn) {intercept = fn;}}},
  }});
  const response = {config: {url: '/vas/api/v1/follow/follow_wallet_trade_list?chain=bsc'},
    data: {list: [{id: 'native', timestamp: Math.floor(clock.Date.now() / 1000) - 100}]}};
  const pending = intercept(response);
  const next = fs.readFileSync('src/follow-tracker-main.js', 'utf8')
    .replace(/const BRIDGE_VERSION = "[^"]+"/, 'const BRIDGE_VERSION = "fixture-next"');
  vm.runInContext(next, h.context);
  h.context.window.dispatchEvent({type: 'message', source: h.context.window, origin: 'https://gmgn.ai',
    data: {channel: 'gmgn-follow-trade-event-v1', type: 'recent-trades', requestId: requests[0].requestId, items: [trade()]}});
  assert.equal((await pending).data.list.length, 2);
  assert.equal(h.rows.length, 0);
  assert.equal(clock.pending, 0);
});

test('已确认的 Pump 记录允许较慢供应量更新，但五秒后不重放声音', async () => {
  const clock = fakeClock();
  const h = mainBridgeHarness({ clock });
  const item = trade({ platform: 'pump', totalSupply: null });
  h.emit(item, 'trade', 'pump-supply-delivery');
  await clock.advance(0);
  h.context.window.dispatchEvent({ type: 'message', source: h.context.window, origin: 'https://gmgn.ai',
    data: { channel: 'gmgn-follow-trade-event-v1', type: 'trade-rendered', deliveryId: 'pump-supply-delivery' } });
  await clock.advance(7000);
  h.emit({ ...item, totalSupplySnapshot: 1_000_000_000 }, 'trade-metadata');
  await clock.advance(0);
  assert.equal(h.rows.length, 2);
  assert.equal(h.rows[0].id, h.rows[1].id);
  assert.equal(h.rows[1].bts, '1000000000');
  assert.equal(h.sounds.length, 1);
  await clock.advance(30_000);
  assert.equal(clock.pending, 0);
});

function gmgnSupplyHarness() {
  const clock = fakeClock(), requests = [];
  let unsubscribed = 0;
  const h = mainBridgeHarness({ clock, subscribedChains: ['bsc', 'robinhood', 'sol'],
    tokenBrief(chain, addresses) {
      return { subscribe(observer) {
        requests.push({ chain, addresses, observer });
        return { unsubscribe() { unsubscribed++; } };
      } };
    } });
  return { h, clock, requests, get unsubscribed() { return unsubscribed; } };
}
function gmgnSupplyReply(request, overrides = {}) {
  request.observer.next({ tokens: [{ chain: request.chain, address: request.addresses[0],
    symbol: 'RKST', total_supply: '1000000000', decimals: 18, ...overrides }] });
}

test('GMGN 原生资料补齐 RKST 市值：供应量已是人类单位，不改变成交字段或重复声音', async () => {
  const {h, clock, requests} = gmgnSupplyHarness();
  const item = trade({platform: 'pump', networkId: 4663, totalSupply: null,
    tokenAddress: '0x8d1612b4b78ebf08cfbf01a04fa270ccbb0509a2',
    usdAmount: 12165.521068, baseAmount: 1_500_000, priceUsdAtTrade: 12165.521068 / 1_500_000 });
  h.emit(item, 'trade', 'gmgn-mc'); await clock.advance(0);
  assert.equal(h.rows.length, 1); assert.equal(h.rows[0].bts, undefined);
  renderReceipt(h, 'gmgn-mc');
  gmgnSupplyReply(requests[0], { price: '99999' }); await Promise.resolve(); await clock.advance(0);
  assert.equal(requests[0].chain, 'robinhood');
  assert.equal(h.rows.length, 2); assert.equal(h.rows[1].id, h.rows[0].id);
  assert.equal(Number(h.rows[1].bts), 1_000_000_000);
  assert.equal(Number(h.rows[1].pu) * Number(h.rows[1].bts), 8110347.378666666);
  assert.equal(h.rows[1].ts, h.rows[0].ts); assert.equal(h.rows[1].au, h.rows[0].au);
  assert.equal(h.sounds.length, 1); assert.equal(clock.pending, 0);
});

test('GMGN 市值请求合并并缓存 30 秒，跨链同地址隔离', async () => {
  const {h, clock, requests} = gmgnSupplyHarness();
  const item = trade({platform: 'pump', totalSupply: null});
  h.emit(item, 'trade', 'cache1');
  h.emit({...item, transactionHash: '0x' + 'cd'.repeat(32)}, 'trade', 'cache2');
  await clock.advance(0); assert.equal(requests.length, 1);
  renderReceipt(h, 'cache1'); renderReceipt(h, 'cache2');
  gmgnSupplyReply(requests[0]); await clock.advance(0);
  h.emit({...item, transactionHash: '0x' + 'ef'.repeat(32), priceUsdAtTrade: 0.001}, 'trade', 'cache3');
  await clock.advance(0); renderReceipt(h, 'cache3');
  assert.equal(requests.length, 1); assert.equal(h.rows.at(-1).bts, '1000000000');
  assert.equal(h.rows.at(-1).pu, 0.001);
  h.emit({...item, networkId: 4663}, 'trade', 'other-chain'); await clock.advance(0);
  assert.equal(requests.length, 2); assert.equal(requests[1].chain, 'robinhood');
  renderReceipt(h, 'other-chain'); gmgnSupplyReply(requests[1]); await clock.advance(31_000);
  h.emit({...item, transactionHash: '0x' + 'aa'.repeat(32), createdAt: clock.Date.now()}, 'trade', 'expired-cache');
  assert.equal(requests.length, 3);
});

for (const invalid of [{chain: 'sol'}, {address: '0x' + '99'.repeat(20)},
  {total_supply: 'NaN'}, {total_supply: '0'}]) {
  test(`GMGN 供应量响应错误时只保留原交易 ${JSON.stringify(invalid)}`, async () => {
    const {h, clock, requests} = gmgnSupplyHarness();
    h.emit(trade({platform: 'pump', totalSupply: null}), 'trade', 'invalid-mc');
    await clock.advance(0); renderReceipt(h, 'invalid-mc');
    gmgnSupplyReply(requests[0], invalid); await clock.advance(30_000);
    assert.equal(h.rows.length, 1); assert.equal(h.rows[0].bts, undefined);
    assert.equal(h.sounds.length, 1); assert.equal(clock.pending, 0);
  });
}

test('GMGN 查询超时取消订阅，不补发交易或持续请求', async () => {
  const fixture = gmgnSupplyHarness(), {h, clock, requests} = fixture;
  h.emit(trade({platform: 'pump', totalSupply: null}), 'trade', 'timeout-mc');
  await clock.advance(0); renderReceipt(h, 'timeout-mc');
  await clock.advance(6000);
  assert.equal(fixture.unsubscribed, 1); assert.equal(requests.length, 1);
  gmgnSupplyReply(requests[0]); await clock.advance(30_000);
  assert.equal(h.rows.length, 1); assert.equal(clock.pending, 0);
});

test('关闭推送取消 GMGN 元数据订阅，迟到结果不得恢复旧记录', async () => {
  const fixture = gmgnSupplyHarness(), {h, clock, requests} = fixture;
  h.emit(trade({platform: 'pump', totalSupply: null}), 'trade', 'cancel-mc');
  await clock.advance(0); renderReceipt(h, 'cancel-mc');
  h.emit(null, 'trade-reset');
  gmgnSupplyReply(requests[0]); await clock.advance(0);
  assert.equal(fixture.unsubscribed, 1); assert.equal(h.rows.length, 1);
  assert.equal(clock.pending, 0);
});

test('Pump 自带供应量和 Fomo 消息不请求 GMGN 资料', async () => {
  const {h, clock, requests} = gmgnSupplyHarness();
  h.emit(trade({platform: 'pump'}));
  h.emit(trade({transactionHash: '0x' + 'cd'.repeat(32), totalSupply: null}));
  await clock.advance(5000);
  assert.equal(requests.length, 0); assert.equal(h.rows.length, 2);
});

test('Solana 的 GMGN 供应量直接使用，地址大小写严格区分', async () => {
  const {h, clock, requests} = gmgnSupplyHarness();
  const item = trade({platform: 'pump', networkId: 1399811149, totalSupply: null,
    tokenAddress: 'BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump',
    walletAddress: '21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm', transactionHash: 'sol-trade' });
  h.emit(item, 'trade', 'sol-mc'); await clock.advance(0); renderReceipt(h, 'sol-mc');
  gmgnSupplyReply(requests[0], {total_supply: '998700001.123456', decimals: 6});
  await Promise.resolve(); await clock.advance(0);
  assert.equal(h.rows[1].bts, '998700001.123456'); assert.equal(clock.pending, 0);
});
