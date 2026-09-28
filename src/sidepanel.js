(function startNativeSidePanel() {
  "use strict";

  const core = globalThis.GmgnFomoCore;
  const pumpApi = globalThis.GmgnPumpApi;
  if (!core || !pumpApi) return;

  const REFRESH_MS = 5_000;
  const ROUTE_SETTLE_MS = 300;
  const TOKEN_LOAD_TIMEOUT_MS = 13_000;
  const SIDE_PANEL_HEARTBEAT_MS = 20_000;
  const SIDE_PANEL_RECONNECT_MS = 500;
  let currentRoute = null;
  let currentData = null;
  let currentPumpItems = [];
  let activeTab = "holders";
  let requestVersion = 0;
  let activeLoad = null;
  let routeLoadTimer = null;
  const holderCopyStates = new Map();
  const holderFollowActions = new Map();
  let holderFollowState = { fomo: null, pump: null, errors: {} };
  let holderFollowStateFingerprint = "";
  let holderFollowRequest = null;
  let holderFollowRequestForce = false;

  const content = document.querySelector("[data-role='content']");
  const panel = document.querySelector(".fomo-panel");
  const pumpNotice = document.querySelector("[data-role='pump-notice']");
  const status = document.querySelector("[data-role='status']");
  const openFomo = document.querySelector("[data-role='open-fomo']");
  const trackingToggle = document.querySelector("[data-role='tracking-toggle']");
  let trackingEnabled = true;
  let visibilityPort = null;
  let visibilityHeartbeatTimer = null;
  let visibilityReconnectTimer = null;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function pumpPlatformLogo() {
    const image = document.createElement("img");
    image.className = "fomo-platform-logo pump";
    image.alt = "Pump";
    image.title = image.alt;
    image.src = chrome.runtime.getURL("assets/pump.svg");
    return image;
  }

  function normalizedFollowWallet(value) {
    return core.normalizeWalletAddress(value, core.TOKEN_NETWORK_IDS.sol)
      || core.normalizeWalletAddress(value, core.TOKEN_NETWORK_IDS.eth)
      || "";
  }

  function holderActionKey(holder, route) {
    const userId = typeof holder?.userId === "string" ? holder.userId.trim() : "";
    const wallet = normalizedFollowWallet(holder?.walletAddress);
    return `${route.networkId}:${route.address.toLowerCase()}:${holder?.platform || "fomo"}:${userId || wallet || holder?.id || holder?.displayName}`;
  }

  function holderFollowKey(holder) {
    const userId = typeof holder?.userId === "string" ? holder.userId.trim() : "";
    const wallet = normalizedFollowWallet(holder?.walletAddress);
    return `${holder?.platform || "fomo"}:${userId || wallet}`;
  }

  function rerenderHolderActions() {
    if (currentData && activeTab === "holders" && currentRoute) renderHolders();
  }

  function applyHolderFollowState(result) {
    const errors = result?.errors && typeof result.errors === "object" ? result.errors : {};
    const fomo = errors.fomo
      ? null
      : new Set((Array.isArray(result?.states?.fomo) ? result.states.fomo : [])
        .filter((value) => typeof value === "string" && value));
    let pump = null;
    if (!errors.pump) {
      pump = { userIds: new Set(), wallets: new Set() };
      for (const item of Array.isArray(result?.states?.pump) ? result.states.pump : []) {
        if (typeof item?.userId === "string" && item.userId.trim()) pump.userIds.add(item.userId.trim());
        for (const value of [item?.address, item?.evmAddress]) {
          const wallet = normalizedFollowWallet(value);
          if (wallet) pump.wallets.add(wallet);
        }
      }
    }
    const fingerprint = JSON.stringify([fomo && [...fomo].sort(),
      pump && [...pump.userIds].sort(), pump && [...pump.wallets].sort(), errors]);
    const changed = fingerprint !== holderFollowStateFingerprint;
    holderFollowStateFingerprint = fingerprint;
    holderFollowState = { fomo, pump, errors };
    return changed;
  }

  function refreshHolderFollowStates(force = false) {
    if (holderFollowRequest) {
      if (!force || holderFollowRequestForce) return holderFollowRequest;
      return holderFollowRequest.then(() => refreshHolderFollowStates(true));
    }
    holderFollowRequestForce = force;
    holderFollowRequest = sendMessage({ type: "queryHolderFollowStates", force })
      .then((result) => {
        if (result?.ok && applyHolderFollowState(result)) rerenderHolderActions();
        return result;
      })
      .catch((error) => {
        holderFollowStateFingerprint = "";
        holderFollowState = {
          fomo: null,
          pump: null,
          errors: { fomo: error?.message || "FOLLOW_STATE_FAILED", pump: error?.message || "FOLLOW_STATE_FAILED" },
        };
        rerenderHolderActions();
        return null;
      })
      .finally(() => {
        holderFollowRequest = null;
        holderFollowRequestForce = false;
      });
    return holderFollowRequest;
  }

  function holderIsFollowed(holder) {
    const userId = typeof holder?.userId === "string" ? holder.userId.trim() : "";
    if (holder?.platform === "fomo") return Boolean(userId && holderFollowState.fomo?.has(userId));
    const wallet = normalizedFollowWallet(holder?.walletAddress);
    return Boolean(
      (userId && holderFollowState.pump?.userIds.has(userId))
      || (wallet && holderFollowState.pump?.wallets.has(wallet)),
    );
  }

  function holderFollowControl(holder) {
    const platform = holder?.platform === "pump" ? "pump" : "fomo";
    const userId = typeof holder?.userId === "string" ? holder.userId.trim() : "";
    if (!userId) return null;
    const sourceState = holderFollowState[platform];
    const key = holderFollowKey(holder);
    const action = holderFollowActions.get(key);
    const following = holderIsFollowed(holder);
    const label = action?.status === "pending"
      ? "…"
      : action?.status === "error"
        ? "!"
        : sourceState === null ? "…" : following ? "✓" : "+";
    const button = element("button", `fomo-holder-follow${following ? " following" : ""}${action?.status === "error" ? " error" : ""}`, label);
    button.type = "button";
    button.disabled = sourceState === null || action?.status === "pending";
    button.title = action?.status === "error"
      ? `Follow action failed: ${action.error}`
      : sourceState === null
        ? `Follow status unavailable: ${holderFollowState.errors[platform] || "loading"}`
        : following ? `Unfollow ${holder.displayName} and clear tracked trades` : `Follow ${holder.displayName}`;
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(following));
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (holderFollowActions.get(key)?.status === "pending") return;
      holderFollowActions.set(key, { status: "pending" });
      rerenderHolderActions();
      try {
        const result = await sendMessage({
          type: "toggleHolderFollow",
          platform,
          userId,
          walletAddress: holder.walletAddress || "",
          following: !following,
        });
        if (!result?.ok) throw new Error(result?.error || "FOLLOW_ACTION_FAILED");
        holderFollowActions.delete(key);
        await refreshHolderFollowStates();
      } catch (error) {
        holderFollowActions.set(key, { status: "error", error: error?.message || "FOLLOW_ACTION_FAILED" });
        rerenderHolderActions();
        setTimeout(() => {
          if (holderFollowActions.get(key)?.status === "error") {
            holderFollowActions.delete(key);
            rerenderHolderActions();
          }
        }, 2_000);
      }
    });
    return button;
  }

  function holderNameControl(holder, route) {
    const directAddress = core.normalizeWalletAddress(holder.walletAddress, route.networkId);
    const canResolveFomo = holder.platform === "fomo"
      && typeof holder.tradeId === "string" && holder.tradeId
      && typeof holder.userId === "string" && holder.userId
      && core.decimalString(holder.humanAmountRaw ?? holder.humanAmount) !== null;
    const canResolvePump = holder.platform === "pump"
      && typeof holder.userId === "string" && holder.userId;
    if (!directAddress && !canResolveFomo && !canResolvePump) {
      return element("strong", "", holder.displayName);
    }
    const key = holderActionKey(holder, route);
    const state = holderCopyStates.get(key);
    const label = state?.status === "copying"
      ? "Copying…"
      : state?.status === "copied" ? "Copied" : state?.status === "error" ? "Copy failed" : holder.displayName;
    const button = element("button", "fomo-holder-name", label);
    button.type = "button";
    button.title = state?.status === "error"
      ? `Copy failed: ${state.error}`
      : "Copy holder address";
    button.setAttribute("aria-label", `Copy address for ${holder.displayName}`);
    button.disabled = state?.status === "copying";
    if (state?.status === "copying") button.setAttribute("aria-busy", "true");
    button.addEventListener("click", async () => {
      if (holderCopyStates.get(key)?.status === "copying") return;
      holderCopyStates.set(key, { status: "copying" });
      rerenderHolderActions();
      try {
        let address = directAddress;
        if (!address) {
          const response = await sendMessage({
            type: canResolvePump ? "resolvePumpHolderAddress" : "resolveFomoHolderAddress",
            params: { address: route.address, networkId: route.networkId },
            holder: {
              tradeId: holder.tradeId,
              userId: holder.userId,
              humanAmount: holder.humanAmount,
              humanAmountRaw: holder.humanAmountRaw,
            },
          });
          if (!response?.ok) throw new Error(response?.error || "HOLDER_ADDRESS_NOT_FOUND");
          address = core.normalizeWalletAddress(response.address, route.networkId);
          if (!address) throw new Error("HOLDER_ADDRESS_NOT_FOUND");
        }
        const copyResponse = await sendMessage({
          type: "copyHolderAddress",
          address,
          networkId: route.networkId,
        });
        if (!copyResponse?.ok) throw new Error(copyResponse?.error || "CLIPBOARD_WRITE_FAILED");
        holderCopyStates.set(key, { status: "copied" });
      } catch (error) {
        holderCopyStates.set(key, { status: "error", error: error?.message || "UNKNOWN_ERROR" });
      }
      rerenderHolderActions();
      setTimeout(() => {
        const current = holderCopyStates.get(key);
        if (current?.status === "copied" || current?.status === "error") {
          holderCopyStates.delete(key);
          rerenderHolderActions();
        }
      }, 900);
    });
    return button;
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timeout !== null) clearTimeout(timeout);
        callback(value);
      };
      const timeout = message?.type === "queryFomoToken"
        ? setTimeout(() => finish(reject, new Error("FOMO_REQUEST_TIMEOUT")), TOKEN_LOAD_TIMEOUT_MS)
        : null;
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) finish(reject, new Error(chrome.runtime.lastError.message));
        else finish(resolve, response);
      });
    });
  }

  function setTrackingToggleState(enabled, pending = false) {
    trackingEnabled = enabled;
    if (!trackingToggle) return;
    trackingToggle.checked = enabled;
    trackingToggle.disabled = pending;
  }

  async function refreshTrackingToggle() {
    const result = await sendMessage({ type: "getFollowedTradesEnabled" }).catch(() => null);
    if (!result?.ok) return;
    setTrackingToggleState(Boolean(result.enabled));
    if (!result.enabled) {
      pumpNotice.hidden = true;
      panel.classList.remove("pump-login-required");
    }
  }

  if (trackingToggle) {
    trackingToggle.addEventListener("change", async () => {
      const previous = trackingEnabled;
      const enabled = trackingToggle.checked;
      setTrackingToggleState(enabled, true);
      if (!enabled) {
        pumpNotice.hidden = true;
        panel.classList.remove("pump-login-required");
      }
      try {
        const result = await sendMessage({ type: "setFollowedTradesEnabled", enabled });
        if (!result?.ok) throw new Error(result?.error || "FOLLOWED_TRADES_SETTING_FAILED");
        setTrackingToggleState(Boolean(result.enabled));
      } catch {
        setTrackingToggleState(previous);
      }
    });
  }

  function fomoTokenUrl(route) {
    return `https://fomo.family/tokens/${route.fomoChain}/${encodeURIComponent(route.address)}`;
  }

  function fallbackInitial(value) {
    return [...String(value || "?").trim()][0]?.toUpperCase() || "?";
  }

  function avatar(url, name, sizeClass = "") {
    const wrapper = element("div", `fomo-avatar ${sizeClass}`.trim(), fallbackInitial(name));
    wrapper._avatarKey = JSON.stringify([url || "", fallbackInitial(name), sizeClass]);
    if (!url) return wrapper;
    const image = document.createElement("img");
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("load", () => wrapper.classList.add("has-image"), { once: true });
    image.addEventListener("error", () => image.remove(), { once: true });
    image.src = url;
    wrapper.append(image);
    return wrapper;
  }

  function holderAvatarControl(holder, followControl) {
    const control = avatar(holder.profilePictureLink, holder.displayName);
    const wrapper = element("div", "fomo-avatar-wrap");
    const profileUrl = core.safeHttpsUrl(holder.profileUrl);
    if (profileUrl) {
      const link = element("a", "fomo-avatar-profile");
      link.href = profileUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = `Open ${holder.platform === "pump" ? "Pump" : "Fomo"} profile`;
      link.setAttribute("aria-label", `${link.title} for ${holder.displayName}`);
      control.classList.add("profile");
      link.append(control);
      wrapper.append(link);
    } else {
      wrapper.append(control);
    }
    if (followControl) wrapper.append(followControl);
    return wrapper;
  }

  function signedClass(value) {
    const number = core.finiteNumber(value);
    if (number === null || number === 0) return "neutral";
    return number > 0 ? "positive" : "negative";
  }

  function signedArrow(value) {
    const number = core.finiteNumber(value);
    if (number === null || number === 0) return "";
    return number > 0 ? "▲" : "▼";
  }

  function emptyState(title, detail = "") {
    const wrapper = element("div", "fomo-empty");
    wrapper.append(element("strong", "", title));
    if (detail) wrapper.append(element("p", "", detail));
    return wrapper;
  }

  function showLoading() {
    const loading = element("div", "fomo-loading");
    loading.append(element("i"), element("i"), element("i"));
    content.replaceChildren(loading);
  }

  function renderIdle() {
    currentData = null;
    document.querySelector("[data-role='token-avatar']").replaceChildren(avatar(null, "G", "token"));
    document.querySelector("[data-role='token-name']").textContent = "GMGN Fomo Pump Panel";
    document.querySelector("[data-role='token-symbol']").textContent = "等待 GMGN Token…";
    document.querySelector("[data-role='market-cap']").textContent = "— MC";
    const change = document.querySelector("[data-role='change-24']");
    change.className = "fomo-change neutral";
    change.textContent = "—";
    openFomo.hidden = true;
    status.textContent = "Waiting for a GMGN token…";
    content.replaceChildren(emptyState("打开一个 GMGN Token", "侧边栏会自动同步对应的 fomo.family 数据。"));
  }

  function renderPendingHeader(route) {
    document.querySelector("[data-role='token-avatar']").replaceChildren(avatar(null, route.chain, "token"));
    document.querySelector("[data-role='token-name']").textContent = "Loading token…";
    document.querySelector("[data-role='token-symbol']").textContent = `${route.chain.toUpperCase()} · ${route.address.slice(0, 6)}…${route.address.slice(-4)}`;
    document.querySelector("[data-role='market-cap']").textContent = "— MC";
    const change = document.querySelector("[data-role='change-24']");
    change.className = "fomo-change neutral";
    change.textContent = "—";
  }

  function renderHeader(metadata) {
    updateTokenAvatar(document.querySelector("[data-role='token-avatar']"), metadata.imageUrl, metadata.symbol || metadata.name);
    document.querySelector("[data-role='token-name']").textContent = metadata.name;
    document.querySelector("[data-role='token-symbol']").textContent = `${metadata.symbol || "TOKEN"} · ${metadata.address.slice(0, 6)}…${metadata.address.slice(-4)}`;
    document.querySelector("[data-role='market-cap']").textContent = `${core.compactUsd(metadata.marketCap)} MC`;

    const change = document.querySelector("[data-role='change-24']");
    const percent = metadata.change24 === null ? null : metadata.change24 * 100;
    change.className = `fomo-change ${signedClass(percent)}`;
    change.textContent = percent === null ? "—" : `${signedArrow(percent)} ${core.percent(percent)}`;
  }

  function renderPositionSummary(holders) {
    const summary = element("section", "fomo-position-summary");
    const copy = element("div", "fomo-position-summary-copy");
    copy.append(element(
      "span",
      "",
      holders.isFomoPositionValueComplete
        ? "Fomo 持仓总额"
        : `Fomo Top ${holders.pricedPositionCount || holders.fomoPositionCount} 持仓`,
    ));
    copy.append(element(
      "small",
      "",
      holders.isFomoPositionValueComplete
        ? `${core.compactNumber(holders.fomoPositionCount, 0)} 个 Fomo 仓位`
        : "接口已达到 100 条上限，金额不代表全量",
    ));
    const metrics = element("div", "fomo-position-summary-metrics");
    metrics.append(element("strong", "", core.preciseUsd(holders.fomoPositionValue)));
    if (core.finiteNumber(holders.fomoOwnershipPercent) !== null) {
      metrics.append(element(
        "span",
        "",
        `Holding: ${holders.isFomoOwnershipComplete ? "" : "Top 100 "}${core.holdingPercent(holders.fomoOwnershipPercent)}`,
      ));
    }
    summary.append(copy, metrics);
    return summary;
  }

  function holderRenderKey(holder, route, totalSupply) {
    const platform = holder.platform === "pump" ? "pump" : "fomo";
    // Price-only updates retain buttons, listeners, comments and decoded images.
    const identity = [holder.platform, holder.id, holder.userId, holder.walletAddress,
      holder.displayName, holder.tradeId, holder.humanAmountRaw, holder.humanAmount,
      holder.profilePictureLink, holder.profileUrl, holder.ownershipPercent,
      holder.averageEntryPrice, holder.isDev, holder.comment, holder.likes];
    const pnl = core.finiteNumber(holder.pnlPercent) ?? core.holderPnlPercent(holder);
    return JSON.stringify([identity, totalSupply,
      core.finiteNumber(holder.value) !== null, pnl !== null,
      holderCopyStates.get(holderActionKey(holder, route)),
      holderFollowActions.get(holderFollowKey(holder)), holderIsFollowed(holder),
      holderFollowState[platform] === null, holderFollowState.errors[platform]]);
  }

  function updateHolderMetrics(card, holder) {
    const metrics = card.querySelector(".fomo-holder-metrics");
    if (!metrics) return;
    const value = metrics.querySelector("strong");
    if (value) {
      const text = core.preciseUsd(holder.value);
      if (value.textContent !== text) value.textContent = text;
    }
    const pnl = metrics.querySelector("span");
    if (pnl) {
      const percent = core.finiteNumber(holder.pnlPercent) ?? core.holderPnlPercent(holder);
      const text = percent === null ? "—" : `${signedArrow(percent)} ${core.percent(percent)}`;
      if (pnl.textContent !== text) pnl.textContent = text;
      const className = signedClass(percent);
      if (pnl.className !== className) pnl.className = className;
    }
  }

  function updateHolderContent(container, nodes) {
    // Remove obsolete slots first: otherwise a replaced summary shifts every
    // index and unnecessarily detaches/reinserts all surviving holder cards.
    const retained = new Set(nodes);
    for (const child of Array.from(container.children)) {
      if (!retained.has(child)) child.remove();
    }
    // Leave unchanged cards attached, including decoded images and expanded text.
    nodes.forEach((node, index) => {
      if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null);
    });
  }

  function updateHolderCard(previous, next) {
    if (!previous) return next;
    const oldAvatar = previous.querySelector(".fomo-avatar");
    const nextAvatar = next.querySelector(".fomo-avatar");
    if (oldAvatar && nextAvatar && oldAvatar._avatarKey === nextAvatar._avatarKey) {
      oldAvatar.classList.toggle("profile", nextAvatar.classList.contains("profile"));
      nextAvatar.replaceWith(oldAvatar);
    }
    if (previous._commentKey === next._commentKey) {
      const oldComment = previous.querySelector(".fomo-comment");
      const nextComment = next.querySelector(".fomo-comment");
      if (oldComment && nextComment) nextComment.replaceWith(oldComment);
    }
    previous.replaceChildren(...next.childNodes);
    previous.className = "fomo-holder";
    previous._renderKey = next._renderKey;
    previous._commentKey = next._commentKey;
    return previous;
  }

  function updateTokenAvatar(slot, url, name) {
    const key = JSON.stringify([url || "", fallbackInitial(name), "token"]);
    if (slot.firstElementChild?._avatarKey !== key) slot.replaceChildren(avatar(url, name, "token"));
  }

  function renderHolders(animatePump = false) {
    const { metadata, holders } = currentData;
    const previousCards = new Map(Array.from(content.children)
      .filter(node => node._holderKey).map(node => [node._holderKey, node]));
    const summary = renderPositionSummary(holders);
    const previousSummary = content.firstElementChild;
    const nodes = [previousSummary?.isEqualNode(summary) ? previousSummary : summary];
    if (!holders.items.length) {
      nodes.push(emptyState("No Fomo holders found for this token."));
      updateHolderContent(content, nodes);
      return;
    }

    for (const holder of holders.items) {
      const key = `${holderActionKey(holder, currentRoute)}:${holder.id || holder.walletAddress || ""}`;
      const previous = previousCards.get(key);
      previousCards.delete(key);
      const renderKey = holderRenderKey(holder, currentRoute, metadata.totalSupply);
      if (previous?._renderKey === renderKey) {
        updateHolderMetrics(previous, holder);
        nodes.push(previous);
        continue;
      }
      const isPump = holder.platform === "pump";
      const article = element("article", `fomo-holder${animatePump && isPump ? " pump-enter" : ""}`);
      article._holderKey = key;
      article._renderKey = renderKey;
      article._commentKey = JSON.stringify([holder.comment, holder.likes]);
      const row = element("div", "fomo-holder-row");
      const nameControl = holderNameControl(holder, currentRoute);
      const followControl = holderFollowControl(holder);
      row.append(holderAvatarControl(holder, followControl));

      const identity = element("div", "fomo-identity");
      const nameLine = element("div", "fomo-name-line");
      nameLine.append(nameControl);
      if (holder.platform === "pump") nameLine.append(pumpPlatformLogo());
      if (core.finiteNumber(holder.ownershipPercent) !== null) {
        nameLine.append(element("span", "fomo-ownership-badge", core.holdingPercent(holder.ownershipPercent)));
      }
      if (holder.isDev) nameLine.append(element("span", "fomo-dev", "DEV"));
      identity.append(nameLine);
      const entryMc = core.averageEntryMarketCap(holder, metadata.totalSupply);
      if (!isPump || entryMc !== null) {
        identity.append(element("div", "fomo-subtle", `Avg. entry: ${core.compactUsd(entryMc)} MC`));
      }
      row.append(identity);

      const metrics = element("div", "fomo-holder-metrics");
      const holderValue = core.finiteNumber(holder.value);
      if (!isPump || holderValue !== null) {
        metrics.append(element("strong", "", core.preciseUsd(holder.value)));
      }
      const explicitPnlPercent = core.finiteNumber(holder.pnlPercent);
      const pnlPercent = explicitPnlPercent === null ? core.holderPnlPercent(holder) : explicitPnlPercent;
      if (!isPump || pnlPercent !== null) {
        metrics.append(element(
          "span",
          signedClass(pnlPercent),
          pnlPercent === null ? "—" : `${signedArrow(pnlPercent)} ${core.percent(pnlPercent)}`,
        ));
      }
      if (!isPump || metrics.childElementCount) row.append(metrics);
      article.append(row);

      if (holder.comment) {
        const comment = element("div", "fomo-comment");
        const text = element("p", holder.comment.length > 180 ? "clamped" : "", holder.comment);
        comment.append(text);
        if (holder.comment.length > 180) {
          const more = element("button", "fomo-read-more", "Read more");
          more.type = "button";
          more.addEventListener("click", () => {
            const expanded = text.classList.toggle("expanded");
            more.textContent = expanded ? "Show less" : "Read more";
          });
          comment.append(more);
        }
        if (holder.likes) comment.append(element("div", "fomo-likes", `♡ ${holder.likes}`));
        article.append(comment);
      }
      nodes.push(updateHolderCard(previous, article));
    }
    updateHolderContent(content, nodes);
  }

  const FEED_LABELS = Object.freeze({
    swap_buy: ["Buy", "buy"],
    swap_sell: ["Sell", "sell"],
    transfer_in: ["Receive", "transfer"],
    transfer_out: ["Send", "transfer"],
  });

  function renderFeed() {
    const fragment = document.createDocumentFragment();
    if (!currentData.feed.length) {
      fragment.append(emptyState("No Buy, Sell or Transfer activity found."));
      content.replaceChildren(fragment);
      return;
    }

    for (const item of currentData.feed) {
      const article = element("article", "fomo-feed-item");
      article.append(avatar(item.profilePictureLink, item.displayName));
      const copy = element("div", "fomo-feed-copy");
      const line = element("div", "fomo-feed-line");
      line.append(element("strong", "", item.displayName));
      if (item.isDev) line.append(element("span", "fomo-dev", "DEV"));
      const [label, className] = FEED_LABELS[item.type];
      line.append(element("span", `fomo-feed-type ${className}`, label));
      line.append(element("time", "", core.relativeTime(item.createdAt)));
      copy.append(line);
      copy.append(element(
        "div",
        "fomo-feed-value",
        `${core.compactUsd(item.usdAmount)} at ${core.compactUsd(item.marketCap)} MC`,
      ));
      article.append(copy);
      fragment.append(article);
    }
    content.replaceChildren(fragment);
  }

  function aboutStat(label, value) {
    const item = element("div", "fomo-about-stat");
    item.append(element("span", "", label), element("strong", "", value));
    return item;
  }

  function renderAbout() {
    const { metadata, holders } = currentData;
    const wrapper = element("div", "fomo-about");
    wrapper.append(element("h2", "", `About ${metadata.symbol || metadata.name}`));
    wrapper.append(element("p", "fomo-about-description", metadata.description || "No description provided by fomo.family."));

    const stats = element("div", "fomo-about-grid");
    stats.append(
      aboutStat("Market cap", core.compactUsd(metadata.marketCap)),
      aboutStat("Price", core.compactUsd(metadata.priceUsd, 4)),
      aboutStat("24H volume", core.compactUsd(metadata.volume24)),
      aboutStat("Liquidity", core.compactUsd(metadata.liquidity)),
      aboutStat("Holders", core.compactNumber(holders.totalHolders)),
      aboutStat(
        holders.isFomoPositionValueComplete ? "Fomo positions" : "Fomo top positions",
        core.compactUsd(holders.fomoPositionValue),
      ),
      ...(core.finiteNumber(holders.fomoOwnershipPercent) === null ? [] : [aboutStat(
        holders.isFomoOwnershipComplete ? "Fomo ownership" : "Fomo Top 100 ownership",
        core.holdingPercent(holders.fomoOwnershipPercent),
      )]),
      aboutStat("Supply", core.compactNumber(metadata.totalSupply)),
    );
    wrapper.append(stats);

    const details = element("div", "fomo-about-details");
    details.append(aboutStat("Network", currentRoute.fomoChain));
    if (metadata.launchpad.name) details.append(aboutStat("Launchpad", metadata.launchpad.name));
    details.append(aboutStat("Contract address", `${metadata.address.slice(0, 8)}…${metadata.address.slice(-6)}`));
    wrapper.append(details);

    const links = element("div", "fomo-socials");
    for (const [name, url] of Object.entries(metadata.socialLinks)) {
      const link = element("a", "", name === "twitter" ? "X / Twitter" : `${name[0].toUpperCase()}${name.slice(1)}`);
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      links.append(link);
    }
    wrapper.append(links);
    content.replaceChildren(wrapper);
  }

  function renderActiveTab() {
    if (!currentData) return;
    if (activeTab === "feed") renderFeed();
    else if (activeTab === "about") renderAbout();
    else renderHolders();
  }

  function renderError(error) {
    const refreshingSession = error === "FOMO_SESSION_REFRESHING";
    const needsLogin = refreshingSession
      || error === "FOMO_NOT_CONNECTED"
      || error === "FOMO_SESSION_EXPIRED";
    const wrapper = emptyState(
      refreshingSession
        ? "Refreshing fomo.family session"
        : needsLogin ? "Connect fomo.family" : "Unable to load this token",
      needsLogin
        ? refreshingSession
          ? "The extension is reconnecting in the background and will retry shortly."
          : "Open the matching token on Fomo, then return here and retry."
        : "The Fomo API did not return data for this token. Try again shortly.",
    );
    const actions = element("div", "fomo-error-actions");
    const link = element("a", "primary", "Open token on Fomo ↗");
    link.href = fomoTokenUrl(currentRoute);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const retry = element("button", "", "Retry");
    retry.type = "button";
    retry.addEventListener("click", () => load(false, true));
    if (!refreshingSession) actions.append(link);
    actions.append(retry);
    wrapper.append(actions);
    content.replaceChildren(wrapper);
    status.textContent = error || "FOMO_REQUEST_FAILED";
  }

  function pumpLoginRequired(sources) {
    return ["PUMP_SESSION_REQUIRED", "PUMP_SESSION_EXPIRED"]
      .includes(sources?.pump?.error);
  }

  async function refreshPumpNotice() {
    const result = await sendMessage({ type: "getFollowedTradeSources" }).catch(() => null);
    if (!result?.ok) return;
    const visible = trackingEnabled && pumpLoginRequired(result.sources);
    pumpNotice.hidden = !visible;
    panel.classList.toggle("pump-login-required", visible);
  }

  function withPumpItems(data, pumpItems) {
    return {
      ...data,
      holders: {
        ...data.holders,
        items: pumpApi.mergeHolderItems(data.holders?.items, pumpItems),
      },
    };
  }

  function load(silent = false, force = false) {
    if (!currentRoute) {
      renderIdle();
      return Promise.resolve();
    }
    if (routeLoadTimer !== null) {
      if (!force) return Promise.resolve();
      clearTimeout(routeLoadTimer);
      routeLoadTimer = null;
    }
    if (activeLoad?.version === requestVersion) return activeLoad.promise;
    const version = requestVersion;
    const entry = { version, promise: null };
    if (!silent) {
      status.textContent = "Loading fomo.family…";
      showLoading();
    }
    entry.promise = (async () => {
      try {
        const route = currentRoute;
        const result = await sendMessage({
          type: "queryFomoToken",
          params: { address: route.address, networkId: route.networkId },
          includeFeed: activeTab === "feed",
          force,
        });
        if (version !== requestVersion || !currentRoute) return;
        if (!result?.ok) return renderError(result?.error);
        const fomoData = result.data;
        const updatedAt = result.cached ? result.cachedAt : Date.now();
        const label = result.cached ? "Cached" : result.partial ? "Partially updated" : "Updated";
        const updatedLabel = `${label} ${new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
        currentData = withPumpItems(fomoData, currentPumpItems);
        renderHeader(currentData.metadata);
        renderActiveTab();
        status.textContent = updatedLabel;
        if (activeTab !== "holders") return;
        if (typeof refreshHolderFollowStates === "function") {
          refreshHolderFollowStates(force);
        }

        const pumpResult = await sendMessage({
          type: "queryPumpHolders",
          params: { address: route.address, networkId: route.networkId },
          metadata: fomoData.metadata,
        }).catch(() => null);
        if (version !== requestVersion || !currentRoute) return;
        const hadPumpItems = currentPumpItems.length > 0;
        if (pumpResult?.ok) {
          currentPumpItems = Array.isArray(pumpResult.items) ? pumpResult.items : [];
        }
        currentData = withPumpItems(fomoData, currentPumpItems);
        const animatePump = !hadPumpItems && currentPumpItems.length > 0;
        if (pumpResult?.ok && activeTab === "holders") {
          renderHolders(animatePump);
        }
      } catch (error) {
        if (version === requestVersion) renderError(error?.message);
      }
    })().finally(() => {
      if (activeLoad === entry) activeLoad = null;
    });
    activeLoad = entry;
    return entry.promise;
  }

  function setRoute(route) {
    const nextKey = route ? `${route.chain}:${route.address}` : "";
    const currentKey = currentRoute ? `${currentRoute.chain}:${currentRoute.address}` : "";
    if (nextKey === currentKey) return false;
    currentRoute = route || null;
    currentData = null;
    currentPumpItems = [];
    requestVersion += 1;
    clearTimeout(routeLoadTimer);
    routeLoadTimer = null;
    if (!currentRoute) {
      renderIdle();
      return true;
    }
    openFomo.href = fomoTokenUrl(currentRoute);
    openFomo.hidden = false;
    renderPendingHeader(currentRoute);
    const version = requestVersion;
    routeLoadTimer = setTimeout(() => {
      routeLoadTimer = null;
      if (version === requestVersion && currentRoute && document.visibilityState === "visible") load();
    }, ROUTE_SETTLE_MS);
    return true;
  }

  function routeFromUrl(value) {
    try {
      return core.parseTokenRoute(new URL(value).pathname);
    } catch {
      return null;
    }
  }

  async function syncActiveTab(refreshCurrent = false) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const changed = setRoute(routeFromUrl(tab?.url));
      if (refreshCurrent && !changed && currentRoute) load(true);
    } catch {
      setRoute(null);
    }
  }

  function stopVisibilityHeartbeat() {
    if (visibilityHeartbeatTimer === null) return;
    clearInterval(visibilityHeartbeatTimer);
    visibilityHeartbeatTimer = null;
  }

  function reportSidePanelVisible(port) {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (visibilityPort !== port || !Number.isInteger(tab?.windowId)) return;
      port.postMessage({ type: "sidePanelVisible", windowId: tab.windowId });
    }).catch(() => {});
  }

  function scheduleVisibilityReconnect() {
    if (visibilityReconnectTimer !== null) return;
    visibilityReconnectTimer = setTimeout(() => {
      visibilityReconnectTimer = null;
      connectVisibilityPort();
    }, SIDE_PANEL_RECONNECT_MS);
  }

  function connectVisibilityPort() {
    if (visibilityPort) return;
    let port;
    try {
      if (!chrome.runtime?.id) return;
      port = chrome.runtime.connect({ name: "fomoSidePanelVisibility" });
    } catch {
      return;
    }
    visibilityPort = port;
    reportSidePanelVisible(port);
    stopVisibilityHeartbeat();
    visibilityHeartbeatTimer = setInterval(() => {
      reportSidePanelVisible(port);
    }, SIDE_PANEL_HEARTBEAT_MS);
    port.onDisconnect.addListener(() => {
      try {
        void chrome.runtime.lastError;
      } catch {}
      if (visibilityPort !== port) return;
      visibilityPort = null;
      stopVisibilityHeartbeat();
      try {
        if (chrome.runtime?.id) scheduleVisibilityReconnect();
      } catch {}
    });
  }

  function reloadAfterFomoSessionChange() {
    const version = requestVersion;
    const route = currentRoute;
    Promise.resolve(activeLoad?.promise)
      .catch(() => {})
      .finally(() => {
        if (version !== requestVersion || currentRoute !== route || !currentRoute) return;
        load(true);
      });
  }

  for (const button of document.querySelectorAll("[data-tab]")) {
    button.addEventListener("click", () => {
      activeTab = button.dataset.tab;
      for (const tab of document.querySelectorAll("[data-tab]")) {
        tab.classList.toggle("active", tab === button);
      }
      renderActiveTab();
      const tab = activeTab;
      const version = requestVersion;
      if (tab !== "about") Promise.resolve(activeLoad?.promise).catch(() => {}).then(() => {
        if (version === requestVersion && activeTab === tab && currentRoute) load(true);
      });
    });
  }

  document.querySelector("[data-role='refresh']").addEventListener("click", () => load(false, true));
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "sidePanelRouteChanged") {
      syncActiveTab();
    } else if (message?.type === "fomoSessionChanged") {
      reloadAfterFomoSessionChange();
    }
  });
  chrome.tabs.onActivated.addListener(syncActiveTab);
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (tab.active && changeInfo.url) setRoute(routeFromUrl(changeInfo.url));
  });
  document.addEventListener("visibilitychange", (event) => {
    if (!event.isTrusted) return;
    if (document.visibilityState === "visible") {
      refreshTrackingToggle();
      refreshPumpNotice();
      syncActiveTab(true);
    }
  });

  renderIdle();
  refreshTrackingToggle();
  refreshPumpNotice();
  connectVisibilityPort();
  syncActiveTab();
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    refreshPumpNotice();
    if (currentRoute) load(true);
  }, REFRESH_MS);
})();
