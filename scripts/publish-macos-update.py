#!/usr/bin/env python3
"""Publish both verified Mac installers, then advance the independent Mac feed."""
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

REPO = 'AIsMovDataInfra/RackTop'
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
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
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
        for archive in (path for path in packages if path.name.endswith('.app.tar.gz')):
            signature = Path(temporary) / 'archive.sig'
            entry = next(item for item in platforms.values() if item['url'].endswith('/' + archive.name))
            signature.write_bytes(base64.b64decode(entry['signature'], validate=True))
            run('minisign', '-Vm', str(archive), '-p', str(key), '-x', str(signature))


def main():
    version = json.loads((ROOT / 'package.json').read_text())['version']
    tag = f'v{version}'
    assets = Path(sys.argv[1]).resolve()
    if os.environ.get('GITHUB_REPOSITORY') != REPO or os.environ.get('GITHUB_REF') != f'refs/tags/{tag}':
        raise SystemExit('Publication requires a version tag in the RackTop fork')
    run('git', 'fetch', 'origin', 'main')
    commit = run('git', 'rev-parse', f'{tag}^{{commit}}')
    subprocess.run(['git', 'merge-base', '--is-ancestor', commit, 'origin/main'], check=True)
    packages, platforms, signing = collect_packages(assets, version)
    verify_signatures(packages, platforms)
    feed = api('contents/macos.json?ref=updater', optional=True)
    if feed:
        previous = json.loads(base64.b64decode(feed['content']))
        if version_tuple(previous['version']) >= version_tuple(version):
            raise SystemExit('Refusing to overwrite or roll the Mac update channel backwards')
    if api(f'releases/tags/{tag}', optional=True):
        raise SystemExit('This release already exists; published update assets are immutable')

    source = assets / f'RackTop_{version}_source.tar.gz'
    run('git', 'archive', '--format=tar.gz', f'--prefix=RackTop-{version}/', '-o', str(source), commit)
    for name in ['LICENSE', 'NOTICE.md']:
        (assets / name).write_bytes((ROOT / name).read_bytes())
    files = packages + [source, assets / 'LICENSE', assets / 'NOTICE.md']
    checksums = assets / 'SHA256SUMS'
    checksums.write_text(''.join(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n' for path in files))
    files.append(checksums)
    overview = (ROOT / 'docs/Version_overview.md').read_text()
    section = overview.split(f'## {version}\n', 1)[1].split('\n## ', 1)[0]
    bullets = [line for line in section.splitlines() if line.startswith('- ')]
    body = '## 主要更新\n\n' + '\n'.join(bullets) + '\n\n## 下载\n\n'
    for path in packages:
        if path.suffix == '.dmg':
            label = 'Apple Silicon（M 系列）' if 'macos-arm64' in path.name else 'Intel Mac'
            body += f'- [{label} DMG](https://github.com/{REPO}/releases/download/{tag}/{path.name})\n'
    body += f'- [{source.name}](https://github.com/{REPO}/releases/download/{tag}/{source.name})：对应源码，GPL-3.0。\n'
    body += '\n打开 DMG，将 RackTop 拖入「应用程序」。'
    if signing:
        body += '本次 Mac 测试包未通过 Apple 公证；首次启动被阻止时，请在「系统设置 → 隐私与安全性」允许打开。'
    body += '\n\n`.app.tar.gz` 为应用自动更新附件，手动安装请选择对应芯片的 DMG。\n'
    notes = assets / 'release-notes.md'
    notes.write_text(body)
    run('gh', 'release', 'create', tag, '--repo', REPO, '--verify-tag', '--prerelease',
        '--title', f'RackTop {tag} Mac 测试版（Apple Silicon / Intel）', '--notes-file', str(notes), *map(str, files))
    release = api(f'releases/tags/{tag}')
    for path in files:
        asset = next(item for item in release['assets'] if item['name'] == path.name)
        expected = 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()
        if asset.get('digest') != expected:
            raise SystemExit(f'GitHub asset digest mismatch: {path.name}; feed was not advanced')
    manifest = {
        'version': version,
        'notes': '\n'.join(bullets),
        'pub_date': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'platforms': platforms,
    }
    content = json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'
    branch = api('git/ref/heads/updater', optional=True)
    if not branch:
        tree = api('git/trees', 'POST', {'tree': [{'path': 'macos.json', 'mode': '100644', 'type': 'blob', 'content': content}]})
        created = api('git/commits', 'POST', {'message': f'{tag} Mac updater', 'tree': tree['sha'], 'parents': []})
        api('git/refs', 'POST', {'ref': 'refs/heads/updater', 'sha': created['sha']})
    else:
        payload = {'message': f'{tag} Mac updater', 'branch': 'updater', 'content': base64.b64encode(content.encode()).decode()}
        if feed:
            payload['sha'] = feed['sha']
        api('contents/macos.json', 'PUT', payload)
    verified = api('contents/macos.json?ref=updater')
    if json.loads(base64.b64decode(verified['content'])) != manifest:
        raise SystemExit('Published Mac manifest did not verify')
    print(f'Published and verified {release["html_url"]}; Mac updater manifest advanced')


if __name__ == '__main__':
    main()
