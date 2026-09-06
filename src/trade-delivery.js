(function exposeTradeDelivery(root, factory) {
  const api = factory();
  root.GmgnTradeDelivery = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis, function createTradeDelivery() {
  "use strict";

  // One timer for all ports. No timer or page work when there are no deliveries.
  function create({ keyOf, now = Date.now, schedule = setTimeout, cancel = clearTimeout,
    onResult = () => {}, limit = 128, maxAgeMs = 60_000 } = {}) {
    const records = new Map();
    const ports = new Map();
    const offsets = [0, 6_000, 14_000];
    let timer = null;
    let sequence = 0;
    const stats = { sent: 0, acknowledged: 0, failed: 0, unverified: 0 };

    function result(stage, record, detail) {
      onResult(stage, record.item, { transport: record.transport, ...detail });
    }
    function finish(state, ticket, status, detail = {}) {
      if (ticket.done) return;
      ticket.done = true;
      if (status === "accepted") {
        stats.acknowledged += 1;
        ticket.record.acceptedConsumers.add(state.consumerId);
      }
      else if (status === "unverified") stats.unverified += 1;
      else stats.failed += 1;
      result(status === "accepted" ? "gmgn-event-ack" : status === "unverified" ? "gmgn-event-unverified" : "gmgn-event-failed",
        ticket.record, { error: status === "accepted" ? "" : status, consumerId: state.consumerId, ...detail });
      if (status === "accepted" && detail.reason === "ROW_RENDERED") {
        result("gmgn-row-rendered", ticket.record, { consumerId: state.consumerId });
      }
    }
    function expire(record, reason) {
      if (!ports.size && !record.acceptedConsumers.size) {
        result("gmgn-event-failed", record, { error: reason });
      }
      for (const [port, state] of ports) {
        const ticket = state.get(record.key);
        if (ticket && reason === "CANCELLED") {
          try { port.postMessage({ type: "gmgnFollowTradeCancel", deliveryId: ticket.deliveryId }); } catch {}
        }
        if (ticket) finish(state, ticket, reason);
        state.delete(record.key);
      }
      records.delete(record.key);
    }
    function prune() {
      for (const record of records.values()) {
        if (record.expiresAt <= now()) expire(record, "EVENT_EXPIRED");
      }
    }
    function attach(state, record) {
      if (state.has(record.key) || record.acceptedConsumers.has(state.consumerId)) return;
      state.set(record.key, { record, deliveryId: `delivery-${now()}-${++sequence}`,
        startedAt: now(), attempt: 0, done: false });
    }
    function flush() {
      if (timer !== null) cancel(timer);
      timer = null;
      prune();
      let nextAt = Infinity;
      for (const [port, state] of ports) {
        for (const ticket of state.values()) {
          if (ticket.done) continue;
          const deadline = Math.min(ticket.record.expiresAt, ticket.startedAt + 20_000);
          if (now() >= deadline) {
            finish(state, ticket, "ACK_TIMEOUT");
            continue;
          }
          const due = ticket.startedAt + (offsets[ticket.attempt] ?? 20_000);
          if (ticket.attempt < offsets.length && now() >= due) {
            ticket.attempt += 1;
            try {
              port.postMessage({ type: "gmgnFollowTradeEvent", item: ticket.record.item,
                deliveryId: ticket.deliveryId });
              stats.sent += 1;
              result("gmgn-event-broadcast", ticket.record, { count: 1,
                gmgnSubscriberCount: ports.size, consumerId: state.consumerId, attempt: ticket.attempt });
            } catch {
              finish(state, ticket, "PORT_DISCONNECTED");
              ports.delete(port);
              break;
            }
          }
          if (!ticket.done) nextAt = Math.min(nextAt, deadline,
            ticket.startedAt + (offsets[ticket.attempt] ?? 20_000));
        }
      }
      if (Number.isFinite(nextAt)) timer = schedule(flush, Math.max(1, nextAt - now()));
    }
    return {
      addPort(port, consumerId = port) {
        prune();
        const state = new Map();
        state.consumerId = consumerId;
        ports.set(port, state);
        for (const record of records.values()) attach(state, record);
        flush();
      },
      removePort(port) {
        const state = ports.get(port);
        for (const ticket of state?.values() || []) {
          if (!ticket.done) result("gmgn-page-rejected", ticket.record, {
            error: "PORT_DISCONNECTED", consumerId: state.consumerId,
          });
        }
        ports.delete(port); flush();
      },
      publish(items, transport) {
        prune();
        let added = 0;
        for (const item of items || []) {
          const key = keyOf(item);
          const createdAt = Number(item?.createdAt);
          const reason = !key || !Number.isFinite(createdAt) ? "INVALID_EVENT"
            : now() - createdAt >= maxAgeMs ? "EVENT_EXPIRED"
              : createdAt - now() > 5_000 ? "FUTURE_EVENT"
                : records.has(key) ? "DUPLICATE_EVENT" : "";
          if (reason) {
            result("gmgn-event-skipped", { item, transport }, { reason });
            continue;
          }
          while (records.size >= limit) expire(records.values().next().value, "QUEUE_FULL");
          const record = { key, item, transport, acceptedConsumers: new Set(), expiresAt: Math.min(now() + maxAgeMs, createdAt + maxAgeMs) };
          records.set(key, record);
          result("gmgn-event-queued", record, { gmgnSubscriberCount: ports.size,
            reason: ports.size ? "READY" : "NO_GMGN_PORT" });
          for (const state of ports.values()) attach(state, record);
          added += 1;
        }
        flush();
        return added;
      },
      acknowledge(port, message) {
        const state = ports.get(port);
        if (!state || !["submitted", "decoded", "accepted", "unverified", "expired", "invalid", "unavailable", "overflow"].includes(message?.status)) return;
        const ticket = [...state.values()].find((value) => value.deliveryId === message.deliveryId);
        if (!ticket || ticket.done) return;
        if (["submitted", "decoded"].includes(message.status)) {
          result(message.status === "submitted" ? "gmgn-native-submitted" : "gmgn-native-decoded",
            ticket.record, { consumerId: state.consumerId });
          return;
        }
        if (message.status === "accepted" && message.reason !== "ROW_RENDERED") {
          result("gmgn-page-rejected", ticket.record, { reason: "LEGACY_ENTRY_ACK", consumerId: state.consumerId });
          return;
        }
        // Unavailable/overflow can be retried by the existing bounded schedule.
        if (["unavailable", "overflow"].includes(message.status)) {
          result("gmgn-page-rejected", ticket.record, { error: message.status,
            reason: message.reason, routeChain: message.routeChain, consumerId: state.consumerId });
          return;
        }
        finish(state, ticket, message.status, { reason: message.reason, routeChain: message.routeChain });
        flush();
      },
      metadata(items) {
        for (const item of items || []) {
          const key = keyOf(item);
          const record = records.get(key);
          if (!record) continue;
          record.item = item;
          for (const [port, state] of ports) {
            if (!state.has(key)) continue;
            try { port.postMessage({ type: "gmgnFollowTradeMetadata", item }); } catch {}
          }
        }
      },
      discard(predicate) {
        for (const record of records.values()) if (predicate(record.item)) expire(record, "CANCELLED");
        flush();
      },
      clear() {
        if (timer !== null) cancel(timer);
        timer = null;
        records.clear();
        for (const [port, state] of ports) {
          try { port.postMessage({ type: "gmgnFollowTradeReset" }); } catch {}
          state.clear();
        }
      },
      snapshot() {
        prune();
        return { ...stats, portCount: ports.size, retainedCount: records.size,
          pendingCount: [...ports.values()].reduce((n, state) => n + [...state.values()].filter((t) => !t.done).length, 0) };
      },
    };
  }
  return { create };
});
