const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../src/pump-api");
const core = require("../src/core");

const evmParams = {
  address: "0x1111111111111111111111111111111111111111",
  networkId: 8453,
};
const solanaParams = {
  address: "8Jx8AAHj86wbQgUTjGuj6GTTL5Ps3cqxKRTvpaJApump",
  networkId: 1399811149,
};
const PUMP_WALLET = "0x3333333333333333333333333333333333333333";

test("从 Pump 当前页面配置中只提取 CORE NATS 连接信息", () => {
  const configs = {
    CORE: {
      servers: "wss://prod-v2.nats.realtime.pump.fun",
      user: "subscriber",
      pass: "public-read-password",
      pingInterval: 5_000,
      timeout: 5_000,
    },
  };
  const html = `<script>self.__next_f.push([1,"{\\"configs\\":${JSON.stringify(configs).replaceAll('"', '\\"')},\\"instances\\":{}}"])</script>`;

  assert.deepEqual(api.parseCoreNatsConfig(html), {
    server: "wss://prod-v2.nats.realtime.pump.fun",
    user: "subscriber",
    pass: "public-read-password",
    token: "",
    pingInterval: 5_000,
    timeout: 5_000,
  });
  assert.equal(api.parseCoreNatsConfig("<html></html>"), null);
});

test("Pump 余额变化 NATS subject 只接受规范钱包地址", () => {
  const solanaWallet = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const evmWallet = "0x1160079f1463dc5f9f20b1f1b9cf628718649c18";
  assert.equal(
    api.buildAccountBalanceSubject(solanaWallet),
    `account_balance_change.${solanaWallet}.*`,
  );
  assert.equal(
    api.buildAccountBalanceSubject(evmWallet.toUpperCase().replace("0X", "0x")),
    `account_balance_change.${evmWallet}.*`,
  );
  assert.equal(
    api.accountBalanceSubjectWallet(`account_balance_change.${solanaWallet}.*`),
    solanaWallet,
  );
  assert.equal(api.buildAccountBalanceSubject("bad.wallet"), "");
  assert.equal(api.accountBalanceSubjectWallet("coin_trade.*"), "");
});

test("Pump Position 请求对 EVM 与 Solana 地址使用网页同款参数", () => {
  const arcParams = {
    address: "0x2222222222222222222222222222222222222222",
    networkId: 5042,
  };
  for (const params of [evmParams, solanaParams, arcParams]) {
    const request = api.buildPositionsRequest(params);
    const url = new URL(request.url);
    assert.equal(request.method, "GET");
    assert.equal(url.origin, api.POSITIONS_ORIGIN);
    assert.equal(decodeURIComponent(url.pathname), `/mint-positions/${params.address}`);
    assert.equal(url.searchParams.get("sortBy"), "TOP");
    assert.equal(url.searchParams.get("withThesis"), "true");
    assert.equal(url.searchParams.get("pageSize"), "50");
  }
});

test("Pump 用户资料按 userId 查询并选择当前链 canonical 钱包", () => {
  const request = api.buildUserRequest("user-1");
  assert.equal(request.url, `${api.POSITIONS_ORIGIN}/users/user-1`);
  assert.equal(api.sanitizeUserWallet({
    canonical_evm_wallet: PUMP_WALLET,
    canonical_svm_wallet: solanaParams.address,
  }, evmParams.networkId), PUMP_WALLET);
  assert.equal(api.sanitizeUserWallet({
    canonical_evm_wallet: PUMP_WALLET,
    canonical_svm_wallet: solanaParams.address,
  }, solanaParams.networkId), solanaParams.address);
});

test("只清洗同时带有效持仓和 Thesis 的 Pump Callout", () => {
  const result = api.sanitizePositions({ positions: [{
    userId: "user-with-position",
    userName: "Position Caller",
    walletAddress: PUMP_WALLET,
    amountHeld: 5_000_000,
    pnlUsd: 296_510.33,
    pnlPercentage: 2238.18,
    realizedPnlUsd: 92_812.56,
    costBasisAmount: 5_000_000,
    costBasisUsd: 5_810.89,
    amountBought: 15_840_000,
    amountBoughtUsd: 13_247.84,
    callout: {
      calloutId: "with-position",
      thesis: "Has a current position",
      likes: 56,
      calloutTimestamp: "2026-08-14T16:28:20.225Z",
      calledOutAtMcap: 781_771,
    },
  }, {
    userId: "closed-position",
    userName: "Closed Caller",
    amountHeld: 0,
    callout: { calloutId: "closed", thesis: "No current position" },
  }, {
    userId: "without-thesis",
    userName: "No Callout",
    amountHeld: 10,
    callout: null,
  }] }, {
    priceUsd: 0.0418,
    totalSupply: 1_000_000_000,
    marketCap: 41_800_000,
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].platform, "pump");
  assert.equal(result[0].userId, "user-with-position");
  assert.equal(result[0].walletAddress, PUMP_WALLET);
  assert.equal(result[0].displayName, "Position Caller");
  assert.equal(result[0].profileUrl, "https://pump.fun/profile/Position%20Caller");
  assert.equal(Math.round(result[0].value), 209_000);
  assert.equal(result[0].humanAmount, 5_000_000);
  assert.equal(result[0].ownershipPercent, 0.5);
  assert.equal(result[0].pnl, 296_510.33);
  assert.equal(result[0].pnlPercent, 2238.18);
  assert.equal(result[0].comment, "Has a current position");
  assert.equal(result[0].likes, 56);
  assert.equal(result[0].averageEntryPrice, 13_247.84 / 15_840_000);
});

test("Pump 用户头像链接优先使用平台用户名并安全编码", () => {
  assert.equal(api.buildProfileUrl("@Position Caller"), "https://pump.fun/profile/Position%20Caller");
  assert.equal(api.buildProfileUrl(""), "");
});

test("缺少 Token Price 时使用 Market Cap 与 Supply 计算 Pump 持仓价值", () => {
  const [result] = api.sanitizePositions({ positions: [{
    userName: "Fallback Price",
    amountHeld: 100,
    callout: { calloutId: "fallback", thesis: "Fallback" },
  }] }, { marketCap: 2_000, totalSupply: 1_000 });

  assert.equal(result.value, 200);
});

test("Fomo 与 Pump 卡片按当前持仓 USD 统一降序且不跨平台去重", () => {
  const fomo = [
    { id: "f1", platform: "fomo", walletAddress: "same", value: 100 },
    { id: "f2", platform: "fomo", value: 40 },
  ];
  const pump = [
    { id: "p1", platform: "pump", walletAddress: "same", value: 80 },
    { id: "p2", platform: "pump", value: null },
  ];
  const result = api.mergeHolderItems(fomo, pump);

  assert.deepEqual(result.map((item) => item.id), ["f1", "p1", "f2", "p2"]);
});

test("Pump 关注切换使用当前网页接口并携带页面 WAF 配置", () => {
  const wallet = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const follow = api.buildFollowMutationRequest(wallet, true);
  assert.equal(new URL(follow.url).pathname, `/following/v2/${wallet}`);
  assert.equal(follow.method, "POST");
  assert.equal(follow.credentials, "include");
  assert.equal(follow.allowEmptyResponse, true);
  assert.equal(follow.includeWafToken, true);

  const unfollow = api.buildFollowMutationRequest(wallet, false);
  assert.equal(new URL(unfollow.url).pathname, `/following/${wallet}`);
  assert.equal(unfollow.method, "DELETE");
  assert.throws(() => api.buildFollowMutationRequest("bad", true), /INVALID_PUMP_FOLLOW_REQUEST/);
});

test("Pump 关注交易请求复用登录 Cookie 并只清洗 trade alert", () => {
  const request = api.buildFollowedTradesRequest();
  const url = new URL(request.url);
  assert.equal(url.pathname, "/following-positions/alerts");
  assert.equal(url.searchParams.get("pageSize"), "10");
  assert.equal(url.searchParams.get("kinds"), "trade");
  assert.equal(url.searchParams.get("minTradeAmountUsd"), "10");
  assert.equal(request.credentials, "include");
  assert.equal(request.timeoutMs, 8_000);
  assert.equal(api.FOLLOWED_TRADES_MAX_PAGES, 2);
  assert.equal(
    new URL(api.buildFollowedTradesRequest("page-2").url).searchParams.get("cursor"),
    "page-2",
  );

  const result = api.sanitizeFollowedTrades({ items: [{
    kind: "trade",
    createdAt: "2026-08-28T08:30:00.000Z",
    walletAddress: "PumpWallet111111111111111111111111111111111",
    coinMint: solanaParams.address,
    coinSymbol: "PUMPY",
    marketCap: "",
    marketCapUsd: 123456,
    author: {
      userId: "pump-user-1",
      userName: "Pump Friend",
      profileImage: "https://example.com/pump.png",
    },
    trade: {
      tx: "tx-1",
      isBuy: true,
      timestamp: 1_777_777_777,
      amountUsd: "42.25",
    },
  }, {
    kind: "callout",
    coinMint: solanaParams.address,
    trade: { tx: "must-not-render", isBuy: true, timestamp: 1_777_777_777 },
  }] });

  assert.equal(result.length, 1);
  assert.equal(result[0].platform, "pump");
  assert.equal(result[0].type, "buy");
  assert.equal(result[0].networkId, solanaParams.networkId);
  assert.equal(result[0].displayName, "Pump Friend");
  assert.equal(result[0].tokenSymbol, "PUMPY");
  assert.equal(result[0].usdAmount, 42.25);
  assert.equal(result[0].marketCap, 123456);
  assert.equal(result[0].marketCapAtTrade, null);
  assert.match(result[0].id, /^pump:tx-1:/);
});

test("Pump EVM 卖出在 trade timestamp 不可用时回退到官方 row createdAt", () => {
  const tx = "0x74331917078748a5e5c60345e60ebd7f3523cc2bcd212e0f4fe5eebfec14254d";
  const wallet = "0x1160079f1463dc5f9f20b1f1b9cf628718649c18";
  const token = "0xbeea1d618e533a387d941f58a7d4c9b7bd377777";
  const [result] = api.sanitizeFollowedTrades({ items: [{
    kind: "trade",
    chainId: 56,
    createdAt: "2026-08-28T16:18:17.000Z",
    walletAddress: wallet,
    coinMint: token,
    coinName: "牛来",
    coinSymbol: "牛来",
    coinImage: "https://example.com/niulai.png",
    author: {
      userId: "pump-user-niulai",
      userName: "Pump trader",
      walletAddress: wallet,
    },
    trade: {
      tx,
      isBuy: false,
      timestamp: "",
      amountUsd: "17384.25",
    },
  }] });

  assert.equal(result.transactionHash, tx);
  assert.equal(result.walletAddress, wallet);
  assert.equal(result.tokenAddress, token);
  assert.equal(result.networkId, 56);
  assert.equal(result.type, "sell");
  assert.equal(result.createdAt, Date.parse("2026-08-28T16:18:17.000Z"));
  assert.equal(result.tokenImageUrl, "https://example.com/niulai.png");
});

test("Pump EVM alert 与 profile 统一规范交易、钱包和 Token 后使用同一稳定 ID", () => {
  const tx = `0x${"ab".repeat(32)}`;
  const wallet = "0x1160079f1463dc5f9f20b1f1b9cf628718649c18";
  const token = "0x98096d17e191b3da1d5f99a6d7b3584351b11e18";
  const usdg = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
  const mixed = (address) => `0x${address.slice(2).toUpperCase()}`;
  const [alert] = api.sanitizeFollowedTrades({ items: [{
    kind: "trade",
    chainId: 4663,
    createdAt: "2026-08-28T16:18:17.000Z",
    walletAddress: mixed(wallet),
    coinMint: mixed(token),
    author: { userName: "evm-trader" },
    trade: { tx: mixed(tx), isBuy: true, amountUsd: "250" },
  }] });
  const [profile] = api.sanitizeProfileSwaps({ transactions: [{
    tx_hash: mixed(tx),
    block_time: 1788097000,
    type: "SWAP",
    chainId: 4663,
    token_in: {
      mint: mixed(token),
      amount: "1000",
      metadata: { symbol: "MEME", market_cap: "654321" },
    },
    token_out: { mint: mixed(usdg), amount: "250", metadata: { symbol: "USDG" } },
  }] }, { evmAddress: mixed(wallet), username: "evm-trader", userId: "pump-user-evm" });

  assert.equal(alert.transactionHash, tx);
  assert.equal(alert.walletAddress, wallet);
  assert.equal(alert.tokenAddress, token);
  assert.equal(profile.transactionHash, tx);
  assert.equal(profile.walletAddress, wallet);
  assert.equal(profile.tokenAddress, token);
  assert.equal(profile.tokenSymbol, "MEME");
  assert.equal(profile.marketCap, 654321);
  assert.equal(profile.baseAmount, 1000);
  assert.equal(profile.userId, "pump-user-evm");
  assert.equal(alert.id, profile.id);
});

test("Pump alert 兼容 coin metadata 中的 symbol 与市值字段", () => {
  const tokenAddress = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6U3M3zXjvB7mbonk";
  const [item] = api.sanitizeFollowedTrades({ items: [{
    kind: "trade",
    createdAt: "2026-08-28T08:30:00.000Z",
    walletAddress: "PumpWallet111111111111111111111111111111111",
    coinMint: tokenAddress,
    coin: { metadata: { symbol: "BONK", market_cap: "777000" } },
    trade: { tx: "solana-tx", isBuy: true, amountUsd: "42" },
  }] });

  assert.equal(item.tokenSymbol, "BONK");
  assert.equal(item.marketCap, 777000);
  assert.equal(item.marketCapAtTrade, null);
});

test("Pump alert 不把会随刷新变化的外层市值冒充交易时市值", () => {
  const tokenAddress = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6U3M3zXjvB7mbonk";
  const base = {
    kind: "trade",
    createdAt: "2026-08-28T08:30:00.000Z",
    walletAddress: "PumpWallet111111111111111111111111111111111",
    coinMint: tokenAddress,
    marketCap: "345800",
    coinMarketCap: "349900",
    fdv: "360503.6679305807",
    trade: { tx: "solana-tx", isBuy: false, amountUsd: "42" },
  };
  const [first] = api.sanitizeFollowedTrades({ items: [base] });
  const [refreshed] = api.sanitizeFollowedTrades({ items: [{
    ...base,
    marketCap: "367700",
    coinMarketCap: "367700",
    fdv: "367700",
  }] });

  assert.equal(first.marketCapAtTrade, null);
  assert.equal(refreshed.marketCapAtTrade, null);
  assert.equal(first.id, refreshed.id);
});

test("Pump alert 只接受明确标注 atTrade 的交易时市值字段", () => {
  const [item] = api.sanitizeFollowedTrades({ items: [{
    kind: "trade",
    createdAt: "2026-08-28T08:30:00.000Z",
    walletAddress: "PumpWallet111111111111111111111111111111111",
    coinMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6U3M3zXjvB7mbonk",
    trade: {
      tx: "solana-tx",
      isBuy: true,
      amountUsd: "42",
      marketCap: "999999",
      marketCapAtTrade: "456789",
      totalSupplyAtTrade: "1000000000",
    },
  }] });

  assert.equal(item.marketCapAtTrade, 456789);
  assert.equal(item.totalSupplyAtTrade, 1_000_000_000);
});

test("Pump 实时新交易冻结观察时的市值与供应量，后续行情不会覆盖", () => {
  const observedAt = Date.parse("2026-08-28T08:30:10.000Z");
  const base = {
    id: "pump:realtime-1",
    platform: "pump",
    type: "buy",
    createdAt: observedAt - 2_000,
    marketCap: 367_700,
    totalSupply: 1_000_000_000,
  };
  const [captured] = api.withRealtimeMarketSnapshots([base], observedAt);
  const [refreshed] = api.withRealtimeMarketSnapshots([{
    ...base,
    marketCap: 410_000,
    marketCapSnapshot: captured.marketCapSnapshot,
    priceUsdSnapshot: captured.priceUsdSnapshot,
    totalSupplySnapshot: captured.totalSupplySnapshot,
    marketSnapshotCapturedAt: captured.marketSnapshotCapturedAt,
    marketSnapshotSource: captured.marketSnapshotSource,
  }], observedAt + 30_000);

  assert.equal(captured.marketCapSnapshot, 367_700);
  assert.equal(captured.totalSupplySnapshot, 1_000_000_000);
  assert.equal(captured.priceUsdSnapshot, 0.0003677);
  assert.equal(captured.marketSnapshotCapturedAt, observedAt);
  assert.equal(captured.marketSnapshotSource, "pump-realtime-observed");
  assert.equal(refreshed.marketCapSnapshot, 367_700);
  assert.equal(refreshed.priceUsdSnapshot, 0.0003677);
});

test("Pump 历史 profile 当前行情不冒充实时交易快照", () => {
  const observedAt = Date.parse("2026-08-28T08:30:10.000Z");
  const historical = {
    id: "pump:historical-1",
    platform: "pump",
    type: "buy",
    createdAt: observedAt - api.REALTIME_MARKET_SNAPSHOT_MAX_AGE_MS - 1,
    marketCap: 367_700,
    totalSupply: 1_000_000_000,
  };

  const [result] = api.withRealtimeMarketSnapshots([historical], observedAt);

  assert.strictEqual(result, historical);
  assert.equal("marketCapSnapshot" in result, false);
});

test("Pump presence 自动识别当前用户并用 canonical SVM 钱包读取关注列表", () => {
  const presence = api.buildPresenceRequest();
  assert.equal(presence.url, `${api.POSITIONS_ORIGIN}/following-positions/alerts/presence`);
  assert.equal(presence.method, "POST");
  assert.equal(presence.credentials, "include");
  const release = api.buildPresenceDeleteRequest();
  assert.equal(release.url, presence.url);
  assert.equal(release.method, "DELETE");
  assert.equal(release.credentials, "include");
  assert.equal(release.allowEmptyResponse, true);
  assert.equal(
    api.sanitizeAlertsSubject("alertsFeed.user.92570c01-24ab-4ed3-9b0c-38c93f32573a.instance-1"),
    "alertsFeed.user.92570c01-24ab-4ed3-9b0c-38c93f32573a.instance-1",
  );
  assert.equal(api.sanitizeAlertsSubject("account_balance_change.wallet.*"), "");
  assert.equal(api.presenceUserId({
    subject: "alertsFeed.user.92570c01-24ab-4ed3-9b0c-38c93f32573a.*",
    heartbeatIntervalSeconds: 60,
    presenceTtlSeconds: 180,
  }), "92570c01-24ab-4ed3-9b0c-38c93f32573a");
  assert.equal(api.presenceRefreshMs({ heartbeatIntervalSeconds: 60 }), 60_000);

  const viewer = "A1EbAYSRyWCUgRi3Q9iphNtRD3pAqTrm2sq79CR5J4v8";
  const request = api.buildFollowingRequest(viewer);
  assert.equal(request.url, `${api.POSITIONS_ORIGIN}/following/${viewer}`);
  const following = api.sanitizeFollowing([{
    username: "hexiecs",
    profile_image: "https://example.com/hexiecs.png",
    address: "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm",
  }]);
  assert.deepEqual(following, [{
    username: "hexiecs",
    profileImage: "https://example.com/hexiecs.png",
    address: "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm",
    evmAddress: "",
    userId: "",
  }]);
});

test("Pump 官方 NATS trade 事件直接规范化并严格应用实时过滤", () => {
  const event = {
    id: "event-1",
    kind: "trade",
    createdAt: "2026-09-04T08:30:00.000Z",
    author: {
      userId: "pump-user-1",
      userName: "Pump Friend",
      profileImage: "https://example.com/avatar.png",
      walletAddress: "PumpWallet111111111111111111111111111111111",
    },
    coin: {
      mint: solanaParams.address,
      chainId: solanaParams.networkId,
      imageUri: "https://example.com/coin.png",
      symbol: "LIVE",
    },
    trade: {
      tx: "live-tx-1",
      isBuy: true,
      baseAmount: "250000",
      amountUsd: "25.5",
      priceUsd: "0.000102",
    },
  };

  const item = api.sanitizeRealtimeAlertTrade(event);
  assert.equal(item.pumpEventId, "event-1");
  assert.equal(item.sourceVerification, api.PUMP_ALERTS_NATS_VERIFICATION);
  assert.equal(item.walletAddress, event.author.walletAddress);
  assert.equal(item.tokenAddress, solanaParams.address);
  assert.equal(item.baseAmount, 250_000);
  assert.equal(item.usdAmount, 25.5);
  assert.equal(item.priceUsdAtTrade, 0.000102);
  assert.equal(item.tokenSymbol, "LIVE");
  assert.equal(api.sanitizeRealtimeAlertTrade({ ...event, id: "event-low", trade: {
    ...event.trade,
    amountUsd: 9.99,
  } }), null);
  assert.equal(api.sanitizeRealtimeAlertTrade({ ...event, id: "event-stub", stub: {} }), null);
  assert.equal(api.sanitizeRealtimeAlertTrade({ ...event, id: "event-evm", coin: {
    ...event.coin,
    chainId: 8453,
  } }), null);
  for (const [patch, expected] of [
    [{ kind: "follow" }, "non-trade"],
    [{ id: "" }, "missing-id"],
    [{ stub: {} }, "stub"],
    [{ author: null }, "missing-trade-author-coin"],
    [{ coin: { ...event.coin, chainId: 999999 } }, "unsupported-chain"],
    [{ trade: { ...event.trade, amountUsd: null } }, "missing-usd-amount"],
    [{ trade: { ...event.trade, amountUsd: 9.99 } }, "below-minimum-usd"],
    [{ trade: { ...event.trade, isBuy: null } }, "invalid-trade-fields"],
  ]) {
    const reasons = [];
    assert.equal(api.sanitizeRealtimeAlertTrade({ ...event, ...patch }, undefined, (reason) => reasons.push(reason)), null);
    assert.deepEqual(reasons, [expected]);
  }
});

test("Pump profile 请求保留网页的 dust/includeEvm 参数与 cursor", () => {
  const wallet = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const request = api.buildProfileTransactionsRequest(wallet, "cursor#tx");
  const url = new URL(request.url);
  assert.equal(url.origin, api.PROFILE_ORIGIN);
  assert.equal(url.pathname, `/transactions/${wallet}`);
  assert.equal(url.searchParams.get("dustFilter"), "true");
  assert.equal(url.searchParams.get("includeEvm"), "true");
  assert.equal(url.searchParams.get("cursor"), "cursor#tx");
  assert.equal(api.PROFILE_TRANSACTIONS_MAX_PAGES, 2);
  assert.equal(api.profileTransactionsNextCursor({
    pagination: { next_cursor: "next#tx" },
  }), "next#tx");
});

test("Pump profile SWAP 只在实时校验路径进入 RPC 候选", () => {
  const wallet = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const payload = { transactions: [{
    tx_hash: "4".repeat(88),
    block_time: 1788095419,
    type: "SWAP",
    chain: "solana",
    token_in: {
      mint: "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump",
      amount: "1000",
    },
    token_out: { mint: api.WRAPPED_SOL_MINT, amount: "1" },
  }] };

  assert.equal(api.profileTransferGroups(payload, { address: wallet }).length, 0);
  assert.equal(api.profileTransferGroups(payload, { address: wallet }, true).length, 1);
});

test("Pump profile 漏报的目标交易经 Solana 收据还原为 GTA 卖出", () => {
  const transactionHash = "2WHiUQCbxhg5YfS79PPH3xfWZ5LfaGdycqR2vqmotjkUonfox1U8ue6nSWcDE2NYkmhrsNb1bT2H9XKKEVKx5Jfv";
  const walletAddress = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const tokenAddress = "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump";
  const author = {
    address: walletAddress,
    username: "hexiecs",
    profileImage: "https://example.com/hexiecs.png",
  };
  const payload = { transactions: [{
    tx_hash: transactionHash,
    block_time: 1788095419,
    transaction_type: "RECEIVE",
    type: "TRANSFER",
    direction: "IN",
    token_transferred: {
      mint: api.SOLANA_USDC_MINT,
      amount: "2533.850574",
      metadata: { symbol: "USDC", decimals: "6" },
    },
  }] };
  const [group] = api.profileTransferGroups(payload, author);
  assert.equal(api.isProfileRpcCandidate(group), true);

  const rpc = { id: transactionHash, result: {
    blockTime: 1788095419,
    meta: {
      err: null,
      logMessages: [
        "Program log: Instruction: PumpSwapV3",
        "Program log: Instruction: Sell",
      ],
      preTokenBalances: [{
        owner: walletAddress,
        mint: tokenAddress,
        uiTokenAmount: { amount: "9173160413968", decimals: 6 },
      }, {
        owner: walletAddress,
        mint: api.SOLANA_USDC_MINT,
        uiTokenAmount: { amount: "114359996952", decimals: 6 },
      }],
      postTokenBalances: [{
        owner: walletAddress,
        mint: tokenAddress,
        uiTokenAmount: { amount: "4586580206984", decimals: 6 },
      }, {
        owner: walletAddress,
        mint: api.SOLANA_USDC_MINT,
        uiTokenAmount: { amount: "116893847526", decimals: 6 },
      }],
    },
  } };
  const item = api.withCoinMetadata(api.sanitizeSolanaRpcTrade(rpc, group), {
    symbol: "GTA",
    name: "GTA memes",
    image_uri: "ipfs://bafybeid52g3njfejwrugskdxjf3m2cbqj7jb32xhhpjvyhus7llcbuta4y",
    usd_market_cap: "",
    marketCap: 552688.53,
  });

  assert.equal(item.id, `pump:${transactionHash}:${walletAddress}:${tokenAddress}:sell`);
  assert.equal(item.platform, "pump");
  assert.equal(item.type, "sell");
  assert.equal(item.networkId, solanaParams.networkId);
  assert.equal(item.displayName, "hexiecs");
  assert.equal(item.tokenSymbol, "GTA");
  assert.equal(item.tokenName, "GTA memes");
  assert.equal(
    item.tokenImageUrl,
    "https://ipfs.io/ipfs/bafybeid52g3njfejwrugskdxjf3m2cbqj7jb32xhhpjvyhus7llcbuta4y",
  );
  assert.equal(item.usdAmount, 2533.850574);
  assert.equal(item.marketCap, 552688.53);
  assert.equal(item.createdAt, 1788095419000);
  assert.equal(item.sourceVerification, api.PUMP_CHAIN_RPC_VERIFICATION);
});

test("普通 Solana 转账即使 profile 返回记录也不会生成 Pump 买卖卡片", () => {
  const transactionHash = "4ovps8ths1TTLcsqnX7mfhQjXNRJqVs1A1UMyuXxPshKn41tkqM7Yz9zC24GPEBMv1o97CV4H21zfFEjFtSNwrEL";
  const walletAddress = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const tokenAddress = "DyKoCHKYn69hd2nW1rjRfScYdGz1YK4YahoN3ak8pump";
  const [group] = api.profileTransferGroups({ transactions: [{
    tx_hash: transactionHash,
    block_time: 1788095169,
    type: "TRANSFER",
    direction: "OUT",
    token_transferred: {
      mint: tokenAddress,
      amount: "100000",
      metadata: { program: "pump", symbol: "pumpcat" },
    },
  }] }, { address: walletAddress, username: "hexiecs" });
  const result = api.sanitizeSolanaRpcTrade({ result: {
    blockTime: 1788095169,
    meta: {
      err: null,
      logMessages: ["Program log: Instruction: TransferChecked"],
      preTokenBalances: [],
      postTokenBalances: [],
    },
  } }, group);

  assert.equal(api.isProfileRpcCandidate(group), true);
  assert.equal(result, null);
});

test("所有 Solana TRANSFER 都进入收据判定，不依赖 pump 后缀或 profile 报价腿", () => {
  const walletAddress = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const tokenAddress = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6U3M3zXjvB7mbonk";
  const transactionHash = "5to5eTFBBDsTd83f9J2A3jSnefiDQtcvo8em34Gakd1YLRqBb6LYrHpXCuFBKtZYdgku6CjFGdfcVyKwCGJhrb23";
  const [group] = api.profileTransferGroups({ transactions: [{
    tx_hash: transactionHash,
    block_time: 1788096000,
    type: "TRANSFER",
    direction: "OUT",
    token_transferred: {
      mint: tokenAddress,
      amount: "500000",
      metadata: { program: "non_launchpad", symbol: "BONK", name: "Bonk" },
    },
  }] }, { address: walletAddress, username: "generic-trader" });

  assert.equal(api.isProfileRpcCandidate(group), true);
  const item = api.sanitizeSolanaRpcTrade({ result: {
    blockTime: 1788096000,
    transaction: { message: { accountKeys: [{ pubkey: walletAddress, signer: true }] } },
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [10_000_000_000],
      postBalances: [14_999_995_000],
      logMessages: ["Program log: Instruction: SharedAccountsRoute"],
      preTokenBalances: [{
        owner: walletAddress,
        mint: tokenAddress,
        programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        uiTokenAmount: { amount: "100000000000", decimals: 5 },
      }],
      postTokenBalances: [{
        owner: walletAddress,
        mint: tokenAddress,
        programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        uiTokenAmount: { amount: "50000000000", decimals: 5 },
      }],
    },
  } }, group, 100);

  assert.equal(item.type, "sell");
  assert.equal(item.tokenAddress, tokenAddress);
  assert.equal(item.tokenSymbol, "BONK");
  assert.equal(item.tokenName, "Bonk");
  assert.equal(item.usdAmount, 500);
});

test("临时报价账户没有余额腿时，签名钱包的一种 Token 净变化仍可确认实际 swap", () => {
  const walletAddress = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const tokenAddress = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6U3M3zXjvB7mbonk";
  const transactionHash = "WxkUQqhDCik4LsPJhktQLCQVfbgL1Wvr91TkCk45ciSFrmSkH9apcKUJs6wTzyYpbtu6zdXm59zT4Go1S23Upn9";
  const [group] = api.profileTransferGroups({ transactions: [{
    tx_hash: transactionHash,
    block_time: 1788096010,
    type: "TRANSFER",
    direction: "IN",
    token_transferred: {
      mint: tokenAddress,
      amount: "1000",
      metadata: { program: "non_launchpad", symbol: "BONK" },
    },
  }] }, { address: walletAddress, username: "generic-trader" });
  const baseRpc = {
    blockTime: 1788096010,
    transaction: { message: { accountKeys: [{ pubkey: walletAddress, signer: true }] } },
    meta: {
      err: null,
      logMessages: ["Program log: Instruction: SwapBaseInput"],
      preTokenBalances: [],
      postTokenBalances: [{
        owner: walletAddress,
        mint: tokenAddress,
        uiTokenAmount: { amount: "100000000", decimals: 5 },
      }],
    },
  };

  const item = api.sanitizeSolanaRpcTrade({ result: baseRpc }, group, 100);
  assert.equal(item.type, "buy");
  assert.equal(item.tokenAddress, tokenAddress);
  assert.equal(item.usdAmount, null);
  assert.equal(api.sanitizeSolanaRpcTrade({ result: {
    ...baseRpc,
    transaction: { message: { accountKeys: [{ pubkey: walletAddress, signer: false }] } },
  } }, group, 100), null);
});

test("USDT 报价、失败 swap 与普通双向转账分别正确识别和排除", () => {
  const walletAddress = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
  const tokenAddress = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6U3M3zXjvB7mbonk";
  const transactionHash = "2EnCz5kec3N8wtLCCbZrdjacGwhhw8RS5dqQrAP6a2fJWK8ZZ61MRpFoyTqWfA6g7PQKqzoi4BEMYXnoHH1hEGVE";
  const [group] = api.profileTransferGroups({ transactions: [{
    tx_hash: transactionHash,
    block_time: 1788096020,
    type: "TRANSFER",
    direction: "IN",
    token_transferred: {
      mint: tokenAddress,
      amount: "1000",
      metadata: { symbol: "BONK" },
    },
  }] }, { address: walletAddress, username: "generic-trader" });
  const meta = {
    err: null,
    logMessages: ["Program log: Instruction: RouteV2"],
    preTokenBalances: [{
      owner: walletAddress,
      mint: api.SOLANA_USDT_MINT,
      uiTokenAmount: { amount: "500000000", decimals: 6 },
    }],
    postTokenBalances: [{
      owner: walletAddress,
      mint: api.SOLANA_USDT_MINT,
      uiTokenAmount: { amount: "375000000", decimals: 6 },
    }, {
      owner: walletAddress,
      mint: tokenAddress,
      uiTokenAmount: { amount: "100000000", decimals: 5 },
    }],
  };
  const item = api.sanitizeSolanaRpcTrade({ result: { blockTime: 1788096020, meta } }, group);

  assert.equal(item.type, "buy");
  assert.equal(item.usdAmount, 125);
  assert.equal(api.sanitizeSolanaRpcTrade({ result: {
    blockTime: 1788096020,
    meta: { ...meta, err: { InstructionError: [3, "Custom"] } },
  } }, group), null);
  assert.equal(api.sanitizeSolanaRpcTrade({ result: {
    blockTime: 1788096020,
    meta: { ...meta, logMessages: ["Program log: Instruction: TransferChecked"] },
  } }, group), null);
});

function evmTopic(address) {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function evmTransfer(token, from, to, amount = 1n) {
  return {
    address: token,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      evmTopic(from),
      evmTopic(to),
    ],
    data: `0x${amount.toString(16).padStart(64, "0")}`,
  };
}

test("Pump profile 的 EVM SWAP 直接按 canonical EVM 钱包生成卡片", () => {
  const wallet = "0x1160079f1463dc5f9f20b1f1b9cf628718649c18";
  const token = "0x98096d17e191b3da1d5f99a6d7b3584351b11e18";
  const usdg = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
  const tx = `0x${"12".repeat(32)}`;
  const [item] = api.sanitizeProfileSwaps({ transactions: [{
    tx_hash: tx,
    block_time: 1788097000,
    type: "SWAP",
    transaction_type: "BUY",
    chainId: "robinhood",
    wallet_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    token_in: { mint: token, amount: "1000", metadata: { symbol: "MEME" } },
    token_out: { mint: usdg, amount: "250", metadata: { symbol: "USDG" } },
  }] }, {
    address: "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm",
    evmAddress: wallet,
    username: "evm-trader",
  });

  assert.equal(item.type, "buy");
  assert.equal(item.networkId, 4663);
  assert.equal(item.walletAddress, wallet);
  assert.equal(item.tokenAddress, token);
  assert.equal(item.tokenSymbol, "MEME");
  assert.equal(item.usdAmount, 250);
  assert.equal(item.baseAmount, 1000);
  assert.equal(item.quoteAmount, 250);
  assert.equal(item.quoteAddress, usdg);
  assert.equal(item.quoteSymbol, "USDG");
});

test("Pump profile 保留 ETH/WETH 原生币成交量，不再降级成 0", () => {
  const wallet = "0x1160079f1463dc5f9f20b1f1b9cf628718649c18";
  const token = "0x98096d17e191b3da1d5f99a6d7b3584351b11e18";
  const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const [item] = api.sanitizeProfileSwaps({ transactions: [{
    tx_hash: `0x${"14".repeat(32)}`,
    block_time: 1788097002,
    type: "SWAP",
    networkId: 1,
    sol_value: "196.5",
    token_in: { mint: token, amount: "1000", metadata: { symbol: "NAV" } },
    token_out: { mint: weth, amount: "0.2715", metadata: { symbol: "WETH" } },
  }] }, { evmAddress: wallet, username: "traderpow" });

  assert.equal(item.type, "buy");
  assert.equal(item.usdAmount, null);
  assert.equal(item.quoteAmount, 0.2715);
  assert.equal(item.quoteAddress, weth);
  assert.equal(item.quoteSymbol, "WETH");
  assert.equal(item.baseAmount, 1000);
});

test("Robinhood 代付买入从 receipt 稳定币流量恢复真实 USD、价格和成交 MC", () => {
  const wallet = "0xbebbad0b95ed88e6c56c8d79daa82257e97c3f44";
  const smartAccount = "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f";
  const relayer = "0xf70da97812cb96acdf810712aa562db8dfa3dbef";
  const router = "0x39b38686a19836ac10162c490e4558e120cbbe5f";
  const token = "0x98096d17e191b3da1d5f99a6d7b3584351b11e18";
  const weth = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
  const usdg = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
  const tx = `0x${"ab".repeat(32)}`;
  const baseAmount = 328_310.19149403373;
  const usdAmount = 19_922.477622;
  const payload = { transactions: [{
    tx_hash: tx,
    block_time: 1788269932,
    type: "SWAP",
    transaction_type: "BUY",
    network_id: 4663,
    sol_value: "196.5094787745673",
    token_in: { mint: token, amount: String(baseAmount), metadata: { symbol: "BONER" } },
    token_out: { mint: weth, amount: "8.177491066576097", metadata: { symbol: "ETH" } },
  }] };
  const [group] = api.profileTransferGroups(
    payload,
    { evmAddress: wallet, username: "hexiecs" },
    true,
  );
  const item = api.sanitizeEvmRpcTrade({
    transaction: { hash: tx, from: relayer, to: router, value: "0x0", input: "0x12345678" },
    receipt: {
      status: "0x1",
      transactionHash: tx,
      logs: [
        evmTransfer(usdg, relayer, smartAccount, 19_922_477_622n),
        evmTransfer(usdg, smartAccount, router, 19_922_477_622n),
        evmTransfer(token, smartAccount, wallet, 328_310_191_494_033_730_000_000n),
      ],
    },
  }, group);
  const enriched = api.withCoinMetadata(item, {
    symbol: "BONER",
    total_supply_str: "1000000000000000000000000000",
    base_decimals: 18,
    usd_market_cap: 53_989_683,
  });

  assert.equal(item.sourceVerification, api.PUMP_CHAIN_RPC_VERIFICATION);
  assert.equal(item.usdAmount, usdAmount);
  assert.equal(item.baseAmount, baseAmount);
  assert.ok(Math.abs(item.priceUsdAtTrade - (usdAmount / baseAmount)) < 1e-12);
  assert.ok(Math.abs(enriched.marketCapAtTrade - 60_681_873.84418142) < 0.01);
  assert.equal(enriched.marketCap, 53_989_683, "当前 MC 与成交 MC 必须分开保留");
});

test("Pump coin metadata 按 decimals 将原始 total_supply 转为可展示供应量", () => {
  const item = api.withCoinMetadata({
    tokenSymbol: "",
    tokenName: "",
    tokenImageUrl: "",
    marketCap: null,
    totalSupply: null,
  }, {
    symbol: "rehanfal",
    total_supply_str: "1000000000000000",
    base_decimals: 6,
    usd_market_cap: 308622.16,
  });

  assert.equal(item.totalSupply, 1_000_000_000);
  assert.equal(item.marketCap, 308622.16);
});

test("Pump profile 兼容 EVM networkId 字段并识别 Base USDC 报价", () => {
  const wallet = "0x1160079f1463dc5f9f20b1f1b9cf628718649c18";
  const token = "0x98096d17e191b3da1d5f99a6d7b3584351b11e18";
  const baseUsdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bdA02913";
  const [item] = api.sanitizeProfileSwaps({ transactions: [{
    tx_hash: `0x${"13".repeat(32)}`,
    block_time: 1788097001,
    type: "SWAP",
    networkId: 8453,
    token_in: { mint: token, amount: "1000", metadata: { symbol: "MEME" } },
    token_out: { mint: baseUsdc, amount: "250", metadata: {} },
  }] }, { evmAddress: wallet, username: "base-trader" });

  assert.equal(item.type, "buy");
  assert.equal(item.networkId, 8453);
  assert.equal(item.walletAddress, wallet);
  assert.equal(item.tokenAddress, token);
  assert.equal(item.usdAmount, 250);
});

test("EVM TRANSFER 经 receipt 中的目标 Token 净变化和 swap 证据还原为卖出", () => {
  const wallet = "0x1160079f1463dc5f9f20b1f1b9cf628718649c18";
  const token = "0x98096d17e191b3da1d5f99a6d7b3584351b11e18";
  const usdg = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
  const router = "0x1111111111111111111111111111111111111111";
  const pool = "0x2222222222222222222222222222222222222222";
  const tx = `0x${"34".repeat(32)}`;
  const [group] = api.profileTransferGroups({ transactions: [{
    tx_hash: tx,
    block_time: 1788097010,
    type: "TRANSFER",
    transaction_type: "SEND",
    network_id: 4663,
    direction: "OUT",
    token_transferred: {
      mint: token,
      amount: "1000",
      metadata: { symbol: "MEME", name: "Meme Token" },
    },
  }, {
    tx_hash: tx,
    block_time: 1788097010,
    type: "TRANSFER",
    transaction_type: "RECEIVE",
    network_id: 4663,
    direction: "IN",
    token_transferred: {
      mint: usdg,
      amount: "250.75",
      metadata: { symbol: "USDG" },
    },
  }] }, { evmAddress: wallet, username: "evm-trader" });
  const item = api.sanitizeEvmRpcTrade({
    transaction: { hash: tx, from: router, to: router, value: "0x0", input: "0x12345678" },
    receipt: {
      status: "0x1",
      transactionHash: tx,
      logs: [
        evmTransfer(token, wallet, pool, 1_000n),
        evmTransfer(usdg, pool, router, 250_750_000n),
        {
          address: pool,
          topics: ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"],
          data: "0x",
        },
      ],
    },
  }, group);

  assert.equal(api.isProfileRpcCandidate(group), true);
  assert.equal(group.networkId, 4663);
  assert.equal(item.sourceVerification, api.PUMP_CHAIN_RPC_VERIFICATION);
  assert.equal(item.type, "sell");
  assert.equal(item.walletAddress, wallet);
  assert.equal(item.tokenAddress, token);
  assert.equal(item.tokenSymbol, "MEME");
  assert.equal(item.usdAmount, 250.75);
});

test("EVM 代付交易不依赖 transaction.from，但普通 transfer、失败和歧义交易均排除", () => {
  const wallet = "0x1160079f1463dc5f9f20b1f1b9cf628718649c18";
  const token = "0xbeea1d618e533a387d941f58a7d4c9b7bd377777";
  const otherToken = "0x3333333333333333333333333333333333333333";
  const usdt = "0x55d398326f99059ff775485246999027b3197955";
  const router = "0x4444444444444444444444444444444444444444";
  const pool = "0x5555555555555555555555555555555555555555";
  const tx = `0x${"56".repeat(32)}`;
  const [group] = api.profileTransferGroups({ transactions: [{
    tx_hash: tx,
    block_time: 1788097020,
    type: "TRANSFER",
    network_id: 56,
    direction: "OUT",
    token_transferred: { mint: token, amount: "1000", metadata: { symbol: "MEME" } },
  }] }, { evmAddress: wallet, username: "aa-wallet" });
  const swapReceipt = {
    status: "0x1",
    transactionHash: tx,
    logs: [
      evmTransfer(token, wallet, pool, 1_000n),
      evmTransfer(usdt, pool, router, 300_000_000n),
      {
        address: pool,
        topics: ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"],
        data: "0x",
      },
    ],
  };
  const relayed = api.sanitizeEvmRpcTrade({
    transaction: { hash: tx, from: router, to: router, value: "0x0", input: "0x174dea71" },
    receipt: swapReceipt,
  }, group);
  assert.equal(relayed.type, "sell");

  assert.equal(api.sanitizeEvmRpcTrade({
    transaction: { hash: tx, from: wallet, to: token, value: "0x0", input: "0xa9059cbb" },
    receipt: { ...swapReceipt, logs: [evmTransfer(token, wallet, pool, 1_000n)] },
  }, group), null);
  assert.equal(api.sanitizeEvmRpcTrade({
    transaction: { hash: tx, from: router, to: router, value: "0x0", input: "0x174dea71" },
    receipt: { ...swapReceipt, status: "0x0" },
  }, group), null);
  const profileDisambiguated = api.sanitizeEvmRpcTrade({
    transaction: { hash: tx, from: router, to: router, value: "0x0", input: "0x174dea71" },
    receipt: {
      ...swapReceipt,
      logs: [
        ...swapReceipt.logs,
        evmTransfer(otherToken, wallet, pool, 5n),
      ],
    },
  }, group);
  assert.equal(profileDisambiguated.tokenAddress, token);

  const ambiguousTx = `0x${"67".repeat(32)}`;
  const [ambiguousGroup] = api.profileTransferGroups({ transactions: [{
    tx_hash: ambiguousTx,
    block_time: 1788097021,
    type: "TRANSFER",
    network_id: 56,
    direction: "IN",
    token_transferred: { mint: usdt, amount: "300", metadata: { symbol: "USDT" } },
  }] }, { evmAddress: wallet, username: "aa-wallet" });
  assert.equal(api.sanitizeEvmRpcTrade({
    transaction: {
      hash: ambiguousTx,
      from: router,
      to: router,
      value: "0x0",
      input: "0x174dea71",
    },
    receipt: {
      ...swapReceipt,
      transactionHash: ambiguousTx,
      logs: [
        evmTransfer(token, wallet, pool, 1_000n),
        evmTransfer(otherToken, wallet, pool, 5n),
        evmTransfer(usdt, pool, wallet, 300_000_000n),
      ],
    },
  }, ambiguousGroup), null);
});

test("EVM receipt 中无关池子的 quote transfer 与 Swap topic 不会把普通转账判成交易", () => {
  const wallet = "0x1160079f1463dc5f9f20b1f1b9cf628718649c18";
  const token = "0xbeea1d618e533a387d941f58a7d4c9b7bd377777";
  const usdt = "0x55d398326f99059ff775485246999027b3197955";
  const sender = "0x2222222222222222222222222222222222222222";
  const unrelatedPool = "0x3333333333333333333333333333333333333333";
  const unrelatedTrader = "0x4444444444444444444444444444444444444444";
  const tx = `0x${"cd".repeat(32)}`;
  const [group] = api.profileTransferGroups({ transactions: [{
    tx_hash: tx,
    block_time: 1788097030,
    type: "TRANSFER",
    network_id: 56,
    direction: "IN",
    token_transferred: { mint: token, amount: "1000", metadata: { symbol: "MEME" } },
  }] }, { evmAddress: wallet, username: "tracked-wallet" });
  const receipt = {
    status: "0x1",
    transactionHash: tx,
    logs: [
      evmTransfer(token, sender, wallet, 1_000n),
      evmTransfer(usdt, unrelatedTrader, unrelatedPool, 300_000_000n),
      {
        address: unrelatedPool,
        topics: ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"],
        data: "0x",
      },
    ],
  };

  assert.equal(api.sanitizeEvmRpcTrade({
    transaction: { hash: tx, from: unrelatedTrader, to: unrelatedPool, value: "0x0", input: "0x12345678" },
    receipt,
  }, group), null);
  assert.equal(api.sanitizeEvmRpcTrade({
    transaction: { hash: tx, from: unrelatedTrader, to: unrelatedPool, value: "0xde0b6b3a7640000", input: "0x12345678" },
    receipt,
  }, group), null);
  assert.equal(api.sanitizeEvmRpcTrade({
    transaction: { hash: tx, from: unrelatedTrader, to: unrelatedPool, value: "0x0", input: "0x12345678" },
    receipt: {
      ...receipt,
      logs: [
        evmTransfer(token, sender, wallet, 1_000n),
        evmTransfer(usdt, sender, unrelatedTrader, 300_000_000n),
      ],
    },
  }, group), null);
  assert.equal(api.sanitizeEvmRpcTrade({
    transaction: { hash: tx, from: wallet, to: unrelatedPool, value: "0xde0b6b3a7640000", input: "0x12345678" },
    receipt: { ...receipt, logs: [evmTransfer(token, sender, wallet, 1_000n)] },
  }, group), null);
});

test("EVM receipt 请求按交易哈希同时读取 transaction 与 receipt", () => {
  const first = `0x${"78".repeat(32)}`;
  const second = `0x${"9a".repeat(32)}`;
  const requests = api.buildEvmTransactionsRequest([first, second, first.toUpperCase()]);
  assert.deepEqual(requests.map((request) => request.method), [
    "eth_getTransactionByHash",
    "eth_getTransactionReceipt",
    "eth_getTransactionByHash",
    "eth_getTransactionReceipt",
  ]);
  assert.deepEqual(requests.map((request) => request.params[0]), [first, first, second, second]);
  assert.throws(() => api.buildEvmTransactionsRequest(["bad-hash"]), /INVALID_EVM_TRANSACTION_HASHES/);
});

function abiDynamicString(value) {
  const bytes = Buffer.from(value, "utf8");
  const paddedLength = Math.ceil(bytes.length / 32) * 32;
  return `0x${(32n).toString(16).padStart(64, "0")}${BigInt(bytes.length).toString(16).padStart(64, "0")}${bytes.toString("hex").padEnd(paddedLength * 2, "0")}`;
}

function abiBytes32(value) {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}`;
}

test("EVM Token ticker 请求按地址去重并使用 symbol() selector", () => {
  const first = "0x1111111111111111111111111111111111111111";
  const second = "0x2222222222222222222222222222222222222222";
  const requests = api.buildEvmTokenSymbolRequests([
    first,
    `0x${first.slice(2).toUpperCase()}`,
    second,
  ], 4663);

  assert.equal(api.EVM_SYMBOL_DATA, "0x95d89b41");
  assert.deepEqual(requests.map((request) => request.id), [`symbol:${first}`, `symbol:${second}`]);
  assert.deepEqual(requests.map((request) => request.method), ["eth_call", "eth_call"]);
  assert.deepEqual(requests.map((request) => request.params), [
    [{ to: first, data: api.EVM_SYMBOL_DATA }, "latest"],
    [{ to: second, data: api.EVM_SYMBOL_DATA }, "latest"],
  ]);
  assert.deepEqual(api.buildEvmTokenSymbolRequests([solanaParams.address], solanaParams.networkId), []);
});

test("EVM Token ticker 严格解码标准 dynamic string 与 legacy bytes32", () => {
  assert.equal(api.decodeEvmTokenSymbol(abiDynamicString("MEME")), "MEME");
  assert.equal(api.decodeEvmTokenSymbol(abiDynamicString("牛来")), "牛来");
  assert.equal(api.decodeEvmTokenSymbol(abiBytes32("LEGACY")), "LEGACY");
});

test("EVM Token ticker 拒绝空值、控制字符、错误 offset、padding 与畸形 UTF-8", () => {
  const invalidPadding = `${abiDynamicString("OK").slice(0, -2)}01`;
  const wrongOffset = `0x${(64n).toString(16).padStart(64, "0")}${abiDynamicString("OK").slice(66)}`;
  assert.equal(api.decodeEvmTokenSymbol("0x"), "");
  assert.equal(api.decodeEvmTokenSymbol(abiDynamicString("")), "");
  assert.equal(api.decodeEvmTokenSymbol(abiDynamicString("BAD\nSYMBOL")), "");
  assert.equal(api.decodeEvmTokenSymbol(wrongOffset), "");
  assert.equal(api.decodeEvmTokenSymbol(invalidPadding), "");
  assert.equal(api.decodeEvmTokenSymbol(`0x${"ff".repeat(32)}`), "");
  assert.equal(api.decodeEvmTokenSymbol("0x1234"), "");
});


for (const [chain, networkId] of Object.entries(core.TOKEN_NETWORK_IDS)) {
  test(`Pump NATS ${chain} 买卖支持数字和字符串链 ID，并与 REST 身份一致`, () => {
    const solana = chain === "sol";
    const wallet = solana ? "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm" : `0x${"Ab".repeat(20)}`;
    const mint = solana ? solanaParams.address : `0x${"Cd".repeat(20)}`;
    const tx = solana ? "live-solana-signature" : `0x${"Ef".repeat(32)}`;
    for (const isBuy of [true, false]) {
      for (const chainId of [networkId, String(networkId)]) {
        const event = { id: `live-${chain}-${isBuy}`, kind: "trade", createdAt: "2026-09-06T08:30:00.000Z",
          author: { userId: "friend", userName: "Friend", walletAddress: wallet },
          coin: { mint, chainId, symbol: "LIVE" },
          trade: { tx, isBuy, baseAmount: 100, amountUsd: 25, priceUsd: 0.25 } };
        const item = api.sanitizeRealtimeAlertTrade(event);
        assert.ok(item);
        assert.equal(item.networkId, networkId);
        assert.equal(item.transactionHash, solana ? tx : tx.toLowerCase());
        assert.equal(item.walletAddress, solana ? wallet : wallet.toLowerCase());
        assert.equal(item.tokenAddress, solana ? mint : mint.toLowerCase());
        assert.equal(item.sourceVerification, api.PUMP_ALERTS_NATS_VERIFICATION);
        const [rest] = api.sanitizeFollowedTrades({ items: [{ ...event, walletAddress: wallet, coinMint: mint }] });
        assert.equal(item.id, rest.id);
        assert.equal(api.sanitizeRealtimeAlertTrade({ ...event, coin: { ...event.coin,
          mint: solana ? `0x${"ab".repeat(20)}` : solanaParams.address } }), null);
        if (!solana) {
          assert.equal(api.sanitizeRealtimeAlertTrade({ ...event, author: { ...event.author, walletAddress: "invalid" } }), null);
          assert.equal(api.sanitizeRealtimeAlertTrade({ ...event, trade: { ...event.trade, tx: "invalid" } }), null);
        }
      }
    }
  });
}

test('Pump REST 与 NATS 保留供应量及实时市值，原始整数按 decimals 转换', () => {
  const row = require('./fixtures/pump-evm-alert.json');
  const user = require('./fixtures/pump-evm-alert-user.json');
  const coin = { mint: row.coinMint, chainId: row.chainId, symbol: row.symbol,
    total_supply_str: '1372742700000000000000000000', decimals: 18, marketCap: 690877.7783100586 };
  const author = { ...row.author, walletAddress: user.canonical_evm_wallet };
  const [rest] = api.sanitizeFollowedTrades({ items: [{ ...row, coin, author, walletAddress: author.walletAddress }] });
  const nats = api.sanitizeRealtimeAlertTrade({ ...row, id: 'marketcap-fields', coin, author });
  for (const item of [rest, nats]) {
    assert.equal(item.totalSupply, 1_372_742_700);
    assert.equal(item.marketCap, coin.marketCap);
    assert.equal(item.totalSupplyAtTrade, null);
    assert.equal(item.marketCapAtTrade, null);
    assert.equal(item.priceUsdAtTrade, row.trade.priceUsd);
    const [live] = api.withRealtimeMarketSnapshots([item], item.createdAt);
    const native = require('../src/gmgn-follow-bridge').toGmgnFollowSocketTrade(live);
    assert.equal(Number(native.bts), item.totalSupply);
    assert.equal(Number(native.pu), row.trade.priceUsd);
  }
});
