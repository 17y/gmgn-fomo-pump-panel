const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("Offscreen 文档把地址写入系统剪贴板并返回成功", async () => {
  let listener;
  let copied = "";
  const context = {
    // Isolated instrumentation branch coverage; public config is tested separately.
    GmgnRuntimeConfig: { localDiagnostics: true },
    chrome: {
      runtime: {
        onMessage: { addListener(value) { listener = value; } },
      },
    },
    document: {
      body: { append() {} },
      createElement() {
        return { remove() {}, select() {}, style: {}, value: "" };
      },
      execCommand() { return false; },
    },
    navigator: {
      clipboard: {
        async writeText(value) { copied = value; },
      },
    },
    TextDecoder,
    TextEncoder,
    URL,
    clearInterval,
    clearTimeout,
    setInterval,
    setTimeout,
  };
  vm.runInNewContext(fs.readFileSync("src/offscreen.js", "utf8"), context);

  const response = await new Promise((resolve) => {
    const pending = listener({
      target: "offscreen",
      type: "copyToClipboard",
      text: "0x2222222222222222222222222222222222222222",
    }, {}, resolve);
    assert.equal(pending, true);
  });

  assert.equal(response.ok, true);
  assert.equal(copied, "0x2222222222222222222222222222222222222222");
});

for (const suffix of ["instance-1", "*"]) {
test(`Offscreen NATS presence ${suffix} 订阅完整回传匹配的 Alerts 事件`, async () => {
  let listener;
  const runtimeMessages = [];
  const sockets = [];
  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }

    send(value) { this.sent.push(String(value)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
    receive(value) {
      const bytes = new TextEncoder().encode(value);
      this.onmessage?.({ data: bytes.buffer });
    }
  }
  const context = {
    // Isolated instrumentation branch coverage; public config is tested separately.
    GmgnRuntimeConfig: { localDiagnostics: true },
    WebSocket: FakeWebSocket,
    chrome: {
      runtime: {
        id: "extension-id",
        async sendMessage(message) {
          runtimeMessages.push(message);
          return { ok: true, accepted: message.type === "pumpNatsAlertEvent" };
        },
        onMessage: { addListener(value) { listener = value; } },
      },
    },
    document: {
      body: { append() {} },
      createElement() { return { remove() {}, select() {}, style: {}, value: "" }; },
      execCommand() { return false; },
    },
    navigator: { clipboard: { async writeText() {} } },
    TextDecoder,
    TextEncoder,
    URL,
    clearInterval() {},
    clearTimeout() {},
    setInterval() { return 1; },
    setTimeout() { return 1; },
  };
  vm.runInNewContext(fs.readFileSync("src/offscreen.js", "utf8"), context);
  const subject = "alertsFeed.user.viewer-user.instance-1";
  const subscription = `alertsFeed.user.viewer-user.${suffix}`;
  const event = {
    id: "event-1",
    kind: "trade",
    createdAt: "2026-09-04T08:30:00.000Z",
    trade: { tx: "tx-1", isBuy: true, amountUsd: 25 },
  };

  const pending = listener({
    target: "offscreen",
    type: "configurePumpNats",
    diagnosticsEnabled: true,
    config: {
      server: "wss://prod-v2.nats.realtime.pump.fun",
      user: "subscriber",
      pass: "public-read-password",
      pingInterval: 5_000,
    },
    subjects: [subscription],
  }, {}, () => {});
  assert.equal(pending, false);
  assert.equal(sockets.length, 1);

  sockets[0].open();
  sockets[0].receive('INFO {"server_id":"test"}\r\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(sockets[0].sent.join(""), /CONNECT /);
  assert.match(sockets[0].sent.join(""), /PING\r\n/);

  sockets[0].receive("PONG\r\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets[0].sent.join("").includes(`SUB ${subscription} 1\r\n`), true);
  const payload = JSON.stringify(event);
  sockets[0].receive(`MSG ${subject} 1 ${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(runtimeMessages.at(-1))), {
    type: "pumpNatsAlertEvent",
    event,
  });
  const received = runtimeMessages.length;
  for (const unrelated of [
    "alertsFeed.user.other-user.instance-1",
    "alertsFeed.user.viewer-user.instance-1.extra",
    "alertsFeed.user.viewer-user.*",
  ]) {
    sockets[0].receive(`MSG ${unrelated} 1 ${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimeMessages.length, received, "通配符不能扩大到其他账号、多层 subject 或发布通配符");
  if (suffix !== "*") {
    sockets[0].receive(`MSG alertsFeed.user.viewer-user.other-instance 1 ${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtimeMessages.length, received, "精确订阅不能被当作通配订阅");
  }

  function diagnostics(type = "getPumpNatsDiagnostics", enabled) {
    let result;
    listener({ target: "offscreen", type, enabled }, { id: "extension-id" }, (value) => { result = value; });
    return result.diagnostic;
  }
  const before = diagnostics();
  assert.equal(before.revision, "pump-receive-v2");
  assert.equal(before.wildcardSubscription, suffix === "*");
  assert.equal(before.counters.forwarded, 1);
  assert.equal(before.counters.backgroundAccepted, 1);
  assert.equal(before.counters.subjectRejected, suffix === "*" ? 3 : 4);

  // Fragmented payloads are counted once only after the complete NATS frame.
  sockets[0].receive(`MSG ${subject} 1 1\r\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(diagnostics().counters.messages, before.counters.messages);
  sockets[0].receive("{\r\n");
  sockets[0].receive(`MSG ${subject} 1 4\r\nnull\r\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(diagnostics().counters.invalidJson, 1);
  assert.equal(diagnostics().counters.invalidPayload, 1);
  assert.equal(diagnostics().counters.messages, before.counters.messages + 2);
  const diagnosticText = JSON.stringify(diagnostics());
  for (const secret of [subscription, "public-read-password", event.id, event.trade.tx]) {
    assert.equal(diagnosticText.includes(secret), false);
  }
  diagnostics("setPumpNatsDiagnostics", false);
  sockets[0].receive(`MSG ${subject} 1 ${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(diagnostics().counters), "{}", "关闭诊断必须清除并停止采集");
  assert.equal(runtimeMessages.at(-1).type, "pumpNatsAlertEvent", "诊断开关不能阻断推送");
  diagnostics("setPumpNatsDiagnostics", true);
  assert.equal(diagnostics().counters.messages, undefined, "重新开启不能混入上次采集");
});
}
