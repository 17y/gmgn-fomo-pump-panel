const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const core = require("../src/core");

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type) { for (const listener of listeners.get(type) || []) listener({ isTrusted: true }); },
    count() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
  };
}

function loaderHarness() {
  const window = eventTarget();
  window.navigation = eventTarget();
  const document = { ...eventTarget(), visibilityState: "hidden" };
  const location = { pathname: "/?chain=bsc" };
  const messages = new Set();
  const requests = [];
  const context = vm.createContext({
    window, document, location, GmgnFomoCore: core,
    chrome: { runtime: {
      getManifest: () => ({ version: "test" }),
      sendMessage: () => new Promise((resolve) => requests.push(resolve)),
      onMessage: { addListener: (fn) => messages.add(fn), removeListener: (fn) => messages.delete(fn) },
    } },
  });
  const install = () => vm.runInContext(fs.readFileSync("src/panel-loader.js", "utf8"), context);
  install();
  return { window, document, location, messages, requests, install };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("panel loader is idle on non-token and hidden pages, then loads once and hands off listeners", async () => {
  const h = loaderHarness();
  h.document.visibilityState = "visible";
  h.document.dispatch("visibilitychange");
  assert.equal(h.requests.length, 0);
  h.document.visibilityState = "hidden";
  h.location.pathname = "/bsc/token/0x1111111111111111111111111111111111111111";
  h.window.navigation.dispatch("navigatesuccess");
  assert.equal(h.requests.length, 0);
  h.document.visibilityState = "visible";
  h.document.dispatch("visibilitychange");
  h.install();
  h.window.dispatch("popstate");
  assert.equal(h.requests.length, 1);
  h.requests[0]({ ok: true, loaded: true });
  await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.window.count() + h.window.navigation.count() + h.document.count() + h.messages.size, 0);
});

test("closing the side panel during a pending loader check is not lost", async () => {
  const h = loaderHarness();
  h.location.pathname = "/sol/token/So11111111111111111111111111111111111111112";
  h.document.visibilityState = "visible";
  h.document.dispatch("visibilitychange");
  for (const listener of h.messages) listener({ type: "sidePanelVisibilityChanged", visible: false });
  h.requests[0]({ ok: true, loaded: false });
  await flush();
  assert.equal(h.requests.length, 2);
  h.requests[1]({ ok: true, loaded: true });
  await flush();
  assert.equal(h.messages.size, 0);
});

test("background coalesces overlay injection and skips it while the side panel is visible", async () => {
  const source = fs.readFileSync("src/background.js", "utf8");
  const block = source.slice(source.indexOf("function ensureFomoOverlay("), source.indexOf("\nasync function injectIntoOpenGmgnTabs"));
  const sidePanelPortsByWindow = new Map([[17, new Set()]]);
  let ping;
  const scripts = [];
  const context = vm.createContext({
    sidePanelPortsByWindow,
    overlayLoadsByTab: new Map(),
    chrome: {
      runtime: { getManifest: () => ({ version: "test" }) },
      tabs: { sendMessage: () => new Promise((resolve) => { ping = resolve; }) },
      scripting: { executeScript: async (request) => scripts.push(request) },
    },
  });
  vm.runInContext(`${block}\nglobalThis.ensure = ensureFomoOverlay;`, context);
  const tab = { id: 12, windowId: 17 };
  assert.equal((await context.ensure(tab)).loaded, false);
  assert.equal(ping, undefined);
  sidePanelPortsByWindow.clear();
  const first = context.ensure(tab);
  assert.equal(context.ensure(tab), first);
  ping(null);
  await first;
  assert.equal(scripts.length, 1);
  const next = context.ensure(tab);
  ping({ ok: true, version: "test" });
  await next;
  assert.equal(scripts.length, 1);
});
