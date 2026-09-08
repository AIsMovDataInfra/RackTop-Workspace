"""Local filesystem and actual stdin/stdout protocol tests; no SSH needed."""

import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("remote_files.py")
SPEC = importlib.util.spec_from_file_location("remote_files", SCRIPT)
remote = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(remote)


class FileWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "scope"
        self.root.mkdir()
        self.worker = remote.Worker()
        self.worker.dispatch("init", {"root": str(self.root)})

    def tearDown(self):
        self.worker.close()
        self.temp.cleanup()

    def call(self, method, **params):
        return self.worker.dispatch(method, params)

    def assertError(self, code, method, **params):
        with self.assertRaises(remote.FileError) as error:
            self.call(method, **params)
        self.assertEqual(error.exception.code, code)

    def upload(self, path, content):
        expected = hashlib.sha256(content).hexdigest()
        transfer = self.call("write_open", path=path, size=len(content), sha256=expected)
        for offset in range(0, len(content), remote.MAX_CHUNK_BYTES):
            chunk = content[offset:offset + remote.MAX_CHUNK_BYTES]
            result = self.call("write_chunk", transferId=transfer["transferId"], offset=offset,
                               dataBase64=base64.b64encode(chunk).decode())
            self.assertEqual(result["nextOffset"], offset + len(chunk))
        return self.call("write_commit", transferId=transfer["transferId"], sha256=expected)

    def test_streaming_round_trip_and_private_atomic_upload(self):
        (self.root / "sub").mkdir()
        content = os.urandom(remote.MAX_CHUNK_BYTES * 2 + 13)
        result = self.upload("sub/data.bin", content)
        self.assertEqual((self.root / "sub/data.bin").read_bytes(), content)
        self.assertEqual(stat.S_IMODE((self.root / "sub/data.bin").stat().st_mode), 0o600)
        self.assertFalse(list((self.root / "sub").glob(remote.TEMP_PREFIX + "*")))
        opened = self.call("read_open", path="sub/data.bin")
        received = bytearray()
        offset = 0
        while True:
            chunk = self.call("read_chunk", transferId=opened["transferId"], offset=offset,
                              maxBytes=remote.MAX_CHUNK_BYTES)
            received.extend(base64.b64decode(chunk["dataBase64"]))
            offset = chunk["nextOffset"]
            if chunk["eof"]:
                break
        closed = self.call("read_close", transferId=opened["transferId"])
        self.assertEqual(received, content)
        self.assertEqual(closed["sha256"], result["sha256"])
        self.assertFalse(self.worker.handles)

    def test_empty_file(self):
        result = self.upload("empty", b"")
        opened = self.call("read_open", path="empty")
        closed = self.call("read_close", transferId=opened["transferId"])
        self.assertEqual(closed["size"], 0)
        self.assertEqual(closed["sha256"], result["sha256"])

    def test_initialization_cannot_change_scope(self):
        fresh = remote.Worker()
        try:
            with self.assertRaises(remote.FileError) as error:
                fresh.dispatch("list", {})
            self.assertEqual(error.exception.code, "not_initialized")
        finally:
            fresh.close()
        self.assertError("already_initialized", "init", root=self.temp.name)
        self.assertEqual(self.call("list")["path"], "")

    def test_traversal_symlinks_and_special_files(self):
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (outside / "secret").write_text("private")
        (self.root / "escape").symlink_to(outside, target_is_directory=True)
        (self.root / "secret-link").symlink_to(outside / "secret")
        os.mkfifo(self.root / "pipe")
        for path in ("../outside/secret", str(outside / "secret"), "x/../secret",
                     "x//secret", "x/./secret", ".racktop-upload-guess"):
            self.assertError("unsafe_path", "read_open", path=path)
        self.assertError("not_directory", "read_open", path="escape/secret")
        self.assertError("unsafe_path", "read_open", path="secret-link")
        self.assertError("not_file", "read_open", path="pipe")
        self.assertError("not_directory", "write_open", path="escape/new")
        self.assertEqual(self.call("list")["entries"], [])
        self.assertFalse((outside / "new").exists())

    def test_no_overwrite_even_when_target_appears_during_transfer(self):
        transfer = self.call("write_open", path="target", size=3)["transferId"]
        self.call("write_chunk", transferId=transfer, offset=0, dataBase64="bmV3")
        (self.root / "target").write_bytes(b"original")
        self.assertError("already_exists", "write_commit", transferId=transfer,
                         sha256=hashlib.sha256(b"new").hexdigest())
        self.assertEqual((self.root / "target").read_bytes(), b"original")
        self.assertFalse(self.worker.handles)
        self.assertFalse(list(self.root.glob(remote.TEMP_PREFIX + "*")))
        self.assertError("already_exists", "write_open", path="target")
        (self.root / "dangling").symlink_to(self.root / "missing")
        self.assertError("already_exists", "write_open", path="dangling")

    def test_upload_hash_size_and_offset_errors_clean_up(self):
        transfer = self.call("write_open", path="bad-hash", size=3)["transferId"]
        self.call("write_chunk", transferId=transfer, offset=0, dataBase64="bmV3")
        self.assertError("hash_mismatch", "write_commit", transferId=transfer, sha256="0" * 64)
        transfer = self.call("write_open", path="bad-size", size=2)["transferId"]
        self.assertError("size_mismatch", "write_chunk", transferId=transfer,
                         offset=0, dataBase64="bmV3")
        transfer = self.call("write_open", path="bad-offset")["transferId"]
        self.assertError("invalid_offset", "write_chunk", transferId=transfer,
                         offset=1, dataBase64="bmV3")
        self.assertFalse(self.worker.handles)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_replaced_temporary_name_cannot_publish_a_symlink(self):
        outside = Path(self.temp.name) / "outside"
        outside.write_bytes(b"private")
        transfer = self.call("write_open", path="target", size=3)["transferId"]
        self.call("write_chunk", transferId=transfer, offset=0, dataBase64="bmV3")
        temporary = next(self.root.glob(remote.TEMP_PREFIX + "*"))
        temporary.unlink()
        temporary.symlink_to(outside)
        self.assertError("file_changed", "write_commit", transferId=transfer,
                         sha256=hashlib.sha256(b"new").hexdigest())
        self.assertEqual(outside.read_bytes(), b"private")
        self.assertFalse((self.root / "target").exists())
        self.assertTrue(temporary.is_symlink())
        self.assertFalse(self.worker.handles)

    def test_upload_detects_external_temporary_file_modification(self):
        transfer = self.call("write_open", path="target", size=3)["transferId"]
        self.call("write_chunk", transferId=transfer, offset=0, dataBase64="bmV3")
        temporary = next(self.root.glob(remote.TEMP_PREFIX + "*"))
        original_stat = temporary.stat()
        temporary.write_bytes(b"BAD")
        os.utime(temporary, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns + 1000000000))
        self.assertError("file_changed", "write_commit", transferId=transfer,
                         sha256=hashlib.sha256(b"new").hexdigest())
        self.assertFalse((self.root / "target").exists())
        self.assertEqual(list(self.root.iterdir()), [])

    def test_source_changes_before_or_during_chunk_are_detected(self):
        source = self.root / "source"
        source.write_bytes(b"old data")
        transfer = self.call("read_open", path="source")["transferId"]
        original_stat = source.stat()
        source.write_bytes(b"new data")
        # Some temp filesystems have coarse timestamp granularity; advance mtime
        # explicitly so the same-size change has a deterministic fingerprint.
        os.utime(source, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns + 1000000000))
        self.assertError("file_changed", "read_chunk", transferId=transfer, offset=0, maxBytes=4)
        transfer = self.call("read_open", path="source")["transferId"]
        real_read = remote.os.read

        def changed_during_read(fd, size):
            data = real_read(fd, size)
            source.write_bytes(b"changed size!")
            return data

        remote.os.read = changed_during_read
        try:
            self.assertError("file_changed", "read_chunk", transferId=transfer,
                             offset=0, maxBytes=4)
        finally:
            remote.os.read = real_read
        self.assertFalse(self.worker.handles)

    def test_transfer_bounds_cancel_and_incomplete_close(self):
        (self.root / "source").write_bytes(b"abcd")
        transfers = [self.call("read_open", path="source")["transferId"] for _ in range(8)]
        self.assertError("too_many_transfers", "write_open", path="ninth")
        self.assertError("incomplete", "read_close", transferId=transfers.pop())
        self.assertError("invalid_params", "read_chunk", transferId=transfers.pop(),
                         offset=0, maxBytes=remote.MAX_CHUNK_BYTES + 1)
        transfer = self.call("write_open", path="cancelled")["transferId"]
        self.call("write_chunk", transferId=transfer, offset=0, dataBase64="eA==")
        self.assertEqual(self.call("write_cancel", transferId=transfer), {"cancelled": True})
        self.assertFalse(list(self.root.glob(remote.TEMP_PREFIX + "*")))

    def test_sparse_hundred_gib_file_opens_without_reading_into_memory(self):
        with (self.root / "large").open("wb") as stream:
            stream.truncate(remote.MAX_FILE_BYTES)
        result = self.call("read_open", path="large")
        self.assertEqual(result["size"], remote.MAX_FILE_BYTES)
        chunk = self.call("read_chunk", transferId=result["transferId"], offset=0, maxBytes=9)
        self.assertEqual(base64.b64decode(chunk["dataBase64"]), b"\0" * 9)

    def test_listing_bounds_response_and_never_reveals_root(self):
        for number in range(2003):
            (self.root / (str(number).zfill(4) + "-" + "界" * 50)).touch()
        result = self.call("list", path=".")
        self.assertTrue(result["truncated"])
        self.assertLessEqual(len(result["entries"]), remote.MAX_ENTRIES)
        encoded = remote.encode(result)
        self.assertLessEqual(len(encoded), remote.MAX_LIST_BYTES)
        self.assertNotIn(str(self.root), encoded)
        self.assertTrue(all(not entry["path"].startswith("/") for entry in result["entries"]))

    def test_wire_protocol_and_eof_remove_partial_upload(self):
        requests = [
            {"id": 1, "method": "init", "params": {"root": str(self.root)}},
            {"id": 2, "method": "write_open", "params": {"path": "partial"}},
            {"id": 3, "method": "list", "params": {"path": ""}},
        ]
        result = subprocess.run([sys.executable, str(SCRIPT)], input="".join(
            json.dumps(request) + "\n" for request in requests), capture_output=True,
            text=True, timeout=10, check=True)
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([reply["id"] for reply in replies], [1, 2, 3])
        self.assertEqual(replies[2]["result"]["entries"], [])
        self.assertEqual(result.stderr, "")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_oversized_line_exits_and_cleans_up(self):
        prefix = json.dumps({"id": 1, "method": "init", "params": {"root": str(self.root)}}) + "\n"
        prefix += json.dumps({"id": 2, "method": "write_open", "params": {"path": "partial"}}) + "\n"
        result = subprocess.run([sys.executable, str(SCRIPT)],
                                input=prefix + "x" * (remote.MAX_LINE_BYTES + 1) + "\n",
                                capture_output=True, text=True, timeout=10, check=True)
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(replies[-1]["error"]["code"], "request_too_large")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_ssh_disconnect_signals_remove_partial_upload(self):
        for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            with subprocess.Popen([sys.executable, str(SCRIPT)], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True) as process:
                for request in (
                    {"id": 1, "method": "init", "params": {"root": str(self.root)}},
                    {"id": 2, "method": "write_open", "params": {"path": "partial"}},
                ):
                    process.stdin.write(json.dumps(request) + "\n")
                    process.stdin.flush()
                    self.assertIn("result", json.loads(process.stdout.readline()))
                self.assertEqual(len(list(self.root.glob(remote.TEMP_PREFIX + "*"))), 1)
                process.send_signal(signum)
                process.wait(timeout=5)
                self.assertEqual(process.returncode, 0)
                self.assertEqual(list(self.root.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
