#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
for tool in flatpak sha256sum; do command -v "$tool" >/dev/null || { echo "Install Ubuntu's $tool package first." >&2; exit 1; }; done
[[ $(uname -m) = x86_64 ]] || { echo 'This kit requires Linux x86_64.' >&2; exit 1; }
sha256sum --check SHA256SUMS
packages=(RackTop_*_linux-amd64.flatpak)
[[ ${#packages[@]} = 1 && -f "${packages[0]}" ]] || { echo 'Expected exactly one RackTop application bundle.' >&2; exit 1; }
app_commit="$(cat APP-COMMIT.txt)"
[[ "$app_commit" =~ ^[0-9a-f]{64}$ ]] || { echo 'Invalid application commit.' >&2; exit 1; }
# Do not downgrade existing runtime deployments. No dependency resolution,
# related extensions or remote metadata are requested on this offline path.
for spec in 'org.gnome.Platform 50' 'org.freedesktop.Platform.GL.default 25.08' 'org.freedesktop.Platform.GL.default 25.08-extra'; do
  read -r runtime branch <<< "$spec"
  if ! flatpak info --user "$runtime//$branch" >/dev/null 2>&1; then
    flatpak install --user --noninteractive --bundle --no-deps --no-related "${runtime}_${branch}_x86_64.flatpak"
  fi
done
# Flatpak 1.6 reports AlreadyInstalled even with --or-update for an identical
# bundle commit. Different commits update in place and retain application data.
installed_commit="$(flatpak info --user --show-commit com.racktop.desktop//stable 2>/dev/null || true)"
if [[ "$installed_commit" != "$app_commit" ]]; then
  flatpak install --user --noninteractive --bundle --no-deps --no-related --or-update "${packages[0]}"
fi
printf '\nInstalled. Start with: flatpak run com.racktop.desktop\n'
