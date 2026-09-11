#!/usr/bin/env python3
"""Mac package validation shared by the unified Workspace release publisher."""
import base64
import json
from pathlib import Path
import re
import subprocess
import tempfile

REPO = 'AIsMovDataInfra/RackTop-Workspace'
ROOT = Path(__file__).resolve().parents[1]


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def api(path, method='GET', payload=None, optional=False):
    command = ['gh', 'api', f'repos/{REPO}/{path}', '--method', method]
    if payload is not None:
        command += ['--input', '-']
    response = subprocess.run(command, input=json.dumps(payload) if payload is not None else None,
                              text=True, capture_output=True)
    if response.returncode:
        if optional and '(HTTP 404)' in response.stderr:
            return None
        raise RuntimeError(response.stderr)
    return json.loads(response.stdout)


def version_tuple(version):
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
        raise ValueError('Mac releases require a neutral x.y.z version')
    return tuple(map(int, version.split('.')))


def collect_packages(assets, version):
    """Require exactly one matching installer/archive for each supported CPU."""
    version_tuple(version)
    packages = []
    platforms = {}
    signing_modes = set()
    for arch, platform in [('arm64', 'darwin-aarch64'), ('x64', 'darwin-x86_64')]:
        prefix = f'RackTop_{version}_macos-{arch}'
        dmgs = list(assets.glob(prefix + '*.dmg'))
        archives = list(assets.glob(prefix + '*.app.tar.gz'))
        if len(dmgs) != 1 or len(archives) != 1:
            raise ValueError(f'Require exactly one DMG and updater archive for {arch}')
        dmg, archive = dmgs[0], archives[0]
        suffix = dmg.name.removeprefix(prefix).removesuffix('.dmg')
        if suffix not in ('', '-unsigned', '-unnotarized') or archive.name != prefix + suffix + '.app.tar.gz':
            raise ValueError(f'Installer and updater signing labels differ for {arch}')
        signing_modes.add(suffix)
        for path in (dmg, archive):
            if not path.is_file() or path.stat().st_size == 0:
                raise ValueError(f'Empty or missing package: {path.name}')
        signature = (assets / (archive.name + '.sig')).read_text().strip()
        # Reject malformed signatures before invoking minisign or publishing.
        decoded = base64.b64decode(signature, validate=True)
        if not decoded.startswith(b'untrusted comment:'):
            raise ValueError('Invalid Tauri updater signature encoding')
        platforms[platform] = {
            'signature': signature,
            'url': f'https://github.com/{REPO}/releases/download/v{version}/{archive.name}',
        }
        packages.extend([dmg, archive])
    if len(signing_modes) != 1:
        raise ValueError('The two Mac architectures must have the same signing status')
    return packages, platforms, signing_modes.pop()


def verify_signatures(packages, platforms):
    public_key = base64.b64decode((ROOT / 'src-tauri/linux-updater.pub').read_text().strip(), validate=True)
    with tempfile.TemporaryDirectory(prefix='racktop-mac-signatures-') as temporary:
        key = Path(temporary) / 'public.key'
        key.write_bytes(public_key)
        for archive in (path for path in packages if path.name.endswith(('.app.tar.gz', '.deb', '.flatpak'))):
            signature = Path(temporary) / 'archive.sig'
            entry = next(item for item in platforms.values() if item['url'].endswith('/' + archive.name))
            signature.write_bytes(base64.b64decode(entry['signature'], validate=True))
            run('minisign', '-Vm', str(archive), '-p', str(key), '-x', str(signature))


def main():
    # Keep old operator entry points safe: publication always requires all platforms.
    import runpy
    runpy.run_path(str(ROOT / 'scripts/publish-workspace-update.py'), run_name='__main__')


if __name__ == '__main__':
    main()
