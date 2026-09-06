// Public distribution: local diagnostic collection cannot be enabled by settings or messages.
Object.defineProperty(globalThis, "GmgnRuntimeConfig", {
  value: Object.freeze({ localDiagnostics: false }),
  writable: false,
  configurable: false,
});
