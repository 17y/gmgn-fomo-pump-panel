(function exposeGmgnFollowBridge(root, factory) {
  const identity = root.GmgnTradeIdentity || (typeof require === "function" ? require("./trade-identity") : null);
  const api = factory(identity);
  root.GmgnFollowBridge = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis, function createGmgnFollowBridge(identity) {
  "use strict";

  const NETWORK_CHAINS = Object.freeze({
    1: "eth",
    56: "bsc",
    4663: "robinhood",
    8453: "base",
    1399811149: "sol",
  });

  function finiteNumber(value) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function seconds(value) {
    const number = finiteNumber(value);
    if (number === null || number <= 0) return null;
    return Math.trunc(number >= 1e12 ? number / 1_000 : number);
  }

  function text(value, limit = 256) {
    return typeof value === "string" ? value.trim().slice(0, limit) : "";
  }

  function tokenTicker(value) {
    const ticker = text(value, 64).replace(/^\$+/, "");
    return ticker && !/[·\u0000-\u001f\u007f]/.test(ticker) ? ticker : "";
  }

  function markedImageUrl(value, markers = {}) {
    const source = text(value, 2_048);
    if (!source) return "";
    const hashIndex = source.indexOf("#");
    const base = hashIndex === -1 ? source : source.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? "" : source.slice(hashIndex + 1);
    const preserved = fragment.split("&").filter(
      (part) => part && !/^gmgn-follow-(?:source|name)=/.test(part),
    );
    for (const [markerName, markerValue] of Object.entries(markers)) {
      if (!markerValue) continue;
      preserved.push(`${markerName}=${encodeURIComponent(markerValue)}`);
    }
    return preserved.length ? `${base}#${preserved.join("&")}` : base;
  }

  function canonicalTransactionHash(item) {
    const value = text(item?.transactionHash || item?.transaction_hash, 128);
    if (/^0x[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
    if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value)) return value;
    return "";
  }

  function makerIdentity(item, platform) {
    const walletAddress = text(item?.walletAddress);
    if (walletAddress) return walletAddress;
    const userId = platform === "fomo" ? text(item?.userId, 160) : "";
    return userId ? `fomo:${encodeURIComponent(userId)}` : "";
  }

  function trackingItemKey(item) {
    const platform = item?.platform === "fomo" || item?.platform === "pump"
      ? item.platform
      : "";
    if (!platform) return "";
    const pumpKey = identity?.pumpKey(item);
    if (pumpKey) return pumpKey;
    const transactionHash = canonicalTransactionHash(item);
    if (transactionHash) {
      return [
        platform,
        "tx",
        Number(item?.networkId) || "",
        transactionHash,
        text(item?.tokenAddress).toLowerCase(),
        item?.type || "",
      ].join(":");
    }
    const id = text(item?.id, 240);
    if (id) return `${platform}:id:${id}`;
    return [
      platform,
      text(item?.walletAddress).toLowerCase(),
      text(item?.tokenAddress).toLowerCase(),
      item?.type || "",
      seconds(item?.createdAt) || "",
    ].join(":");
  }

  function tradeMarketData(item, options = {}) {
    const amountUsd = finiteNumber(item?.usdAmount);
    const baseAmountValue = finiteNumber(item?.baseAmount);
    const baseAmount = baseAmountValue !== null && baseAmountValue > 0 ? baseAmountValue : null;
    const totalSupplyValue = finiteNumber(
      item?.totalSupplyAtTrade ?? item?.totalSupplySnapshot ?? item?.totalSupply,
    );
    const totalSupply = totalSupplyValue !== null && totalSupplyValue > 0
      ? totalSupplyValue
      : null;
    const explicitMarketCap = finiteNumber(item?.marketCapAtTrade ?? item?.marketCapSnapshot);
    const explicitPrice = finiteNumber(item?.priceUsdAtTrade ?? item?.priceUsdSnapshot);
    const priceUsdAtTrade = explicitPrice !== null && explicitPrice > 0
      ? explicitPrice
      : options.allowAmountDerivedPrice !== false
          && amountUsd !== null && amountUsd > 0 && baseAmount !== null
        ? amountUsd / baseAmount
        : explicitMarketCap !== null && explicitMarketCap > 0 && totalSupply !== null
          ? explicitMarketCap / totalSupply
          : null;
    const marketCapAtTrade = explicitMarketCap !== null && explicitMarketCap > 0
      ? explicitMarketCap
      : priceUsdAtTrade !== null && totalSupply !== null
        ? priceUsdAtTrade * totalSupply
        : null;
    return { amountUsd, baseAmount, totalSupply, priceUsdAtTrade, marketCapAtTrade };
  }

  function toGmgnTrade(item) {
    const chain = NETWORK_CHAINS[Number(item?.networkId)];
    const timestamp = seconds(item?.createdAt);
    const tokenAddress = text(item?.tokenAddress);
    const platform = item?.platform === "pump" || item?.platform === "fomo"
      ? item.platform
      : "";
    const maker = makerIdentity(item, platform);
    const side = item?.type === "buy" || item?.type === "sell" ? item.type : "";
    const key = trackingItemKey(item);
    if (!chain || !timestamp || !tokenAddress || !maker || !platform || !side || !key) {
      return null;
    }

    const market = tradeMarketData(item, { allowAmountDerivedPrice: platform !== "pump" });
    const quoteAmountValue = finiteNumber(item?.quoteAmount);
    const quoteAmount = quoteAmountValue !== null && quoteAmountValue > 0 ? quoteAmountValue : null;
    const displayName = text(item?.displayName || item?.userHandle || maker, 120) || maker;
    const ticker = tokenTicker(item?.tokenSymbol);
    const tokenLogo = text(item?.tokenImageUrl, 2_048);
    const avatar = markedImageUrl(
      text(item?.profilePictureLink, 2_048) || text(item?.platformLogoUrl, 2_048),
      {
        "gmgn-follow-source": platform,
        "gmgn-follow-name": displayName,
      },
    );
    const quoteAddress = text(item?.quoteAddress);
    const totalSupply = market.totalSupply;
    const priceUsd = market.priceUsdAtTrade;

    return {
      id: `external:${key}`,
      chain,
      transaction_hash: text(item?.transactionHash, 128),
      maker,
      side,
      base_address: tokenAddress,
      quote_address: quoteAddress,
      base_amount: market.baseAmount === null ? "0" : String(market.baseAmount),
      quote_amount: quoteAmount === null ? "0" : String(quoteAmount),
      amount_usd: market.amountUsd ?? 0,
      cost_usd: market.amountUsd ?? 0,
      buy_cost_usd: 0,
      price: priceUsd ?? 0,
      price_usd: priceUsd ?? 0,
      price_change: null,
      timestamp,
      ...(totalSupply === null ? {} : { base_total_supply: String(totalSupply) }),
      is_open_or_close: 0,
      launchpad: "",
      launchpad_platform: "",
      migrated_pool_exchange: "",
      base_token: {
        address: tokenAddress,
        symbol: ticker,
        name: text(item?.tokenName, 120),
        logo: tokenLogo,
        ...(market.marketCapAtTrade === null ? {} : {
          market_cap: market.marketCapAtTrade,
        }),
        total_supply: totalSupply === null ? "0" : String(totalSupply),
        token_create_time: 0,
        token_open_time: 0,
      },
      maker_info: {
        address: maker,
        name: displayName,
        twitter_username: text(item?.userHandle, 120),
        twitter_name: displayName,
        avatar,
        tags: [],
        tag_rank: {},
      },
      balance_info: null,
      quote_symbol: tokenTicker(item?.quoteSymbol),
    };
  }

  function toGmgnFollowSocketTrade(item) {
    const trade = toGmgnTrade(item);
    if (!trade) return null;
    return {
      n: trade.chain,
      s: trade.side,
      m: trade.maker,
      ts: trade.timestamp,
      h: trade.transaction_hash,
      a: trade.base_address,
      ba: trade.base_address,
      bs: trade.base_token.symbol,
      bn: trade.base_token.name,
      bl: trade.base_token.logo,
      ...(trade.base_total_supply ? { bts: trade.base_total_supply } : {}),
      ta: trade.base_amount,
      cu: trade.cost_usd,
      au: trade.amount_usd,
      bcu: trade.buy_cost_usd,
      pu: trade.price_usd,
      pc: trade.price_change,
      ooc: trade.is_open_or_close,
      id: trade.id,
      lp: trade.launchpad,
      tlp: trade.launchpad_platform,
      avatar: trade.maker_info.avatar,
      tu: trade.maker_info.twitter_username,
      tn: trade.maker_info.twitter_name,
      ma: trade.maker_info.address,
      t: trade.maker_info.tags,
      bp: trade.price,
      bot: trade.base_token.token_open_time,
      bct: trade.base_token.token_create_time,
      qad: trade.quote_address,
      qa: trade.quote_amount,
      qs: trade.quote_symbol,
      mpe: trade.migrated_pool_exchange,
    };
  }

  const RECENT_TRADE_LIMIT = 30;
  const TRACKING_PATHS = new Set([
    "/vas/api/v1/follow/follow_wallet_trade_list",
    "/vas/api/v1/follow/multi_chain_follow_wallet_trade_list",
  ]);

  function trackingRequest(value) {
    let url;
    try { url = new URL(value, "https://gmgn.ai"); } catch { return null; }
    if (!/^https:\/\/(?:www\.)?gmgn\.ai$/.test(url.origin)
      || !TRACKING_PATHS.has(url.pathname)) return null;
    const chains = new Set();
    const filters = new Set();
    for (const [key, value] of url.searchParams) {
      if (/^chain(?:\[\d*\])?$/.test(key)) {
        for (const chain of value.split(",")) if (chain.trim()) chains.add(chain.trim());
      }
      if (/^filters(?:\[\d*\])?$/.test(key)) {
        for (const filter of value.split(",")) filters.add(filter);
      }
      // A group or wallet scoped result must retain its native membership.
      if (/^(?:group_id|wallet|address|maker|token_address|base_address)(?:\[.*\])?$/.test(key)
        && value) return null;
    }
    if (!chains.size || filters.has("callOut")) return null;
    return {
      chains,
      filters,
      side: url.searchParams.get("side") || "",
      minAmount: finiteNumber(url.searchParams.get("min_amount_usd")),
      maxAmount: finiteNumber(url.searchParams.get("max_amount_usd")),
    };
  }

  function recentTrackingItems(items) {
    const byKey = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      const key = trackingItemKey(item);
      if (key && NETWORK_CHAINS[Number(item?.networkId)] && seconds(item?.createdAt)
        && text(item?.tokenAddress) && makerIdentity(item, item.platform)
        && ["buy", "sell"].includes(item.type) && !byKey.has(key)) byKey.set(key, item);
    }
    return [...byKey.values()]
      .sort((left, right) => seconds(right.createdAt) - seconds(left.createdAt))
      .slice(0, RECENT_TRADE_LIMIT);
  }

  function mergeRecentTrackingPayload(payload, request, items) {
    if (!request || !items?.length || !payload || typeof payload !== "object") return payload;
    const nested = Array.isArray(payload.data?.list);
    const list = nested ? payload.data.list : payload.list;
    if (!Array.isArray(list) || !list.length) return payload;
    const native = list.filter((row) => !String(row?.id || "").startsWith("external:"));
    let cutoff = Infinity;
    for (const row of native) {
      const timestamp = seconds(row?.timestamp);
      if (timestamp) cutoff = Math.min(cutoff, timestamp);
    }
    // No native time window means there is no safe cutoff to restore against.
    if (!Number.isFinite(cutoff)) return payload;
    const ids = new Set(list.map((row) => row?.id).filter(Boolean));
    const additions = [];
    for (const item of items.slice(0, RECENT_TRADE_LIMIT)) {
      const row = toGmgnTrade(item);
      if (!row || ids.has(row.id) || !request.chains.has(row.chain)
        || row.timestamp <= cutoff
        || (request.side && row.side !== request.side)
        || (request.filters.size && !request.filters.has(row.side)
          && !request.filters.has(row.side === "buy" ? "buy_more" : "sell_part"))
        || (request.minAmount !== null && row.amount_usd < request.minAmount)
        || (request.maxAmount !== null && row.amount_usd > request.maxAmount)) continue;
      ids.add(row.id);
      additions.push(row);
    }
    if (!additions.length) return payload;
    const merged = [...list, ...additions].sort((left, right) => (
      (seconds(right?.timestamp) || 0) - (seconds(left?.timestamp) || 0)
    ));
    return nested
      ? { ...payload, data: { ...payload.data, list: merged } }
      : { ...payload, list: merged };
  }

  return Object.freeze({
    NETWORK_CHAINS,
    finiteNumber,
    seconds,
    tokenTicker,
    markedImageUrl,
    trackingItemKey,
    tradeMarketData,
    toGmgnTrade,
    toGmgnFollowSocketTrade,
    RECENT_TRADE_LIMIT,
    trackingRequest,
    recentTrackingItems,
    mergeRecentTrackingPayload,
  });
});
