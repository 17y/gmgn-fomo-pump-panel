(function startOffscreenDocument() {
  "use strict";

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const NATS_RECONNECT_MIN_MS = 1_000;
  const NATS_RECONNECT_MAX_MS = 30_000;
  const NATS_MAX_HEADER_BYTES = 4_096;
  const NATS_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
  const NATS_MAX_PENDING_BYTES = NATS_MAX_HEADER_BYTES + NATS_MAX_PAYLOAD_BYTES + 4;
  const NATS_READ_CHUNK_BYTES = 64 * 1024;
  let pumpNatsConfig = null;
  let pumpNatsConnectionKey = "";
  let pumpNatsSocket = null;
  let pumpNatsGeneration = 0;
  let pumpNatsReconnectTimer = null;
  let pumpNatsReconnectAttempts = 0;
  let pumpNatsPingTimer = null;
  let pumpNatsConnectTimer = null;
  let pumpNatsConnected = false;
  let pumpNatsReceiveBuffer = new Uint8Array();
  let pumpNatsSidCounter = 0;
  const pumpNatsDesiredSubjects = new Set();
  const pumpNatsSidBySubject = new Map();
  let pumpDiagnosticsEnabled = false;
  let pumpDiagnostics = {};

  function setPumpDiagnosticsEnabled(enabled) {
    if (globalThis.GmgnRuntimeConfig?.localDiagnostics !== true) enabled = false;
    if (enabled === pumpDiagnosticsEnabled) return;
    pumpDiagnosticsEnabled = enabled;
    pumpDiagnostics = enabled ? { startedAt: Date.now() } : {};
  }

  function countPumpDiagnostic(key) {
    if (pumpDiagnosticsEnabled) pumpDiagnostics[key] = (pumpDiagnostics[key] || 0) + 1;
  }

  function forwardPumpAlert(event) {
    const diagnosticWindow = pumpDiagnostics;
    const countResult = (key) => {
      if (diagnosticWindow === pumpDiagnostics) countPumpDiagnostic(key);
    };
    countPumpDiagnostic("forwarded");
    chrome.runtime.sendMessage({ type: "pumpNatsAlertEvent", event }).then((response) => {
      countResult(response?.accepted === true ? "backgroundAccepted"
        : response?.ok === true ? "backgroundRejected" : "backgroundUnconfirmed");
    }).catch(() => countResult("forwardFailed"));
  }

  function validPumpNatsSubject(value) {
    return typeof value === "string"
      && /^alertsFeed\.user\.[A-Za-z0-9_-]{1,128}\.(?:[A-Za-z0-9_-]{1,128}|\*)$/.test(value);
  }

  function normalizePumpNatsConfig(value) {
    let server;
    try {
      server = new URL(value?.server);
    } catch {
      return null;
    }
    if (server.protocol !== "wss:"
      || !/(?:^|\.)nats\.realtime\.pump\.fun$/.test(server.hostname)) return null;
    const credential = (item) => (
      typeof item === "string" && item.length > 0 && item.length <= 256 ? item : ""
    );
    const user = credential(value.user);
    const pass = credential(value.pass);
    const token = credential(value.token);
    if ((!user || !pass) && !token) return null;
    const pingInterval = Number(value.pingInterval);
    const timeout = Number(value.timeout);
    return {
      server: server.toString().replace(/\/$/, ""),
      user,
      pass,
      token,
      pingInterval: Number.isFinite(pingInterval)
        ? Math.max(1_000, Math.min(60_000, Math.trunc(pingInterval)))
        : 10_000,
      timeout: Number.isFinite(timeout)
        ? Math.max(1_000, Math.min(30_000, Math.trunc(timeout)))
        : 5_000,
    };
  }

  function pumpNatsNotify(message) {
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  function pumpNatsStatus(status) {
    pumpNatsNotify({ type: "pumpNatsStatus", status });
  }

  function pumpNatsSend(value) {
    if (pumpNatsSocket?.readyState === WebSocket.OPEN) pumpNatsSocket.send(value);
  }

  function clearPumpNatsReconnectTimer() {
    if (pumpNatsReconnectTimer !== null) clearTimeout(pumpNatsReconnectTimer);
    pumpNatsReconnectTimer = null;
  }

  function clearPumpNatsPingTimer() {
    if (pumpNatsPingTimer !== null) clearInterval(pumpNatsPingTimer);
    pumpNatsPingTimer = null;
  }

  function clearPumpNatsConnectTimer() {
    if (pumpNatsConnectTimer !== null) clearTimeout(pumpNatsConnectTimer);
    pumpNatsConnectTimer = null;
  }

  function closePumpNatsSocket() {
    clearPumpNatsReconnectTimer();
    clearPumpNatsPingTimer();
    clearPumpNatsConnectTimer();
    pumpNatsGeneration += 1;
    const socket = pumpNatsSocket;
    pumpNatsSocket = null;
    pumpNatsConnected = false;
    pumpNatsReceiveBuffer = new Uint8Array();
    pumpNatsSidBySubject.clear();
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try { socket.close(); } catch {}
  }

  function pumpNatsUnsubscribe(subject) {
    const sid = pumpNatsSidBySubject.get(subject);
    if (!sid) return;
    pumpNatsSidBySubject.delete(subject);
    pumpNatsSend(`UNSUB ${sid}\r\n`);
  }

  function syncPumpNatsSubjects() {
    for (const subject of pumpNatsSidBySubject.keys()) {
      if (!pumpNatsDesiredSubjects.has(subject)) pumpNatsUnsubscribe(subject);
    }
    if (!pumpNatsConnected) return;
    for (const subject of pumpNatsDesiredSubjects) {
      if (pumpNatsSidBySubject.has(subject)) continue;
      const sid = ++pumpNatsSidCounter;
      pumpNatsSidBySubject.set(subject, sid);
      pumpNatsSend(`SUB ${subject} ${sid}\r\n`);
    }
  }

  function schedulePumpNatsReconnect() {
    if (!pumpNatsConfig || !pumpNatsDesiredSubjects.size || pumpNatsReconnectTimer !== null) return;
    const delay = Math.min(
      NATS_RECONNECT_MIN_MS * (2 ** Math.min(pumpNatsReconnectAttempts, 5)),
      NATS_RECONNECT_MAX_MS,
    );
    pumpNatsReconnectAttempts += 1;
    pumpNatsReconnectTimer = setTimeout(() => {
      pumpNatsReconnectTimer = null;
      connectPumpNats();
    }, delay);
  }

  function handlePumpNatsLine(line) {
    if (line.startsWith("INFO ")) {
      const connect = {
        verbose: false,
        pedantic: false,
        tls_required: true,
        lang: "javascript",
        version: "1.0.0",
        protocol: 1,
        ...(pumpNatsConfig.user ? { user: pumpNatsConfig.user } : {}),
        ...(pumpNatsConfig.pass ? { pass: pumpNatsConfig.pass } : {}),
        ...(pumpNatsConfig.token ? { auth_token: pumpNatsConfig.token } : {}),
      };
      pumpNatsSend(`CONNECT ${JSON.stringify(connect)}\r\nPING\r\n`);
      return;
    }
    if (line === "PING") {
      countPumpDiagnostic("serverPings");
      pumpNatsSend("PONG\r\n");
      return;
    }
    if (line === "PONG") countPumpDiagnostic("serverPongs");
    if (line === "PONG" && !pumpNatsConnected) {
      pumpNatsConnected = true;
      pumpNatsReconnectAttempts = 0;
      clearPumpNatsConnectTimer();
      syncPumpNatsSubjects();
      clearPumpNatsPingTimer();
      pumpNatsPingTimer = setInterval(
        () => pumpNatsSend("PING\r\n"),
        pumpNatsConfig.pingInterval,
      );
      pumpNatsStatus("connected");
      return;
    }
    if (line.startsWith("-ERR")) {
      countPumpDiagnostic("serverErrors");
      try { pumpNatsSocket?.close(); } catch {}
    }
  }

  function appendPumpNatsBytes(bytes) {
    const generation = pumpNatsGeneration;
    for (let offset = 0; offset < bytes.length;) {
      const pending = pumpNatsReceiveBuffer;
      const count = Math.min(bytes.length - offset, NATS_READ_CHUNK_BYTES,
        NATS_MAX_PENDING_BYTES - pending.length);
      if (!count) {
        rejectPumpNatsFrame();
        return;
      }
      const chunk = bytes.subarray(offset, offset + count);
      if (!pending.length) {
        // WebSocket ArrayBuffers are already owned by this receiver.
        pumpNatsReceiveBuffer = chunk;
      } else {
        const length = pending.length + count;
        const capacity = pending.buffer.byteLength - pending.byteOffset;
        const next = capacity >= length
          ? new Uint8Array(pending.buffer, pending.byteOffset, length)
          : new Uint8Array(Math.min(NATS_MAX_PENDING_BYTES, Math.max(length, pending.length * 2)));
        if (capacity < length) next.set(pending);
        next.set(chunk, pending.length);
        pumpNatsReceiveBuffer = next.subarray(0, length);
      }
      offset += count;
      drainPumpNatsBuffer();
      if (generation !== pumpNatsGeneration) return;
    }
    const pending = pumpNatsReceiveBuffer;
    if (pending.length && (pending.byteOffset > 0
      || pending.buffer.byteLength > Math.max(NATS_READ_CHUNK_BYTES, pending.length * 2))) {
      pumpNatsReceiveBuffer = pending.slice();
    }
  }

  function rejectPumpNatsFrame() {
    countPumpDiagnostic("invalidFrames");
    // Clear pending bytes immediately and invalidate queued decoder callbacks.
    closePumpNatsSocket();
    pumpNatsStatus("disconnected");
    schedulePumpNatsReconnect();
  }

  function pumpNatsAlertForSubject(subject, payloadBytes) {
    if (!validPumpNatsSubject(subject) || subject.endsWith(".*")) {
      countPumpDiagnostic("subjectRejected");
      return null;
    }
    // NATS publishes a concrete subject even when presence asks us to subscribe
    // to alertsFeed.user.<userId>.*. Match that last token without widening users.
    const wildcard = `${subject.slice(0, subject.lastIndexOf(".") + 1)}*`;
    if (!pumpNatsDesiredSubjects.has(subject) && !pumpNatsDesiredSubjects.has(wildcard)) {
      countPumpDiagnostic("subjectRejected");
      return null;
    }
    try {
      const event = JSON.parse(decoder.decode(payloadBytes));
      if (!event || typeof event !== "object") countPumpDiagnostic("invalidPayload");
      return event && typeof event === "object" ? event : null;
    } catch {
      countPumpDiagnostic("invalidJson");
      return null;
    }
  }

  function crlfIndex(bytes, start = 0) {
    const end = Math.min(bytes.length - 1, start + NATS_MAX_HEADER_BYTES + 1);
    for (let index = start; index < end; index += 1) {
      if (bytes[index] === 13 && bytes[index + 1] === 10) return index;
    }
    return -1;
  }

  function drainPumpNatsBuffer() {
    const buffer = pumpNatsReceiveBuffer;
    const generation = pumpNatsGeneration;
    let offset = 0;
    while (offset < buffer.length) {
      const headerEnd = crlfIndex(buffer, offset);
      if (headerEnd < 0) {
        if (buffer.length - offset > NATS_MAX_HEADER_BYTES + 1) {
          rejectPumpNatsFrame();
          return;
        }
        break;
      }
      const line = decoder.decode(buffer.subarray(offset, headerEnd));
      if (line.startsWith("MSG ")) {
        const parts = line.split(/\s+/);
        const size = Number(parts.at(-1));
        const payloadStart = headerEnd + 2;
        const frameEnd = payloadStart + size + 2;
        if (!Number.isSafeInteger(size) || size < 0 || size > NATS_MAX_PAYLOAD_BYTES) {
          rejectPumpNatsFrame();
          return;
        }
        if (buffer.length < frameEnd) break;
        if (buffer[frameEnd - 2] !== 13 || buffer[frameEnd - 1] !== 10) {
          rejectPumpNatsFrame();
          return;
        }
        countPumpDiagnostic("messages");
        if (pumpDiagnosticsEnabled) pumpDiagnostics.lastMessageAt = Date.now();
        const subject = parts[1];
        const payloadBytes = buffer.subarray(payloadStart, payloadStart + size);
        offset = frameEnd;
        const event = pumpNatsAlertForSubject(subject, payloadBytes);
        if (event) {
          forwardPumpAlert(event);
        }
        continue;
      }
      offset = headerEnd + 2;
      if (line.startsWith("HMSG ")) {
        // CONNECT does not advertise headers. Never interpret an unsupported
        // HMSG payload as protocol lines (which could include PING or -ERR).
        countPumpDiagnostic("unsupportedHeaderMessages");
        rejectPumpNatsFrame();
        return;
      }
      handlePumpNatsLine(line);
      if (generation !== pumpNatsGeneration) return;
    }
    // Copy an incomplete tail once per chunk, never once per message. Release
    // a fully consumed batch instead of retaining its backing ArrayBuffer.
    pumpNatsReceiveBuffer = offset === buffer.length ? new Uint8Array()
      : offset ? buffer.slice(offset) : buffer;
  }

  async function pumpNatsBytes(data) {
    if (typeof data === "string") return encoder.encode(data);
    if (data instanceof ArrayBuffer || Object.prototype.toString.call(data) === "[object ArrayBuffer]") {
      return new Uint8Array(data);
    }
    if (data?.arrayBuffer) return new Uint8Array(await data.arrayBuffer());
    return new Uint8Array();
  }

  function connectPumpNats() {
    if (!pumpNatsConfig || !pumpNatsDesiredSubjects.size || pumpNatsSocket) return;
    const generation = ++pumpNatsGeneration;
    pumpNatsStatus("connecting");
    let socket;
    try {
      socket = new WebSocket(pumpNatsConfig.server);
    } catch {
      pumpNatsStatus("disconnected");
      schedulePumpNatsReconnect();
      return;
    }
    socket.binaryType = "arraybuffer";
    pumpNatsSocket = socket;
    clearPumpNatsConnectTimer();
    pumpNatsConnectTimer = setTimeout(() => {
      pumpNatsConnectTimer = null;
      if (generation !== pumpNatsGeneration || pumpNatsConnected) return;
      try { socket.close(); } catch {}
    }, pumpNatsConfig.timeout);
    socket.onmessage = (event) => {
      countPumpDiagnostic("websocketFrames");
      pumpNatsBytes(event.data).then((bytes) => {
        if (generation !== pumpNatsGeneration) return;
        appendPumpNatsBytes(bytes);
      }).catch(() => countPumpDiagnostic("decodeErrors"));
    };
    socket.onerror = () => {
      try { socket.close(); } catch {}
    };
    socket.onclose = () => {
      if (generation !== pumpNatsGeneration) return;
      pumpNatsGeneration += 1;
      clearPumpNatsConnectTimer();
      clearPumpNatsPingTimer();
      pumpNatsSocket = null;
      pumpNatsConnected = false;
      pumpNatsReceiveBuffer = new Uint8Array();
      pumpNatsSidBySubject.clear();
      pumpNatsStatus("disconnected");
      schedulePumpNatsReconnect();
    };
  }

  function configurePumpNats(config, subjects) {
    const nextSubjects = [...new Set((Array.isArray(subjects) ? subjects : [])
      .map((subject) => typeof subject === "string" ? subject.trim() : "")
      .filter(validPumpNatsSubject))];
    if (!nextSubjects.length) {
      pumpNatsDesiredSubjects.clear();
      pumpNatsConfig = null;
      pumpNatsConnectionKey = "";
      closePumpNatsSocket();
      pumpNatsStatus("idle");
      return true;
    }
    const nextConfig = normalizePumpNatsConfig(config);
    if (!nextConfig) return false;
    const nextKey = JSON.stringify([
      nextConfig.server,
      nextConfig.user,
      nextConfig.pass,
      nextConfig.token,
    ]);
    const configChanged = nextKey !== pumpNatsConnectionKey;
    pumpNatsConfig = nextConfig;
    pumpNatsConnectionKey = nextKey;
    pumpNatsDesiredSubjects.clear();
    nextSubjects.forEach((subject) => pumpNatsDesiredSubjects.add(subject));
    if (configChanged) closePumpNatsSocket();
    syncPumpNatsSubjects();
    connectPumpNats();
    return true;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const input = document.createElement("textarea");
      input.value = text;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      return copied;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== "offscreen") return false;
    if (["setPumpNatsDiagnostics", "getPumpNatsDiagnostics"].includes(message.type)) {
      if (globalThis.GmgnRuntimeConfig?.localDiagnostics !== true) {
        sendResponse({ ok: false, error: "DIAGNOSTICS_UNAVAILABLE" });
        return false;
      }
      if (_sender.id !== chrome.runtime.id) {
        sendResponse({ ok: false });
        return false;
      }
      if (message.type === "setPumpNatsDiagnostics") {
        setPumpDiagnosticsEnabled(message.enabled === true);
      }
      sendResponse({ ok: true, diagnostic: {
        revision: "pump-receive-v2", enabled: pumpDiagnosticsEnabled,
        connected: pumpNatsConnected, subscriptionCount: pumpNatsSidBySubject.size,
        wildcardSubscription: [...pumpNatsDesiredSubjects].some((subject) => subject.endsWith(".*")),
        counters: { ...pumpDiagnostics },
      } });
      return false;
    }
    if (message?.type === "configurePumpNats") {
      if (typeof message.diagnosticsEnabled === "boolean") {
        setPumpDiagnosticsEnabled(message.diagnosticsEnabled);
      }
      const ok = configurePumpNats(message.config, message.subjects);
      sendResponse({ ok });
      return false;
    }
    if (message?.type === "copyToClipboard") {
      copyText(message.text)
        .then((copied) => sendResponse({ ok: copied }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    return false;
  });
})();
