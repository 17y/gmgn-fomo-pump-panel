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
    kind === "content" ? "\n  function syncRoute" : "\n  function setRoute",
  );
  let resolvePump;
  const state = { fomoCalls: 0, pumpCalls: 0, renderedItems: [] };
  const fomoData = { metadata: {}, holders: { items: [] } };
  const context = {
    Date,
    Promise,
    document: { visibilityState: "visible" },
    setTimeout() { return 1; },
    clearTimeout() {},
    state,
    refreshPumpNotice() {},
    isActiveInstance() { return true; },
    renderHeader() {},
    renderCollapsedPosition() {},
    renderActiveTab() {},
    renderError() {},
    renderIdle() {},
    withPumpItems(data, items) {
      return { ...data, holders: { ...data.holders, items: [...data.holders.items, ...items] } };
    },
    renderHolders() {
      state.renderedItems = context.currentData.holders.items;
    },
    sendMessage(message) {
      if (message.type === "queryFomoToken") {
        state.fomoCalls += 1;
        return Promise.resolve({ ok: true, data: fomoData });
      }
      state.pumpCalls += 1;
      return new Promise((resolve) => { resolvePump = resolve; });
    },
  };
  const declarations = kind === "content"
    ? `
      var requestVersion = 1;
      var activeLoad = null;
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
      var currentPumpItems = [];
      var currentData = null;
      var currentRoute = { address: "token", networkId: 56 };
      var activeTab = "holders";
      var status = { textContent: "" };
      function showLoading() {}
    `;
  vm.runInNewContext(`${declarations}\n${loadSource}\nglobalThis.loadUnderTest = load;`, context);
  return {
    state,
    start() {
      return kind === "content"
        ? context.loadUnderTest(context.currentView)
        : context.loadUnderTest();
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
  test(`${name} reuses the in-flight holder load and applies its delayed Pump result`, async () => {
    const harness = createLoadHarness(source, name === "content" ? "content" : "sidepanel");
    const first = harness.start();
    await new Promise((resolve) => setImmediate(resolve));
    const refresh = harness.start();

    assert.equal(refresh, first);
    assert.equal(harness.state.fomoCalls, 1);
    assert.equal(harness.state.pumpCalls, 1);

    const pumpItem = { platform: "pump", userId: "pump-user" };
    harness.finishPump([pumpItem]);
    await first;
    assert.deepEqual(harness.state.renderedItems, [pumpItem]);
  });
}

test("only trusted visibility changes trigger holder reloads", () => {
  for (const source of [content, sidePanel]) {
    assert.match(source, /document\.addEventListener\("visibilitychange", \(event\) => \{\s*if \(!event\.isTrusted\) return;/);
  }
});
