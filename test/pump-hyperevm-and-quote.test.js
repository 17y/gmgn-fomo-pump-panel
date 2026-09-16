const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');
const pump = require('../src/pump-api');
const bridge = require('../src/gmgn-follow-bridge');
const follow = require('../src/follow-trades');
const resolver = require('../src/evm-holder-resolver');

const wallet = '0x1160079f1463dc5f9f20b1f1b9cf628718649c18';
const token = '0xf09703969cf55aa8a05ee9c76ab3013477283666';
const tx = '0xb7d0adf6d64544ba4b0698bfba36a0c8e7935a09ce263f7e2140a7faac0d672e';
const usdc = '0xb88339cb7199b77e23db6e890353e22632ba630f';
const rpcFixture = require('./fixtures/pump-hyperevm-b7d0.json');
// Constructed alert envelopes using public identifiers, not captured Pump events.
function alert(chainId = 999) {
  return { id: 'hyperevm-fixture', kind: 'trade', createdAt: Date.now(),
    coin: { mint: token, chainId, symbol: 'FIXTURE' },
    author: { walletAddress: wallet, userId: 'fixture-user' },
    trade: { tx, isBuy: true, amountUsd: 2053, baseAmount: 510197,
      priceUsd: 2053 / 510197, quoteAmount: '2053', quoteAddress: usdc, quoteSymbol: 'USDC' } };
}

test('User HyperEVM receipt verifies the relayed buy; failed receipt and unrelated wallet remain rejected', () => {
  // Profile metadata is constructed; all on-chain transfer logs are unmodified RPC data.
  const group = { networkId: 999, transactionHash: tx, walletAddress: wallet,
    createdAt: Date.now(), author: {}, rows: [{ type: 'TRANSFER', direction: 'IN',
      token_transferred: { mint: token, amount: '510197.073718507876717630', metadata: { symbol: 'FIXTURE' } } }] };
  const item = pump.sanitizeEvmRpcTrade(rpcFixture, group);
  assert.equal(item.networkId, 999);
  assert.equal(item.type, 'buy');
  assert.equal(item.walletAddress, wallet);
  assert.equal(item.transactionHash, tx);
  assert.equal(item.usdAmount, 2049.798341);
  assert.equal(item.baseAmount, 510197.0737185079);
  assert.equal(item.sourceVerification, pump.PUMP_CHAIN_RPC_VERIFICATION);
  assert.equal(bridge.toGmgnFollowSocketTrade(item).n, 'hyperevm');
  assert.equal(pump.sanitizeEvmRpcTrade({ ...rpcFixture, receipt: { ...rpcFixture.receipt, status: '0x0' } }, group), null);
  assert.equal(pump.sanitizeEvmRpcTrade(rpcFixture, { ...group, walletAddress: '0x' + '11'.repeat(20) }), null);
});

test('HyperEVM Pump event survives normalization, native mapping and history without enabling Fomo holders', () => {
  assert.equal(core.TOKEN_NETWORK_IDS.hyperevm, 999);
  assert.equal(core.parseTokenRoute(`/hyperevm/token/${token}`), null);
  assert.equal(resolver.isSupported(999), true);
  const item = pump.sanitizeRealtimeAlertTrade(alert('999'));
  assert.equal(item.networkId, 999);
  const row = bridge.toGmgnFollowSocketTrade(item);
  assert.equal(row.n, 'hyperevm');
  assert.equal(row.h, tx);
  assert.equal(row.m, wallet);
  assert.equal(row.qa, '2053');
  assert.equal(row.qad, usdc);
  assert.equal(row.qs, 'USDC');
  assert.equal(follow.gmgnTokenUrl(item), `https://gmgn.ai/hyperevm/token/${token}`);
  const request = bridge.trackingRequest('https://gmgn.ai/vas/api/v1/follow/multi_chain_follow_wallet_trade_list?chain[]=hyperevm&chain[]=bsc');
  const restored = bridge.mergeRecentTrackingPayload({ data: { list: [{ id: 'native', timestamp: Date.now() / 1000 - 10 }] } }, request, [item]);
  assert.equal(restored.data.list[0].quote_amount, '2053');
  assert.equal(restored.data.list[0].chain, 'hyperevm');
});

test('HyperEVM declaration does not accept a Solana wallet, a different chain or low-value alert', () => {
  const wrongWallet = alert(); wrongWallet.author.walletAddress = 'F6mEJf6reUh6nUy6pFajWHSz4aKVwMs4BwpsMqs97839';
  assert.equal(pump.sanitizeRealtimeAlertTrade(wrongWallet), null);
  assert.equal(pump.sanitizeRealtimeAlertTrade(alert(998)), null);
  const low = alert(); low.trade.amountUsd = 9.99;
  assert.equal(pump.sanitizeRealtimeAlertTrade(low), null);
});

test('Pump missing or invalid spend is absent in both native formats, with USD retained and Fomo unchanged', () => {
  for (const value of [null, undefined, '', 0, -1, 'bad']) {
    const event = alert(); event.trade.quoteAmount = value;
    const item = pump.sanitizeRealtimeAlertTrade(event);
    const row = bridge.toGmgnFollowSocketTrade(item);
    const history = bridge.toGmgnTrade(item);
    assert.equal(Object.hasOwn(row, 'qa'), false);
    assert.equal(Object.hasOwn(row, 'qad'), false);
    assert.equal(Object.hasOwn(history, 'quote_amount'), false);
    assert.equal(row.au, 2053);
    assert.equal(row.cu, 2053);
    const fomo = bridge.toGmgnTrade({ ...item, platform: 'fomo', networkId: 56 });
    assert.equal(fomo.quote_amount, '0');
  }
});

test('HyperEVM profile recognizes USDC and WHYPE spend using human quantities without rescaling', () => {
  for (const [quoteMint, quoteSymbol] of [[usdc, 'USDC'], ['0x5555555555555555555555555555555555555555', 'WHYPE']]) {
    const [item] = pump.sanitizeProfileSwaps({ transactions: [{ type: 'SWAP', network_id: 999,
      tx_hash: tx, block_time: Date.now(), token_in: { mint: token, amount: '12345' },
      token_out: { mint: quoteMint, amount: '0.123456', metadata: { symbol: quoteSymbol } } }] }, { evmAddress: wallet });
    assert.equal(item.type, 'buy');
    assert.equal(item.quoteAmount, 0.123456);
    assert.equal(item.quoteAddress, quoteMint);
    assert.equal(item.baseAmount, 12345);
    assert.equal(item.networkId, 999);
  }
});
