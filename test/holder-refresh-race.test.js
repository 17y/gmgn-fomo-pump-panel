const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const content = fs.readFileSync("src/content.js", "utf8");
const sidePanel = fs.readFileSync("src/sidepanel.js", "utf8");

function functionBlock(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1);
  assert.notEqual(endIndex, -1);
  return source.slice(startIndex, endIndex);
}

function createLoadHarness(source, kind) {
  const loadSource = functionBlock(
    source,
    kind === "content" ? "  function canLoadView(" : "  function load(",
    kind === "content" ? "\n  function clearInitialLoadHandles" : "\n  function setRoute",
  );
  let resolvePump;
  const state = { fomoCalls: 0, feedCalls: 0, pumpCalls: 0, renderedItems: [], messages: [], followForces: [] };
  const fomoData = { metadata: {}, holders: { items: [] } };
  const context = {
    Date,
    Promise,
    document: { visibilityState: "visible" },
    setTimeout() { return 1; },
    clearTimeout() {},
    state,
    refreshPumpNotice() {},
    refreshHolderFollowStates(force) { state.followForces.push(force); },
    isActiveInstance() { return true; },
    renderHeader() {},
    renderCollapsedPosition() {},
    renderActiveTab() {},
    renderFeed() {},
    renderError() {},
    renderIdle() {},
    withPumpItems(data, items) {
      return { ...data, holders: { ...data.holders, items: [...data.holders.items, ...items] } };
    },
    renderHolders() {
      state.renderedItems = context.currentData.holders.items;
    },
    sendMessage(message) {
      state.messages.push(message);
      if (message.type === "queryFomoToken") {
        state.fomoCalls += 1;
        return Promise.resolve({ ok: true, data: fomoData });
      }
      if (message.type === "queryFomoFeed") {
        state.feedCalls++;
        return Promise.resolve({ ok: true, items: [] });
      }
      state.pumpCalls += 1;
      return new Promise((resolve) => { resolvePump = resolve; });
    },
  };
  const declarations = kind === "content"
    ? `
      var requestVersion = 1;
      var activeLoad = null;
      var loadedVersion = -1, holderExtrasLoad = null, feedLoad = null;
      var currentPumpItems = [];
      var currentData = null;
      var sidePanelVisible = false;
      var refreshTimer = null;
      var pendingInitialLoad = null;
      var REFRESH_MS = 5000;
      var currentView = {
        route: { address: "token", networkId: 56 },
        host: { isConnected: true },
        status: { textContent: "" },
        activeTab: "holders",
        panel: { classList: { contains() { return false; } } },
      };
    `
    : `
      var requestVersion = 1;
      var activeLoad = null;
      var loadedVersion = -1, holderExtrasLoad = null, feedLoad = null, currentTabId = 1;
      var currentPumpItems = [];
      var currentData = null;
      var currentRoute = { address: "token", networkId: 56 };
      var routeLoadTimer = null;
      var activeTab = "holders";
      var status = { textContent: "" };
      function showLoading() {}
    `;
  vm.runInNewContext(`${declarations}\n${loadSource}\nglobalThis.loadUnderTest = load;`, context);
  return {
    state,
    setTab(tab) {
      if (kind === "content") context.currentView.activeTab = tab;
      else context.activeTab = tab;
    },
    start(force = false) {
      return kind === "content"
        ? context.loadUnderTest(context.currentView, false, force)
        : context.loadUnderTest(false, force);
    },
    finishPump(items) {
      resolvePump({ ok: true, items });
    },
  };
}

test("holder refresh keeps one request per route so a slow Pump response can finish", () => {
  for (const source of [content, sidePanel]) {
    assert.match(source, /let activeLoad = null;/);
    assert.match(source, /if \(activeLoad\?\.[\s\S]{0,100}requestVersion[\s\S]{0,100}return activeLoad\.promise;/);
    assert.match(source, /\.finally\(\(\) => \{\s*if \(activeLoad === entry\) activeLoad = null;\s*(?:scheduleRefresh\(\);\s*)?\}\)/);
  }

  assert.doesNotMatch(content, /load\(currentView, \+\+requestVersion, true\)/);
  assert.doesNotMatch(sidePanel, /const version = \+\+requestVersion;/);
});

for (const [name, source] of [["content", content], ["side panel", sidePanel]]) {
  test(`${name} fetches Feed only when viewed and restores holder work on return`, async () => {
    const h = createLoadHarness(source, name === "content" ? "content" : "sidepanel");
    h.setTab("feed");
    await h.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state.messages[0].includeFeed, false);
    assert.equal(h.state.feedCalls, 1);
    assert.equal(h.state.pumpCalls, 0);
    h.setTab("holders");
    const pending = h.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.state.fomoCalls, 1);
    assert.equal(h.state.pumpCalls, 1);
    h.finishPump([]);
    await pending;
  });

  test(`${name} finishes the base load independently and reuses its delayed Pump result`, async () => {
    const harness = createLoadHarness(source, name === "content" ? "content" : "sidepanel");
    const first = harness.start();
    await new Promise((resolve) => setImmediate(resolve));
    const refresh = harness.start();
    await first;
    assert.equal(harness.start(), refresh);
    assert.equal(harness.state.fomoCalls, 1);
    assert.equal(harness.state.pumpCalls, 1);

    const pumpItem = { platform: "pump", userId: "pump-user" };
    harness.finishPump([pumpItem]);
    await refresh;
    assert.deepEqual(harness.state.renderedItems, [pumpItem]);
  });
}

test("only trusted visibility changes trigger holder reloads", () => {
  for (const source of [content, sidePanel]) {
    assert.match(source, /document\.addEventListener\("visibilitychange", \(event\) => \{\s*if \(!event\.isTrusted\) return;/);
  }
});

for (const [name, source] of [["content", content], ["side panel", sidePanel]]) {
  test(`${name} distinguishes route loading from an explicit manual refresh`, async () => {
    const h = createLoadHarness(source, name === "content" ? "content" : "sidepanel");
    const initial = h.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.state.messages[0].force, false);
    assert.equal(h.state.followForces[0], false);
    h.finishPump([]);
    await initial;
    const manual = h.start(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.state.messages[2].force, true);
    assert.equal(h.state.followForces[1], true);
    h.finishPump([]);
    await manual;
  });
}
