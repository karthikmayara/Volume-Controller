# Volume Controller — Open Issues

This file tracks **currently open** items only. Resolved items from older revisions were removed.

## 1) Spotify volume controls can be selector-fragile
- **Status:** Open
- **Why:** Spotify frequently changes `data-testid`/ARIA markup, so simulated slider or mute button interactions may fail intermittently.
- **Impact:** Volume slider or mute from island can become unavailable on Spotify, while YouTube / YouTube Music continue to work.
- **Next step:** Add selector fallback telemetry and broaden resilient selectors for volume controls.

## 2) Restricted pages cannot host the island (Chrome limitation)
- **Status:** Open (expected platform limitation)
- **Why:** Content scripts cannot run on pages like `chrome://*` and some store/internal pages.
- **Impact:** Island is unavailable there.
- **Next step:** Optional UX copy in action popup to explain unsupported page contexts.

## 3) Cross-window ownership handoff needs deeper validation
- **Status:** Open
- **Why:** Ownership logic is robust for same-window multi-tab scenarios, but mixed-window rapid play/pause transitions need broader manual test coverage.
- **Impact:** Rare edge cases may still cause delayed owner handoff.
- **Next step:** Extend QA scenarios with multi-window race cases and regression checklist.
