# Volume Controller — Dynamic Island for Chrome

A floating media controller that lives in the corner of every tab, giving you instant playback controls without hunting for the audio tab.

---

## Installation

1. Download and unzip `volume-controller.zip`
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked**
5. Select the `volume-controller/` folder
6. Open YouTube, Spotify, or YouTube Music and play something

---

## Features

- **Floating island** — Draggable pill UI, always on top
- **Real-time info** — Track title, artist, artwork, progress bar
- **Full controls** — Play/pause, next, previous, seek by clicking/dragging the progress bar
- **Cross-tab sync** — Island on any tab shows what's playing elsewhere
- **Jump to tab** — Click the arrow icon to navigate to the playing tab
- **Keyboard toggle** — `Alt+Shift+D` to show/hide the island
- **Platform-aware** — Accent color changes: green (Spotify), red (YouTube), orange (YouTube Music)

---

## Supported Platforms

| Platform       | Play/Pause | Next/Prev | Seek | Metadata |
|----------------|-----------|-----------|------|----------|
| YouTube        | ✅        | ✅ (next only) | ✅ | ✅ |
| YouTube Music  | ✅        | ✅        | ✅  | ✅ |
| Spotify (web)  | ✅        | ✅        | ✅* | ✅ |

*Spotify seek uses DOM click simulation — may vary with Spotify updates.

---

## Architecture

```
manifest.json       MV3 config, permissions, keyboard shortcut
background.js       Service worker — state manager, tab tracker
content.js          Injected into media sites — island UI + platform adapters
island.css          Island styling (glass pill, animations)
icons/              Extension icons
```

**Data flow:**
```
Media Site Tab
  └── content.js polls platform.getState() every 500ms
      └── Sends MEDIA_STATE_UPDATE to background.js
          └── background.js broadcasts to all tabs
              └── Every tab's island re-renders
```

**Control flow:**
```
User clicks button on island (any tab)
  └── If this tab is the media tab: call platform.play/pause/etc directly
  └── If not: send MEDIA_ACTION to background
      └── background.js forwards to active media tab's content.js
          └── content.js calls platform adapter
```

---

## Known Limitations

- Spotify seek is less reliable than YouTube (no direct video element access)
- Background service workers can be suspended by Chrome — state restores on next media event
- `chrome://` pages and extension pages cannot receive content scripts (expected behavior)
- Multiple tabs playing simultaneously: last one to report wins as the active tab

---

## Permissions Explained

| Permission | Why |
|------------|-----|
| `tabs` | Track which tab is audible / active |
| `scripting` | Inject controls into media tabs |
| `storage` | Persist last known media state across service worker restarts |
| Host permissions | Only requested for YouTube and Spotify (not all sites) |
