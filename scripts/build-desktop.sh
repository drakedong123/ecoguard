#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The desktop target requires macOS 13 or later and Apple Command Line Tools." >&2
  exit 1
fi
mkdir -p "$ROOT/.cache/clang" "$ROOT/.cache/swiftpm/cache" "$ROOT/.cache/swiftpm/config" "$ROOT/.cache/swiftpm/security"
export CLANG_MODULE_CACHE_PATH="$ROOT/.cache/clang"
export SWIFTPM_MODULECACHE_OVERRIDE="$ROOT/.cache/clang"
OPTIONS=(--package-path "$ROOT/desktop" --disable-sandbox --cache-path "$ROOT/.cache/swiftpm/cache" --config-path "$ROOT/.cache/swiftpm/config" --security-path "$ROOT/.cache/swiftpm/security" -c release)
swift build "${OPTIONS[@]}"
BIN_DIR="$(swift build "${OPTIONS[@]}" --show-bin-path)"
APP="$ROOT/build/EcoGuard.app"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN_DIR/EcoGuard" "$APP/Contents/MacOS/EcoGuard"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>EcoGuard</string>
  <key>CFBundleIdentifier</key><string>org.ecoguard.app</string>
  <key>CFBundleName</key><string>EcoGuard</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
plutil -lint "$APP/Contents/Info.plist"
codesign --force --sign - "$APP"
codesign --verify --strict "$APP"
printf 'Built %s\n' "$APP"
