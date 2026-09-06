const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../src/fomo-api");

const params = {
  address: "0x1111111111111111111111111111111111111111",
  networkId: 56,
};
const EVM_WALLET = "0x2222222222222222222222222222222222222222";
const SOLANA_WALLET = "11111111111111111111111111111111";
const LUCKY_TOKEN = "C6XQfwrPs9pzFbv6PppeEuibQM9Z9mH48sA7JqJMpump";
const JPEGKITE_WALLET = "Hv3a4PaPvMPE5inwNoS27uFBRoeoJJMRSCJsKtExNH54";
const FOMO_WRONG_WALLET = "H4goKfmoYwFgzcAyi2L3AM6jzWhjtUgDA886AWtWa4h3";

test("构造 metadata、holders 与排除 Thesis 的 Feed 请求", () => {
  const requests = api.buildRequests(params);
  assert.equal(requests.metadata.method, "POST");
  assert.equal(requests.metadata.body, JSON.stringify([`${params.address}:56`]));

  const holders = new URL(requests.holders.url);
  assert.deepEqual(JSON.parse(holders.searchParams.get("tokens")), [{ address: params.address, networkId: 56 }]);
  assert.equal(holders.searchParams.get("limit"), "100");

  const feed = new URL(requests.feed.url);
  assert.equal(feed.searchParams.get("tokenAddress"), params.address);
  assert.equal(feed.searchParams.get("networkId"), "56");
  assert.equal(feed.searchParams.get("excludeThesis"), "true");
  assert.equal(feed.searchParams.get("threshold"), "1000");

  const trade = api.buildTradeRequest(params, { tradeId: "trade-1", userId: "user-1" });
  assert.equal(trade.url, "https://prod-api.fomo.family/trades/trade-1");
  assert.equal(trade.method, "GET");

  const gmgn = new URL(api.buildGmgnHoldersRequest(params).url);
  assert.equal(gmgn.origin, "https://gmgn.ai");
  assert.equal(gmgn.pathname, `/vas/api/v1/token_holders/bsc/${params.address}`);
  assert.equal(gmgn.searchParams.get("limit"), "100");
  assert.equal(gmgn.searchParams.get("orderby"), "amount_percentage");
});

test("清洗 Token metadata 和 About 字段", () => {
  const result = api.sanitizeMetadata({ responseObject: [{
    marketCap: "348200",
    priceUSD: "0.0003482",
    change24: "16.0725",
    liquidity: "40000",
    volume24: "100000",
    token: {
      address: params.address,
      networkId: 56,
      createdAt: 123,
      info: {
        name: "Demo Panda",
        symbol: "DEMO",
        totalSupply: 1_000_000_000,
        description: "Panda token",
        imageLargeUrl: "https://example.com/token.png",
      },
      socialLinks: {
        website: "https://example.com",
        twitter: "javascript:alert(1)",
      },
      launchpad: { launchpadName: "Four.meme" },
    },
  }] }, params);

  assert.equal(result.name, "Demo Panda");
  assert.equal(result.marketCap, 348200);
  assert.equal(result.imageUrl, "https://example.com/token.png");
  assert.deepEqual(result.socialLinks, { website: "https://example.com/" });
  assert.equal(result.launchpad.name, "Four.meme");
});

test("清洗 Top Holders 并计算完整的 Fomo 持仓总额", () => {
  const result = api.sanitizeHolders({ responseObject: [{
    tokenAddress: params.address,
    networkId: 56,
    totalHolders: 274,
    topHolders: [{
      tradeId: "trade-1",
      humanAmount: 10_000_000,
      value: 13445.86,
      pnl: 5000,
      costBasis: 8445.86,
      averageEntryPrice: 0.0002093,
      user: {
        id: "user-1",
        displayName: "Trader Alpha",
        userHandle: "trader-alpha",
        profilePictureLink: "https://example.com/avatar.png",
      },
      comment: { comment: "the holder comment", numLikes: 19 },
    }, {
      tradeId: "trade-2",
      humanAmount: 5_000_000,
      value: "6966.28",
      user: { id: "user-2", displayName: "Trader Beta" },
    }],
  }] }, params, 1_000_000_000);

  assert.equal(result.totalHolders, 274);
  assert.equal(result.fomoPositionValue, 20412.14);
  assert.equal(result.fomoPositionCount, 2);
  assert.equal(result.pricedPositionCount, 2);
  assert.equal(result.isFomoPositionValueComplete, true);
  assert.equal(result.fomoTokenAmount, 15_000_000);
  assert.equal(result.fomoOwnershipPercent, 1.5);
  assert.equal(result.isFomoOwnershipComplete, true);
  assert.equal(result.items[0].humanAmount, 10_000_000);
  assert.equal(result.items[0].humanAmountRaw, "10000000");
  assert.equal(result.items[0].ownershipPercent, 1);
  assert.equal(result.items[0].displayName, "Trader Alpha");
  assert.equal(result.items[0].platform, "fomo");
  assert.equal(result.items[0].tradeId, "trade-1");
  assert.equal(result.items[0].userId, "user-1");
  assert.equal(result.items[0].profileUrl, "https://fomo.family/profile/trader-alpha");
  assert.equal(result.items[0].walletAddress, undefined);
  assert.equal(result.items[0].averageEntryPrice, 0.0002093);
  assert.equal(result.items[0].comment, "the holder comment");
  assert.equal(result.items[0].likes, 19);
});

test("Fomo 用户头像链接使用 profile handle 并安全编码", () => {
  assert.equal(api.buildProfileUrl("@Trader Alpha"), "https://fomo.family/profile/Trader%20Alpha");
  assert.equal(api.buildProfileUrl(""), "");
});

test("不用 Fomo 地址字段，按当前持仓和买卖记录唯一匹配 GMGN 链上地址", () => {
  const solParams = { address: LUCKY_TOKEN, networkId: 1399811149 };
  const holder = { tradeId: "trade-jpegkite", userId: "user-jpegkite", humanAmount: 12_541_051.61 };
  const tradePayload = { responseObject: {
    userId: "user-jpegkite",
    trade: {
      id: "trade-jpegkite",
      userAddress: FOMO_WRONG_WALLET,
      tokenAddress: LUCKY_TOKEN,
      networkId: solParams.networkId,
      humanTokenAmount: 12_541_051.61,
    },
    swaps: [{
      address: FOMO_WRONG_WALLET,
      outTradeId: "trade-jpegkite",
      outTokenAddress: LUCKY_TOKEN,
      outHumanAmount: 25_082_103.22,
    }, {
      address: FOMO_WRONG_WALLET,
      inTradeId: "trade-jpegkite",
      inTokenAddress: LUCKY_TOKEN,
      inHumanAmount: 12_541_051.61,
    }],
  } };
  const gmgnPayload = { data: { list: [{
    address: FOMO_WRONG_WALLET,
    balance: 0,
    buy_amount_cur: 0,
    sell_amount_cur: 0,
  }, {
    address: JPEGKITE_WALLET,
    balance: 12_541_051.613355,
    buy_amount_cur: 25_082_103.226709,
    sell_amount_cur: 12_541_051.613354,
  }] } };
  assert.equal(
    api.sanitizeVerifiedHolderAddress(tradePayload, gmgnPayload, solParams, holder),
    JPEGKITE_WALLET,
  );

  const wrongRow = structuredClone(tradePayload);
  wrongRow.responseObject.userId = "user-2";
  assert.throws(
    () => api.sanitizeVerifiedHolderAddress(wrongRow, gmgnPayload, solParams, holder),
    /HOLDER_IDENTITY_MISMATCH/,
  );

  const wrongAmount = structuredClone(tradePayload);
  wrongAmount.responseObject.trade.humanTokenAmount = 5_000_000;
  assert.throws(
    () => api.sanitizeVerifiedHolderAddress(wrongAmount, gmgnPayload, solParams, holder),
    /HOLDER_AMOUNT_MISMATCH/,
  );
});

test("同持仓候选用交易统计消歧，仍不唯一时拒绝复制", () => {
  const holder = { tradeId: "trade-1", userId: "user-1", humanAmount: 10_000_000 };
  const tradePayload = { responseObject: {
    userId: "user-1",
    trade: {
      id: "trade-1",
      userAddress: EVM_WALLET,
      tokenAddress: params.address,
      networkId: params.networkId,
      humanTokenAmount: 10_000_000,
    },
    swaps: [{
      outTradeId: "trade-1",
      outTokenAddress: params.address,
      outHumanAmount: 12_000_000,
    }, {
      inTradeId: "trade-1",
      inTokenAddress: params.address,
      inHumanAmount: 2_000_000,
    }],
  } };
  const matching = {
    address: EVM_WALLET,
    balance: 10_000_000,
    buy_amount_cur: 12_000_000,
    sell_amount_cur: 2_000_000,
  };
  const decoy = {
    address: "0x3333333333333333333333333333333333333333",
    balance: 10_000_000,
    buy_amount_cur: 10_000_000,
    sell_amount_cur: 0,
  };
  assert.equal(
    api.sanitizeVerifiedHolderAddress(tradePayload, { data: { list: [decoy, matching] } }, params, holder),
    EVM_WALLET,
  );

  const duplicate = { ...matching, address: "0x4444444444444444444444444444444444444444" };
  assert.throws(
    () => api.sanitizeVerifiedHolderAddress(
      tradePayload,
      { data: { list: [matching, duplicate] } },
      params,
      holder,
    ),
    /HOLDER_CHAIN_DATA_AMBIGUOUS/,
  );
});

test("只保留当前 holder 当前 Token 的最新买入时间用于链上小窗口定位", () => {
  const holder = { tradeId: "trade-1", userId: "user-1", humanAmountRaw: "10" };
  const tradePayload = { responseObject: {
    userId: "user-1",
    trade: {
      id: "trade-1",
      tokenAddress: params.address,
      networkId: params.networkId,
      humanTokenAmount: "10",
    },
    swaps: [{
      outTradeId: "trade-1",
      outTokenAddress: params.address,
      outHumanAmount: "6",
      createdAt: "2026-08-28T01:02:03.000Z",
    }, {
      outTradeId: "trade-1",
      outTokenAddress: params.address,
      outHumanAmount: "4",
      createdAt: 1_777_777_777,
    }, {
      outTradeId: "trade-other",
      outTokenAddress: params.address,
      outHumanAmount: "100",
      createdAt: "2099-01-01T00:00:00.000Z",
    }, {
      inTradeId: "trade-1",
      inTokenAddress: params.address,
      inHumanAmount: "0",
      createdAt: "2098-01-01T00:00:00.000Z",
    }],
  } };

  const trade = api.sanitizeHolderTrade(tradePayload, params, holder);

  assert.equal(trade.buyTimestampMs, Date.parse("2026-08-28T01:02:03.000Z"));
  assert.equal(trade.buyAmountRaw, "10");
});

test("EVM 持仓优先选择逐位精确候选，不会被附近金额抢行", () => {
  const holder = {
    tradeId: "trade-1",
    userId: "user-1",
    humanAmount: 7_500_000.1234,
    humanAmountRaw: "7500000.123400000000000000",
  };
  const tradePayload = { responseObject: {
    userId: "user-1",
    trade: {
      id: "trade-1",
      tokenAddress: params.address,
      networkId: params.networkId,
      humanTokenAmount: "7500000.123400000000000000",
    },
    swaps: [{
      outTradeId: "trade-1",
      outTokenAddress: params.address,
      outHumanAmount: "8000000.1234",
    }],
  } };
  const exact = {
    address: EVM_WALLET,
    balance: "7500000.123400000000000000",
    buy_amount_cur: "1",
    sell_amount_cur: "0",
  };
  const oldToleranceDecoy = {
    address: "0x3333333333333333333333333333333333333333",
    balance: "7500000.124",
    buy_amount_cur: "8000000.1234",
    sell_amount_cur: "0",
  };
  assert.equal(
    api.sanitizeVerifiedHolderAddress(
      tradePayload,
      { data: { list: [oldToleranceDecoy, exact] } },
      params,
      holder,
    ),
    EVM_WALLET,
  );
});

test("EVM 没有逐位精确值时接受 2 ppm 内的唯一 GMGN 候选", () => {
  const holder = {
    tradeId: "trade-1",
    userId: "user-1",
    humanAmountRaw: "7500000.123400000000000000",
  };
  const tradePayload = { responseObject: {
    userId: "user-1",
    trade: {
      id: "trade-1",
      tokenAddress: params.address,
      networkId: params.networkId,
      humanTokenAmount: "7500000.1235",
    },
    swaps: [],
  } };

  assert.equal(
    api.sanitizeVerifiedHolderAddress(
      tradePayload,
      { data: { list: [{
        address: EVM_WALLET,
        balance: "7500000.124",
      }] } },
      params,
      holder,
    ),
    EVM_WALLET,
  );
});

test("没有当前链上持仓时不回退复制 Fomo 的 userAddress", () => {
  const holder = { tradeId: "trade-1", userId: "user-1", humanAmount: 10_000_000 };
  const tradePayload = { responseObject: {
    userId: "user-1",
    trade: {
      id: "trade-1",
      userAddress: EVM_WALLET,
      tokenAddress: params.address,
      networkId: params.networkId,
      humanTokenAmount: 10_000_000,
    },
    swaps: [],
  } };
  assert.throws(
    () => api.sanitizeVerifiedHolderAddress(tradePayload, { data: { list: [] } }, params, holder),
    /HOLDER_CHAIN_DATA_NOT_FOUND/,
  );
});

test("达到 100 条接口上限时不把 Top 100 金额冒充全量", () => {
  const topHolders = Array.from({ length: 100 }, (_, index) => ({
    tradeId: `trade-${index}`,
    humanAmount: 100,
    value: 10,
    user: { displayName: `holder-${index}` },
  }));
  const result = api.sanitizeHolders({ responseObject: [{
    tokenAddress: params.address,
    networkId: 56,
    totalHolders: 500,
    topHolders,
  }] }, params, 1_000_000);

  assert.equal(result.fomoPositionValue, 1000);
  assert.equal(result.fomoPositionCount, 100);
  assert.equal(result.isFomoPositionValueComplete, false);
  assert.equal(result.fomoOwnershipPercent, 1);
  assert.equal(result.isFomoOwnershipComplete, false);
  assert.equal(result.items.length, 50);
});

test("缺少 humanAmount 时不硬算持仓占比", () => {
  const result = api.sanitizeHolders({ responseObject: [{
    tokenAddress: params.address,
    networkId: 56,
    topHolders: [{ value: 10, user: { displayName: "holder" } }],
  }] }, params, 1_000_000);

  assert.equal(result.fomoOwnershipPercent, null);
  assert.equal(result.fomoTokenAmount, null);
  assert.equal(result.items[0].ownershipPercent, null);
});

test("Feed 本地再次过滤 Thesis，只保留交易和转账", () => {
  const result = api.sanitizeFeed({ responseObject: { items: [
    { id: "buy", type: "swap_buy", displayName: "Buyer", usdAmount: 1400, marketCap: 331500 },
    { id: "sell", type: "swap_sell", displayName: "Seller", usdAmount: 1000, marketCap: 313800 },
    { id: "in", type: "transfer_in", displayName: "Receiver", usdAmount: 500 },
    { id: "thesis", type: "thesis", displayName: "Writer", comment: "must not render" },
    { id: "unknown", type: "comment", displayName: "Writer" },
  ] } });

  assert.deepEqual(result.map((item) => item.id), ["buy", "sell", "in"]);
  assert.equal(result.some((item) => item.type === "thesis"), false);
});

test("Fomo Alerts 使用账号级 tradingActivity REST 并按 lastId 最多补三页", () => {
  const first = new URL(api.buildFollowedTradesRequest().url);
  assert.equal(first.pathname, "/feed/tradingActivity");
  assert.equal(first.searchParams.get("limit"), "50");
  assert.equal(first.searchParams.get("threshold"), "0");
  assert.equal(first.searchParams.get("lastId"), null);

  const next = new URL(api.buildFollowedTradesRequest("alert-50").url);
  assert.equal(next.searchParams.get("lastId"), "alert-50");
  assert.equal(api.FOLLOWED_TRADES_MAX_PAGES, 3);
  assert.equal(api.followedTradesNextCursor({
    responseObject: { items: [{ id: "alert-50" }], hasNextPage: true },
  }), "alert-50");
  assert.equal(api.followedTradesNextCursor({
    responseObject: { items: [{ id: "alert-50" }], hasNextPage: false },
  }), "");
});

test("逐用户 swaps 接口只保留为单个用户资料核对能力", () => {
  assert.equal(
    new URL(api.buildFollowingIdsRequest().url).pathname,
    "/v2/users/current/followingIds",
  );
  assert.deepEqual(api.sanitizeFollowingIds({ responseObject: {
    followingIds: ["397397", "397397", "user-2", ""],
  } }), ["397397", "user-2"]);

  const usersRequest = new URL(api.buildFollowedUsersRequest(["397397", "user-2"]).url);
  assert.equal(usersRequest.pathname, "/v2/users");
  assert.deepEqual(usersRequest.searchParams.getAll("userIds"), ["397397", "user-2"]);
  assert.equal(
    new URL(api.buildFollowedUserSwapsRequest("397397").url).pathname,
    "/v2/users/397397/swaps",
  );
});

test("Fomo 关注状态与关注切换严格使用当前网页接口", () => {
  assert.equal(new URL(api.buildCurrentUserRequest().url).pathname, "/v2/users/current");
  assert.equal(api.currentUserId({ responseObject: { id: "viewer-1" } }), "viewer-1");
  assert.equal(api.currentUserId({ responseObject: {} }), "");

  const follow = api.buildFollowMutationRequest("viewer-1", "holder-1", true);
  assert.equal(new URL(follow.url).pathname, "/follows");
  assert.equal(follow.method, "POST");
  assert.deepEqual(JSON.parse(follow.body), { user_id: "viewer-1", following_id: "holder-1" });

  const unfollow = api.buildFollowMutationRequest("viewer-1", "holder-1", false);
  assert.equal(unfollow.method, "DELETE");
  assert.deepEqual(JSON.parse(unfollow.body), { user_id: "viewer-1", following_id: "holder-1" });
  assert.throws(() => api.buildFollowMutationRequest("", "holder-1", true), /INVALID_FOMO_FOLLOW_REQUEST/);
});

test("单用户资料核对严格复用 Fomo 当前前端的买卖方向和成交价映射", () => {
  const cash = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";
  const tokenAddress = "0xd1764430f475b5d8d91a38c89cdc6a6262427777";
  const user = {
    id: "397397",
    displayName: "Followed Trader",
    userHandle: "followed",
    profilePictureLink: "https://example.com/user.png",
  };
  const result = api.sanitizeFollowedUserSwaps({ responseObject: { swaps: [{
    id: "swap-buy",
    createdAt: "2026-08-28T08:30:00.000Z",
    inNetworkId: 56,
    inTokenAddress: cash,
    inHumanAmount: "25.5",
    humanUsdAmountIn: "25.5",
    outNetworkId: 56,
    outTokenAddress: tokenAddress,
    outHumanAmount: "100000",
    outTradeId: "trade-buy",
    transactionHash: "0xbuy",
  }, {
    id: "swap-sell",
    createdAt: "2026-08-28T13:56:37.000Z",
    inNetworkId: 56,
    inTokenAddress: tokenAddress,
    inHumanAmount: "200000",
    inTradeId: "trade-sell",
    outNetworkId: 56,
    outTokenAddress: cash,
    outHumanAmount: "50",
    humanUsdAmountOut: "50",
    transactionHash: "0xsell",
  }] } }, user);

  assert.deepEqual(result.map((item) => item.id), ["fomo:swap-buy", "fomo:swap-sell"]);
  assert.equal(result[0].type, "buy");
  assert.equal(result[0].tokenAddress, tokenAddress);
  assert.equal(result[0].baseAmount, 100000);
  assert.equal(result[0].usdAmount, 25.5);
  assert.equal(result[0].priceUsdAtTrade, 0.000255);
  assert.equal(result[0].quoteAddress, cash);
  assert.equal(result[0].quoteSymbol, "USDT");
  assert.equal(result[1].type, "sell");
  assert.equal(result[1].baseAmount, 200000);
  assert.equal(result[1].usdAmount, 50);
  assert.equal(result[1].priceUsdAtTrade, 0.00025);
  assert.equal(result[1].displayName, "Followed Trader");
  assert.equal(result[1].marketCapAtTrade, null);
});

test("Fomo tradingActivity 扁平事件用 humanAmount 还原成交价和市值", () => {
  const tokenAddress = "0x7777777777777777777777777777777777777777";
  const [trade] = api.sanitizeFomoRealtimeTrade({
    id: "activity-live",
    type: "swap_buy",
    createdAt: "2026-09-03T03:56:19.762Z",
    tokenAddress,
    networkId: 56,
    usdAmount: "25",
    humanAmount: "100000",
    totalSupply: "1000000000",
  });

  assert.equal(trade.id, "fomo:activity-live");
  assert.equal(trade.baseAmount, 100_000);
  assert.equal(trade.priceUsdAtTrade, 0.00025);
  assert.equal(trade.marketCapAtTrade, 250_000);
  assert.equal(trade.marketCapSource, "fomo-swap-price+token-supply");
});

test("Fomo 关注交易用自己的 token metadata 补总供应量且不覆盖交易市值", () => {
  const solAddress = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6U3M3zXjvB7mbonk";
  const trades = [{
    id: "fomo:evm",
    platform: "fomo",
    tokenAddress: params.address.toUpperCase().replace("0X", "0x"),
    networkId: params.networkId,
    tokenSymbol: "",
    tokenName: "",
    tokenImageUrl: "",
    totalSupply: null,
    marketCapAtTrade: 367_700,
  }, {
    id: "fomo:sol",
    platform: "fomo",
    tokenAddress: solAddress,
    networkId: 1399811149,
    totalSupply: null,
  }];
  const request = api.buildFollowedTradesMetadataRequest(trades);

  assert.equal(request.url, "https://prod-api.fomo.family/proxy/filterTokens");
  assert.equal(request.method, "POST");
  assert.deepEqual(JSON.parse(request.body), [
    `${params.address.toLowerCase()}:${params.networkId}`,
    `${solAddress}:1399811149`,
  ]);

  const metadata = api.sanitizeFollowedTradesMetadata({ responseObject: [{
    token: {
      address: params.address,
      networkId: params.networkId,
      info: {
        symbol: "POW",
        name: "Power",
        imageLargeUrl: "ipfs://bafkreiduxzar2onubb6oudbuibb7vip6am6nujj3sau6iftolmzt3rycaa",
        totalSupply: "1000000000",
      },
    },
    marketCap: 999_999,
    priceUSD: 0.000999999,
  }] });
  const [enriched] = api.withFollowedTradesMetadata(trades, metadata);

  assert.equal(enriched.totalSupply, 1_000_000_000);
  assert.equal(enriched.tokenSymbol, "POW");
  assert.equal(enriched.tokenName, "Power");
  assert.equal(
    enriched.tokenImageUrl,
    "https://ipfs.io/ipfs/bafkreiduxzar2onubb6oudbuibb7vip6am6nujj3sau6iftolmzt3rycaa",
  );
  assert.equal(enriched.marketCapAtTrade, 367_700);
  assert.equal("marketCap" in metadata[0], false, "当前 metadata 市值不得进入交易记录");
});
