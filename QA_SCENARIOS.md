# Multi-Tab Media Validation Matrix

## Scenario A: Last-started source becomes active owner
1. Open three tabs: YouTube, YouTube Music, Spotify.
2. Start playback on YouTube.
3. Start playback on Spotify.
4. Start playback on YouTube Music.

Expected:
- Island source badge reads `Controlling: YouTube Music`.
- Play/pause/seek/next/previous from any observer tab control YouTube Music.

## Scenario B: Owner pause fallback
1. With all three playing and YT Music as owner, pause YT Music.

Expected:
- Ownership falls back to the most recently playing remaining tab.
- Source badge updates accordingly.

## Scenario C: Observer runtime sync
1. Keep active owner playing.
2. Switch to a non-media tab.

Expected:
- Runtime and progress bar keep moving in observer tab.
- No stale time lock after tab switch.

## Scenario D: Observer controls
1. On a non-media tab, use island controls:
   - Play/Pause
   - Seek bar drag
   - Next/Previous

Expected:
- Commands are routed through background to active owner.
- UI updates in all tabs match owner state.

## Scenario E: Volume controls
1. On non-owner tab, use volume slider and mute button.

Expected:
- YouTube / YouTube Music: volume + mute update immediately.
- Spotify: volume works when Spotify volume DOM slider exists; otherwise controls appear disabled.

## Scenario F: Owner tab close
1. Close current owner tab while another source is still playing.

Expected:
- Background reassigns owner to next most recent playing tab.
- Island continues working without reload.

## Scenario G: Restricted pages
1. Open `chrome://extensions` and Chrome Web Store tab.

Expected:
- Island is not injectable there (Chrome restriction), and no crash occurs.


## Scenario H: Flicker stabilization when switching paused/non-owner tab
1. Play YouTube Music and YouTube.
2. Pause YouTube and keep YouTube Music playing.
3. Switch focus between tabs repeatedly without pressing play on YouTube.

Expected:
- Island should stay locked to the active owner (YouTube Music) with no title/artwork flicker.
- Owner should not bounce due transient tab activation or delayed audible updates.
