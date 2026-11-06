# EcoGuard

EcoGuard is a local Chromium extension and macOS menu bar app for managing unused resources. The first code milestone provides runnable app shells, local browser preferences and repeatable builds. Automatic tab cleanup, resource monitoring and desktop process actions belong to later milestones.

## Build and verify

Requirements: macOS 13 or later, Apple Command Line Tools with Swift 5.9 or later, Node.js 20 or later with npm, and Python 3. All dependencies are platform frameworks or standard libraries. No package installation, paid service or account is needed to build locally.

```sh
npm run verify
```

This validates the extension, runs preference persistence tests, builds both components, verifies the native app signature and checks the native status command. It produces:

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

The extension currently requests only local storage access. It does not inspect pages, read browsing history, unload tabs or close tabs. Later milestones will introduce the necessary permissions with the corresponding functionality.

## Source layout

- `extension/` contains the manifest, service worker, popup, preference service and tests.
- `desktop/` is a Swift package with an `EcoGuardCore` library and an AppKit executable.
- `scripts/` contains validation, packaging and verification commands.
- `docs/Source_Traceability.md` maps the proposal to planned deliverables.
- `docs/Implementation_Status.md` records completed code milestones and remaining checks.

The full design document stays local and ignored. Generated build products and tool caches also stay out of Git.

## Next code milestone

Implement the browser eligibility engine from design chunk 03. The repository and build foundation implemented here corresponds to design chunk 02; design chunk 01 was the earlier documentation and traceability work.

## Platform references

The extension follows [Chrome's unpacked-extension workflow](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world) and [local storage API](https://developer.chrome.com/docs/extensions/reference/api/storage). The native package uses [Swift Package Manager](https://docs.swift.org/package-manager/PackageDescription/PackageDescription.html) and [AppKit status items](https://developer.apple.com/documentation/appkit/nsstatusitem).
