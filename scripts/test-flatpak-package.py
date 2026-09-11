#!/usr/bin/env python3
"""Focused checks for the Flatpak boundary and wrong-artifact rejection."""
from pathlib import Path
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


if __name__ == '__main__':
    unittest.main()
