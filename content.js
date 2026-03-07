/**
 * content.js — Volume Controller
 * Injected into ALL tabs.
 *
 * On media tabs (YouTube/Spotify): detects platform, polls state, controls playback
 * On all other tabs: shows island with state received from background, relays actions
 */

// ═══════════════════════════════════════════════════════════════
// PLATFORM ADAPTERS  (only used on media tabs)
// ═══════════════════════════════════════════════════════════════

const YouTube = {
  name: "youtube",
  isActive() {
    return location.hostname.includes("youtube.com") && !location.hostname.includes("music.");
  },
  getVideo() {
    return document.querySelector("video.html5-main-video") || document.querySelector("video");
  },
  play()  { this.getVideo()?.play(); },
  pause() { this.getVideo()?.pause(); },
  next()  { document.querySelector(".ytp-next-button")?.click(); },
  previous() {
    const v = this.getVideo();
    if (v && v.currentTime > 3) v.currentTime = 0;
  },
  seek(fraction) {
    const v = this.getVideo();
    if (v && v.duration) v.currentTime = fraction * v.duration;
  },
  getState() {
    const v = this.getVideo();
    if (!v) return null;
    const meta = navigator.mediaSession?.metadata;
    // Resolve artwork — pick the largest mediaSession image first.
    let artwork = pickBestArtwork(meta?.artwork) || "";
    if (!artwork) {
      // Try to extract video ID from URL for thumbnail
      const match = location.href.match(/[?&]v=([^&]+)/);
      if (match) artwork = `https://img.youtube.com/vi/${match[1]}/mqdefault.jpg`;
      if (!artwork) artwork = pickMetaImage();
    }
    return {
      platform:    "youtube",
      isPlaying:   !v.paused && !v.ended,
      currentTime: v.currentTime,
      duration:    v.duration || 0,
      title:       meta?.title  || document.title.replace(" - YouTube", "").trim(),
      artist:      meta?.artist || "",
      artwork,
      volume:      v.volume,
      muted:       v.muted
    };
  }
};

const YouTubeMusic = {
  name: "youtube-music",
  isActive() { return location.hostname === "music.youtube.com"; },
  getVideo()  { return document.querySelector("video"); },
  play() {
    const v = this.getVideo();
    if (!v) return;
    if (v.paused) { document.querySelector(".play-pause-button")?.click() || v.play(); }
  },
  pause() {
    const v = this.getVideo();
    if (!v) return;
    if (!v.paused) { document.querySelector(".play-pause-button")?.click() || v.pause(); }
  },
  next()     { document.querySelector(".next-button")?.click(); },
  previous() { document.querySelector(".previous-button")?.click(); },
  seek(fraction) {
    const v = this.getVideo();
    if (v && v.duration) v.currentTime = fraction * v.duration;
  },
  getState() {
    const v = this.getVideo();
    if (!v) return null;
    const meta    = navigator.mediaSession?.metadata;
    const titleEl = document.querySelector(".title.ytmusic-player-bar");
    const artEl   = document.querySelector(".byline.ytmusic-player-bar");
    return {
      platform:    "youtube-music",
      isPlaying:   !v.paused && !v.ended,
      currentTime: v.currentTime,
      duration:    v.duration || 0,
      title:       meta?.title  || titleEl?.textContent?.trim() || "",
      artist:      meta?.artist || artEl?.textContent?.trim()   || "",
      artwork:     pickBestArtwork(meta?.artwork) || pickMetaImage() || "",
      volume:      v.volume,
      muted:       v.muted
    };
  }
};

const Spotify = {
  name: "spotify",
  isActive() { return location.hostname.includes("spotify.com"); },
  _click(sel) { document.querySelector(sel)?.click(); },
  play()     { this._click('[data-testid="control-button-playpause"]'); },
  pause()    { this.play(); },
  next()     { this._click('[data-testid="control-button-skip-forward"]'); },
  previous() { this._click('[data-testid="control-button-skip-back"]'); },
  seek(fraction) {
    const bar = document.querySelector('[data-testid="progress-bar"]');
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const x = rect.left + fraction * rect.width;
    const y = rect.top  + rect.height / 2;
    bar.dispatchEvent(new MouseEvent("mousedown", { clientX: x, clientY: y, bubbles: true }));
    bar.dispatchEvent(new MouseEvent("mouseup",   { clientX: x, clientY: y, bubbles: true }));
  },
  getState() {
    const meta      = navigator.mediaSession?.metadata;
    const isPlaying = navigator.mediaSession?.playbackState === "playing";
    const pb        = document.querySelector('[data-testid="playback-progressbar"] [role="progressbar"], [data-testid="playback-progressbar"]');
    const currentEl = document.querySelector('[data-testid="playback-position"], [data-testid="playback-position-time"], [aria-label*="elapsed" i]');
    const totalEl   = document.querySelector('[data-testid="playback-duration"], [aria-label*="total" i]');
    let currentTime = 0, duration = 0;
    if (currentEl && totalEl) {
      currentTime = parseMMSS(currentEl.textContent);
      duration    = parseMMSS(totalEl.textContent);
    } else {
      const timeEls = Array.from(document.querySelectorAll('[data-testid="playback-duration"], [data-testid="playback-position"]'))
        .map((el) => parseMMSS(el.textContent))
        .filter((v) => Number.isFinite(v) && v > 0)
        .sort((a, b) => a - b);
      if (timeEls.length >= 2) {
        currentTime = timeEls[0];
        duration = timeEls[timeEls.length - 1];
      }
    }

    if ((!duration || duration < currentTime) && pb) {
      const valueNow = parseFloat(pb.getAttribute("aria-valuenow") || 0);
      const valueMax = parseFloat(pb.getAttribute("aria-valuemax") || 0);
      if (valueMax > 0) {
        currentTime = valueNow;
        duration = valueMax;
      }
    }

    if ((!duration || duration < currentTime) && meta?.length) {
      duration = meta.length;
      if (!currentTime && !isPlaying) currentTime = 0;
    }

    if (duration && currentTime > duration) {
      currentTime = duration;
    }

    if (duration <= 0) {
      const fallback = document.querySelector('[aria-valuemin][aria-valuemax]');
      if (fallback) {
        const now = parseFloat(fallback.getAttribute("aria-valuenow") || 0);
        const max = parseFloat(fallback.getAttribute("aria-valuemax") || 0);
        if (max > 0) {
          currentTime = now;
          duration = max;
        }
      }
    }

    if (duration <= 0 || Number.isNaN(duration)) {
      currentTime = 0;
      duration = 0;
    } else if (pb) {
      currentTime = Math.max(0, Number.isFinite(currentTime) ? currentTime : 0);
    }
    return {
      platform: "spotify",
      isPlaying, currentTime, duration,
      title:   meta?.title             || "",
      artist:  meta?.artist            || "",
      artwork: pickBestArtwork(meta?.artwork) || pickMetaImage() || "",
      volume: null, muted: false
    };
  }
};

function parseMMSS(str) {
  if (!str) return 0;
  const p = str.trim().split(":").map(Number);
  if (p.length === 2) return p[0] * 60 + p[1];
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  return 0;
}

function pickBestArtwork(artworks = []) {
  if (!Array.isArray(artworks) || artworks.length === 0) return "";
  const sorted = [...artworks]
    .filter((img) => img?.src)
    .sort((a, b) => {
      const aSize = parseInt(a?.sizes?.split("x")?.[0] || "0", 10);
      const bSize = parseInt(b?.sizes?.split("x")?.[0] || "0", 10);
      return bSize - aSize;
    });
  return sorted[0]?.src || "";
}

function pickMetaImage() {
  const selectors = [
    'meta[property="og:image:secure_url"]',
    'meta[property="og:image"]',
    'meta[name="twitter:image"]'
  ];
  for (const sel of selectors) {
    const value = document.querySelector(sel)?.getAttribute("content");
    if (value) return value;
  }
  return "";
}

function detectPlatform() {
  if (YouTubeMusic.isActive()) return YouTubeMusic;
  if (YouTube.isActive())      return YouTube;
  if (Spotify.isActive())      return Spotify;
  return null;
}

// ═══════════════════════════════════════════════════════════════
// CONTENT SCRIPT CORE
// ═══════════════════════════════════════════════════════════════

(function () {
  "use strict";

  // Prevent double-injection on SPA navigations
  if (window.__vcInjected) return;
  window.__vcInjected = true;

  const platform       = detectPlatform(); // null on non-media tabs
  let isThisTabActive  = false;
  let islandVisible    = false;
  let lastState        = null;
  let dom              = {};
  let pollingTimer     = null;

  // ── Context validity guard ────────────────────────────────────
  // "Extension context invalidated" fires when the extension is reloaded while
  // a content script is still alive. Every chrome.runtime call after that throws.
  // We detect it and shut down cleanly instead of flooding the console.

  function isContextAlive() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  function safeSend(message, callback) {
    if (!isContextAlive()) { stopPolling(); return; }
    try {
      if (callback) {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) return;
          callback(res);
        });
      } else {
        chrome.runtime.sendMessage(message).catch(() => {});
      }
    } catch { stopPolling(); }
  }

  function stopPolling() {
    if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
  }

  // ── Bootstrap ────────────────────────────────────────────────

  injectIsland();

  // Get any already-playing state from background
  safeSend({ type: "GET_INITIAL_STATE" }, (response) => {
    if (response?.state) { renderState(response.state); showIsland(); }
  });

  // Media tabs start polling immediately
  if (platform) startPolling();

  // ── Polling (media tabs only) ─────────────────────────────────

  function startPolling() {
    pollingTimer = setInterval(() => {
      if (!isContextAlive()) { stopPolling(); return; }
      if (document.hidden) return;

      const state = platform.getState();
      if (!state) return;

      safeSend({ type: "MEDIA_STATE_UPDATE", state }, (response) => {
        const active = !!response?.isActive;
        isThisTabActive = active;
        // Render directly only on the active media tab. Observer tabs render from broadcasts.
        if (active) {
          renderState(state);
          showIsland();
        }
      });
    }, 500);
  }

  // ── Messages from background ──────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {

      // Background forwarded a control action to us (we are the media tab)
      case "EXECUTE_MEDIA_ACTION":
        if (platform) handleAction(message.action, message.value);
        sendResponse({ ok: true });
        break;

      // State broadcast from another tab — render on our island
      case "MEDIA_STATE_UPDATE":
        if (!isThisTabActive) {
          renderState(message.state);
          showIsland();
        }
        break;

      // We are now the active media source
      case "YOU_ARE_ACTIVE":
        isThisTabActive = true;
        break;

      // Another tab took over — we become a passive observer
      case "ACTIVE_TAB_CHANGED":
        isThisTabActive = false;
        if (message.state) {
          renderState(message.state);
          showIsland();
        } else if (lastState) {
          showIsland();
        }
        break;

      // Active media tab closed — hide island on all observer tabs
      case "ACTIVE_TAB_CLOSED":
        isThisTabActive = false;
        hideIsland();
        break;

      case "TOGGLE_ISLAND":
        toggleIsland();
        break;
    }
  });

  // ── Action dispatch ───────────────────────────────────────────

  function handleAction(action, value) {
    if (!platform) return;
    switch (action) {
      case "play":     platform.play();      break;
      case "pause":    platform.pause();     break;
      case "next":     platform.next();      break;
      case "previous": platform.previous();  break;
      case "seek":     platform.seek(value); break;
    }
    // Re-render after a short delay to pick up new state
    setTimeout(() => {
      const s = platform.getState();
      if (s) renderState(s);
    }, 150);
  }

  // ── Island injection ──────────────────────────────────────────

  function injectIsland() {
    if (document.getElementById("vc-island")) return;

    // Defer if body isn't ready (SPA navigation edge case)
    if (!document.body) {
      window.addEventListener("DOMContentLoaded", injectIsland, { once: true });
      return;
    }

    const island = document.createElement("div");
    island.id = "vc-island";
    island.setAttribute("role", "complementary");
    island.setAttribute("aria-label", "Media controls");
    // Start hidden — shown once real state arrives
    island.classList.add("vc-hidden");

    island.innerHTML = `
      <div id="vc-pill">
        <div id="vc-artwork-wrap">
          <img id="vc-artwork" src="" alt="Album art" />
          <div id="vc-artwork-placeholder">♪</div>
        </div>
        <div id="vc-info">
          <div id="vc-title-scroll">
            <span id="vc-title">—</span>
          </div>
          <span id="vc-artist"></span>
        </div>
        <div id="vc-controls">
          <button id="vc-prev" aria-label="Previous">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
          </button>
          <button id="vc-playpause" aria-label="Play / Pause">
            <svg id="vc-icon-play"  viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            <svg id="vc-icon-pause" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
          </button>
          <button id="vc-next" aria-label="Next">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm2-8.14 5.51 3.86L8 15.14V9.86zM16 6h2v12h-2z"/></svg>
          </button>
        </div>
        <button id="vc-goto" aria-label="Go to media tab" title="Go to tab">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
        </button>
      </div>
      <div id="vc-progress-wrap">
        <div id="vc-progress-bar">
          <div id="vc-progress-fill"></div>
          <div id="vc-progress-thumb"></div>
        </div>
        <div id="vc-time">
          <span id="vc-current-time">0:00</span>
          <span id="vc-duration">0:00</span>
        </div>
      </div>
    `;

    document.body.appendChild(island);

    // Cache all DOM refs once — renderState() uses these, never getElementById
    dom = {
      island,
      pill:         island.querySelector("#vc-pill"),
      title:        island.querySelector("#vc-title"),
      titleScroll:  island.querySelector("#vc-title-scroll"),
      artist:       island.querySelector("#vc-artist"),
      artwork:      island.querySelector("#vc-artwork"),
      artworkPH:    island.querySelector("#vc-artwork-placeholder"),
      iconPlay:     island.querySelector("#vc-icon-play"),
      iconPause:    island.querySelector("#vc-icon-pause"),
      progressBar:  island.querySelector("#vc-progress-bar"),
      progressFill: island.querySelector("#vc-progress-fill"),
      progressThumb:island.querySelector("#vc-progress-thumb"),
      currentTime:  island.querySelector("#vc-current-time"),
      duration:     island.querySelector("#vc-duration"),
    };

    // One-time entrance animation class
    island.classList.add("vc-entering");
    island.addEventListener("animationend", () => {
      island.classList.remove("vc-entering");
    }, { once: true });

    bindEvents();
  }

  // ── Event binding ─────────────────────────────────────────────

  function bindEvents() {
    // ── Playback buttons ──────────────────────────────────────
    dom.island.querySelector("#vc-playpause").addEventListener("click", (e) => {
      e.stopPropagation();
      const action = lastState?.isPlaying ? "pause" : "play";
      if (isThisTabActive && platform) {
        action === "pause" ? platform.pause() : platform.play();
        // Optimistic UI update
        setTimeout(() => { const s = platform.getState(); if (s) renderState(s); }, 150);
      } else {
        safeSend({ type: "MEDIA_ACTION", action });
      }
    });

    dom.island.querySelector("#vc-next").addEventListener("click", (e) => {
      e.stopPropagation();
      isThisTabActive && platform
        ? platform.next()
        : safeSend({ type: "MEDIA_ACTION", action: "next" });
    });

    dom.island.querySelector("#vc-prev").addEventListener("click", (e) => {
      e.stopPropagation();
      isThisTabActive && platform
        ? platform.previous()
        : safeSend({ type: "MEDIA_ACTION", action: "previous" });
    });

    dom.island.querySelector("#vc-goto").addEventListener("click", (e) => {
      e.stopPropagation();
      safeSend({ type: "FOCUS_MEDIA_TAB" });
    });

    // ── Progress bar seek ─────────────────────────────────────
    // Attach drag listeners only while dragging (not permanently on document)
    dom.progressBar.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      doSeek(e);

      const onMove = (e) => { e.preventDefault(); doSeek(e); };
      const onUp   = (e) => {
        doSeek(e);
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup",   onUp,   true);
      };
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup",   onUp,   true);
    });

    function doSeek(e) {
      const rect     = dom.progressBar.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      if (isThisTabActive && platform) {
        platform.seek(fraction);
      } else {
        safeSend({ type: "MEDIA_ACTION", action: "seek", value: fraction });
      }
    }

    // ── Island drag ───────────────────────────────────────────
    // Use capture phase so YouTube's own mousedown doesn't swallow the event
    dom.pill.addEventListener("mousedown", (e) => {
      // Only drag from the info/artwork area — not buttons
      if (e.target.closest("button, #vc-controls")) return;
      e.preventDefault();
      e.stopPropagation();

      const style      = window.getComputedStyle(dom.island);
      const startRight  = parseInt(style.right)  || 20;
      const startBottom = parseInt(style.bottom) || 80;
      const startX      = e.clientX;
      const startY      = e.clientY;

      dom.island.style.transition = "none";

      const onMove = (e) => {
        e.preventDefault();
        dom.island.style.setProperty("right", `${Math.max(8, startRight - (e.clientX - startX))}px`, "important");
        dom.island.style.setProperty("bottom", `${Math.max(8, startBottom - (e.clientY - startY))}px`, "important");
      };
      const onUp = () => {
        dom.island.style.transition = "";
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup",   onUp,   true);
      };
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup",   onUp,   true);
    }, true); // capture phase — beats YouTube's listeners
  }

  // ── Render ────────────────────────────────────────────────────

  function renderState(state) {
    if (!state || !dom.island) return;
    lastState = state;

    // Title
    const newTitle = state.title || "—";
    if (dom.title && dom.title.textContent !== newTitle) {
      dom.title.textContent = newTitle;
      requestAnimationFrame(() => {
        if (!dom.title || !dom.titleScroll) return;
        dom.title.classList.toggle("scrolling", dom.title.scrollWidth > dom.titleScroll.clientWidth);
      });
    }

    // Artist
    if (dom.artist) dom.artist.textContent = state.artist || "";

    // Artwork — only update src when it actually changes
    if (dom.artwork) {
      const newSrc = state.artwork || "";
      if (newSrc && dom.artwork.getAttribute("src") !== newSrc) {
        dom.artwork.src = newSrc;
      }
      const hasArt = !!newSrc;
      dom.artwork.style.display  = hasArt ? "block" : "none";
      if (dom.artworkPH) dom.artworkPH.style.display = hasArt ? "none" : "flex";
    }

    // Play/pause icon swap
    if (dom.iconPlay && dom.iconPause) {
      dom.iconPlay.style.display  = state.isPlaying ? "none"  : "block";
      dom.iconPause.style.display = state.isPlaying ? "block" : "none";
    }

    // Progress bar
    const dur = state.duration || 0;
    const pct = dur > 0 ? ((state.currentTime / dur) * 100).toFixed(2) + "%" : "0%";
    if (dom.progressFill)  dom.progressFill.style.width = pct;
    if (dom.progressThumb) dom.progressThumb.style.left = pct;

    // Time labels
    if (dom.currentTime) dom.currentTime.textContent = fmtTime(state.currentTime);
    if (dom.duration)    dom.duration.textContent    = fmtTime(state.duration);

    // Platform CSS theme
    dom.island.setAttribute("data-platform", state.platform || "");
  }

  // ── Visibility ────────────────────────────────────────────────

  function showIsland() {
    if (!dom.island) return;
    dom.island.classList.remove("vc-hidden");
    islandVisible = true;
  }

  function hideIsland() {
    if (!dom.island) return;
    dom.island.classList.add("vc-hidden");
    islandVisible = false;
  }

  function toggleIsland() {
    islandVisible ? hideIsland() : showIsland();
  }

  // ── Utilities ─────────────────────────────────────────────────

  function fmtTime(sec) {
    if (!sec || isNaN(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

})();
