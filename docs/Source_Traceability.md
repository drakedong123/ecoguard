# EcoGuard Source Traceability

Chunk 01 deliverable · 6 November 2026

This checklist maps the seven slides in `EcoGuard_Project_Proposal_final.pptx` to the planned implementation and verification. The full specification is maintained locally in `docs/EcoGuard_Design.md`, which remains excluded from Git. This file records requirements and planned checks; it does not claim that later implementation chunks or product tests are complete.

## Chunk 01 completion

- [x] Review all seven proposal slides against the local design.
- [x] Define the target as macOS 13 or later and Chromium browsers with Chrome 120 or later extension APIs.
- [x] Choose free platform frameworks and standard libraries, with no paid service or production package dependency.
- [x] Document platform limitations, protection rules and recovery behavior.
- [x] Define controlled baseline and treatment evaluation, including overhead and unwanted interventions.
- [x] Divide delivery into 14 ordered chunks with outputs, dependencies and exit conditions.
- [x] Map slide requirements to implementation chunks and observable acceptance checks below.
- [x] Keep the full design document out of the tracked files.

The requirements below have been traced to the design. Their acceptance checks remain pending until the corresponding implementation chunks run.

## Slide 1 Project purpose

**EG-01 Resource management with little user attention.** Build a browser extension and a quiet desktop manager for unused resources. Implementation: chunks 05, 07–10. Acceptance: the components observe activity without a persistent dashboard, and interventions appear in a bounded local history.

The implementation uses tab unloading and controlled desktop actions. It never deletes tabs, force quits applications or automatically closes applications.

## Slide 2 Motivation

**EG-02 Demonstrate resource effects rather than assume them.** Compare equivalent background workloads with EcoGuard disabled and enabled. Implementation: chunks 11–13. Acceptance: preserve raw observations and report paired CPU, RSS, network and available battery differences, together with EcoGuard's own overhead. Treat battery-life improvement as an experimental result, not a guaranteed benefit.

## Slide 3 Two components and minimal interface

**EG-03 Browser extension.** Find idle tabs and unload their contents while retaining each tab. Implementation: chunks 03–06. Acceptance: eligible background fixtures become discarded without changing the number of open tabs.

**EG-04 Desktop manager.** Observe user applications and recommend actions after inactivity. Implementation: chunks 07–10. Acceptance: an enrolled disposable app can become a recommendation candidate, while unapproved and protected apps receive no intervention.

**EG-05 Quiet operation.** Use a browser popup, a native menu bar item and a small actionable corner panel. Implementation: chunks 06 and 10. Acceptance: routine monitoring opens no dashboard or focus-stealing window; dismissal suppresses repeat recommendations for the configured cooldown.

**EG-06 Consistent inactivity principles.** Both components protect recent activity and apply conservative eligibility rules. Implementation: chunks 03 and 08. Acceptance: their policy tests reject recently used resources. Browser and desktop settings remain local and independent; synchronization is outside this release.

## Slide 4 Browser requirements

**EG-07 Activity tracking and session recovery.** Track tab activity automatically across extension worker restarts. Implementation: chunks 04–05. Acceptance: stopping and restarting the service worker preserves session observations, while a new browser session grants fresh inactivity grace.

**EG-08 Unload without closing.** Use browser-native tab discarding. Implementation: chunk 05. Acceptance: automatic cleanup leaves the tab in the strip and selecting it triggers normal browser reload. A failed discard does not count as a successful intervention. User-requested addition on 12 November 2026: a separate manual button closes the displayed selection of still-unloaded tabs across windows, including Chrome-discarded tabs, while keeping active/pinned/private tabs.

**EG-09 Protected browser work.** Exclude active, pinned, audible, edited, recently used and otherwise uncertain pages. Implementation: chunks 03–05. Acceptance: protected fixtures receive zero EcoGuard discard calls, including after a final state change just before intervention.

**EG-10 Site and tab exceptions.** Allow explicit protection for a tab or hostname. Implementation: chunks 03 and 06. Acceptance: exceptions survive worker shutdown; a hostname matches itself and subdomains on a dot boundary without matching unrelated hosts.

**EG-11 Browser overhead.** Wake periodically rather than keep the extension worker alive with a polling timer. Implementation: chunks 05 and 13. Acceptance: inspect alarm-based scheduling and measure overhead during controlled idle runs.

## Slides 4 and 5 Desktop requirements

**EG-12 CPU and memory observations.** Sample cumulative CPU time, CPU percentage and RSS for the application's main process. Implementation: chunk 07. Acceptance: valid samples contain units and process identity; inaccessible processes do not produce invented measurements. Helper-process resource use is outside the initial attribution scope.

**EG-13 Network and energy observations.** Record physical-interface network counters, available battery percentage and power source. Implementation: chunks 07 and 12. Acceptance: label these as system observations, preserve unavailable values, reject invalid counter differences and exclude charging or AC runs from battery-discharge comparisons. Per-app network and energy attribution are outside this release.

**EG-14 Safe action ladder.** Observe, recommend, offer lower priority, offer a confirmed short suspension, and suggest closing through the app's own UI. Implementation: chunks 08–10. Acceptance: routine automatic behavior stops at a recommendation; priority changes and suspension require user action. Explain that restoring niceness may require relaunching the target app.

**EG-15 Protected desktop processes.** Protect system apps, critical tools, other users' processes, EcoGuard and unknown identities. Implementation: chunks 07–09. Acceptance: reject these targets even if a stale preference attempts to enroll them. Recheck PID, process start time, owner and executable immediately before an action.

**EG-16 Application exceptions.** Support explicit application protection and require enrollment before recommendations or process changes. Implementation: chunks 08 and 10. Acceptance: protecting or unenrolling an app prevents further actions and resumes any active EcoGuard suspension lease.

**EG-17 Bounded suspension recovery.** Start and arm an independent resume watchdog before stopping a target. Implementation: chunk 09. Acceptance: a disposable process resumes after timeout and controller failure; failed watchdog readiness prevents suspension. Foreground activation, pause monitoring, protection and normal quit request earlier resume.

Suspension does not itself release the application's RSS. Memory effects must be measured without presenting retained memory as freed memory.

## Slide 6 Decision model

**EG-18 Recent activity and reuse.** Require an inactivity threshold and protect frequent browser revisits. Implementation: chunks 03 and 08. Acceptance: boundary tests cover just below, at and above the idle threshold; browser reuse within the rolling window vetoes unloading.

**EG-19 Audio, downloads and unsaved work.** Protect browser pages with detectable activity and fail closed when page inspection fails. Implementation: chunks 03–05. Acceptance: edited, playing-media, embedded-frame and uninspectable fixtures remain protected, and an active browser download vetoes unloading.

Desktop APIs cannot reliably establish that an arbitrary application has no unsaved work, audio, downloads or synchronization. Desktop suspension therefore remains explicitly confirmed for each action. Browser checks also have documented blind spots, including proprietary state and some capture mechanisms; tests must not describe those checks as a universal guarantee.

**EG-20 Conservative selection.** Combine long inactivity with available resource evidence and safety checks. Implementation: chunks 03, 05 and 08. Acceptance: desktop candidates meet CPU or RSS thresholds; browser candidates use age and reuse proxies because ordinary tab APIs lack reliable per-tab resource counters. Existing tabs receive a full observation grace period, and browser scans act on at most two candidates.

**EG-21 Feedback-based adjustment.** Increase the site's idle delay after a rapid return to an unloaded tab. Implementation: chunks 03, 05 and 06. Acceptance: the restored site's threshold doubles up to 24 hours, the learned-host collection stays bounded and a local reset removes learning. This is a rule adjustment, not a trained model.

## Slide 7 Evaluation

**EG-22 Paired workloads.** Compare the same workloads with EcoGuard disabled and enabled, alternating run order. Implementation: chunks 11–12. Acceptance: collect at least three pairs for the intended evaluation, preserve raw runs and reject incompatible workload, platform or duration metadata.

**EG-23 Resource measurements.** Report CPU-seconds differences, RSS observations, network-byte differences and available battery-discharge differences. Implementation: chunks 07 and 12. Acceptance: units and attribution limits accompany every result. Optional energy conversion requires a supplied coefficient and a modeled-energy label. No default energy-savings number is fabricated.

**EG-24 User disruption and restore speed.** Record unwanted interventions, rapid restores and reload latency. Implementation: chunks 11–14. Acceptance: protected fixtures receive zero interventions, no tabs close, and real-browser restore latency is measured separately from mocked API tests. Report counts with denominators.

**EG-25 Low overhead.** Measure EcoGuard's CPU and RSS during idle observation. Implementation: chunks 07 and 13. Acceptance targets: median CPU below 1 percent of one core and main-process RSS below 80 MiB. Measure local-fixture restore latency against a median target below two seconds. These are targets until measured.

## Additional implementation constraints

The following decisions make the proposed project feasible within the chosen platform and cost constraints. They are implementation decisions rather than claims made by the slides.

- Swift, AppKit, Foundation, IOKit and a small C target provide the native implementation. JavaScript and Manifest V3 provide the extension. Node.js and Python standard-library tools support verification and evaluation.
- Personal local builds require no store account, paid signing certificate, hosted backend, paid API or subscription. Wider distribution and notarization require a separate release decision.
- Page probes exchange state flags and timestamps, never typed text. Histories omit full page URLs and titles. No telemetry or cloud synchronization is included.
- Storage is local, bounded and validated. Desktop writes are atomic and restricted to the current user. Export happens on request.
- Automated process-control tests act only on disposable processes created by the test. Real browser behavior, native UI behavior and battery performance require separate acceptance evidence.

## Handoff to chunk 02

Chunk 02 creates the repository structure, zero-dependency Swift package, extension manifest and repeatable build commands. Later chunks implement the requirements above. Chunk 01 introduces no application executable, browser permission grant or background service.
