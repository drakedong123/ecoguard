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
- [ ] Add final safety/reuse decisions and feedback-based threshold adjustment in the second half.

The first-stage API is `evaluateBasicEligibility({ tab, activity, settings, now, paused })`. Activity uses `lastActiveAt` and optional `lastInteractionAt` in epoch milliseconds, plus an optional `protected` boolean. Tab input uses Chrome's `id`, `url`, `status`, `active`, `pinned`, `audible`, `incognito`, `discarded` and `autoDiscardable` fields. Missing safety-relevant metadata rejects candidacy conservatively. Output contains `candidate` and a stable reason code. Passing the filter includes `requiresSafetyCheck: true`; it never grants final permission to discard a tab.

Verified on 7 November 2026 with `npm run verify`: all 23 tests passed, the extension packaged with the new policy modules, the native release build and signature checks passed, and the design document remained ignored. Policy tests use supplied tab snapshots; real-browser eligibility and intervention behavior have not been exercised in this half.

This half introduces no live tab inspection, additional permissions or automatic cleanup. Page safety probes, scheduled tab unloading, full popup management, native resource metrics, inactivity policy, guarded process actions, recommendation panels and evaluation workloads remain in their respective later chunks.
