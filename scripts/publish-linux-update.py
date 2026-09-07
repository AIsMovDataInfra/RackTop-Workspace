#!/usr/bin/env python3
"""Publish a reviewed main-branch Linux tag, verify assets, then advance its feed."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

REPO = 'AIsMovDataInfra/RackTop'
root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text())['version']
tag = f'v{version}'
assets = Path(sys.argv[1]).resolve()

def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()

def api(path, method='GET', payload=None, optional=False):
    command = ['gh', 'api', f'repos/{REPO}/{path}', '--method', method]
    if payload is not None:
        command += ['--input', '-']
    response = subprocess.run(command, input=json.dumps(payload) if payload is not None else None, text=True, capture_output=True)
    if response.returncode:
        if optional and '(HTTP 404)' in response.stderr:
            return None
        raise RuntimeError(response.stderr)
    return json.loads(response.stdout)

if os.environ.get('GITHUB_REPOSITORY') != REPO or os.environ.get('GITHUB_REF') != f'refs/tags/{tag}':
    raise SystemExit('Publication requires a version tag in the Linux fork')
run('git', 'fetch', 'origin', 'main')
commit = run('git', 'rev-parse', f'{tag}^{{commit}}')
subprocess.run(['git', 'merge-base', '--is-ancestor', commit, 'origin/main'], check=True)
package = assets / f'RackTop_{version}_amd64.deb'
manifest = json.loads((assets / 'linux-amd64.json').read_text())
expected_url = f'https://github.com/{REPO}/releases/download/{tag}/{package.name}'
if manifest['version'] != version or manifest['platforms']['linux-x86_64-deb']['url'] != expected_url:
    raise SystemExit('Updater manifest does not match the package and tag')
feed = api('contents/linux-amd64.json?ref=updater', optional=True)
if feed:
    previous = json.loads(base64.b64decode(feed['content']))
    if subprocess.run(['dpkg', '--compare-versions', previous['version'], 'gt', version]).returncode == 0:
        raise SystemExit('Refusing to roll the Linux update channel backwards')
if api(f'releases/tags/{tag}', optional=True):
    raise SystemExit('This release already exists; published update assets are immutable')

source = assets / f'RackTop_{version}_source.tar.gz'
run('git', 'archive', '--format=tar.gz', f'--prefix=RackTop-{version}/', '-o', str(source), commit)
for name in ['LICENSE', 'NOTICE.md']:
    (assets / name).write_bytes((root / name).read_bytes())
files = [package, source, assets / 'LICENSE', assets / 'NOTICE.md']
(assets / 'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n' for path in files))
files.append(assets / 'SHA256SUMS')
overview = (root / 'docs/Version_overview.md').read_text()
section = overview.split(f'## {version}', 1)[1].split('\n## ', 1)[0]
bullets = [line for line in section.splitlines() if line.startswith('- ')][:5]
notes = assets / 'release-notes.md'
notes.write_text('## 主要更新\n\n' + '\n'.join(bullets) + '\n\n## 下载\n\n' +
                 f'- [{package.name}]({expected_url})：Ubuntu 22.04 / Debian 兼容 amd64 桌面安装包。\n' +
                 f'- [{source.name}](https://github.com/{REPO}/releases/download/{tag}/{source.name})：对应源码，GPL-3.0。\n')
run('gh', 'release', 'create', tag, '--repo', REPO, '--verify-tag', '--prerelease', '--title', f'RackTop {tag} 测试版', '--notes-file', str(notes), *map(str, files))
release = api(f'releases/tags/{tag}')
for path in files:
    asset = next(item for item in release['assets'] if item['name'] == path.name)
    expected = 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()
    if asset.get('digest') != expected:
        raise SystemExit(f'GitHub asset digest mismatch or unavailable: {path.name}; feed was not advanced')

# Advance only after every release asset is visible and its GitHub digest matches.
content = json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'
branch = api('git/ref/heads/updater', optional=True)
if not branch:
    tree = api('git/trees', 'POST', {'tree': [{'path': 'linux-amd64.json', 'mode': '100644', 'type': 'blob', 'content': content}]})
    created = api('git/commits', 'POST', {'message': f'{tag} Linux updater', 'tree': tree['sha'], 'parents': []})
    api('git/refs', 'POST', {'ref': 'refs/heads/updater', 'sha': created['sha']})
else:
    payload = {'message': f'{tag} Linux updater', 'branch': 'updater', 'content': base64.b64encode(content.encode()).decode()}
    if feed:
        payload['sha'] = feed['sha']
    api('contents/linux-amd64.json', 'PUT', payload)
verified = api('contents/linux-amd64.json?ref=updater')
if json.loads(base64.b64decode(verified['content'])) != manifest:
    raise SystemExit('Published update manifest did not verify')
print(f'Published and verified {release["html_url"]}; Linux updater manifest advanced')
