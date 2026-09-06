const test = require("node:test");
const assert = require("node:assert/strict");
const { pumpKey } = require("../src/trade-identity");
const history = require("../src/follow-trades");
const bridge = require("../src/gmgn-follow-bridge");

test("Pump 跨来源标识一致，Solana 大小写、钱包、代币和方向均不能被合并", () => {
  const item = { platform: "pump", networkId: 1399811149, transactionHash: "SigAbC",
    walletAddress: "WalletAbC", tokenAddress: "TokenAbC", type: "buy", pumpEventId: "nats-event" };
  assert.equal(pumpKey(item), pumpKey({ ...item, pumpEventId: undefined, id: "rest-id" }));
  assert.equal(pumpKey(item), history.stableKey(item));
  assert.equal(pumpKey(item), bridge.trackingItemKey(item));
  for (const field of ["transactionHash", "walletAddress", "tokenAddress"]) {
    assert.notEqual(pumpKey(item), pumpKey({ ...item, [field]: item[field].toLowerCase() }));
  }
  assert.notEqual(pumpKey(item), pumpKey({ ...item, type: "sell" }));
  assert.notEqual(pumpKey(item), pumpKey({ ...item, walletAddress: "OtherMaker" }));
  const evm = { ...item, networkId: 56 };
  assert.equal(pumpKey(evm), pumpKey({ ...evm, transactionHash: "sigabc", walletAddress: "walletabc", tokenAddress: "tokenabc" }));
  assert.equal(pumpKey({ platform: "fomo", pumpEventId: "nats-event" }), "");
});
