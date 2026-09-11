#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 CURRENT_VERSION_LINUX_AMD64.deb [OUTPUT_DIRECTORY]" >&2
  exit 2
fi
for tool in flatpak flatpak-builder dpkg-deb python3 sha256sum; do
  command -v "$tool" >/dev/null || { echo "Missing Flatpak build prerequisite: $tool" >&2; exit 1; }
done
[[ "$(uname -s)" = Linux && "$(uname -m)" = x86_64 ]] || {
  echo 'The Flatpak compatibility package currently targets Linux x86_64.' >&2
  exit 1
}

version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$root/package.json")"
deb="$(realpath "$1")"
[[ "$(dpkg-deb -f "$deb" Package)" = rack-top && "$(dpkg-deb -f "$deb" Version)" = "$version" && "$(dpkg-deb -f "$deb" Architecture)" = amd64 ]] || {
  echo 'Expected a rack-top amd64 Debian package matching the current source version.' >&2
  exit 1
}
python3 "$root/scripts/check-release-version.py"
for runtime in org.gnome.Platform org.gnome.Sdk; do
  flatpak info --user "$runtime//50" >/dev/null || {
    echo 'Install org.gnome.Platform//50 and org.gnome.Sdk//50 in the user Flatpak installation first; see packaging/flatpak/README.md.' >&2
    exit 1
  }
done

build_base="${CARGO_TARGET_DIR:-$root/src-tauri/target}/flatpak"
mkdir -p "$build_base"
build_base="$(realpath "$build_base")"
output="${2:-$build_base/output}"
mkdir -p "$output"
output="$(realpath "$output")"
stage="$(mktemp -d "$build_base/package.XXXXXX")"
trap 'status=$?; if [[ $status -ne 0 ]]; then echo "Flatpak build files retained at: $stage" >&2; fi' EXIT
cp "$root/packaging/flatpak/com.racktop.desktop.json" "$stage/"
cp "$root/packaging/flatpak/"*.patch "$stage/"
dpkg-deb -x "$deb" "$stage/deb"
mkdir "$stage/racktop-payload"
install -m755 "$stage/deb/usr/bin/racktop" "$stage/racktop-payload/racktop"
cp "$root/packaging/flatpak/"{com.racktop.desktop.desktop,com.racktop.desktop.metainfo.xml,x-terminal-emulator} "$stage/racktop-payload/"
cp "$root/src-tauri/icons/128x128.png" "$stage/racktop-payload/icon.png"
cp "$root/LICENSE" "$root/NOTICE.md" "$stage/racktop-payload/"
python3 - "$stage/racktop-payload/com.racktop.desktop.metainfo.xml" "$version" <<'PY'
from datetime import datetime, timezone
from pathlib import Path
import os
import sys
path = Path(sys.argv[1])
date = datetime.fromtimestamp(int(os.environ['SOURCE_DATE_EPOCH']), timezone.utc) if 'SOURCE_DATE_EPOCH' in os.environ else datetime.now(timezone.utc)
path.write_text(path.read_text().replace('@VERSION@', sys.argv[2]).replace('@DATE@', date.strftime('%Y-%m-%d')))
PY

flatpak-builder --user --force-clean --state-dir="$build_base/state" "$stage/build" "$stage/com.racktop.desktop.json"
# Retain an explicit version in the signed bundle metadata. The updater reads
# this before installation and from the installed deployment afterwards.
printf '\n[X-RackTop Update]\nversion=%s\n' "$version" >> "$stage/build/metadata"
flatpak build --runtime --readonly "$stage/build" /bin/sh -s < "$root/packaging/flatpak/runtime-smoke.sh"
flatpak build-export "$stage/repo" "$stage/build" stable
bundle="$output/RackTop_${version}_linux-amd64.flatpak"
flatpak build-bundle --runtime-repo=https://flathub.org/repo/flathub.flatpakrepo "$stage/repo" "$bundle" com.racktop.desktop stable
cp "$stage/repo/refs/heads/app/com.racktop.desktop/x86_64/stable" "$bundle.commit"
(cd "$output" && sha256sum "$(basename "$bundle")" > "$(basename "$bundle").sha256")
printf 'Flatpak bundle: %s\nBuild directory: %s\n' "$bundle" "$stage/build"
