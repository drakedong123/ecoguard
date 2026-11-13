# Browser acceptance record

Verified on 13 November 2026, on macOS arm64 with Chrome 157.0.8103.51. The manifest declares Chrome 120 as its minimum; this runtime acceptance record covers only the tested browser build.

## Observed checks

- All 147 automated tests passed. Manifest/assets/JavaScript validation, extension packaging and regression checks passed.
- All 16 isolated real-Chrome acceptance checks passed. The exact successful run is preserved in [acceptance-results.json](acceptance-results.json), including the production-source fingerprint, timestamps, check durations and evidence.
- A real alarm discarded the eligible read-only page after the actual five-minute threshold, without reducing the tab count. No unwanted unloads were observed across eight protected fixtures, including active tabs in two windows, edited/media/frame pages, pinned tabs and tab exceptions.
- A real in-progress download vetoed an otherwise eligible tab across an alarm. Restore selected and reloaded the existing logical tab, and the confirmed rapid return doubled its host delay. Chrome's replacement tab ID was retained correctly.
- Trusted edit/reset events, popup modal focus/Escape, metadata-only completed export, reset scopes, stale close selection, manual close, browser settings controls, worker shutdown and browser restart passed.
- The three-pair short benchmark smoke protocol completed and its raw observations passed summary validation. These runs verify collection, not resource savings or steady-state overhead. Raw samples remain in `build/browser-smoke/runs.json` and the derived summary in `build/browser-smoke/summary.json`.
- The production ZIP is reproducible, excludes tests/tooling and has a SHA-256 sidecar under `build/`.

## Integration issue resolved

The first real alarm exposed a gap in the simulated browser: this Chrome build replaces the tab ID when discarding. The old worker rejected the successful unload as unconfirmed, so history, restore and rapid-return learning were unavailable. The fix accepts a new ID only through Chrome's explicit replacement event during the pending discard, validates the live replacement and transfers the confirmed session record. Four regression tests cover successful replacement/restart/learning, unrelated or changed replacements, protection persistence, and recovery after a failed replacement lookup. Known tab protection is persisted before that lookup, so a temporary API error cannot silently remove it; worker restart and subsequent unprotection are also tested.

Reverification also found a navigation-readiness race in the test runner: a newly created target could still contain its initial blank document when the popup was opened. The runner now waits for the requested URL and a complete document before returning a fixture page. The full real-browser run was repeated against the current production-source fingerprint.

## Verification limits

The acceptance runner uses headless Chrome and directs downloads to its disposable output directory. Native Save/Cancel dialogs and permission-prompt appearance are not established by that run. Native UI inspection was blocked by automatic approval review because the tool selected an unrelated private Chrome window. No UI action was taken in that window. The guided `npm run test:browser:picker` command is supplied for direct operator verification of the two OS dialogs.

No full ten-minute-per-run resource study, extension-only overhead measurement, battery-discharge study or median restore-latency target is claimed. The restore check records one automation-observed reload, which is not a median benchmark. Browser totals and loopback response bytes have the attribution limits described in the [browser guide](README.md).

Reproduce functional acceptance with `npm run test:browser`; allow approximately seven to nine minutes. Reproduce the smoke collector with `npm run benchmark:browser -- --smoke`. Generated screenshots, test exports, raw runs and release files remain under `build/`.
