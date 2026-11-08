# EcoGuard Implementation Status

## First code milestone

Repository and build foundation, corresponding to chunk 02 in the local design. Chunk 01 covered the design document and source traceability.

- [x] Add a zero-dependency Swift package with separate core and executable targets.
- [x] Add a native menu bar shell with build status, About and Quit actions.
- [x] Add native `--status` and `--help` commands for headless verification.
- [x] Add an unpacked Manifest V3 extension with a module service worker and popup.
- [x] Persist and validate the browser's inactivity preference.
- [x] Add extension validation and reproducible packaging commands for both components.
- [x] Ignore generated outputs and caches while preserving the local design ignore rule.
- [x] Document prerequisites and how to run each component.

## Verification record

Verified on 6 November 2026 with `npm run verify` on an Apple Silicon Mac:

- Extension manifest, packaged asset paths and JavaScript syntax passed validation.
- Five preference-service tests passed, including persistence after worker recreation, invalid input, corrupt data, queued requests and recovery after storage errors.
- The Swift package compiled in release mode without third-party dependencies.
- `build/EcoGuard.app` passed property-list and ad hoc signature validation.
- The native `--status` command returned the expected foundation capabilities; invalid arguments returned exit code 2.
- Both packaged outputs exist, and generated products and the local design document remain ignored by Git.

Real Chrome installation and native GUI interaction remain separate manual checks. Successful compilation and mocked storage tests do not establish those results.

## Remaining feature work

### Second code milestone first half

Browser eligibility engine, corresponding to the first half of design chunk 03.

- [x] Normalize hostnames and HTTP/HTTPS URLs, including case, trailing dots and international names.
- [x] Match site protections on hostname boundaries and seed the default protected sites.
- [x] Preserve site protections when saving an inactivity preference or loading older settings.
- [x] Add a pure basic eligibility filter for protected tab states, inactivity and recent interaction.
- [x] Reject missing metadata, unobserved activity and invalid or future timestamps.
- [x] Cover exact time boundaries, site matching, protected states and settings persistence with tests.
- [x] Add final safety/reuse decisions and feedback-based threshold adjustment in the second half (completed below).

The first-stage API is `evaluateBasicEligibility({ tab, activity, settings, now, paused })`. Activity uses `lastActiveAt` and optional `lastInteractionAt` in epoch milliseconds, plus an optional `protected` boolean. Tab input uses Chrome's `id`, `url`, `status`, `active`, `pinned`, `audible`, `incognito`, `discarded` and `autoDiscardable` fields. Missing safety-relevant metadata rejects candidacy conservatively. Output contains `candidate` and a stable reason code. Passing the filter includes `requiresSafetyCheck: true`; it never grants final permission to discard a tab.

Verified on 7 November 2026 with `npm run verify`: all 23 tests passed, the extension packaged with the new policy modules, the native release build and signature checks passed, and the design document remained ignored. Policy tests use supplied tab snapshots; real-browser eligibility and intervention behavior have not been exercised in this half.

This half introduces no live tab inspection, additional permissions or automatic cleanup. Page safety probes, scheduled tab unloading, full popup management, native resource metrics, inactivity policy, guarded process actions, recommendation panels and evaluation workloads remain in their respective later chunks.

### Second code milestone second half — Chunk 03 complete

- [x] Add final pure eligibility decisions that preserve basic exclusions and apply learned site delays.
- [x] Protect frequent reuse: three activations in an inclusive rolling thirty-minute window.
- [x] Prune activation observations to the newest three relevant timestamps without mutating input; reject missing or invalid reuse history.
- [x] Require explicit safe page observations and an explicit absence of active downloads.
- [x] Bind safety observations to the tab ID and exact URL and reject future or stale probe timestamps.
- [x] Double exact-host delays on rapid restore up to 1440 minutes, bounding learned hosts at 100 and evicting oldest updates.
- [x] Preserve validated learning when saving preferences or loading older settings; add a pure learning reset.
- [x] Test reuse, safety, feedback and learned-delay boundaries, corruption, eviction, persistence and immutable inputs.

`evaluateEligibility({ tab, activity, settings, now, paused, safety, downloadsInProgress })` returns `{ eligible, reason }` and includes hostname, idle duration and effective threshold when eligible. It first applies `evaluateBasicEligibility`. Activity additionally requires `recentActivations`, an array of epoch-millisecond timestamps; an observed empty array is valid. `pruneRecentActivations(activations, now)` keeps the newest three within the inclusive thirty-minute window, or returns null for invalid observations. Keeping three is sufficient to maintain the three-activation veto; a future worker can append each activation and prune before saving session state.

Safety input requires `inspected: true`, matching `tabId` and exact `url`, `checkedAt`, `lastInteractionAt`, and explicit false values for `edited`, `playingMedia`, `hasEmbeddedFrame`, `capturing` and `sharing`. Probe age may not exceed five seconds; this is an implementation freshness limit. Probe interaction timestamps must be valid and outside the five-minute interaction grace. `downloadsInProgress` must be explicitly false. Unknown states fail closed. The worker must still acquire fresh state and rerun this decision immediately before intervention; a passing pure decision neither inspects a real page nor performs a discard. Capture and proprietary page-state detection retain the design's documented blind spots.

`applyRestoreFeedback({ settings, discard, tab, now })` accepts a confirmed discard record `{ confirmed: true, tabId, hostname, discardedAt }` and a matching active tab with `discarded: false` on the same exact hostname. Restores from zero through two minutes after discard, inclusive, double the greater of the current base and learned delay, capped at 24 hours. Output is `{ adjusted, reason, settings }`. The caller must consume each confirmed discard record once and persist returned settings; those worker responsibilities belong to chunk 05. Learned entries are `{ hostname, idleMinutes, updatedAt }`; normalization keeps the newest valid duplicate and the newest 100 hosts. `resetLearnedDelays(settings)` returns preferences with empty learning for the later reset control.

Verified on 8 November 2026 with `npm run verify`: all 44 tests passed; extension validation and packaging, native release build, app signature and CLI checks passed. These are supplied-observation policy tests; real-browser intervention and GUI checks remain pending.

Next: chunk 04, the browser page safety probe (sticky edit tracking, media/frame checks, interaction timestamps and explicit reset). Chunk 05 connects policy to live events, scheduling, final revalidation and unloading. This milestone changes no browser permissions.
