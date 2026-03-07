/**
 * background.js
 * Central state manager for the Volume Controller extension.
 *
 * Key fixes in this version:
 * - broadcastToAllContentScripts sends to ALL tabs (not just supported sites)
 *   so the island appears on any tab the user is browsing
 * - activeMediaTab promoted immediately on first MEDIA_STATE_UPDATE regardless
 *   of isPlaying, so paused-on-load state still registers the tab
 * - YOU_ARE_ACTIVE sent to active tab so it knows to act locally
 * - shouldBroadcast always passes through for the media tab's own updates
 */

let activeMediaTab    = null;
let lastBroadcastState = null;

// ─── Rehydrate on service worker restart ─────────────────────────────────────

chrome.storage.session.get(["activeMediaTab", "latestMediaState"], (result) => {
  if (result.activeMediaTab) {
    chrome.tabs.get(result.activeMediaTab, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        chrome.storage.session.remove(["activeMediaTab", "latestMediaState"]);
        return;
      }
      activeMediaTab = result.activeMediaTab;
    });
  }
  if (result.latestMediaState) {
    lastBroadcastState = result.latestMediaState;
  }
});

// ─── Tab Tracking ─────────────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!("audible" in changeInfo)) return;
  if (!isSupportedSite(tab.url)) return;
  if (changeInfo.audible === true && activeMediaTab === null) {
    setActiveTab(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeMediaTab) {
    activeMediaTab = null;
    chrome.storage.session.remove("activeMediaTab");
    broadcastToAllTabs({ type: "ACTIVE_TAB_CLOSED" });
  }
});

// ─── Message Handling ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    case "MEDIA_SESSION_ACTIVE": {
      const tabId = sender.tab?.id;
      if (tabId && isSupportedSite(sender.tab?.url)) {
        setActiveTab(tabId);
        sendResponse({ ok: true });
      }
      break;
    }

    case "MEDIA_STATE_UPDATE": {
      const tabId    = sender.tab?.id;
      const newState = message.state;
      if (!newState || !tabId) break;

      // Register this tab as active as soon as it reports state.
      // If this tab is playing, always promote it so controls target the right tab.
      if (isSupportedSite(sender.tab?.url)) {
        if (activeMediaTab === null || activeMediaTab === tabId || newState.isPlaying) {
          setActiveTab(tabId);
        }
      }

      // Write to storage only on track change
      if (
        newState.title  !== lastBroadcastState?.title ||
        newState.artist !== lastBroadcastState?.artist
      ) {
        chrome.storage.session.set({ latestMediaState: newState });
      }

      // Always broadcast — the media tab itself needs updates on other tabs'
      // islands. Throttling is only for progress ticks, not critical state.
      if (shouldBroadcast(newState)) {
        lastBroadcastState = newState;
        // Broadcast to ALL tabs (including non-media tabs) so any open tab
        // shows the island — excludes only the sender to avoid echo
        broadcastToAllTabs({ type: "MEDIA_STATE_UPDATE", state: newState }, tabId);
      }
      break;
    }

    case "MEDIA_ACTION": {
      if (activeMediaTab === null) {
        sendResponse({ ok: false, error: "No active media tab" });
        return;
      }
      chrome.tabs.sendMessage(activeMediaTab, {
        type: "EXECUTE_MEDIA_ACTION",
        action: message.action,
        value: message.value
      }).then(() => {
        sendResponse({ ok: true });
      }).catch((err) => {
        activeMediaTab = null;
        chrome.storage.session.remove("activeMediaTab");
        sendResponse({ ok: false, error: err.message });
      });
      return true; // async
    }

    case "FOCUS_MEDIA_TAB": {
      if (activeMediaTab === null) break;
      chrome.tabs.update(activeMediaTab, { active: true })
        .then((tab) => {
          if (tab?.windowId) chrome.windows.update(tab.windowId, { focused: true });
        })
        .catch(() => {
          activeMediaTab = null;
          chrome.storage.session.remove("activeMediaTab");
        });
      break;
    }

    case "GET_INITIAL_STATE": {
      chrome.storage.session.get("latestMediaState", (result) => {
        sendResponse({
          state:       result.latestMediaState || null,
          activeTabId: activeMediaTab
        });
      });
      return true; // async
    }
  }
});

// ─── Keyboard Shortcut ────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-island") {
    broadcastToAllTabs({ type: "TOGGLE_ISLAND" });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setActiveTab(tabId) {
  if (tabId === activeMediaTab) return;
  activeMediaTab = tabId;
  chrome.storage.session.set({ activeMediaTab: tabId });

  // Tell the active tab it owns playback controls
  chrome.tabs.sendMessage(tabId, { type: "YOU_ARE_ACTIVE" }).catch(() => {});

  // Tell all other tabs they are observers and provide latest state so they can render immediately
  broadcastToAllTabs({ type: "ACTIVE_TAB_CHANGED", state: lastBroadcastState }, tabId);
}

function isSupportedSite(url) {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "www.youtube.com" ||
      hostname === "youtube.com"     ||
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
  if (newState.title    !== prev.title)    return true;
  if (newState.artist   !== prev.artist)   return true;
  if (newState.isPlaying !== prev.isPlaying) return true;
  if (newState.platform !== prev.platform) return true;
  if (newState.artwork  !== prev.artwork)  return true;
  // Throttle progress-only ticks to 1s granularity
  return Math.abs((newState.currentTime || 0) - (prev.currentTime || 0)) >= 1;
}

/**
 * Broadcast to ALL open tabs — not just supported media sites.
 * This is what makes the island appear on non-media tabs (gmail, google, etc.)
 * The content script manifest covers only media sites, so non-media tabs won't
 * have the content script at all — those sendMessage calls will just fail
 * silently, which is fine.
 */
function broadcastToAllTabs(message, excludeTabId = null) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id || tab.id === excludeTabId) continue;
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}
