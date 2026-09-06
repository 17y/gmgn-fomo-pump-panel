(function exposeFomoApi(root, factory) {
  const core = root.GmgnFomoCore || (typeof require === "function" ? require("./core") : null);
  const api = factory(core);
  root.GmgnFomoApi = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis, function createFomoApi(core) {
  "use strict";

  if (!core) throw new Error("GmgnFomoCore is required");

  const API_ORIGIN = "https://prod-api.fomo.family";
  const GMGN_API_ORIGIN = "https://gmgn.ai";
  const HOLDER_QUERY_LIMIT = 100;
  const HOLDER_DISPLAY_LIMIT = 50;
  const FOLLOWED_TRADES_LIMIT = 50;
  const FOLLOWED_TRADES_MAX_PAGES = 3;
  const FOLLOWED_TRADES_THRESHOLD = 0;
  const FOMO_CASH_TOKENS = new Set([
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:1399811149",
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:8453",
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d:56",
    "0x754704bc059f8c67012fed69bc8a327a5aafb603:143",
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:1",
    "0x5fc5360d0400a0fd4f2af552add042d716f1d168:4663",
  ]);
  const FEED_TYPES = new Set(["swap_buy", "swap_sell", "transfer_in", "transfer_out"]);
  const FOLLOWED_TRADE_DIRECTIONS = new Map([
    ["swap_buy", "buy"],
    ["swap_sell", "sell"],
  ]);
  const FOLLOWED_TRADE_TYPES = new Set(FOLLOWED_TRADE_DIRECTIONS.keys());
  const GMGN_CHAIN_NAMES = new Map([
    [1, "eth"],
    [56, "bsc"],
    [8453, "base"],
    [1399811149, "sol"],
    [4663, "robinhood"],
  ]);

  function assertParams(params) {
    if (!core.validTokenAddress(params?.address) || !Number.isInteger(params?.networkId)) {
      throw new Error("INVALID_TOKEN");
    }
  }

  function buildRequests(params) {
    assertParams(params);
    const tokenKey = `${params.address}:${params.networkId}`;
    const holdersUrl = new URL("/hodlers/top", API_ORIGIN);
    holdersUrl.searchParams.set("tokens", JSON.stringify([{ address: params.address, networkId: params.networkId }]));
    holdersUrl.searchParams.set("limit", String(HOLDER_QUERY_LIMIT));

    const feedUrl = new URL("/feed/token", API_ORIGIN);
    feedUrl.searchParams.set("tokenAddress", params.address);
    feedUrl.searchParams.set("networkId", String(params.networkId));
    feedUrl.searchParams.set("excludeThesis", "true");
    feedUrl.searchParams.set("threshold", "1000");

    return {
      metadata: {
        url: `${API_ORIGIN}/proxy/filterTokens`,
        method: "POST",
        body: JSON.stringify([tokenKey]),
      },
      holders: { url: holdersUrl.toString(), method: "GET" },
      feed: { url: feedUrl.toString(), method: "GET" },
    };
  }

  function buildFollowedTradesRequest(lastId = "") {
    const url = new URL("/feed/tradingActivity", API_ORIGIN);
    url.searchParams.set("limit", String(FOLLOWED_TRADES_LIMIT));
    const cursor = holderIdentifier(lastId);
    if (cursor) url.searchParams.set("lastId", cursor);
    url.searchParams.set("threshold", String(FOLLOWED_TRADES_THRESHOLD));
    return { url: url.toString(), method: "GET" };
  }

  function followedTradesNextCursor(payload) {
    const response = payload?.responseObject;
    if (!response?.hasNextPage || !Array.isArray(response.items)) return "";
    return holderIdentifier(response.items.at(-1)?.id);
  }

  function buildFollowingIdsRequest() {
    return { url: `${API_ORIGIN}/v2/users/current/followingIds`, method: "GET" };
  }

  function buildCurrentUserRequest() {
    return { url: `${API_ORIGIN}/v2/users/current`, method: "GET" };
  }

  function currentUserId(payload) {
    return holderIdentifier(payload?.responseObject?.id);
  }

  function buildFollowMutationRequest(viewerUserId, followingUserId, shouldFollow) {
    const userId = holderIdentifier(viewerUserId);
    const followingId = holderIdentifier(followingUserId);
    if (!userId || !followingId || typeof shouldFollow !== "boolean") {
      throw new Error("INVALID_FOMO_FOLLOW_REQUEST");
    }
    return {
      url: `${API_ORIGIN}/follows`,
      method: shouldFollow ? "POST" : "DELETE",
      body: JSON.stringify({ user_id: userId, following_id: followingId }),
    };
  }

  function buildFollowedUsersRequest(userIds) {
    const ids = [...new Set((Array.isArray(userIds) ? userIds : [])
      .map(holderIdentifier)
      .filter(Boolean))];
    if (!ids.length) return null;
    const url = new URL("/v2/users", API_ORIGIN);
    for (const userId of ids) url.searchParams.append("userIds", userId);
    return { url: url.toString(), method: "GET" };
  }

  function buildFollowedUserSwapsRequest(userId, lastSwapIdV2 = "") {
    const id = holderIdentifier(userId);
    if (!id) throw new Error("INVALID_FOMO_USER");
    const url = new URL(`/v2/users/${encodeURIComponent(id)}/swaps`, API_ORIGIN);
    const cursor = holderIdentifier(lastSwapIdV2);
    if (cursor) url.searchParams.set("lastSwapIdV2", cursor);
    return { url: url.toString(), method: "GET" };
  }

  function followedTradeTokenKey(address, networkId) {
    if (!core.validTokenAddress(address) || !Number.isInteger(Number(networkId))) return "";
    const normalized = address.startsWith("0x") ? address.toLowerCase() : address;
    return `${normalized}:${Number(networkId)}`;
  }

  function buildFollowedTradesMetadataRequest(items) {
    const tokenKeys = [...new Set((Array.isArray(items) ? items : [])
      .map((item) => followedTradeTokenKey(item?.tokenAddress, item?.networkId))
      .filter(Boolean))];
    if (!tokenKeys.length) return null;
    return {
      url: `${API_ORIGIN}/proxy/filterTokens`,
      method: "POST",
      body: JSON.stringify(tokenKeys),
    };
  }

  function holderIdentifier(value) {
    return typeof value === "string" && value.trim() ? value.trim() : "";
  }

  function buildProfileUrl(userHandle) {
    const handle = holderIdentifier(userHandle).replace(/^@/, "");
    return handle ? `https://fomo.family/profile/${encodeURIComponent(handle)}` : "";
  }

  function buildTradeRequest(params, holder) {
    assertParams(params);
    const tradeId = holderIdentifier(holder?.tradeId);
    const userId = holderIdentifier(holder?.userId);
    if (!tradeId || !userId) throw new Error("INVALID_HOLDER");
    return {
      url: `${API_ORIGIN}/trades/${encodeURIComponent(tradeId)}`,
      method: "GET",
    };
  }

  function buildGmgnHoldersRequest(params) {
    assertParams(params);
    const chain = GMGN_CHAIN_NAMES.get(params.networkId);
    if (!chain) throw new Error("UNSUPPORTED_GMGN_CHAIN");
    const url = new URL(`/vas/api/v1/token_holders/${chain}/${encodeURIComponent(params.address)}`, GMGN_API_ORIGIN);
    url.searchParams.set("limit", String(HOLDER_QUERY_LIMIT));
    url.searchParams.set("cost", "20");
    url.searchParams.set("orderby", "amount_percentage");
    url.searchParams.set("direction", "desc");
    return {
      url: url.toString(),
      method: "GET",
      credentials: "include",
      referrer: `${GMGN_API_ORIGIN}/`,
      timeoutMs: 5_000,
    };
  }

  function cleanSocialLinks(value) {
    const source = value && typeof value === "object" ? value : {};
    return Object.fromEntries(
      ["website", "twitter", "telegram", "discord"]
        .map((name) => [name, core.safeHttpsUrl(source[name])])
        .filter(([, url]) => url),
    );
  }

  function sanitizeMetadata(payload, params) {
    const rows = Array.isArray(payload?.responseObject) ? payload.responseObject : [];
    const address = String(params.address).toLowerCase();
    const row = rows.find((item) => (
      String(item?.token?.address || "").toLowerCase() === address
      && Number(item?.token?.networkId) === params.networkId
    ));
    if (!row?.token) return null;

    const token = row.token;
    const info = token.info && typeof token.info === "object" ? token.info : {};
    const launchpad = token.launchpad && typeof token.launchpad === "object" ? token.launchpad : {};
    return {
      address: token.address || params.address,
      networkId: Number(token.networkId) || params.networkId,
      name: info.name || token.name || token.symbol || "Unknown token",
      symbol: info.symbol || token.symbol || "",
      imageUrl: core.safeTokenImageUrl(
        info.imageLargeUrl || info.imageSmallUrl || info.imageThumbUrl,
      ),
      bannerUrl: core.safeHttpsUrl(info.imageBannerUrl),
      description: typeof info.description === "string" ? info.description.trim() : "",
      totalSupply: core.finiteNumber(info.totalSupply),
      createdAt: core.finiteNumber(token.createdAt || row.createdAt),
      marketCap: core.finiteNumber(row.marketCap),
      priceUsd: core.finiteNumber(row.priceUSD),
      change24: core.finiteNumber(row.change24),
      liquidity: core.finiteNumber(row.liquidity),
      volume24: core.finiteNumber(row.volume24),
      socialLinks: cleanSocialLinks(token.socialLinks),
      launchpad: {
        name: typeof launchpad.launchpadName === "string" ? launchpad.launchpadName : "",
        iconUrl: core.safeHttpsUrl(launchpad.launchpadIconUrl),
      },
    };
  }

  function sanitizeHolders(payload, params, totalSupply = null) {
    const rows = Array.isArray(payload?.responseObject) ? payload.responseObject : [];
    const address = String(params.address).toLowerCase();
    const row = rows.find((item) => (
      String(item?.tokenAddress || "").toLowerCase() === address
      && Number(item?.networkId) === params.networkId
    ));
    const holders = Array.isArray(row?.topHolders) ? row.topHolders : [];
    const positionValues = holders
      .map((holder) => core.finiteNumber(holder?.value))
      .filter((value) => value !== null && value >= 0);
    const tokenAmounts = holders
      .map((holder) => core.finiteNumber(holder?.humanAmount))
      .filter((value) => value !== null && value >= 0);
    const supply = core.finiteNumber(totalSupply);
    const hasAllTokenAmounts = tokenAmounts.length === holders.length;
    const fomoTokenAmount = hasAllTokenAmounts
      ? tokenAmounts.reduce((total, value) => total + value, 0)
      : null;
    const fomoOwnershipPercent = supply !== null && supply > 0 && hasAllTokenAmounts
      ? (fomoTokenAmount / supply) * 100
      : null;
    return {
      totalHolders: core.finiteNumber(row?.totalHolders) || 0,
      fomoPositionValue: positionValues.reduce((total, value) => total + value, 0),
      fomoPositionCount: holders.length,
      pricedPositionCount: positionValues.length,
      fomoTokenAmount,
      tokenAmountCount: tokenAmounts.length,
      fomoOwnershipPercent,
      isFomoPositionValueComplete: holders.length < HOLDER_QUERY_LIMIT
        && positionValues.length === holders.length,
      isFomoOwnershipComplete: holders.length < HOLDER_QUERY_LIMIT
        && hasAllTokenAmounts
        && supply !== null
        && supply > 0,
      items: holders.slice(0, HOLDER_DISPLAY_LIMIT).map((holder) => ({
        id: holder.tradeId || holder.user?.id,
        platform: "fomo",
        tradeId: holderIdentifier(holder.tradeId),
        userId: holderIdentifier(holder.user?.id),
        displayName: holder.user?.displayName || holder.user?.userHandle || "Fomo trader",
        userHandle: holder.user?.userHandle || "",
        profileUrl: buildProfileUrl(holder.user?.userHandle),
        profilePictureLink: core.safeHttpsUrl(holder.user?.profilePictureLink),
        clanName: typeof holder.user?.clan?.name === "string" ? holder.user.clan.name : "",
        value: core.finiteNumber(holder.value),
        humanAmount: core.finiteNumber(holder.humanAmount),
        humanAmountRaw: core.decimalString(holder.humanAmount),
        ownershipPercent: supply !== null && supply > 0 && core.finiteNumber(holder.humanAmount) !== null
          ? (core.finiteNumber(holder.humanAmount) / supply) * 100
          : null,
        pnl: core.finiteNumber(holder.pnl),
        unrealizedPnl: core.finiteNumber(holder.unrealizedPnl),
        realizedPnl: core.finiteNumber(holder.realizedPnl),
        costBasis: core.finiteNumber(holder.costBasis),
        averageEntryPrice: core.finiteNumber(holder.averageEntryPrice),
        comment: typeof holder.comment?.comment === "string" ? holder.comment.comment.trim() : "",
        likes: core.finiteNumber(holder.comment?.numLikes) || 0,
        averageHoldTimeSeconds: core.finiteNumber(holder.averageHoldTimeSeconds),
        isDev: Boolean(holder.isDev),
      })),
    };
  }

  function amountsMatch(expectedValue, actualValue) {
    const expected = core.finiteNumber(expectedValue);
    const actual = core.finiteNumber(actualValue);
    if (expected === null || actual === null || expected < 0 || actual < 0) return false;
    const tolerance = Math.max(0.02, Math.abs(expected) * 1e-9);
    return Math.abs(expected - actual) <= tolerance;
  }

  function holderAmountsMatch(expectedValue, actualValue, networkId) {
    if (networkId !== core.TOKEN_NETWORK_IDS.sol) {
      return core.decimalEqual(expectedValue, actualValue)
        || core.decimalWithinRelativeTolerance(expectedValue, actualValue, 2);
    }
    return amountsMatch(expectedValue, actualValue);
  }

  function sumSwapAmounts(swaps, predicate, field) {
    const values = swaps.filter(predicate).map((swap) => core.decimalString(swap?.[field]));
    if (values.some((value) => value === null)) return null;
    return core.addDecimalStrings(values) || "0";
  }

  function timestampMilliseconds(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 0 ? Math.trunc(value < 1e12 ? value * 1000 : value) : null;
    }
    if (typeof value !== "string" || !value.trim()) return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric > 0 ? Math.trunc(numeric < 1e12 ? numeric * 1000 : numeric) : null;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function sanitizeFollowingIds(payload) {
    const ids = Array.isArray(payload?.responseObject?.followingIds)
      ? payload.responseObject.followingIds
      : [];
    return [...new Set(ids.map(holderIdentifier).filter(Boolean))];
  }

  function sanitizeFollowedUsers(payload) {
    const users = Array.isArray(payload?.responseObject?.users) ? payload.responseObject.users : [];
    return users.map((user) => {
      const id = holderIdentifier(user?.id);
      if (!id) return null;
      return {
        id,
        displayName: user?.displayName || user?.userHandle || "Fomo trader",
        userHandle: typeof user?.userHandle === "string" ? user.userHandle : "",
        profilePictureLink: core.safeHttpsUrl(user?.profilePictureLink),
        walletAddress: holderIdentifier(user?.walletAddress || user?.address),
      };
    }).filter(Boolean);
  }

  function fomoTokenKey(networkId, tokenAddress) {
    const address = holderIdentifier(tokenAddress);
    if (!address || !Number.isInteger(Number(networkId))) return "";
    return `${address.startsWith("0x") ? address.toLowerCase() : address}:${Number(networkId)}`;
  }

  function isFomoCashToken(networkId, tokenAddress) {
    return FOMO_CASH_TOKENS.has(fomoTokenKey(networkId, tokenAddress));
  }

  function fomoCashSymbol(networkId) {
    if (Number(networkId) === 4663) return "USDG";
    if (Number(networkId) === 56) return "USDT";
    return "USDC";
  }

  function sanitizeFollowedUserSwaps(payload, user) {
    const swaps = Array.isArray(payload?.responseObject?.swaps) ? payload.responseObject.swaps : [];
    const userId = holderIdentifier(user?.id);
    const displayName = user?.displayName || user?.userHandle || "Fomo trader";
    return swaps.map((swap) => {
      // This is the exact direction test used by Fomo's current production profile UI.
      const isBuy = !isFomoCashToken(swap?.outNetworkId, swap?.outTokenAddress);
      const tokenAddress = holderIdentifier(isBuy ? swap?.outTokenAddress : swap?.inTokenAddress);
      const networkId = Number(isBuy ? swap?.outNetworkId : swap?.inNetworkId);
      const createdAt = timestampMilliseconds(swap?.createdAt);
      if (!core.validTokenAddress(tokenAddress) || !Number.isInteger(networkId) || createdAt === null) {
        return null;
      }
      const usdAmount = core.finiteNumber(
        isBuy ? swap?.humanUsdAmountIn : swap?.humanUsdAmountOut,
      );
      const baseAmount = core.finiteNumber(isBuy ? swap?.outHumanAmount : swap?.inHumanAmount);
      const quoteAmount = core.finiteNumber(isBuy ? swap?.inHumanAmount : swap?.outHumanAmount);
      const quoteAddress = holderIdentifier(isBuy ? swap?.inTokenAddress : swap?.outTokenAddress);
      const priceUsdAtTrade = usdAmount !== null && usdAmount > 0
        && baseAmount !== null && baseAmount > 0
        ? usdAmount / baseAmount
        : null;
      const tradeId = holderIdentifier(isBuy ? swap?.outTradeId : swap?.inTradeId);
      const transactionHash = holderIdentifier(
        swap?.transactionHash || swap?.txHash || swap?.signature,
      );
      const swapId = holderIdentifier(swap?.id);
      const id = swapId || transactionHash || tradeId
        || `${userId || "unknown"}:${tokenAddress}:${createdAt}:${isBuy ? "buy" : "sell"}`;
      return {
        id: `fomo:${id}`,
        platform: "fomo",
        type: isBuy ? "buy" : "sell",
        createdAt,
        tokenAddress,
        networkId,
        transactionHash,
        walletAddress: holderIdentifier(user?.walletAddress),
        userId,
        displayName,
        userHandle: typeof user?.userHandle === "string" ? user.userHandle : "",
        profilePictureLink: core.safeHttpsUrl(user?.profilePictureLink),
        tokenSymbol: "",
        tokenName: "",
        tokenImageUrl: "",
        usdAmount,
        baseAmount,
        quoteAmount,
        quoteAddress,
        quoteSymbol: isFomoCashToken(
          isBuy ? swap?.inNetworkId : swap?.outNetworkId,
          quoteAddress,
        ) ? fomoCashSymbol(isBuy ? swap?.inNetworkId : swap?.outNetworkId) : "",
        priceUsdAtTrade,
        totalSupply: null,
        marketCap: null,
        marketCapAtTrade: null,
        marketCapSource: "",
        isDev: Boolean(swap?.isDev),
      };
    }).filter(Boolean);
  }

  function followedTradeMarketData(item) {
    const usdAmount = core.finiteNumber(item?.usdAmount);
    const baseAmount = core.finiteNumber(
      item?.tokenAmount ?? item?.baseAmount ?? item?.humanAmount,
    );
    const totalSupply = core.finiteNumber(item?.totalSupplyAtTrade ?? item?.totalSupply);
    const explicitPrice = core.finiteNumber(
      item?.priceUsdAtTrade ?? item?.tokenPriceUsdAtTrade,
    );
    const explicitMarketCap = core.finiteNumber(item?.fdv)
      ?? core.finiteNumber(item?.marketCapAtTrade)
      ?? core.finiteNumber(item?.marketCap);
    const priceUsdAtTrade = explicitPrice !== null && explicitPrice > 0
      ? explicitPrice
      : usdAmount !== null && usdAmount > 0 && baseAmount !== null && baseAmount > 0
        ? usdAmount / baseAmount
        : explicitMarketCap !== null && explicitMarketCap > 0
            && totalSupply !== null && totalSupply > 0
          ? explicitMarketCap / totalSupply
          : null;
    const marketCapAtTrade = explicitMarketCap !== null && explicitMarketCap > 0
      ? explicitMarketCap
      : priceUsdAtTrade !== null && priceUsdAtTrade > 0
          && totalSupply !== null && totalSupply > 0
        ? priceUsdAtTrade * totalSupply
        : null;
    const marketCapSource = explicitMarketCap !== null && explicitMarketCap > 0
      ? "fomo-trading-activity"
      : marketCapAtTrade !== null
        ? "fomo-swap-price+token-supply"
        : "";
    return {
      usdAmount,
      baseAmount,
      totalSupply,
      priceUsdAtTrade,
      marketCapAtTrade,
      marketCapSource,
    };
  }

  function sanitizeFomoRealtimeTrade(payload) {
    const item = payload && typeof payload === "object" ? payload : null;
    if (!item) return [];
    const hasRawSwapShape = [
      "inTokenAddress",
      "outTokenAddress",
      "inHumanAmount",
      "outHumanAmount",
    ].some((field) => item[field] !== null && item[field] !== undefined);
    if (hasRawSwapShape) {
      const user = item.user && typeof item.user === "object" ? item.user : {
        id: item.userId,
        walletAddress: item.walletAddress,
        displayName: item.displayName,
        userHandle: item.userHandle,
        profilePictureLink: item.profilePictureLink,
      };
      return sanitizeFollowedUserSwaps({ responseObject: { swaps: [item] } }, user)
        .map((trade) => ({
          ...trade,
          tokenSymbol: item.ticker || item.symbol || item.tokenSymbol || "",
          tokenName: item.tokenName || "",
          tokenImageUrl: core.safeTokenImageUrl(item.tokenImageUrl),
          totalSupply: core.finiteNumber(item.totalSupplyAtTrade ?? item.totalSupply),
          ...followedTradeMarketData({
            ...item,
            usdAmount: trade.usdAmount,
            baseAmount: trade.baseAmount,
            priceUsdAtTrade: trade.priceUsdAtTrade,
          }),
        }));
    }
    return sanitizeFollowedTrades({ responseObject: { items: [item] } });
  }

  function sanitizeHolderTrade(payload, params, holder) {
    assertParams(params);
    const expectedTradeId = holderIdentifier(holder?.tradeId);
    const expectedUserId = holderIdentifier(holder?.userId);
    const response = payload?.responseObject;
    const trade = response?.trade;
    if (!expectedTradeId || !expectedUserId || !trade) throw new Error("HOLDER_IDENTITY_MISMATCH");
    if (holderIdentifier(trade.id) !== expectedTradeId
      || holderIdentifier(response.userId) !== expectedUserId
      || Number(trade.networkId) !== params.networkId
      || String(trade.tokenAddress || "").toLowerCase() !== String(params.address).toLowerCase()) {
      throw new Error("HOLDER_IDENTITY_MISMATCH");
    }

    const holderAmountRaw = core.decimalString(holder?.humanAmountRaw ?? holder?.humanAmount);
    const tradeAmountRaw = core.decimalString(trade.humanTokenAmount ?? trade.sumSwapOpen);
    if (!holderAmountRaw || !tradeAmountRaw
      || !holderAmountsMatch(holderAmountRaw, tradeAmountRaw, params.networkId)) {
      throw new Error("HOLDER_AMOUNT_MISMATCH");
    }

    const tokenAddress = String(params.address).toLowerCase();
    const swaps = Array.isArray(response.swaps) ? response.swaps : [];
    const isBuySwap = (swap) => (
      holderIdentifier(swap?.outTradeId) === expectedTradeId
      && String(swap?.outTokenAddress || "").toLowerCase() === tokenAddress
    );
    const buyAmountRaw = sumSwapAmounts(swaps, isBuySwap, "outHumanAmount");
    const sellAmountRaw = sumSwapAmounts(swaps, (swap) => (
      holderIdentifier(swap?.inTradeId) === expectedTradeId
      && String(swap?.inTokenAddress || "").toLowerCase() === tokenAddress
    ), "inHumanAmount");
    if (buyAmountRaw === null || sellAmountRaw === null) throw new Error("HOLDER_ACTIVITY_INVALID");
    const buyTimestamps = swaps
      .filter(isBuySwap)
      .map((swap) => timestampMilliseconds(swap?.createdAt))
      .filter((value) => value !== null);
    return {
      tradeId: expectedTradeId,
      userId: expectedUserId,
      currentAmount: core.finiteNumber(tradeAmountRaw),
      currentAmountRaw: tradeAmountRaw,
      buyAmount: core.finiteNumber(buyAmountRaw),
      buyAmountRaw,
      sellAmount: core.finiteNumber(sellAmountRaw),
      sellAmountRaw,
      hasSwapActivity: buyAmountRaw !== "0" || sellAmountRaw !== "0",
      buyTimestampMs: buyTimestamps.length ? Math.max(...buyTimestamps) : null,
    };
  }

  function gmgnHolderRows(payload, networkId) {
    const rows = Array.isArray(payload?.data?.list) ? payload.data.list : [];
    return rows.map((row) => ({
      address: core.normalizeWalletAddress(row?.address, networkId),
      balance: core.finiteNumber(row?.balance ?? row?.amount_cur),
      balanceRaw: core.decimalString(row?.balance ?? row?.amount_cur),
      buyAmount: core.finiteNumber(row?.buy_amount_cur),
      buyAmountRaw: core.decimalString(row?.buy_amount_cur),
      sellAmount: core.finiteNumber(row?.sell_amount_cur),
      sellAmountRaw: core.decimalString(row?.sell_amount_cur),
    })).filter((row) => row.address && row.balanceRaw !== null);
  }

  function sanitizeVerifiedHolderAddress(tradePayload, gmgnPayload, params, holder) {
    const trade = sanitizeHolderTrade(tradePayload, params, holder);
    const rows = gmgnHolderRows(gmgnPayload, params.networkId);
    const exactBalanceMatches = rows
      .filter((row) => core.decimalEqual(trade.currentAmountRaw, row.balanceRaw));
    const balanceMatches = exactBalanceMatches.length
      ? exactBalanceMatches
      : rows.filter((row) => holderAmountsMatch(
        trade.currentAmountRaw,
        row.balanceRaw,
        params.networkId,
      ));
    if (!balanceMatches.length) throw new Error("HOLDER_CHAIN_DATA_NOT_FOUND");
    if (balanceMatches.length === 1) return balanceMatches[0].address;

    const activityMatches = trade.hasSwapActivity
      ? balanceMatches.filter((row) => (
        (row.buyAmountRaw === null
          || holderAmountsMatch(trade.buyAmountRaw, row.buyAmountRaw, params.networkId))
        && (row.sellAmountRaw === null
          || holderAmountsMatch(trade.sellAmountRaw, row.sellAmountRaw, params.networkId))
      ))
      : balanceMatches;
    if (!activityMatches.length) throw new Error("HOLDER_CHAIN_ACTIVITY_MISMATCH");
    if (activityMatches.length !== 1) throw new Error("HOLDER_CHAIN_DATA_AMBIGUOUS");
    return activityMatches[0].address;
  }

  function sanitizeFeed(payload) {
    const items = Array.isArray(payload?.responseObject?.items) ? payload.responseObject.items : [];
    return items
      .filter((item) => FEED_TYPES.has(item?.type))
      .slice(0, 100)
      .map((item) => ({
        id: item.id || item.tradeId,
        type: item.type,
        createdAt: item.createdAt,
        displayName: item.displayName || item.userHandle || "Fomo trader",
        userHandle: item.userHandle || "",
        profilePictureLink: core.safeHttpsUrl(item.profilePictureLink),
        usdAmount: core.finiteNumber(item.usdAmount),
        marketCap: core.finiteNumber(item.marketCap || item.fdv),
        isDev: Boolean(item.isDev),
      }));
  }

  function sanitizeFollowedTrades(payload) {
    const items = Array.isArray(payload?.responseObject?.items) ? payload.responseObject.items : [];
    return items.map((item) => {
      const direction = FOLLOWED_TRADE_DIRECTIONS.get(item?.type);
      if (!direction) return null;
      const tokenAddress = holderIdentifier(item?.tokenAddress);
      const networkId = Number(item?.networkId);
      const createdAt = timestampMilliseconds(item?.createdAt);
      if (!core.validTokenAddress(tokenAddress) || !Number.isInteger(networkId) || createdAt === null) {
        return null;
      }
      const transactionHash = holderIdentifier(
        item?.transactionHash
        || item?.txHash
        || item?.signature,
      );
      const tradeId = holderIdentifier(item?.tradeId);
      const userId = holderIdentifier(item?.userId);
      const userHandle = item?.userHandle || "";
      const marketData = followedTradeMarketData(item);
      const id = holderIdentifier(item?.id) || tradeId || transactionHash
        || `${userId || userHandle || "unknown"}:${tokenAddress}:${createdAt}:${item.type}`;
      return {
        id: `fomo:${id}`,
        platform: "fomo",
        type: direction,
        createdAt,
        tokenAddress,
        networkId,
        transactionHash,
        walletAddress: holderIdentifier(item?.walletAddress),
        userId,
        displayName: item?.displayName || userHandle || "Fomo trader",
        userHandle,
        profilePictureLink: core.safeHttpsUrl(item?.profilePictureLink),
        tokenSymbol: item?.ticker || item?.symbol || "",
        tokenName: item?.tokenName || "",
        tokenImageUrl: core.safeTokenImageUrl(item?.tokenImageUrl),
        usdAmount: marketData.usdAmount,
        baseAmount: marketData.baseAmount,
        quoteAmount: core.finiteNumber(item?.quoteAmount),
        quoteAddress: holderIdentifier(item?.quoteAddress),
        quoteSymbol: item?.quoteSymbol || "",
        priceUsdAtTrade: marketData.priceUsdAtTrade,
        totalSupply: marketData.totalSupply,
        marketCap: marketData.marketCapAtTrade,
        marketCapAtTrade: marketData.marketCapAtTrade,
        marketCapSource: marketData.marketCapSource,
        isDev: Boolean(item?.isDev),
      };
    }).filter(Boolean).slice(0, FOLLOWED_TRADES_LIMIT);
  }

  function sanitizeFollowedTradesMetadata(payload) {
    const rows = Array.isArray(payload?.responseObject) ? payload.responseObject : [];
    return rows.map((row) => {
      const token = row?.token;
      const tokenAddress = holderIdentifier(token?.address);
      const networkId = Number(token?.networkId);
      const key = followedTradeTokenKey(tokenAddress, networkId);
      if (!key) return null;
      const info = token?.info && typeof token.info === "object" ? token.info : {};
      return {
        key,
        tokenAddress,
        networkId,
        tokenSymbol: info.symbol || token.symbol || "",
        tokenName: info.name || token.name || "",
        tokenImageUrl: core.safeTokenImageUrl(
          info.imageLargeUrl || info.imageSmallUrl || info.imageThumbUrl,
        ),
        totalSupply: core.finiteNumber(info.totalSupply),
      };
    }).filter(Boolean);
  }

  function withFollowedTradesMetadata(items, metadataItems) {
    const byToken = new Map((Array.isArray(metadataItems) ? metadataItems : [])
      .map((item) => [item?.key, item])
      .filter(([key]) => key));
    return (Array.isArray(items) ? items : []).map((item) => {
      const metadata = byToken.get(followedTradeTokenKey(item?.tokenAddress, item?.networkId));
      if (!metadata) return item;
      const currentSupply = core.finiteNumber(item.totalSupply);
      const metadataSupply = core.finiteNumber(metadata.totalSupply);
      const next = {
        ...item,
        tokenSymbol: item.tokenSymbol || metadata.tokenSymbol || "",
        tokenName: item.tokenName || metadata.tokenName || "",
        tokenImageUrl: item.tokenImageUrl || metadata.tokenImageUrl || "",
        totalSupply: currentSupply !== null && currentSupply > 0
          ? currentSupply
          : metadataSupply,
      };
      const marketData = followedTradeMarketData(next);
      return {
        ...next,
        priceUsdAtTrade: marketData.priceUsdAtTrade,
        marketCap: marketData.marketCapAtTrade,
        marketCapAtTrade: marketData.marketCapAtTrade,
        marketCapSource: item.marketCapSource || marketData.marketCapSource,
      };
    });
  }

  return {
    API_ORIGIN,
    GMGN_API_ORIGIN,
    HOLDER_QUERY_LIMIT,
    HOLDER_DISPLAY_LIMIT,
    FOLLOWED_TRADES_LIMIT,
    FOLLOWED_TRADES_MAX_PAGES,
    FOLLOWED_TRADES_THRESHOLD,
    FOMO_CASH_TOKENS,
    FEED_TYPES,
    FOLLOWED_TRADE_TYPES,
    buildRequests,
    buildFollowedTradesRequest,
    followedTradesNextCursor,
    buildFollowingIdsRequest,
    buildCurrentUserRequest,
    currentUserId,
    buildFollowMutationRequest,
    buildFollowedUsersRequest,
    buildFollowedUserSwapsRequest,
    buildFollowedTradesMetadataRequest,
    buildTradeRequest,
    buildGmgnHoldersRequest,
    buildProfileUrl,
    sanitizeMetadata,
    sanitizeHolders,
    sanitizeHolderTrade,
    sanitizeVerifiedHolderAddress,
    sanitizeFeed,
    sanitizeFollowedTrades,
    sanitizeFomoRealtimeTrade,
    sanitizeFollowingIds,
    sanitizeFollowedUsers,
    sanitizeFollowedUserSwaps,
    isFomoCashToken,
    sanitizeFollowedTradesMetadata,
    withFollowedTradesMetadata,
  };
});
