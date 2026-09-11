#!/usr/bin/env python3
"""Focused checks for the Flatpak boundary and wrong-artifact rejection."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
PACKAGING = ROOT / 'packaging/flatpak'


class FlatpakPackagingTests(unittest.TestCase):
    def test_host_terminal_forwards_script_as_one_argument(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            capture = temporary / 'argv.json'
            stub = temporary / 'flatpak-spawn'
            stub.write_text('#!/usr/bin/env python3\nimport json,os,sys\nopen(os.environ["RACKTOP_TEST_CAPTURE"], "w").write(json.dumps(sys.argv[1:]))\n')
            stub.chmod(0o755)
            script = 'printf "%s" "spaces; $(must-not-run) `nor-this`"\nexit 7'
            environment = dict(os.environ, PATH=f'{temporary}:{os.environ["PATH"]}', RACKTOP_TEST_CAPTURE=str(capture))
            subprocess.run(['/bin/sh', str(PACKAGING / 'x-terminal-emulator'), '-e', 'sh', '-lc', script], env=environment, check=True)
            self.assertEqual(json.loads(capture.read_text()), ['--host', 'x-terminal-emulator', '-e', 'sh', '-lc', script])

    def test_host_terminal_preserves_failure_status(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            stub = temporary / 'flatpak-spawn'
            stub.write_text('#!/bin/sh\nexit 73\n')
            stub.chmod(0o755)
            environment = dict(os.environ, PATH=f'{temporary}:{os.environ["PATH"]}')
            result = subprocess.run(['/bin/sh', str(PACKAGING / 'x-terminal-emulator'), '-e', 'sh'], env=environment)
            self.assertEqual(result.returncode, 73)

    def test_manifest_sources_are_pinned_and_app_metadata_agrees(self):
        manifest = json.loads((PACKAGING / 'com.racktop.desktop.json').read_text())
        metadata = ET.fromstring((PACKAGING / 'com.racktop.desktop.metainfo.xml').read_text())
        self.assertEqual(manifest['app-id'], metadata.findtext('id'))
        self.assertEqual(manifest['command'], metadata.findtext('provides/binary'))
        self.assertTrue((PACKAGING / metadata.findtext('launchable')).is_file())
        for module in manifest['modules']:
            for source in module['sources']:
                if 'url' in source:
                    self.assertTrue(source['url'].startswith('https://'))
                    self.assertRegex(source['sha256'], r'^[0-9a-f]{64}$')
        # Host invocation is restricted to the explicit setup-terminal wrapper;
        # an SSH host wrapper would make /app's askpass executable inaccessible.
        ssh_module = next(module for module in manifest['modules'] if module['name'] == 'openssh-client')
        self.assertIn('/app/bin/ssh', '\n'.join(ssh_module['build-commands']))
        self.assertNotIn('flatpak-spawn', '\n'.join(ssh_module['build-commands']))

    def test_wrong_debian_version_is_rejected_before_flatpak_build(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            tree = temporary / 'package'
            (tree / 'DEBIAN').mkdir(parents=True)
            (tree / 'DEBIAN/control').write_text('Package: rack-top\nVersion: 0.0.0\nArchitecture: amd64\nMaintainer: Test <test@example.invalid>\nDescription: packaging test fixture\n')
            deb = temporary / 'wrong-version.deb'
            subprocess.run(['dpkg-deb', '--build', str(tree), str(deb)], check=True, stdout=subprocess.DEVNULL)
            for name in ['flatpak', 'flatpak-builder']:
                path = temporary / name
                path.write_text('#!/bin/sh\nexit 97\n')
                path.chmod(0o755)
            environment = dict(os.environ, PATH=f'{temporary}:{os.environ["PATH"]}')
            result = subprocess.run(['bash', str(ROOT / 'scripts/package-flatpak.sh'), str(deb)], env=environment, text=True, capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn('matching the current source version', result.stderr)


class OfflineInstallerTests(unittest.TestCase):
    runtimes = (
        ('org.gnome.Platform', '50'),
        ('org.freedesktop.Platform.GL.default', '25.08'),
        ('org.freedesktop.Platform.GL.default', '25.08-extra'),
    )
    app_bundle = 'RackTop_0.0.1_linux-amd64.flatpak'
    app_commit = 'a' * 64
    app_ref = 'com.racktop.desktop//stable'

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='racktop offline kit ')
        self.addCleanup(self.directory.cleanup)
        self.kit = Path(self.directory.name)
        self.capture = self.kit / 'flatpak-calls.jsonl'
        self.installer = self.kit / 'install.sh'
        self.installer.write_bytes((ROOT / 'scripts/install-flatpak-offline.sh').read_bytes())
        bundles = [self.app_bundle] + [f'{runtime}_{branch}_x86_64.flatpak' for runtime, branch in self.runtimes]
        for name in bundles:
            (self.kit / name).write_text(f'local bundle fixture: {name}\n')
        commit_file = self.kit / 'APP-COMMIT.txt'
        commit_file.write_text(self.app_commit + '\n')
        checksummed = [self.installer, commit_file] + [self.kit / name for name in bundles]
        (self.kit / 'SHA256SUMS').write_text(''.join(
            f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n'
            for path in checksummed
        ))
        tools = self.kit / 'tools'
        tools.mkdir()
        flatpak = tools / 'flatpak'
        flatpak.write_text('''#!/usr/bin/env python3
import json
import os
import sys
args = sys.argv[1:]
with open(os.environ['RACKTOP_OFFLINE_CALLS'], 'a') as output:
    output.write(json.dumps(args) + '\\n')
if args[0] == 'info':
    if '--show-commit' in args and args[-1] == 'com.racktop.desktop//stable':
        commit = os.environ.get('RACKTOP_INSTALLED_APP_COMMIT')
        if commit:
            print(commit)
        sys.exit(0 if commit else 1)
    sys.exit(0 if args[-1] in json.loads(os.environ['RACKTOP_INSTALLED_RUNTIMES']) else 1)
if args[0] == 'install':
    sys.exit(73 if args[-1] == os.environ.get('RACKTOP_FAIL_BUNDLE') else 0)
sys.exit(97)
''')
        flatpak.chmod(0o755)
        # Keep installer tests independent of the machine running the suite.
        uname = tools / 'uname'
        uname.write_text('#!/bin/sh\nprintf "x86_64\\n"\n')
        uname.chmod(0o755)
        self.environment = dict(
            os.environ,
            PATH=f'{tools}:{os.environ["PATH"]}',
            LC_ALL='C',
            RACKTOP_OFFLINE_CALLS=str(self.capture),
            RACKTOP_INSTALLED_RUNTIMES='[]',
            RACKTOP_INSTALLED_APP_COMMIT='',
        )
        self.environment.pop('RACKTOP_FAIL_BUNDLE', None)

    def run_installer(self, installed=(), fail_bundle=None, app_commit=None):
        environment = dict(self.environment, RACKTOP_INSTALLED_RUNTIMES=json.dumps(list(installed)))
        if app_commit is not None:
            environment['RACKTOP_INSTALLED_APP_COMMIT'] = app_commit
        if fail_bundle:
            environment['RACKTOP_FAIL_BUNDLE'] = fail_bundle
        self.capture.unlink(missing_ok=True)
        result = subprocess.run(['bash', str(self.installer)], env=environment, text=True, capture_output=True)
        calls = [json.loads(line) for line in self.capture.read_text().splitlines()] if self.capture.exists() else []
        return result, calls

    def test_corrupt_checksum_fails_before_any_flatpak_call(self):
        with (self.kit / self.app_bundle).open('ab') as bundle:
            bundle.write(b'corrupted download')
        result, calls = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('FAILED', result.stdout)
        self.assertEqual(calls, [])

    def test_existing_runtimes_are_preserved(self):
        refs = [f'{runtime}//{branch}' for runtime, branch in self.runtimes]
        result, calls = self.run_installer(installed=refs)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual({call[-1] for call in calls if call[0] == 'info'}, set(refs) | {self.app_ref})
        self.assertEqual([call for call in calls if call[0] == 'install'], [[
            'install', '--user', '--noninteractive', '--bundle', '--no-deps', '--no-related',
            '--or-update', self.app_bundle,
        ]])

    def test_missing_runtimes_use_local_bundles_without_remote_resolution(self):
        result, calls = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        installations = [call for call in calls if call[0] == 'install']
        expected = [[
            'install', '--user', '--noninteractive', '--bundle', '--no-deps', '--no-related',
            f'{runtime}_{branch}_x86_64.flatpak',
        ] for runtime, branch in self.runtimes]
        expected.append([
            'install', '--user', '--noninteractive', '--bundle', '--no-deps', '--no-related',
            '--or-update', self.app_bundle,
        ])
        self.assertEqual(installations, expected)
        self.assertTrue(all((self.kit / call[-1]).is_file() for call in installations))
        self.assertEqual({call[0] for call in calls}, {'info', 'install'})

    def test_same_application_commit_skips_installation(self):
        refs = [f'{runtime}//{branch}' for runtime, branch in self.runtimes]
        result, calls = self.run_installer(installed=refs, app_commit=self.app_commit)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(['info', '--user', '--show-commit', self.app_ref], calls)
        self.assertEqual([call for call in calls if call[0] == 'install'], [])

    def test_different_application_commit_still_installs_update(self):
        refs = [f'{runtime}//{branch}' for runtime, branch in self.runtimes]
        result, calls = self.run_installer(installed=refs, app_commit='b' * 64)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(['info', '--user', '--show-commit', self.app_ref], calls)
        self.assertEqual([call for call in calls if call[0] == 'install'], [[
            'install', '--user', '--noninteractive', '--bundle', '--no-deps', '--no-related',
            '--or-update', self.app_bundle,
        ]])

    def test_installation_failure_preserves_status_and_stops(self):
        first_runtime = 'org.gnome.Platform_50_x86_64.flatpak'
        refs = [f'{runtime}//{branch}' for runtime, branch in self.runtimes]
        for bundle, installed in ((first_runtime, ()), (self.app_bundle, refs)):
            with self.subTest(bundle=bundle):
                result, calls = self.run_installer(installed=installed, fail_bundle=bundle)
                self.assertEqual(result.returncode, 73, result.stderr)
                self.assertEqual([call[-1] for call in calls if call[0] == 'install'], [bundle])
                self.assertEqual(calls[-1][-1], bundle)
                self.assertNotIn('Installed. Start with:', result.stdout)


if __name__ == '__main__':
    unittest.main()
