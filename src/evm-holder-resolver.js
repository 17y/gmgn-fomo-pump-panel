(function exposeEvmHolderResolver(root, factory) {
  const core = root.GmgnFomoCore || (typeof require === "function" ? require("./core") : null);
  const api = factory(core);
  root.GmgnEvmHolderResolver = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis, function createEvmHolderResolver(core) {
  "use strict";

  if (!core) throw new Error("GmgnFomoCore is required");

  const FOMO_SETTLEMENT = "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f";
  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const DECIMALS_DATA = "0x313ce567";
  const BALANCE_OF_SELECTOR = "0x70a08231";
  const EIP7702_PREFIX = "0xef0100";
  const TRADE_LOG_RADIUS_BLOCKS = 4_999n;
  const MIN_LOG_RANGE = 5_000n;
  const MAX_CANDIDATES = 800;
  const MAX_HOLDER_PAGES = 20;
  const RPC_CONFIG = new Map([
    [999, { url: "https://rpc.hyperliquid.xyz/evm" }],
    [1, { url: "https://ethereum-rpc.publicnode.com", blockTimeMs: 12_000 }],
    [56, {
      url: "https://rpc-bsc.blockmachine.io",
      fallbackUrls: ["https://bsc.drpc.org", "https://bsc-rpc.publicnode.com"],
      blockTimeMs: 450,
      maxLogBlocks: 10_000n,
    }],
    [8453, { url: "https://mainnet.base.org/", blockTimeMs: 2_000 }],
    [4663, {
      url: "https://rpc.mainnet.chain.robinhood.com",
      holderApi: "https://robinhoodchain.blockscout.com/api/v2",
    }],
  ]);

  function configFor(networkId) {
    return RPC_CONFIG.get(Number(networkId)) || null;
  }

  function isSupported(networkId) {
    return Boolean(configFor(networkId));
  }

  function rpcQuantity(value) {
    try {
      const quantity = typeof value === "bigint" ? value : BigInt(value);
      return quantity >= 0n ? `0x${quantity.toString(16)}` : null;
    } catch {
      return null;
    }
  }

  function parseRpcQuantity(value) {
    if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }

  function tradeLogRange(centerBlock, tip) {
    if (typeof centerBlock !== "bigint" || typeof tip !== "bigint"
      || centerBlock < 0n || tip < 0n || centerBlock > tip) {
      throw new Error("INVALID_EVM_TRADE_LOG_RANGE");
    }
    return {
      fromBlock: centerBlock > TRADE_LOG_RADIUS_BLOCKS
        ? centerBlock - TRADE_LOG_RADIUS_BLOCKS
        : 0n,
      toBlock: centerBlock + TRADE_LOG_RADIUS_BLOCKS < tip
        ? centerBlock + TRADE_LOG_RADIUS_BLOCKS
        : tip,
    };
  }

  function estimatedBlockAtTimestamp(networkId, tip, timestampMs, nowMs = Date.now()) {
    const blockTimeMs = configFor(networkId)?.blockTimeMs;
    if (!Number.isFinite(blockTimeMs) || blockTimeMs <= 0
      || typeof tip !== "bigint" || tip < 0n
      || !Number.isFinite(timestampMs) || timestampMs <= 0
      || !Number.isFinite(nowMs) || nowMs <= 0) {
      return null;
    }
    const blocksAgo = BigInt(Math.round(Math.max(0, nowMs - timestampMs) / blockTimeMs));
    return blocksAgo < tip ? tip - blocksAgo : 0n;
  }

  function rpcEndpointCount(networkId) {
    const config = configFor(networkId);
    return config ? 1 + (config.fallbackUrls?.length || 0) : 0;
  }

  function buildRpcRequest(networkId, payload, timeoutMs = 8_000, endpointIndex = 0) {
    const config = configFor(networkId);
    if (!config) throw new Error("UNSUPPORTED_EVM_CHAIN");
    const url = [config.url, ...(config.fallbackUrls || [])][endpointIndex];
    if (!url) throw new Error("UNSUPPORTED_EVM_RPC_ENDPOINT");
    return {
      url,
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs,
    };
  }

  function hasHolderApi(networkId) {
    return Boolean(configFor(networkId)?.holderApi);
  }

  function logRanges(networkId, fromBlock, toBlock) {
    const config = configFor(networkId);
    if (!config || typeof fromBlock !== "bigint" || typeof toBlock !== "bigint"
      || fromBlock < 0n || toBlock < fromBlock) {
      throw new Error("INVALID_EVM_LOG_RANGE");
    }
    const maxBlocks = config.maxLogBlocks || (toBlock - fromBlock + 1n);
    const ranges = [];
    for (let from = fromBlock; from <= toBlock; from += maxBlocks) {
      ranges.push({
        fromBlock: from,
        toBlock: from + maxBlocks - 1n < toBlock ? from + maxBlocks - 1n : toBlock,
      });
    }
    return ranges;
  }

  function buildBlockscoutRequest(params, path, query = null) {
    const config = configFor(params?.networkId);
    const token = core.normalizeWalletAddress(params?.address, params?.networkId);
    if (!config?.holderApi || !token) throw new Error("UNSUPPORTED_BLOCKSCOUT_CHAIN");
    const url = new URL(`${config.holderApi}/tokens/${encodeURIComponent(token)}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    return { url: url.toString(), method: "GET", timeoutMs: 8_000 };
  }

  function buildBlockscoutTokenRequest(params) {
    return buildBlockscoutRequest(params, "");
  }

  function buildBlockscoutHoldersRequest(params, nextPageParams = null) {
    return buildBlockscoutRequest(params, "/holders", nextPageParams);
  }

  function blockscoutTokenDecimals(payload) {
    const value = Number(payload?.decimals);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error("INVALID_TOKEN_DECIMALS");
    }
    return value;
  }

  function blockscoutHolderPage(payload, params) {
    if (!Array.isArray(payload?.items)) throw new Error("BLOCKSCOUT_HOLDERS_INVALID");
    const excluded = new Set([
      "0x0000000000000000000000000000000000000000",
      "0x000000000000000000000000000000000000dead",
      FOMO_SETTLEMENT,
      String(params.address).toLowerCase(),
    ]);
    const rows = payload.items.map((item) => {
      const account = item?.address || item?.address_hash || {};
      const address = core.normalizeWalletAddress(account.hash, params.networkId);
      const balanceRaw = typeof item?.value === "string" && /^\d+$/.test(item.value)
        ? BigInt(item.value).toString()
        : null;
      if (!address || balanceRaw === null) throw new Error("BLOCKSCOUT_HOLDERS_INVALID");
      return {
        address,
        balanceRaw,
        isWallet: !excluded.has(address)
          && (!account.is_contract || String(account.proxy_type).toLowerCase() === "eip7702"),
      };
    });
    const nextPageParams = payload.next_page_params && typeof payload.next_page_params === "object"
      ? payload.next_page_params
      : null;
    return { rows, nextPageParams };
  }

  function topicAddress(address, networkId) {
    const normalized = core.normalizeWalletAddress(address, networkId);
    return normalized ? `0x${normalized.slice(2).padStart(64, "0")}` : null;
  }

  function logFilters(params, fromBlock, toBlock) {
    const token = core.normalizeWalletAddress(params?.address, params?.networkId);
    const settlement = topicAddress(FOMO_SETTLEMENT, params?.networkId);
    const from = rpcQuantity(fromBlock);
    const to = rpcQuantity(toBlock);
    if (!token || !settlement || !from || !to) throw new Error("INVALID_EVM_LOG_FILTER");
    return [{
      address: token,
      fromBlock: from,
      toBlock: to,
      topics: [TRANSFER_TOPIC, settlement],
    }, {
      address: token,
      fromBlock: from,
      toBlock: to,
      topics: [TRANSFER_TOPIC, null, settlement],
    }];
  }

  function topicWallet(value, networkId) {
    if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) return "";
    return core.normalizeWalletAddress(`0x${value.slice(-40)}`, networkId);
  }

  function candidateAddresses(buyLogs, sellLogs, params) {
    const excluded = new Set([
      "0x0000000000000000000000000000000000000000",
      FOMO_SETTLEMENT,
      String(params.address).toLowerCase(),
    ]);
    const candidates = new Set();
    for (const log of Array.isArray(buyLogs) ? buyLogs : []) {
      const address = topicWallet(log?.topics?.[2], params.networkId);
      if (address && !excluded.has(address)) candidates.add(address);
    }
    for (const log of Array.isArray(sellLogs) ? sellLogs : []) {
      const address = topicWallet(log?.topics?.[1], params.networkId);
      if (address && !excluded.has(address)) candidates.add(address);
    }
    return [...candidates];
  }

  function balanceOfData(address, networkId) {
    const topic = topicAddress(address, networkId);
    if (!topic) throw new Error("INVALID_EVM_WALLET");
    return `${BALANCE_OF_SELECTOR}${topic.slice(2)}`;
  }

  function tokenDecimals(value) {
    const parsed = parseRpcQuantity(value);
    if (parsed === null || parsed > 255n) throw new Error("INVALID_TOKEN_DECIMALS");
    return Number(parsed);
  }

  function classifyWalletCode(value) {
    if (value === "0x") return "eoa";
    if (typeof value === "string"
      && value.length === EIP7702_PREFIX.length + 40
      && value.toLowerCase().startsWith(EIP7702_PREFIX)
      && /^[0-9a-f]+$/i.test(value.slice(2))) {
      return "eip7702";
    }
    return "contract";
  }

  function balanceRequests(params, addresses, blockTag) {
    const token = core.normalizeWalletAddress(params?.address, params?.networkId);
    if (!token || typeof blockTag !== "string") throw new Error("INVALID_EVM_BALANCE_REQUEST");
    return addresses.map((address, index) => ({
      jsonrpc: "2.0",
      id: index + 1,
      method: "eth_call",
      params: [{ to: token, data: balanceOfData(address, params.networkId) }, blockTag],
    }));
  }

  function uniqueBalanceMatch(addresses, responses, targetRawAmount, tolerancePpm = 0) {
    let target;
    try {
      target = BigInt(targetRawAmount);
    } catch {
      throw new Error("INVALID_TARGET_BALANCE");
    }
    if (!Array.isArray(responses) || responses.length !== addresses.length) {
      throw new Error("EVM_BALANCE_RESPONSE_INCOMPLETE");
    }
    const byId = new Map(responses.map((response) => [Number(response?.id), response]));
    const balances = [];
    for (let index = 0; index < addresses.length; index += 1) {
      const response = byId.get(index + 1);
      const balance = parseRpcQuantity(response?.result);
      if (response?.error || balance === null) throw new Error("EVM_BALANCE_RESPONSE_INVALID");
      balances.push({ address: addresses[index], balance });
    }
    const exactMatches = balances
      .filter((row) => row.balance === target)
      .map((row) => row.address);
    if (exactMatches.length === 1) return exactMatches[0];
    if (exactMatches.length > 1) throw new Error("HOLDER_CHAIN_DATA_AMBIGUOUS");

    const matches = tolerancePpm > 0 && target > 0n
      ? balances.filter((row) => {
        const difference = row.balance > target
          ? row.balance - target
          : target - row.balance;
        return difference * 1_000_000n <= target * BigInt(tolerancePpm);
      }).map((row) => row.address)
      : [];
    if (!matches.length) throw new Error("HOLDER_CHAIN_DATA_NOT_FOUND");
    if (matches.length !== 1) throw new Error("HOLDER_CHAIN_DATA_AMBIGUOUS");
    return matches[0];
  }

  return {
    FOMO_SETTLEMENT,
    DECIMALS_DATA,
    TRADE_LOG_RADIUS_BLOCKS,
    MIN_LOG_RANGE,
    MAX_CANDIDATES,
    MAX_HOLDER_PAGES,
    isSupported,
    hasHolderApi,
    logRanges,
    rpcQuantity,
    parseRpcQuantity,
    tradeLogRange,
    estimatedBlockAtTimestamp,
    rpcEndpointCount,
    buildRpcRequest,
    buildBlockscoutTokenRequest,
    buildBlockscoutHoldersRequest,
    blockscoutTokenDecimals,
    blockscoutHolderPage,
    logFilters,
    candidateAddresses,
    tokenDecimals,
    classifyWalletCode,
    balanceRequests,
    uniqueBalanceMatch,
  };
});
