#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ "$(uname -s)" != Linux ]]; then
  echo 'Linux packages must be built on Linux.' >&2
  exit 1
fi

for tool in node npm cargo pkg-config ssh; do
  command -v "$tool" >/dev/null || { echo "Missing build prerequisite: $tool" >&2; exit 1; }
done
pkg-config --exists gtk+-3.0 webkit2gtk-4.1 ayatana-appindicator3-0.1 dbus-1 openssl || {
  echo 'Missing Linux development libraries; see docs/LINUX.md.' >&2
  exit 1
}

npm run tauri -- build --bundles deb -- "$@"
bundle_dir="${CARGO_TARGET_DIR:-src-tauri/target}/release/bundle/deb"
shopt -s nullglob
packages=("$bundle_dir"/*.deb)
if ((${#packages[@]} == 0)); then
  echo "No Debian package found in $bundle_dir" >&2
  exit 1
fi
for package in "${packages[@]}"; do
  dpkg-deb --info "$package"
  (cd "$(dirname "$package")" && sha256sum "$(basename "$package")" > "$(basename "$package").sha256")
done
