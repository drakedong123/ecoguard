# EcoGuard

EcoGuard is a local Chromium extension and macOS menu bar app for managing unused resources. The browser extension automatically unloads eligible idle tabs using page safety checks, session activity tracking and alarm-based scheduling (chunks 03–05). Its popup provides an inactivity threshold, pause/resume, tab/site protection, restore-last-unloaded, manual close-unloaded-tabs, history export and confirmed reset controls. Chunk 06 implementation is complete; real Chrome acceptance remains pending. Native resource monitoring and desktop process actions belong to later milestones.

## Build and verify

Requirements: macOS 13 or later, Apple Command Line Tools with Swift 5.9 or later, Node.js 20 or later with npm, and Python 3. All dependencies are platform frameworks or standard libraries. No package installation, paid service or account is needed to build locally.

```sh
npm run verify
```

This validates the extension, runs preference persistence, browser policy, page safety, worker lifecycle and popup tests, builds both components, verifies the native app signature and checks the native status command. It produces:

- `build/EcoGuard.app` — a native menu bar application.
- `build/extension/` — an unpacked Manifest V3 extension.

Individual commands:

```sh
npm run check
npm test
npm run build:extension
npm run build:desktop
```

## Try the native app

Open `build/EcoGuard.app` in Finder. A leaf icon appears in the macOS menu bar. Open its menu to see the build status, view About EcoGuard or quit. This foundation build does not inspect or change other applications.

For a check that does not start the GUI:

```sh
build/EcoGuard.app/Contents/MacOS/EcoGuard --status
```

The app uses a local ad hoc signature. It is intended for development on the Mac that builds it, rather than notarized distribution. The Swift build disables SwiftPM's nested build sandbox to work inside restricted development environments; it does not change macOS security settings.

## Try the browser extension

1. Open `chrome://extensions` in Chrome 120 or later.
2. Enable Developer mode, choose Load unpacked and select `build/extension`.
3. Open EcoGuard from the browser's extension menu.
4. Save an inactivity threshold from 5 to 1440 minutes. Reopen the popup to verify it persisted.
5. Eligible background tabs unload after the threshold (30 minutes by default), with five minutes of interaction grace. Selecting an unloaded tab reloads it. **Pause automatic unloading** stops this behavior for the current browser session; **Resume automatic unloading** restarts it. Browser restart clears pause and grants all tabs fresh inactivity grace.
6. The **Close unloaded tabs (N)** button closes the displayed selection of unloaded tabs across all browser windows, including tabs unloaded by Chrome itself. It is disabled when none are available. Active, pinned and private tabs are kept; tabs restored since opening the popup are skipped. Closing runs only when clicked, without an additional prompt, and the popup reports successes, skips and failures.
7. **Protect this tab** prevents automatic unloading until unprotected, closed or the browser session ends. **Protect this site** saves protection for the displayed hostname and its subdomains. Expand **Manage protected sites** to remove an exact saved rule, including a default rule. The popup lists matching rules so inherited parent-site protection remains visible even after removing a narrower rule. These exceptions prevent automatic unloading; the explicit close button still closes its selected unloaded tabs.
8. **Restore last unloaded tab** selects the most recent available tab confirmed as unloaded by EcoGuard and focuses its browser window. Chrome reloads the existing tab normally; closed or navigated tabs are not recreated. The displayed selection is revalidated when clicked. Tabs unloaded only by Chrome are outside this restore control. It is disabled when no confirmed EcoGuard tab is available in the current session.
9. **Export history as JSON** opens Chrome's save dialog for a local metadata-only export. Check Chrome's downloads for completion; canceling or failing an export does not erase history.
10. Under **Reset local data**, choose **Clear history**, **Reset learned delays** or **Reset all EcoGuard data**. Each presents its scope with Cancel and Confirm reset. The full reset restores the 30-minute threshold/default protected sites, clears history/learning/tab exceptions/restore records, grants fresh observation grace and leaves automatic unloading paused for the browser session. It does not close or reload tabs, change page content, clear page edit flags or delete previous export files.
11. **Clear edit protection** is available only when the current page can be inspected and is marked edited. Save work first, review the confirmation and confirm. This clears only the edit flag and restarts five-minute interaction grace; new edits protect again. Tab/site, media, embedded-frame and other safety protections remain independent.

For a manual check, open a disposable background tab and discard it using `chrome://discards`. Reopen EcoGuard and check that the count increases. Click **Close unloaded tabs** and verify that the tab disappears while loaded and pinned tabs remain. Also test restoring or pinning a discarded tab in another window before clicking; it must be skipped. The action reads the browser's discarded state and uses the [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-remove), without requesting additional permissions. Chrome does not provide an atomic conditional close, so a state change between the final lookup and removal remains a narrow race.

The extension requests `storage`, `tabs`, `alarms` and `downloads`, plus content-script access to HTTP/HTTPS pages. These support local/session state, URL and tab-state checks, minute alarms and a conservative global download veto. Reload the extension, accept any updated permission prompt and refresh existing pages after updating: tracking must begin at document load. Missing page receivers remain protected. The probe retains only an edited flag and an interaction timestamp in each page; inspection returns safety flags on request without collecting typed text or field values. Nothing is sent to a server.

## Source layout

- `extension/` contains the manifest, service worker, popup, preference service and tests.
- `desktop/` is a Swift package with an `EcoGuardCore` library and an AppKit executable.
- `scripts/` contains validation, packaging and verification commands.
- `docs/Source_Traceability.md` maps the proposal to planned deliverables.
- `docs/Implementation_Status.md` records completed code milestones and remaining checks.

The full design document stays local and ignored. Generated build products and tool caches also stay out of Git.

## Second code milestone progress

The browser eligibility engine completes design chunk 03 in `extension/hostname.js`, `extension/policy.js` and `extension/learning.js`:

- Normalize hostnames and HTTP/HTTPS URLs, including international domain names.
- Match protected sites by exact hostname or subdomain boundary.
- Exclude active, pinned, audible, private, discarded, browser-protected and loading tabs.
- Apply the configured inactivity threshold and five-minute interaction grace.
- Reject unknown tab state and missing or invalid activity timestamps.
- Protect tabs with three activations in the inclusive rolling thirty-minute window.
- Require fresh, matching safety observations and explicit absence of downloads.
- Double an exact hostname's idle delay after a confirmed rapid restore, capped at 24 hours, retaining the newest 100 learned hosts.
- Validate and preserve learned delays through preference saves, with a pure reset helper.

`evaluateBasicEligibility({ tab, activity, settings, now, paused })` provides a preliminary `candidate` result. `evaluateEligibility({ tab, activity, settings, now, paused, safety, downloadsInProgress })` combines it with reuse and safety checks and returns `eligible` plus a reason. All timestamps use epoch milliseconds. Both functions are pure; chunk 05's worker supplies live observations and performs the browser action. Saved inactivity preferences preserve normalized site protections and learning, including when upgrading older settings.

Safety observations must match the tab ID and exact URL, be no older than five seconds, and explicitly report successful inspection and safe page flags. Missing observations reject eligibility. The page probe fulfills this input contract within the documented limits of observable page state.

`applyRestoreFeedback({ settings, discard, tab, now })` returns updated settings after activation of the same confirmed discarded tab on the same hostname within two minutes, including the exact boundary. `resetLearnedDelays(settings)` removes learning while preserving other preferences. The worker persists feedback and consumes each confirmed discard record at most once. The repository foundation corresponds to design chunk 02; design chunk 01 was documentation and traceability.

## Page safety probe — chunk 04

`extension/page-safety.js` runs in the isolated top-level HTTP/HTTPS document from `document_start`. Captured edit events set a sticky flag for form and contenteditable work. Submission, form reset, hash/history navigation and BFCache restoration retain that flag. A full new document starts fresh. Trusted keyboard, pointer, touch, wheel and scroll activity updates interaction time; new documents and BFCache restores receive fresh grace. No input values, page text, media track data or embedded documents are read.

On request, the script checks audio/video playback, attached media providers and embedded frames/plugins, including inside open shadow trees. Muted playback and paused elements with attached streams remain protected. Loading, late-attached, hidden/unloaded, failed or oversized inspections return `inspected: false`. Inspection is bounded to 20,000 elements and 100 document/shadow roots.

`createPageSafetyClient({ tabs, now? })` from `extension/page-probe.js` provides `inspect(tab)` and `resetEdits(tab, { confirmed: true })`. Here `tabs` is the Chrome tabs API and `tab` contains the target ID and exact URL. Requests target frame 0 and time out after five seconds. The client validates the response, binds it to the requested tab and URL, strips unexpected data and produces the `safety` input for `evaluateEligibility`. Reset clears only edit protection and restarts interaction grace; it does not override media, frame or inspection failures. Chunk 06 supplies the user-facing confirmation/control. The worker reacquires tab/download state and revalidates immediately before discarding.

Capture/sharing flags conservatively protect attached media providers; false means none observed by this DOM probe. Unattached capture/WebRTC streams, closed shadow trees, noncomposed edits hidden inside them and proprietary page state remain blind spots. Default protected hosts and conservative policy still apply. Automated tests execute the content script against supplied DOM/event and Chrome message surfaces; real Chrome permission, event delivery and navigation behavior remain manual acceptance checks.

## Browser worker — chunk 05

`extension/worker.js` registers browser listeners synchronously and uses one serialized queue for lifecycle events, scans, preference changes, pause and manual closing. The named `ecoguard-scan` alarm wakes the worker about once a minute; initialization and browser lifecycle wakeups recreate a missing alarm. Duplicate pending scans coalesce. There is no polling interval or persistent worker connection.

Each scan ranks candidates by longest observed inactivity, makes at most two discard attempts and requires successful preliminary and final safety probes. It rechecks downloads and the current tab immediately before calling `chrome.tabs.discard`. Tab/download events and popup mutations invalidate any earlier pending scan synchronously, even when their queued state updates have not run yet. Busy or unreadable downloads, unknown tab/page state, changed URLs and stale probes protect the tab. Browser APIs do not provide atomic conditional discard; changes after the last checks remain a narrow race.

`chrome.storage.session.browserSession` retains activity, the three most recent activations in the rolling window, per-tab protection, pause and confirmed discard records across worker shutdown. Full navigation/replacement and newly observed tabs get fresh grace; switching away from an active tab starts its idle period. Browser restart or extension reload clears session storage and starts observation again. Corrupt session envelopes pause cleanup; corrupt individual observations get fresh grace. Storage failures stop the operation and force a durable-state reload before a later retry.

Local preferences include learned hostname delays. A confirmed rapid restore doubles the effective delay, capped at 24 hours. Discard records are consumed before the preference update, preventing duplicate learning after a crash; an interrupted update can lose that one adjustment. A browser rejection or an API response that does not confirm the same discarded tab never counts as success. The local `browserHistory` holds at most 500 events containing only timestamp, tab ID, hostname, action and reason. Exact URLs are retained only in session observations for navigation binding; history excludes URLs, titles and input values.

### Manual browser acceptance (pending)

- Reload the packaged extension, accept its permissions and refresh disposable test pages. Set the threshold to five minutes, leave one simple unedited HTTP/HTTPS page in the background and wait for a minute scan after its grace period. Check that it becomes discarded in `chrome://discards` and remains in the tab strip.
- Keep active tabs in two windows, a pinned tab, an edited form, a media-playing page and a default protected site open. None should be unloaded. An active download should veto all new unloads. Pages opened before observation without a refreshed probe should stay protected.
- Select a discarded test tab and verify normal reload. Within two minutes, this should add a doubled hostname delay under local `settings.learnedHostDelays`; inspect storage from the worker's DevTools only after the unload so inspecting does not keep the worker alive during the run.
- Pause from the popup and wait past a scan; confirm no new unloads. Resume and verify eligible tabs can unload. Use Chrome's extension service-worker stop control, then reopen the popup and confirm preferences, session pause and observation timestamps survived. Restart the browser separately and verify new grace and an unpaused session.
- Reload a background test page before its threshold expires; it should receive fresh inactivity grace. Exercise the manual close-unloaded-tabs button separately using the instructions above.

Automated tests use simulated browser/DOM surfaces, including a test that connects the real worker, transport and content-script sources. These do not establish actual Chrome permissions, trusted-event delivery, alarm timing or resource savings.

## Popup controls — chunk 06

The first half adds current-tab protection, persistent site-rule management and restore-last-unloaded. New handlers use the same popup sender checks and serialized worker queue as existing actions. Tab protection is bound to the displayed tab ID and exact URL, so a stale popup cannot silently target a different page. Site rules are validated hostnames, limited to 500, and match only the hostname itself and subdomains on a dot boundary. Removing a rule does not clear other rules, tab protection, learned delays or safety checks.

Restore uses confirmed session discard records and validates the displayed tab ID, hostname, discard timestamp and live exact URL. It skips unavailable records when finding a candidate and rejects a changed selection on click. Activation triggers the existing rapid-restore feedback path at most once. A window-focus failure is reported as partial success after selecting the tab. No new permissions are required.

Additional manual Chrome acceptance remains pending:

- Protect and unprotect the current ordinary web tab; verify the button state survives popup/worker reopening and protection survives navigation. Restart the browser separately and confirm session tab protection clears.
- Protect a site, reopen the popup and verify the saved rule. Visit a subdomain and confirm the inherited parent rule appears. Remove a rule under **Manage protected sites** and confirm only that rule is removed; remaining matching rules continue protecting the site. Saved rules must survive a browser restart.
- Open a browser settings page and confirm current-tab/site buttons are disabled while saved-site management remains usable.
- Let EcoGuard unload a disposable tab, open the popup from another tab/window and use **Restore last unloaded tab**. Confirm the same tab is selected and its window is focused, with no duplicate tab. Repeat with a closed, navigated or already restored target before clicking; it must report an error and refresh the controls.

The second half completes export and reset controls. History export uses the existing downloads permission and a save dialog, initiated by the worker so closing the popup does not own the download's lifetime. JSON contains schema version, application/version, export time and at most 500 events with timestamp, tab ID, hostname, action and reason. It excludes exact URLs, titles, page contents, preferences and session observations. The popup reports that export started, rather than claiming the file finished saving.

Clearing history preserves preferences, learning, pause and available restore records. Resetting learned delays preserves history, the chosen idle threshold and exceptions; subsequent rapid restores can learn new delays. A full reset changes only EcoGuard's named storage keys and keeps unrelated keys. It first persists pause plus a reset intent in session storage, writes default settings/empty history and fresh session observations, then clears the intent. An interrupted operation is retried on a worker restart within that browser session before scans resume. Storage errors are reported; browser restart/reload still clears session state and pause according to the normal session rules.

The popup inspects current-page safety on demand and explains edit, media, frame and detected capture/sharing protection. Edit reset requires a literal confirmed request bound to the displayed tab ID/exact URL, a fresh successful reset response and a final tab lookup. It records fresh interaction grace and preserves independent protections. Confirmation dialogs support Cancel/Escape, and controls block duplicate or overlapping resets and preference writes. No additional permissions were added.

Final manual acceptance for these controls remains pending:

- Export nonempty and empty history; verify valid JSON and the documented metadata-only fields. Cancel a save dialog and confirm history remains. Check the completed download separately from the popup's started message.
- Cancel each reset, including with Escape, and confirm no data changed. Confirm history-only and learning-only resets separately and verify unrelated settings/protections survive.
- Confirm a full reset and reopen the popup: defaults, empty history/learning, no tab exceptions or restore records, and paused automatic unloading should be visible. Existing unloaded tabs and edited pages must remain untouched. Resume manually when ready.
- On a disposable edited page, cancel edit reset first, then save work and confirm it. Confirm five-minute interaction grace, fresh edits reapplying protection, and independent media/frame/site/tab protections remaining effective. A missing probe or changed page should leave the control disabled or report an error.

Chunk 06 implementation is complete. Real Chrome popup layout/dialog focus, save dialogs, download completion, permissions, unload/restore and navigation behavior still require the documented acceptance checks; automated tests use simulated browser/DOM surfaces. Evaluation, final packaging verification and handoff remain later overall-project chunks.

## Platform references

The extension follows [Chrome's unpacked-extension workflow](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world), [local/session storage API](https://developer.chrome.com/docs/extensions/reference/api/storage), [Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs), [alarm scheduling](https://developer.chrome.com/docs/extensions/reference/api/alarms), [download state queries](https://developer.chrome.com/docs/extensions/reference/api/downloads), [isolated content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) and [message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging). The native package uses [Swift Package Manager](https://docs.swift.org/package-manager/PackageDescription/PackageDescription.html) and [AppKit status items](https://developer.apple.com/documentation/appkit/nsstatusitem).
