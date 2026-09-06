const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("src/content.js", "utf8");

function initialLoadBlock() {
  const start = source.indexOf("  function clearInitialLoadHandles");
  const end = source.indexOf("\n  function syncRoute", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type) {
      for (const listener of listeners.get(type) || []) listener();
    },
  };
}

function createHarness({ readyState = "loading", visibilityState = "hidden" } = {}) {
  let sequence = 0;
  const timers = new Map();
  const idleCallbacks = new Map();
  const window = eventTarget();
  const document = { readyState, visibilityState };
  const state = { loads: [] };
  const view = { host: { isConnected: true } };
  const context = vm.createContext({
    window,
    document,
    state,
    view,
    setTimeout(callback, delay) {
      const id = ++sequence;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    requestIdleCallback(callback, options) {
      const id = ++sequence;
      idleCallbacks.set(id, { callback, options });
      return id;
    },
    cancelIdleCallback(id) { idleCallbacks.delete(id); },
  });
  vm.runInContext(`
    const INITIAL_LOAD_SETTLE_MS = 500;
    const INITIAL_LOAD_IDLE_TIMEOUT_MS = 1_000;
    let requestVersion = 1;
    let currentView = view;
    let pendingInitialLoad = null;
    function isActiveInstance() { return true; }
    function load(target) { state.loads.push(target); }
    ${initialLoadBlock()}
    globalThis.initialLoadApi = {
      scheduleInitialLoad,
      pauseInitialLoad,
      cancelInitialLoad,
      pending: () => pendingInitialLoad,
      setView: (target) => { currentView = target; },
    };
  `, context);
  return { context, document, idleCallbacks, state, timers, view, window };
}

test("浮层首次请求只在页面完成、可见、稳定 500ms 并进入 idle 后启动", () => {
  const harness = createHarness();
  harness.context.initialLoadApi.scheduleInitialLoad(harness.view);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.idleCallbacks.size, 0);
  assert.equal(harness.state.loads.length, 0);

  harness.document.readyState = "complete";
  harness.window.dispatch("load");
  assert.equal(harness.timers.size, 0, "隐藏页不得开始稳定期");

  harness.document.visibilityState = "visible";
  harness.context.initialLoadApi.pending().queue();
  const settleTimer = [...harness.timers.values()][0];
  assert.equal(settleTimer.delay, 500);
  settleTimer.callback();
  const idle = [...harness.idleCallbacks.values()][0];
  assert.equal(idle.options.timeout, 1_000);
  assert.equal(harness.state.loads.length, 0);

  idle.callback();
  assert.equal(harness.state.loads.length, 1);
  assert.equal(harness.context.initialLoadApi.pending(), null);
});

test("浮层首次请求在隐藏或路由切换时取消旧任务", () => {
  const harness = createHarness({ readyState: "complete", visibilityState: "visible" });
  harness.context.initialLoadApi.scheduleInitialLoad(harness.view);
  const staleTimer = [...harness.timers.values()][0];

  harness.document.visibilityState = "hidden";
  harness.context.initialLoadApi.pauseInitialLoad();
  assert.equal(harness.timers.size, 0);
  staleTimer.callback();
  assert.equal(harness.idleCallbacks.size, 0);
  assert.equal(harness.state.loads.length, 0);

  const nextView = { host: { isConnected: true } };
  harness.context.initialLoadApi.setView(nextView);
  harness.context.initialLoadApi.scheduleInitialLoad(nextView);
  harness.context.initialLoadApi.cancelInitialLoad();
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.idleCallbacks.size, 0);
  assert.equal(harness.state.loads.length, 0);
});
