const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("../src/trade-delivery");

function harness(limit = 128) {
  let time = 100_000;
  let serial = 0;
  const timers = new Map();
  const events = [];
  const broker = create({ keyOf: (item) => item.id, now: () => time, limit,
    schedule: (fn, delay) => { const id = ++serial; timers.set(id, { fn, at: time + delay }); return id; },
    cancel: (id) => timers.delete(id),
    onResult: (stage, item, detail) => events.push({ stage, id: item.id, detail }),
  });
  function advance(ms) {
    const end = time + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      time = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    time = end;
  }
  const port = () => ({ messages: [], postMessage(message) { this.messages.push(message); } });
  const trade = (id) => ({ id, createdAt: time, platform: "fomo" });
  const ack = (p, index = 0) => broker.acknowledge(p, { deliveryId: p.messages[index].deliveryId, status: "accepted", reason: "ROW_RENDERED" });
  return { broker, timers, events, advance, port, trade, ack };
}

test("发送不算成功，回执只确认对应页面且停止重试", () => {
  const h = harness(), a = h.port(), b = h.port();
  h.broker.addPort(a); h.broker.addPort(b);
  h.broker.publish([h.trade("one")], "websocket");
  assert.equal(h.broker.snapshot().acknowledged, 0);
  h.broker.acknowledge(b, { deliveryId: a.messages[0].deliveryId, status: "accepted", reason: "ROW_RENDERED" });
  assert.equal(h.broker.snapshot().acknowledged, 0, "其他页面不能确认本页消息");
  h.ack(a); h.advance(6_000);
  assert.equal(a.messages.length, 1);
  assert.equal(b.messages.length, 2);
  h.ack(b); h.advance(60_000);
  assert.equal(h.broker.snapshot().acknowledged, 2);
  assert.equal(h.timers.size, 0);
});

test("页面五秒未就绪，后台仅重试三次并明确超时，空闲不留定时器", () => {
  const h = harness(), p = h.port(); h.broker.addPort(p);
  h.broker.publish([h.trade("late")], "websocket");
  h.broker.acknowledge(p, { deliveryId: p.messages[0].deliveryId, status: "unavailable" });
  h.advance(21_000);
  assert.equal(p.messages.length, 3);
  assert.equal(new Set(p.messages.map((m) => m.deliveryId)).size, 1);
  assert.equal(h.broker.snapshot().failed, 1);
  assert.equal(h.events.at(-1).detail.error, "ACK_TIMEOUT");
  assert.equal(h.timers.size, 0);
});

test("无页面时短期保留事件，新页面可重连恢复，超过成交时效不补通知", () => {
  const h = harness(); h.broker.publish([h.trade("missed")], "websocket");
  assert.equal(h.timers.size, 0);
  h.advance(2_000); const a = h.port(); h.broker.addPort(a);
  assert.equal(a.messages.length, 1); h.ack(a); h.broker.removePort(a);
  const b = h.port(); h.broker.addPort(b);
  assert.equal(b.messages.length, 1, "新文档有独立的回执与去重状态");
  h.broker.removePort(b); h.advance(60_000);
  const c = h.port(); h.broker.addPort(c); assert.equal(c.messages.length, 0);
});

test("队列有硬上限，旧事件淘汰并记录原因", () => {
  const h = harness(3), p = h.port(); h.broker.addPort(p);
  h.broker.publish([1,2,3,4,5].map((id) => h.trade(String(id))), "websocket");
  assert.equal(h.broker.snapshot().retainedCount, 3);
  assert.equal(h.broker.snapshot().pendingCount, 3);
  assert.equal(h.events.filter((e) => e.detail.error === "QUEUE_FULL").length, 2);
  h.broker.clear(); assert.equal(h.timers.size, 0);
});

test("重复上游事件不重发，metadata 可补充后续重试而不制造新交易", () => {
  const h = harness(), p = h.port(); h.broker.addPort(p); const item = h.trade("one");
  h.broker.publish([item, item], "websocket");
  h.broker.publish([item], "websocket"); assert.equal(p.messages.length, 1);
  h.broker.metadata([{ ...item, totalSupply: 1000 }]);
  assert.equal(p.messages[1].type, "gmgnFollowTradeMetadata");
  h.advance(6_000); assert.equal(p.messages[2].item.totalSupply, 1000);
  h.ack(p); assert.equal(h.timers.size, 0);
});

test("推送关闭、取消关注和账号切换可撤销待投递与重连重放", () => {
  const h = harness(), p = h.port(); h.broker.addPort(p);
  h.broker.publish([h.trade("cancelled"), h.trade("keep")], "websocket");
  h.broker.discard((item) => item.id === "cancelled");
  const next = h.port(); h.broker.addPort(next);
  assert.deepEqual(next.messages.map((m) => m.item.id), ["keep"]);
  h.broker.clear(); h.advance(60_000);
  assert.equal(p.messages.filter((m) => m.type === "gmgnFollowTradeEvent").length, 2);
  assert.equal(h.timers.size, 0);
});

test("过期和远未来事件不会进入队列", () => {
  const h = harness(), p = h.port(); h.broker.addPort(p);
  h.broker.publish([{ ...h.trade("old"), createdAt: 1 }, { ...h.trade("future"), createdAt: 200_000 }], "websocket");
  assert.equal(p.messages.length, 0); assert.equal(h.timers.size, 0);
});

test("同一标签页刷新后不会重新通知已确认事件，未确认事件可以重送", () => {
  const h = harness(), first = h.port(); h.broker.addPort(first, 42);
  h.broker.publish([h.trade("acked"), h.trade("pending")], "websocket");
  h.ack(first); h.broker.removePort(first);
  const next = h.port(); h.broker.addPort(next, 42);
  assert.deepEqual(next.messages.map((m) => m.item.id), ["pending"]);
  h.broker.clear();
});

test('入队、无页面、过期、重复及页面拒绝都输出可关联的原因', () => {
  const h = harness();
  const item = h.trade('no-page');
  h.broker.publish([item], 'websocket');
  assert.equal(h.events.at(-1).detail.reason, 'NO_GMGN_PORT');
  h.broker.publish([item], 'websocket');
  assert.equal(h.events.at(-1).detail.reason, 'DUPLICATE_EVENT');
  const p = h.port(); h.broker.addPort(p, 42);
  h.broker.acknowledge(p, { deliveryId: p.messages[0].deliveryId, status: 'unavailable',
    reason: 'CHAIN_NOT_SUBSCRIBED', routeChain: 'sol' });
  assert.equal(h.events.at(-1).detail.reason, 'CHAIN_NOT_SUBSCRIBED');
  assert.equal(h.events.at(-1).detail.consumerId, 42);
  h.broker.publish([{ ...h.trade('expired'), createdAt: 1 }], 'websocket');
  assert.equal(h.events.at(-1).detail.reason, 'EVENT_EXPIRED');
  h.broker.clear();
});


test("提交和解码只记录进度，未渲染持续重试，渲染后停止并单独存证", () => {
  const h = harness(), p = h.port(); h.broker.addPort(p);
  h.broker.publish([h.trade("render-check")], "websocket");
  const deliveryId = p.messages[0].deliveryId;
  for (const status of ["submitted", "decoded"]) h.broker.acknowledge(p, { deliveryId, status });
  assert.equal(h.broker.snapshot().acknowledged, 0);
  h.advance(6000);
  assert.equal(p.messages.length, 2);
  h.broker.acknowledge(p, { deliveryId, status: "accepted", reason: "ROW_RENDERED" });
  h.advance(60000);
  assert.equal(p.messages.length, 2);
  assert.equal(h.broker.snapshot().acknowledged, 1);
  assert.ok(h.events.find((e) => e.stage === "gmgn-native-decoded"));
  assert.ok(h.events.find((e) => e.stage === "gmgn-row-rendered"));
});


test("旧入口 accepted 不能冒充渲染成功；已解码但未观察到行单独结束而不重放通知", () => {
  const h = harness(), p = h.port(); h.broker.addPort(p);
  h.broker.publish([h.trade("legacy")], "websocket");
  const deliveryId = p.messages[0].deliveryId;
  h.broker.acknowledge(p, { deliveryId, status: "accepted" });
  assert.equal(h.broker.snapshot().acknowledged, 0);
  assert.equal(h.events.at(-1).detail.reason, "LEGACY_ENTRY_ACK");
  h.broker.acknowledge(p, { deliveryId, status: "decoded" });
  h.broker.acknowledge(p, { deliveryId, status: "unverified", reason: "NATIVE_DECODED_ROW_NOT_OBSERVED" });
  h.advance(60000);
  assert.equal(p.messages.length, 1);
  assert.equal(h.broker.snapshot().failed, 0);
  assert.equal(h.broker.snapshot().unverified, 1);
  assert.equal(h.events.at(-1).stage, "gmgn-event-unverified");
});
