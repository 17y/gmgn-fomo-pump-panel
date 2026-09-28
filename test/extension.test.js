const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("Manifest 只保留 GMGN、Fomo、Pump 与 EVM 兜底所需权限和脚本", () => {
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.deepEqual(manifest.permissions, [
    "storage",
    "webRequest",
    "declarativeNetRequestWithHostAccess",
    "sidePanel",
    "scripting",
    "clipboardWrite",
    "offscreen",
  ]);
  assert.deepEqual(manifest.content_scripts.map((entry) => ({
    js: entry.js,
    runAt: entry.run_at,
    world: entry.world,
  })), [
    {
      js: ["src/fomo-alert-topic-main.js"],
      runAt: "document_start",
      world: "MAIN",
    },
    {
      js: ["src/fomo-alert-topic.js"],
      runAt: "document_start",
      world: undefined,
    },
    {
      js: ["src/trade-identity.js", "src/gmgn-follow-bridge.js", "src/follow-tracker-main.js"],
      runAt: "document_start",
      world: "MAIN",
    },
    { js: ["src/follow-tracker.js"], runAt: "document_start", world: undefined },
    { js: ["src/core.js", "src/panel-loader.js"], runAt: "document_idle", world: undefined },
  ]);
  assert.equal(manifest.host_permissions.some((value) => /dexscreener/.test(value)), false);
  assert.equal(manifest.host_permissions.includes("https://frontend-api-v3.pump.fun/*"), true);
  assert.equal(manifest.host_permissions.includes("https://rpc.mainnet.chain.robinhood.com/*"), true);
  assert.equal(manifest.host_permissions.includes("https://robinhoodchain.blockscout.com/*"), true);
  assert.equal(manifest.host_permissions.includes("https://ethereum-rpc.publicnode.com/*"), true);
  assert.equal(manifest.host_permissions.includes("https://bsc-rpc.publicnode.com/*"), true);
  assert.equal(manifest.host_permissions.includes("https://rpc-bsc.blockmachine.io/*"), true);
  assert.equal(manifest.host_permissions.includes("https://bsc.drpc.org/*"), true);
  assert.equal(manifest.host_permissions.includes("https://rpc-bnb.blockmachine.io/*"), false);
  assert.equal(manifest.host_permissions.includes("https://bsc-dataseed1.bnbchain.org/*"), false);
  assert.equal(manifest.host_permissions.includes("https://mainnet.base.org/*"), true);
  assert.equal(manifest.host_permissions.includes("https://profile-api.pump.fun/*"), true);
  assert.equal(manifest.host_permissions.includes("https://api.mainnet-beta.solana.com/*"), true);
  assert.deepEqual(manifest.web_accessible_resources, [{
    resources: ["src/panel.css", "assets/pump.svg"],
    matches: ["https://gmgn.ai/*", "https://www.gmgn.ai/*"],
  }]);
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.equal(packageJson.version, manifest.version);
  const fomoTopicCapture = fs.readFileSync("src/fomo-alert-topic-main.js", "utf8");
  assert.match(fomoTopicCapture, /new Proxy\(NativeWebSocket/);
  assert.doesNotMatch(fomoTopicCapture, /globalThis\.fetch\s*=/);
  assert.match(
    fs.readFileSync("src/follow-tracker-main.js", "utf8"),
    new RegExp(`const BRIDGE_VERSION = ["']${manifest.version.replaceAll(".", "\\.")}["']`),
  );
});

test("公开包不包含本地诊断页面或工作站脚本", () => {
  assert.equal(fs.existsSync("diagnostics.html"), false);
  assert.equal(fs.existsSync("src/diagnostics.js"), false);
  assert.equal(fs.existsSync("scripts"), false);
  assert.match(fs.readFileSync("src/background.js", "utf8"), /importScripts\("runtime-config.js"/);
  assert.match(fs.readFileSync("offscreen.html", "utf8"), /src\/runtime-config.js/);
});

test("更新扩展后补注入事件薄桥和按需面板入口，完整面板不进入首屏脚本", () => {
  const background = fs.readFileSync("src/background.js", "utf8");
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  assert.match(background, /injectIntoOpenGmgnTabs/);
  assert.match(background, /configureSidePanel\(\);\s*injectIntoOpenGmgnTabs\(\);/);
  assert.match(background, /chrome\.scripting\.executeScript/);
  assert.match(background, /world: "MAIN"/);
  assert.match(background, /"src\/gmgn-follow-bridge\.js"/);
  assert.match(background, /"src\/follow-tracker-main\.js"/);
  assert.match(background, /"src\/follow-tracker\.js"/);
  assert.match(background, /gmgnFollowTradeRelayPing/);
  assert.match(background, /let bridgeReady = false/);
  assert.match(background, /__gmgnFollowThinBridgeVersion === expectedVersion/);
  assert.match(background, /typeof globalThis\.GmgnFollowBridge\?\.toGmgnFollowSocketTrade === "function"/);
  assert.match(background, /if \(!bridgeReady\)/);
  assert.match(background, /files: \["src\/core\.js", "src\/panel-loader\.js"\]/);
  assert.match(background, /function ensureFomoOverlay/);
  assert.equal(manifest.content_scripts.some((entry) => entry.js.includes("src/content.js")), false);
});

test("原生 Side Panel 由用户手势打开并同步 GMGN 路由", () => {
  const background = fs.readFileSync("src/background.js", "utf8");
  const content = fs.readFileSync("src/content.js", "utf8");
  const sidePanel = fs.readFileSync("src/sidepanel.js", "utf8");
  const html = fs.readFileSync("sidepanel.html", "utf8");
  assert.match(background, /openPanelOnActionClick: true/);
  assert.match(background, /chrome\.sidePanel\.open/);
  assert.match(background, /fomoSidePanelVisibility/);
  assert.match(background, /sidePanelVisibilityChanged/);
  assert.match(content, /gmgnTokenRouteChanged/);
  assert.match(content, /getSidePanelVisibility/);
  assert.match(content, /REFRESH_MS = 5_000/);
  assert.match(sidePanel, /REFRESH_MS = 5_000/);
  assert.match(sidePanel, /SIDE_PANEL_HEARTBEAT_MS = 20_000/);
  assert.match(sidePanel, /void chrome\.runtime\.lastError/);
  assert.match(sidePanel, /if \(visibilityPort !== port\) return;/);
  assert.match(html, /src\/sidepanel\.js/);
});

test("Authorization 只从 Fomo 页面持久化，并在 401 后自动续期", () => {
  const source = fs.readFileSync("src/background.js", "utf8");
  assert.match(source, /chrome\.storage\.local\.set/);
  assert.match(source, /previousSession/);
  assert.match(source, /details\.initiator !== FOMO_PAGE_ORIGIN/);
  assert.match(source, /chrome\.tabs\.create\(\{ url: FOMO_PAGE_URL, active: false \}\)/);
  assert.match(source, /session\.authorization !== previousAuthorization/);
  assert.match(source, /queryFomoTokenShared\(params, \{ \.\.\.options, force: false \}, false\)/);
  assert.match(source, /chrome\.storage\.local\.remove\(SESSION_KEY\)/);
  assert.match(source, /reason === "HTTP_401"/);
  assert.doesNotMatch(source, /reason === "HTTP_401" \|\| reason === "HTTP_403"/);
  assert.match(source, /cache: "no-store"/);
  assert.match(source, /fomoTokenCacheV1/);
  assert.match(source, /cachedResult/);
});

test("浮层使用 Shadow DOM 并加载隔离样式", () => {
  const source = fs.readFileSync("src/content.js", "utf8");
  assert.match(source, /attachShadow\(\{ mode: "open" \}\)/);
  assert.match(source, /src\/panel\.css/);
});

test("只增加持仓占比标签，不替换持仓金额或展示 Token 数量", () => {
  const content = fs.readFileSync("src/content.js", "utf8");
  const sidePanel = fs.readFileSync("src/sidepanel.js", "utf8");
  const styles = fs.readFileSync("src/panel.css", "utf8");
  assert.match(content, /fomo-ownership-badge/);
  assert.match(sidePanel, /fomo-ownership-badge/);
  assert.match(styles, /\.fomo-ownership-badge/);
  assert.match(content, /core\.preciseUsd\(holders\.fomoPositionValue\)/);
  assert.match(sidePanel, /core\.preciseUsd\(holders\.fomoPositionValue\)/);
  assert.match(content, /Holding:.*holdingPercent/);
  assert.match(sidePanel, /Holding:.*holdingPercent/);
  assert.doesNotMatch(content, /fomo-token-amount|fomo-position-summary-amount/);
  assert.doesNotMatch(sidePanel, /fomo-token-amount|fomo-position-summary-amount/);
});

test("Holders 保持现有卡片结构并标注 Fomo 与 Pump 来源", () => {
  const background = fs.readFileSync("src/background.js", "utf8");
  const content = fs.readFileSync("src/content.js", "utf8");
  const sidePanel = fs.readFileSync("src/sidepanel.js", "utf8");
  const styles = fs.readFileSync("src/panel.css", "utf8");
  assert.match(background, /importScripts\("runtime-config\.js", "core\.js", "fomo-api\.js", "pump-api\.js", "trade-identity\.js", "follow-trades\.js", "evm-holder-resolver\.js", "trade-delivery\.js", "trade-receipts\.js"\)/);
  assert.match(background, /GmgnPumpApi\.sanitizePositions/);
  assert.match(background, /PUMP_REQUEST_TIMEOUT_MS = 2_000/);
  assert.doesNotMatch(background, /Promise\.all\(\[\s*queryFomoToken[\s\S]*queryPumpHolders/);
  assert.match(content, /type: "queryFomoToken"[\s\S]*type: "queryPumpHolders"/);
  assert.match(sidePanel, /type: "queryFomoToken"[\s\S]*type: "queryPumpHolders"/);
  assert.match(content, /pumpApi\.mergeHolderItems/);
  assert.match(sidePanel, /pumpApi\.mergeHolderItems/);
  for (const source of [content, sidePanel]) {
    const fomoRequest = source.indexOf('type: "queryFomoToken"');
    const fomoRender = source.indexOf("currentData = withPumpItems(fomoData, currentPumpItems);", fomoRequest);
    const pumpRequest = source.indexOf('type: "queryPumpHolders"', fomoRequest);
    assert.ok(fomoRequest !== -1 && fomoRender > fomoRequest && pumpRequest > fomoRender);
    assert.doesNotMatch(source, /renderImmediately/);
  }
  assert.match(styles, /\.fomo-holder\.pump-enter/);
  assert.match(content, /holder\.platform === "pump".*pumpPlatformLogo/);
  assert.match(sidePanel, /holder\.platform === "pump".*pumpPlatformLogo/);
  assert.match(content, /if \(!isPump \|\| metrics\.childElementCount\)/);
  assert.match(sidePanel, /if \(!isPump \|\| metrics\.childElementCount\)/);
  assert.match(styles, /\.fomo-platform-logo\.pump/);
});

test("Fomo 与 Pump 新事件直达 GMGN 原生流，只在事件后定向补平台 Logo", () => {
  const background = fs.readFileSync("src/background.js", "utf8");
  const manifest = fs.readFileSync("manifest.json", "utf8");
  const tracker = fs.readFileSync("src/follow-tracker.js", "utf8");
  const main = fs.readFileSync("src/follow-tracker-main.js", "utf8");
  const bridge = fs.readFileSync("src/gmgn-follow-bridge.js", "utf8");
  assert.match(background, /type === "queryFollowedTrades"/);
  assert.match(background, /const useFomoRealtimeSnapshot = !forceFomo && fomoAlertSocketAuthenticated/);
  assert.match(
    background,
    /Promise\.allSettled\(\[\s*useFomoRealtimeSnapshot[\s\S]*queryFomoFollowedTrades\(true, forceFomo\),\s*queryPumpFollowedTrades\(\)/,
  );
  assert.match(background, /fetchPumpFollowedTradePages\(fetchPublicJson, null, maxPages\)/);
  assert.match(background, /fetchPumpJsonFromPage/);
  assert.match(background, /queryPumpProfileFollowedTrades/);
  assert.match(background, /buildPresenceRequest/);
  assert.match(background, /buildProfileTransactionsRequest/);
  assert.match(background, /buildSolanaTransactionsRequest/);
  assert.match(background, /followedTradesForNetwork/);
  assert.match(background, /url: \["https:\/\/pump\.fun\/\*"\]/);
  assert.doesNotMatch(background, /chrome\.tabs\.update/);
  assert.match(manifest, /"https:\/\/pump\.fun\/\*"/);
  assert.match(tracker, /chrome\.runtime\.connect\(\{ name: "gmgnFollowTradeEvents" \}\)/);
  assert.match(background, /broadcastGmgnFollowTradeEvents/);
  assert.match(fs.readFileSync("src/trade-delivery.js", "utf8"), /type: "gmgnFollowTradeEvent"/);
  assert.match(background, /FOLLOWED_TRADES_POLL_MS = 5_000/);
  assert.match(background, /type: "followedTradesSnapshot"/);
  assert.match(tracker, /mode: "event-only"/);
  assert.match(tracker, /window\.postMessage/);
  assert.match(tracker, /PLATFORM_DECORATION_DELAYS_MS/);
  assert.match(tracker, /document\.querySelectorAll\?\.\(PLATFORM_IMAGE_SELECTOR\)/);
  assert.doesNotMatch(tracker, /MutationObserver|setInterval/);
  assert.match(bridge, /gmgn-follow-source/);
  assert.match(bridge, /gmgn-follow-name/);
  assert.doesNotMatch(main, /mergeTrackingPayload/);
  assert.match(main, /const BRIDGE_VERSION/);
  assert.doesNotMatch(main, /globalThis\.fetch\s*=/);
  assert.doesNotMatch(main, /XMLHttpRequest\.prototype\.(?:open|send)\s*=/);
  assert.match(main, /followWalletSocket\.handleData/);
  assert.match(main, /audio_played_uuids/);
  assert.match(main, /selectedFollowingSound/);
  assert.match(main, /nativeSound\.AE\(selection\.soundType\)/);
  assert.doesNotMatch(main, /AudioContext|createOscillator|playFallback/);
  assert.doesNotMatch(background, /playFollowedTradeSound|AUDIO_PLAYBACK/);
  assert.doesNotMatch(fs.readFileSync("src\/offscreen.js", "utf8"), /AudioContext|createOscillator/);
  assert.doesNotMatch(tracker, /dataset|innerHTML/);
  assert.doesNotMatch(main, /XMLHttpRequest\.prototype/);
  assert.doesNotMatch(main, /QueryCache|visibilitychange|new Event\("focus"\)/i);
  assert.match(main, /bridge\.trackingRequest\(axios\.getUri\(response\.config\)\)/);
  assert.match(main, /bridge\.mergeRecentTrackingPayload/);
});

test("双 UI 提供持久化关注交易推送开关，关闭后由后台停止数据源", () => {
  const background = fs.readFileSync("src/background.js", "utf8");
  const content = fs.readFileSync("src/content.js", "utf8");
  const sidePanel = fs.readFileSync("src/sidepanel.js", "utf8");
  const html = fs.readFileSync("sidepanel.html", "utf8");
  const styles = fs.readFileSync("src/panel.css", "utf8");

  assert.match(background, /followedTradesEnabledV1/);
  assert.match(background, /stopFollowedTradesAcquisition/);
  assert.match(background, /type === "setFollowedTradesEnabled"/);
  for (const source of [content, sidePanel]) {
    assert.match(source, /getFollowedTradesEnabled/);
    assert.match(source, /setFollowedTradesEnabled/);
    assert.match(source, /tracking-toggle/);
  }
  for (const source of [content, html]) {
    assert.match(source, /推送追踪/);
    assert.match(source, /data-role="tracking-toggle"/);
  }
  assert.match(styles, /\.fomo-tracking-toggle/);
});

test("非关键插件工作不进入 GMGN 首屏关键路径", () => {
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  const background = fs.readFileSync("src/background.js", "utf8");
  const tracker = fs.readFileSync("src/follow-tracker.js", "utf8");
  const content = fs.readFileSync("src/content.js", "utf8");
  const sidePanel = fs.readFileSync("src/sidepanel.js", "utf8");
  const main = fs.readFileSync("src/follow-tracker-main.js", "utf8");
  const mainBridge = manifest.content_scripts.find((entry) => (
    entry.js.includes("src/follow-tracker-main.js")
  ));
  const isolatedTracker = manifest.content_scripts.find((entry) => (
    entry.js.includes("src/follow-tracker.js")
  ));

  assert.equal(mainBridge.run_at, "document_start");
  assert.equal(mainBridge.world, "MAIN");
  assert.equal(isolatedTracker.run_at, "document_start");
  assert.doesNotMatch(tracker, /requestAnimationFrame|MutationObserver|setInterval/);
  assert.match(tracker, /PLATFORM_DECORATION_DELAYS_MS = Object\.freeze\(\[80, 250, 700, 1_400\]\)/);
  assert.doesNotMatch(content, /setInterval\(syncRoute,\s*400\)/);
  assert.match(content, /scheduleInitialLoad/);
  assert.match(content, /INITIAL_LOAD_IDLE_TIMEOUT_MS/);
  assert.match(content, /TOKEN_LOAD_TIMEOUT_MS = 13_000/);
  assert.match(sidePanel, /TOKEN_LOAD_TIMEOUT_MS = 13_000/);
  assert.match(sidePanel, /renderPendingHeader\(currentRoute\)/);
  assert.match(content, /FOMO_REQUEST_TIMEOUT/);
  assert.match(sidePanel, /FOMO_REQUEST_TIMEOUT/);
  assert.match(background, /FOMO_REQUEST_TIMEOUT_MS = 10_000/);
  assert.match(background, /FOMO_SESSION_REFRESHING/);
  assert.match(background, /type: "fomoSessionChanged"/);
  assert.match(sidePanel, /reloadAfterFomoSessionChange/);
  assert.match(sidePanel, /message\?\.type === "fomoSessionChanged"/);
  assert.match(content, /REFRESH_MS = 5_000/);
  assert.match(main, /RETRY_OFFSETS_MS = Object\.freeze\(\[0, 100, 250, 500, 1_000, 2_000, 4_000\]\)/);
  assert.doesNotMatch(main, /setInterval|scheduleWebpackScan|axiosBridgeInstalled/);
  assert.doesNotMatch(
    main,
    /webpackObservedFactoryCount|installQueryStoreChunkBridge|scanTrackingQueryStores|syncTrackingQueryCaches|getQueryCache|setQueryData/,
    "主世界脚本不得扫描或改写 GMGN 的全局 QueryCache",
  );
  assert.doesNotMatch(main, /chunks\.push\s*=/, "不得接管 GMGN 的全局 Webpack chunk 热路径");
  assert.doesNotMatch(main, /globalThis\.fetch\s*=|XMLHttpRequest\.prototype\.(?:open|send)\s*=/);
  assert.match(main, /const webpackFactoryMatches = new WeakMap\(\)/);
  assert.match(main, /function webpackFactoryMarkers/);
  assert.equal(manifest.content_scripts.some((entry) => entry.js.includes("src/content.js")), false);
});

test("旧自动地址备注功能已完整移除", () => {
  const sources = [
    "src/background.js",
    "src/follow-tracker.js",
    "src/follow-tracker-main.js",
    "src/trade-identity.js", "src/gmgn-follow-bridge.js",
  ].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const removedIdentifiers = [
    "query" + "EarlyRiskLabels",
    "cancel" + "EarlyRiskLabels",
    "Gmgn" + "EarlyRiskApi",
    "gmgn-early-" + "risk-data",
    "extension_" + "risk_kind",
    "enhanceTokenAddress" + "RemarksPayload",
  ];
  for (const identifier of removedIdentifiers) assert.equal(sources.includes(identifier), false);
  assert.equal(fs.existsSync("src/" + "early-risk-api.js"), false);
});

test("Pump 会话不可用时双 UI 显示非阻断的用户点击提醒", () => {
  const background = fs.readFileSync("src/background.js", "utf8");
  const content = fs.readFileSync("src/content.js", "utf8");
  const sidePanel = fs.readFileSync("src/sidepanel.js", "utf8");
  const html = fs.readFileSync("sidepanel.html", "utf8");
  const styles = fs.readFileSync("src/panel.css", "utf8");

  assert.match(background, /getFollowedTradeSources/);
  assert.match(background, /setBadgeText/);
  assert.match(background, /setBadgeBackgroundColor/);
  assert.match(background, /setTitle/);
  assert.match(background, /PUMP_SESSION_REQUIRED/);
  assert.match(background, /PUMP_SESSION_EXPIRED/);
  for (const source of [content, sidePanel]) {
    assert.match(source, /pumpLoginRequired/);
    assert.match(source, /getFollowedTradeSources/);
    assert.match(source, /pump-login-required/);
  }
  for (const source of [content, html]) {
    assert.match(source, /fomo-pump-notice/);
    assert.match(source, /Pump 数据未连接/);
    assert.match(source, /https:\/\/pump\.fun\/\?tab=friends/);
  }
  assert.match(styles, /\.fomo-pump-notice/);
  assert.match(styles, /\.fomo-panel\.pump-login-required \.fomo-body/);
});

test("Holders 标签不再显示总持有人数", () => {
  const content = fs.readFileSync("src/content.js", "utf8");
  const sidePanel = fs.readFileSync("src/sidepanel.js", "utf8");
  const html = fs.readFileSync("sidepanel.html", "utf8");
  assert.doesNotMatch(content, /holder-count/);
  assert.doesNotMatch(sidePanel, /holder-count/);
  assert.doesNotMatch(html, /holder-count/);
});

test("Holder 名字后不再展示 Clan 标签", () => {
  const content = fs.readFileSync("src/content.js", "utf8");
  const sidePanel = fs.readFileSync("src/sidepanel.js", "utf8");
  const styles = fs.readFileSync("src/panel.css", "utf8");
  assert.doesNotMatch(content, /fomo-clan/);
  assert.doesNotMatch(sidePanel, /fomo-clan/);
  assert.doesNotMatch(styles, /fomo-clan/);
});

test("Holder 名字按稳定标识解析地址后复制，不按列表下标配对", () => {
  const fomoApi = fs.readFileSync("src/fomo-api.js", "utf8");
  const background = fs.readFileSync("src/background.js", "utf8");
  const content = fs.readFileSync("src/content.js", "utf8");
  const sidePanel = fs.readFileSync("src/sidepanel.js", "utf8");
  const styles = fs.readFileSync("src/panel.css", "utf8");
  for (const source of [content, sidePanel]) {
    assert.match(source, /core\.normalizeWalletAddress\(holder\.walletAddress, route\.networkId\)/);
    assert.match(source, /"resolveFomoHolderAddress"/);
    assert.match(source, /type: canResolvePump \? "resolvePumpHolderAddress" : "resolveFomoHolderAddress"/);
    assert.match(source, /tradeId: holder\.tradeId/);
    assert.match(source, /userId: holder\.userId/);
    assert.match(source, /humanAmount: holder\.humanAmount/);
    assert.match(source, /humanAmountRaw: holder\.humanAmountRaw/);
    assert.match(source, /type: "copyHolderAddress"/);
    assert.doesNotMatch(source, /navigator\.clipboard\.writeText/);
    assert.match(source, /function holderAvatarControl\(holder, followControl\)/);
    assert.match(source, /core\.safeHttpsUrl\(holder\.profileUrl\)/);
    assert.match(source, /element\("a", "fomo-avatar-profile"\)/);
    assert.match(source, /link\.target = "_blank"/);
    assert.match(source, /link\.rel = "noopener noreferrer"/);
    assert.doesNotMatch(source, /nameControl\.click\(\)/);
    assert.match(source, /row\.append\(holderAvatarControl\(holder, followControl\)\)/);
    assert.match(source, /holderCopyStates\.set\(key, \{ status: "copied" \}\)/);
    assert.match(source, /holderCopyStates\.set\(key, \{ status: "error", error:/);
    assert.match(source, /rerenderHolderActions\(\)/);
    assert.match(source, /state\?\.status === "copying"/);
    assert.doesNotMatch(source, /if \(button\.isConnected\)/);
    assert.match(source, /fomo-holder-name/);
    assert.doesNotMatch(source, /gmgnWalletUrl/);
  }
  assert.match(background, /resolveFomoHolderAddress/);
  assert.match(background, /chrome\.offscreen\.createDocument/);
  assert.match(background, /reasons: \["CLIPBOARD", "WORKERS"\]/);
  assert.match(background, /resolvedHolderAddresses/);
  assert.equal(fs.existsSync("offscreen.html"), true);
  assert.equal(fs.existsSync("src/offscreen.js"), true);
  assert.match(fomoApi, /\/trades\/\$\{encodeURIComponent\(tradeId\)\}/);
  assert.match(fomoApi, /holderIdentifier\(trade\.id\) !== expectedTradeId/);
  assert.match(fomoApi, /holderIdentifier\(response\.userId\) !== expectedUserId/);
  assert.doesNotMatch(fomoApi, /holder\.user\?\.evmAddress|holder\.user\?\.address/);
  assert.match(fomoApi, /\/vas\/api\/v1\/token_holders/);
  assert.match(fomoApi, /sanitizeVerifiedHolderAddress/);
  assert.match(fomoApi, /HOLDER_CHAIN_DATA_AMBIGUOUS/);
  assert.doesNotMatch(background, /sanitizeTradeAddress/);
  assert.match(styles, /\.fomo-holder-name:hover/);
  assert.match(styles, /\.fomo-avatar-profile/);
  assert.match(styles, /\.fomo-avatar\.profile/);
  assert.match(styles, /cursor: copy/);
});

test("Fomo 与 Pump Holder 头像右下角支持关注、取消关注并清理该用户交易", () => {
  const background = fs.readFileSync("src/background.js", "utf8");
  const content = fs.readFileSync("src/content.js", "utf8");
  const sidePanel = fs.readFileSync("src/sidepanel.js", "utf8");
  const styles = fs.readFileSync("src/panel.css", "utf8");
  for (const source of [content, sidePanel]) {
    assert.match(source, /function holderFollowControl/);
    assert.match(source, /type: "queryHolderFollowStates"/);
    assert.match(source, /type: "toggleHolderFollow"/);
    assert.match(source, /following: !following/);
    assert.match(source, /following \? "✓" : "\+"/);
    assert.match(source, /sourceState === null \? "…"/);
    assert.match(source, /holderFollowRequestForce/);
    assert.match(source, /return holderFollowRequest\.then\(\(\) => refreshHolderFollowStates\(true\)\)/);
    assert.match(source, /Unfollow \$\{holder\.displayName\} and clear tracked trades/);
    assert.match(source, /holderAvatarControl\(holder, followControl\)/);
    assert.match(source, /if \(followControl\) wrapper\.append\(followControl\)/);
    assert.match(source, /refreshHolderFollowStates\(force\)/);
    assert.doesNotMatch(source, /nameLine\.append\(followControl\)/);
  }
  assert.match(styles, /\.fomo-avatar-wrap/);
  assert.match(styles, /\.fomo-holder-follow/);
  assert.match(styles, /right: -3px/);
  assert.match(styles, /bottom: -3px/);
  assert.match(background, /function purgeFollowedTradesForIdentity/);
  assert.match(background, /followedTradeMatchesIdentity/);
  assert.match(background, /persistFollowedTradesHistory/);
  assert.match(background, /unfollowedTradeIdentities/);
  assert.match(background, /pumpProfileTradesSnapshot/);
  assert.match(background, /fomoAlertRestSnapshot/);
});
