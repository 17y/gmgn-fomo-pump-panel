const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../src/follow-trades");

const token = "0x1111111111111111111111111111111111111111";

test("Pump REST 更新历史后仍保留 NATS 行身份，回填与实时使用同一键", () => {
  const bridge = require("../src/gmgn-follow-bridge");
  const live = { id: "pump:tx:wallet:token:buy", platform: "pump", type: "buy", createdAt: Date.now(),
    networkId: 56, tokenAddress: token, walletAddress: "wallet", transactionHash: `0x${"ab".repeat(32)}`,
    pumpEventId: "native-alert-event", sourceVerification: "pump-alerts-nats" };
  const { pumpEventId, ...rest } = live;
  const [cached] = api.mergeFollowedTrades([{ ...rest, sourceVerification: "pump-alerts-rest" }], [live]);
  assert.equal(cached.pumpEventId, pumpEventId);
  assert.equal(bridge.trackingItemKey(cached), bridge.trackingItemKey(live));
});

test("关注交易按时间合并、同平台稳定 ID 去重且保留跨平台卡片", () => {
  const result = api.mergeFollowedTrades(
    [{ id: "shared", platform: "fomo", type: "buy", createdAt: 100, tokenAddress: token }],
    [
      { id: "shared", platform: "pump", type: "sell", createdAt: 300, tokenAddress: token },
      { id: "shared", platform: "pump", type: "sell", createdAt: 200, tokenAddress: token },
      { id: "invalid", platform: "other", type: "buy", createdAt: 999 },
    ],
  );

  assert.deepEqual(result.map((item) => item.id), ["shared", "shared"]);
  assert.deepEqual(result.map((item) => item.platform), ["pump", "fomo"]);
});

test("同平台同 ID 的后续记录只补齐首条为空的展示元数据", () => {
  const result = api.mergeFollowedTrades(
    [{
      id: "same-trade",
      platform: "pump",
      type: "buy",
      createdAt: 100,
      tokenAddress: token,
      transactionHash: "first-hash",
      usdAmount: 25,
      marketCap: null,
      tokenSymbol: "",
      tokenName: null,
      tokenLogo: "",
      tokenImageUrl: "",
      displayName: "",
      userHandle: "",
      profilePictureLink: "",
    }, {
      id: "newer-other-trade",
      platform: "pump",
      type: "buy",
      createdAt: 200,
      tokenAddress: token,
    }],
    [{
      id: "same-trade",
      platform: "pump",
      type: "sell",
      createdAt: 300,
      tokenAddress: "0x2222222222222222222222222222222222222222",
      transactionHash: "later-hash",
      usdAmount: 999,
      marketCap: 456000,
      tokenSymbol: "FILLED",
      tokenName: "Filled Token",
      tokenLogo: "https://example.com/token-logo.png",
      tokenImageUrl: "https://example.com/token-image.png",
      displayName: "Filled Trader",
      userHandle: "filled_trader",
      profilePictureLink: "https://example.com/filled-avatar.png",
    }],
  );

  assert.deepEqual(result.map((item) => item.id), ["newer-other-trade", "same-trade"]);
  const merged = result[1];
  assert.equal(merged.type, "buy");
  assert.equal(merged.createdAt, 100);
  assert.equal(merged.tokenAddress, token);
  assert.equal(merged.transactionHash, "first-hash");
  assert.equal(merged.usdAmount, 25);
  assert.equal(merged.marketCap, 456000);
  assert.equal(merged.tokenSymbol, "FILLED");
  assert.equal(merged.tokenName, "Filled Token");
  assert.equal(merged.tokenLogo, "https://example.com/token-logo.png");
  assert.equal(merged.tokenImageUrl, "https://example.com/token-image.png");
  assert.equal(merged.displayName, "Filled Trader");
  assert.equal(merged.userHandle, "filled_trader");
  assert.equal(merged.profilePictureLink, "https://example.com/filled-avatar.png");
});

test("同一 Pump 交易的链上确认标记可从 receipt 结果补入 profile 条目", () => {
  const [merged] = api.mergeFollowedTrades(
    [{ id: "same-trade", platform: "pump", type: "buy", createdAt: 100 }],
    [{
      id: "same-trade",
      platform: "pump",
      type: "buy",
      createdAt: 100,
      sourceVerification: "pump-chain-rpc",
    }],
  );

  assert.equal(merged.sourceVerification, "pump-chain-rpc");
});

test("同平台同 ID 的后续记录不会覆盖首条非空展示元数据", () => {
  const first = {
    id: "same-trade",
    platform: "fomo",
    type: "buy",
    createdAt: 100,
    tokenAddress: token,
    marketCap: 123000,
    tokenSymbol: "FIRST",
    tokenName: "First Token",
    tokenLogo: "https://example.com/first-logo.png",
    tokenImageUrl: "https://example.com/first-image.png",
    displayName: "First Trader",
    userHandle: "first_trader",
    profilePictureLink: "https://example.com/first-avatar.png",
  };
  const result = api.mergeFollowedTrades([first], [{
    ...first,
    createdAt: 200,
    marketCap: 456000,
    tokenSymbol: "LATER",
    tokenName: "Later Token",
    tokenLogo: "https://example.com/later-logo.png",
    tokenImageUrl: "https://example.com/later-image.png",
    displayName: "Later Trader",
    userHandle: "later_trader",
    profilePictureLink: "https://example.com/later-avatar.png",
  }]);

  assert.equal(result.length, 1);
  assert.equal(result[0].createdAt, 100);
  assert.equal(result[0].marketCap, 123000);
  assert.equal(result[0].tokenSymbol, "FIRST");
  assert.equal(result[0].tokenName, "First Token");
  assert.equal(result[0].tokenLogo, "https://example.com/first-logo.png");
  assert.equal(result[0].tokenImageUrl, "https://example.com/first-image.png");
  assert.equal(result[0].displayName, "First Trader");
  assert.equal(result[0].userHandle, "first_trader");
  assert.equal(result[0].profilePictureLink, "https://example.com/first-avatar.png");
});

test("Pump 刷新后的当前行情不会覆盖已经冻结的实时快照", () => {
  const refreshed = {
    id: "pump:snapshot",
    platform: "pump",
    type: "buy",
    createdAt: 200,
    tokenAddress: token,
    marketCap: 410_000,
    totalSupply: 1_000_000_000,
  };
  const cached = {
    ...refreshed,
    marketCap: 367_700,
    marketCapSnapshot: 367_700,
    priceUsdSnapshot: 0.0003677,
    totalSupplySnapshot: 1_000_000_000,
    marketSnapshotCapturedAt: 1_800_000_000_000,
    marketSnapshotSource: "pump-realtime-observed",
  };

  const [result] = api.mergeFollowedTrades([refreshed], [cached]);

  assert.equal(result.marketCap, 410_000);
  assert.equal(result.marketCapSnapshot, 367_700);
  assert.equal(result.priceUsdSnapshot, 0.0003677);
  assert.equal(result.totalSupplySnapshot, 1_000_000_000);
  assert.equal(result.marketSnapshotCapturedAt, 1_800_000_000_000);
  assert.equal(result.marketSnapshotSource, "pump-realtime-observed");
});

test("每条链独立保留最近 100 条，热门链不会挤掉少数链且同时间稳定排序", () => {
  const bsc = Array.from({ length: 101 }, (_, index) => ({
    id: `bsc-${index}`,
    platform: "pump",
    type: "buy",
    createdAt: 1_000 - index,
    networkId: 56,
    tokenAddress: token,
  }));
  const robinhood = [{
    id: "robinhood-first",
    platform: "fomo",
    type: "sell",
    createdAt: 900,
    networkId: 4663,
    tokenAddress: token,
  }, {
    id: "robinhood-second",
    platform: "pump",
    type: "buy",
    createdAt: 900,
    networkId: 4663,
    tokenAddress: token,
  }];

  const result = api.mergeFollowedTrades(bsc, robinhood);

  assert.equal(result.filter((item) => item.networkId === 56).length, 100);
  assert.deepEqual(
    result.filter((item) => item.networkId === 4663).map((item) => item.id),
    ["robinhood-first", "robinhood-second"],
  );
  assert.equal(result.some((item) => item.id === "bsc-100"), false);
  assert.deepEqual(
    [...result].sort((left, right) => right.createdAt - left.createdAt).map((item) => item.id),
    result.map((item) => item.id),
  );
});

test("缺少 networkId 时按规范化 chain 名称共用链限额", () => {
  const result = api.mergeFollowedTrades(Array.from({ length: 101 }, (_, index) => ({
    id: `chain-only-${index}`,
    platform: "fomo",
    type: "buy",
    createdAt: 1_000 - index,
    chain: index % 2 ? "BSC" : "bsc",
    tokenAddress: token,
  })));

  assert.equal(result.length, 100);
  assert.equal(result.some((item) => item.id === "chain-only-100"), false);
});

test("展示的一条或多条链共用一个最早时间门槛，未展示链不清理", () => {
  const items = [{
    id: "bsc-before-window",
    platform: "fomo",
    type: "buy",
    createdAt: 199,
    networkId: 56,
    tokenAddress: token,
  }, {
    id: "bsc-at-window",
    platform: "fomo",
    type: "buy",
    createdAt: 200,
    networkId: 56,
    tokenAddress: token,
  }, {
    id: "robinhood-after-window",
    platform: "pump",
    type: "sell",
    createdAt: 250,
    networkId: 4663,
    tokenAddress: token,
  }, {
    id: "sol-before-window-but-not-visible",
    platform: "pump",
    type: "buy",
    createdAt: 100,
    networkId: 1399811149,
    tokenAddress: "11111111111111111111111111111111",
  }];

  const result = api.pruneFollowedTrades(items, [56, 4663], 200);

  assert.deepEqual(result.map((item) => item.id), [
    "robinhood-after-window",
    "bsc-at-window",
    "sol-before-window-but-not-visible",
  ]);
});

test("根据 networkId 生成 GMGN Token 链接", () => {
  assert.equal(
    api.gmgnTokenUrl({ networkId: 56, tokenAddress: token }, "https://gmgn.ai"),
    `https://gmgn.ai/bsc/token/${token}`,
  );
  assert.equal(api.gmgnTokenUrl({ networkId: 999999, tokenAddress: token }), "");
});
