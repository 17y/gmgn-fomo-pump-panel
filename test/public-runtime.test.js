const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("公开 Offscreen 配置不可被覆盖，消息不能开启诊断，复制功能仍可用", async () => {
  let listener;
  let copied;
  const context = vm.createContext({
    chrome: { runtime: { id: "public-test", onMessage: { addListener(fn) { listener = fn; } } } },
    navigator: { clipboard: { async writeText(text) { copied = text; } } },
    TextEncoder, TextDecoder, URL, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(fs.readFileSync("src/runtime-config.js", "utf8"), context);
  vm.runInContext("GmgnRuntimeConfig.localDiagnostics = true; globalThis.GmgnRuntimeConfig = { localDiagnostics: true };", context);
  assert.equal(context.GmgnRuntimeConfig.localDiagnostics, false);
  vm.runInContext(fs.readFileSync("src/offscreen.js", "utf8"), context);
  for (const type of ["setPumpNatsDiagnostics", "getPumpNatsDiagnostics"]) {
    let response;
    listener({ target: "offscreen", type, enabled: true }, { id: "public-test" }, value => { response = value; });
    assert.equal(response.error, "DIAGNOSTICS_UNAVAILABLE");
  }
  const response = await new Promise(resolve => listener({ target: "offscreen", type: "copyToClipboard", text: "public-copy" }, {}, resolve));
  assert.equal(response.ok, true);
  assert.equal(copied, "public-copy");
});
