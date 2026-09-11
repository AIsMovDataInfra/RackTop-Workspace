#!/usr/bin/env python3
"""Publish verified Linux/Mac packages once, then atomically advance both feeds."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
REPO = 'AIsMovDataInfra/RackTop-Workspace'


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


mac = module('racktop_mac_packages', 'publish-macos-update.py')
versions = module('racktop_release_versions', 'check-release-version.py')
run, api = mac.run, mac.api


def sha256(path):
    # The offline runtime kit can be large; do not load it into memory.
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def version_key(version):
    # Read older Linux feed versions during migration, but publish neutral versions only.
    match = re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-linux\.(0|[1-9][0-9]*))?', version)
    if not match:
        raise ValueError('Unrecognized updater version')
    major, minor, patch, revision = match.groups()
    return int(major), int(minor), int(patch), revision is None, int(revision or 0)


def collect_packages(assets, version):
    packages, platforms, signing = mac.collect_packages(assets, version)
    package = assets / f'RackTop_{version}_linux-amd64.deb'
    debs = list(assets.glob('*.deb'))
    if debs != [package] or not package.is_file() or not package.stat().st_size:
        raise ValueError('Require exactly one matching Linux amd64 Debian package')
    flatpak = assets / f'RackTop_{version}_linux-amd64.flatpak'
    if list(assets.glob('*.flatpak')) != [flatpak] or not flatpak.is_file() or not flatpak.stat().st_size:
        raise ValueError('Require exactly one matching Linux amd64 Flatpak package')
    offline = assets / f'RackTop_{version}_linux-amd64-flatpak-offline.tar.gz'
    if list(assets.glob('*flatpak-offline.tar.gz')) != [offline] or not offline.is_file() or not offline.stat().st_size:
        raise ValueError('Require exactly one matching Linux amd64 Flatpak offline kit')
    manifest = json.loads((assets / 'linux-amd64.json').read_text())
    expected_url = f'https://github.com/{REPO}/releases/download/v{version}/{package.name}'
    if manifest.get('version') != version or set(manifest.get('platforms', {})) != {'linux-x86_64-deb'}:
        raise ValueError('Linux manifest version or platforms mismatch')
    entry = manifest['platforms']['linux-x86_64-deb']
    if entry.get('url') != expected_url:
        raise ValueError('Linux package URL does not match the Workspace release')
    signature = (assets / (package.name + '.sig')).read_text().strip()
    if entry.get('signature') != signature or not base64.b64decode(signature, validate=True).startswith(b'untrusted comment:'):
        raise ValueError('Linux manifest signature mismatch')
    # Flatpak manages its own deployments; never offer its bundle to the DEB updater.
    return packages + [package, flatpak, offline], platforms, manifest['platforms'], signing


def verify_release_assets(release, files):
    actual = {item['name']: item for item in release['assets']}
    expected_names = {path.name for path in files}
    if len(actual) != len(release['assets']) or set(actual) != expected_names:
        raise ValueError('Release asset set differs; published artifacts are immutable')
    for path in files:
        expected = 'sha256:' + sha256(path)
        if actual[path.name].get('digest') != expected or actual[path.name].get('size') != path.stat().st_size:
            raise ValueError(f'GitHub asset digest/size mismatch: {path.name}; feeds were not advanced')


def check_feed(previous, manifest):
    if previous is None:
        return
    if version_key(previous['version']) > version_key(manifest['version']):
        raise ValueError('Refusing to roll an update channel backwards')
    if previous['version'] == manifest['version'] and previous != manifest:
        raise ValueError('An existing version manifest is immutable')


def publish_feeds(manifests):
    branch = api('git/ref/heads/updater', optional=True)
    head = branch['object']['sha'] if branch else None
    previous = {}
    for path, manifest in manifests.items():
        feed = api(f'contents/{path}?ref={head}', optional=True) if head else None
        previous[path] = json.loads(base64.b64decode(feed['content'])) if feed else None
        check_feed(previous[path], manifest)
    if previous == manifests:
        return
    entries = [{'path': path, 'mode': '100644', 'type': 'blob',
                'content': json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'}
               for path, manifest in manifests.items()]
    payload = {'tree': entries}
    if head:
        payload['base_tree'] = api(f'git/commits/{head}')['tree']['sha']
    tree = api('git/trees', 'POST', payload)
    version = manifests['macos.json']['version']
    commit = api('git/commits', 'POST', {'message': f'v{version} Mac and Linux updaters',
                                     'tree': tree['sha'], 'parents': [head] if head else []})
    if head:
        # A competing write fails fast-forward validation; never force either feed.
        api('git/refs/heads/updater', 'PATCH', {'sha': commit['sha'], 'force': False})
    else:
        api('git/refs', 'POST', {'ref': 'refs/heads/updater', 'sha': commit['sha']})
    for path, manifest in manifests.items():
        verified = api(f'contents/{path}?ref=updater')
        if json.loads(base64.b64decode(verified['content'])) != manifest:
            raise ValueError(f'Published manifest did not verify: {path}')


def main():
    version = versions.check_version()
    tag = f'v{version}'
    if os.environ.get('GITHUB_REPOSITORY') != REPO or os.environ.get('GITHUB_REF') != f'refs/tags/{tag}':
        raise SystemExit('Publication requires a matching version tag in RackTop-Workspace')
    assets = Path(sys.argv[1]).resolve()
    run('git', 'fetch', 'origin', 'main')
    commit = run('git', 'rev-parse', f'{tag}^{{commit}}')
    if run('git', 'rev-parse', 'HEAD') != commit:
        raise ValueError('Publication checkout must match the immutable tag')
    subprocess.run(['git', 'merge-base', '--is-ancestor', commit, 'origin/main'], check=True)
    packages, mac_platforms, linux_platforms, signing = collect_packages(assets, version)
    deb = next(path for path in packages if path.suffix == '.deb')
    metadata = run('dpkg-deb', '--show', '--showformat=${Package}\n${Version}\n${Architecture}', str(deb))
    if metadata != f'rack-top\n{version}\namd64':
        raise ValueError('Debian package metadata does not match the release')
    mac.verify_signatures(packages, mac_platforms | linux_platforms)
    source = assets / f'RackTop_{version}_source.tar.gz'
    run('git', 'archive', '--format=tar.gz', f'--prefix=RackTop-{version}/', '-o', str(source), commit)
    for name in ['LICENSE', 'NOTICE.md']:
        (assets / name).write_bytes((ROOT / name).read_bytes())
    files = packages + [source, assets / 'LICENSE', assets / 'NOTICE.md']
    checksums = assets / 'SHA256SUMS'
    checksums.write_text(''.join(f'{sha256(path)}  {path.name}\n' for path in files))
    files.append(checksums)
    overview = (ROOT / 'docs/Version_overview.md').read_text()
    section = overview.split(f'## {version}\n', 1)[1].split('\n## ', 1)[0]
    bullets = [line for line in section.splitlines() if line.startswith('- ')]
    if not bullets:
        raise ValueError('Release notes must contain the current version changes')
    body = '## 主要更新\n\n' + '\n'.join(bullets) + '\n\n## 下载\n\n'
    for path in packages:
        if path.suffix in ('.dmg', '.deb', '.flatpak'):
            if path.suffix == '.flatpak':
                label = 'Linux amd64 Flatpak 应用包（已有运行时）'
            elif path.suffix == '.deb':
                label = 'Linux amd64 DEB（Ubuntu 22.04）'
            else:
                label = 'Mac Apple Silicon（M 系列）DMG' if 'macos-arm64' in path.name else 'Mac Intel DMG'
            body += f'- [{label}](https://github.com/{REPO}/releases/download/{tag}/{path.name})\n'
        elif path.name.endswith('.app.tar.gz'):
            label = 'Mac Apple Silicon 自动更新附件' if 'macos-arm64' in path.name else 'Mac Intel 自动更新附件'
            body += f'- [{label}](https://github.com/{REPO}/releases/download/{tag}/{path.name})\n'
        elif path.name.endswith('-flatpak-offline.tar.gz'):
            body += f'- [Linux amd64 Flatpak 离线安装包（Ubuntu 20.04，含运行时）](https://github.com/{REPO}/releases/download/{tag}/{path.name})\n'
    body += f'- [对应源码（GPL-3.0）](https://github.com/{REPO}/releases/download/{tag}/{source.name})\n'
    for name, label in [('LICENSE', 'GPL-3.0 许可证'), ('NOTICE.md', '项目来源与署名'), ('SHA256SUMS', '文件校验清单')]:
        body += f'- [{label}](https://github.com/{REPO}/releases/download/{tag}/{name})\n'
    body += '\nLinux：Ubuntu 20.04 首次安装请选择含运行时的 Flatpak 离线安装包；已有运行时可用较小的 `.flatpak` 应用包。Ubuntu 22.04 也可用系统软件安装器打开 DEB。安装与更新步骤见 [Linux 安装说明](https://github.com/' + REPO + '/blob/' + tag + '/docs/LINUX.md)。Mac：打开对应芯片的 DMG，将 RackTop 拖入「应用程序」。\n'
    body += '\n旧仓库的 1.x 客户端首次迁移需下载安装此版本；DEB 和 Mac 安装保留原应用数据，后续使用独立仓库更新。Flatpak 使用独立配置目录，通过重新安装新版 `.flatpak` 更新。\n'
    if signing:
        body += '\n本次 Mac 测试包未通过 Apple 公证；首次启动被阻止时，请在「系统设置 → 隐私与安全性」允许打开。\n'
    body += '\n`.app.tar.gz` 是 Mac 自动更新附件，手动安装请选择 DMG。所有安装包均可用 `SHA256SUMS` 校验。\n'
    notes = assets / 'release-notes.md'
    notes.write_text(body)
    release = api(f'releases/tags/{tag}', optional=True)
    if release is None:
        run('gh', 'release', 'create', tag, '--repo', REPO, '--verify-tag', '--prerelease',
            '--title', f'RackTop {tag} 测试版 · Linux amd64 / Mac Apple Silicon / Mac Intel',
            '--notes-file', str(notes), *map(str, files))
        release = api(f'releases/tags/{tag}')
    elif release.get('draft') or release.get('tag_name') != tag:
        raise ValueError('An existing release must already be published under the same tag')
    # Recovery may resume after upload only when every public artifact is identical.
    verify_release_assets(release, files)
    common = {'version': version, 'notes': '\n'.join(bullets), 'pub_date': release['published_at']}
    publish_feeds({'macos.json': common | {'platforms': mac_platforms},
                   'linux-amd64.json': common | {'platforms': linux_platforms}})
    print(f'Verified {len(files)} release assets and both update feeds: {release["html_url"]}')


if __name__ == '__main__':
    main()
