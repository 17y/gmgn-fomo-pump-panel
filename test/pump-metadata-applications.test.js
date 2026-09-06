const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/background.js', 'utf8');
const block = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const flush = () => new Promise(resolve => setImmediate(resolve));
const metadata = {symbol: 'FIXTURE', name: 'Synthetic', image_uri: 'https://example.invalid/fixture.png',
  usd_market_cap: 1000, total_supply: 1000000, decimals: 0};
const trade = (id, token = id, platform = 'pump') => ({platform, type: 'buy', id: `fixture-${id}`,
  transactionHash: `tx-${id}`, tokenAddress: '0x' + token.toString(16).padStart(40, '0'),
  networkId: 56, createdAt: Date.now()});
function harness(count = 10) {
  const requests = [], snapshots = [], events = [], notifications = [];
  let persists = 0;
  const c = vm.createContext({Date, Promise, Set, Map,
    GmgnPumpApi: require('../src/pump-api'), GmgnFomoCore: require('../src/core'),
    GmgnFollowTrades: require('../src/follow-trades'),
    pumpCoinMetadataCache: new Map(), pumpCoinMetadataRequests: new Map(),
    pumpCoinMetadataApplications: new Set(), PUMP_MARKET_CACHE_MS: 60000,
    followedTradesHistory: {fomo: [], pump: Array.from({length: count}, (_, i) => trade(i + 1))},
    pumpProfileTradesSnapshot: null, followedTradesSnapshot: null,
    followedTradesEnabled: true, pumpAlertsPresenceGeneration: 1,
    followedTradesNetworkByPort: new Map([[{}, 56]]), rememberObservedPumpItems() {},
    fetchPublicJson: () => new Promise((resolve, reject) => requests.push({resolve, reject})),
    applyCachedPumpEvmSymbols: x => x, schedulePumpEvmSymbolEnrichment() {},
    getFollowedTradesEnabled: async () => true, hydrateFollowedTradesHistory: async () => {},
    recordFollowedTradePipeline() {}, broadcastGmgnFollowTradeEvents: items => events.push(...items),
    broadcastGmgnFollowTradeMetadata() {}, filterUnfollowedTrades: x => x,
    persistFollowedTradesHistory: async () => { persists++; },
    isVerifiedFomoFollowedTrade: () => true, isVerifiedPumpFollowedTrade: () => true,
    hasRenderablePumpAlertTrade: () => true,
    withFollowedTradeRealtime: (response, items, notify) => {notifications.push(...notify); return response;},
    publishFollowedTradesResponse: response => {snapshots.push(response); c.followedTradesSnapshot = {response};},
  });
  vm.runInContext([
    block('function setBoundedCache(', 'function getResolvedHolderAddress('),
    block('async function getPumpCoinMetadata(', 'function cachePumpRpcTrade('),
    block('function pumpItemNeedsCoinMetadata(', 'async function enrichPumpProfileItems('),
    block('function preparePumpEvmSymbols(', 'async function pumpProfileItemsFromPages('),
    block('function buildCurrentFollowedTradesResponse(', 'function followedTradeNotificationKey('),
    block('function rememberFollowedTrades(', 'async function updateFollowedTradesWindow('),
    block('async function publishFomoRealtimeItems(', 'function publishPumpAlertRealtimeItems('),
  ].join('\n'), c);
  return {c, requests, snapshots, events, notifications, get persists() {return persists;}};
}
for (const count of [3, 6, 10]) test(`${count} concurrent Pump metadata completions publish only once each`, async () => {
  const h = harness(count);
  for (let i = 0; i < 20; i++) h.c.buildCurrentFollowedTradesResponse();
  assert.equal(h.requests.length, count);
  for (const request of h.requests) {request.resolve(metadata); await flush();}
  assert.equal(h.snapshots.length, count);
  assert.equal(h.persists, count);
  assert.equal(h.c.pumpCoinMetadataApplications.size, 0);
  assert.equal(h.c.pumpCoinMetadataRequests.size, 0);
  assert.equal(h.c.followedTradesHistory.pump.length, count);
  assert.ok(h.c.followedTradesHistory.pump.every(x => x.tokenSymbol === metadata.symbol));
  assert.equal(h.events.length, 0);
  assert.equal(h.notifications.length, 0, 'metadata must never create trade notifications');
});
test('Fomo delivery remains immediate while Pump metadata is pending and a late trade is enriched', async () => {
  const h = harness();
  const fomo = trade(100, 100, 'fomo');
  await h.c.publishFomoRealtimeItems([fomo]);
  assert.deepEqual(h.events.map(x => x.id), [fomo.id]);
  assert.deepEqual(h.notifications.map(x => x.id), [fomo.id]);
  assert.equal(h.snapshots.length, 1);
  const late = trade(101, 1);
  h.c.rememberFollowedTrades('pump', [late]);
  h.c.pumpProfileTradesSnapshot = {items: [late]};
  for (const request of h.requests) {request.resolve(metadata); await flush();}
  assert.equal(h.snapshots.length, 11);
  assert.equal(h.events.length, 1);
  assert.equal(h.notifications.length, 1);
  const stored = h.c.followedTradesHistory.pump.find(x => x.id === late.id);
  assert.equal(stored.transactionHash, late.transactionHash);
  assert.equal(stored.tokenSymbol, metadata.symbol);
  assert.equal(h.c.pumpProfileTradesSnapshot.items[0].tokenSymbol, metadata.symbol);
  assert.equal(h.c.followedTradesHistory.pump.length, 11);
});
test('failed metadata is retryable and completion does not restore an unfollowed trade', async () => {
  const h = harness(1);
  h.c.buildCurrentFollowedTradesResponse();
  h.requests[0].reject(new Error('synthetic failure'));
  await flush();
  assert.equal(h.c.pumpCoinMetadataApplications.size, 0);
  assert.equal(h.c.pumpCoinMetadataRequests.size, 0);
  h.c.buildCurrentFollowedTradesResponse();
  assert.equal(h.requests.length, 2);
  h.c.filterUnfollowedTrades = () => [];
  h.c.followedTradesHistory.pump = []; // Simulate removal while metadata is pending.
  h.requests[1].resolve(metadata);
  await flush();
  assert.equal(h.c.followedTradesHistory.pump.length, 0);
  assert.equal(h.events.length, 0);
  assert.equal(h.notifications.length, 0);
  assert.equal(h.c.pumpCoinMetadataApplications.size, 0);
});

test('official Pump NATS and REST events keep publishing while metadata completion is coalesced', async () => {
  const h = harness(3);
  h.c.buildCurrentFollowedTradesResponse();
  const api = require('../src/pump-api');
  const first = {...trade(201, 1), sourceVerification: api.PUMP_ALERTS_NATS_VERIFICATION};
  const second = {...trade(202, 2), sourceVerification: api.PUMP_ALERTS_REST_VERIFICATION};
  await h.c.publishPumpCollectedItems([first], 'alerts-nats', first.sourceVerification);
  await h.c.publishPumpCollectedItems([second], 'alerts-rest-delta', second.sourceVerification);
  assert.deepEqual(h.events.map(x => x.id), [first.id, second.id]);
  assert.equal(h.requests.length, 3);
  for (const request of h.requests) {request.resolve(metadata); await flush();}
  assert.deepEqual(h.events.map(x => x.id), [first.id, second.id]);
  assert.equal(h.notifications.length, 0, 'snapshot must not create a second notification path');
  assert.equal(h.c.followedTradesHistory.pump.length, 5);
  assert.ok(h.c.followedTradesHistory.pump.every(x => x.tokenSymbol === metadata.symbol));
});
