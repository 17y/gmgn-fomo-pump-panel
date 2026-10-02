const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync("src/sidepanel.js", "utf8");
const block = source.slice(source.indexOf("  function load("), source.indexOf("  function routeFromUrl("));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const route = (id) => ({ chain: "bsc", networkId: 56, address: `token-${id}` });

function harness({ defer = false } = {}) {
  let now = 0, nextId = 0;
  const timers = new Map(), requests = [], rendered = [], replies = [];
  const context = vm.createContext({
    Date, Promise, currentRoute: null, currentData: null, currentPumpItems: [], activeTab: "holders",
    requestVersion: 0, currentTabId: 1, loadedVersion: -1, holderExtrasLoad: null, feedLoad: null, activeLoad: null, routeLoadTimer: null, ROUTE_SETTLE_MS: 300,
    document: { visibilityState: "visible" }, status: {}, openFomo: {},
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fomoTokenUrl: (value) => value.address,
    renderPendingHeader() {}, renderIdle() {}, showLoading() {}, renderError() {},
    renderHeader(metadata) { rendered.push(metadata.token); }, renderActiveTab() {}, renderHolders() {}, renderFeed() {},
    refreshHolderFollowStates() {},
    withPumpItems: (data) => data,
    sendMessage(message) {
      requests.push(message);
      if (message.type === "queryPumpHolders") return Promise.resolve({ ok: true, items: [] });
      if (message.type === "queryFomoFeed") return Promise.resolve({ ok: true, items: [] });
      const result = { ok: true, data: { metadata: { token: message.params.address }, holders: { items: [] }, feed: [] } };
      if (!defer) return Promise.resolve(result);
      return new Promise((resolve) => { replies.push(() => resolve(result)); });
    },
  });
  vm.runInContext(`${block}\nglobalThis.api = { load, setRoute };`, context);
  return {
    context, requests, rendered, replies, timers,
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); }
      }
      await flush();
    },
  };
}

test("rapid navigation waits 300ms and fetches only the final token; periodic loads cannot bypass it", async () => {
  const h = harness();
  for (let i = 0; i < 10; i++) {
    h.context.api.setRoute(route(i));
    await h.context.api.load(true);
    await h.advance(100);
  }
  assert.equal(h.requests.length, 0);
  assert.equal(h.timers.size, 1);
  await h.advance(199);
  assert.equal(h.requests.length, 0);
  await h.advance(1);
  const tokens = h.requests.filter((message) => message.type === "queryFomoToken");
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].params.address, "token-9");
  assert.equal(tokens[0].force, false);
  assert.deepEqual(h.rendered, ["token-9"]);
});

test("leaving a token cancels the pending load and a hidden panel does not fetch", async () => {
  const h = harness();
  h.context.api.setRoute(route(1));
  h.context.api.setRoute(null);
  await h.advance(500);
  assert.equal(h.requests.length, 0);
  h.context.api.setRoute(route(2));
  h.context.document.visibilityState = "hidden";
  await h.advance(500);
  assert.equal(h.requests.length, 0);
  h.context.document.visibilityState = "visible";
  await h.context.api.load(true);
  assert.deepEqual(h.rendered, ["token-2"]);
});

test("manual refresh starts immediately and cancels the scheduled duplicate", async () => {
  const h = harness();
  h.context.api.setRoute(route(1));
  await h.context.api.load(false, true);
  assert.equal(h.requests[0].force, true);
  assert.equal(h.timers.size, 0);
  await h.advance(500);
  assert.equal(h.requests.filter((message) => message.type === "queryFomoToken").length, 1);
});

test("old in-flight results cannot render over the new token or start old-token Pump work", async () => {
  const h = harness({ defer: true });
  h.context.api.setRoute(route(1));
  await h.advance(300);
  h.context.api.setRoute(route(2));
  await h.advance(300);
  assert.equal(h.replies.length, 2);
  h.replies[1]();
  await flush();
  h.replies[0]();
  await flush();
  assert.deepEqual(h.rendered, ["token-2"]);
  assert.deepEqual(h.requests.filter((message) => message.type === "queryPumpHolders")
    .map((message) => message.params.address), ["token-2"]);
});

test("ten thousand route replacements retain one timer and load only the final route", async () => {
  const h = harness();
  for (let i = 0; i < 10000; i++) h.context.api.setRoute(route(i));
  assert.equal(h.timers.size, 1);
  assert.equal(h.requests.length, 0);
  await h.advance(300);
  assert.equal(h.timers.size, 0);
  assert.equal(h.requests.filter(message => message.type === "queryFomoToken").length, 1);
  assert.deepEqual(h.rendered, ["token-9999"]);
});

test("idle, focus and section switches never re-read token data; Feed is loaded once on demand", async () => {
  const h = harness();
  h.context.api.setRoute(route(1)); await h.advance(300);
  for (let i = 0; i < 100; i++) {
    await h.advance(60_000); await h.context.api.load(true);
    h.context.api.setRoute(route(1));
  }
  assert.equal(h.requests.filter(m => m.type === "queryFomoToken").length, 1);
  assert.equal(h.requests.filter(m => m.type === "queryPumpHolders").length, 1);
  assert.equal(h.requests.filter(m => m.type === "queryFomoFeed").length, 0);
  h.context.activeTab = "feed"; await h.context.api.load(true);
  h.context.activeTab = "holders"; await h.context.api.load(true);
  h.context.activeTab = "feed"; await h.context.api.load(true);
  assert.equal(h.requests.filter(m => m.type === "queryFomoFeed").length, 1);
  assert.equal(h.requests.filter(m => m.type === "queryFomoToken").length, 1);
  await h.context.api.load(false, true);
  await flush();
  assert.equal(h.requests.filter(m => m.type === "queryFomoToken").length, 2);
  assert.equal(h.requests.filter(m => m.type === "queryFomoFeed").length, 2);
  assert.equal(h.timers.size, 0);
});
