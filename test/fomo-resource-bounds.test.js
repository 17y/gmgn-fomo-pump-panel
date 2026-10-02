const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/background.js', 'utf8');
const block = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
};
const constants = source.slice(0, source.indexOf('const sidePanelPortsByWindow'))
  .split('\n').filter(line => line.startsWith('const ')).join('\n');
const cacheFunctions = block('function setBoundedCache(', 'function getResolvedHolderAddress(');
const flush = () => new Promise(resolve => setImmediate(resolve));

function readHarness() {
  let now = 0, requests = 0, response = { responseObject: [] };
  const timers = new Map();
  const c = vm.createContext({
    URL, AbortController, Date: { now: () => now },
    setTimeout(fn) { const id = {}; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    fomoBackoffReady: Promise.resolve(), fomoRateLimitUntil: 0, fomoRejectedAuthorization: '',
    fomoReadCache: new Map(), fomoReadFailures: new Map(), fomoReadRequests: new Map(),
    isFomoAuthError: () => false, recordFomoApiRequestDiagnostic() {},
    fetch: async (_url, options) => {
      requests++;
      return response === 'blocked' ? new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      }) : { ok: true, status: 200, json: async () => response };
    },
  });
  vm.runInContext(constants + cacheFunctions + block('async function fetchJson(', 'function isPumpPresenceMutation('), c);
  return {
    c, timers, requests: () => requests, advance: ms => { now += ms; },
    response: value => { response = value; },
    read: (id, options = {}) => c.fetchJson({ method: 'GET', url: `https://synthetic.invalid/${id}`, ...options }, { authorization: 'synthetic', supportedChains: '56' }),
    weight: () => [...c.fomoReadCache.values()].reduce((sum, entry) => sum + entry.weight, 0),
    budget: vm.runInContext('FOMO_READ_CACHE_BUDGET', c),
  };
}

test('Fomo raw cache respects both weight and count limits and returns oversized responses intact', async () => {
  const h = readHarness();
  const big = { padding: 'x'.repeat(262144), businessValue: 123 };
  h.response(big);
  assert.equal(await h.read('big'), big);
  assert.equal(h.c.fomoReadCache.size, 0);
  assert.equal(h.c.fomoReadRequests.size, 0);
  h.response({ padding: 'x'.repeat(48000) });
  for (let i = 0; i < 1000; i++) {
    await h.read(i);
    assert.ok(h.weight() <= h.budget);
    assert.ok(h.c.fomoReadCache.size <= 128);
  }
  const before = h.requests();
  await h.read(999);
  assert.equal(h.requests(), before, 'fresh latest entry is reused');
  await h.read(0);
  assert.equal(h.requests(), before + 1, 'evicted data is fetched normally');
  h.advance(1001);
  h.response({ small: true });
  await h.read('after-expiry');
  assert.equal(h.c.fomoReadCache.size, 1);
  assert.equal(h.timers.size, 0);
  for (let i = 0; i < 1000; i++) await h.read(`small-${i}`);
  assert.equal(h.c.fomoReadCache.size, 128);
});

test('Fomo bounded weight walk stops on oversized and deeply nested values', () => {
  const h = readHarness();
  let visits = 0;
  const value = { oversized: 'x'.repeat(262144), get next() { visits++; return 'unused'; } };
  assert.equal(h.c.cacheValueWeight(value, 262144), Infinity);
  assert.equal(visits, 0);
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(h.c.cacheValueWeight(cyclic, 262144), Infinity);
});

test('Fomo slow reads deduplicate and abort releases all in-flight entries and timers', async () => {
  const h = readHarness();
  h.response('blocked');
  const results = Promise.allSettled(Array.from({ length: 80 }, (_, i) => h.read(i % 40)));
  await flush();
  assert.equal(h.requests(), 40);
  assert.equal(h.c.fomoReadRequests.size, 40);
  for (const fn of [...h.timers.values()]) fn();
  assert.ok((await results).every(result => result.reason?.message === 'FOMO_REQUEST_TIMEOUT'));
  assert.equal(h.c.fomoReadRequests.size, 0);
  assert.equal(h.c.fomoReadCache.size, 0);
  assert.equal(h.timers.size, 0);
});

function writeHarness() {
  let release, fail = false;
  const gate = new Promise(resolve => { release = resolve; });
  const writes = [], pending = new Map();
  const c = vm.createContext({
    tokenCacheWritePromise: null, tokenCachePendingWrites: pending,
    tokenCacheId: params => `${params.networkId}:${params.address}`,
    async writeTokenCacheEntry(params, data) {
      writes.push({ params, data });
      await gate;
      if (fail) { fail = false; throw new Error('synthetic-storage-error'); }
    },
  });
  vm.runInContext(constants + block('function cacheToken(', 'function fomoRetryAfterMs('), c);
  return { c, writes, pending, release, failOnce() { fail = true; },
    put: (id, version) => c.cacheToken({ networkId: 56, address: String(id) }, { version }) };
}

test('slow token storage coalesces 1000 same-token updates to the latest pending snapshot', async () => {
  const h = writeHarness();
  const first = h.put('same', 0);
  await flush();
  const rest = Array.from({ length: 1000 }, (_, i) => h.put('same', i + 1));
  assert.equal(h.writes.length, 1);
  assert.equal(h.pending.size, 1);
  assert.equal(new Set(rest).size, 1, 'one shared waiter per pending token');
  h.release();
  await Promise.all([first, ...rest]);
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes.at(-1).data.version, 1000);
  assert.equal(h.pending.size, 0);
});

test('slow token storage bounds distinct pending tokens and keeps the newest 50', async () => {
  const h = writeHarness();
  const first = h.put('active', 0);
  await flush();
  const rest = Array.from({ length: 1000 }, (_, i) => h.put(i, i));
  assert.equal(h.pending.size, 50);
  assert.equal(h.writes.length, 1);
  h.release();
  await Promise.all([first, ...rest]);
  assert.equal(h.writes.length, 51);
  assert.deepEqual(h.writes.slice(1).map(entry => entry.data.version), Array.from({ length: 50 }, (_, i) => i + 950));
  assert.equal(h.pending.size, 0);
});

test('token storage failure settles affected callers and does not block later tokens', async () => {
  const h = writeHarness();
  h.failOnce();
  const first = h.put('failed', 1);
  const result = assert.rejects(first, /synthetic-storage-error/);
  await flush();
  const second = h.put('next', 2);
  h.release();
  await Promise.all([result, second]);
  await flush();
  await h.put('later', 3);
  assert.equal(h.writes.length, 3);
  assert.equal(h.pending.size, 0);
});

function historyHarness() {
  let items = [], release, fail = false;
  const gate = new Promise(resolve => { release = resolve; });
  const writes = [];
  const c = vm.createContext({
    Date, followedTradesCacheWritePromise: Promise.resolve(), followedTradesCacheNextWrite: null,
    followedTradesCachePendingWrite: null, followedTradesCacheFingerprint: '',
    followedTradesHistoryItems: () => items,
    followedTradesFingerprint: value => JSON.stringify(value),
    chrome: { storage: { local: { async set(value) {
      writes.push(value.followedTradesCacheV1.items);
      await gate;
      if (fail) { fail = false; throw new Error('synthetic-storage-error'); }
    } } } },
  });
  vm.runInContext(constants + block('function persistFollowedTradesHistory(', 'function rememberFollowedTrades('), c);
  return { c, writes, release, failOnce() { fail = true; }, put(next) { items = next; return c.persistFollowedTradesHistory(); } };
}

test('slow history storage retains only the active and latest complete snapshots', async () => {
  const h = historyHarness();
  const first = h.put([{ id: 'original' }]);
  await flush();
  const updates = Array.from({ length: 1000 }, (_, i) => h.put([{ id: 'original' }, { id: `trade-${i}` }]));
  assert.equal(new Set(updates).size, 1);
  assert.equal(h.writes.length, 1);
  h.release();
  await Promise.all([first, ...updates]);
  assert.equal(h.writes.length, 2);
  assert.deepEqual(h.writes[1], [{ id: 'original' }, { id: 'trade-999' }]);
  await h.put(h.writes[1]);
  assert.equal(h.writes.length, 2, 'unchanged final history is not rewritten');
  assert.equal(h.c.followedTradesCachePendingWrite, null);
  assert.equal(h.c.followedTradesCacheNextWrite, null);
});

test('history storage recovers after a failed write without losing a newer snapshot', async () => {
  const h = historyHarness();
  h.failOnce();
  const first = h.put([{ id: 'first' }]);
  const failure = assert.rejects(first, /synthetic-storage-error/);
  await flush();
  const second = h.put([{ id: 'first' }, { id: 'second' }]);
  h.release();
  await Promise.all([failure, second]);
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes.at(-1).length, 2);
  h.failOnce();
  await assert.rejects(h.put([{ id: 'third' }]), /synthetic-storage-error/);
  await h.put([{ id: 'third' }]);
  assert.equal(h.writes.length, 4, 'same snapshot is retried after failure');
});

test('blocked optional diagnostic storage retains only the newest 300 pending events', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let stored = {};
  const c = vm.createContext({
    Date, GmgnRuntimeConfig: { localDiagnostics: true }, followedTradesDiagnosticsEnabled: true, followedTradesPipelinePendingEvents: [],
    followedTradesPipelineFlushScheduled: false, followedTradesPipelineWrite: Promise.resolve(),
    tradeReceipts: { record() { return false; } }, diagnosticTradeRef: item => item,
    sanitizeFollowedTradePipelineDetail: detail => detail,
    chrome: { storage: { local: {
      async get() { await gate; return { followedTradesPipelineV1: stored }; },
      async set(value) { stored = value.followedTradesPipelineV1; },
    } } },
  });
  vm.runInContext(constants + block('function recordFollowedTradePipeline(', 'async function '), c);
  c.recordFollowedTradePipeline('initial', []);
  await flush();
  for (let i = 0; i < 10000; i++) c.recordFollowedTradePipeline(`event-${i}`, []);
  assert.equal(c.followedTradesPipelinePendingEvents.length, 300);
  release();
  await c.followedTradesPipelineWrite;
  assert.equal(stored.events.length, 300);
  assert.equal(stored.events[0].stage, 'event-9700');
  assert.equal(stored.events.at(-1).stage, 'event-9999');
  assert.equal(c.followedTradesPipelinePendingEvents.length, 0);
});

test('GMGN metadata burst bounds queued keys, batches, timers, and releases them after completion', async () => {
  const timers = new Map(), gates = [], queue = new Map(), pending = new Map();
  const starts = [];
  let calls = 0, now = 0;
  const c = vm.createContext({
    Date: { now: () => now }, gmgnMetadataLastBatchAt: -Infinity, followedTradesEnabled: true, fomoMetadataQueue: queue, fomoFollowedMetadataRequests: pending,
    fomoMetadataBatchTimer: null, fomoMetadataBatchesRunning: 0,
    fomoMetadataMisses: new Map(), fomoFollowedMetadataCache: new Map(),
    GmgnFomoCore: require('../src/core'), GmgnFomoApi: require('../src/fomo-api'),
    setTimeout(fn, delay) { const id = {}; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetchGmgnTradeMetadata(items) {
      calls++;
      starts.push(now);
      assert.ok(items.length <= 50);
      return new Promise(resolve => gates.push(() => resolve([])));
    },
  });
  vm.runInContext(constants + cacheFunctions + block('function isFomoAuthError(', 'function withCachedFomoFollowedTradesMetadata('), c);
  const session = { authorization: 'synthetic', supportedChains: '56' };
  const item = i => ({ tokenAddress: `0x${i.toString(16).padStart(40, '0')}`, networkId: 56, unusedLargeField: 'do not retain this trade in the queue' });
  const requests = [];
  const submit = (start, count) => {
    for (let i = start; i < start + count; i++) requests.push(c.queryFomoTradeMetadata(item(i), session));
  };
  const runTimers = () => { for (const [id, timer] of [...timers]) { timers.delete(id); now += timer.delay; timer.fn(); } };
  submit(1, 10000);
  assert.equal(queue.size, 512);
  assert.equal(pending.size, 512);
  assert.equal(timers.size, 1);
  assert.equal(queue.values().next().value.item.unusedLargeField, undefined);
  runTimers(); runTimers();
  assert.equal(calls, 1);
  assert.equal(c.fomoMetadataBatchesRunning, 1);
  submit(10001, 1000);
  assert.equal(queue.size, 512);
  assert.equal(pending.size, 562, '512 waiting plus one active batch of 50');
  assert.equal(timers.size, 0, 'no polling timer while the single slot is busy');
  assert.equal(c.queryFomoTradeMetadata(item(1), session), requests[0]);
  while (pending.size) {
    gates.splice(0).forEach(resolve => resolve());
    await flush();
    runTimers();
    assert.ok(c.fomoMetadataBatchesRunning <= 1);
  }
  await Promise.all(requests);
  assert.equal(queue.size, 0);
  assert.equal(c.fomoMetadataBatchesRunning, 0);
  assert.equal(c.fomoMetadataMisses.size, 512);
  assert.equal(timers.size, 0);
  assert.ok(starts.length > 2);
  assert.ok(starts.slice(1).every((at, i) => at - starts[i] >= 5000), 'batches start at least five seconds apart');
});

test('Feed grace timer is omitted for Holders and cleared when Feed returns early', async () => {
  const timers = new Set(); let scheduled = 0;
  const c = vm.createContext({
    Date, getSession: async () => ({ authorization: 'synthetic' }), getCachedToken: async () => null,
    fetchJson: async () => ({}), cacheToken: async () => {},
    fomoFollowedMetadataCache: new Map(),
    GmgnFomoApi: {
      buildRequests: () => ({ feed: {}, metadata: {}, holders: {} }),
      sanitizeMetadata: () => ({ totalSupply: 1 }), sanitizeHolders: () => ({ items: [] }),
      sanitizeFollowedTradesMetadata: () => [], sanitizeFeed: () => [],
    },
    setTimeout() { const id = {}; timers.add(id); scheduled++; return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(constants + block('async function queryFomoToken(', 'function queryFomoTokenShared('), c);
  assert.equal((await c.queryFomoToken({}, true, { includeFeed: false })).ok, true);
  assert.equal(scheduled, 0);
  assert.equal((await c.queryFomoToken({}, true, { includeFeed: true })).ok, true);
  assert.equal(scheduled, 1);
  assert.equal(timers.size, 0);
});
