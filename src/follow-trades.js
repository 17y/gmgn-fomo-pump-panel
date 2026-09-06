(function exposeFollowTrades(root, factory) {
  const core = root.GmgnFomoCore || (typeof require === "function" ? require("./core") : null);
  const identity = root.GmgnTradeIdentity || (typeof require === "function" ? require("./trade-identity") : null);
  const api = factory(core, identity);
  root.GmgnFollowTrades = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis, function createFollowTrades(core, identity) {
  "use strict";

  if (!core) throw new Error("GmgnFomoCore is required");

  const DISPLAY_LIMIT = 100;
  const DISPLAY_METADATA_FIELDS = Object.freeze([
    "tokenSymbol",
    "tokenName",
    "tokenLogo",
    "tokenImageUrl",
    "marketCap",
    "marketCapAtTrade",
    "marketCapSnapshot",
    "marketCapSource",
    "priceUsdAtTrade",
    "priceUsdSnapshot",
    "totalSupply",
    "totalSupplyAtTrade",
    "totalSupplySnapshot",
    "marketSnapshotCapturedAt",
    "marketSnapshotSource",
    "baseAmount",
    "quoteAmount",
    "quoteAddress",
    "quoteSymbol",
    "displayName",
    "userHandle",
    "profilePictureLink",
    "sourceVerification",
    "pumpEventId",
  ]);
  const NETWORK_CHAINS = new Map(Object.entries(core.TOKEN_NETWORK_IDS).map(([chain, id]) => [id, chain]));

  function stableKey(item) {
    const pumpKey = identity?.pumpKey(item);
    if (pumpKey) return pumpKey;
    const transactionHash = typeof item?.transactionHash === "string"
      ? item.transactionHash.trim().toLowerCase()
      : "";
    if (item?.platform === "fomo" && transactionHash) {
      const tokenAddress = typeof item?.tokenAddress === "string"
        ? item.tokenAddress.trim().toLowerCase()
        : "";
      return ["fomo", "tx", item.networkId, transactionHash, tokenAddress, item.type].join(":");
    }
    if (typeof item?.id === "string" && item.id) return `${item.platform}:${item.id}`;
    return [
      item?.platform,
      item?.transactionHash,
      item?.walletAddress,
      item?.tokenAddress,
      item?.type,
      item?.createdAt,
    ].join(":");
  }

  function mergeFollowedTrades(...sources) {
    const byId = new Map();
    let sourceIndex = 0;
    for (const item of sources.flatMap((source) => Array.isArray(source) ? source : [])) {
      const createdAt = core.finiteNumber(item?.createdAt);
      if (!item || !["fomo", "pump"].includes(item.platform)
        || !["buy", "sell"].includes(item.type) || createdAt === null) continue;
      const key = stableKey(item);
      const first = byId.get(key);
      if (!first) {
        byId.set(key, {
          item: { ...item, createdAt },
          sourceIndex,
        });
      } else {
        for (const field of DISPLAY_METADATA_FIELDS) {
          if ((first.item[field] === null || first.item[field] === undefined || first.item[field] === "")
            && item[field] !== null && item[field] !== undefined && item[field] !== "") {
            first.item[field] = item[field];
          }
        }
      }
      sourceIndex += 1;
    }
    const countsByNetwork = new Map();
    return [...byId.values()]
      .sort((left, right) => (
        right.item.createdAt - left.item.createdAt || left.sourceIndex - right.sourceIndex
      ))
      .filter(({ item }) => {
        const networkId = Number(item.networkId);
        const chain = typeof item.chain === "string" ? item.chain.trim().toLowerCase() : "";
        const network = Number.isInteger(networkId) && networkId > 0
          ? `network:${networkId}`
          : `chain:${chain || "unknown"}`;
        const count = countsByNetwork.get(network) || 0;
        if (count >= DISPLAY_LIMIT) return false;
        countsByNetwork.set(network, count + 1);
        return true;
      })
      .map(({ item }) => item);
  }

  function pruneFollowedTrades(items, networkIds, cutoffMs) {
    const activeNetworks = new Set((Array.isArray(networkIds) ? networkIds : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0));
    const cutoff = core.finiteNumber(cutoffMs);
    const merged = mergeFollowedTrades(items);
    if (!activeNetworks.size || cutoff === null) return merged;
    return merged.filter((item) => (
      !activeNetworks.has(Number(item.networkId)) || item.createdAt >= cutoff
    ));
  }

  function gmgnTokenUrl(item, origin = "https://gmgn.ai") {
    const chain = NETWORK_CHAINS.get(Number(item?.networkId));
    if (!chain || !core.validTokenAddress(item?.tokenAddress)) return "";
    return `${origin}/${chain}/token/${encodeURIComponent(item.tokenAddress)}`;
  }

  return {
    DISPLAY_LIMIT,
    stableKey,
    mergeFollowedTrades,
    pruneFollowedTrades,
    gmgnTokenUrl,
  };
});
