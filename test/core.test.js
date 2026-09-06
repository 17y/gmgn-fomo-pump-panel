const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/core");

const EVM_ADDRESS = "0x1111111111111111111111111111111111111111";
const MIXED_CASE_EVM_ADDRESS = `0x${"Ab".repeat(20)}`;
const SOLANA_ADDRESS = "11111111111111111111111111111111";

test("解析 GMGN EVM token 路由并映射 Fomo chain", () => {
  assert.deepEqual(core.parseTokenRoute(`/bsc/token/${EVM_ADDRESS}`), {
    chain: "bsc",
    address: EVM_ADDRESS,
    networkId: 56,
    fomoChain: "bnb",
  });
});

test("解析 GMGN Solana token 路由", () => {
  assert.deepEqual(core.parseTokenRoute(`/sol/token/${SOLANA_ADDRESS}`), {
    chain: "sol",
    address: SOLANA_ADDRESS,
    networkId: 1399811149,
    fomoChain: "solana",
  });
});

test("忽略非 token、未知链和非法 CA 路由", () => {
  assert.equal(core.parseTokenRoute(`/bsc/address/${EVM_ADDRESS}`), null);
  assert.equal(core.parseTokenRoute(`/tron/token/${EVM_ADDRESS}`), null);
  assert.equal(core.parseTokenRoute("/bsc/token/not-an-address"), null);
});

test("按当前链校验钱包地址", () => {
  assert.equal(core.normalizeWalletAddress(MIXED_CASE_EVM_ADDRESS, 56), MIXED_CASE_EVM_ADDRESS.toLowerCase());
  assert.equal(core.normalizeWalletAddress(SOLANA_ADDRESS, 1399811149), SOLANA_ADDRESS);
  assert.equal(core.normalizeWalletAddress(SOLANA_ADDRESS, 56), "");
  assert.equal(core.normalizeWalletAddress(EVM_ADDRESS, 1399811149), "");
});

test("只允许 https 资源 URL", () => {
  assert.equal(core.safeHttpsUrl("https://example.com/a.png"), "https://example.com/a.png");
  assert.equal(core.safeHttpsUrl("http://example.com/a.png"), null);
  assert.equal(core.safeHttpsUrl("javascript:alert(1)"), null);
});

test("Token 图片把合法 IPFS 地址转换成 HTTPS 网关且拒绝危险协议", () => {
  const cid = "bafkreiduxzar2onubb6oudbuibb7vip6am6nujj3sau6iftolmzt3rycaa";
  assert.equal(core.safeTokenImageUrl(`ipfs://${cid}`), `https://ipfs.io/ipfs/${cid}`);
  assert.equal(
    core.safeTokenImageUrl(`ipfs://ipfs/${cid}/token%20image.png?download=1`),
    `https://ipfs.io/ipfs/${cid}/token%20image.png`,
  );
  assert.equal(core.safeTokenImageUrl("https://example.com/token.png"), "https://example.com/token.png");
  assert.equal(core.safeTokenImageUrl("javascript:alert(1)"), null);
  assert.equal(core.safeTokenImageUrl("ipfs://bad-cid/../../secret"), null);
});

test("计算 Holder PnL 与平均入场 MC", () => {
  const holder = { pnl: 500, costBasis: 1000, averageEntryPrice: 0.0002 };
  assert.equal(core.holderPnlPercent(holder), 50);
  assert.equal(core.averageEntryMarketCap(holder, 1_000_000_000), 200_000);
  assert.equal(core.holderPnlPercent({ pnl: 1, costBasis: 0 }), null);
});

test("空值不会被误格式化为 0", () => {
  assert.equal(core.finiteNumber(null), null);
  assert.equal(core.compactUsd(null), "—");
});

test("十进制数量不经浮点数即可规范化、相加并转换最小单位", () => {
  assert.equal(core.decimalString("7500000.123400000000000000"), "7500000.1234");
  assert.equal(core.decimalString("7.5e6"), "7500000");
  assert.equal(core.decimalEqual("1.2300", "1.23"), true);
  assert.equal(core.decimalEqual("7500000.000000000000000001", "7500000"), false);
  assert.equal(core.decimalWithinRelativeTolerance("7500000", "7500014", 2), true);
  assert.equal(core.decimalWithinRelativeTolerance("7500000", "7500016", 2), false);
  assert.equal(core.decimalWithinRelativeTolerance("0", "0.000001", 2), false);
  assert.equal(core.addDecimalStrings(["1.2", "0.03", "4"]), "5.23");
  assert.equal(core.decimalToUnits("1.000000000000000001", 18), "1000000000000000001");
  assert.equal(core.decimalToUnits("1.0000001", 6), null);
});

test("持仓占比保留小比例所需精度", () => {
  assert.equal(core.holdingPercent(1), "1%");
  assert.equal(core.holdingPercent(0.1), "0.1%");
  assert.equal(core.holdingPercent(0.0012), "0.0012%");
  assert.equal(core.holdingPercent(null), "—");
});

test("相对时间支持 ISO 日期", () => {
  assert.equal(core.relativeTime("2026-08-16T00:00:00Z", Date.parse("2026-08-16T00:02:05Z")), "2m");
});
