#!/usr/bin/env python3
"""Exercise Tauri's real HTTP downloader and RackTop's trusted package checks."""
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

probe, package = map(lambda value: Path(value).resolve(), sys.argv[1:3])
original_bytes = package.read_bytes()
original_manifest = json.loads((package.parent / 'linux-amd64.json').read_text())
version = original_manifest['version']
# The first Workspace installer must upgrade an existing 1.x Linux installation.
previous_version = '1.30.0-linux.12'
state = {'manifest': original_manifest, 'bytes': original_bytes, 'status': 200}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps(state['manifest']).encode() if self.path == '/manifest.json' else state['bytes']
        self.send_response(state['status'])
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
endpoint = f'http://127.0.0.1:{server.server_port}'
results = []


def reset():
    state.update(manifest=copy.deepcopy(original_manifest), bytes=original_bytes, status=200)
    state['manifest']['platforms']['linux-x86_64-deb']['url'] = endpoint + '/package.deb'


def check(name, current, expected, success=True):
    result = subprocess.run([str(probe), '--download-update-test', endpoint + '/manifest.json', current], capture_output=True, text=True, timeout=30)
    output = result.stdout + result.stderr
    assert (result.returncode == 0) == success, f'{name}: {output}'
    assert expected in output, f'{name}: {output}'
    results.append(name)


try:
    reset()
    check('signed update download and metadata', previous_version, f'verified update {version}')
    check('same version has no update', version, 'no update')
    check('newer client is not downgraded', '9.0.0-linux.1', 'no update')
    state['bytes'] = original_bytes[:-1] + bytes([original_bytes[-1] ^ 1])
    check('tampered package rejected', previous_version, 'signature', False)
    reset()
    state['manifest']['platforms']['linux-x86_64-deb']['signature'] = 'invalid'
    check('invalid signature rejected', previous_version, 'Invalid padding', False)
    reset()
    state['manifest']['version'] = version.rsplit('.', 1)[0] + '.' + str(int(version.rsplit('.', 1)[1]) + 1)
    check('signed package with mismatched manifest version rejected', previous_version, '版本或架构不匹配', False)
    reset()
    state['status'] = 500
    check('failed endpoint is reported', previous_version, '', False)
    signature = Path(str(package) + '.sig')
    valid = subprocess.run([str(probe), '--verify-update-files', str(package), str(signature)], capture_output=True, text=True)
    assert valid.returncode == 0, valid.stderr
    results.append('release signer matches embedded production public key')
    with tempfile.TemporaryDirectory() as directory:
        corrupted = Path(directory) / package.name
        corrupted.write_bytes(original_bytes + b'tampered')
        invalid = subprocess.run([str(probe), '--verify-update-files', str(corrupted), str(signature)], capture_output=True, text=True)
        assert invalid.returncode != 0
        results.append('release verifier rejects modified bytes')
    print(json.dumps({'passed': len(results), 'checks': results}, ensure_ascii=False, indent=2))
finally:
    server.shutdown()
    server.server_close()
