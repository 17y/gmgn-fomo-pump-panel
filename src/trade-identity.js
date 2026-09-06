(function exposeTradeIdentity(root, factory) {
  const api = factory();
  root.GmgnTradeIdentity = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis, function createTradeIdentity() {
  "use strict";
  const text = (value) => typeof value === "string" ? value.trim() : "";
  function pumpKey(item) {
    if (item?.platform !== "pump") return "";
    const sol = Number(item.networkId) === 1399811149;
    const address = (value) => sol ? text(value) : text(value).toLowerCase();
    const tx = address(item.transactionHash);
    // REST has no NATS event id. Both sources do have transaction + maker +
    // token + side. Preserve Solana case and distinct makers in one transaction.
    if (tx && text(item.walletAddress) && text(item.tokenAddress) && Number(item.networkId) > 0) return ["pump", "tx", Number(item.networkId) || "", tx,
      address(item.walletAddress), address(item.tokenAddress), item.type || ""].join(":");
    const eventId = text(item.pumpEventId);
    return eventId ? `pump:event:${eventId}` : "";
  }
  return { pumpKey };
});
