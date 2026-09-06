const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("src/content.js", "utf8");

test("隐藏浮层的宿主不会被 Shadow DOM 的 display:block 重新显示", () => {
  const styles = fs.readFileSync("src/panel.css", "utf8");
  assert.match(styles, /:host\(\[hidden\]\)\s*\{\s*display: none !important;/);
});

function layoutBlock() {
  const start = source.indexOf("  function setCollapsed");
  const end = source.indexOf("\n  function enableDragging", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

function createHarness(storedLayout = null) {
  const writes = [];
  const observers = [];
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    chrome: {
      storage: {
        local: {
          set(value) { writes.push(value); },
        },
      },
    },
    setTimeout(callback) {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    window: { innerWidth: 1200, innerHeight: 900 },
    document: { visibilityState: "visible" },
    ResizeObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        observers.push(this);
      }

      observe() {}

      disconnect() { this.disconnected = true; }
    },
  });
  vm.runInContext(`
    const LAYOUT_KEY = "gmgnFomoPanelLayoutV1";
    let currentView = null;
    let currentLayout = null;
    async function storageGet() { return storedLayout; }
    ${layoutBlock()}
    globalThis.layoutApi = {
      keepOnScreen,
      saveLayout,
      restoreAndTrackLayout,
      revealViewWhenReady,
      setCollapsed,
      setCurrentView: (view) => { currentView = view; },
    };
  `, context);
  context.storedLayout = storedLayout;
  return { context, observers, timers, writes };
}

function createView(rect, { stylesReady = true } = {}) {
  const classes = new Set();
  const collapseButton = { textContent: "−" };
  const host = {
    dataset: {},
    hidden: false,
    isConnected: true,
    style: {},
  };
  const panel = {
    classList: {
      contains(value) { return classes.has(value); },
      toggle(value, force) {
        if (force === undefined ? !classes.has(value) : force) classes.add(value);
        else classes.delete(value);
      },
    },
    getBoundingClientRect() {
      const collapsed = classes.has("collapsed");
      return {
        ...rect,
        left: Number.parseFloat(host.style.left) || rect.left,
        top: Number.parseFloat(host.style.top) || rect.top,
        width: collapsed && stylesReady ? 300 : Number.parseFloat(panel.style.width) || rect.width,
        height: collapsed && stylesReady ? 92 : Number.parseFloat(panel.style.height) || rect.height,
      };
    },
    style: {},
  };
  return {
    collapsedPosition: { setAttribute() {} },
    host,
    panel,
    stylesReady,
    layoutReady: false,
    setStylesReady(value) {
      stylesReady = value;
      this.stylesReady = value;
    },
    shadow: { querySelector: () => collapseButton },
  };
}

test("切 Token 时等待样式和布局都就绪后一次性显示浮层", async () => {
  assert.match(source, /host\.style\.visibility = "hidden";/);
  assert.match(source, /stylesheet\.addEventListener\("load", \(\) => \{\s*view\.stylesReady = true;\s*if \(revealViewWhenReady\(view\)\) saveLayout\(view\);/);
  const harness = createHarness({
    left: 615,
    top: 126,
    width: 420,
    height: 620,
    collapsed: false,
  });
  const view = createView(
    { left: 18, top: 82, width: 420, height: 620 },
    { stylesReady: false },
  );
  view.host.style.visibility = "hidden";
  harness.context.layoutApi.setCurrentView(view);

  await harness.context.layoutApi.restoreAndTrackLayout(view);
  assert.equal(view.layoutReady, true);
  assert.equal(view.host.style.visibility, "hidden", "CSS 未加载时不能露出无样式数据");

  view.setStylesReady(true);
  assert.equal(harness.context.layoutApi.revealViewWhenReady(view), true);
  assert.equal(view.host.style.visibility, "visible");
});

test("浮层拖动后的布局会在刷新重建时恢复", async () => {
  const saved = { left: 326, top: 148, width: 420, height: 620 };
  const harness = createHarness(saved);
  const view = createView({ left: 18, top: 82, width: 420, height: 620 });
  harness.context.layoutApi.setCurrentView(view);

  await harness.context.layoutApi.restoreAndTrackLayout(view);

  assert.equal(view.host.style.left, "326px");
  assert.equal(view.host.style.top, "148px");
  assert.equal(view.panel.style.width, "420px");
  assert.equal(view.panel.style.height, "620px");
  assert.equal(harness.observers.length, 1);
});

test("后台标签页暂停布局监听，回到前台后恢复并可取消待保存任务", async () => {
  const harness = createHarness();
  const view = createView({ left: 18, top: 82, width: 420, height: 620 });
  harness.context.layoutApi.setCurrentView(view);
  harness.context.document.visibilityState = "hidden";
  await harness.context.layoutApi.restoreAndTrackLayout(view);
  assert.equal(harness.observers.length, 0);
  assert.equal(harness.context.layoutApi.revealViewWhenReady(view), false);
  harness.context.document.visibilityState = "visible";
  await harness.context.layoutApi.restoreAndTrackLayout(view);
  assert.equal(harness.observers.length, 1);
  assert.equal(view.layoutTrackingActive, true);
  harness.observers[0].callback();
  assert.equal(harness.timers.size, 1);
  view.stopLayoutTracking();
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.observers[0].disconnected, true);
  assert.equal(view.layoutTrackingActive, false);
});

test("并发恢复布局只安装一个有效的尺寸监听器", async () => {
  const harness = createHarness();
  const view = createView({ left: 18, top: 82, width: 420, height: 620 });
  harness.context.layoutApi.setCurrentView(view);
  await Promise.all([
    harness.context.layoutApi.restoreAndTrackLayout(view),
    harness.context.layoutApi.restoreAndTrackLayout(view),
  ]);
  assert.equal(harness.observers.length, 1);
});

test("隐藏到 Side Panel 时不把 0x0 左上角覆盖为已保存布局", async () => {
  const corrupted = { left: 0, top: 0, width: 0, height: 0 };
  const harness = createHarness(corrupted);
  const view = createView({ left: 762, top: 82, width: 420, height: 620 });
  harness.context.layoutApi.setCurrentView(view);

  await harness.context.layoutApi.restoreAndTrackLayout(view);
  assert.equal(view.host.style.left, "762px", "旧的 0x0 布局应被忽略并使用默认位置");
  assert.equal(view.host.style.top, "82px");

  view.host.hidden = true;
  view.host.dataset.gmgnFomoHidden = "true";
  harness.context.layoutApi.saveLayout(view);
  assert.equal(harness.writes.length, 0);

  view.host.hidden = false;
  delete view.host.dataset.gmgnFomoHidden;
  harness.context.layoutApi.saveLayout(view);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.writes[0].gmgnFomoPanelLayoutV1)),
    { left: 762, top: 82, width: 420, height: 620, collapsed: false },
  );
});

test("刷新后恢复浮层的缩小或展开形态并保留展开尺寸", async () => {
  const saved = {
    left: 615,
    top: 126,
    width: 480,
    height: 680,
    collapsed: true,
  };
  const harness = createHarness(saved);
  const view = createView({ left: 18, top: 82, width: 420, height: 620 });
  harness.context.layoutApi.setCurrentView(view);

  await harness.context.layoutApi.restoreAndTrackLayout(view);

  assert.equal(view.panel.classList.contains("collapsed"), true);
  assert.equal(view.shadow.querySelector().textContent, "+");
  assert.equal(view.host.style.left, "615px");
  assert.equal(view.host.style.top, "126px");
  assert.equal(view.panel.style.width, "480px");
  assert.equal(view.panel.style.height, "680px");

  harness.context.layoutApi.saveLayout(view);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.writes[0].gmgnFomoPanelLayoutV1)),
    { left: 615, top: 126, width: 480, height: 680, collapsed: true },
  );

  harness.context.layoutApi.setCollapsed(view, false);
  harness.context.layoutApi.keepOnScreen(view);
  harness.context.layoutApi.saveLayout(view);
  assert.equal(view.panel.classList.contains("collapsed"), false);
  assert.equal(view.shadow.querySelector().textContent, "−");
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.writes[1].gmgnFomoPanelLayoutV1)),
    { left: 615, top: 126, width: 480, height: 680, collapsed: false },
  );
});

test("移动后立即切 Token 使用最新内存坐标而不是异步存储旧值", async () => {
  const oldLayout = {
    left: 615,
    top: 126,
    width: 420,
    height: 620,
    collapsed: false,
  };
  const harness = createHarness(oldLayout);
  const firstView = createView({ left: 18, top: 82, width: 420, height: 620 });
  harness.context.layoutApi.setCurrentView(firstView);
  await harness.context.layoutApi.restoreAndTrackLayout(firstView);

  firstView.host.style.left = "188px";
  firstView.host.style.top = "247px";
  harness.context.layoutApi.saveLayout(firstView);

  const nextView = createView({ left: 762, top: 82, width: 420, height: 620 });
  const restorePromise = harness.context.layoutApi.restoreAndTrackLayout(nextView);
  harness.context.layoutApi.setCurrentView(nextView);
  await restorePromise;

  assert.equal(nextView.host.style.left, "188px");
  assert.equal(nextView.host.style.top, "247px");
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.writes[0].gmgnFomoPanelLayoutV1)),
    { left: 188, top: 247, width: 420, height: 620, collapsed: false },
  );
});

test("右侧缩小卡片切 Token 时等待缩小样式生效后再校正边界", async () => {
  const saved = {
    left: 900,
    top: 126,
    width: 420,
    height: 620,
    collapsed: true,
  };
  const harness = createHarness(saved);
  const view = createView(
    { left: 18, top: 82, width: 420, height: 620 },
    { stylesReady: false },
  );
  harness.context.layoutApi.setCurrentView(view);

  await harness.context.layoutApi.restoreAndTrackLayout(view);
  assert.equal(view.host.style.left, "900px", "不能用展开宽度把缩小卡片提前向左推");

  harness.observers[0].callback();
  const [pendingTimerId, pendingResizeCallback] = [...harness.timers.entries()][0];
  harness.timers.delete(pendingTimerId);
  pendingResizeCallback();
  assert.equal(view.host.style.left, "900px", "样式未就绪时 ResizeObserver 也不能提前校正");

  view.setStylesReady(true);
  harness.observers[0].callback();
  const resizeCallback = [...harness.timers.values()][0];
  resizeCallback();

  assert.equal(view.host.style.left, "900px");
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.writes.at(-1).gmgnFomoPanelLayoutV1)),
    { left: 900, top: 126, width: 420, height: 620, collapsed: true },
  );
});
