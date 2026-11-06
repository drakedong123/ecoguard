#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm run check
npm test
npm run build
python3 - "$ROOT" <<'PY'
import json
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1])
binary = root / 'build/EcoGuard.app/Contents/MacOS/EcoGuard'
result = subprocess.run([str(binary), '--status'], check=True, capture_output=True, text=True)
status = json.loads(result.stdout)
assert status['version'] == '0.1.0'
assert status['automaticCleanupAvailable'] is False
assert status['processActionsAvailable'] is False
assert status['externalDependencies'] == []
assert subprocess.run([str(binary), '--invalid'], capture_output=True).returncode == 2
assert (root / 'build/extension/manifest.json').is_file()
assert not (root / 'build/extension/tests').exists()
print('Native CLI and both packaged build outputs verified.')
PY
git diff --check
git check-ignore docs/EcoGuard_Design.md build/EcoGuard.app/Contents/Info.plist build/extension/manifest.json
