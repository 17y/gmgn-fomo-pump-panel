const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const subject = 'alertsFeed.user.synthetic.instance';
const tick = () => new Promise(resolve => setImmediate(resolve));
function frame(event) {
  const body = JSON.stringify(event);
  return new TextEncoder().encode(`MSG ${subject} 1 ${Buffer.byteLength(body)}\r\n${body}\r\n`);
}

function receiver() {
  const allocation = { bytes: 0 };
  class CountedBytes extends Uint8Array {
    constructor(...args) {
      super(...args);
      // subarray and ArrayBuffer constructors are views, not new backing memory.
      if (typeof args[0] === 'number' || ArrayBuffer.isView(args[0]) || Array.isArray(args[0])) {
        allocation.bytes += this.byteLength;
      }
    }
  }
  const messages = [];
  const sockets = [];
  const timers = new Map();
  let timerId = 0;
  let listener;
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 1; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(value); }
    close() { this.readyState = 3; this.onclose?.(); }
    receive(bytes) {
      // Model an exact WebSocket ArrayBuffer; input allocation is not parser work.
      const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
      this.onmessage?.({ data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
    }
  }
  const context = {
    // Isolated instrumentation branch coverage; public config is tested separately.
    GmgnRuntimeConfig: { localDiagnostics: true },
    Uint8Array: CountedBytes, ArrayBuffer, TextEncoder, TextDecoder, URL, WebSocket: Socket,
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return 1; }, clearInterval() {},
    chrome: { runtime: {
      id: 'fixture', onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage(message) { messages.push(message); return { ok: true, accepted: true }; },
    } },
  };
  const source = fs.readFileSync('src/offscreen.js', 'utf8');
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, `
    globalThis.pendingState = () => ({ length: pumpNatsReceiveBuffer.length,
      backingBytes: pumpNatsReceiveBuffer.buffer.byteLength });
  })();`), context);
  listener({ target: 'offscreen', type: 'configurePumpNats', diagnosticsEnabled: true,
    config: { server: 'wss://prod-v2.nats.realtime.pump.fun', token: 'synthetic-fixture' },
    subjects: [subject],
  }, {}, () => {});
  return {
    allocation, sockets, messages, timers,
    events: () => messages.filter(x => x.type === 'pumpNatsAlertEvent').map(x => JSON.parse(JSON.stringify(x.event))),
    pending: () => context.pendingState(),
    diagnostic() {
      let result;
      listener({ target: 'offscreen', type: 'getPumpNatsDiagnostics' }, { id: 'fixture' }, x => { result = x.diagnostic; });
      return result;
    },
  };
}

test('Pump coalesced batches allocate linear byte storage, including batches above the per-frame limit', async t => {
  const event = { kind: 'trade', synthetic: 'x'.repeat(2000) };
  const single = frame(event);
  for (const count of [1, 10, 100, 500, 2500]) {
    const r = receiver();
    const batch = new Uint8Array(single.length * count);
    for (let i = 0; i < count; i++) batch.set(single, i * single.length);
    r.sockets[0].receive(batch);
    await tick();
    assert.equal(r.events().length, count);
    assert.deepEqual(r.events()[count - 1], event);
    assert.ok(r.allocation.bytes <= batch.length * 2, `${r.allocation.bytes} bytes allocated for ${batch.length} input bytes`);
    assert.equal(r.pending().backingBytes, 0, 'fully drained batches must release their buffers');
    assert.equal(r.sockets[0].readyState, 1);
    t.diagnostic(JSON.stringify({ messages: count, inputBytes: batch.length, parserAllocatedBytes: r.allocation.bytes }));
  }
});

test('Pump preserves message order across split headers, UTF-8 bytes, trailers and PING', async () => {
  const r = receiver();
  const first = frame({ id: 1, text: '中文交易😀' });
  const next = frame({ id: 2 });
  const data = Buffer.concat([first, Buffer.from('PING\r\n'), next]);
  for (const byte of data) r.sockets[0].receive(Uint8Array.of(byte));
  await tick();
  assert.deepEqual(r.events(), [{ id: 1, text: '中文交易😀' }, { id: 2 }]);
  assert.deepEqual(r.sockets[0].sent, ['PONG\r\n']);
  assert.equal(r.pending().backingBytes, 0);
});

test('Pump grows a heavily fragmented valid payload geometrically', async () => {
  const r = receiver();
  const event = { id: 1, text: 'x'.repeat(1024 * 1024) };
  const data = frame(event);
  for (let i = 0; i < data.length; i += 257) {
    r.sockets[0].receive(data.subarray(i, i + 257));
    await tick();
  }
  assert.deepEqual(r.events(), [event]);
  assert.ok(r.allocation.bytes < data.length * 4, `fragment copies: ${r.allocation.bytes}`);
  assert.equal(r.pending().backingBytes, 0);
});

test('Pump releases a large completed batch while retaining only its incomplete tail', async () => {
  const r = receiver();
  const single = frame({ id: 1 });
  const data = Buffer.concat([...Array(10000).fill(single), Buffer.from('MSG ')]);
  r.sockets[0].receive(data);
  await tick();
  assert.equal(r.events().length, 10000);
  assert.equal(r.pending().length, 4);
  assert.ok(r.pending().backingBytes <= 65536);
  r.sockets[0].receive(`${subject} 1 8\r\n{"id":2}\r\n`);
  await tick();
  assert.deepEqual(r.events().at(-1), { id: 2 });
  assert.equal(r.pending().backingBytes, 0);
});

for (const [name, invalid] of [
  ['oversized declared payload', `MSG ${subject} 1 4194305\r\n`],
  ['unsafe integer size', `MSG ${subject} 1 9007199254740992\r\n`],
  ['unterminated header', 'X'.repeat(100000)],
  ['invalid trailer', `MSG ${subject} 1 2\r\n{}XX`],
  ['unsupported headers', `HMSG ${subject} 1 8 8\r\nPING\r\n\r\n\r\n`],
]) {
  test(`Pump bounds ${name}, discards queued data from the closed socket and reconnects`, async () => {
    const r = receiver();
    const socket = r.sockets[0];
    socket.receive(invalid);
    socket.receive(frame({ stale: true }));
    await tick();
    assert.equal(socket.readyState, 3);
    assert.equal(r.pending().backingBytes, 0);
    assert.equal(r.events().length, 0);
    assert.equal(r.diagnostic().counters.invalidFrames, 1);
    assert.equal(r.timers.size, 1, 'exactly one reconnect is scheduled');
    [...r.timers.values()][0]();
    assert.equal(r.sockets.length, 2);
    r.sockets[1].receive(frame({ recovered: true }));
    await tick();
    assert.deepEqual(r.events(), [{ recovered: true }]);
  });
}

test('Pump remote close invalidates queued byte decoding', async () => {
  const r = receiver();
  r.sockets[0].receive(frame({ stale: true }));
  r.sockets[0].close();
  await tick();
  assert.equal(r.events().length, 0);
  assert.equal(r.pending().backingBytes, 0);
});
