(() => {
  "use strict";

  if (globalThis.__gmgnFomoAlertTopicCapture === "1.0.0") return;
  globalThis.__gmgnFomoAlertTopicCapture = "1.0.0";

  const EVENT_NAME = "gmgn-fomo-alert-topic";
  const emitTopicId = (value) => {
    const topicId = typeof value === "string" ? value.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(topicId)) return;
    document.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: topicId }));
  };

  const inspectSocketMessage = (data) => {
    if (typeof data !== "string") return;
    try {
      const message = JSON.parse(data);
      if (message?.type === "subscribe" && message.topicType === "trading_activity") {
        emitTopicId(message.topicId);
      }
    } catch {}
  };

  const NativeWebSocket = globalThis.WebSocket;
  if (typeof NativeWebSocket === "function") {
    try {
      globalThis.WebSocket = new Proxy(NativeWebSocket, {
        construct(target, argumentsList) {
          const socket = Reflect.construct(target, argumentsList, target);
          const nativeSend = socket.send;
          socket.send = function send(data) {
            inspectSocketMessage(data);
            return nativeSend.call(this, data);
          };
          return socket;
        },
      });
    } catch {}
  }

})();
