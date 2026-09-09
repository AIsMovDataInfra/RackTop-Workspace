#!/usr/bin/env python3
"""Fail before compilation when the six release version fields or tag disagree."""
import json
import os
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def check_version():
    package = json.loads((ROOT / 'package.json').read_text())
    lock = json.loads((ROOT / 'package-lock.json').read_text())
    cargo = (ROOT / 'src-tauri/Cargo.toml').read_text().split('[package]', 1)[1].split('\n[', 1)[0]
    name = re.search(r'^name = "([^"]+)"$', cargo, re.M).group(1)
    entries = [entry for entry in (ROOT / 'src-tauri/Cargo.lock').read_text().split('[[package]]')
               if re.search(r'^name = "' + re.escape(name) + r'"$', entry, re.M)]
    if len(entries) != 1:
        raise ValueError('Cargo.lock must contain exactly one application package')
    cargo_version = re.search(r'^version = "([^"]+)"$', cargo, re.M).group(1)
    lock_version = re.search(r'^version = "([^"]+)"$', entries[0], re.M).group(1)
    versions = [package['version'], lock['version'], lock['packages']['']['version'],
                cargo_version, lock_version,
                json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text())['version']]
    version = versions[0]
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version) or set(versions) != {version}:
        raise ValueError(f'Release versions must agree on a neutral x.y.z version: {versions}')
    ref = os.environ.get('GITHUB_REF', '')
    if ref.startswith('refs/tags/') and ref != f'refs/tags/v{version}':
        raise ValueError('The pushed tag does not match the source version')
    return version

if __name__ == '__main__':
    print('Verified six release version fields:', check_version())
