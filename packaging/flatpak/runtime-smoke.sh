#!/bin/sh
# Run against org.gnome.Platform, not the SDK: SDK-only libraries can hide
# missing runtime dependencies. This check does not launch the GUI or use keys.
set -eu
for binary in /app/bin/racktop /app/bin/ssh /app/bin/ssh-keygen /app/bin/ssh-keyscan /app/lib/libayatana-appindicator3.so.1; do
  test -f "$binary"
  dependencies="$(ldd "$binary")"
  printf '%s\n' "$dependencies"
  if printf '%s\n' "$dependencies" | grep -q 'not found'; then
    printf 'Missing runtime dependency for %s\n' "$binary" >&2
    exit 1
  fi
done
test "$(command -v ssh)" = /app/bin/ssh
test -x /usr/bin/flatpak-spawn
test -c /dev/ptmx
/app/bin/ssh -V
test "$(RACKTOP_ASKPASS_PASSWORD=flatpak-runtime-fixture /app/bin/racktop)" = flatpak-runtime-fixture
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
/app/bin/ssh-keygen -q -t ed25519 -N '' -f "$temporary/key"
/app/bin/ssh-keygen -l -f "$temporary/key.pub" -E sha256
printf '%s\n' 'Flatpak runtime dependency, OpenSSH and password-helper checks passed.'
