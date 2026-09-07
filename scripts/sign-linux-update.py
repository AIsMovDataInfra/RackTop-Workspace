#!/usr/bin/env python3
"""Sign an existing Debian package and prepare the Linux-only updater manifest."""
import json
import os
from pathlib import Path
import subprocess
import sys

package = Path(sys.argv[1]).resolve()
repository = Path(__file__).resolve().parents[1]
version = json.loads((repository / 'package.json').read_text())['version']
expected = f'RackTop_{version}_amd64.deb'
if package.name != expected or '-linux.' not in version:
    raise SystemExit('Package filename/version does not match this Linux source tree')
if not os.environ.get('TAURI_SIGNING_PRIVATE_KEY') and not os.environ.get('TAURI_SIGNING_PRIVATE_KEY_PATH'):
    raise SystemExit('Set the protected Linux updater signing key before signing')
metadata = subprocess.check_output(['dpkg-deb', '--show', '--showformat=${Package}\n${Version}\n${Architecture}\n', str(package)], text=True)
if metadata != f'rack-top\n{version}\namd64\n':
    raise SystemExit('Debian package metadata does not match this release')
result = subprocess.run([str(repository / 'node_modules/.bin/tauri'), 'signer', 'sign', str(package)], capture_output=True, text=True)
if result.returncode:
    raise SystemExit('Signing failed; signer output is suppressed to protect key material')
signature = Path(str(package) + '.sig').read_text().strip()
manifest = {'version': version, 'notes': 'Linux 客户端更新', 'platforms': {
    'linux-x86_64-deb': {'signature': signature,
                       'url': f'https://github.com/AIsMovDataInfra/RackTop/releases/download/v{version}/{package.name}'}}}
(package.parent / 'linux-amd64.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(f'Signed {package.name}; prepared linux-amd64.json')
