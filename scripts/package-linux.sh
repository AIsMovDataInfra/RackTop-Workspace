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
version="$(node -p 'require("./package.json").version')"
package="$bundle_dir/RackTop_${version}_amd64.deb"
release_package="$bundle_dir/RackTop_${version}_linux-amd64.deb"
if [[ ! -f "$package" ]]; then
  echo "Expected Debian package was not built: $package" >&2
  exit 1
fi
mv -f -- "$package" "$release_package"
dpkg-deb --info "$release_package"
(cd "$bundle_dir" && sha256sum "$(basename "$release_package")" > "$(basename "$release_package").sha256")
