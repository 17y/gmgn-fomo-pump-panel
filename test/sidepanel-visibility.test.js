const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("src/background.js", "utf8");

function visibilityRegistryBlock() {
  const start = source.indexOf("function removeSidePanelPort");
  const end = source.indexOf("\nfunction configureSidePanel", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

function createHarness() {
  const broadcasts = [];
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    broadcasts,
    sidePanelPortsByWindow: new Map(),
    sidePanelWindowByPort: new Map(),
    sidePanelCloseTimers: new Map(),
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    broadcastSidePanelVisibility(windowId, visible) {
      broadcasts.push({ windowId, visible });
    },
  });
  vm.runInContext(`
    ${visibilityRegistryBlock()}
    globalThis.visibilityRegistry = {
      registerSidePanelPort,
      removeSidePanelPort,
    };
  `, context);
  return { broadcasts, timers, registry: context.visibilityRegistry };
}

test("each new side-panel port re-announces visibility without amplifying heartbeats", () => {
  const { broadcasts, timers, registry } = createHarness();
  const firstPort = {};
  const replacementPort = {};

  registry.registerSidePanelPort(firstPort, 17);
  registry.registerSidePanelPort(firstPort, 17);
  registry.registerSidePanelPort(replacementPort, 17);

  assert.deepEqual(broadcasts, [
    { windowId: 17, visible: true },
    { windowId: 17, visible: true },
  ]);

  registry.removeSidePanelPort(firstPort);
  assert.equal(broadcasts.length, 2, "remaining port keeps the panel visible");

  registry.removeSidePanelPort(replacementPort);
  assert.equal(broadcasts.length, 2, "close waits for the reconnect grace period");
  assert.equal([...timers.values()][0].delay, 800);
  [...timers.values()][0].callback();
  assert.deepEqual(broadcasts.at(-1), { windowId: 17, visible: false });
});

test("side-panel reconnect cancels the pending hidden state without flashing the overlay", () => {
  const { broadcasts, timers, registry } = createHarness();
  const port = {};
  registry.registerSidePanelPort(port, 17);
  registry.removeSidePanelPort(port);
  registry.registerSidePanelPort({}, 17);
  assert.equal(timers.size, 0);
  assert.equal(broadcasts.some((entry) => !entry.visible), false);
});
