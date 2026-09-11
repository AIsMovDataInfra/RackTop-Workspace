#!/usr/bin/env python3
"""Check the real Tauri signed downloader and Flatpak metadata parser, offline."""
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading


def main():
    probe, package = (Path(value).resolve() for value in sys.argv[1:3])
    test_public_key = [str(Path(sys.argv[3]).resolve())] if len(sys.argv) > 3 else []
    original_bytes = package.read_bytes()
    original_manifest = json.loads((package.parent / 'flatpak-amd64.json').read_text())
    version = original_manifest['version']
    state = {}

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
        state['manifest']['platforms']['linux-x86_64-flatpak']['url'] = endpoint + '/package.flatpak'

    def check(name, current='2.2.2', expected='', success=True):
        result = subprocess.run([str(probe), '--download-update-test', endpoint + '/manifest.json', current, 'flatpak', *test_public_key], capture_output=True, text=True, timeout=30)
        output = result.stdout + result.stderr
        assert (result.returncode == 0) == success and expected in output, f'{name}: {output}'
        results.append(name)

    try:
        reset()
        check('signed Flatpak download with matching metadata and commit', expected=f'verified update {version}')
        check('same version has no update', current=version, expected='no update')
        check('newer version is not downgraded', current='999.0.0', expected='no update')
        state['bytes'] = original_bytes + b'tampered'
        check('modified bundle fails signature verification', expected='signature', success=False)
        reset()
        state['manifest']['platforms']['linux-x86_64-flatpak']['signature'] = 'invalid'
        check('invalid signature is rejected', success=False)
        reset()
        state['manifest']['platforms']['linux-x86_64-flatpak']['commit'] = '0' * 64
        check('wrong manifest commit is rejected', expected='commit mismatch', success=False)
        reset()
        state['manifest']['version'] = version.rsplit('.', 1)[0] + '.' + str(int(version.rsplit('.', 1)[1]) + 1)
        check('signed bundle with wrong advertised version is rejected', expected='版本', success=False)
        reset()
        entry = state['manifest']['platforms'].pop('linux-x86_64-flatpak')
        state['manifest']['platforms']['linux-x86_64-deb'] = entry
        check('DEB target is never accepted by Flatpak', success=False)
        reset()
        state['status'] = 500
        check('endpoint failure is reported', success=False)
        if not test_public_key:
            signature = Path(str(package) + '.sig')
            subprocess.run([str(probe), '--verify-flatpak-bundle', str(package), version, str(signature)], check=True)
            results.append('production embedded public key verifies the release signer')
            with tempfile.TemporaryDirectory() as temporary:
                damaged = Path(temporary) / package.name
                damaged.write_bytes(original_bytes + b'changed')
                result = subprocess.run([str(probe), '--verify-flatpak-bundle', str(damaged), version, str(signature)], capture_output=True)
                assert result.returncode != 0
                results.append('release verifier rejects changed bytes')
        print(json.dumps({'passed': len(results), 'checks': results}, indent=2))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
