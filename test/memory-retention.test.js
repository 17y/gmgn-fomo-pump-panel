const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const core = require("../src/core");

function block(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}

test("successful metadata caches evict old tokens and keep fresh request deduplication", async () => {
  const source = fs.readFileSync("src/background.js", "utf8");
  let now = 0, requests = 0;
  const context = vm.createContext({
    Date: { now: () => now },
    pumpCoinMetadataCache: new Map(), pumpCoinMetadataRequests: new Map(),
    blockscoutSnapshotsByToken: new Map(),
    PUMP_MARKET_CACHE_MS: 1000, BLOCKSCOUT_SNAPSHOT_CACHE_MS: 1000,
    tokenCacheId: p => p.address,
    GmgnPumpApi: { buildCoinRequest: token => token },
    GmgnEvmHolderResolver: {
      buildBlockscoutTokenRequest: p => p, buildBlockscoutHoldersRequest: p => p,
    },
    fetchPublicJson: async () => { requests++; return { synthetic: true }; },
  });
  vm.runInContext([
    block(source, "function setBoundedCache(", "function getResolvedHolderAddress("),
    block(source, "async function getPumpCoinMetadata(", "function cachePumpRpcTrade("),
    block(source, "async function getInitialBlockscoutSnapshot(", "async function resolveEvmHolderFromBlockscout("),
  ].join("\n"), context);
  for (let i = 0; i < 1000; i++) {
    await context.getPumpCoinMetadata(`synthetic-${i}`);
    await context.getInitialBlockscoutSnapshot({ address: `synthetic-${i}` });
  }
  assert.equal(context.pumpCoinMetadataCache.size, 512);
  assert.equal(context.blockscoutSnapshotsByToken.size, 32);
  const before = requests;
  await context.getPumpCoinMetadata("synthetic-999");
  await context.getInitialBlockscoutSnapshot({ address: "synthetic-999" });
  assert.equal(requests, before);
  now = 86400000;
  await context.getPumpCoinMetadata("new-token");
  await context.getInitialBlockscoutSnapshot({ address: "new-token" });
  assert.equal(context.pumpCoinMetadataCache.size, 1);
  assert.equal(context.blockscoutSnapshotsByToken.size, 1);
  const beforeConcurrent = requests;
  await Promise.all([context.getPumpCoinMetadata("concurrent"), context.getPumpCoinMetadata("concurrent")]);
  assert.equal(requests - beforeConcurrent, 1);
});

test("module discovery retains markers without retaining a large module source string", () => {
  const source = fs.readFileSync("src/follow-tracker-main.js", "utf8");
  const cache = new WeakMap();
  const context = vm.createContext({ webpackFactoryMatches: cache });
  vm.runInContext(block(source, "  function webpackFactoryMarkers(", "  function webpackModuleFromFactoryMarkers("), context);
  const factory = new Function(`/* ${"synthetic-large-source ".repeat(100000)} */ return "getQuotationSocketMgr audio_channel";`);
  const result = context.webpackFactoryMarkers(factory);
  assert.ok(result.includes("getQuotationSocketMgr"));
  assert.ok(result.includes("audio_channel"));
  assert.ok(!result.includes("synthetic-large-source"));
  assert.ok(cache.get(factory).length < 200);
});

for (const file of ["src/content.js", "src/sidepanel.js"]) {
  test(`${file}: price updates retain card identity and update profit/loss text`, () => {
    const source = fs.readFileSync(file, "utf8");
    const context = vm.createContext({
      core, holderCopyStates: new Map(), holderFollowActions: new Map(),
      holderActionKey: () => "alice", holderFollowKey: () => "alice", holderIsFollowed: () => true,
      holderFollowState: { fomo: new Set(["alice"]), errors: {} },
      signedArrow: n => n < 0 ? "▼" : "▲", signedClass: n => n < 0 ? "negative" : "positive",
    });
    vm.runInContext(block(source, "  function holderRenderKey(", "  function updateHolderContent("), context);
    const holder = { platform: "fomo", userId: "alice", value: 100, pnl: 10, costBasis: 100, comment: "keep me" };
    const next = { ...holder, value: 90, pnl: -10, unrealizedPnl: -20, averageHoldTimeSeconds: 500 };
    assert.equal(context.holderRenderKey(holder, {}, 1000), context.holderRenderKey(next, {}, 1000));
    assert.notEqual(context.holderRenderKey(holder, {}, 1000), context.holderRenderKey({ ...holder, comment: "changed" }, {}, 1000));
    const value = {}, pnl = {};
    const metrics = { querySelector: tag => tag === "strong" ? value : pnl };
    context.updateHolderMetrics({ querySelector: () => metrics }, next);
    assert.equal(value.textContent, core.preciseUsd(90));
    assert.equal(pnl.className, "negative");
    assert.ok(pnl.textContent.includes("▼"));
    assert.notEqual(context.holderRenderKey(holder, {}, 1000), context.holderRenderKey({ ...holder, value: null }, {}, 1000));
  });
}
