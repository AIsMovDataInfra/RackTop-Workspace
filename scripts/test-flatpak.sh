#!/usr/bin/env bash
# Install the supplied bundle in the user Flatpak installation, then smoke-test
# its application runtime and native WebKit process using disposable app data.
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 RACKTOP.flatpak [EVIDENCE_DIRECTORY]" >&2
  exit 2
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bundle="$(realpath "$1")"
evidence="${2:-$(dirname "$bundle")/verification}"
mkdir -p "$evidence"
evidence="$(realpath "$evidence")"
for tool in flatpak dbus-run-session xvfb-run python3; do
  command -v "$tool" >/dev/null || { echo "Missing Flatpak smoke-test prerequisite: $tool" >&2; exit 1; }
done
expected_commit="$(cat "$bundle.commit")"
[[ "$expected_commit" =~ ^[0-9a-f]{64}$ ]] || { echo 'Missing or invalid build commit sidecar.' >&2; exit 1; }
if [[ "$(flatpak info --user --show-commit com.racktop.desktop//stable 2>/dev/null || true)" != "$expected_commit" ]]; then
  flatpak install --user --noninteractive --bundle --no-deps --no-related --or-update "$bundle"
fi
test "$(flatpak info --user --show-commit com.racktop.desktop//stable)" = "$expected_commit"
test "$(flatpak info --user --show-runtime com.racktop.desktop//stable)" = org.gnome.Platform/x86_64/50
dbus-run-session -- flatpak run --user --command=sh com.racktop.desktop//stable -s \
  < "$root/packaging/flatpak/runtime-smoke.sh" 2>&1 | tee "$evidence/runtime.log"

xvfb-run -a dbus-run-session -- python3 - "$evidence" <<'PY'
import json
import os
from pathlib import Path
import signal
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time

evidence = Path(sys.argv[1])


def webkit_running(data):
    # WebKit can spawn via the Flatpak portal, outside the launcher descendant
    # tree. Match this test's unique data path in the renderer's sandbox metadata.
    for process in Path('/proc').glob('[0-9]*'):
        try:
            if b'WebKitWebProcess' not in (process / 'cmdline').read_bytes():
                continue
            metadata = (process / 'root/.flatpak-info').read_text()
            if ('\nname=com.racktop.desktop\n' in metadata
                    and f'\nXDG_DATA_HOME={data}/data\n' in metadata):
                return True
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    return False


with tempfile.TemporaryDirectory(prefix='racktop-flatpak-smoke-') as temporary:
    data = Path(temporary)
    for name in ('data', 'config', 'cache'):
        (data / name).mkdir()
    database = data / 'data/com.racktop.desktop/racktop.sqlite'
    command = [
        'flatpak', 'run', '--user', '--die-with-parent', '--nosocket=wayland',
        '--nofilesystem=host', '--nofilesystem=home', f'--filesystem={data}',
        f'--env=XDG_DATA_HOME={data}/data', f'--env=XDG_CONFIG_HOME={data}/config',
        f'--env=XDG_CACHE_HOME={data}/cache', '--env=GDK_BACKEND=x11',
        '--env=LIBGL_ALWAYS_SOFTWARE=1', '--command=env', 'com.racktop.desktop//stable',
        # Flatpak 1.6 overwrites reserved XDG variables after processing --env.
        # Set them inside the sandbox before starting the actual app instead.
        f'XDG_DATA_HOME={data}/data', f'XDG_CONFIG_HOME={data}/config',
        f'XDG_CACHE_HOME={data}/cache', '/app/bin/racktop',
    ]
    with (evidence / 'native-startup.log').open('w') as output:
        process = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        webkit_seen = False
        try:
            # Survival alone does not prove the web renderer or database started.
            started = time.monotonic()
            deadline = started + 60
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(f'Flatpak exited early with status {process.returncode}; see native-startup.log')
                webkit_seen = webkit_running(data)
                if time.monotonic() - started >= 15 and database.is_file() and webkit_seen:
                    break
                time.sleep(0.25)
            if not database.is_file():
                raise RuntimeError('The native app did not initialize its isolated database')
            with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
                if connection.execute('PRAGMA quick_check').fetchone() != ('ok',):
                    raise RuntimeError('The initialized database failed SQLite quick_check')
                if not connection.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'servers'").fetchone():
                    raise RuntimeError('The initialized database lacks the servers table')
            if not webkit_seen:
                raise RuntimeError('The native app never started a WebKit web renderer')
            if shutil.which('xwd'):
                subprocess.run(['xwd', '-root', '-silent', '-out', str(evidence / 'desktop.xwd')], check=True)
            (evidence / 'native-startup.json').write_text(json.dumps({
                'bundle_runtime': 'org.gnome.Platform/x86_64/50',
                'native_survival_seconds': round(time.monotonic() - started, 2),
                'isolated_database_quick_check': 'ok',
                'webkit_web_process_started': True,
                'host_os': Path('/etc/os-release').read_text(),
            }, indent=2) + '\n')
        finally:
            # Restrict termination to this test's process group.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
print('Installed Flatpak passed runtime, native startup, SQLite and WebKit smoke checks.')
PY
