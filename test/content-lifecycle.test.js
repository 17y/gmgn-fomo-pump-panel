const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const core = require("../src/core");
const source = fs.readFileSync("src/content.js", "utf8");
const loadBlock = source.slice(source.indexOf("  function canLoadView("), source.indexOf("  function clearInitialLoadHandles("));
const routeBlock = source.slice(source.indexOf("  function syncRoute("), source.indexOf("  chrome.runtime.onMessage.addListener"));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness({ collapsed = false, deferred = false } = {}) {
  const requests = [];
  const renders = [];
  const timers = new Map();
  const state = { creates: 0, restores: 0, initial: 0, disposals: 0 };
  let nextId = 0;
  let reply;
  const data = { metadata: { symbol: "TEST" }, holders: { items: [] } };
  const context = vm.createContext({
    core, state, requests, renders,
    document: { visibilityState: "visible", getElementById: () => context.currentView?.host },
    location: { pathname: "/bsc/token/0x1111111111111111111111111111111111111111" },
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    isActiveInstance: () => true,
    refreshPumpNotice: () => renders.push("notice"),
    refreshHolderFollowStates: () => renders.push("follow"),
    renderHeader: () => renders.push("header"),
    renderCollapsedPosition: () => renders.push("summary"),
    renderActiveTab: () => renders.push("body"),
    renderHolders: () => renders.push("pump"),
    renderError: () => renders.push("error"),
    withPumpItems: (value) => value,
    sendMessage(message) {
      requests.push(message.type);
      if (message.type === "gmgnTokenRouteChanged") return Promise.resolve();
      if (message.type === "queryPumpHolders") return Promise.resolve({ ok: true, items: [] });
      if (deferred) return new Promise((resolve) => { reply = resolve; });
      return Promise.resolve({ ok: true, data });
    },
    saveLayout() {},
    cancelInitialLoad() { context.pendingInitialLoad = null; },
    restoreAndTrackLayout() { state.restores++; },
    scheduleInitialLoad() { state.initial++; context.pendingInitialLoad = {}; },
    hideOverlayHost() { context.currentView.host.hidden = true; },
    createView(route) {
      state.creates++;
      return {
        route, activeTab: "holders", status: {},
        panel: { classList: { contains: () => collapsed } },
        host: { isConnected: true, hidden: false, dataset: {}, remove() { this.isConnected = false; } },
        stopLayoutTracking() { state.disposals++; },
      };
    },
  });
  vm.runInContext(`
    var HOST_ID = "panel";
    var REFRESH_MS = 5000;
    var currentKey = "", currentRoute = null, currentView = null, currentData = null;
    var currentPumpItems = [], requestVersion = 0, activeLoad = null, refreshTimer = null;
    var pendingInitialLoad = null, sidePanelVisible = false, sidePanelStateReady = true;
    ${loadBlock}
    ${routeBlock}
    globalThis.api = { load, syncRoute, stopRefresh, scheduleRefresh };
    syncRoute();
    pendingInitialLoad = null;
  `, context);
  return { context, state, requests, renders, timers, data, reply: () => reply({ ok: true, data }) };
}

test("collapsed refresh updates only the Fomo summary and arms one bounded next refresh", async () => {
  const h = harness({ collapsed: true });
  await h.context.api.load(h.context.currentView);
  assert.deepEqual(h.requests, ["gmgnTokenRouteChanged", "queryFomoToken"]);
  assert.deepEqual(h.renders, ["summary"]);
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 5000);
  h.context.document.visibilityState = "hidden";
  h.context.api.scheduleRefresh();
  await h.context.api.load(h.context.currentView);
  assert.equal(h.timers.size, 0);
  assert.equal(h.requests.length, 2);
});

test("side-panel hide/show retains layout but releases hidden data without duplicate mounts", async () => {
  const h = harness();
  await h.context.api.load(h.context.currentView);
  const view = h.context.currentView;
  const data = h.context.currentData;
  h.context.sidePanelVisible = true;
  h.context.api.syncRoute();
  h.context.api.syncRoute();
  assert.equal(h.timers.size, 0);
  assert.equal(h.state.disposals, 1);
  assert.equal(view.host.hidden, true);
  h.context.sidePanelVisible = false;
  h.context.api.syncRoute();
  h.context.api.syncRoute();
  assert.equal(h.context.currentView, view);
  assert.equal(h.context.currentData, null);
  assert.equal(view.host.hidden, false);
  assert.equal(h.state.creates, 1);
  assert.equal(h.state.restores, 1);
  assert.equal(h.state.initial, 2);
});

test("a holder response from a previous token cannot render or start Pump work on the new token", async () => {
  const h = harness({ deferred: true });
  const request = h.context.api.load(h.context.currentView);
  h.context.location.pathname = "/bsc/token/0x2222222222222222222222222222222222222222";
  h.context.api.syncRoute();
  h.reply();
  await request;
  assert.equal(h.context.currentData, null);
  assert.deepEqual(h.renders, ["notice"]);
  assert.equal(h.requests.includes("queryPumpHolders"), false);
  assert.equal(h.timers.size, 0);
});

test("a response arriving after the side panel opens cannot repaint the hidden overlay", async () => {
  const h = harness({ deferred: true });
  const request = h.context.api.load(h.context.currentView);
  h.context.sidePanelVisible = true;
  h.context.api.syncRoute();
  h.reply();
  await request;
  await flush();
  assert.equal(h.context.currentData, null);
  assert.deepEqual(h.renders, ["notice"]);
  assert.equal(h.timers.size, 0);
});

test("leaving a token page disposes its view and timers without creating a sentinel", async () => {
  const h = harness();
  await h.context.api.load(h.context.currentView);
  const view = h.context.currentView;
  h.context.location.pathname = "/";
  h.context.api.syncRoute();
  assert.equal(view.host.isConnected, false);
  assert.equal(h.context.currentView, null);
  assert.equal(h.timers.size, 0);
  assert.equal(h.state.creates, 1);
});

test("both panel surfaces keep Solana token route identity case-sensitive", () => {
  const first = "/sol/token/So11111111111111111111111111111111111111112";
  const second = "/sol/token/so11111111111111111111111111111111111111112";
  const h = harness();
  h.context.location.pathname = first;
  h.context.api.syncRoute();
  h.context.location.pathname = second;
  h.context.api.syncRoute();
  assert.equal(h.state.creates, 3);

  const sidePanel = fs.readFileSync("src/sidepanel.js", "utf8");
  const block = sidePanel.slice(sidePanel.indexOf("  function setRoute("), sidePanel.indexOf("  function routeFromUrl("));
  const context = vm.createContext({
    currentRoute: core.parseTokenRoute(first), currentData: null, currentPumpItems: [], requestVersion: 0,
    openFomo: {}, fomoTokenUrl: () => "", renderPendingHeader() {}, load() {}, renderIdle() {},
  });
  vm.runInContext(`${block}\nglobalThis.setRoute = setRoute;`, context);
  assert.equal(context.setRoute(core.parseTokenRoute(second)), true);
  assert.equal(context.requestVersion, 1);
});
