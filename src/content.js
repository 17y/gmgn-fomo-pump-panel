(function startFomoPanel() {
  "use strict";

  const core = globalThis.GmgnFomoCore;
  const pumpApi = globalThis.GmgnPumpApi;
  if (!core || !pumpApi) return;

  const HOST_ID = "gmgn-fomo-panel-host";
  const INSTANCE_ATTRIBUTE = "data-gmgn-fomo-panel-instance";
  const LAYOUT_KEY = "gmgnFomoPanelLayoutV1";
  const INITIAL_LOAD_SETTLE_MS = 500;
  const INITIAL_LOAD_IDLE_TIMEOUT_MS = 1_000;
  const TOKEN_LOAD_TIMEOUT_MS = 13_000;
  const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  document.documentElement.setAttribute(INSTANCE_ATTRIBUTE, instanceId);
  let currentKey = "";
  let currentRoute = null;
  let currentView = null;
  let currentData = null;
  let currentPumpItems = [];
  let requestVersion = 0;
  let activeLoad = null;
  let loadedVersion = -1;
  let holderExtrasLoad = null;
  let feedLoad = null;
  let extensionContextValid = true;
  let sidePanelVisible = false;
  let sidePanelStateReady = false;
  let pendingInitialLoad = null;
  let currentLayout = null;
  const holderCopyStates = new Map();
  const holderFollowActions = new Map();
  let holderFollowState = { fomo: null, pump: null, errors: {} };
  let holderFollowStateFingerprint = "";
  let holderFollowRequest = null;
  let holderFollowRequestForce = false;

  function isActiveInstance() {
    return extensionContextValid
      && document.documentElement.getAttribute(INSTANCE_ATTRIBUTE) === instanceId;
  }

  function extensionResourceUrl(path) {
    if (!isActiveInstance()) return null;
    try {
      return chrome.runtime.getURL(path);
    } catch {
      extensionContextValid = false;
      return null;
    }
  }

  function hideOverlayHost() {
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    host.hidden = true;
    host.dataset.gmgnFomoHidden = "true";
  }

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
    image.src = extensionResourceUrl("assets/pump.svg");
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
    if (currentData && currentView?.activeTab === "holders" && currentView.host.isConnected) {
      renderHolders(currentView);
    }
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
    holderFollowRequest = sendMessage({ type: "queryHolderFollowStates", force, params: currentView?.route, oncePerVisit: true })
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
    if (!isActiveInstance()) return Promise.reject(new Error("EXTENSION_RELOAD_REQUIRED"));
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
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            extensionContextValid = false;
            finish(reject, new Error("EXTENSION_RELOAD_REQUIRED"));
          } else {
            finish(resolve, response);
          }
        });
      } catch {
        extensionContextValid = false;
        finish(reject, new Error("EXTENSION_RELOAD_REQUIRED"));
      }
    });
  }

  function setTrackingToggleState(view, enabled, pending = false) {
    view.trackingEnabled = enabled;
    if (!view.trackingToggle) return;
    view.trackingToggle.checked = enabled;
    view.trackingToggle.disabled = pending;
  }

  function bindTrackingToggle(view) {
    if (!view.trackingToggle) return;
    view.trackingToggle.addEventListener("change", async () => {
      const previous = view.trackingEnabled;
      const enabled = view.trackingToggle.checked;
      setTrackingToggleState(view, enabled, true);
      if (!enabled) setPumpNotice(view, null);
      try {
        const result = await sendMessage({ type: "setFollowedTradesEnabled", enabled });
        if (!result?.ok) throw new Error(result?.error || "FOLLOWED_TRADES_SETTING_FAILED");
        setTrackingToggleState(view, Boolean(result.enabled));
      } catch {
        setTrackingToggleState(view, previous);
      }
    });
    sendMessage({ type: "getFollowedTradesEnabled" })
      .then((result) => {
        if (result?.ok && view.host.isConnected) {
          setTrackingToggleState(view, Boolean(result.enabled));
          if (!result.enabled) setPumpNotice(view, null);
        }
      })
      .catch(() => {});
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (result) => {
          resolve(chrome.runtime.lastError ? null : result?.[key] || null);
        });
      } catch {
        resolve(null);
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
    const wrapper = element("div", `fomo-avatar ${sizeClass}`.trim());
    wrapper.textContent = fallbackInitial(name);
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

  function createView(route) {
    const stylesheetUrl = extensionResourceUrl("src/panel.css");
    if (!stylesheetUrl) return null;
    document.getElementById(HOST_ID)?.remove();
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.position = "fixed";
    host.style.top = "82px";
    host.style.right = "18px";
    host.style.zIndex = "2147483000";
    host.style.visibility = "hidden";

    const shadow = host.attachShadow({ mode: "open" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = stylesheetUrl;
    shadow.append(stylesheet);

    const panel = element("aside", "fomo-panel");
    panel.innerHTML = `
      <header class="fomo-header">
        <div class="fomo-token-avatar" data-role="token-avatar"></div>
        <div class="fomo-token-copy">
          <div class="fomo-token-name" data-role="token-name">Loading token…</div>
          <div class="fomo-token-symbol" data-role="token-symbol"></div>
        </div>
        <div class="fomo-market">
          <div class="fomo-market-cap" data-role="market-cap">— MC</div>
          <div class="fomo-change neutral" data-role="change-24">—</div>
        </div>
        <div class="fomo-collapsed-position" data-role="collapsed-position" aria-hidden="true"></div>
        <button class="fomo-side-panel" type="button" aria-label="在浏览器侧边栏打开" title="在浏览器侧边栏打开">▥</button>
        <button class="fomo-collapse" type="button" aria-label="折叠 Fomo 浮层">−</button>
      </header>
      <nav class="fomo-tabs" aria-label="Fomo token tabs">
        <button type="button" class="active" data-tab="holders">Holders</button>
        <button type="button" data-tab="feed">Feed</button>
      </nav>
      <main class="fomo-body">
        <div class="fomo-content" data-role="content"><div class="fomo-loading"><i></i><i></i><i></i></div></div>
      </main>
      <section class="fomo-pump-notice" data-role="pump-notice" aria-live="polite" hidden>
        <img alt="" data-role="pump-notice-logo">
        <span><strong>Pump 数据未连接</strong><small>打开 Pump 检查会话，连接成功后提示会消失</small></span>
        <a href="https://pump.fun/?tab=friends" target="_blank" rel="noopener noreferrer">打开 Pump ↗</a>
      </section>
      <footer class="fomo-footer">
        <span data-role="status">Connecting to fomo.family…</span>
        <span class="fomo-footer-actions">
          <label class="fomo-tracking-toggle" title="把当前关注地址的交易推送到 GMGN 追踪；关闭后停止获取">
            <input type="checkbox" data-role="tracking-toggle" aria-label="关注交易推送到追踪" checked>
            <span>推送追踪</span><i aria-hidden="true"></i>
          </label>
          <button type="button" data-role="refresh">刷新</button>
          <a data-role="open-fomo" target="_blank" rel="noopener noreferrer">Open Fomo ↗</a>
        </span>
      </footer>`;
    shadow.append(panel);
    (document.body || document.documentElement).append(host);

    const view = {
      host,
      shadow,
      panel,
      stylesReady: Boolean(stylesheet.sheet),
      layoutReady: false,
      route,
      activeTab: "holders",
      content: shadow.querySelector("[data-role='content']"),
      collapsedPosition: shadow.querySelector("[data-role='collapsed-position']"),
      pumpNotice: shadow.querySelector("[data-role='pump-notice']"),
      trackingToggle: shadow.querySelector("[data-role='tracking-toggle']"),
      trackingEnabled: true,
      status: shadow.querySelector("[data-role='status']"),
    };
    stylesheet.addEventListener("load", () => {
      view.stylesReady = true;
      if (revealViewWhenReady(view)) saveLayout(view);
    }, { once: true });
    shadow.querySelector("[data-role='open-fomo']").href = fomoTokenUrl(route);
    shadow.querySelector("[data-role='pump-notice-logo']").src = extensionResourceUrl("assets/pump.svg");
    bindTrackingToggle(view);

    shadow.querySelector(".fomo-side-panel").addEventListener("click", (event) => {
      event.stopPropagation();
      sendMessage({ type: "openFomoSidePanel" }).catch(() => {});
    });
    shadow.querySelector("[data-role='refresh']").addEventListener("click", () => load(view, false, true));

    shadow.querySelector(".fomo-collapse").addEventListener("click", (event) => {
      event.stopPropagation();
      const collapsed = !panel.classList.contains("collapsed");
      if (collapsed) {
        const rect = panel.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          view.expandedLayout = {
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        }
      }
      setCollapsed(view, collapsed);
      keepOnScreen(view);
      saveLayout(view);
      if (!collapsed) {
        if (currentData) renderHeader(view, currentData.metadata);
        renderActiveTab(view);
        load(view, true);
      }
    });

    for (const button of shadow.querySelectorAll("[data-tab]")) {
      button.addEventListener("click", () => {
        view.activeTab = button.dataset.tab;
        for (const tab of shadow.querySelectorAll("[data-tab]")) {
          tab.classList.toggle("active", tab === button);
        }
        renderActiveTab(view);
        const tab = view.activeTab;
        const version = requestVersion;
        Promise.resolve(activeLoad?.promise).catch(() => {}).then(() => {
          if (version === requestVersion && view.activeTab === tab && canLoadView(view)) load(view, true);
        });
      });
    }

    enableDragging(view);
    restoreAndTrackLayout(view);
    return view;
  }

  function setCollapsed(view, collapsed) {
    view.panel.classList.toggle("collapsed", collapsed);
    view.collapsedPosition.setAttribute("aria-hidden", String(!collapsed));
    view.shadow.querySelector(".fomo-collapse").textContent = collapsed ? "+" : "−";
  }

  function revealViewWhenReady(view) {
    if (!view.stylesReady || !view.layoutReady || view !== currentView
      || !view.host.isConnected || view.host.hidden
      || view.host.dataset.gmgnFomoHidden === "true"
      || document.visibilityState !== "visible") return false;
    keepOnScreen(view);
    view.host.style.visibility = "visible";
    return true;
  }

  function keepOnScreen(view) {
    if (!view.host.isConnected || view.host.hidden
      || view.host.dataset.gmgnFomoHidden === "true") return;
    if (view.panel.classList.contains("collapsed") && view.stylesReady === false) return;
    const rect = view.panel.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const left = Math.min(Math.max(0, rect.left), Math.max(0, window.innerWidth - rect.width));
    const top = Math.min(Math.max(0, rect.top), Math.max(0, window.innerHeight - rect.height));
    view.host.style.left = `${left}px`;
    view.host.style.top = `${top}px`;
    view.host.style.right = "auto";
  }

  function saveLayout(view) {
    if (!view.host.isConnected || view.host.hidden
      || view.host.dataset.gmgnFomoHidden === "true") return;
    const rect = view.panel.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const collapsed = view.panel.classList.contains("collapsed");
    const width = collapsed ? view.expandedLayout?.width : Math.round(rect.width);
    const height = collapsed ? view.expandedLayout?.height : Math.round(rect.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    if (!collapsed) view.expandedLayout = { width, height };
    currentLayout = {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width,
      height,
      collapsed,
    };
    try {
      chrome.storage.local.set({
        [LAYOUT_KEY]: currentLayout,
      });
    } catch {
      // Extension reload invalidates old content scripts.
    }
  }

  async function restoreAndTrackLayout(view) {
    view.stopLayoutTracking?.();
    const layoutVersion = view.layoutVersion = (view.layoutVersion || 0) + 1;
    await Promise.resolve();
    const storedLayout = currentLayout || await storageGet(LAYOUT_KEY);
    if (!view.host.isConnected || view.host.hidden
      || view.host.dataset.gmgnFomoHidden === "true"
      || view !== currentView || view.layoutVersion !== layoutVersion
      || document.visibilityState !== "visible") return;
    const layout = currentLayout || storedLayout;
    if (layout && [layout.left, layout.top, layout.width, layout.height].every(Number.isFinite)
      && layout.width > 0 && layout.height > 0) {
      currentLayout = layout;
      view.panel.style.width = `${layout.width}px`;
      view.panel.style.height = `${layout.height}px`;
      view.host.style.left = `${layout.left}px`;
      view.host.style.top = `${layout.top}px`;
      view.host.style.right = "auto";
      view.expandedLayout = { width: layout.width, height: layout.height };
      setCollapsed(view, layout.collapsed === true);
    }
    view.layoutReady = true;
    revealViewWhenReady(view);

    let resizeTimer;
    const observer = new ResizeObserver(() => {
      if (!view.host.isConnected || view.host.hidden
        || view.host.dataset.gmgnFomoHidden === "true"
        || view !== currentView) {
        clearTimeout(resizeTimer);
        return observer.disconnect();
      }
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        keepOnScreen(view);
        saveLayout(view);
      }, 180);
    });
    view.stopLayoutTracking = () => {
      clearTimeout(resizeTimer);
      observer.disconnect();
      view.layoutTrackingActive = false;
    };
    observer.observe(view.panel);
    view.layoutTrackingActive = true;
  }

  function enableDragging(view) {
    const header = view.shadow.querySelector(".fomo-header");
    header.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button, a")) return;
      const rect = view.panel.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      view.host.style.left = `${rect.left}px`;
      view.host.style.top = `${rect.top}px`;
      view.host.style.right = "auto";
      view.panel.classList.add("dragging");
      header.setPointerCapture?.(event.pointerId);

      const move = (moveEvent) => {
        const maxLeft = Math.max(0, window.innerWidth - view.panel.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - view.panel.offsetHeight);
        view.host.style.left = `${Math.min(maxLeft, Math.max(0, rect.left + moveEvent.clientX - startX))}px`;
        view.host.style.top = `${Math.min(maxTop, Math.max(0, rect.top + moveEvent.clientY - startY))}px`;
      };
      const stop = () => {
        view.panel.classList.remove("dragging");
        saveLayout(view);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
      window.addEventListener("pointercancel", stop, { once: true });
      event.preventDefault();
    });
  }

  function renderHeader(view, metadata) {
    const avatarSlot = view.shadow.querySelector("[data-role='token-avatar']");
    updateTokenAvatar(avatarSlot, metadata.imageUrl, metadata.symbol || metadata.name);
    view.shadow.querySelector("[data-role='token-name']").textContent = metadata.name;
    view.shadow.querySelector("[data-role='token-symbol']").textContent = `${metadata.symbol || "TOKEN"} · ${metadata.address.slice(0, 6)}…${metadata.address.slice(-4)}`;
    view.shadow.querySelector("[data-role='market-cap']").textContent = `${core.compactUsd(metadata.marketCap)} MC`;

    const change = view.shadow.querySelector("[data-role='change-24']");
    const changePercent = metadata.change24 === null ? null : metadata.change24 * 100;
    change.className = `fomo-change ${signedClass(changePercent)}`;
    change.textContent = changePercent === null ? "—" : `${signedArrow(changePercent)} ${core.percent(changePercent)}`;
  }

  function emptyState(text) {
    return element("div", "fomo-empty", text);
  }

  function positionSummary(holders) {
    const summary = element("section", "fomo-position-summary");
    summary.classList.toggle("limited", !holders.isFomoPositionValueComplete);
    const summaryCopy = element("div", "fomo-position-summary-copy");
    const summaryLabel = holders.isFomoPositionValueComplete
      ? "Fomo 持仓总额"
      : `Fomo Top ${holders.pricedPositionCount || holders.fomoPositionCount} 持仓`;
    summaryCopy.append(element("span", "", summaryLabel));
    summaryCopy.append(element(
      "small",
      "",
      holders.isFomoPositionValueComplete
        ? `${core.compactNumber(holders.fomoPositionCount, 0)} 个 Fomo 仓位`
        : "接口已达到 100 条上限，金额不代表全量",
    ));
    const summaryMetrics = element("div", "fomo-position-summary-metrics");
    summaryMetrics.append(element("strong", "", core.preciseUsd(holders.fomoPositionValue)));
    if (core.finiteNumber(holders.fomoOwnershipPercent) !== null) {
      summaryMetrics.append(element(
        "span",
        "",
        `Holding: ${holders.isFomoOwnershipComplete ? "" : "Top 100 "}${core.holdingPercent(holders.fomoOwnershipPercent)}`,
      ));
    }
    summary.append(summaryCopy, summaryMetrics);
    return summary;
  }

  function renderCollapsedPosition(view, holders) {
    view.collapsedPosition.replaceChildren(positionSummary(holders));
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

  function renderHolders(view, animatePump = false) {
    if (!canLoadView(view) || view.panel.classList.contains("collapsed")) return;
    const { metadata, holders } = currentData;
    const previousCards = new Map(Array.from(view.content.children)
      .filter(node => node._holderKey).map(node => [node._holderKey, node]));
    const summary = positionSummary(holders);
    const previousSummary = view.content.firstElementChild;
    const nodes = [previousSummary?.isEqualNode(summary) ? previousSummary : summary];


    if (!holders.items.length) {
      nodes.push(emptyState("No Fomo holders found for this token."));
      updateHolderContent(view.content, nodes);
      return;
    }

    for (const holder of holders.items) {
      const key = `${holderActionKey(holder, view.route)}:${holder.id || holder.walletAddress || ""}`;
      const previous = previousCards.get(key);
      previousCards.delete(key);
      const renderKey = holderRenderKey(holder, view.route, metadata.totalSupply);
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
      const nameControl = holderNameControl(holder, view.route);
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
        const pnl = element("span", signedClass(pnlPercent));
        pnl.textContent = pnlPercent === null ? "—" : `${signedArrow(pnlPercent)} ${core.percent(pnlPercent)}`;
        metrics.append(pnl);
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
    updateHolderContent(view.content, nodes);
  }

  const FEED_LABELS = Object.freeze({
    swap_buy: ["Buy", "buy"],
    swap_sell: ["Sell", "sell"],
    transfer_in: ["Receive", "transfer"],
    transfer_out: ["Send", "transfer"],
  });

  function renderFeed(view) {
    const fragment = document.createDocumentFragment();
    if (!currentData.feed.length) {
      fragment.append(emptyState("No Buy, Sell or Transfer activity found."));
      view.content.replaceChildren(fragment);
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
      copy.append(element("div", "fomo-feed-value", `${core.compactUsd(item.usdAmount)} at ${core.compactUsd(item.marketCap)} MC`));
      article.append(copy);
      fragment.append(article);
    }
    view.content.replaceChildren(fragment);
  }

  function renderActiveTab(view) {
    if (!currentData || !canLoadView(view)
      || view.panel.classList.contains("collapsed")) return;
    if (view.activeTab === "feed") renderFeed(view);
    else renderHolders(view);
  }

  function renderError(view, error) {
    const wrapper = element("div", "fomo-error");
    const refreshingSession = error === "FOMO_SESSION_REFRESHING";
    const needsLogin = refreshingSession
      || error === "FOMO_NOT_CONNECTED"
      || error === "FOMO_SESSION_EXPIRED";
    wrapper.append(element("strong", "", refreshingSession
      ? "Refreshing fomo.family session"
      : needsLogin ? "Connect fomo.family" : "Unable to load this token"));
    wrapper.append(element("p", "", needsLogin
      ? refreshingSession
        ? "The extension is reconnecting in the background and will retry shortly."
        : "Open Fomo, make sure you are logged in, then return here and refresh GMGN."
      : "The Fomo API did not return data for this token. Try again shortly."));
    const actions = element("div", "fomo-error-actions");
    const link = element("a", "primary", "Open token on Fomo ↗");
    link.href = fomoTokenUrl(view.route);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const retry = element("button", "", "Retry");
    retry.type = "button";
    retry.addEventListener("click", () => load(view, false, true));
    actions.append(link, retry);
    wrapper.append(actions);
    view.content.replaceChildren(wrapper);
    view.status.textContent = error || "FOMO_REQUEST_FAILED";
  }

  function pumpLoginRequired(sources) {
    return ["PUMP_SESSION_REQUIRED", "PUMP_SESSION_EXPIRED"]
      .includes(sources?.pump?.error);
  }

  function setPumpNotice(view, sources) {
    const visible = view.trackingEnabled && pumpLoginRequired(sources);
    view.pumpNotice.hidden = !visible;
    view.panel.classList.toggle("pump-login-required", visible);
  }

  async function refreshPumpNotice(view) {
    const result = await sendMessage({ type: "getFollowedTradeSources" }).catch(() => null);
    if (!canLoadView(view) || !result?.ok) return;
    setPumpNotice(view, result.sources);
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

  function canLoadView(view) {
    return isActiveInstance() && view === currentView && Boolean(view?.host.isConnected)
      && !view.host.hidden && !sidePanelVisible && document.visibilityState === "visible";
  }

  function load(view, silent = false, force = false) {
    if (!canLoadView(view)) return Promise.resolve();
    if (activeLoad?.view === view && activeLoad.version === requestVersion) return activeLoad.promise;
    if (!force && loadedVersion === requestVersion) {
      if (view.loadError) { renderError(view, view.loadError); return Promise.resolve(); }
      if (currentData) {
        renderCollapsedPosition(view, currentData.holders);
        if (!view.panel.classList.contains("collapsed")) {
          renderHeader(view, currentData.metadata);
          renderActiveTab(view);
        }
        view.status.textContent = view.loadedStatus;
      }
      return loadPanelSection(view);
    }
    const version = requestVersion;
    const entry = { view, version, promise: null };
    view.loadError = null;
    if (!view.panel.classList.contains("collapsed")) refreshPumpNotice(view);
    if (!silent) view.status.textContent = "Loading fomo.family…";
    entry.promise = (async () => {
      try {
        const result = await sendMessage({ type: "queryFomoToken", params: {
          address: view.route.address, networkId: view.route.networkId,
        }, oncePerVisit: true, includeFeed: false, force });
        if (version !== requestVersion || view !== currentView) return;
        loadedVersion = version;
        if (!result?.ok) {
          view.loadError = result?.error || "FOMO_REQUEST_FAILED";
          if (canLoadView(view)) renderError(view, view.loadError);
          return;
        }
        if (force) { holderExtrasLoad = null; feedLoad = null; }
        currentData = withPumpItems(result.data, currentPumpItems);
        const updatedAt = result.cached ? result.cachedAt : result.updatedAt || Date.now();
        const label = result.cached ? "Cached" : result.partial ? "Partially updated" : "Updated";
        view.loadedStatus = `${label} ${new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
        if (!canLoadView(view)) return;
        renderCollapsedPosition(view, currentData.holders);
        view.status.textContent = view.loadedStatus;
        if (view.panel.classList.contains("collapsed")) return;
        renderHeader(view, currentData.metadata);
        renderActiveTab(view);
        loadPanelSection(view, force);
      } catch (error) {
        if (version === requestVersion && view === currentView) {
          loadedVersion = version;
          view.loadError = error?.message || "FOMO_REQUEST_FAILED";
          if (canLoadView(view)) renderError(view, view.loadError);
        }
      }
    })().finally(() => { if (activeLoad === entry) activeLoad = null; });
    activeLoad = entry;
    return entry.promise;
  }

  function loadPanelSection(view, force = false) {
    if (!currentData || !canLoadView(view) || view.panel.classList.contains("collapsed")) return Promise.resolve();
    const version = requestVersion, data = currentData;
    if (view.activeTab === "feed") {
      if (!force && feedLoad?.version === version) return feedLoad.promise;
      const entry = { version, promise: null };
      entry.promise = sendMessage({ type: "queryFomoFeed", params: {
        address: view.route.address, networkId: view.route.networkId,
      }, oncePerVisit: true, force }).then(result => {
        if (version !== requestVersion || !currentData || feedLoad !== entry) return;
        if (!result?.ok) { if (canLoadView(view)) view.status.textContent = result?.error || "FOMO_FEED_FAILED"; return; }
        currentData = { ...currentData, feed: result.items };
        if (canLoadView(view) && view.activeTab === "feed") renderFeed(view);
      }).catch(error => { if (version === requestVersion && canLoadView(view)) view.status.textContent = error?.message || "FOMO_FEED_FAILED"; });
      feedLoad = entry;
      return entry.promise;
    }
    if (!force && holderExtrasLoad?.version === version) return holderExtrasLoad.promise;
    const entry = { version, promise: null };
    entry.promise = (async () => {
      refreshHolderFollowStates(force);
      const result = await sendMessage({ type: "queryPumpHolders", params: {
        address: view.route.address, networkId: view.route.networkId,
      }, metadata: data.metadata, oncePerVisit: true, force }).catch(() => null);
      if (version !== requestVersion || !currentData || holderExtrasLoad !== entry) return;
      const hadItems = currentPumpItems.length > 0;
      if (result?.ok) currentPumpItems = Array.isArray(result.items) ? result.items : [];
      currentData = withPumpItems(currentData, currentPumpItems);
      if (result?.ok && canLoadView(view) && view.activeTab === "holders") renderHolders(view, !hadItems && currentPumpItems.length > 0);
    })();
    holderExtrasLoad = entry;
    return entry.promise;
  }

  function clearInitialLoadHandles(entry) {
    if (!entry) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    if (entry.idleHandle !== null) {
      if (entry.idleFallback) clearTimeout(entry.idleHandle);
      else if (typeof cancelIdleCallback === "function") cancelIdleCallback(entry.idleHandle);
    }
    entry.timer = null;
    entry.idleHandle = null;
    entry.idleFallback = false;
  }

  function cancelInitialLoad() {
    const entry = pendingInitialLoad;
    if (!entry) return;
    clearInitialLoadHandles(entry);
    window.removeEventListener("load", entry.queue);
    pendingInitialLoad = null;
  }

  function pauseInitialLoad() {
    clearInitialLoadHandles(pendingInitialLoad);
  }

  function scheduleInitialLoad(view) {
    cancelInitialLoad();
    const entry = {
      view,
      version: requestVersion,
      timer: null,
      idleHandle: null,
      idleFallback: false,
      queue: null,
    };
    const isCurrent = () => pendingInitialLoad === entry
      && entry.version === requestVersion
      && entry.view === currentView
      && entry.view.host.isConnected
      && isActiveInstance();
    const run = () => {
      entry.idleHandle = null;
      entry.idleFallback = false;
      if (!isCurrent() || document.visibilityState !== "visible") return;
      window.removeEventListener("load", entry.queue);
      pendingInitialLoad = null;
      load(entry.view);
    };
    entry.queue = () => {
      if (!isCurrent()
        || document.visibilityState !== "visible"
        || document.readyState !== "complete"
        || entry.timer !== null
        || entry.idleHandle !== null) return;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (!isCurrent() || document.visibilityState !== "visible") return;
        if (typeof requestIdleCallback === "function") {
          entry.idleFallback = false;
          entry.idleHandle = requestIdleCallback(run, {
            timeout: INITIAL_LOAD_IDLE_TIMEOUT_MS,
          });
        } else {
          entry.idleFallback = true;
          entry.idleHandle = setTimeout(run, 0);
        }
      }, INITIAL_LOAD_SETTLE_MS);
    };
    pendingInitialLoad = entry;
    window.addEventListener("load", entry.queue);
    entry.queue();
  }

  function syncRoute() {
    if (!sidePanelStateReady || !isActiveInstance()) return;
    const route = core.parseTokenRoute(location.pathname);
    const key = route ? `${route.chain}:${route.address}` : "";
    if (key !== currentKey) {
      cancelInitialLoad();
      if (currentView) {
        saveLayout(currentView);
        currentView.stopLayoutTracking?.();
      }
      document.getElementById(HOST_ID)?.remove();
      currentKey = key;
      currentRoute = route;
      currentData = null;
      currentPumpItems = [];
      holderExtrasLoad = null; feedLoad = null;
      requestVersion += 1;
      currentView = null;
      sendMessage({ type: "gmgnTokenRouteChanged", route }).catch(() => {});
    }
    if (!route) return;
    if (sidePanelVisible) {
      if (!currentView || currentView.host.hidden) return;
      cancelInitialLoad();
      saveLayout(currentView);
      currentView.stopLayoutTracking?.();
      requestVersion += 1;
      // Keep the layout shell, but release hidden cards, images and token data.
      currentView.content?.replaceChildren();
      currentData = null;
      currentPumpItems = [];
      holderExtrasLoad = null; feedLoad = null;
      hideOverlayHost();
      return;
    }
    if (document.visibilityState !== "visible") return;
    if (currentView?.host.isConnected) {
      if (!currentView.host.hidden) return;
      currentView.host.hidden = false;
      delete currentView.host.dataset.gmgnFomoHidden;
      restoreAndTrackLayout(currentView);
    } else {
      currentView = createView(route);
      if (!currentView) return;
    }
    scheduleInitialLoad(currentView);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isActiveInstance()) return false;
    if (message?.type === "gmgnFomoPing") {
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
      return false;
    }
    if (message?.type === "fomoSessionChanged") {
      const version = requestVersion, view = currentView;
      Promise.resolve(activeLoad?.promise).catch(() => {}).finally(() => {
        if (version !== requestVersion || view !== currentView) return;
        if (!currentData) { loadedVersion = -1; if (canLoadView(view)) load(view, true); }
        else if (canLoadView(view)) refreshHolderFollowStates(true);
      });
      return false;
    }
    if (message?.type !== "sidePanelVisibilityChanged") return false;
    sidePanelStateReady = true;
    sidePanelVisible = Boolean(message.visible);
    syncRoute();
    sendResponse({ ok: true });
    return false;
  });

  sendMessage({ type: "getSidePanelVisibility" })
    .then((result) => {
      if (!sidePanelStateReady) sidePanelVisible = Boolean(result?.visible);
    })
    .catch(() => {})
    .finally(() => {
      sidePanelStateReady = true;
      syncRoute();
    });
  window.addEventListener("popstate", syncRoute);
  window.navigation?.addEventListener?.("navigatesuccess", syncRoute);
  window.addEventListener("resize", () => canLoadView(currentView) && keepOnScreen(currentView));
  document.addEventListener("visibilitychange", (event) => {
    if (!event.isTrusted) return;
    if (document.visibilityState !== "visible") {
      pauseInitialLoad();
      currentView?.stopLayoutTracking?.();
    } else {
      const resumeView = canLoadView(currentView) && !currentView.layoutTrackingActive ? currentView : null;
      syncRoute();
      if (resumeView && resumeView === currentView) restoreAndTrackLayout(currentView);
      if (pendingInitialLoad) pendingInitialLoad.queue();
      else if (canLoadView(currentView)) load(currentView, true);
    }
  });
})();
