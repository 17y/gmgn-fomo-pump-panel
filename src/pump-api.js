(function exposePumpApi(root, factory) {
  const core = root.GmgnFomoCore || (typeof require === "function" ? require("./core") : null);
  const api = factory(core);
  root.GmgnPumpApi = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis, function createPumpApi(core) {
  "use strict";

  if (!core) throw new Error("GmgnFomoCore is required");

  const POSITIONS_ORIGIN = "https://frontend-api-v3.pump.fun";
  const PROFILE_ORIGIN = "https://profile-api.pump.fun";
  const SOLANA_RPC_ORIGIN = "https://api.mainnet-beta.solana.com";
  const POSITION_LIMIT = 50;
  const FOLLOWED_TRADES_LIMIT = 10;
  const FOLLOWED_TRADES_MAX_PAGES = 2;
  const FOLLOWED_TRADES_MIN_USD = 10;
  const PROFILE_TRANSACTIONS_MAX_PAGES = 2;
  const REALTIME_MARKET_SNAPSHOT_MAX_AGE_MS = 2 * 60_000;
  const SOLANA_NETWORK_ID = core.TOKEN_NETWORK_IDS.sol;
  const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
  const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const SOLANA_USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYDVTJUrT72KN3fG6wEgYwA";
  const PUMP_CHAIN_RPC_VERIFICATION = "pump-chain-rpc";
  const PUMP_ALERTS_REST_VERIFICATION = "pump-alerts-rest";
  const PUMP_ALERTS_NATS_VERIFICATION = "pump-alerts-nats";
  const EVM_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const EVM_SWAP_TOPICS = new Set([
    "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
    "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
    "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
  ]);
  const EVM_DIRECT_TRANSFER_SELECTORS = new Set([
    "0xa9059cbb",
    "0x23b872dd",
    "0x42842e0e",
    "0xb88d4fde",
  ]);
  const EVM_SYMBOL_DATA = "0x95d89b41";
  const EVM_SYMBOL_MAX_BYTES = 64;
  const EVM_SYMBOL_MAX_CHARACTERS = 32;
  const NATS_CONFIG_MARKERS = [
    { configs: '\\"configs\\":', instances: ',\\"instances\\":', escaped: true },
    { configs: '"configs":', instances: ',"instances":', escaped: false },
  ];
  const EVM_QUOTE_TOKENS = new Map([
    [5042, new Map([
      ["0x3600000000000000000000000000000000000000", "stable"],
    ])],
    [999, new Map([
      ["0x5555555555555555555555555555555555555555", "native"],
      ["0xb88339cb7199b77e23db6e890353e22632ba630f", "stable"],
    ])],
    [1, new Map([
      ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "native"],
      ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "stable"],
      ["0xdac17f958d2ee523a2206206994597c13d831ec7", "stable"],
      ["0x6b175474e89094c44da98b954eedeac495271d0f", "stable"],
    ])],
    [56, new Map([
      ["0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", "native"],
      ["0x55d398326f99059ff775485246999027b3197955", "stable"],
      ["0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", "stable"],
      ["0xc5f0f7b66764f6ec8c8dff7ba683102295e16409", "stable"],
    ])],
    [8453, new Map([
      ["0x4200000000000000000000000000000000000006", "native"],
      ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "stable"],
    ])],
    [4663, new Map([
      ["0x0bd7d308f8e1639fab988df18a8011f41eacad73", "native"],
      ["0x5fc5360d0400a0fd4f2af552add042d716f1d168", "stable"],
    ])],
  ]);
  const EVM_STABLE_TOKEN_DECIMALS = new Map([
    [5042, new Map([
      ["0x3600000000000000000000000000000000000000", 6],
    ])],
    [999, new Map([
      ["0xb88339cb7199b77e23db6e890353e22632ba630f", 6],
    ])],
    [1, new Map([
      ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6],
      ["0xdac17f958d2ee523a2206206994597c13d831ec7", 6],
      ["0x6b175474e89094c44da98b954eedeac495271d0f", 18],
    ])],
    [56, new Map([
      ["0x55d398326f99059ff775485246999027b3197955", 18],
      ["0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", 18],
      ["0xc5f0f7b66764f6ec8c8dff7ba683102295e16409", 18],
    ])],
    [8453, new Map([
      ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 6],
    ])],
    [4663, new Map([
      ["0x5fc5360d0400a0fd4f2af552add042d716f1d168", 6],
    ])],
  ]);

  function assertParams(params) {
    if (!core.validTokenAddress(params?.address)) throw new Error("INVALID_TOKEN");
  }

  function parseCoreNatsConfig(html) {
    if (typeof html !== "string" || !html.includes(".nats.realtime.pump.fun")) return null;
    let parsed = null;
    for (const marker of NATS_CONFIG_MARKERS) {
      const serverIndex = html.indexOf(".nats.realtime.pump.fun");
      const markerIndex = html.lastIndexOf(marker.configs, serverIndex);
      const start = markerIndex < 0 ? -1 : markerIndex + marker.configs.length;
      const end = start < 0 ? -1 : html.indexOf(marker.instances, serverIndex);
      if (start < 0 || end <= start) continue;
      try {
        const raw = marker.escaped
          ? html.slice(start, end).replaceAll('\\"', '"')
          : html.slice(start, end);
        parsed = JSON.parse(raw);
        break;
      } catch {}
    }
    const config = parsed?.CORE;
    const rawServer = Array.isArray(config?.servers) ? config.servers[0] : config?.servers;
    let server;
    try {
      server = new URL(rawServer);
    } catch {
      return null;
    }
    if (server.protocol !== "wss:"
      || !/(?:^|\.)nats\.realtime\.pump\.fun$/.test(server.hostname)) return null;
    const credential = (value) => (
      typeof value === "string" && value.length > 0 && value.length <= 256 ? value : ""
    );
    const user = credential(config.user);
    const pass = credential(config.pass);
    const token = credential(config.token);
    if ((!user || !pass) && !token) return null;
    const boundedMs = (value, fallback, min, max) => {
      const numeric = core.finiteNumber(value);
      return numeric !== null && numeric >= min && numeric <= max
        ? Math.trunc(numeric)
        : fallback;
    };
    return {
      server: server.toString().replace(/\/$/, ""),
      user,
      pass,
      token,
      pingInterval: boundedMs(config.pingInterval, 10_000, 1_000, 60_000),
      timeout: boundedMs(config.timeout, 5_000, 1_000, 30_000),
    };
  }

  function normalizeNatsWallet(value) {
    return core.normalizeWalletAddress(value, SOLANA_NETWORK_ID)
      || core.normalizeWalletAddress(value, core.TOKEN_NETWORK_IDS.eth)
      || "";
  }

  function buildAccountBalanceSubject(walletAddress) {
    const wallet = normalizeNatsWallet(walletAddress);
    return wallet ? `account_balance_change.${wallet}.*` : "";
  }

  function accountBalanceSubjectWallet(subject) {
    if (typeof subject !== "string") return "";
    const match = /^account_balance_change\.([^.]+)\.\*$/.exec(subject.trim());
    return match ? normalizeNatsWallet(match[1]) : "";
  }

  function buildPositionsRequest(params) {
    assertParams(params);
    const url = new URL(`/mint-positions/${encodeURIComponent(params.address)}`, POSITIONS_ORIGIN);
    url.searchParams.set("sortBy", "TOP");
    url.searchParams.set("withThesis", "true");
    url.searchParams.set("pageSize", String(POSITION_LIMIT));
    return { url: url.toString(), method: "GET" };
  }

  function buildUserRequest(userId) {
    const normalized = typeof userId === "string" ? userId.trim() : "";
    if (!normalized) throw new Error("INVALID_PUMP_USER");
    return {
      url: `${POSITIONS_ORIGIN}/users/${encodeURIComponent(normalized)}`,
      method: "GET",
    };
  }

  function buildProfileUrl(identifier) {
    const value = typeof identifier === "string" ? identifier.trim().replace(/^@/, "") : "";
    return value ? `https://pump.fun/profile/${encodeURIComponent(value)}` : "";
  }

  function buildFollowedTradesRequest(cursor = "") {
    const url = new URL("/following-positions/alerts", POSITIONS_ORIGIN);
    url.searchParams.set("pageSize", String(FOLLOWED_TRADES_LIMIT));
    url.searchParams.set("kinds", "trade");
    url.searchParams.set("minTradeAmountUsd", String(FOLLOWED_TRADES_MIN_USD));
    if (typeof cursor === "string" && cursor.trim()) url.searchParams.set("cursor", cursor.trim());
    return {
      url: url.toString(),
      method: "GET",
      credentials: "include",
      timeoutMs: 8_000,
    };
  }

  function buildPresenceRequest() {
    return {
      url: `${POSITIONS_ORIGIN}/following-positions/alerts/presence`,
      method: "POST",
      credentials: "include",
      timeoutMs: 8_000,
    };
  }

  function buildPresenceDeleteRequest() {
    return {
      url: `${POSITIONS_ORIGIN}/following-positions/alerts/presence`,
      method: "DELETE",
      credentials: "include",
      timeoutMs: 8_000,
      allowEmptyResponse: true,
    };
  }

  function sanitizeAlertsSubject(value) {
    const subject = typeof value === "string" ? value.trim() : "";
    return /^alertsFeed\.user\.[A-Za-z0-9_-]{1,128}\.(?:[A-Za-z0-9_-]{1,128}|\*)$/.test(subject)
      ? subject
      : "";
  }

  function presenceUserId(payload) {
    const subject = typeof payload?.subject === "string" ? payload.subject.trim() : "";
    const match = /^alertsFeed\.user\.([^.]+)\./.exec(subject);
    return match?.[1] || "";
  }

  function presenceRefreshMs(payload) {
    const heartbeat = core.finiteNumber(payload?.heartbeatIntervalSeconds);
    const seconds = heartbeat !== null && heartbeat > 0 ? heartbeat : 60;
    return Math.max(15_000, Math.trunc(seconds * 1_000));
  }

  function buildFollowingRequest(walletAddress) {
    const wallet = core.normalizeWalletAddress(walletAddress, SOLANA_NETWORK_ID);
    if (!wallet) throw new Error("INVALID_PUMP_WALLET");
    return {
      url: `${POSITIONS_ORIGIN}/following/${encodeURIComponent(wallet)}`,
      method: "GET",
      timeoutMs: 8_000,
    };
  }

  function buildFollowMutationRequest(walletAddress, shouldFollow) {
    const wallet = core.normalizeWalletAddress(walletAddress, SOLANA_NETWORK_ID);
    if (!wallet || typeof shouldFollow !== "boolean") {
      throw new Error("INVALID_PUMP_FOLLOW_REQUEST");
    }
    return {
      url: `${POSITIONS_ORIGIN}/${shouldFollow ? "following/v2" : "following"}/${encodeURIComponent(wallet)}`,
      method: shouldFollow ? "POST" : "DELETE",
      credentials: "include",
      timeoutMs: 8_000,
      allowEmptyResponse: true,
      includeWafToken: true,
    };
  }

  function sanitizeFollowing(payload) {
    const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.following) ? payload.following : [];
    const seen = new Set();
    return rows.map((row) => {
      const address = core.normalizeWalletAddress(
        row?.address ?? row?.walletAddress ?? row?.canonical_svm_wallet,
        SOLANA_NETWORK_ID,
      );
      if (!address || seen.has(address)) return null;
      seen.add(address);
      return {
        address,
        evmAddress: core.normalizeWalletAddress(
          row?.canonical_evm_wallet ?? row?.evmAddress ?? row?.evm_address,
          core.TOKEN_NETWORK_IDS.eth,
        ),
        userId: typeof (row?.userId ?? row?.user_id) === "string"
          ? (row.userId ?? row.user_id).trim()
          : "",
        username: typeof row?.username === "string" ? row.username.trim() : "",
        profileImage: core.safeHttpsUrl(row?.profile_image ?? row?.profileImage),
      };
    }).filter(Boolean);
  }

  function withUserWallets(author, payload) {
    return {
      ...author,
      evmAddress: core.normalizeWalletAddress(
        payload?.canonical_evm_wallet,
        core.TOKEN_NETWORK_IDS.eth,
      ) || author?.evmAddress || "",
      userId: typeof (payload?.userId ?? payload?.user_id) === "string"
        ? (payload.userId ?? payload.user_id).trim()
        : author?.userId || "",
    };
  }

  function buildProfileTransactionsRequest(walletAddress, cursor = "") {
    const wallet = core.normalizeWalletAddress(walletAddress, SOLANA_NETWORK_ID);
    if (!wallet) throw new Error("INVALID_PUMP_WALLET");
    const url = new URL(`/transactions/${encodeURIComponent(wallet)}`, PROFILE_ORIGIN);
    url.searchParams.set("dustFilter", "true");
    url.searchParams.set("includeEvm", "true");
    if (typeof cursor === "string" && cursor.trim()) url.searchParams.set("cursor", cursor.trim());
    return { url: url.toString(), method: "GET", timeoutMs: 8_000 };
  }

  function profileTransactionsNextCursor(payload) {
    return typeof payload?.pagination?.next_cursor === "string"
      ? payload.pagination.next_cursor.trim()
      : "";
  }

  function profileTransactions(payload) {
    return Array.isArray(payload?.transactions) ? payload.transactions : [];
  }

  function buildCoinRequest(tokenAddress) {
    if (!core.validTokenAddress(tokenAddress)) throw new Error("INVALID_TOKEN");
    const url = new URL(`/coins-v3/${encodeURIComponent(tokenAddress)}`, POSITIONS_ORIGIN);
    url.searchParams.set("includeLiveStreamInfo", "false");
    return { url: url.toString(), method: "GET", timeoutMs: 8_000 };
  }

  function buildSolPriceRequest() {
    return { url: `${POSITIONS_ORIGIN}/sol-price`, method: "GET", timeoutMs: 8_000 };
  }

  function sanitizeSolPrice(payload) {
    const value = core.finiteNumber(payload?.solPrice ?? payload?.price);
    return value !== null && value > 0 ? value : null;
  }

  function buildSolanaTransactionsRequest(signatures) {
    const unique = [...new Set((Array.isArray(signatures) ? signatures : [])
      .filter((signature) => typeof signature === "string" && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)))];
    if (!unique.length) throw new Error("INVALID_SOLANA_SIGNATURES");
    return {
      url: SOLANA_RPC_ORIGIN,
      method: "POST",
      timeoutMs: 12_000,
      body: JSON.stringify(unique.map((signature) => ({
        jsonrpc: "2.0",
        id: signature,
        method: "getTransaction",
        params: [signature, {
          encoding: "jsonParsed",
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        }],
      }))),
    };
  }

  function buildEvmTransactionsRequest(transactionHashes) {
    const unique = [...new Set((Array.isArray(transactionHashes) ? transactionHashes : [])
      .map((hash) => typeof hash === "string" ? hash.toLowerCase() : "")
      .filter((hash) => /^0x[0-9a-f]{64}$/.test(hash)))];
    if (!unique.length) throw new Error("INVALID_EVM_TRANSACTION_HASHES");
    return unique.flatMap((hash) => [{
      jsonrpc: "2.0",
      id: `transaction:${hash}`,
      method: "eth_getTransactionByHash",
      params: [hash],
    }, {
      jsonrpc: "2.0",
      id: `receipt:${hash}`,
      method: "eth_getTransactionReceipt",
      params: [hash],
    }]);
  }

  function buildEvmTokenSymbolRequests(tokenAddresses, networkId) {
    if (networkId === SOLANA_NETWORK_ID) return [];
    const tokens = [...new Set((Array.isArray(tokenAddresses) ? tokenAddresses : [])
      .map((address) => core.normalizeWalletAddress(address, networkId))
      .filter(Boolean))];
    return tokens.map((token) => ({
      jsonrpc: "2.0",
      id: `symbol:${token}`,
      method: "eth_call",
      params: [{ to: token, data: EVM_SYMBOL_DATA }, "latest"],
    }));
  }

  function decodedEvmSymbol(bytes) {
    let value;
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    } catch {
      return "";
    }
    if (/[\p{Cc}\p{Cf}]/u.test(value)) return "";
    const symbol = value.trim();
    return symbol && Array.from(symbol).length <= EVM_SYMBOL_MAX_CHARACTERS ? symbol : "";
  }

  function decodeEvmTokenSymbol(value) {
    if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(value)) return "";
    const hex = value.slice(2);
    if (hex.length === 64) {
      const bytes = hex.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16));
      const terminator = bytes.indexOf(0);
      if (terminator >= 0 && bytes.slice(terminator).some((byte) => byte !== 0)) return "";
      return decodedEvmSymbol(terminator >= 0 ? bytes.slice(0, terminator) : bytes);
    }
    if (hex.length < 128) return "";
    try {
      const offset = BigInt(`0x${hex.slice(0, 64)}`);
      const length = BigInt(`0x${hex.slice(64, 128)}`);
      if (offset !== 32n || length <= 0n || length > BigInt(EVM_SYMBOL_MAX_BYTES)) return "";
      const byteLength = Number(length);
      const paddedLength = Math.ceil(byteLength / 32) * 32;
      if (hex.length !== (64 + paddedLength) * 2) return "";
      const data = hex.slice(128, 128 + (byteLength * 2));
      const padding = hex.slice(128 + (byteLength * 2));
      if (!/^0*$/.test(padding)) return "";
      return decodedEvmSymbol(data.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)));
    } catch {
      return "";
    }
  }

  function followedTradesNextCursor(payload) {
    return typeof payload?.nextCursor === "string" ? payload.nextCursor.trim() : "";
  }

  function sanitizeUserWallet(payload, networkId) {
    const value = networkId === core.TOKEN_NETWORK_IDS.sol
      ? payload?.canonical_svm_wallet
      : payload?.canonical_evm_wallet;
    return core.normalizeWalletAddress(value, networkId);
  }

  function positiveRatio(numerator, denominator) {
    const top = core.finiteNumber(numerator);
    const bottom = core.finiteNumber(denominator);
    return top !== null && bottom !== null && bottom > 0 ? top / bottom : null;
  }

  function sanitizePositions(payload, metadata = {}) {
    const rows = Array.isArray(payload?.positions) ? payload.positions : [];
    const supply = core.finiteNumber(metadata.totalSupply);
    const metadataPrice = core.finiteNumber(metadata.priceUsd);
    const marketCap = core.finiteNumber(metadata.marketCap);
    const priceUsd = metadataPrice ?? positiveRatio(marketCap, supply);

    return rows.map((row, index) => {
      const callout = row?.callout && typeof row.callout === "object" ? row.callout : null;
      const humanAmount = core.finiteNumber(row?.amountHeld);
      const comment = typeof callout?.thesis === "string" ? callout.thesis.trim() : "";
      if (!callout || !comment || humanAmount === null || humanAmount <= 0) return null;

      const amountBoughtEntry = positiveRatio(row.amountBoughtUsd, row.amountBought);
      const costBasisEntry = positiveRatio(row.costBasisUsd, row.costBasisAmount);
      return {
        id: `pump:${callout.calloutId || row.userId || index}`,
        platform: "pump",
        userId: typeof row.userId === "string" ? row.userId.trim() : "",
        walletAddress: typeof row.walletAddress === "string" ? row.walletAddress.trim() : "",
        displayName: row.userName || row.xUsername || row.walletAddress || "Pump caller",
        userHandle: row.xUsername || row.userName || "",
        profileUrl: buildProfileUrl(row.userName || row.walletAddress),
        profilePictureLink: core.safeHttpsUrl(row.profileImage),
        clanName: "",
        value: priceUsd === null ? null : humanAmount * priceUsd,
        humanAmount,
        ownershipPercent: supply !== null && supply > 0 ? (humanAmount / supply) * 100 : null,
        pnl: core.finiteNumber(row.pnlUsd),
        pnlPercent: core.finiteNumber(row.pnlPercentage),
        realizedPnl: core.finiteNumber(row.realizedPnlUsd),
        costBasis: core.finiteNumber(row.costBasisUsd),
        averageEntryPrice: amountBoughtEntry ?? costBasisEntry,
        comment,
        likes: core.finiteNumber(callout.likes) || 0,
        createdAt: Date.parse(callout.calloutTimestamp) || null,
        calloutMarketCap: core.finiteNumber(callout.calledOutAtMcap),
        calloutPrice: core.finiteNumber(callout.calloutPrice),
        isDev: false,
      };
    }).filter(Boolean);
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

  function networkIdFromProfileRow(row) {
    const rawNetwork = row?.network_id ?? row?.networkId ?? row?.chain_id ?? row?.chainId;
    const numeric = Number(rawNetwork);
    if (Number.isInteger(numeric) && Object.values(core.TOKEN_NETWORK_IDS).includes(numeric)) return numeric;
    const rawChain = row?.chain ?? rawNetwork;
    const chain = typeof rawChain === "string" ? rawChain.toLowerCase() : "";
    if (chain === "solana") return SOLANA_NETWORK_ID;
    if (chain === "hyperliquid") return core.TOKEN_NETWORK_IDS.hyperevm;
    if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(String(row?.tx_hash || ""))) return SOLANA_NETWORK_ID;
    return core.TOKEN_NETWORK_IDS[chain] || null;
  }

  function stableQuoteSymbol(value) {
    const symbol = typeof value === "string" ? value.trim().toUpperCase() : "";
    return /^(?:USDC|USDT|USDG|USDS|USDE|FDUSD|DAI)$/.test(symbol);
  }

  function quoteKind(asset, networkId) {
    const mint = typeof asset?.mint === "string" ? asset.mint.trim() : "";
    const symbol = asset?.metadata?.symbol ?? asset?.symbol;
    if (networkId === SOLANA_NETWORK_ID) {
      if (mint === SOLANA_USDC_MINT || mint === SOLANA_USDT_MINT) return "stable";
      if (mint === WRAPPED_SOL_MINT) return "sol";
    } else {
      const addressKind = EVM_QUOTE_TOKENS.get(Number(networkId))?.get(mint.toLowerCase());
      if (addressKind) return addressKind;
    }
    if (stableQuoteSymbol(symbol)) return "stable";
    if (Number(networkId) === 999 && /^(?:HYPE|WHYPE)$/.test(String(symbol || "").trim().toUpperCase())) return "native";
    return /^(?:ETH|WETH|BNB|WBNB)$/.test(String(symbol || "").trim().toUpperCase())
      ? "native"
      : "";
  }

  function tokenAddressForNetwork(value, networkId) {
    if (typeof value !== "string") return "";
    return core.normalizeWalletAddress(value.trim(), networkId);
  }

  function normalizedTradeIdentity(transactionHash, walletAddress, tokenAddress, networkId) {
    const isSolana = networkId === SOLANA_NETWORK_ID;
    const hash = typeof transactionHash === "string" ? transactionHash.trim() : "";
    const normalizedHash = isSolana
      ? hash
      : /^0x[0-9a-f]{64}$/i.test(hash) ? hash.toLowerCase() : "";
    const normalizedWallet = isSolana
      ? (typeof walletAddress === "string" ? walletAddress.trim() : "")
      : core.normalizeWalletAddress(walletAddress, networkId);
    const normalizedToken = isSolana
      ? (typeof tokenAddress === "string" ? tokenAddress.trim() : "")
      : core.normalizeWalletAddress(tokenAddress, networkId);
    return normalizedHash && normalizedWallet && core.validTokenAddress(normalizedToken)
      ? { transactionHash: normalizedHash, walletAddress: normalizedWallet, tokenAddress: normalizedToken }
      : null;
  }

  function profileWallet(row, author, networkId) {
    const candidates = networkId === SOLANA_NETWORK_ID
      ? [author?.address, row?.wallet_address, row?.walletAddress, row?.user_address]
      : [
        author?.evmAddress,
        row?.wallet_address,
        row?.walletAddress,
        row?.user_address,
        row?.evm_address,
      ];
    return candidates
      .map((value) => core.normalizeWalletAddress(value, networkId))
      .find(Boolean) || "";
  }

  function followedTradeItem({
    transactionHash,
    walletAddress,
    tokenAddress,
    direction,
    createdAt,
    networkId,
    author,
    token,
    usdAmount,
    marketCap,
    baseAmount,
    quoteAmount,
    quoteAddress,
    quoteSymbol,
  }) {
    const identity = normalizedTradeIdentity(
      transactionHash,
      walletAddress,
      tokenAddress,
      networkId,
    );
    if (!identity || !["buy", "sell"].includes(direction) || !createdAt || !networkId) return null;
    const metadata = token?.metadata && typeof token.metadata === "object" ? token.metadata : {};
    const resolvedMarketCap = core.finiteNumber(marketCap)
      ?? core.finiteNumber(metadata.marketCap)
      ?? core.finiteNumber(metadata.market_cap)
      ?? core.finiteNumber(metadata.marketCapUsd)
      ?? core.finiteNumber(metadata.usd_market_cap)
      ?? core.finiteNumber(metadata.fdv)
      ?? core.finiteNumber(token?.marketCap)
      ?? core.finiteNumber(token?.market_cap)
      ?? core.finiteNumber(token?.fdv);
    return {
      id: `pump:${identity.transactionHash}:${identity.walletAddress}:${identity.tokenAddress}:${direction}`,
      platform: "pump",
      type: direction,
      createdAt,
      tokenAddress: identity.tokenAddress,
      networkId,
      transactionHash: identity.transactionHash,
      walletAddress: identity.walletAddress,
      userId: typeof author?.userId === "string" ? author.userId.trim() : "",
      displayName: author?.username || walletAddress || "Pump trader",
      userHandle: author?.username || "",
      profilePictureLink: core.safeHttpsUrl(author?.profileImage),
      tokenSymbol: metadata.symbol
        || metadata.tokenSymbol
        || metadata.token_symbol
        || token?.symbol
        || token?.tokenSymbol
        || token?.coinSymbol
        || "",
      tokenName: metadata.name || token?.name || "",
      tokenImageUrl: core.safeTokenImageUrl(metadata.icon || metadata.image || token?.image),
      usdAmount: core.finiteNumber(usdAmount),
      baseAmount: core.finiteNumber(baseAmount) === null
        ? null
        : Math.abs(core.finiteNumber(baseAmount)),
      quoteAmount: core.finiteNumber(quoteAmount) === null
        ? null
        : Math.abs(core.finiteNumber(quoteAmount)),
      quoteAddress: tokenAddressForNetwork(quoteAddress, networkId),
      quoteSymbol: typeof quoteSymbol === "string" ? quoteSymbol.trim() : "",
      marketCap: resolvedMarketCap,
      isDev: false,
    };
  }

  function sanitizeProfileSwaps(payload, author = {}) {
    return profileTransactions(payload).map((row) => {
      if (String(row?.type || "").toUpperCase() !== "SWAP") return null;
      const networkId = networkIdFromProfileRow(row);
      if (!networkId) return null;
      const incoming = row?.token_in;
      const outgoing = row?.token_out;
      const incomingQuote = quoteKind(incoming, networkId);
      const outgoingQuote = quoteKind(outgoing, networkId);
      let direction = "";
      let token = null;
      let quote = null;
      let quoteType = "";
      if (incomingQuote && !outgoingQuote) {
        direction = "sell";
        token = outgoing;
        quote = incoming;
        quoteType = incomingQuote;
      } else if (outgoingQuote && !incomingQuote) {
        direction = "buy";
        token = incoming;
        quote = outgoing;
        quoteType = outgoingQuote;
      }
      const quoteAmount = core.finiteNumber(quote?.amount);
      return followedTradeItem({
        transactionHash: typeof row?.tx_hash === "string" ? row.tx_hash.trim() : "",
        walletAddress: profileWallet(row, author, networkId),
        tokenAddress: tokenAddressForNetwork(token?.mint, networkId),
        direction,
        createdAt: timestampMilliseconds(row?.block_time),
        networkId,
        author,
        token,
        usdAmount: quoteType === "stable"
          ? quoteAmount
          : null,
        baseAmount: token?.amount,
        quoteAmount,
        quoteAddress: quote?.mint,
        quoteSymbol: quote?.metadata?.symbol ?? quote?.symbol,
      });
    }).filter(Boolean);
  }

  function profileTransferGroups(payload, author = {}, includeSwaps = false) {
    const groups = new Map();
    for (const row of profileTransactions(payload)) {
      const rowType = String(row?.type || "").toUpperCase();
      const rawHash = typeof row?.tx_hash === "string" ? row.tx_hash.trim() : "";
      const networkId = networkIdFromProfileRow(row);
      if (!networkId) continue;
      const includeSwap = rowType === "SWAP" && (
        includeSwaps === true
        || includeSwaps === "all"
        || (includeSwaps === "evm" && networkId !== SOLANA_NETWORK_ID)
      );
      if (rowType !== "TRANSFER" && !includeSwap) continue;
      const transactionHash = networkId === SOLANA_NETWORK_ID ? rawHash : rawHash.toLowerCase();
      const validHash = networkId === SOLANA_NETWORK_ID
        ? /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(transactionHash)
        : /^0x[0-9a-f]{64}$/.test(transactionHash);
      if (!validHash) continue;
      const walletAddress = profileWallet(row, author, networkId);
      if (!walletAddress) continue;
      const createdAt = timestampMilliseconds(row?.block_time);
      if (!createdAt) continue;
      const key = `${networkId}:${transactionHash}:${walletAddress}`;
      const group = groups.get(key) || {
        transactionHash,
        walletAddress,
        author,
        createdAt,
        networkId,
        rows: [],
      };
      group.createdAt = Math.max(group.createdAt, createdAt);
      group.rows.push(row);
      groups.set(key, group);
    }
    return [...groups.values()].sort((left, right) => right.createdAt - left.createdAt);
  }

  function profileTransferDeltas(group) {
    const deltas = new Map();
    function add(asset, direction) {
      const mint = tokenAddressForNetwork(asset?.mint, group?.networkId);
      const amount = core.finiteNumber(asset?.amount);
      if (!mint || amount === null || amount <= 0) return;
      const current = deltas.get(mint) || { mint, amount: 0, metadata: asset.metadata || {} };
      current.amount += direction * amount;
      deltas.set(mint, current);
    }
    for (const row of Array.isArray(group?.rows) ? group.rows : []) {
      if (String(row?.type || "").toUpperCase() === "SWAP") {
        add(row?.token_in, 1);
        add(row?.token_out, -1);
        continue;
      }
      const asset = row?.token_transferred;
      const direction = String(row?.direction || "").toUpperCase();
      if (!["IN", "OUT"].includes(direction)) continue;
      add(asset, direction === "IN" ? 1 : -1);
    }
    return [...deltas.values()].filter((entry) => Math.abs(entry.amount) > 0);
  }

  function isProfileRpcCandidate(group) {
    return Boolean(group?.transactionHash && group?.walletAddress && group?.networkId
      && Array.isArray(group?.rows) && group.rows.length);
  }

  function rawTokenBalances(entries, walletAddress) {
    const balances = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry?.owner !== walletAddress || typeof entry?.mint !== "string") continue;
      const raw = entry?.uiTokenAmount?.amount;
      const decimals = Number(entry?.uiTokenAmount?.decimals);
      if (!/^\d+$/.test(String(raw || "")) || !Number.isInteger(decimals) || decimals < 0) continue;
      const current = balances.get(entry.mint) || { raw: 0n, decimals };
      if (current.decimals !== decimals) continue;
      current.raw += BigInt(raw);
      balances.set(entry.mint, current);
    }
    return balances;
  }

  function ownerTokenDeltas(result, walletAddress) {
    const pre = rawTokenBalances(result?.meta?.preTokenBalances, walletAddress);
    const post = rawTokenBalances(result?.meta?.postTokenBalances, walletAddress);
    return [...new Set([...pre.keys(), ...post.keys()])].map((mint) => {
      const decimals = post.get(mint)?.decimals ?? pre.get(mint)?.decimals;
      const deltaRaw = (post.get(mint)?.raw || 0n) - (pre.get(mint)?.raw || 0n);
      return {
        mint,
        amount: Number(deltaRaw) / (10 ** decimals),
        deltaRaw,
        metadata: {},
      };
    }).filter((entry) => entry.deltaRaw !== 0n);
  }

  function profileMetadata(group, mint) {
    return profileTransferDeltas(group).find((entry) => entry.mint === mint)?.metadata || {};
  }

  function selectTradeToken(deltas, group) {
    const tokens = deltas.filter((entry) => !quoteKind(entry, SOLANA_NETWORK_ID));
    if (tokens.length === 1) return tokens[0];
    const profileTokens = profileTransferDeltas(group)
      .filter((entry) => !quoteKind(entry, SOLANA_NETWORK_ID))
      .map((entry) => entry.mint);
    const matches = tokens.filter((entry) => profileTokens.includes(entry.mint));
    return matches.length === 1 ? matches[0] : null;
  }

  function walletSignedTransaction(result, walletAddress) {
    const keys = result?.transaction?.message?.accountKeys;
    return Array.isArray(keys) && keys.some((entry) => (
      typeof entry === "string"
        ? false
        : entry?.pubkey === walletAddress && entry?.signer === true
    ));
  }

  function nativeSolDelta(result, walletAddress) {
    const keys = result?.transaction?.message?.accountKeys;
    const pre = result?.meta?.preBalances;
    const post = result?.meta?.postBalances;
    if (!Array.isArray(keys) || !Array.isArray(pre) || !Array.isArray(post)) return null;
    const index = keys.findIndex((entry) => (
      typeof entry === "string" ? entry === walletAddress : entry?.pubkey === walletAddress
    ));
    if (index < 0) return null;
    const before = core.finiteNumber(pre[index]);
    const after = core.finiteNumber(post[index]);
    if (before === null || after === null) return null;
    const fee = index === 0 ? core.finiteNumber(result?.meta?.fee) || 0 : 0;
    return (after - before + fee) / 1e9;
  }

  function hasSwapExecution(result) {
    const logs = Array.isArray(result?.meta?.logMessages) ? result.meta.logMessages.join("\n") : "";
    return /Instruction:\s*[A-Za-z0-9_]*(?:Swap|Route)[A-Za-z0-9_]*/i.test(logs)
      || /Instruction:\s*(?:Buy|Sell)[A-Za-z0-9_]*/i.test(logs)
      || /Program log:\s*(?:swap|route|buy|sell)\b/i.test(logs);
  }

  function sanitizeSolanaRpcTrade(payload, group, solPrice = null) {
    const result = payload?.result ?? payload;
    if (!result || result?.meta?.err || !hasSwapExecution(result)) return null;
    const deltas = ownerTokenDeltas(result, group?.walletAddress);
    const selected = selectTradeToken(deltas, group);
    if (!selected) return null;
    const token = { ...selected, metadata: profileMetadata(group, selected.mint) };
    const direction = token.amount > 0 ? "buy" : "sell";
    let quoteDeltas = deltas.filter((entry) => quoteKind(entry, SOLANA_NETWORK_ID));
    if (!quoteDeltas.some((entry) => direction === "buy" ? entry.amount < 0 : entry.amount > 0)) {
      quoteDeltas = profileTransferDeltas(group)
        .filter((entry) => quoteKind(entry, SOLANA_NETWORK_ID));
    }
    let quote = quoteDeltas.find((entry) => (
      direction === "buy" ? entry.amount < 0 : entry.amount > 0
    ));
    if (!quote) {
      const solAmount = nativeSolDelta(result, group?.walletAddress);
      if (solAmount !== null && (direction === "buy" ? solAmount < 0 : solAmount > 0)) {
        quote = { mint: WRAPPED_SOL_MINT, amount: solAmount, metadata: { symbol: "SOL" } };
      }
    }
    if (!quote && !walletSignedTransaction(result, group?.walletAddress)) return null;
    const kind = quoteKind(quote, SOLANA_NETWORK_ID);
    const usdAmount = kind === "stable"
      ? Math.abs(quote.amount)
      : kind === "sol" && core.finiteNumber(solPrice) !== null
        ? Math.abs(quote.amount) * Number(solPrice)
        : null;
    const item = followedTradeItem({
      transactionHash: group.transactionHash,
      walletAddress: group.walletAddress,
      tokenAddress: token.mint,
      direction,
      createdAt: timestampMilliseconds(result.blockTime) ?? group.createdAt,
      networkId: SOLANA_NETWORK_ID,
      author: group.author,
      token,
      usdAmount,
      baseAmount: token.amount,
      quoteAmount: quote?.amount,
      quoteAddress: quote?.mint,
      quoteSymbol: quote?.metadata?.symbol ?? quote?.symbol,
    });
    return item ? { ...item, sourceVerification: PUMP_CHAIN_RPC_VERIFICATION } : null;
  }

  function parseEvmQuantity(value) {
    if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }

  function evmTopicAddress(value, networkId) {
    if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) return "";
    return core.normalizeWalletAddress(`0x${value.slice(-40)}`, networkId);
  }

  function evmTransferLogs(receipt, networkId) {
    return (Array.isArray(receipt?.logs) ? receipt.logs : []).map((log) => {
      if (String(log?.topics?.[0] || "").toLowerCase() !== EVM_TRANSFER_TOPIC
        || log.topics.length !== 3) return null;
      const mint = core.normalizeWalletAddress(log?.address, networkId);
      const from = evmTopicAddress(log.topics[1], networkId);
      const to = evmTopicAddress(log.topics[2], networkId);
      const amountRaw = parseEvmQuantity(log?.data);
      return mint && from && to && amountRaw !== null
        ? { mint, from, to, amountRaw }
        : null;
    }).filter(Boolean);
  }

  function evmWalletTokenDeltas(logs, walletAddress, group) {
    const deltas = new Map();
    for (const log of logs) {
      let delta = 0n;
      if (log.to === walletAddress) delta += log.amountRaw;
      if (log.from === walletAddress) delta -= log.amountRaw;
      if (delta === 0n) continue;
      deltas.set(log.mint, (deltas.get(log.mint) || 0n) + delta);
    }
    return [...deltas.entries()].filter(([, deltaRaw]) => deltaRaw !== 0n).map(([mint, deltaRaw]) => ({
      mint,
      deltaRaw,
      amount: deltaRaw > 0n ? 1 : -1,
      metadata: profileMetadata(group, mint),
    }));
  }

  function evmTargetCounterparties(logs, walletAddress, target) {
    const counterparties = new Set();
    for (const log of logs) {
      if (log.mint !== target.mint) continue;
      if (log.from === walletAddress && log.to !== walletAddress) counterparties.add(log.to);
      if (log.to === walletAddress && log.from !== walletAddress) counterparties.add(log.from);
    }
    return counterparties;
  }

  function selectEvmTradeToken(deltas, group) {
    const tokens = deltas.filter((entry) => !quoteKind(entry, group.networkId));
    if (tokens.length === 1) return tokens[0];
    const profileTokens = profileTransferDeltas(group)
      .filter((entry) => !quoteKind(entry, group.networkId))
      .map((entry) => entry.mint);
    const matches = tokens.filter((entry) => profileTokens.includes(entry.mint));
    return matches.length === 1 ? matches[0] : null;
  }

  function evmSwapEvidence(transaction, receipt, group, target, deltas, logs) {
    const selector = typeof transaction?.input === "string"
      ? transaction.input.slice(0, 10).toLowerCase()
      : "";
    const callTarget = core.normalizeWalletAddress(transaction?.to, group.networkId);
    if (callTarget === target.mint && EVM_DIRECT_TRANSFER_SELECTORS.has(selector)) return false;

    const direction = target.deltaRaw > 0n ? "buy" : "sell";
    const reverseQuote = deltas.some((entry) => (
      quoteKind(entry, group.networkId)
      && (direction === "buy" ? entry.deltaRaw < 0n : entry.deltaRaw > 0n)
    ));
    if (reverseQuote) return true;

    const counterparties = evmTargetCounterparties(logs, group.walletAddress, target);
    if (!counterparties.size) return false;
    const linkedQuote = logs.some((entry) => (
      quoteKind(entry, group.networkId)
      && (direction === "buy"
        ? counterparties.has(entry.to)
        : counterparties.has(entry.from))
    ));
    if (linkedQuote) return true;

    const linkedSwap = (Array.isArray(receipt?.logs) ? receipt.logs : []).some((log) => {
      if (!EVM_SWAP_TOPICS.has(String(log?.topics?.[0] || "").toLowerCase())) return false;
      const emitter = core.normalizeWalletAddress(log?.address, group.networkId);
      return counterparties.has(emitter);
    });
    if (linkedSwap) return true;

    const value = parseEvmQuantity(transaction?.value);
    if (direction !== "buy" || value === null || value <= 0n) return false;
    const sender = core.normalizeWalletAddress(transaction?.from, group.networkId);
    return sender === group.walletAddress && counterparties.has(callTarget);
  }

  function evmStableQuoteFromReceipt(logs, group, target, direction) {
    const counterparties = evmTargetCounterparties(logs, group.walletAddress, target);
    if (!counterparties.size) return null;
    const candidates = logs.filter((entry) => (
      quoteKind(entry, group.networkId) === "stable"
      && (direction === "buy"
        ? counterparties.has(entry.to)
        : counterparties.has(entry.from))
    ));
    const unique = new Map(candidates.map((entry) => (
      [`${entry.mint}:${entry.amountRaw}`, entry]
    )));
    if (unique.size !== 1) return null;
    const [quote] = unique.values();
    const decimals = EVM_STABLE_TOKEN_DECIMALS.get(Number(group.networkId))?.get(quote.mint);
    if (!Number.isInteger(decimals)) return null;
    const amount = Number(quote.amountRaw) / (10 ** decimals);
    return Number.isFinite(amount) && amount > 0
      ? { mint: quote.mint, amount, metadata: { symbol: "USD" } }
      : null;
  }

  function sanitizeEvmRpcTrade(payload, group) {
    const transaction = payload?.transaction;
    const receipt = payload?.receipt;
    if (!transaction || !receipt || !["0x1", 1, true].includes(receipt.status)) return null;
    const transactionHash = String(transaction.hash || receipt.transactionHash || "").toLowerCase();
    if (transactionHash !== group?.transactionHash) return null;
    const logs = evmTransferLogs(receipt, group.networkId);
    const deltas = evmWalletTokenDeltas(logs, group.walletAddress, group);
    const selected = selectEvmTradeToken(deltas, group);
    if (!selected || !evmSwapEvidence(transaction, receipt, group, selected, deltas, logs)) return null;

    const direction = selected.deltaRaw > 0n ? "buy" : "sell";
    const quote = profileTransferDeltas(group).find((entry) => (
      quoteKind(entry, group.networkId)
      && (direction === "buy" ? entry.amount < 0 : entry.amount > 0)
    ));
    const receiptQuote = evmStableQuoteFromReceipt(logs, group, selected, direction);
    const usdAmount = quoteKind(quote, group.networkId) === "stable"
      ? Math.abs(quote.amount)
      : receiptQuote?.amount ?? null;
    const token = { ...selected, metadata: profileMetadata(group, selected.mint) };
    const profileToken = profileTransferDeltas(group)
      .find((entry) => entry.mint === selected.mint);
    const item = followedTradeItem({
      transactionHash: group.transactionHash,
      walletAddress: group.walletAddress,
      tokenAddress: selected.mint,
      direction,
      createdAt: group.createdAt,
      networkId: group.networkId,
      author: group.author,
      token,
      usdAmount,
      baseAmount: profileToken?.amount,
      quoteAmount: quote?.amount,
      quoteAddress: quote?.mint,
      quoteSymbol: quote?.metadata?.symbol ?? quote?.symbol,
    });
    const baseAmount = core.finiteNumber(item?.baseAmount);
    const priceUsdAtTrade = usdAmount !== null && baseAmount !== null && baseAmount > 0
      ? usdAmount / baseAmount
      : null;
    return item ? {
      ...item,
      priceUsdAtTrade,
      sourceVerification: PUMP_CHAIN_RPC_VERIFICATION,
    } : null;
  }

  function withCoinMetadata(item, payload) {
    if (!item) return null;
    const coin = payload && typeof payload === "object" ? payload : {};
    const totalSupply = coinTotalSupply(coin) ?? core.finiteNumber(item.totalSupply);
    const marketCap = core.finiteNumber(coin.usd_market_cap)
      ?? core.finiteNumber(coin.marketCap)
      ?? core.finiteNumber(coin.market_cap)
      ?? core.finiteNumber(item.marketCap);
    const priceUsdAtTrade = core.finiteNumber(item.priceUsdAtTrade);
    const marketCapAtTrade = core.finiteNumber(item.marketCapAtTrade)
      ?? (priceUsdAtTrade !== null && priceUsdAtTrade > 0
        && totalSupply !== null && totalSupply > 0
        ? priceUsdAtTrade * totalSupply
        : null);
    return {
      ...item,
      tokenSymbol: coin.symbol || item.tokenSymbol || "",
      tokenName: coin.name || item.tokenName || "",
      tokenImageUrl: core.safeTokenImageUrl(
        coin.image_uri || coin.imageUri || coin.image || item.tokenImageUrl,
      ),
      marketCap,
      marketCapAtTrade,
      totalSupply,
    };
  }

  function coinTotalSupply(coin) {
    const raw = coin?.total_supply_str ?? coin?.total_supply;
    const decimals = Number(coin?.base_decimals ?? coin?.decimals);
    if (/^\d+$/.test(String(raw || ""))
      && Number.isInteger(decimals) && decimals >= 0 && decimals <= 30) {
      const digits = String(raw);
      const padded = digits.padStart(decimals + 1, "0");
      const value = decimals
        ? `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`
        : padded;
      return core.finiteNumber(value);
    }
    return core.finiteNumber(coin?.totalSupply);
  }

  function pumpNetworkId(row, tokenAddress) {
    if (/^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(tokenAddress)) return core.TOKEN_NETWORK_IDS.sol;
    const raw = row?.chainId ?? row?.coin?.chainId;
    const numeric = Number(raw);
    if (Number.isInteger(numeric) && Object.values(core.TOKEN_NETWORK_IDS).includes(numeric)) return numeric;
    const name = typeof raw === "string" ? raw.toLowerCase() : "";
    if (name === "hyperliquid") return core.TOKEN_NETWORK_IDS.hyperevm;
    return core.TOKEN_NETWORK_IDS[name] || null;
  }

  function sanitizeFollowedTrades(payload) {
    const rows = Array.isArray(payload?.items) ? payload.items : [];
    return rows.map((row) => {
      const trade = row?.kind === "trade" && row.trade && typeof row.trade === "object" ? row.trade : null;
      const rawTokenAddress = typeof row?.coinMint === "string" ? row.coinMint.trim() : "";
      const createdAt = timestampMilliseconds(row?.createdAt)
        ?? timestampMilliseconds(trade?.timestamp);
      const networkId = pumpNetworkId(row, rawTokenAddress);
      if (!trade || !core.validTokenAddress(rawTokenAddress) || createdAt === null || !networkId) return null;

      const author = row.author && typeof row.author === "object" ? row.author : {};
      const coin = row.coin && typeof row.coin === "object" ? row.coin : {};
      const identity = normalizedTradeIdentity(
        trade.tx,
        row.walletAddress,
        rawTokenAddress,
        networkId,
      );
      if (!identity) return null;
      const direction = trade.isBuy === true ? "buy" : trade.isBuy === false ? "sell" : "";
      if (!direction) return null;
      const marketCapAtTrade = core.finiteNumber(trade.marketCapAtTrade)
        ?? core.finiteNumber(trade.marketCapAtTradeUsd)
        ?? core.finiteNumber(trade.marketCapUsdAtTrade)
        ?? core.finiteNumber(trade.fdvAtTrade)
        ?? core.finiteNumber(trade.market_cap_at_trade)
        ?? core.finiteNumber(trade.fdv_at_trade);
      const totalSupplyAtTrade = core.finiteNumber(
        trade.totalSupplyAtTrade ?? trade.total_supply_at_trade,
      );
      const metadataMarketCap = core.finiteNumber(coin.marketCap)
        ?? core.finiteNumber(coin.marketCapUsd)
        ?? core.finiteNumber(coin.market_cap)
        ?? core.finiteNumber(coin.usd_market_cap)
        ?? core.finiteNumber(coin.fdv)
        ?? core.finiteNumber(coin.metadata?.marketCap)
        ?? core.finiteNumber(coin.metadata?.market_cap)
        ?? core.finiteNumber(coin.metadata?.usd_market_cap)
        ?? core.finiteNumber(coin.metadata?.fdv)
        ?? core.finiteNumber(trade.marketCap)
        ?? core.finiteNumber(trade.marketCapUsd)
        ?? core.finiteNumber(trade.fdv)
        ?? core.finiteNumber(row.marketCap)
        ?? core.finiteNumber(row.marketCapUsd)
        ?? core.finiteNumber(row.coinMarketCap)
        ?? core.finiteNumber(row.coinMarketCapUsd)
        ?? core.finiteNumber(row.fdv);
      return {
        id: `pump:${identity.transactionHash}:${identity.walletAddress}:${identity.tokenAddress}:${direction}`,
        platform: "pump",
        type: direction,
        createdAt,
        tokenAddress: identity.tokenAddress,
        networkId,
        transactionHash: identity.transactionHash,
        walletAddress: identity.walletAddress,
        userId: typeof author.userId === "string" ? author.userId.trim() : "",
        displayName: author.userName || author.username || row.userName || identity.walletAddress || "Pump trader",
        userHandle: author.xUsername || row.xUsername || "",
        profilePictureLink: core.safeHttpsUrl(author.profileImage || author.avatarUrl || row.profileImage),
        tokenSymbol: row.coinSymbol
          || row.tokenSymbol
          || row.symbol
          || coin.symbol
          || coin.tokenSymbol
          || coin.metadata?.symbol
          || trade.coinSymbol
          || trade.tokenSymbol
          || trade.symbol
          || "",
        tokenName: row.coinName || coin.name || "",
        tokenImageUrl: core.safeTokenImageUrl(
          row.coinImage || row.coinImageUrl || coin.imageUri || coin.image_uri || coin.image,
        ),
        usdAmount: core.finiteNumber(
          trade.amountUsd ?? trade.usdAmount ?? row.amountUsd ?? row.tradeAmountUsd,
        ),
        baseAmount: core.finiteNumber(
          trade.tokenAmount ?? trade.coinAmount ?? trade.baseAmount ?? trade.amountToken,
        ),
        quoteAmount: core.finiteNumber(trade.quoteAmount ?? row.quoteAmount),
        quoteAddress: tokenAddressForNetwork(
          trade.quoteAddress ?? trade.quoteMint ?? row.quoteAddress, networkId,
        ),
        quoteSymbol: typeof (trade.quoteSymbol ?? row.quoteSymbol) === "string"
          ? (trade.quoteSymbol ?? row.quoteSymbol).trim() : "",
        priceUsdAtTrade: core.finiteNumber(
          trade.priceUsdAtTrade ?? trade.tokenPriceUsdAtTrade ?? trade.priceUsd,
        ),
        totalSupply: totalSupplyAtTrade ?? coinTotalSupply(coin) ?? coinTotalSupply(row),
        totalSupplyAtTrade,
        marketCap: marketCapAtTrade ?? metadataMarketCap,
        marketCapAtTrade,
        isDev: Boolean(row.isDev || author.isDev),
        sourceVerification: typeof row.sourceVerification === "string"
          ? row.sourceVerification
          : PUMP_ALERTS_REST_VERIFICATION,
      };
    }).filter(Boolean).slice(0, FOLLOWED_TRADES_LIMIT);
  }

  function sanitizeRealtimeAlertTrade(event, minTradeAmountUsd = FOLLOWED_TRADES_MIN_USD, onRejected) {
    const reject = (reason) => { onRejected?.(reason); return null; };
    if (!event || typeof event !== "object") return reject("invalid-event");
    if (event.kind !== "trade") return reject("non-trade");
    if (typeof event.id !== "string" || !event.id.trim()) return reject("missing-id");
    if (event.stub) return reject("stub");
    const trade = event.trade && typeof event.trade === "object" ? event.trade : null;
    const author = event.author && typeof event.author === "object" ? event.author : null;
    const coin = event.coin && typeof event.coin === "object" ? event.coin : null;
    if (!trade || !author || !coin) return reject("missing-trade-author-coin");
    const networkId = typeof coin.chainId === "number" || typeof coin.chainId === "string"
      ? Number(coin.chainId)
      : null;
    if (!Object.values(core.TOKEN_NETWORK_IDS).includes(networkId)) return reject("unsupported-chain");
    // Validate against the declared chain before the REST parser infers Solana from a mint.
    const tokenAddress = core.normalizeWalletAddress(coin.mint, networkId);
    if (!tokenAddress) return reject("invalid-trade-fields");
    const minimum = core.finiteNumber(minTradeAmountUsd);
    const amountUsd = core.finiteNumber(trade.amountUsd);
    if (minimum !== null && amountUsd === null) return reject("missing-usd-amount");
    if (minimum !== null && amountUsd < minimum) return reject("below-minimum-usd");
    const [item] = sanitizeFollowedTrades({ items: [{
      kind: "trade",
      createdAt: event.createdAt,
      walletAddress: author.walletAddress,
      coinMint: tokenAddress,
      chainId: networkId,
      coin,
      marketCap: event.marketCap,
      coinImage: coin.imageUri,
      symbol: coin.symbol,
      author: {
        userId: author.userId,
        userName: author.userName,
        profileImage: author.profileImage,
        walletAddress: author.walletAddress,
        isVerified: author.isVerified,
      },
      trade: {
        ...trade,
        tx: trade.tx,
        isBuy: trade.isBuy,
        timestamp: event.createdAt,
        baseAmount: trade.baseAmount,
        amountUsd: trade.amountUsd,
        priceUsd: trade.priceUsd,
      },
      sourceVerification: PUMP_ALERTS_NATS_VERIFICATION,
    }] });
    return item ? { ...item, pumpEventId: event.id.trim() } : reject("invalid-trade-fields");
  }

  function withRealtimeMarketSnapshots(
    items,
    capturedAt = Date.now(),
    maxAgeMs = REALTIME_MARKET_SNAPSHOT_MAX_AGE_MS,
  ) {
    const observedAt = core.finiteNumber(capturedAt);
    const maximumAge = core.finiteNumber(maxAgeMs);
    if (observedAt === null || maximumAge === null || maximumAge < 0) {
      return Array.isArray(items) ? items : [];
    }
    const positive = (value) => {
      const number = core.finiteNumber(value);
      return number !== null && number > 0 ? number : null;
    };
    return (Array.isArray(items) ? items : []).map((item) => {
      const createdAt = core.finiteNumber(item?.createdAt);
      const ageMs = createdAt === null ? Infinity : observedAt - createdAt;
      if (item?.platform !== "pump" || ageMs < -5_000 || ageMs > maximumAge) return item;

      const marketCapAtTrade = positive(item.marketCapAtTrade);
      const priceUsdAtTrade = positive(item.priceUsdAtTrade);
      const totalSupplyAtTrade = positive(item.totalSupplyAtTrade);
      const marketCapSnapshot = positive(item.marketCapSnapshot)
        ?? marketCapAtTrade
        ?? positive(item.marketCap);
      const totalSupplySnapshot = positive(item.totalSupplySnapshot)
        ?? totalSupplyAtTrade
        ?? positive(item.totalSupply);
      const priceUsdSnapshot = positive(item.priceUsdSnapshot)
        ?? priceUsdAtTrade
        ?? (marketCapSnapshot !== null && totalSupplySnapshot !== null
          ? marketCapSnapshot / totalSupplySnapshot
          : null);
      if (marketCapSnapshot === null && priceUsdSnapshot === null) return item;

      const explicitTradeSnapshot = marketCapAtTrade !== null || priceUsdAtTrade !== null;
      return {
        ...item,
        marketCapSnapshot,
        priceUsdSnapshot,
        totalSupplySnapshot,
        marketSnapshotCapturedAt: positive(item.marketSnapshotCapturedAt) ?? observedAt,
        marketSnapshotSource: item.marketSnapshotSource
          || (explicitTradeSnapshot ? "pump-explicit-at-trade" : "pump-realtime-observed"),
      };
    });
  }

  function mergeHolderItems(fomoItems, pumpItems) {
    return [
      ...(Array.isArray(fomoItems) ? fomoItems : []),
      ...(Array.isArray(pumpItems) ? pumpItems : []),
    ].sort((left, right) => {
      const leftValue = core.finiteNumber(left?.value);
      const rightValue = core.finiteNumber(right?.value);
      if (leftValue === null && rightValue === null) return 0;
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;
      return rightValue - leftValue;
    });
  }

  return {
    POSITIONS_ORIGIN,
    PROFILE_ORIGIN,
    SOLANA_RPC_ORIGIN,
    POSITION_LIMIT,
    FOLLOWED_TRADES_LIMIT,
    FOLLOWED_TRADES_MAX_PAGES,
    FOLLOWED_TRADES_MIN_USD,
    PROFILE_TRANSACTIONS_MAX_PAGES,
    REALTIME_MARKET_SNAPSHOT_MAX_AGE_MS,
    WRAPPED_SOL_MINT,
    SOLANA_USDC_MINT,
    SOLANA_USDT_MINT,
    PUMP_CHAIN_RPC_VERIFICATION,
    PUMP_ALERTS_REST_VERIFICATION,
    PUMP_ALERTS_NATS_VERIFICATION,
    parseCoreNatsConfig,
    buildAccountBalanceSubject,
    accountBalanceSubjectWallet,
    buildPositionsRequest,
    buildUserRequest,
    buildProfileUrl,
    buildFollowedTradesRequest,
    buildPresenceRequest,
    buildPresenceDeleteRequest,
    sanitizeAlertsSubject,
    presenceUserId,
    presenceRefreshMs,
    buildFollowingRequest,
    buildFollowMutationRequest,
    sanitizeFollowing,
    withUserWallets,
    buildProfileTransactionsRequest,
    profileTransactionsNextCursor,
    profileTransactions,
    buildCoinRequest,
    buildSolPriceRequest,
    sanitizeSolPrice,
    buildSolanaTransactionsRequest,
    buildEvmTransactionsRequest,
    EVM_SYMBOL_DATA,
    buildEvmTokenSymbolRequests,
    decodeEvmTokenSymbol,
    followedTradesNextCursor,
    sanitizeUserWallet,
    sanitizePositions,
    sanitizeFollowedTrades,
    sanitizeRealtimeAlertTrade,
    withRealtimeMarketSnapshots,
    sanitizeProfileSwaps,
    profileTransferGroups,
    isProfileRpcCandidate,
    sanitizeSolanaRpcTrade,
    sanitizeEvmRpcTrade,
    withCoinMetadata,
    mergeHolderItems,
  };
});
