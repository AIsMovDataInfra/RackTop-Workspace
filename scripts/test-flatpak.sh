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
flatpak install --user --noninteractive --or-update "$bundle"
test "$(flatpak info --user --show-runtime com.racktop.desktop//stable)" = org.gnome.Platform/x86_64/50
flatpak run --user --command=sh com.racktop.desktop//stable -s \
  < "$root/packaging/flatpak/runtime-smoke.sh" 2>&1 | tee "$evidence/runtime.log"

dbus-run-session -- xvfb-run -a python3 - "$evidence" <<'PY'
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time

evidence = Path(sys.argv[1])


def descendant_commands(pid):
    """Only inspect this launch's descendants, never unrelated desktop apps."""
    pending = [pid]
    commands = []
    seen = set()
    while pending:
        child = pending.pop()
        if child in seen:
            continue
        seen.add(child)
        try:
            commands.append(Path(f'/proc/{child}/cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace'))
            # WebKit children can be created from a non-main application thread.
            for task in Path(f'/proc/{child}/task').iterdir():
                pending.extend(map(int, (task / 'children').read_text().split()))
        except (FileNotFoundError, ProcessLookupError):
            continue
    return commands


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
        '--env=LIBGL_ALWAYS_SOFTWARE=1', 'com.racktop.desktop//stable',
    ]
    with (evidence / 'native-startup.log').open('w') as output:
        process = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        webkit_seen = False
        try:
            # Survival alone does not prove the web renderer or database started.
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(f'Flatpak exited early with status {process.returncode}; see native-startup.log')
                webkit_seen |= any('WebKitWebProcess' in line for line in descendant_commands(process.pid))
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
            (evidence / 'native-startup.json').write_text(json.dumps({
                'bundle_runtime': 'org.gnome.Platform/x86_64/50',
                'native_survival_seconds': 15,
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
