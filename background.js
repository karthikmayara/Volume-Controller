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
let preferredVolume = null;
let preferredMuted = null;
const OWNER_SWITCH_DELAY_MS = 900;

/** @type {Map<number, {platform:string,isPlaying:boolean,lastPlayingAt:number,lastStateAt:number}>} */
const mediaTabs = new Map();
/** @type {Map<number, number>} */
const promotionTimers = new Map();

chrome.storage.session.get(["activeMediaTab", "latestMediaState", "stateSeq", "preferredVolume", "preferredMuted"], (result) => {
  if (typeof result.stateSeq === "number") stateSeq = result.stateSeq;
  if (typeof result.preferredVolume === "number") preferredVolume = result.preferredVolume;
  if (typeof result.preferredMuted === "boolean") preferredMuted = result.preferredMuted;
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
        sendResponse?.({ ok: false, isActive: false });
        break;
      }

      const now = Date.now();
      const prev = mediaTabs.get(tabId);
      const transitionedToPlaying = !!incoming.isPlaying && !prev?.isPlaying;

      if (tabId === activeMediaTab) {
        if (typeof incoming.volume === "number" && Number.isFinite(incoming.volume)) {
          preferredVolume = clamp01(incoming.volume);
        }
        if (typeof incoming.muted === "boolean") {
          preferredMuted = incoming.muted;
        }
      }

      mediaTabs.set(tabId, {
        platform: incoming.platform || prev?.platform || "",
        isPlaying: !!incoming.isPlaying,
        lastPlayingAt: transitionedToPlaying ? now : (prev?.lastPlayingAt || 0),
        lastStateAt: now
      });

      if (activeMediaTab === null) {
        setActiveTab(tabId, incoming);
      } else if (tabId === activeMediaTab && !incoming.isPlaying) {
        recalcActiveTab();
      } else if (transitionedToPlaying && tabId !== activeMediaTab) {
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
        sendResponse({ ok: false, error: "No active media tab" });
        return;
      }

      if (message.action === "setVolume" && typeof message.value === "number") {
        preferredVolume = clamp01(message.value);
        if (preferredVolume > 0) preferredMuted = false;
        chrome.storage.session.set({ preferredVolume, preferredMuted });
      }
      if (message.action === "toggleMute") {
        preferredMuted = typeof preferredMuted === "boolean" ? !preferredMuted : !(lastBroadcastState?.muted);
        chrome.storage.session.set({ preferredMuted });
      }

      chrome.tabs.sendMessage(activeMediaTab, {
        type: "EXECUTE_MEDIA_ACTION",
        action: message.action,
        value: message.value
      }).then(() => {
        sendResponse({ ok: true, ownerTabId: activeMediaTab });
      }).catch((err) => {
        clearPromotionTimer(activeMediaTab);
        mediaTabs.delete(activeMediaTab);
        activeMediaTab = null;
        recalcActiveTab();
        sendResponse({ ok: false, error: err.message });
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
      sendResponse({ state: lastBroadcastState, activeTabId: activeMediaTab });
      break;
    }
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-island") broadcastToAllTabs({ type: "TOGGLE_ISLAND" });
});

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
  clearPromotionTimer(tabId);
  activeMediaTab = tabId;
  chrome.storage.session.set({ activeMediaTab: tabId });

  if (ownerState) {
    const ownerEnvelope = withStateMeta(ownerState);
    lastBroadcastState = ownerEnvelope;
    chrome.storage.session.set({ latestMediaState: ownerEnvelope, stateSeq });
  }

  chrome.tabs.sendMessage(tabId, { type: "YOU_ARE_ACTIVE" }).catch(() => {});
  applyPreferredAudioToOwner(tabId, ownerState);
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

function applyPreferredAudioToOwner(tabId, ownerState = null) {
  const ownerVolume = typeof ownerState?.volume === "number" ? clamp01(ownerState.volume) : null;
  const ownerMuted = typeof ownerState?.muted === "boolean" ? ownerState.muted : null;

  if (typeof preferredVolume === "number" && preferredVolume !== ownerVolume) {
    chrome.tabs.sendMessage(tabId, {
      type: "EXECUTE_MEDIA_ACTION",
      action: "setVolume",
      value: preferredVolume
    }).catch(() => {});
  }

  if (typeof preferredMuted === "boolean" && preferredMuted !== ownerMuted) {
    chrome.tabs.sendMessage(tabId, {
      type: "EXECUTE_MEDIA_ACTION",
      action: "setMuted",
      value: preferredMuted
    }).catch(() => {});
  }
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
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
