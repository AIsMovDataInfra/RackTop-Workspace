#!/usr/bin/env python3
"""Local SSH integration: disposable passwords, no production hosts or credentials.
Run with a Python environment containing Paramiko and a feature-enabled probe:
  python scripts/test-password-jump.py /path/to/racktop-probe /path/to/test-output
"""
import base64
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import select
import socket
import subprocess
import sys
import threading
import time
import paramiko

logging.getLogger('paramiko').setLevel(logging.CRITICAL)
probe = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
output.mkdir(parents=True, exist_ok=True)
source = (Path(__file__).resolve().parents[1] / 'src-tauri/src/collector.rs').read_text()
sample = json.loads(re.search(r'const SAMPLE: &str = ("(?:[^"\\]|\\.)*");', source).group(1))
TARGET_PASSWORD = 'local-target-test-only-27'
JUMP_PASSWORD = 'different-local-jump-only-41'

class Authentication(paramiko.ServerInterface):
    def __init__(self, service):
        self.service = service
        self.destinations = {}
        self.command = None
        self.ready = threading.Event()

    def get_allowed_auths(self, username):
        return 'password'

    def check_auth_password(self, username, password):
        self.service.attempts.append({'accepted': username == 'tester' and password == self.service.password,
                                      'other_hop_secret': password == self.service.other_password})
        return paramiko.AUTH_SUCCESSFUL if username == 'tester' and password == self.service.password else paramiko.AUTH_FAILED

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == 'session' and not self.service.is_jump else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_direct_tcpip_request(self, chanid, origin, destination):
        if self.service.is_jump and self.service.forwarding and destination == ('127.0.0.1', target.port):
            self.destinations[chanid] = destination
            return paramiko.OPEN_SUCCEEDED
        return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_pty_request(self, *args):
        return True

    def check_channel_exec_request(self, channel, command):
        self.command = command.decode()
        self.ready.set()
        return True

class Service:
    def __init__(self, is_jump, password, other_password):
        self.is_jump, self.password, self.other_password = is_jump, password, other_password
        self.key = paramiko.RSAKey.generate(2048)
        self.attempts = []
        self.forwarding = True
        self.running = True
        self.connections = []
        self.socket = socket.socket()
        self.socket.bind(('127.0.0.1', 0))
        self.port = self.socket.getsockname()[1]
        self.socket.listen()
        self.socket.settimeout(.2)
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while self.running:
            try:
                client, _ = self.socket.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            threading.Thread(target=self.connection, args=(client,), daemon=True).start()

    def connection(self, client):
        transport = paramiko.Transport(client)
        self.connections.append(transport)
        authentication = Authentication(self)
        try:
            transport.add_server_key(self.key)
            transport.start_server(server=authentication)
            while self.running and transport.is_active():
                channel = transport.accept(.2)
                if channel is None:
                    continue
                if self.is_jump:
                    remote = socket.create_connection(authentication.destinations[channel.get_id()], timeout=5)
                    threading.Thread(target=self.relay, args=(channel, remote), daemon=True).start()
                elif authentication.ready.wait(5):
                    command = authentication.command
                    data = sample if '__RACKTOP_' in command else 'racktop-terminal-ok\n'
                    channel.sendall(data.encode())
                    channel.send_exit_status(0)
                    channel.close()
        except (EOFError, OSError, paramiko.SSHException):
            pass
        finally:
            transport.close()

    @staticmethod
    def relay(channel, remote):
        try:
            while True:
                ready, _, _ = select.select([channel, remote], [], [], 5)
                for src in ready:
                    data = src.recv(65536)
                    if not data:
                        return
                    (remote if src is channel else channel).sendall(data)
        except (OSError, EOFError):
            pass
        finally:
            channel.close()
            remote.close()

    def close(self):
        self.running = False
        self.socket.close()
        for transport in self.connections:
            transport.close()

    def fingerprint(self):
        return 'SHA256:' + base64.b64encode(hashlib.sha256(self.key.asbytes()).digest()).decode().rstrip('=')

target = Service(False, TARGET_PASSWORD, JUMP_PASSWORD)
jump = Service(True, JUMP_PASSWORD, TARGET_PASSWORD)
known_hosts = output / 'known_hosts'
known_hosts.write_text('')
env = dict(os.environ, RACKTOP_TEST_KNOWN_HOSTS=str(known_hosts))
draft = {'id': 'local-two-password-test', 'name': 'Local password test', 'host': '127.0.0.1', 'port': target.port,
         'username': 'tester', 'authMethod': 'password', 'password': TARGET_PASSWORD, 'savePassword': False,
         'proxyJump': f'tester@127.0.0.1:{jump.port}', 'proxyUsePassword': True,
         'proxyPassword': JUMP_PASSWORD, 'saveProxyPassword': False, 'tags': [],
         'samplingIntervalSeconds': 2, 'historyRetentionDays': 1, 'remoteHistoryEnabled': False}
results = {}

def call(action, *, fingerprint=None, changes=None, fails=False):
    payload = {'database': str(output / 'test.sqlite'), 'draft': dict(draft, **(changes or {})), 'action': action,
               'trustedFingerprint': fingerprint}
    result = subprocess.run([str(probe), '--password-test'], input=json.dumps(payload), text=True,
                            capture_output=True, timeout=25, env=env)
    for secret in [TARGET_PASSWORD, JUMP_PASSWORD]:
        assert secret not in result.stdout + result.stderr, 'A password appeared in command output'
    if fails:
        assert result.returncode != 0, result.stdout
        return result.stderr
    assert result.returncode == 0, result.stderr
    return result.stdout

try:
    assert '主机指纹' in call('collect', fails=True)
    assert not jump.attempts and not target.attempts
    results['unknown_jump_blocks_authentication'] = 'passed'
    info = json.loads(call('trust', fingerprint=jump.fingerprint()))
    assert info['isProxy'] is True
    assert not jump.attempts and not target.attempts
    results['explicit_jump_fingerprint_confirmation'] = 'passed'
    assert '主机指纹' in call('collect', fails=True)
    assert not target.attempts
    info = json.loads(call('trust', fingerprint=target.fingerprint()))
    assert info['isProxy'] is False and not target.attempts
    results['target_key_probe_sends_no_target_credentials'] = 'passed'
    snapshot = json.loads(call('collect'))
    assert snapshot['status'] == 'online' and len(snapshot['gpus']) == 1
    results['different_passwords_same_username_host_different_ports'] = 'passed'
    assert '认证失败' in call('collect', changes={'proxyPassword': 'incorrect-test-password'}, fails=True)
    results['incorrect_jump_password'] = 'passed'
    assert '认证失败' in call('collect', changes={'password': 'incorrect-test-password'}, fails=True)
    results['incorrect_target_password'] = 'passed'
    assert not any(item['other_hop_secret'] for item in jump.attempts + target.attempts)
    results['no_password_cross_delivery'] = 'passed'
    jump.forwarding = False
    assert 'administratively prohibited' in call('collect', fails=True)
    jump.forwarding = True
    results['forwarding_denied_is_reported'] = 'passed'
    assert 'racktop-terminal-ok' in call('terminal')
    results['native_pty_command_with_two_passwords'] = 'passed'
    target.key = paramiko.RSAKey.generate(2048)
    count = len(target.attempts)
    assert '主机指纹' in call('collect', fails=True)
    assert len(target.attempts) == count
    info = json.loads(call('scan'))
    assert info['changed'] and not info['isProxy']
    assert '已发生变化' in call('trust', fingerprint=target.fingerprint(), fails=True)
    results['changed_target_key_blocks_credentials_and_overwrite'] = 'passed'
    jump.key = paramiko.RSAKey.generate(2048)
    count = len(jump.attempts)
    assert '主机指纹' in call('collect', fails=True)
    assert len(jump.attempts) == count
    info = json.loads(call('scan'))
    assert info['changed'] and info['isProxy']
    results['changed_jump_key_blocks_credentials'] = 'passed'
    assert not any(item['other_hop_secret'] for item in jump.attempts + target.attempts)
    for path in output.glob('test.sqlite*'):
        data = path.read_bytes()
        assert TARGET_PASSWORD.encode() not in data and JUMP_PASSWORD.encode() not in data
    results['no_plaintext_password_in_database_or_output'] = 'passed'
    (output / 'results.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))
finally:
    jump.close()
    target.close()
