#!/usr/bin/env python3
"""Sign a verified Flatpak application bundle using the existing updater key."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def main():
    package, probe = (Path(value).resolve() for value in sys.argv[1:3])
    root = Path(__file__).resolve().parents[1]
    version = json.loads((root / 'package.json').read_text())['version']
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version) or package.name != f'RackTop_{version}_linux-amd64.flatpak':
        raise SystemExit('Flatpak package filename/version mismatch')
    # The same checked bundle parser as the client verifies ID, arch, branch,
    # runtime, embedded version and OSTree commit before signing.
    info = json.loads(subprocess.check_output([str(probe), '--verify-flatpak-bundle', str(package), version], text=True))
    if info['commit'] != Path(str(package) + '.commit').read_text().strip():
        raise SystemExit('Flatpak build commit mismatch')
    if not os.environ.get('TAURI_SIGNING_PRIVATE_KEY') and not os.environ.get('TAURI_SIGNING_PRIVATE_KEY_PATH'):
        raise SystemExit('Set the protected updater signing key before signing')
    result = subprocess.run([str(root / 'node_modules/.bin/tauri'), 'signer', 'sign', str(package)], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit('Flatpak signing failed; signer output is suppressed to protect key material')
    signature = Path(str(package) + '.sig').read_text().strip()
    subprocess.run([str(probe), '--verify-flatpak-bundle', str(package), version, str(package) + '.sig'], check=True)
    manifest = {'version': version, 'platforms': {'linux-x86_64-flatpak': {
        'signature': signature, 'commit': info['commit'],
        'url': f'https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v{version}/{package.name}'}}}
    (package.parent / 'flatpak-amd64.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Signed {package.name}; prepared Flatpak updater manifest')


if __name__ == '__main__':
    main()
