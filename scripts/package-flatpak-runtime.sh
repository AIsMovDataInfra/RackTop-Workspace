#!/usr/bin/env bash
# Export a local-only installation kit for Focal's Flatpak 1.6, which cannot
# read today's oversized Flathub summary. No system installation is changed.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ $# = 2 ]] || { echo "Usage: $0 RACKTOP.flatpak OUTPUT_DIRECTORY" >&2; exit 2; }
for tool in flatpak python3 tar sha256sum; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
version="$(python3 "$root/scripts/check-release-version.py" | awk '{print $NF}')"
app="$(realpath "$1")"
[[ $(basename "$app") = "RackTop_${version}_linux-amd64.flatpak" && -s "$app" ]] || { echo 'Expected the current RackTop Flatpak bundle' >&2; exit 1; }
[[ -f "$app.commit" && $(cat "$app.commit") =~ ^[0-9a-f]{64}$ ]] || { echo 'Missing application commit sidecar from package-flatpak.sh' >&2; exit 1; }
mkdir -p "$2"
output="$(realpath "$2")"
base="${CARGO_TARGET_DIR:-$root/src-tauri/target}/flatpak/offline"
mkdir -p "$base"
stage="$(mktemp -d "$base/kit.XXXXXX")"
kit="$stage/RackTop_${version}_flatpak_offline"
mkdir "$kit"
cp "$app" "$kit/"
cp "$app.commit" "$kit/APP-COMMIT.txt"
cp "$root/scripts/install-flatpak-offline.sh" "$kit/install.sh"
# Resolve the actual user installation from Flatpak rather than assuming HOME.
location="$(flatpak info --user --show-location org.gnome.Platform//50)"
repo="$(realpath "$location/../../../../../repo")"
[[ -d "$repo/objects" ]] || { echo "Missing user OSTree repository: $repo" >&2; exit 1; }
: > "$kit/RUNTIME-COMMITS.txt"
for spec in 'org.gnome.Platform 50' 'org.freedesktop.Platform.GL.default 25.08' 'org.freedesktop.Platform.GL.default 25.08-extra'; do
  read -r runtime branch <<< "$spec"
  commit="$(flatpak info --user --show-commit "$runtime//$branch")"
  printf '%s/x86_64/%s %s\n' "$runtime" "$branch" "$commit" >> "$kit/RUNTIME-COMMITS.txt"
  flatpak build-bundle --runtime --arch=x86_64 "$repo" "$kit/${runtime}_${branch}_x86_64.flatpak" "$runtime" "$branch"
done
cp "$root/LICENSE" "$root/NOTICE.md" "$kit/"
cat > "$kit/README.txt" <<'TEXT'
RackTop Ubuntu 20.04 amd64 offline runtime kit

Install Ubuntu's flatpak package first, extract this complete directory, then:
  bash install.sh
  flatpak run com.racktop.desktop

The installer verifies SHA256SUMS and installs only these local bundles, without
consulting Flathub or changing system libraries. It uses your user installation.
Existing GNOME 50 / Mesa runtime deployments are retained rather than downgraded.
RackTop data uses ~/.var/app/com.racktop.desktop and is separate from a DEB install.
To update RackTop, obtain a newer verified kit and run its installer. The DEB
updater is disabled in the Flatpak app. The installer does NOT update runtimes
that are already present. To replace those runtimes with a newer kit's versions,
first compare RUNTIME-COMMITS.txt with `flatpak info --user --show-commit ID//BRANCH`
and check the kit's date. The following explicit replacement can also downgrade
a newer installed runtime, so only use it with the intended newer kit:
  sha256sum --check SHA256SUMS
  flatpak install --user --bundle --no-deps --no-related --or-update org.gnome.Platform_50_x86_64.flatpak
  flatpak install --user --bundle --no-deps --no-related --or-update org.freedesktop.Platform.GL.default_25.08_x86_64.flatpak
  flatpak install --user --bundle --no-deps --no-related --or-update org.freedesktop.Platform.GL.default_25.08-extra_x86_64.flatpak

The included Mesa drivers cover the portable graphics path; proprietary NVIDIA
hardware acceleration needs its matching Flatpak driver extension separately.
If that extension is unavailable, try:
  flatpak run --env=LIBGL_ALWAYS_SOFTWARE=1 com.racktop.desktop

GNOME runtime sources: https://gitlab.gnome.org/GNOME/gnome-build-meta
Freedesktop/Mesa runtime sources: https://gitlab.com/freedesktop-sdk/freedesktop-sdk
Runtime contents retain their upstream license files. RUNTIME-COMMITS.txt records
exact upstream commits; distribution source manifests pin their component sources.
This kit is not a complete operating system or a replacement for OS maintenance.
TEXT
(cd "$kit" && sha256sum ./*.flatpak install.sh APP-COMMIT.txt RUNTIME-COMMITS.txt LICENSE NOTICE.md README.txt > SHA256SUMS)
archive="$output/RackTop_${version}_linux-amd64-flatpak-offline.tar.gz"
# Inner bundles are already compressed; low gzip effort avoids excessive memory.
tar -C "$stage" -cf - "$(basename "$kit")" | gzip -1 > "$archive"
(cd "$output" && sha256sum "$(basename "$archive")" > "$(basename "$archive").sha256")
printf 'Offline kit: %s\nExpanded kit: %s\n' "$archive" "$kit"
