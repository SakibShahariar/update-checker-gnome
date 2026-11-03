# Open Issue Triage

_Last reviewed: 2026-11-03. Default branch: `master`. Current open issues: 25._

This is a point-in-time classification of the repository's 26 open issues using the five-category policy in the root `AGENTS.md`. It lists 25 open issues. Categories describe what can be done and verified without the owner's laptop; they are not priority or severity labels.

## Category A — Fully actionable

_No Category A issues remain open after this pass._

### Completed in this pass

| Issue | Result |
|---|---|
| [#91 — Direct argv execution where safe](https://github.com/SakibShahariar/update-checker-gnome/issues/91) | Implemented conservative direct argv execution with shell fallback and process-group preservation. GJS regression tests and CI passed; closed after verification. Commits: `7cde73c`, `5009c17`, `8c906c8`. |

## Category B — Implementation ready, validation pending

| Issue | Remaining validation / reason |
|---|---|
| [#21 — Further split `lib/indicator.js`](https://github.com/SakibShahariar/update-checker-gnome/issues/21) | Complete functional regression and GNOME 49–51 extension/menu smoke tests. |
| [#22 — Quiet-hours precision and accessibility](https://github.com/SakibShahariar/update-checker-gnome/issues/22) | Verify icon-only accessible names/tooltips and quiet-hours behavior in GNOME on X11 and Wayland. |
| [#31 — Keyboard navigation](https://github.com/SakibShahariar/update-checker-gnome/issues/31) | Implement keyboard focus/activation and verify the real popup's focus order, focus ring, and pointer behavior. |
| [#59 — Per-worker error boundaries](https://github.com/SakibShahariar/update-checker-gnome/issues/59) | Automated worker-isolation coverage exists; verify UI recovery in a GNOME session. |
| [#60 — Terminal update lifecycle](https://github.com/SakibShahariar/update-checker-gnome/issues/60) | Verify GNOME Terminal `--wait` and configured third-party terminal launchers in a real desktop session. |
| [#68 — Expandable error output and copy](https://github.com/SakibShahariar/update-checker-gnome/issues/68) | Verify expanded layout and clipboard behavior in GNOME Shell. |
| [#69 — Global Check now discoverability](https://github.com/SakibShahariar/update-checker-gnome/issues/69) | Verify keybinding registration, shortcut conflicts, and interaction in GNOME. |
| [#71 — Empty/disabled-source guidance](https://github.com/SakibShahariar/update-checker-gnome/issues/71) | Verify opening Sources preferences from the warning with Preferences both closed and already open. |
| [#73 — Terminal versus background mode](https://github.com/SakibShahariar/update-checker-gnome/issues/73) | Verify both modes, labels, authentication behavior, and lifecycle in GNOME. |
| [#78 — Reduced-motion consistency](https://github.com/SakibShahariar/update-checker-gnome/issues/78) | Verify toggling reduced motion while the extension is running. |
| [#84 — Lifecycle, cancellation, and UI regression tests](https://github.com/SakibShahariar/update-checker-gnome/issues/84) | Finish destroyed-state checks during active source checks, actual subprocess completion, process-group integration, and menu state tests. |
| [#86 — Event-driven scheduling](https://github.com/SakibShahariar/update-checker-gnome/issues/86) | Implemented a six-hour fallback for sources covered by active package-database monitors, retained normal polling for uncovered sources, restored normal polling on monitor cancellation, and invalidated caches on reconnect. GJS/CI passed; live Fedora/GNOME/Flatpak watcher reliability remains to be checked. Commits: `c471aa5`, `56f0718`. |
| [#92 — Batch package-manager checks](https://github.com/SakibShahariar/update-checker-gnome/issues/92) | Unit-test batching and failure isolation, then validate command output, privilege boundaries, and behavior on supported package-manager environments. |
| [#93 — D-Bus APIs where available](https://github.com/SakibShahariar/update-checker-gnome/issues/93) | Implement with CLI fallback; validate D-Bus availability, permissions, sandboxing, and equivalent results on supported distributions. |
| [#94 — Targeted menu-row updates](https://github.com/SakibShahariar/update-checker-gnome/issues/94) | Implement row-field updates and automated state tests; verify row lifecycle, theme changes, and accessibility in GNOME. |
| [#95 — Incremental package-list rendering](https://github.com/SakibShahariar/update-checker-gnome/issues/95) | Implement paged rendering; verify large lists, scrolling, keyboard navigation, and screen-reader behavior in GNOME. |
| [#96 — CSS-class theming](https://github.com/SakibShahariar/update-checker-gnome/issues/96) | Implement stylesheet-based classes and automated checks; visually validate default/dark/light/Matugen/high-contrast/RTL themes. |
| [#98 — Lazy menu construction](https://github.com/SakibShahariar/update-checker-gnome/issues/98) | Implement lazy initialization and tests; verify first/repeated open, updates, errors, keyboard navigation, and themes in GNOME. |
| [#99 — Throttle update progress ticks](https://github.com/SakibShahariar/update-checker-gnome/issues/99) | Implementation and CI are complete; verify animation, cancellation/completion, and reduced-motion changes in a GNOME session. |
| [#100 — Reuse menu row widgets](https://github.com/SakibShahariar/update-checker-gnome/issues/100) | Implement keyed row reuse and lifecycle tests; verify source add/remove/rename, errors, themes, and menu lifecycle in GNOME. |
| [#104 — Performance profiling workflow](https://github.com/SakibShahariar/update-checker-gnome/issues/104) | Documentation is complete; run repeatable measurements on a real GNOME desktop and confirm tooling/commands on supported Fedora environments. |

## Category C — Environment-dependent

_No current issue classified here._ Reclassify an issue as C if the implementation itself cannot be completed or meaningfully verified without a specific unavailable device, operating system, hardware, or runtime—not merely because final desktop validation is pending.

## Category D — Blocked by external dependencies

_No current issue classified here._ Reclassify when a named upstream, third-party, service, or API dependency actually blocks progress.

## Category E — Needs the owner's decision or information

| Issue | Question needed |
|---|---|
| [#66 — Symlink-cycle protection](https://github.com/SakibShahariar/update-checker-gnome/issues/66) | Is recursive filesystem scanning/watch expansion a planned feature? The current extension watches fixed directories non-recursively, so there is no traversal path for cycle protection to guard yet. |
| [#85 — Command-aware result caching](https://github.com/SakibShahariar/update-checker-gnome/issues/85) | Should command-aware caching apply only to known DNF/Flatpak sources with reliable package-database watches, while arbitrary/custom commands keep interval-based caching to avoid stale results from hidden inputs? |
| [#87 — Persistent checker daemon with D-Bus](https://github.com/SakibShahariar/update-checker-gnome/issues/87) | Do you want to pursue a separate user-level checker service, accepting the extra packaging, lifecycle, permission, and migration complexity? |
| [#88 — Weekly trend-based adaptive check delay](https://github.com/SakibShahariar/update-checker-gnome/issues/88) | For security-update sources, should adaptive scheduling exclude them entirely or allow a conservative maximum delay? This affects how quickly security updates are discovered. |

## Triage rules

- Work Category A first. A category assignment is not evidence of completion; require passing CI and verified acceptance criteria before closing.
- Implement Category B work where useful, but keep issues open until the remaining real-environment validation is recorded.
- Ask the owner the specific Category E questions; after an answer, reclassify and continue.
- Reassess this document whenever issues change, work is completed, or dependencies/environments change. This is a living snapshot, not a permanent disposition.
