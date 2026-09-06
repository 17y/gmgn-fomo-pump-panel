(function exposeTradeReceipts(root, factory) {
  const api = factory();
  root.GmgnTradeReceipts = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis, function createTradeReceipts() {
  "use strict";

  const STAGES = new Set([
    "fomo-rest-response", "fomo-websocket-normalized", "fomo-websocket-rejected",
    "fomo-filtered", "fomo-delivery-error", "fomo-metadata-enriched",
    "pump-source-response", "pump-collected-items", "pump-realtime-items", "pump-nats-normalized",
    "gmgn-event-queued", "gmgn-event-broadcast", "gmgn-event-ack",
    "gmgn-event-failed", "gmgn-page-rejected", "gmgn-event-skipped",
    "gmgn-native-submitted", "gmgn-native-decoded", "gmgn-row-rendered", "gmgn-event-unverified",
  ]);
  const text = (value, limit = 100) => typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, limit) : "";
  const time = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;

  function ref(item) {
    if (!["fomo", "pump"].includes(item?.platform)) return null;
    // Pump's synthesized id embeds the trader wallet. Use tx/token/side instead.
    const rawId = text(item.id, 160);
    const id = item.platform === "pump" || /0x[a-f0-9]{40}/i.test(rawId) ? "" : rawId;
    const transactionHash = text(item.transactionHash, 160);
    const tokenAddress = text(item.tokenAddress);
    const createdAt = time(item.createdAt);
    const type = ["buy", "sell"].includes(item.type) ? item.type : "";
    const networkId = Number.isInteger(Number(item.networkId)) ? Number(item.networkId) : null;
    // Never use wallet addresses, payloads, or arbitrary object serialization as keys.
    const key = id ? `${item.platform}:${id}` : transactionHash
      ? [item.platform, networkId, transactionHash, tokenAddress, type].join(":") : "";
    if (!key) return null;
    return { key, platform: item.platform, id, transactionHash, tokenAddress, networkId,
      createdAt, type, userHandle: text(item.userHandle), displayName: text(item.displayName),
      tokenSymbol: text(item.tokenSymbol), tokenName: text(item.tokenName) };
  }

  function safeDetail(detail = {}) {
    const result = {};
    for (const key of ["error", "transport", "reason", "routeChain"]) {
      // Codes only: never persist exception messages / server response text.
      const value = text(detail[key], 80);
      if (/^[a-zA-Z0-9_+:. -]{1,80}$/.test(value)) result[key] = value;
    }
    for (const key of ["gmgnSubscriberCount", "attempt", "consumerId"]) {
      if (Number.isInteger(detail[key]) && detail[key] >= 0) result[key] = detail[key];
    }
    return result;
  }

  function create({ now = Date.now, limit = 200, maxAgeMs = 30 * 60_000 } = {}) {
    let startedAt = now();
    const workerStartedAt = startedAt;
    let evictedCount = 0;
    const rows = new Map();
    const sourceEvents = [];
    function prune() {
      for (const [key, row] of rows) {
        if (now() - row.latestAt > maxAgeMs) { rows.delete(key); evictedCount += 1; }
      }
      while (rows.size > limit) { rows.delete(rows.keys().next().value); evictedCount += 1; }
      while (sourceEvents.length && now() - sourceEvents[0].at > maxAgeMs) sourceEvents.shift();
    }
    function record(stage, items, detail = {}, at = now()) {
      if (!STAGES.has(stage)) return false;
      let changed = false;
      for (const item of items || []) {
        const reference = ref(item);
        if (!reference) continue;
        // Old REST pages must not displace recent realtime receipts.
        if (reference.createdAt && now() - reference.createdAt > maxAgeMs) continue;
        const row = rows.get(reference.key) || { ...reference, firstAt: at, latestAt: at, stages: {} };
        for (const [key, value] of Object.entries(reference)) if (value !== "" && value !== null && value !== 0) row[key] = value;
        row.firstAt = Math.min(row.firstAt, at);
        row.latestAt = Math.max(row.latestAt, at);
        const previous = row.stages[stage];
        row.stages[stage] = { firstAt: Math.min(previous?.firstAt ?? at, at),
          at: Math.max(previous?.at ?? at, at), count: (previous?.count || 0) + 1,
          ...safeDetail(previous && previous.at > at ? previous : detail) };
        rows.delete(reference.key); rows.set(reference.key, row);
        changed = true;
      }
      prune();
      return changed;
    }
    function source(stage, detail = {}) {
      if (!/^(fomo|pump|gmgn)-[a-z-]{1,45}$/.test(stage)) return;
      sourceEvents.push({ at: now(), stage, ...safeDetail(detail) });
      if (sourceEvents.length > 40) sourceEvents.shift();
      prune();
    }
    function snapshot() {
      prune();
      return { version: 1, startedAt, workerStartedAt, capturedAt: now(), maxAgeMs, limit,
        evictedCount, sourceEventLimit: 40, storage: "browser-session", domVisibilityVerified: false,
        trades: [...rows.values()].sort((a, b) => b.latestAt - a.latestAt),
        sourceEvents: sourceEvents.slice() };
    }
    function restore(saved) {
      if (saved?.version !== 1 || !Array.isArray(saved.trades)) return;
      const current = [...rows.values()]; rows.clear();
      startedAt = Math.min(startedAt, time(saved.startedAt) || startedAt);
      evictedCount = Number.isInteger(saved.evictedCount) ? Math.max(0, saved.evictedCount) : 0;
      // Read session data through the same allowlist as live records.
      for (const row of [...saved.trades.slice(0, limit).reverse(), ...current]) {
        for (const [stage, entry] of Object.entries(row?.stages || {})) {
          if (time(entry?.at) && now() - entry.at <= maxAgeMs && entry.at <= now()) {
            record(stage, [row], entry, entry.at);
            const restored = rows.get(ref(row)?.key)?.stages[stage];
            if (restored) {
              restored.count += Number.isInteger(entry.count) ? Math.max(0, Math.min(100_000, entry.count) - 1) : 0;
              const firstAt = time(entry.firstAt);
              if (firstAt && firstAt <= entry.at) restored.firstAt = Math.min(restored.firstAt, firstAt);
            }
          }
        }
      }
      const liveEvents = sourceEvents.splice(0);
      for (const entry of [...(Array.isArray(saved.sourceEvents) ? saved.sourceEvents.slice(-40) : []), ...liveEvents]) {
        if (time(entry?.at) && now() - entry.at <= maxAgeMs && entry.at <= now()
          && /^(fomo|pump|gmgn)-[a-z-]{1,45}$/.test(entry.stage)) {
          sourceEvents.push({ at: entry.at, stage: entry.stage, ...safeDetail(entry) });
        }
      }
      sourceEvents.splice(0, Math.max(0, sourceEvents.length - 40));
      prune();
    }
    function clear() { rows.clear(); sourceEvents.splice(0); startedAt = now(); evictedCount = 0; }
    return { record, source, snapshot, restore, clear };
  }
  return { create };
});
