#!/usr/bin/env bash
# One native/cross target per invocation; CI runs this on both native Mac runners.
set +x
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
if [ "$(uname -s)" != "Darwin" ]; then
  printf 'macOS packaging must run on macOS.\n' >&2
  exit 1
fi
APP_VERSION="$(node -p 'require("./package.json").version')"
TARGET="${RACKTOP_MACOS_TARGET:-aarch64-apple-darwin}"
SKIP_BUILD="${RACKTOP_SKIP_BUILD:-0}"
SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
FINDER_LAYOUT="${RACKTOP_DMG_FINDER_LAYOUT:-1}"
REQUIRE_UPDATER="${RACKTOP_REQUIRE_UPDATER:-1}"
for flag in "$SKIP_BUILD" "$FINDER_LAYOUT" "$REQUIRE_UPDATER"; do
  case "$flag" in 0|1) ;; *) printf 'Packaging flags must be 0 or 1.\n' >&2; exit 1 ;; esac
done
case "$TARGET" in
  aarch64-apple-darwin) ARCH_LABEL="arm64" ;;
  x86_64-apple-darwin) ARCH_LABEL="x64" ;;
  *) printf 'Unsupported macOS target: %s\n' "$TARGET" >&2; exit 1 ;;
esac
TARGET_ROOT="${CARGO_TARGET_DIR:-$ROOT_DIR/src-tauri/target}"
case "$TARGET_ROOT" in /*) ;; *) TARGET_ROOT="$ROOT_DIR/$TARGET_ROOT" ;; esac
TARGET_DIR="$TARGET_ROOT/$TARGET/release/bundle"
APP_PATH="$TARGET_DIR/macos/RackTop.app"
NOTARY_VALUES=0
for value in "${APPLE_ID:-}" "${APPLE_PASSWORD:-}" "${APPLE_TEAM_ID:-}"; do
  if [ -n "$value" ]; then NOTARY_VALUES=$((NOTARY_VALUES + 1)); fi
done
unset value
if [ "$NOTARY_VALUES" -ne 0 ] && [ "$NOTARY_VALUES" -ne 3 ]; then
  printf 'APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID must be configured together.\n' >&2
  exit 1
fi
if [ "$NOTARY_VALUES" -eq 3 ] && [ "$SIGNING_IDENTITY" = "-" ]; then
  printf 'A Developer ID signing identity is required for notarization.\n' >&2
  exit 1
fi
HAS_UPDATER=0
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || [ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]; then
  HAS_UPDATER=1
elif [ "$REQUIRE_UPDATER" = "1" ]; then
  printf 'An updater signing key is required. Set RACKTOP_REQUIRE_UPDATER=0 only for an explicit local DMG-only build.\n' >&2
  exit 1
fi
if [ "$SIGNING_IDENTITY" = "-" ]; then
  ARTIFACT_SUFFIX="-unsigned"
  SIGNING_MODE="ad-hoc"
elif [ "$NOTARY_VALUES" -eq 3 ]; then
  ARTIFACT_SUFFIX=""
  SIGNING_MODE="developer-id"
else
  ARTIFACT_SUFFIX="-unnotarized"
  SIGNING_MODE="developer-id"
fi
DMG_PATH="$TARGET_DIR/dmg/RackTop_${APP_VERSION}_macos-${ARCH_LABEL}${ARTIFACT_SUFFIX}.dmg"
UPDATER_PATH="$TARGET_DIR/macos/RackTop_${APP_VERSION}_macos-${ARCH_LABEL}${ARTIFACT_SUFFIX}.app.tar.gz"
DMG_VOLUME_NAME="Install RackTop ${APP_VERSION} ${ARCH_LABEL}"
WORK_DIR="$(mktemp -d /private/tmp/racktop-package.XXXXXX)"
STAGE_DIR="$WORK_DIR/stage"
MOUNT_DIR="$WORK_DIR/volume"
MOUNTED=0
mkdir -p "$STAGE_DIR" "$MOUNT_DIR"
cleanup() {
  if [ "$MOUNTED" = "1" ]; then
    if ! hdiutil detach "$MOUNT_DIR" >/dev/null 2>&1; then
      hdiutil detach -force "$MOUNT_DIR" >/dev/null 2>&1 || return
    fi
  fi
  case "$WORK_DIR" in /private/tmp/racktop-package.*) rm -rf "$WORK_DIR" ;; esac
}
trap cleanup EXIT

# Vite exposes TAURI_* variables. Signing credentials must not be inherited by
# npm/Vite/Rust/Swift compilation, including a configured private-key file path.
# Keep signing in separate post-build processes and suppress signer diagnostics.
clean_command() {
  python3 - "$@" <<'PY'
import os, re, subprocess, sys
secret = re.compile(r'SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIAL|CERTIFICATE', re.I)
env = {key: value for key, value in os.environ.items()
       if not key.startswith(('APPLE_', 'TAURI_SIGNING_', 'NOTARY_')) and not secret.search(key)}
# Empty overrides also prevent dotenv from loading signing material into Vite.
for key in ('TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'):
    env[key] = ''
sys.exit(subprocess.run(sys.argv[1:], env=env).returncode)
PY
}
notarize() {
  # Keep account credentials out of command echoing and tool failure diagnostics.
  python3 - "$1" <<'PY'
import json, os, subprocess, sys
command = ['xcrun', 'notarytool', 'submit', sys.argv[1], '--apple-id', os.environ['APPLE_ID'],
           '--password', os.environ['APPLE_PASSWORD'], '--team-id', os.environ['APPLE_TEAM_ID'],
           '--wait', '--output-format', 'json']
try:
    result = subprocess.run(command, capture_output=True, text=True, timeout=1800)
    payload = json.loads(result.stdout) if result.returncode == 0 else {}
except (subprocess.TimeoutExpired, ValueError):
    raise SystemExit('Notarization failed or timed out; credential-bearing diagnostics were suppressed')
if result.returncode or payload.get('status') != 'Accepted':
    raise SystemExit('Notarization was not accepted; check the Apple notary history securely')
print('Apple notarization accepted')
PY
}

if [ "$SKIP_BUILD" != "1" ]; then
  clean_command npm run tauri -- build --target "$TARGET" --bundles app \
    --config '{"bundle":{"createUpdaterArtifacts":false,"macOS":{"signingIdentity":"-"}}}' -- --locked
fi
if [ ! -d "$APP_PATH" ]; then
  printf 'RackTop.app was not found at %s\n' "$APP_PATH" >&2
  exit 1
fi
# This is the last point where bundle metadata may be cleared. Never clear it
# after stapling, or generate an updater archive before the app is notarized.
xattr -cr "$APP_PATH"
if [ "$SIGNING_MODE" = "ad-hoc" ]; then
  codesign --force --deep --sign - "$APP_PATH"
else
  codesign --force --deep --options runtime --timestamp --sign "$SIGNING_IDENTITY" "$APP_PATH"
fi
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
NOTARIZATION_MODE="not notarized"
if [ "$NOTARY_VALUES" -eq 3 ]; then
  ditto -c -k --keepParent "$APP_PATH" "$WORK_DIR/notarize-app.zip"
  notarize "$WORK_DIR/notarize-app.zip"
  xcrun stapler staple "$APP_PATH"
  xcrun stapler validate "$APP_PATH"
  spctl --assess --type execute --verbose=2 "$APP_PATH"
  NOTARIZATION_MODE="notarized and stapled"
fi

# Both containers are derived from the final sealed/stapled app. The verifier
# compares every file and symlink after extracting/mounting the actual outputs.
rm -f "$UPDATER_PATH" "$UPDATER_PATH.sig" "$UPDATER_PATH.sha256"
if [ "$HAS_UPDATER" = "1" ]; then
  COPYFILE_DISABLE=1 tar -czf "$UPDATER_PATH" -C "$(dirname "$APP_PATH")" "$(basename "$APP_PATH")"
  python3 - "$ROOT_DIR/node_modules/.bin/tauri" "$UPDATER_PATH" <<'PY'
import os, re, subprocess, sys
secret = re.compile(r'SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIAL|CERTIFICATE', re.I)
env = {key: value for key, value in os.environ.items()
       if not key.startswith(('APPLE_', 'NOTARY_')) and not secret.search(key)}
for key in ('TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'):
    if key in os.environ:
        env[key] = os.environ[key]
result = subprocess.run([sys.argv[1], 'signer', 'sign', sys.argv[2]], env=env,
                        capture_output=True, text=True, timeout=120)
if result.returncode:
    raise SystemExit('Updater signing failed; signer diagnostics were suppressed to protect key material')
PY
fi

ditto "$APP_PATH" "$STAGE_DIR/RackTop.app"
ln -s /Applications "$STAGE_DIR/Applications"
mkdir -p "$(dirname "$DMG_PATH")"
if [ "$FINDER_LAYOUT" = "1" ]; then
  mkdir -p "$STAGE_DIR/.background"
  clean_command swift "$ROOT_DIR/scripts/render-dmg-background.swift" \
    "$ROOT_DIR/src-tauri/dmg-background.svg" "$STAGE_DIR/.background/background.png" 1
  clean_command swift "$ROOT_DIR/scripts/render-dmg-background.swift" \
    "$ROOT_DIR/src-tauri/dmg-background.svg" "$STAGE_DIR/.background/background@2x.png" 2
  chflags hidden "$STAGE_DIR/.background"
  hdiutil create -volname "$DMG_VOLUME_NAME" -srcfolder "$STAGE_DIR" -ov -format UDRW "$WORK_DIR/layout.dmg"
  hdiutil attach "$WORK_DIR/layout.dmg" -readwrite -noverify -noautoopen -nobrowse -mountpoint "$MOUNT_DIR" >/dev/null
  MOUNTED=1
  osascript - "$MOUNT_DIR" <<'APPLESCRIPT'
on run argv
with timeout of 90 seconds
set volumePath to POSIX file (item 1 of argv) as alias
tell application "Finder"
  tell folder volumePath
    open
    delay 2
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set pathbar visible of container window to false
    set bounds of container window to {120, 120, 840, 544}
    set theViewOptions to the icon view options of container window
    set arrangement of theViewOptions to not arranged
    set icon size of theViewOptions to 96
    set text size of theViewOptions to 13
    set background picture of theViewOptions to file ".background:background.png"
    set position of item "RackTop.app" of container window to {205, 188}
    set position of item "Applications" of container window to {515, 188}
    close container window
    open
    update without registering applications
    delay 2
    close container window
  end tell
end tell
end timeout
end run
APPLESCRIPT
  sync
  hdiutil detach "$MOUNT_DIR" >/dev/null
  MOUNTED=0
  hdiutil convert "$WORK_DIR/layout.dmg" -format UDZO -imagekey zlib-level=9 -o "$DMG_PATH" -ov
else
  # Headless CI has no Finder automation session. A normal compressed DMG with
  # the Applications link needs no AppleScript, desktop access or layout fallback.
  hdiutil create -volname "$DMG_VOLUME_NAME" -srcfolder "$STAGE_DIR" -ov -format UDZO \
    -imagekey zlib-level=9 "$DMG_PATH"
fi
if [ "$SIGNING_MODE" = "developer-id" ]; then
  codesign --force --timestamp --sign "$SIGNING_IDENTITY" "$DMG_PATH"
  codesign --verify --verbose=2 "$DMG_PATH"
fi
if [ "$NOTARY_VALUES" -eq 3 ]; then
  notarize "$DMG_PATH"
  xcrun stapler staple "$DMG_PATH"
  xcrun stapler validate "$DMG_PATH"
fi
VERIFY_ARGS=(--target "$TARGET" --dmg "$DMG_PATH" --version "$APP_VERSION" --signing-mode "$SIGNING_MODE")
if [ "$HAS_UPDATER" = "1" ]; then VERIFY_ARGS+=(--updater "$UPDATER_PATH"); fi
if [ "$NOTARY_VALUES" -eq 3 ]; then VERIFY_ARGS+=(--notarized); fi
clean_command python3 "$ROOT_DIR/scripts/test-macos-package.py" "${VERIFY_ARGS[@]}"
python3 - "$DMG_PATH" "$UPDATER_PATH" "$HAS_UPDATER" <<'PY'
import hashlib
from pathlib import Path
import sys
for name in ([sys.argv[1], sys.argv[2]] if sys.argv[3] == '1' else [sys.argv[1]]):
    path = Path(name)
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    line = f'{digest.hexdigest()}  {path.name}\n'
    Path(str(path) + '.sha256').write_text(line)
    print(line, end='')
PY
{
  printf 'version=%s\n' "$APP_VERSION"
  printf 'target=%s\n' "$TARGET"
  printf 'signing=%s\n' "$SIGNING_MODE"
  printf 'notarization=%s\n' "$NOTARIZATION_MODE"
  printf 'finder_layout=%s\n' "$FINDER_LAYOUT"
  printf 'signed_updater=%s\n' "$HAS_UPDATER"
} | tee "$DMG_PATH.signing.txt"
printf 'DMG=%s\n' "$DMG_PATH"
if [ "$HAS_UPDATER" = "1" ]; then printf 'UPDATER=%s\n' "$UPDATER_PATH"; fi
