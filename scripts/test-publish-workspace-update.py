#!/usr/bin/env python3
"""Validate combined release inputs, immutable recovery and atomic feed writes offline."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('workspace_publisher', Path(__file__).with_name('publish-workspace-update.py'))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class WorkspaceRelease(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.assets = Path(self.directory.name)
        self.version = '2.0.0'
        self.signature = base64.b64encode(b'untrusted comment: fixture').decode()
        for arch in ['arm64', 'x64']:
            prefix = f'RackTop_{self.version}_macos-{arch}-unsigned'
            for suffix in ['.dmg', '.app.tar.gz']:
                (self.assets / (prefix + suffix)).write_bytes(b'fixture')
            (self.assets / (prefix + '.app.tar.gz.sig')).write_text(self.signature)
        self.package = self.assets / f'RackTop_{self.version}_linux-amd64.deb'
        self.package.write_bytes(b'fixture deb')
        Path(str(self.package) + '.sig').write_text(self.signature)
        self.manifest = {'version': self.version, 'platforms': {'linux-x86_64-deb': {
            'signature': self.signature,
            'url': f'https://github.com/{publisher.REPO}/releases/download/v{self.version}/{self.package.name}'}}}
        self.write_manifest()

    def write_manifest(self):
        (self.assets / 'linux-amd64.json').write_text(json.dumps(self.manifest))

    def test_packages_have_five_binaries_and_independent_platforms(self):
        packages, mac, linux, signing = publisher.collect_packages(self.assets, self.version)
        self.assertEqual(len(packages), 5)
        self.assertEqual(set(mac), {'darwin-aarch64', 'darwin-x86_64'})
        self.assertEqual(set(linux), {'linux-x86_64-deb'})
        self.assertEqual(signing, '-unsigned')
        for entry in (mac | linux).values():
            self.assertIn('/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/', entry['url'])

    def test_missing_linux_or_either_mac_cannot_publish(self):
        for path in [self.package, *self.assets.glob('*.dmg')]:
            original = path.read_bytes()
            path.unlink()
            with self.assertRaises(ValueError):
                publisher.collect_packages(self.assets, self.version)
            path.write_bytes(original)

    def test_rejects_extra_linux_package(self):
        (self.assets / 'old-package.deb').write_bytes(b'old')
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            publisher.collect_packages(self.assets, self.version)

    def test_rejects_old_repository_or_wrong_manifest_version(self):
        self.manifest['platforms']['linux-x86_64-deb']['url'] = self.manifest['platforms']['linux-x86_64-deb']['url'].replace('RackTop-Workspace/', 'RackTop/')
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, 'URL'):
            publisher.collect_packages(self.assets, self.version)
        self.manifest['version'] = '2.0.1'
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, 'version'):
            publisher.collect_packages(self.assets, self.version)

    def test_rejects_manifest_signature_different_from_artifact(self):
        self.manifest['platforms']['linux-x86_64-deb']['signature'] = 'changed'
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, 'signature'):
            publisher.collect_packages(self.assets, self.version)

    def test_feed_migration_and_no_downgrade_or_mutation(self):
        self.assertGreater(publisher.version_key('2.0.0'), publisher.version_key('1.30.0-linux.12'))
        self.assertGreater(publisher.version_key('2.0.10'), publisher.version_key('2.0.9'))
        publisher.check_feed({'version': '1.30.0-linux.12'}, self.manifest)
        publisher.check_feed(copy.deepcopy(self.manifest), self.manifest)
        with self.assertRaisesRegex(ValueError, 'backwards'):
            publisher.check_feed({'version': '2.0.1'}, self.manifest)
        with self.assertRaisesRegex(ValueError, 'immutable'):
            publisher.check_feed({'version': '2.0.0', 'platforms': {}}, self.manifest)

    def test_recovery_requires_identical_complete_public_artifacts(self):
        release = {'assets': [{'name': self.package.name, 'size': self.package.stat().st_size,
                              'digest': 'sha256:' + hashlib.sha256(self.package.read_bytes()).hexdigest()}]}
        publisher.verify_release_assets(release, [self.package])
        bad = copy.deepcopy(release)
        bad['assets'][0]['digest'] = 'sha256:other'
        with self.assertRaisesRegex(ValueError, 'digest'):
            publisher.verify_release_assets(bad, [self.package])
        with self.assertRaisesRegex(ValueError, 'asset set'):
            publisher.verify_release_assets(release, [])

    def test_both_feeds_share_one_commit_and_fast_forward_update(self):
        manifests = {'linux-amd64.json': self.manifest, 'macos.json': {'version': '2.0.0', 'platforms': {}}}
        calls = []
        def api(path, method='GET', payload=None, optional=False):
            calls.append((path, method, payload))
            if path == 'git/ref/heads/updater': return {'object': {'sha': 'previous'}}
            if '?ref=previous' in path: return None
            if path == 'git/commits/previous': return {'tree': {'sha': 'old-tree'}}
            if path == 'git/trees': return {'sha': 'new-tree'}
            if path == 'git/commits': return {'sha': 'new-commit'}
            if path == 'git/refs/heads/updater': return {}
            if '?ref=updater' in path:
                name = path.removeprefix('contents/').split('?')[0]
                return {'content': base64.b64encode(json.dumps(manifests[name]).encode()).decode()}
            raise AssertionError(path)
        with patch.object(publisher, 'api', side_effect=api):
            publisher.publish_feeds(manifests)
        tree = next(payload for path, method, payload in calls if path == 'git/trees')
        self.assertEqual(tree['base_tree'], 'old-tree')
        self.assertEqual({item['path'] for item in tree['tree']}, set(manifests))
        self.assertEqual(next(payload for path, method, payload in calls if path == 'git/commits')['parents'], ['previous'])
        self.assertIn(('git/refs/heads/updater', 'PATCH', {'sha': 'new-commit', 'force': False}), calls)
        self.assertEqual(sum(method in ('POST', 'PATCH') for _, method, _ in calls), 3)

    def test_existing_newer_feed_prevents_all_writes(self):
        calls = []
        def api(path, method='GET', payload=None, optional=False):
            calls.append(method)
            if path == 'git/ref/heads/updater': return {'object': {'sha': 'previous'}}
            return {'content': base64.b64encode(json.dumps({'version': '2.0.1'}).encode()).decode()}
        with patch.object(publisher, 'api', side_effect=api):
            with self.assertRaisesRegex(ValueError, 'backwards'):
                publisher.publish_feeds({'linux-amd64.json': self.manifest})
        self.assertTrue(all(method == 'GET' for method in calls))


if __name__ == '__main__':
    unittest.main()
