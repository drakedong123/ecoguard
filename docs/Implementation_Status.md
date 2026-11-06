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

The next milestone is the browser eligibility engine. Page safety probes, scheduled tab unloading, full popup management, native resource metrics, inactivity policy, guarded process actions, recommendation panels and evaluation workloads remain in their respective later chunks.
