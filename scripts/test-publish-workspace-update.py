#!/usr/bin/env python3
"""Validate combined release inputs, immutable recovery and atomic feed writes offline."""
import base64
import copy
import hashlib
import importlib.util
import json
import os
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
        self.flatpak = self.assets / f'RackTop_{self.version}_linux-amd64.flatpak'
        self.flatpak.write_bytes(b'fixture flatpak')
        self.offline = self.assets / f'RackTop_{self.version}_linux-amd64-flatpak-offline.tar.gz'
        self.offline.write_bytes(b'fixture offline kit')
        Path(str(self.package) + '.sig').write_text(self.signature)
        self.manifest = {'version': self.version, 'platforms': {'linux-x86_64-deb': {
            'signature': self.signature,
            'url': f'https://github.com/{publisher.REPO}/releases/download/v{self.version}/{self.package.name}'}}}
        self.write_manifest()

    def write_manifest(self):
        (self.assets / 'linux-amd64.json').write_text(json.dumps(self.manifest))

    def test_packages_have_seven_downloads_and_flatpak_stays_out_of_updater(self):
        packages, mac, linux, signing = publisher.collect_packages(self.assets, self.version)
        self.assertEqual(len(packages), 7)
        self.assertIn(self.flatpak, packages)
        self.assertIn(self.offline, packages)
        self.assertEqual(set(mac), {'darwin-aarch64', 'darwin-x86_64'})
        self.assertEqual(set(linux), {'linux-x86_64-deb'})
        self.assertEqual(signing, '-unsigned')
        for entry in (mac | linux).values():
            self.assertIn('/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/', entry['url'])
            self.assertFalse(entry['url'].endswith('.flatpak'))
            self.assertFalse(entry['url'].endswith('-flatpak-offline.tar.gz'))

    def test_missing_linux_or_either_mac_cannot_publish(self):
        for path in [self.package, self.flatpak, self.offline, *self.assets.glob('*.dmg')]:
            original = path.read_bytes()
            path.unlink()
            with self.assertRaises(ValueError):
                publisher.collect_packages(self.assets, self.version)
            path.write_bytes(original)

    def test_rejects_extra_linux_package(self):
        (self.assets / 'old-package.deb').write_bytes(b'old')
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            publisher.collect_packages(self.assets, self.version)

    def test_rejects_extra_wrong_version_or_empty_flatpak(self):
        other = self.assets / 'RackTop_1.0.0_linux-amd64.flatpak'
        other.write_bytes(b'old')
        with self.assertRaisesRegex(ValueError, 'exactly one.*Flatpak'):
            publisher.collect_packages(self.assets, self.version)
        self.flatpak.unlink()
        with self.assertRaisesRegex(ValueError, 'exactly one.*Flatpak'):
            publisher.collect_packages(self.assets, self.version)
        other.unlink()
        self.flatpak.touch()
        with self.assertRaisesRegex(ValueError, 'exactly one.*Flatpak'):
            publisher.collect_packages(self.assets, self.version)

    def test_rejects_extra_wrong_version_or_empty_offline_kit(self):
        other = self.assets / 'RackTop_1.0.0_linux-amd64-flatpak-offline.tar.gz'
        other.write_bytes(b'old')
        with self.assertRaisesRegex(ValueError, 'exactly one.*offline kit'):
            publisher.collect_packages(self.assets, self.version)
        self.offline.unlink()
        with self.assertRaisesRegex(ValueError, 'exactly one.*offline kit'):
            publisher.collect_packages(self.assets, self.version)
        other.unlink()
        self.offline.touch()
        with self.assertRaisesRegex(ValueError, 'exactly one.*offline kit'):
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
        files = [self.package, self.flatpak, self.offline]
        release = {'assets': [{'name': path.name, 'size': path.stat().st_size,
                              'digest': 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()}
                             for path in files]}
        publisher.verify_release_assets(release, files)
        bad = copy.deepcopy(release)
        bad['assets'][2]['digest'] = 'sha256:other'
        with self.assertRaisesRegex(ValueError, 'digest'):
            publisher.verify_release_assets(bad, files)
        with self.assertRaisesRegex(ValueError, 'asset set'):
            publisher.verify_release_assets(release, [self.package])
        missing = copy.deepcopy(release)
        missing['assets'].pop()
        with self.assertRaisesRegex(ValueError, 'asset set'):
            publisher.verify_release_assets(missing, files)

    def test_publication_checksums_include_flatpak_but_feed_remains_debian(self):
        (self.assets / 'docs').mkdir()
        (self.assets / 'docs/Version_overview.md').write_text('## 2.0.0\n\n- 支持 Ubuntu 20.04 安装。\n')
        for name in ['LICENSE', 'NOTICE.md']:
            (self.assets / name).write_text(name)

        def run(*args):
            if args[:2] == ('git', 'rev-parse'):
                return 'release-commit'
            if args[:2] == ('git', 'archive'):
                Path(args[args.index('-o') + 1]).write_bytes(b'fixture source')
            elif args[0] == 'dpkg-deb':
                return f'rack-top\n{self.version}\namd64'
            return ''

        def api(path, optional=False):
            self.assertEqual(path, 'releases/tags/v2.0.0')
            packages, _, _, _ = publisher.collect_packages(self.assets, self.version)
            files = packages + [self.assets / f'RackTop_{self.version}_source.tar.gz',
                                self.assets / 'LICENSE', self.assets / 'NOTICE.md', self.assets / 'SHA256SUMS']
            self.assertEqual(len(files), 11)
            return {'tag_name': 'v2.0.0', 'published_at': '2026-09-11T00:00:00Z',
                    'html_url': 'https://example.invalid/release',
                    'assets': [{'name': file.name, 'size': file.stat().st_size,
                                'digest': 'sha256:' + hashlib.sha256(file.read_bytes()).hexdigest()}
                               for file in files]}

        with patch.object(publisher, 'ROOT', self.assets), \
             patch.object(publisher.versions, 'check_version', return_value=self.version), \
             patch.dict(os.environ, GITHUB_REPOSITORY=publisher.REPO, GITHUB_REF='refs/tags/v2.0.0'), \
             patch.object(publisher.sys, 'argv', ['publish-workspace-update.py', str(self.assets)]), \
             patch.object(publisher, 'run', side_effect=run), \
             patch.object(publisher.subprocess, 'run'), \
             patch.object(publisher.mac, 'verify_signatures'), \
             patch.object(publisher, 'api', side_effect=api), \
             patch.object(publisher, 'publish_feeds') as publish_feeds:
            publisher.main()

        checksums = (self.assets / 'SHA256SUMS').read_text().splitlines()
        self.assertEqual(len(checksums), 10)
        self.assertIn(f'{hashlib.sha256(self.flatpak.read_bytes()).hexdigest()}  {self.flatpak.name}', checksums)
        self.assertIn(f'{hashlib.sha256(self.offline.read_bytes()).hexdigest()}  {self.offline.name}', checksums)
        self.assertFalse(any('.sig' in line for line in checksums))
        body = (self.assets / 'release-notes.md').read_text()
        self.assertIn(self.flatpak.name, body)
        self.assertIn(self.offline.name, body)
        self.assertIn('Flatpak 离线安装包（Ubuntu 20.04，含运行时）', body)
        self.assertIn('DEB（Ubuntu 22.04）', body)
        self.assertIn('Flatpak 使用独立配置目录', body)
        feeds = publish_feeds.call_args.args[0]
        self.assertEqual(set(feeds), {'linux-amd64.json', 'macos.json'})
        self.assertEqual(set(feeds['linux-amd64.json']['platforms']), {'linux-x86_64-deb'})

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
