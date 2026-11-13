# EcoGuard browser extension

This guide covers the standalone extension. The macOS application's later milestones are independent; no native messaging host or desktop app is needed to use EcoGuard.

## Build and install

Use Node.js 20 or later and Python 3. No npm installation, external package, account or server is needed.

```sh
npm run verify:browser
```

The command validates the manifest/assets/JavaScript, runs the automated tests and produces:

- `build/extension/` — loadable unpacked extension.
- `build/EcoGuard-extension-0.1.0.zip` — deterministic source package with `manifest.json` at its root.
- `build/EcoGuard-extension-0.1.0.zip.sha256` — package checksum.

Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and select `build/extension`. Chrome 120 or later is the extension's minimum. To install from the ZIP, extract it to a stable directory and select that directory. Do not load the ZIP directly. Personal unpacked installation requires no store account. Store publication is outside this local release.

After installation or an update, refresh existing HTTP/HTTPS pages. Pages without a safety receiver remain protected. Open the popup and confirm the threshold, pause and protection controls connect successfully. On an extension update, choose Reload in `chrome://extensions` and refresh the pages again. Keep the unpacked directory in place.

## Behavior and limits

Automatic cleanup unloads eligible background tabs, preserving the tab strip. Selecting an unloaded tab reloads it normally. The default idle threshold is 30 minutes; it can be set from 5 to 1440 minutes. New observations and browser restarts grant fresh grace. Alarms run about once a minute, so the threshold is not an exact intervention deadline.

Active, pinned, private, audible, loading, recently reused, edited, protected, uninspectable and otherwise uncertain tabs are excluded. Media, frames and detected attached capture/sharing providers also protect a page; an active download vetoes all new unloads. Each scan attempts at most two unloads. A rapid restore doubles that exact host's learned delay, up to 24 hours.

Pause and per-tab protection last for the browser session, including worker shutdown, and clear on browser restart or extension reload. Site protection, the idle threshold, learned delays and bounded history persist locally. Site rules include their subdomains. Restore selects an existing confirmed EcoGuard-discarded tab; it never recreates closed or navigated tabs.

**Close unloaded tabs** explicitly closes only the displayed selection after live checks. It includes Chrome-discarded tabs and applies across windows. It keeps active/pinned/private tabs, but site/tab exceptions apply to automatic unloading rather than this explicit close action.

The probe exchanges flags and timestamps, never typed values or page text. History retains at most 500 metadata-only events. Exact URLs appear only in session state for navigation matching. No telemetry or external service is used. Export uses Chrome's save dialog; the popup reports initiation, while Chrome's Downloads page reports completion.

Page safety is conservative, not a universal unsaved-work detector. Closed shadow trees, unattached WebRTC/capture streams and proprietary page state remain blind spots. Protect sensitive sites explicitly. Chrome offers no atomic conditional discard/remove: state can change after the final lookup. Clearing edit protection requires confirmation and starts new interaction grace; it does not save work.

## Repeatable real-browser acceptance

```sh
npm run test:browser
```

This requires a recent Chrome exposing the experimental DevTools `Extensions.loadUnpacked` and `Extensions.triggerAction` commands. The acceptance runner is tested with Chrome 157; its tooling requirement does not raise the extension's Chrome 120 minimum. On another platform or a custom installation, set `CHROME_BIN` to the Chrome executable. The runner uses Node's pipe transport without third-party browser automation packages.

The runner launches a disposable temporary profile, binds fixtures only to `127.0.0.1`, loads the production package, and operates the actual extension popup. It does not connect to the user's Chrome profile or working tabs. It waits for the real five-minute inactivity threshold and real alarm; allow around seven to nine minutes. No production clock, threshold floor, probe or eligibility rule is bypassed.

Evidence is written to `build/browser-acceptance/results.json`, with popup/confirmation screenshots and the test JSON export beside it. Failures return a nonzero exit status and retain the result record. The temporary profile is removed after the run.

Chrome can replace a tab ID during discard. EcoGuard follows only the explicit `tabs.onReplaced` relationship from its pending discard, validates the replacement's live URL/window/private/discarded state, and records the replacement ID for history, restore and learning. Unrelated returned IDs remain unconfirmed. Session tab protection also follows Chrome replacements.

The automated headless run covers popup layout, trusted edits, media/frame protections, worker shutdown, alarm-driven unloading, restore/learning, confirmed resets, completed metadata-only export, manual close and browser restart. It directs downloads to its output directory, so it does not establish native save-picker behavior or permission-prompt appearance. For a headed installation, additionally verify the save picker can be accepted and cancelled, and that Chrome reports completed/cancelled downloads correctly. The detailed scenarios remain in the root README.

The guided native-picker check opens another disposable profile and the real popup without overriding download behavior:

```sh
npm run test:browser:picker
```

Cancel the first save dialog and press Enter in the terminal. In the second dialog, save the export into `build/browser-picker/` as instructed. The script verifies preserved history and a completed, valid empty JSON export, then writes `build/browser-picker/results.json`. This check requires direct interaction with the two OS dialogs; the headless suite separately verifies a nonempty export.

To inspect the disposable fixtures manually:

```sh
npm run fixtures:browser
```

Visit `http://127.0.0.1:8765`. The server provides a touched 32 MiB allocation, editable draft, local generated audio, embedded frame, bounded CPU/network workload, and slow disposable download. Stop with Ctrl+C. It reads no arbitrary paths and requires no internet connection.

## Resource evaluation

```sh
# Three short alternating pairs, validating collection only (~3 minutes).
npm run benchmark:browser -- --smoke

# Three alternating pairs: 2-minute warmup + 10-minute observation per run (~72 minutes).
npm run benchmark:browser

# Same full protocol with no workload tabs, for idle browser-total comparison.
npm run benchmark:browser -- --idle

# Revalidate and summarize previously collected runs.
node scripts/browser/summary.mjs build/browser-evaluation/runs.json
```

Each run uses a fresh profile. Treatment loads EcoGuard with a five-minute threshold; baseline has no EcoGuard. Both use the same local workload and active control page. The observation excludes setup/warmup. Completed raw runs are saved after each run, even if a later run fails. Summaries reject missing/duplicate pairs, incompatible platform/browser/workload/duration metadata and malformed measurements. A full evaluation requires at least three complete pairs, two minutes of warmup and ten minutes of observation.

Raw process samples and summaries live under `build/browser-smoke/` or `build/browser-evaluation/` (with `-idle` for the idle workload). Metrics include sampled Chrome CPU seconds, median summed process RSS and local fixture-response bytes. Summaries report **treatment minus baseline**; a negative difference means a lower observed value. RSS may double-count shared pages and is not physical memory freed. CPU sampling can miss the last interval of exiting processes. Loopback response bytes are not system-interface traffic. Browser totals do not isolate extension-only overhead. Unsupported battery observations stay null; no energy or battery-life savings are invented.

Keep browser version, page count, machine workload and power conditions fixed and avoid other browser tests during a full evaluation. Short smoke runs establish only that the collector and summary work. They do not establish savings, steady-state overhead or the two-second median restore target. Those research measurements are separate from functional extension acceptance.

## Reset, troubleshoot and remove

If the popup reports a connection error, inspect the service-worker errors in `chrome://extensions`, reload the extension, refresh disposable pages and reopen the popup. A missing receiver protects a page. If no tab unloads, check pause, threshold, recent use, site/tab exceptions, active downloads and page safety first. Active tabs in every window are protected.

Use history-only and learning-only resets for their respective data. Full reset restores defaults, clears history/learning/tab exceptions/restore records, grants fresh grace and leaves automatic unloading paused. It does not close/reload tabs, clear page edits, delete export files or affect unrelated storage. An interrupted reset is retried after a worker restart within the same browser session.

To remove EcoGuard, optionally export history, open `chrome://extensions`, find EcoGuard and choose **Remove**. Select previously unloaded tabs when you want Chrome to reload them. Delete the extracted package/build files only when you no longer need them, and delete exported JSON files separately if desired. Removing the browser extension does not uninstall the independent native app.
