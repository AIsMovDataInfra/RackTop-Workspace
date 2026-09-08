#!/usr/bin/env python3
"""Check release input validation without GitHub writes."""
import base64
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('mac_publisher', Path(__file__).with_name('publish-macos-update.py'))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class MacReleaseInputs(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.assets = Path(self.directory.name)
        self.version = '1.27.0'
        for arch in ['arm64', 'x64']:
            prefix = f'RackTop_{self.version}_macos-{arch}-unsigned'
            for suffix in ['.dmg', '.app.tar.gz']:
                (self.assets / (prefix + suffix)).write_bytes(b'fixture')
            (self.assets / (prefix + '.app.tar.gz.sig')).write_text(base64.b64encode(b'untrusted comment: fixture').decode())

    def test_both_architectures_have_their_own_urls(self):
        packages, platforms, mode = publisher.collect_packages(self.assets, self.version)
        self.assertEqual(len(packages), 4)
        self.assertEqual(mode, '-unsigned')
        self.assertEqual(set(platforms), {'darwin-aarch64', 'darwin-x86_64'})
        self.assertTrue(platforms['darwin-x86_64']['url'].endswith('/RackTop_1.27.0_macos-x64-unsigned.app.tar.gz'))

    def test_missing_intel_package_is_rejected(self):
        next(self.assets.glob('*x64*.dmg')).unlink()
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            publisher.collect_packages(self.assets, self.version)

    def test_duplicate_package_is_rejected(self):
        (self.assets / 'RackTop_1.27.0_macos-arm64.dmg').write_bytes(b'other')
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            publisher.collect_packages(self.assets, self.version)

    def test_mismatched_archive_signing_status_is_rejected(self):
        archive = next(self.assets.glob('*x64*.app.tar.gz'))
        archive.rename(self.assets / archive.name.replace('-unsigned', ''))
        with self.assertRaisesRegex(ValueError, 'labels differ'):
            publisher.collect_packages(self.assets, self.version)

    def test_invalid_signature_is_rejected(self):
        next(self.assets.glob('*.sig')).write_text('not-a-signature')
        with self.assertRaises(ValueError):
            publisher.collect_packages(self.assets, self.version)

    def test_linux_versions_cannot_publish_to_mac_feed(self):
        with self.assertRaises(ValueError):
            publisher.version_tuple('1.27.0-linux.1')
        self.assertGreater(publisher.version_tuple('1.27.10'), publisher.version_tuple('1.27.9'))


if __name__ == '__main__':
    unittest.main()
