/**
 * background.js
 * Central media ownership + routing manager.
 *
 * Ownership rule:
 * - last tab that transitions into playing becomes active owner
 * - if owner stops/closes, fallback to most recently-playing remaining tab
 */

let activeMediaTab = null;
let lastBroadcastState = null;
let stateSeq = 0;

let volumeMode = "global"; // global | per-platform
let debugOwner = false;

let preferredGlobal = { volume: null, muted: null };
/** @type {Record<string, {volume:number|null, muted:boolean|null}>} */
let preferredByPlatform = {};

const OWNER_SWITCH_DELAY_MS = 900;

/** @type {Map<number, {platform:string,isPlaying:boolean,lastPlayingAt:number,lastStateAt:number}>} */
const mediaTabs = new Map();
/** @type {Map<number, number>} */
const promotionTimers = new Map();

chrome.storage.session.get(["activeMediaTab", "latestMediaState", "stateSeq"], (result) => {
  if (typeof result.stateSeq === "number") stateSeq = result.stateSeq;
  if (result.latestMediaState) lastBroadcastState = result.latestMediaState;
  if (result.activeMediaTab) {
    activeMediaTab = result.activeMediaTab;
    chrome.tabs.get(activeMediaTab, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        activeMediaTab = null;
        chrome.storage.session.remove(["activeMediaTab"]);
      }
    });
  }
});

chrome.storage.local.get(["vcSettings", "vcAudioPrefs"], (result) => {
  const settings = result.vcSettings || {};
  volumeMode = settings.volumeMode === "per-platform" ? "per-platform" : "global";
  debugOwner = !!settings.debugOwner;

  const prefs = result.vcAudioPrefs || {};
  if (prefs.global && typeof prefs.global === "object") {
    preferredGlobal = {
      volume: isFiniteNumber(prefs.global.volume) ? clamp01(prefs.global.volume) : null,
      muted: typeof prefs.global.muted === "boolean" ? prefs.global.muted : null
    };
  }
  if (prefs.byPlatform && typeof prefs.byPlatform === "object") {
    preferredByPlatform = prefs.byPlatform;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && !isSupportedSite(changeInfo.url)) {
    mediaTabs.delete(tabId);
    clearPromotionTimer(tabId);
    if (tabId === activeMediaTab) recalcActiveTab();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  mediaTabs.delete(tabId);
  clearPromotionTimer(tabId);
  if (tabId === activeMediaTab) {
    recalcActiveTab();
    if (activeMediaTab === null) {
      broadcastToAllTabs({ type: "ACTIVE_TAB_CLOSED" });
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "MEDIA_STATE_UPDATE": {
      const tabId = sender.tab?.id;
      const incoming = message.state;
      if (!tabId || !incoming || !isSupportedSite(sender.tab?.url || "")) {
        sendResponse?.({ ok: false, isActive: false, reason: "Unsupported sender" });
        break;
      }

      const now = Date.now();
      const prev = mediaTabs.get(tabId);
      const transitionedToPlaying = !!incoming.isPlaying && !prev?.isPlaying;

      if (tabId === activeMediaTab) {
        updatePreferred(incoming.platform, {
          volume: isFiniteNumber(incoming.volume) ? clamp01(incoming.volume) : undefined,
          muted: typeof incoming.muted === "boolean" ? incoming.muted : undefined
        });
      }

      mediaTabs.set(tabId, {
        platform: incoming.platform || prev?.platform || "",
        isPlaying: !!incoming.isPlaying,
        lastPlayingAt: transitionedToPlaying ? now : (prev?.lastPlayingAt || 0),
        lastStateAt: now
      });

      if (activeMediaTab === null) {
        dlog("owner:init", { tabId, platform: incoming.platform });
        setActiveTab(tabId, incoming);
      } else if (tabId === activeMediaTab && !incoming.isPlaying) {
        dlog("owner:active-stopped", { tabId });
        recalcActiveTab();
      } else if (transitionedToPlaying && tabId !== activeMediaTab) {
        dlog("owner:promotion-scheduled", { from: activeMediaTab, to: tabId });
        schedulePromotion(tabId);
      }

      const state = withStateMeta(incoming);
      if (
        state.title !== lastBroadcastState?.title ||
        state.artist !== lastBroadcastState?.artist ||
        state.artwork !== lastBroadcastState?.artwork
      ) {
        chrome.storage.session.set({ latestMediaState: state, stateSeq });
      }

      if (tabId === activeMediaTab && shouldBroadcast(state)) {
        lastBroadcastState = state;
        broadcastToAllTabs({
          type: "MEDIA_STATE_UPDATE",
          state,
          activeTabId: activeMediaTab
        }, tabId);
      }

      sendResponse({ ok: true, isActive: activeMediaTab === tabId, activeTabId: activeMediaTab });
      break;
    }

    case "MEDIA_ACTION": {
      if (activeMediaTab === null) {
        sendResponse({ ok: false, action: message.action, reason: "No active media tab" });
        return;
      }

      const ownerPlatform = mediaTabs.get(activeMediaTab)?.platform || lastBroadcastState?.platform || "";
      if (message.action === "setVolume" && isFiniteNumber(message.value)) {
        updatePreferred(ownerPlatform, { volume: clamp01(message.value), muted: false });
      } else if (message.action === "toggleMute") {
        const currentMuted = resolvePreferred(ownerPlatform).muted;
        const fallback = typeof lastBroadcastState?.muted === "boolean" ? lastBroadcastState.muted : false;
        updatePreferred(ownerPlatform, { muted: !(typeof currentMuted === "boolean" ? currentMuted : fallback) });
      } else if (message.action === "setMuted") {
        updatePreferred(ownerPlatform, { muted: !!message.value });
      }

      chrome.tabs.sendMessage(activeMediaTab, {
        type: "EXECUTE_MEDIA_ACTION",
        action: message.action,
        value: message.value
      }).then((result) => {
        if (result?.ok === false) {
          sendResponse({
            ok: false,
            action: message.action,
            ownerTabId: activeMediaTab,
            reason: result.reason || "Owner rejected action"
          });
          return;
        }
        sendResponse({ ok: true, action: message.action, ownerTabId: activeMediaTab });
      }).catch((err) => {
        clearPromotionTimer(activeMediaTab);
        mediaTabs.delete(activeMediaTab);
        activeMediaTab = null;
        recalcActiveTab();
        sendResponse({ ok: false, action: message.action, reason: err.message });
      });
      return true;
    }

    case "FOCUS_MEDIA_TAB": {
      if (activeMediaTab === null) break;
      chrome.tabs.update(activeMediaTab, { active: true })
        .then((tab) => {
          if (tab?.windowId) chrome.windows.update(tab.windowId, { focused: true });
        })
        .catch(() => {
          mediaTabs.delete(activeMediaTab);
          activeMediaTab = null;
          recalcActiveTab();
        });
      break;
    }

    case "GET_INITIAL_STATE": {
      sendResponse({
        state: lastBroadcastState,
        activeTabId: activeMediaTab,
        settings: { volumeMode, debugOwner }
      });
      break;
    }

    case "SETTINGS_GET": {
      sendResponse({
        ok: true,
        settings: { volumeMode, debugOwner }
      });
      break;
    }

    case "SETTINGS_SET": {
      if (message.settings?.volumeMode) {
        volumeMode = message.settings.volumeMode === "per-platform" ? "per-platform" : "global";
      }
      if (typeof message.settings?.debugOwner === "boolean") {
        debugOwner = message.settings.debugOwner;
      }
      persistSettings();
      sendResponse({ ok: true, settings: { volumeMode, debugOwner } });
      break;
    }
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-island") broadcastToAllTabs({ type: "TOGGLE_ISLAND" });
});

function dlog(...args) {
  if (debugOwner) console.debug("[VC][bg]", ...args);
}

function withStateMeta(state) {
  stateSeq += 1;
  chrome.storage.session.set({ stateSeq });
  return {
    ...state,
    _seq: stateSeq,
    _stateAt: Date.now()
  };
}

function setActiveTab(tabId, ownerState = null) {
  if (tabId === activeMediaTab) return;
  dlog("owner:set", { from: activeMediaTab, to: tabId });
  clearPromotionTimer(tabId);
  activeMediaTab = tabId;
  chrome.storage.session.set({ activeMediaTab: tabId });

  const platform = ownerState?.platform || mediaTabs.get(tabId)?.platform || "";

  if (ownerState) {
    const ownerEnvelope = withStateMeta(ownerState);
    lastBroadcastState = ownerEnvelope;
    chrome.storage.session.set({ latestMediaState: ownerEnvelope, stateSeq });
  }

  chrome.tabs.sendMessage(tabId, { type: "YOU_ARE_ACTIVE" }).catch(() => {});
  applyPreferredAudioToOwner(tabId, platform, ownerState);

  broadcastToAllTabs({
    type: "ACTIVE_TAB_CHANGED",
    activeTabId: activeMediaTab,
    state: lastBroadcastState
  }, tabId);
}

function recalcActiveTab() {
  const candidates = Array.from(mediaTabs.entries())
    .filter(([, v]) => v.isPlaying)
    .sort((a, b) => (b[1].lastPlayingAt - a[1].lastPlayingAt) || (b[1].lastStateAt - a[1].lastStateAt));

  if (candidates.length === 0) {
    dlog("owner:cleared");
    activeMediaTab = null;
    chrome.storage.session.remove("activeMediaTab");
    return;
  }

  const [nextId] = candidates[0];
  setActiveTab(nextId);
}

function schedulePromotion(tabId) {
  clearPromotionTimer(tabId);
  const timer = setTimeout(() => {
    dlog("owner:promotion-fired", { tabId });
    promotionTimers.delete(tabId);
    const entry = mediaTabs.get(tabId);
    if (!entry?.isPlaying) return;
    if (activeMediaTab === tabId) return;
    setActiveTab(tabId);
  }, OWNER_SWITCH_DELAY_MS);
  promotionTimers.set(tabId, timer);
}

function clearPromotionTimer(tabId) {
  const timer = promotionTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    promotionTimers.delete(tabId);
  }
}

function resolvePreferred(platform) {
  if (volumeMode === "per-platform") {
    const p = preferredByPlatform[platform] || {};
    return {
      volume: isFiniteNumber(p.volume) ? clamp01(p.volume) : null,
      muted: typeof p.muted === "boolean" ? p.muted : null
    };
  }
  return {
    volume: isFiniteNumber(preferredGlobal.volume) ? clamp01(preferredGlobal.volume) : null,
    muted: typeof preferredGlobal.muted === "boolean" ? preferredGlobal.muted : null
  };
}

function updatePreferred(platform, patch = {}) {
  if (volumeMode === "per-platform") {
    const current = preferredByPlatform[platform] || { volume: null, muted: null };
    preferredByPlatform[platform] = {
      volume: patch.volume !== undefined ? (isFiniteNumber(patch.volume) ? clamp01(patch.volume) : null) : current.volume,
      muted: patch.muted !== undefined ? !!patch.muted : current.muted
    };
  } else {
    if (patch.volume !== undefined) {
      preferredGlobal.volume = isFiniteNumber(patch.volume) ? clamp01(patch.volume) : null;
    }
    if (patch.muted !== undefined) {
      preferredGlobal.muted = !!patch.muted;
    }
  }
  persistAudioPrefs();
}

function applyPreferredAudioToOwner(tabId, platform, ownerState = null) {
  const pref = resolvePreferred(platform);
  const ownerVolume = isFiniteNumber(ownerState?.volume) ? clamp01(ownerState.volume) : null;
  const ownerMuted = typeof ownerState?.muted === "boolean" ? ownerState.muted : null;

  if (isFiniteNumber(pref.volume) && pref.volume !== ownerVolume) {
    chrome.tabs.sendMessage(tabId, {
      type: "EXECUTE_MEDIA_ACTION",
      action: "setVolume",
      value: pref.volume
    }).catch(() => {});
  }

  if (typeof pref.muted === "boolean" && pref.muted !== ownerMuted) {
    chrome.tabs.sendMessage(tabId, {
      type: "EXECUTE_MEDIA_ACTION",
      action: "setMuted",
      value: pref.muted
    }).catch(() => {});
  }
}

function persistSettings() {
  chrome.storage.local.set({
    vcSettings: {
      volumeMode,
      debugOwner
    }
  });
}

function persistAudioPrefs() {
  chrome.storage.local.set({
    vcAudioPrefs: {
      global: preferredGlobal,
      byPlatform: preferredByPlatform
    }
  });
}

function isSupportedSite(url) {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "www.youtube.com" ||
      hostname === "youtube.com" ||
      hostname === "music.youtube.com" ||
      hostname === "open.spotify.com" ||
      hostname === "spotify.com"
    );
  } catch {
    return false;
  }
}

function shouldBroadcast(newState) {
  if (!lastBroadcastState) return true;
  const prev = lastBroadcastState;
  if (newState.title !== prev.title) return true;
  if (newState.artist !== prev.artist) return true;
  if (newState.isPlaying !== prev.isPlaying) return true;
  if (newState.platform !== prev.platform) return true;
  if (newState.artwork !== prev.artwork) return true;
  if (newState.muted !== prev.muted) return true;
  if ((newState.volume ?? null) !== (prev.volume ?? null)) return true;
  return Math.abs((newState.currentTime || 0) - (prev.currentTime || 0)) >= 0.5;
}

function broadcastToAllTabs(message, excludeTabId = null) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id || tab.id === excludeTabId) continue;
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
