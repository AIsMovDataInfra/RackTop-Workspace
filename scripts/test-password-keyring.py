#!/usr/bin/env python3
"""Run under dbus-run-session, using isolated XDG paths and disposable secrets."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

probe = str(Path(sys.argv[1]).resolve())
root = Path(sys.argv[2]).resolve()
root.mkdir(parents=True, exist_ok=True)
for key, name in [('XDG_DATA_HOME', 'data'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache'), ('XDG_RUNTIME_DIR', 'runtime')]:
    path = root / name
    path.mkdir(exist_ok=True, mode=0o700)
    os.environ[key] = str(path)
control = root / 'runtime/keyring'
log = (root / 'daemon.log').open('w')
daemon = subprocess.Popen(['gnome-keyring-daemon', '--foreground', '--unlock', '--components=secrets', '--control-directory', str(control)], stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT)
daemon.stdin.write(b'disposable-keyring-unlock\n')
daemon.stdin.close()
target = 'fixture-target-persist-73'
proxy = 'fixture-jump-persist-91'
env = dict(os.environ, RACKTOP_TEST_EXPECT_TARGET=target, RACKTOP_TEST_EXPECT_PROXY=proxy)
draft = {'id': 'password-keyring-fixture', 'name': 'Fixture', 'host': '127.0.0.1', 'port': 2222, 'username': 'tester',
         'authMethod': 'password', 'password': target, 'savePassword': True, 'proxyUsePassword': True,
         'proxyJump': 'tester@127.0.0.1:2223', 'proxyPassword': proxy, 'saveProxyPassword': True,
         'tags': [], 'samplingIntervalSeconds': 2, 'historyRetentionDays': 1, 'remoteHistoryEnabled': False}

def call(draft_value, action='credentials'):
    payload = {'database': str(root / 'test.sqlite'), 'serverId': draft['id'], 'draft': draft_value, 'action': action}
    result = subprocess.run([probe, '--password-test'], input=json.dumps(payload), text=True, capture_output=True, env=env, timeout=20)
    assert target not in result.stdout + result.stderr and proxy not in result.stdout + result.stderr
    assert result.returncode == 0, result.stderr

try:
    for attempt in range(30):
        check = subprocess.run(['gdbus', 'call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.freedesktop.secrets'], text=True, capture_output=True)
        if 'true' in check.stdout:
            break
        time.sleep(.1)
    call(draft)
    call(None)
    call(dict(draft, password=None, proxyPassword=None, saveProxyPassword=False))
    env.pop('RACKTOP_TEST_EXPECT_PROXY')
    call(None)
    env['RACKTOP_TEST_EXPECT_PROXY'] = proxy
    call(draft)
    call(None, 'delete')
    for path in root.glob('test.sqlite*'):
        data = path.read_bytes()
        assert target.encode() not in data and proxy.encode() not in data
    result = {'separate_secret_service_entries': 'passed', 'restart_recovers_both_passwords': 'passed',
              'uncheck_save_removes_persistent_jump_password': 'passed', 'target_password_preserved': 'passed',
              'delete_removes_both_password_entries': 'passed', 'no_passwords_in_sqlite': 'passed'}
    (root / 'results.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
finally:
    daemon.terminate()
    try:
        daemon.wait(timeout=5)
    except subprocess.TimeoutExpired:
        daemon.kill()
        daemon.wait()
    log.close()
