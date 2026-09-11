#!/usr/bin/env python3
"""Exercise installer selection/verification without network or package changes."""
import hashlib
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('install-racktop.sh').resolve()
VERSION = '2.5.0'
COMMIT = 'a' * 64
OLD = 'b' * 64
BASE = f'https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v{VERSION}'
APP = f'RackTop_{VERSION}_linux-amd64.flatpak'
DEB = f'RackTop_{VERSION}_linux-amd64.deb'
KIT = f'RackTop_{VERSION}_linux-amd64-flatpak-offline.tar.gz'
RUNTIMES = ['org.gnome.Platform/x86_64/50', 'org.freedesktop.Platform.GL.default/x86_64/25.08', 'org.freedesktop.Platform.GL.default/x86_64/25.08-extra']

MOCK = r'''#!/usr/bin/python3
import json, os, pathlib, shutil, sys
root = pathlib.Path(os.environ['RACKTOP_FIXTURE'])
state = json.loads((root / 'state.json').read_text())
tool, args = pathlib.Path(sys.argv[0]).name, sys.argv[1:]
with (root / 'calls.jsonl').open('a') as output:
    output.write(json.dumps([tool, args]) + '\n')
if tool == 'sudo' and args[:2] == ['/usr/bin/flatpak', 'install']:
    assert '--system' in args and '--user' not in args
    tool, args = 'flatpak', args[1:]
if tool == 'curl':
    url = args[-1]
    assert url.startswith('https://') and "=https" in args
    name = 'feed.json' if url.endswith('/linux-amd64.json') else url.rsplit('/', 1)[1]
    shutil.copyfile(root / name, args[args.index('--output') + 1])
    if name.endswith('.flatpak') and state.get('during_download'):
        changed = state['during_download']
        state['apps'][changed['scope']] = changed['commit']
        state.setdefault('versions', {})[changed['scope']] = changed['version']
        (root / 'state.json').write_text(json.dumps(state))
elif tool == 'flatpak':
    scope = 'system' if '--system' in args else 'user'
    if args[0] == 'info':
        if '--show-commit' in args:
            value = state['apps'].get(scope)
            if not value: sys.exit(1)
            print(value)
        elif '--show-metadata' in args:
            if not state['apps'].get(scope): sys.exit(1)
            metadata = state.get('metadata', {}).get(scope)
            if metadata is None:
                metadata = '[Application]\nname=com.racktop.desktop\nruntime=org.gnome.Platform/x86_64/50\n'
                version = state.get('versions', {}).get(scope)
                if version is not None: metadata += '[X-RackTop Update]\nversion=' + version + '\n'
            print(metadata)
        elif args[-1] not in state['runtimes'].get(scope, []): sys.exit(1)
    elif args[0] == 'install':
        name = pathlib.Path(args[-1]).name
        if name.startswith('RackTop_'):
            assert '--or-update' in args
            assert state['apps'].get(scope) != os.environ['RACKTOP_COMMIT'], 'identical commit cannot be reinstalled by Flatpak 1.6'
            state['apps'][scope] = os.environ['RACKTOP_COMMIT']
            state.setdefault('versions', {})[scope] = os.environ['RACKTOP_VERSION']
        else:
            stem = name.removesuffix('_x86_64.flatpak')
            runtime, branch = stem.split('_')
            ref = runtime + '/x86_64/' + branch
            assert ref not in state['runtimes'].get(scope, []), 'must preserve existing runtime'
            state['runtimes'].setdefault(scope, []).append(ref)
        (root / 'state.json').write_text(json.dumps(state))
elif tool == 'sudo':
    assert args[:2] == ['apt', 'install'], args
    assert pathlib.Path(args[-1]).is_file()
else:
    sys.exit(2)
'''


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='racktop-install-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for tool in ('curl', 'flatpak', 'sudo'):
            path = self.bin / tool
            path.write_text(MOCK)
            path.chmod(0o755)
        self.env = {**os.environ, 'PATH': str(self.bin) + ':' + os.environ['PATH'], 'RACKTOP_FIXTURE': str(self.root), 'RACKTOP_COMMIT': COMMIT, 'RACKTOP_VERSION': VERSION}
        self.state = {'apps': {}, 'runtimes': {'user': RUNTIMES.copy(), 'system': RUNTIMES.copy()}}
        self.feed = {'version': VERSION, 'platforms': {
            'linux-x86_64-deb': {'url': BASE + '/' + DEB},
            'linux-x86_64-flatpak': {'url': BASE + '/' + APP, 'commit': COMMIT},
        }}
        (self.root / APP).write_bytes(b'synthetic Flatpak')
        (self.root / DEB).write_bytes(b'synthetic DEB')
        self.make_kit()
        self.save()

    def save(self):
        (self.root / 'state.json').write_text(json.dumps(self.state))
        (self.root / 'feed.json').write_text(json.dumps(self.feed))
        self.checksums([self.root / name for name in (APP, DEB, KIT)], self.root / 'SHA256SUMS')

    def checksums(self, files, target):
        target.write_text(''.join(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n' for path in files))

    def make_kit(self):
        kit = self.root / ('RackTop_' + VERSION + '_flatpak_offline')
        kit.mkdir()
        (kit / APP).write_bytes((self.root / APP).read_bytes())
        (kit / 'APP-COMMIT.txt').write_text(COMMIT + '\n')
        for ref in RUNTIMES:
            runtime, arch, branch = ref.split('/')
            (kit / (runtime + '_' + branch + '_' + arch + '.flatpak')).write_bytes(b'synthetic runtime')
        self.checksums(list(kit.iterdir()), kit / 'SHA256SUMS')
        with tarfile.open(self.root / KIT, 'w:gz') as archive:
            archive.add(kit, arcname=kit.name)

    def shell(self, command, success=True):
        result = subprocess.run(['bash', '-c', 'source ' + shlex.quote(str(SCRIPT)) + '\n' + command], env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def main(self, ubuntu='20.04', success=True):
        return self.shell("racktop_ubuntu() { printf '%s\\n' " + shlex.quote(ubuntu) + "; }\npgrep() { return 1; }\ndpkg-query() { return 1; }\nracktop_install_main", success)

    def calls(self):
        path = self.root / 'calls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def installs(self):
        return [(tool, args) for tool, args in self.calls() if tool == 'sudo' or (tool == 'flatpak' and args[0] == 'install')]

    def test_real_platform_parser_accepts_supported_ubuntu_only(self):
        release = self.root / 'os-release'
        for version in ('20.04', '22.04'):
            release.write_text(f'ID=ubuntu\nVERSION_ID="{version}"\n')
            self.assertEqual(self.shell(f'racktop_ubuntu {release} x86_64').stdout.strip(), version)
        self.shell(f'racktop_ubuntu {release} aarch64', False)
        release.write_text('ID=debian\nVERSION_ID="12"\n')
        self.shell(f'racktop_ubuntu {release} x86_64', False)

    def test_scope_is_preserved_and_ambiguous_scope_stops(self):
        self.state['apps'] = {'system': OLD}
        self.save()
        self.assertEqual(self.shell('racktop_flatpak_scope').stdout.strip(), 'system')
        self.state['apps']['user'] = OLD
        self.save()
        self.main(success=False)
        self.assertFalse(self.installs())

    def test_same_flatpak_commit_skips_download_and_reinstall(self):
        self.state['apps'] = {'user': COMMIT}
        self.state['versions'] = {'user': VERSION}
        self.save()
        self.main()
        self.assertFalse(self.installs())
        self.assertFalse(any(args[-1].endswith('.flatpak') for tool, args in self.calls() if tool == 'curl'))

    def test_user_upgrade_downloads_application_only_and_preserves_runtimes(self):
        self.state['apps'] = {'user': OLD}
        self.save()
        self.main()
        self.assertEqual(len(self.installs()), 1)
        self.assertIn('--user', self.installs()[0][1])
        self.assertIn('--or-update', self.installs()[0][1])
        self.assertFalse(any(args[-1].endswith(KIT) for tool, args in self.calls() if tool == 'curl'))

    def test_newer_installed_flatpak_is_never_downgraded_in_either_scope(self):
        for scope in ('user', 'system'):
            with self.subTest(scope=scope):
                self.state['apps'] = {scope: OLD}
                self.state['versions'] = {scope: '2.6.0'}
                self.save()
                result = self.main(success=False)
                self.assertIn('避免降级', result.stderr)
                self.assertFalse(self.installs())
                self.assertFalse(any(args[-1].endswith(('.flatpak', '.tar.gz')) for tool, args in self.calls() if tool == 'curl'))
                self.assertEqual(json.loads((self.root / 'state.json').read_text())['apps'][scope], OLD)

    def test_same_version_different_commit_preserves_other_build(self):
        self.state['apps'] = {'user': OLD}
        self.state['versions'] = {'user': VERSION}
        self.save()
        result = self.main(success=False)
        self.assertIn('避免覆盖其他构建', result.stderr)
        self.assertFalse(self.installs())

    def test_older_version_and_legacy_bundle_without_version_can_upgrade(self):
        for installed_version in ('2.4.0', None):
            with self.subTest(version=installed_version):
                self.state['apps'] = {'user': OLD}
                self.state['versions'] = {} if installed_version is None else {'user': installed_version}
                self.save()
                calls = self.root / 'calls.jsonl'
                calls.unlink(missing_ok=True)
                self.main()
                self.assertEqual(len(self.installs()), 1)
                updated = json.loads((self.root / 'state.json').read_text())
                self.assertEqual(updated['apps']['user'], COMMIT)
                self.assertEqual(updated['versions']['user'], VERSION)
                self.assertTrue(any('--show-metadata' in args for tool, args in self.calls() if tool == 'flatpak'))

    def test_invalid_or_unrecognized_installed_metadata_stops_without_evaluation(self):
        marker = self.root / 'must-not-be-created'
        base = '[Application]\nname=com.racktop.desktop\nruntime=org.gnome.Platform/x86_64/50\n'
        for metadata in [base.replace('com.racktop.desktop', 'com.other.desktop'), base.replace('/50', '/51'),
                         base + '[X-RackTop Update]\n', base + '[X-RackTop Update]\nversion=2.5.0-beta\n',
                         base + '[X-RackTop Update]\nversion=2.5.0\nversion=2.6.0\n',
                         base + '[X-RackTop Update]\nversion=$(touch ' + str(marker) + ')\n']:
            with self.subTest(metadata=metadata):
                self.state['apps'] = {'user': OLD}
                self.state['metadata'] = {'user': metadata}
                self.save()
                self.main(success=False)
                self.assertFalse(self.installs())
                self.assertFalse(marker.exists())

    def test_newer_deployment_installed_during_download_is_not_overwritten(self):
        self.state['apps'] = {'user': OLD}
        self.state['versions'] = {'user': '2.4.0'}
        self.state['during_download'] = {'scope': 'user', 'version': '2.6.0', 'commit': 'c' * 64}
        self.save()
        result = self.main(success=False)
        self.assertIn('避免降级', result.stderr)
        self.assertFalse(self.installs())
        self.assertEqual(json.loads((self.root / 'state.json').read_text())['apps']['user'], 'c' * 64)

    def test_existing_system_flatpak_on_ubuntu22_stays_system_flatpak(self):
        self.state['apps'] = {'system': OLD}
        self.save()
        self.main('22.04')
        self.assertEqual(len(self.installs()), 1)
        self.assertIn('--system', self.installs()[0][1])
        self.assertEqual(self.installs()[0][0], 'sudo')
        self.assertEqual(self.installs()[0][1][:3], ['/usr/bin/flatpak', 'install', '--system'])

    def test_missing_runtimes_use_kit_and_keep_existing_runtime(self):
        self.state['runtimes']['user'] = [RUNTIMES[0]]
        self.save()
        self.main()
        self.assertEqual(len(self.installs()), 3)
        self.assertTrue(any(args[-1].endswith(KIT) for tool, args in self.calls() if tool == 'curl'))
        self.assertEqual(json.loads((self.root / 'state.json').read_text())['apps']['user'], COMMIT)

    def test_system_runtime_repair_requests_sudo_only_for_missing_bundles(self):
        self.state['apps'] = {'system': OLD}
        self.state['runtimes']['system'] = [RUNTIMES[0]]
        self.save()
        self.main()
        self.assertEqual(len(self.installs()), 3)
        for tool, args in self.installs():
            self.assertEqual(tool, 'sudo')
            self.assertEqual(args[:3], ['/usr/bin/flatpak', 'install', '--system'])
        self.assertEqual(json.loads((self.root / 'state.json').read_text())['apps']['system'], COMMIT)

    def test_new_ubuntu22_install_uses_verified_deb(self):
        self.main('22.04')
        self.assertEqual(len(self.installs()), 1)
        tool, args = self.installs()[0]
        self.assertEqual((tool, args[:2]), ('sudo', ['apt', 'install']))
        self.assertTrue(args[-1].endswith(DEB))

    def test_corrupt_package_prevents_any_install(self):
        (self.root / DEB).write_bytes(b'changed after publishing checksums')
        self.main('22.04', False)
        self.assertFalse(self.installs())

    def test_unknown_url_and_missing_commit_prevent_install(self):
        self.feed['platforms']['linux-x86_64-flatpak']['url'] = 'https://example.invalid/app.flatpak'
        self.save()
        self.main(success=False)
        self.assertFalse(self.installs())
        self.feed['platforms']['linux-x86_64-flatpak'] = {'url': BASE + '/' + APP}
        self.save()
        self.main(success=False)
        self.assertFalse(self.installs())

    def test_duplicate_checksum_rejected(self):
        checksums = self.root / 'SHA256SUMS'
        checksums.write_text(checksums.read_text() * 2)
        self.main('22.04', False)
        self.assertFalse(self.installs())

    def test_archive_paths_and_links_rejected_before_extracting(self):
        archive = self.root / 'unsafe.tar.gz'
        for name, link in [('RackTop_2.5.0_flatpak_offline/../../outside', False), ('RackTop_2.5.0_flatpak_offline/link', True)]:
            with tarfile.open(archive, 'w:gz') as out:
                member = tarfile.TarInfo(name)
                if link:
                    member.type = tarfile.SYMTYPE
                    member.linkname = '/etc'
                    out.addfile(member)
                else:
                    member.size = 1
                    out.addfile(member, io.BytesIO(b'x'))
            self.shell(f'racktop_extract_kit {archive} {self.root / "unpack"} {VERSION}', False)
            self.assertFalse((self.root / 'unpack').exists())


if __name__ == '__main__':
    unittest.main()
