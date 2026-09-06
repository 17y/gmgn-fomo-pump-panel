const test = require("node:test");
const assert = require("node:assert/strict");
const resolver = require("../src/evm-holder-resolver");

const params = {
  address: "0x020bfc650a365f8bb26819deaabf3e21291018b4",
  networkId: 4663,
};
const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

function topic(address) {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

test("为支持的 EVM 链构造固定范围的结算合约 Transfer 过滤器", () => {
  const request = resolver.buildRpcRequest(4663, { jsonrpc: "2.0", id: 1 });
  assert.equal(request.url, "https://rpc.mainnet.chain.robinhood.com");
  const bscRequest = resolver.buildRpcRequest(56, { jsonrpc: "2.0", id: 1 });
  assert.equal(bscRequest.url, "https://rpc-bsc.blockmachine.io");
  const bscFallbackRequest = resolver.buildRpcRequest(56, { jsonrpc: "2.0", id: 1 }, 8_000, 1);
  assert.equal(bscFallbackRequest.url, "https://bsc.drpc.org");
  const bscLastRequest = resolver.buildRpcRequest(56, { jsonrpc: "2.0", id: 1 }, 8_000, 2);
  assert.equal(bscLastRequest.url, "https://bsc-rpc.publicnode.com");
  assert.equal(resolver.rpcEndpointCount(56), 3);
  const [buy, sell] = resolver.logFilters(params, 100n, 200n);
  assert.equal(buy.fromBlock, "0x64");
  assert.equal(buy.toBlock, "0xc8");
  assert.equal(buy.topics[1], topic(resolver.FOMO_SETTLEMENT));
  assert.equal(sell.topics[1], null);
  assert.equal(sell.topics[2], topic(resolver.FOMO_SETTLEMENT));
});

test("BSC 日志按 RPC 允许的 10000 区块窗口直接分片", () => {
  assert.deepEqual(resolver.logRanges(56, 0n, 20_000n), [
    { fromBlock: 0n, toBlock: 9_999n },
    { fromBlock: 10_000n, toBlock: 19_999n },
    { fromBlock: 20_000n, toBlock: 20_000n },
  ]);
  assert.deepEqual(resolver.logRanges(4663, 0n, 20_000n), [
    { fromBlock: 0n, toBlock: 20_000n },
  ]);
});

test("成交区块只扩展为固定的小日志窗口", () => {
  assert.deepEqual(resolver.tradeLogRange(50_000n, 100_000n), {
    fromBlock: 45_001n,
    toBlock: 54_999n,
  });
  assert.deepEqual(resolver.tradeLogRange(1_000n, 2_500n), {
    fromBlock: 0n,
    toBlock: 2_500n,
  });
  assert.equal(
    resolver.estimatedBlockAtTimestamp(56, 1_000_000n, 775_000_000, 1_000_000_000),
    500_000n,
  );
});

test("只从正确的 Transfer topic 位置提取钱包并排除结算合约", () => {
  const buyLogs = [{ topics: ["0xevent", topic(resolver.FOMO_SETTLEMENT), topic(WALLET)] }];
  const sellLogs = [
    { topics: ["0xevent", topic(OTHER), topic(resolver.FOMO_SETTLEMENT)] },
    { topics: ["0xevent", topic(resolver.FOMO_SETTLEMENT), topic(resolver.FOMO_SETTLEMENT)] },
  ];
  assert.deepEqual(resolver.candidateAddresses(buyLogs, sellLogs, params), [WALLET, OTHER]);
});

test("固定区块 balanceOf 结果必须按原始整数唯一匹配", () => {
  const requests = resolver.balanceRequests(params, [WALLET, OTHER], "0x123");
  assert.equal(requests[0].params[1], "0x123");
  assert.match(requests[0].params[0].data, new RegExp(`${WALLET.slice(2)}$`));
  assert.equal(resolver.uniqueBalanceMatch([WALLET, OTHER], [
    { id: 1, result: "0xde0b6b3a7640000" },
    { id: 2, result: "0x2" },
  ], "1000000000000000000"), WALLET);

  assert.throws(() => resolver.uniqueBalanceMatch([WALLET, OTHER], [
    { id: 1, result: "0xde0b6b3a7640000" },
    { id: 2, result: "0xde0b6b3a7640000" },
  ], "1000000000000000000"), /HOLDER_CHAIN_DATA_AMBIGUOUS/);

  assert.equal(resolver.uniqueBalanceMatch([WALLET, OTHER], [
    { id: 1, result: "0xde0b6b3a7640001" },
    { id: 2, result: "0x2" },
  ], "1000000000000000000", 2), WALLET);

  assert.throws(() => resolver.uniqueBalanceMatch([WALLET, OTHER], [
    { id: 1, result: "0xde0b6b3a7640001" },
    { id: 2, result: "0xde0b6b3a7640002" },
  ], "1000000000000000000", 2), /HOLDER_CHAIN_DATA_AMBIGUOUS/);
});

test("链上候选只接受 EOA 或 EIP-7702 委托账户", () => {
  assert.equal(resolver.classifyWalletCode("0x"), "eoa");
  assert.equal(
    resolver.classifyWalletCode("0xef01004337084d9e255ff0702461cf8895ce9e3b5ff108"),
    "eip7702",
  );
  assert.equal(resolver.classifyWalletCode("0x60006000"), "contract");
  assert.equal(resolver.classifyWalletCode("0xef0100abcd"), "contract");
});

test("Robinhood Blockscout 持有人保留原始整数并排除普通合约", () => {
  const tokenRequest = resolver.buildBlockscoutTokenRequest(params);
  const holdersRequest = resolver.buildBlockscoutHoldersRequest(params, {
    value: "123",
    address_hash: WALLET,
  });
  assert.equal(tokenRequest.url, `https://robinhoodchain.blockscout.com/api/v2/tokens/${params.address}`);
  assert.match(holdersRequest.url, /\/holders\?/);
  assert.equal(resolver.blockscoutTokenDecimals({ decimals: "18" }), 18);

  const page = resolver.blockscoutHolderPage({
    items: [{
      address: { hash: WALLET, is_contract: false, proxy_type: null },
      value: "1000000000000000000",
    }, {
      address: { hash: OTHER, is_contract: true, proxy_type: null },
      value: "900000000000000000",
    }, {
      address: {
        hash: "0x3333333333333333333333333333333333333333",
        is_contract: true,
        proxy_type: "eip7702",
      },
      value: "800000000000000000",
    }],
    next_page_params: { value: "800000000000000000" },
  }, params);
  assert.deepEqual(page.rows.map((row) => [row.balanceRaw, row.isWallet]), [
    ["1000000000000000000", true],
    ["900000000000000000", false],
    ["800000000000000000", true],
  ]);
  assert.equal(page.nextPageParams.value, "800000000000000000");
});
