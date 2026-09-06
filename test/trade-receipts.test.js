const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/trade-receipts');

const trade = (id, createdAt = 100_000) => ({ id, platform: 'fomo', type: 'sell', createdAt,
  tokenAddress: '0xc73e1b136c576d1429cb84522a8c35c81d9d7777', networkId: 56,
  userHandle: 'iruletrenches', tokenSymbol: '月薪喵' });

test('逐笔证据不受历史广播刷屏影响，数量和时间有界', () => {
  let now = 100_000;
  const r = create({ now: () => now, limit: 3, maxAgeMs: 1000 });
  r.record('gmgn-event-failed', [trade('failed')], { error: 'ACK_TIMEOUT' });
  for (let i = 0; i < 500; i++) r.record('background-broadcast', [trade('noise-' + i)]);
  assert.equal(r.snapshot().trades.length, 1);
  r.record('fomo-rest-response', [trade('old', 1)]);
  assert.equal(r.snapshot().trades.length, 1);
  r.record('gmgn-event-ack', [trade('two'), trade('three'), trade('four')]);
  assert.equal(r.snapshot().trades.length, 3);
  assert.equal(r.snapshot().evictedCount, 1);
  now += 1001;
  assert.equal(r.snapshot().trades.length, 0);
});

test('会话恢复保留逐笔结果、最初时间和次数，合并恢复期间的新事件', () => {
  let now = 100_000;
  const first = create({ now: () => now });
  first.record('gmgn-event-broadcast', [trade('sell')]);
  now += 6000; first.record('gmgn-event-broadcast', [trade('sell')]);
  const saved = JSON.parse(JSON.stringify(first.snapshot()));
  now += 1000;
  const second = create({ now: () => now });
  second.record('gmgn-event-ack', [trade('sell')]);
  second.restore(saved);
  const row = second.snapshot().trades[0];
  assert.equal(row.stages['gmgn-event-broadcast'].count, 2);
  assert.equal(row.stages['gmgn-event-broadcast'].firstAt, 100_000);
  assert.ok(row.stages['gmgn-event-ack']);
  assert.equal(second.snapshot().startedAt, 100_000);
  assert.equal(second.snapshot().workerStartedAt, 107_000);
});

test('恢复和记录都经过字段白名单，Pump 合成 ID 不能泄漏钱包', () => {
  const r = create({ now: () => 100_000 });
  const item = { ...trade('pump:tx:private-sol-wallet:token:sell'), platform: 'pump',
    transactionHash: 'tx-hash', walletAddress: 'private-sol-wallet', authorization: 'secret-auth' };
  r.record('gmgn-event-broadcast', [item], { payload: 'secret-body', consumerId: 42 });
  const saved = r.snapshot();
  saved.trades[0].authorization = 'restore-secret';
  saved.trades[0].stages['gmgn-event-broadcast'].payload = 'restore-payload';
  const next = create({ now: () => 100_000 }); next.restore(saved);
  const output = JSON.stringify(next.snapshot());
  for (const value of ['private-sol-wallet', 'secret-auth', 'secret-body', 'restore-secret', 'restore-payload']) {
    assert.equal(output.includes(value), false, value);
  }
  assert.equal(next.snapshot().trades[0].stages['gmgn-event-broadcast'].consumerId, 42);
});


test('提交、解码、未观察到渲染与成功渲染分别保留，重建后台后不丢失', () => {
  const now = () => 100_000;
  const first = create({ now });
  const item = trade('render-stages');
  for (const stage of ['gmgn-native-submitted', 'gmgn-native-decoded', 'gmgn-event-unverified', 'gmgn-row-rendered']) {
    first.record(stage, [item], { reason: 'NATIVE_DECODED_ROW_NOT_OBSERVED', payload: 'must-not-persist' });
  }
  const second = create({ now });
  second.restore(first.snapshot());
  const stages = second.snapshot().trades[0].stages;
  assert.equal(Object.keys(stages).length, 4);
  assert.ok(stages['gmgn-row-rendered']);
  assert.equal(JSON.stringify(stages).includes('must-not-persist'), false);
});
