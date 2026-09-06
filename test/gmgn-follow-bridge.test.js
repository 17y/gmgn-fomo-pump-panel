const test = require("node:test");
const assert = require("node:assert/strict");
const bridge = require("../src/gmgn-follow-bridge");

const token = "0x1111111111111111111111111111111111111111";
const wallet = "0x2222222222222222222222222222222222222222";
const transactionHash = `0x${"ab".repeat(32)}`;

function external(overrides = {}) {
  return {
    id: "trade-1",
    platform: "fomo",
    type: "buy",
    createdAt: 1_700_000_200_000,
    tokenAddress: token,
    networkId: 56,
    transactionHash,
    walletAddress: wallet,
    displayName: "Alice",
    userHandle: "alice",
    profilePictureLink: "https://example.com/alice.png",
    tokenImageUrl: "https://example.com/token.png",
    tokenSymbol: "$TEST",
    tokenName: "Test token",
    usdAmount: 123,
    baseAmount: 250_000,
    quoteAmount: 0.5,
    quoteAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    quoteSymbol: "WBNB",
    priceUsdAtTrade: 0.000456,
    totalSupply: 1_000_000_000,
    marketCapAtTrade: 456_000,
    ...overrides,
  };
}

test("外部交易使用真实钱包和原始图片，并只给头像附加来源标记", () => {
  const trade = bridge.toGmgnTrade(external());
  assert.equal(trade.chain, "bsc");
  assert.equal(trade.side, "buy");
  assert.equal(trade.maker, wallet);
  assert.equal(trade.maker_info.address, wallet);
  assert.equal(trade.maker_info.name, "Alice");
  assert.equal(
    trade.maker_info.avatar,
    "https://example.com/alice.png#gmgn-follow-source=fomo&gmgn-follow-name=Alice",
  );
  assert.equal(trade.base_token.logo, "https://example.com/token.png");
  assert.equal(trade.base_token.symbol, "TEST");
  assert.doesNotMatch(trade.base_token.logo, /gmgn-follow-/);
  assert.equal(trade.base_amount, "250000");
  assert.equal(trade.quote_amount, "0.5");
  assert.equal(trade.quote_symbol, "WBNB");
});

test("Fomo 与 Pump 没有用户头像时使用各自平台 Logo 并保留来源标记", () => {
  const fomo = bridge.toGmgnTrade(external({
    profilePictureLink: "",
    platformLogoUrl: "https://fomo.family/logo.png",
  }));
  const pump = bridge.toGmgnTrade(external({
    platform: "pump",
    profilePictureLink: "",
    platformLogoUrl: "chrome-extension://example/assets/pump.svg",
  }));
  assert.equal(
    fomo.maker_info.avatar,
    "https://fomo.family/logo.png#gmgn-follow-source=fomo&gmgn-follow-name=Alice",
  );
  assert.equal(
    pump.maker_info.avatar,
    "chrome-extension://example/assets/pump.svg#gmgn-follow-source=pump&gmgn-follow-name=Alice",
  );
});

test("GMGN compact row 只携带原生 following_wallet_activity 字段", () => {
  const row = bridge.toGmgnFollowSocketTrade(external());
  assert.equal(row.n, "bsc");
  assert.equal(row.s, "buy");
  assert.equal(row.m, wallet);
  assert.equal(row.ma, wallet);
  assert.equal(row.ba, token);
  assert.equal(row.h, transactionHash);
  assert.equal(row.pu, 0.000456);
  assert.equal(row.bts, "1000000000");
  assert.equal(row.pu * Number(row.bts), 456_000);
  assert.equal(row.id, `external:${bridge.trackingItemKey(external())}`);
  assert.deepEqual(Object.keys(row).filter((key) => key.startsWith("extension_")), []);
});

test("同一 Fomo 交易的 WebSocket 与 REST id 不同仍使用同一稳定键", () => {
  const realtime = external({ id: "websocket-id" });
  const reconciled = external({ id: "rest-id", tokenSymbol: "FILLED" });
  assert.equal(bridge.trackingItemKey(realtime), bridge.trackingItemKey(reconciled));
  assert.equal(
    bridge.toGmgnFollowSocketTrade(realtime).id,
    bridge.toGmgnFollowSocketTrade(reconciled).id,
  );
});

test("Pump REST 与 NATS 共用交易键，展示字段补全不改变事件键", () => {
  const first = external({
    platform: "pump",
    pumpEventId: "event-123",
    transactionHash: "short-pump-signature",
  });
  const enriched = { ...first, tokenSymbol: "LATER", marketCapAtTrade: 999_000 };
  assert.equal(bridge.trackingItemKey(first), bridge.trackingItemKey({ ...first, pumpEventId: undefined }));
  assert.equal(bridge.trackingItemKey(first), bridge.trackingItemKey(enriched));
});

test("Fomo 缺少钱包时使用稳定 userId，不触发地址补查", () => {
  const row = bridge.toGmgnFollowSocketTrade(external({
    walletAddress: "",
    userId: "user / 123",
  }));
  assert.equal(row.m, "fomo:user%20%2F%20123");
  assert.equal(row.ma, row.m);
});

test("缺少来源身份、链、方向或 Token 时拒绝进入 GMGN 原生流", () => {
  assert.equal(bridge.toGmgnFollowSocketTrade(external({ walletAddress: "", userId: "" })), null);
  assert.equal(bridge.toGmgnFollowSocketTrade(external({
    platform: "pump",
    walletAddress: "",
    userId: "pump-user",
  })), null);
  assert.equal(bridge.toGmgnFollowSocketTrade(external({ networkId: 999 })), null);
  assert.equal(bridge.toGmgnFollowSocketTrade(external({ type: "transfer_in" })), null);
  assert.equal(bridge.toGmgnFollowSocketTrade(external({ tokenAddress: "" })), null);
});

test("只使用成交时或冻结快照计算价格，不使用普通当前市值", () => {
  const currentOnly = bridge.toGmgnTrade(external({
    priceUsdAtTrade: null,
    marketCapAtTrade: null,
    totalSupply: 1_000_000_000,
    marketCap: 999_000,
    platform: "pump",
  }));
  assert.equal(currentOnly.price_usd, 0);
  assert.equal("market_cap" in currentOnly.base_token, false);

  const frozen = bridge.toGmgnTrade(external({
    platform: "pump",
    priceUsdAtTrade: null,
    marketCapAtTrade: null,
    priceUsdSnapshot: 0.0003677,
    marketCapSnapshot: 367_700,
    totalSupplySnapshot: 1_000_000_000,
  }));
  assert.equal(frozen.price_usd, 0.0003677);
  assert.equal(frozen.base_token.market_cap, 367_700);
});

test("历史适配只接受精确追踪接口并保留链、类型、金额和成员范围", () => {
  const base = "https://gmgn.ai/vas/api/v1/follow/";
  const request = bridge.trackingRequest(`${base}multi_chain_follow_wallet_trade_list?chain[]=bsc&chain[]=sol&filters=buy&min_amount_usd=10`);
  assert.deepEqual([...request.chains], ["bsc", "sol"]);
  assert.equal(request.minAmount, 10);
  for (const url of [
    "https://gmgn.ai/vas/api/v1/rank/hot_trades?chain=bsc",
    `${base}follow_wallet_trade_list_extra?chain=bsc`,
    `${base}follow_wallet_trade_list?chain=bsc&filters=callOut`,
    `${base}follow_wallet_trade_list?chain=bsc&group_id=one`,
    `${base}follow_wallet_trade_list?chain=bsc&wallet=one`,
    `${base}follow_wallet_trade_list`,
    "https://example.com/vas/api/v1/follow/follow_wallet_trade_list?chain=bsc",
  ]) assert.equal(bridge.trackingRequest(url), null, url);
});

test("回填两平台合计最多 30 条，只插入比原生最旧记录更新的交易", () => {
  const native = [
    { id: "native-new", chain: "bsc", timestamp: 1_700_000_250 },
    { id: "native-old", chain: "bsc", timestamp: 1_700_000_150 },
  ];
  const payload = { code: 0, data: { list: native, next_page_token: "unchanged", total: 2 } };
  const request = bridge.trackingRequest("/vas/api/v1/follow/follow_wallet_trade_list?chain=bsc");
  const recent = bridge.recentTrackingItems(Array.from({ length: 40 }, (_, index) => external({
    platform: index % 2 ? "pump" : "fomo",
    transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
    createdAt: (1_700_000_140 + index) * 1000,
  })));
  assert.equal(recent.length, 30);
  const result = bridge.mergeRecentTrackingPayload(payload, request, recent);
  const inserted = result.data.list.filter((row) => row.id.startsWith("external:"));
  assert.equal(inserted.length, 29, "等于原生最旧时间的交易也不能回填");
  assert.ok(inserted.every((row) => row.timestamp > 1_700_000_150));
  assert.equal(result.data.next_page_token, "unchanged");
  assert.equal(result.data.total, 2);
  assert.equal(payload.data.list, native);
  assert.equal(native.length, 2, "不修改原始响应和原生行对象");
  assert.equal(result.data.list[0], native[0]);
  assert.equal(result.data.list.at(-1), native[1]);
  assert.deepEqual(result.data.list.map((row) => row.timestamp),
    result.data.list.map((row) => row.timestamp).sort((a, b) => b - a));
  assert.equal(bridge.mergeRecentTrackingPayload(result, request, recent), result, "重复回填直接返回原对象");
});

test("原生列表空、无时间边界或缓存不符合筛选时不回填", () => {
  const request = bridge.trackingRequest("/vas/api/v1/follow/follow_wallet_trade_list?chain=bsc&side=buy&min_amount_usd=100&max_amount_usd=200");
  for (const payload of [{ list: [] }, { list: [{ id: "native" }] }, { list: [{ id: "external:x", timestamp: 1 }] }]) {
    assert.equal(bridge.mergeRecentTrackingPayload(payload, request, [external()]), payload);
  }
  const payload = { list: [{ id: "native", timestamp: 1_700_000_100 }] };
  for (const item of [external({ networkId: 1 }), external({ type: "sell" }), external({ usdAmount: 99 }), external({ usdAmount: 201 })]) {
    assert.equal(bridge.mergeRecentTrackingPayload(payload, request, [item]), payload);
  }
  assert.equal(bridge.mergeRecentTrackingPayload(payload, request, [external()]).list.length, 2);
});
