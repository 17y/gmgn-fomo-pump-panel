const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../src/core');
const source = fs.readFileSync('src/background.js', 'utf8');
const constants = source.slice(0, source.indexOf('const sidePanelPortsByWindow'))
  .split('\n').filter(line => line.startsWith('const ')).join('\n');
const block = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const address = i => `0x${i.toString(16).padStart(40, '0')}`;
const token = i => ({ address: address(i), networkId: 56 });

function harness() {
  let now = 0, uuid = 0, authorization = 'test-only';
  const pages = new Map(), listeners = new Map(), snapshots = new Map();
  const page = tabId => {
    if (!pages.has(tabId)) {
      const events = new Map(); listeners.set(tabId, events);
      const target = { addEventListener(type, fn) { events.set(type, fn); } };
      pages.set(tabId, vm.createContext({ location: { origin: 'https://gmgn.ai', pathname: `/bsc/token/${address(1)}` },
        crypto: { randomUUID: () => `visit-${++uuid}` }, window: { ...target, navigation: target } }));
    }
    return pages.get(tabId);
  };
  const context = vm.createContext({
    Date: { now: () => now }, GmgnFomoCore: core, detailVisitsByTab: snapshots,
    tokenCacheId: p => `${p.networkId}:${p.address}`,
    getSession: async () => ({ authorization }),
    chrome: { scripting: { async executeScript(details) {
      const c = page(details.target.tabId); c.args = details.args;
      return [{ result: vm.runInContext(`(${details.func})(...args)`, c) }];
    } } },
  });
  vm.runInContext(constants + block('function cacheValueWeight(', 'function cacheFomoReadResult(') +
    block('async function detailVisit(', 'async function queryFomoFeed(') +
    block('function invalidateDetailFollowStates(', 'async function queryHolderFollowStates('), context);
  return { context, snapshots,
    advance: ms => { now += ms; },
    auth(value) { authorization = value; },
    route(tabId, path) { page(tabId).location.pathname = path; listeners.get(tabId).get('navigatesuccess')?.(); },
    reload(tabId) { pages.delete(tabId); },
    query(p, loader, { tabId = 1, name = 'token', force = false } = {}) {
      return context.queryDetailPart(p, {}, { oncePerVisit: true, tabId, force }, name, loader);
    },
  };
}

test('overlay and side panel share one detail read across arbitrary idle time; refresh and re-entry fetch', async () => {
  const h = harness(); let calls = 0;
  const read = async () => ({ ok: true, value: ++calls });
  assert.equal((await h.query(token(1), read)).value, 1);
  h.advance(60 * 60_000);
  assert.equal((await h.query(token(1), read)).value, 1);
  assert.equal(calls, 1);
  assert.equal((await h.query(token(1), read, { force: true })).value, 2);
  h.route(1, '/'); h.route(1, `/bsc/token/${address(1)}`);
  assert.equal((await h.query(token(1), read)).value, 3);
  h.reload(1);
  assert.equal((await h.query(token(1), read)).value, 4);
  assert.equal(h.snapshots.size, 1);
});

test('concurrent surfaces share pending results and each detail section is requested separately', async () => {
  const h = harness(); let calls = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const read = () => { calls++; return pending; };
  const a = h.query(token(1), read), b = h.query(token(1), read);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  release({ ok: true, value: 7 }); await Promise.all([a, b]);
  await h.query(token(1), async () => ({ ok: true }), { name: 'follow' });
  h.advance(60_000);
  await h.query(token(1), () => { throw new Error('REDUNDANT_FOLLOW_READ'); }, { name: 'follow' });
  h.context.invalidateDetailFollowStates();
  assert.equal((await h.query(token(1), async () => ({ ok: true, changed: true }), { name: 'follow' })).changed, true);
  await h.query(token(1), async () => ({ ok: true }), { name: 'feed' });
  await h.query(token(1), async () => ({ ok: true }), { force: true });
  assert.equal(h.snapshots.get(1).parts.has('feed'), false);
});

test('rapid routes replace the same snapshot; tab count, retained weight, and individual entries are bounded', async () => {
  const h = harness();
  for (let i = 1; i <= 1000; i++) {
    h.route(1, `/bsc/token/${address(i)}`);
    await h.query(token(i), async () => ({ ok: true, item: i }));
    assert.equal(h.snapshots.size, 1);
  }
  for (let tabId = 1; tabId <= 100; tabId++) {
    h.route(tabId, `/bsc/token/${address(1)}`);
    for (const name of ['token', 'follow', 'pump']) await h.query(token(1),
      async () => ({ ok: true, padding: 'x'.repeat(70_000) }), { tabId, name });
    assert.ok(h.snapshots.size <= 8);
    const weight = [...h.snapshots.values()].flatMap(visit => [...visit.parts.values()])
      .reduce((sum, entry) => sum + entry.weight, 0);
    assert.ok(weight <= 2 * 1024 * 1024);
  }
  const huge = { ok: true, padding: 'x'.repeat(300_000) };
  h.route(101, `/bsc/token/${address(1)}`);
  assert.equal((await h.query(token(1), async () => huge, { tabId: 101 })).padding, huge.padding);
  assert.equal(h.snapshots.get(101).parts.get('token').result, null);
});

test('account changes invalidate snapshots and mismatched page routes make no request', async () => {
  const h = harness(); let calls = 0;
  const read = async () => ({ ok: true, count: ++calls });
  await h.query(token(1), read); h.auth('different-test-account');
  await h.query(token(1), read); assert.equal(calls, 2);
  await assert.rejects(h.query(token(2), read), /DETAIL_ROUTE_CHANGED/);
  assert.equal(calls, 2);
});
