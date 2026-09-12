#!/bin/sh
# Run against org.gnome.Platform, not the SDK: SDK-only libraries can hide
# missing runtime dependencies. This check does not launch the GUI or use keys.
set -eu
for binary in /app/bin/racktop /app/bin/ssh /app/bin/ssh-keygen /app/bin/ssh-keyscan /app/libexec/ssh-pkcs11-helper /app/libexec/ssh-sk-helper /app/lib/libayatana-appindicator3.so.1; do
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
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
# The operation-bound helper must reject a missing channel and must not fall
# back to a legacy environment password or start the GUI. Successful target +
# jump authentication is covered separately by test-ssh-hardening.py with real
# loopback SSH processes; this dependency smoke is not an authentication test.
if helper_output="$(RACKTOP_ASKPASS_SOCKET="$temporary/missing-socket" \
  RACKTOP_ASKPASS_TOKEN=00000000000000000000000000000000 \
  RACKTOP_ASKPASS_PASSWORD=flatpak-runtime-fixture \
  timeout 5 /app/bin/racktop)"; then
  printf '%s\n' 'Password helper accepted an unavailable channel.' >&2
  exit 1
else
  test "$?" -eq 1
fi
test -z "$helper_output"
/app/bin/ssh-keygen -q -t ed25519 -N '' -f "$temporary/key"
/app/bin/ssh-keygen -l -f "$temporary/key.pub" -E sha256
printf '%s\n' 'Flatpak runtime dependency, OpenSSH and closed-password-channel rejection checks passed.'
