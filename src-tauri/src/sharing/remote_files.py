#!/usr/bin/env python3
"""One owner-scoped, streaming file worker (Python 3, Linux; no third-party packages).

The SSH caller supplies one trusted root in the first ``init`` request. All later
paths are relative to that root; an empty path or ``.`` denotes its directory.
Symlinks and names beginning with .racktop-upload- are intentionally unavailable.
Requests and responses are newline-delimited JSON. Nothing else is printed.
"""

import base64
import binascii
import errno
import hashlib
import hmac
import json
import os
import secrets
import signal
import stat
import sys


MAX_CHUNK_BYTES = 48 * 1024
MAX_LINE_BYTES = 70 * 1024
MAX_LIST_BYTES = 60 * 1024
MAX_ENTRIES = 2000
MAX_HANDLES = 8
MAX_FILE_BYTES = 100 * 1024 * 1024 * 1024
TEMP_PREFIX = ".racktop-upload-"
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


class FileError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def fail(code, message):
    raise FileError(code, message)


def integer(value, name, maximum, minimum=0):
    if type(value) is not int or not minimum <= value <= maximum:
        fail("invalid_params", "Invalid " + name)
    return value


def digest(value):
    if not isinstance(value, str) or len(value) != 64:
        fail("invalid_params", "SHA-256 must contain 64 hexadecimal characters")
    if any(c not in "0123456789abcdefABCDEF" for c in value):
        fail("invalid_params", "SHA-256 must contain 64 hexadecimal characters")
    return value.lower()


def encode(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=False)


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def unlink_temporary(parent_fd, name, inode):
    """Do not remove an entry that another process substituted for our temp file."""
    try:
        info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (info.st_dev, info.st_ino) == inode and stat.S_ISREG(info.st_mode):
            os.unlink(name, dir_fd=parent_fd)
    except OSError:
        pass


def os_error(error):
    mapping = {
        errno.ENOENT: ("not_found", "The requested entry does not exist"),
        errno.EEXIST: ("already_exists", "The destination already exists"),
        errno.EACCES: ("permission_denied", "Permission denied"),
        errno.EPERM: ("permission_denied", "Permission denied"),
        errno.ELOOP: ("unsafe_path", "Symbolic links are not allowed"),
        errno.ENOTDIR: ("not_directory", "A path component is not a directory"),
        errno.ENAMETOOLONG: ("invalid_path", "The path is too long"),
        errno.ENOSPC: ("disk_full", "The destination has insufficient space"),
        errno.EDQUOT: ("disk_full", "The destination quota is exhausted"),
    }
    return FileError(*mapping.get(error.errno, ("io_error", "File operation failed")))


class Worker:
    def __init__(self):
        self.root_fd = None
        self.handles = {}

    def close_handle(self, transfer_id):
        handle = self.handles.pop(transfer_id, None)
        if handle is None:
            return
        try:
            if handle["kind"] == "write":
                unlink_temporary(handle["parent_fd"], handle["temp"], handle["inode"])
        finally:
            os.close(handle["fd"])
            if handle["kind"] == "write":
                os.close(handle["parent_fd"])

    def close(self):
        for transfer_id in list(self.handles):
            self.close_handle(transfer_id)
        if self.root_fd is not None:
            os.close(self.root_fd)
            self.root_fd = None

    def path(self, value, allow_root=False):
        if not isinstance(value, str) or "\x00" in value:
            fail("invalid_path", "A relative path is required")
        try:
            if len(value.encode("utf-8")) > 4096:
                fail("invalid_path", "The path is too long")
        except UnicodeError:
            fail("invalid_path", "The path must be valid UTF-8")
        if value in ("", "."):
            if allow_root:
                return "", []
            fail("invalid_path", "A file path is required")
        parts = value.split("/")
        if len(parts) > 128 or any(
            p in ("", ".", "..") or p.startswith(TEMP_PREFIX) for p in parts
        ):
            fail("unsafe_path", "Only relative paths without traversal are allowed")
        return value, parts

    def directory(self, parts):
        current = os.dup(self.root_fd)
        try:
            for part in parts:
                child = os.open(part, DIRECTORY_FLAGS, dir_fd=current)
                os.close(current)
                current = child
            return current
        except BaseException:
            os.close(current)
            raise

    def handle(self, params, kind):
        transfer_id = params.get("transferId")
        if not isinstance(transfer_id, str) or len(transfer_id) != 32:
            fail("invalid_transfer", "Unknown transfer")
        handle = self.handles.get(transfer_id)
        if handle is None or handle["kind"] != kind:
            fail("invalid_transfer", "Unknown transfer")
        return transfer_id, handle

    def capacity(self):
        if len(self.handles) >= MAX_HANDLES:
            fail("too_many_transfers", "At most eight transfers may be open")

    def unchanged(self, handle):
        if fingerprint(os.fstat(handle["fd"])) != handle["fingerprint"]:
            fail("file_changed", "The file changed outside this transfer")

    def upload_unchanged(self, handle):
        self.unchanged(handle)
        info = os.stat(handle["temp"], dir_fd=handle["parent_fd"], follow_symlinks=False)
        if ((info.st_dev, info.st_ino) != handle["inode"] or
                not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
            fail("file_changed", "The upload temporary file was replaced")

    def init(self, params):
        if self.root_fd is not None:
            fail("already_initialized", "This worker already has a root")
        root = params.get("root")
        if not isinstance(root, str) or not root or "\x00" in root:
            fail("invalid_params", "A configured root is required")
        # Resolving an owner-configured symlink root is allowed; subsequent walks
        # start at its pinned directory descriptor and never follow symlinks.
        root = os.path.realpath(os.path.expanduser(root))
        current = os.open("/", DIRECTORY_FLAGS)
        try:
            for part in root.split("/"):
                if part:
                    child = os.open(part, DIRECTORY_FLAGS, dir_fd=current)
                    os.close(current)
                    current = child
            self.root_fd = current
        except BaseException:
            os.close(current)
            raise
        return {"path": "", "maxChunkBytes": MAX_CHUNK_BYTES, "maxHandles": MAX_HANDLES}

    def list(self, params):
        path, parts = self.path(params.get("path", ""), allow_root=True)
        fd = self.directory(parts)
        entries = []
        used_bytes = len(encode({"path": path, "entries": [], "truncated": False}))
        truncated = False
        try:
            with os.scandir(fd) as iterator:
                for scanned, entry in enumerate(iterator):
                    if scanned >= MAX_ENTRIES:
                        truncated = True
                        break
                    if entry.name.startswith(TEMP_PREFIX):
                        continue
                    try:
                        entry_path = path + "/" + entry.name if path else entry.name
                        self.path(entry_path)
                        info = entry.stat(follow_symlinks=False)
                    except (FileError, FileNotFoundError):
                        continue
                    if stat.S_ISDIR(info.st_mode):
                        entry_type, size = "directory", 0
                    elif stat.S_ISREG(info.st_mode):
                        entry_type, size = "file", info.st_size
                    else:
                        continue
                    item = {"name": entry.name, "path": entry_path, "type": entry_type,
                            "size": size, "mtimeMs": info.st_mtime_ns // 1000000}
                    item_bytes = len(encode(item)) + 1
                    if used_bytes + item_bytes > MAX_LIST_BYTES:
                        truncated = True
                        break
                    entries.append(item)
                    used_bytes += item_bytes
        finally:
            os.close(fd)
        entries.sort(key=lambda entry: (entry["type"] != "directory", entry["name"]))
        return {"path": path, "entries": entries, "truncated": truncated}

    def read_open(self, params):
        self.capacity()
        path, parts = self.path(params.get("path"))
        parent_fd = self.directory(parts[:-1])
        try:
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK |
                         os.O_CLOEXEC, dir_fd=parent_fd)
        finally:
            os.close(parent_fd)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                fail("not_file", "Only regular files may be downloaded")
            if info.st_size > MAX_FILE_BYTES:
                fail("file_too_large", "The file exceeds the 100 GiB limit")
            transfer_id = secrets.token_hex(16)
            self.handles[transfer_id] = {
                "kind": "read", "fd": fd, "offset": 0, "size": info.st_size,
                "fingerprint": fingerprint(info), "hash": hashlib.sha256(),
            }
        except BaseException:
            os.close(fd)
            raise
        return {"transferId": transfer_id, "path": path, "size": info.st_size,
                "fingerprint": hashlib.sha256(encode(fingerprint(info)).encode("ascii")).hexdigest(),
                "mtimeMs": info.st_mtime_ns // 1000000}

    def read_chunk(self, params):
        transfer_id, handle = self.handle(params, "read")
        offset = integer(params.get("offset"), "offset", MAX_FILE_BYTES)
        maximum = integer(params.get("maxBytes"), "maxBytes", MAX_CHUNK_BYTES, 1)
        if offset != handle["offset"]:
            fail("invalid_offset", "Download chunks must be read in order")
        self.unchanged(handle)
        expected = min(maximum, handle["size"] - offset)
        data = os.read(handle["fd"], expected)
        self.unchanged(handle)
        if len(data) != expected:
            fail("file_changed", "The source file changed during download")
        handle["hash"].update(data)
        handle["offset"] += len(data)
        return {"transferId": transfer_id, "offset": offset,
                "nextOffset": handle["offset"],
                "dataBase64": base64.b64encode(data).decode("ascii"),
                "eof": handle["offset"] == handle["size"]}

    def read_close(self, params):
        transfer_id, handle = self.handle(params, "read")
        self.unchanged(handle)
        if handle["offset"] != handle["size"]:
            fail("incomplete", "The download has not reached the end of the file")
        result = {"transferId": transfer_id, "size": handle["size"],
                  "sha256": handle["hash"].hexdigest()}
        self.close_handle(transfer_id)
        return result

    def write_open(self, params):
        self.capacity()
        path, parts = self.path(params.get("path"))
        size = params.get("size")
        if size is not None:
            size = integer(size, "size", MAX_FILE_BYTES)
        expected_hash = digest(params["sha256"]) if params.get("sha256") is not None else None
        parent_fd = self.directory(parts[:-1])
        temp, fd, inode = None, None, None
        try:
            try:
                os.stat(parts[-1], dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                fail("already_exists", "The destination already exists")
            temp = TEMP_PREFIX + secrets.token_hex(16)
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW |
                         os.O_CLOEXEC, 0o600, dir_fd=parent_fd)
            info = os.fstat(fd)
            inode = (info.st_dev, info.st_ino)
            os.fchmod(fd, 0o600)
            transfer_id = secrets.token_hex(16)
            self.handles[transfer_id] = {
                "kind": "write", "fd": fd, "parent_fd": parent_fd, "temp": temp,
                "name": parts[-1], "path": path, "offset": 0, "size": size,
                "expected_hash": expected_hash, "hash": hashlib.sha256(),
                "inode": inode, "fingerprint": fingerprint(os.fstat(fd)),
            }
        except BaseException:
            if fd is not None:
                if inode is not None:
                    unlink_temporary(parent_fd, temp, inode)
                os.close(fd)
            os.close(parent_fd)
            raise
        return {"transferId": transfer_id, "path": path, "maxChunkBytes": MAX_CHUNK_BYTES}

    def write_chunk(self, params):
        transfer_id, handle = self.handle(params, "write")
        offset = integer(params.get("offset"), "offset", MAX_FILE_BYTES)
        if offset != handle["offset"]:
            fail("invalid_offset", "Upload chunks must be written in order")
        encoded = params.get("dataBase64")
        if not isinstance(encoded, str) or not 0 < len(encoded) <= (MAX_CHUNK_BYTES // 3) * 4:
            fail("invalid_params", "A nonempty chunk of at most 48 KiB is required")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            fail("invalid_params", "Invalid base64 chunk")
        if not data or len(data) > MAX_CHUNK_BYTES:
            fail("invalid_params", "A nonempty chunk of at most 48 KiB is required")
        if offset + len(data) > (handle["size"] if handle["size"] is not None else MAX_FILE_BYTES):
            fail("size_mismatch", "The upload exceeds its declared size or the 100 GiB limit")
        self.upload_unchanged(handle)
        remaining = memoryview(data)
        while remaining:
            written = os.write(handle["fd"], remaining)
            if written <= 0:
                fail("io_error", "Unable to write the upload")
            remaining = remaining[written:]
        handle["hash"].update(data)
        handle["offset"] += len(data)
        info = os.fstat(handle["fd"])
        if info.st_size != handle["offset"]:
            fail("file_changed", "The upload changed outside this transfer")
        handle["fingerprint"] = fingerprint(info)
        return {"transferId": transfer_id, "nextOffset": handle["offset"]}

    def write_commit(self, params):
        transfer_id, handle = self.handle(params, "write")
        self.upload_unchanged(handle)
        expected_hash = digest(params.get("sha256"))
        actual_hash = handle["hash"].hexdigest()
        if handle["size"] is not None and handle["size"] != handle["offset"]:
            fail("size_mismatch", "The upload does not match its declared size")
        if not hmac.compare_digest(expected_hash, actual_hash) or (
            handle["expected_hash"] is not None and
            not hmac.compare_digest(handle["expected_hash"], actual_hash)
        ):
            fail("hash_mismatch", "The uploaded file failed SHA-256 verification")
        os.fsync(handle["fd"])
        # Linux procfs binds the source to our open descriptor, so even a local
        # process replacing the temporary name cannot substitute another inode.
        # The hard link publishes atomically and never replaces an existing target
        # (including a dangling symlink). Both files are on the same filesystem.
        os.link("/proc/self/fd/" + str(handle["fd"]), handle["name"],
                dst_dir_fd=handle["parent_fd"], follow_symlinks=True)
        unlink_temporary(handle["parent_fd"], handle["temp"], handle["inode"])
        os.fsync(handle["parent_fd"])
        result = {"path": handle["path"], "size": handle["offset"], "sha256": actual_hash}
        self.close_handle(transfer_id)
        return result

    def write_cancel(self, params):
        transfer_id, _ = self.handle(params, "write")
        self.close_handle(transfer_id)
        return {"cancelled": True}

    def dispatch(self, method, params):
        methods = ("init", "list", "read_open", "read_chunk", "read_close",
                   "write_open", "write_chunk", "write_commit", "write_cancel")
        if method not in methods:
            fail("unknown_method", "Unknown file method")
        if not isinstance(params, dict):
            fail("invalid_params", "Parameters must be an object")
        if method != "init" and self.root_fd is None:
            fail("not_initialized", "The worker root has not been initialized")
        try:
            return getattr(self, method)(params)
        except (FileError, OSError, ValueError, UnicodeError) as error:
            transfer_id = params.get("transferId")
            if isinstance(transfer_id, str):
                self.close_handle(transfer_id)
            if isinstance(error, FileError):
                raise
            if isinstance(error, OSError):
                raise os_error(error) from None
            fail("invalid_params", "Invalid file parameters")


def object_without_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail("invalid_request", "Duplicate JSON keys are not allowed")
        result[key] = value
    return result


def reject_constant(_):
    fail("invalid_request", "Non-finite JSON numbers are not allowed")


def main():
    worker = Worker()
    def interrupted(_signum, _frame):
        raise SystemExit(0)
    for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(signum, interrupted)
    try:
        while True:
            line = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
            if not line:
                break
            request_id = None
            oversized = len(line) > MAX_LINE_BYTES
            try:
                if oversized:
                    fail("request_too_large", "The request exceeds the line size limit")
                request = json.loads(line, object_pairs_hook=object_without_duplicates,
                                     parse_constant=reject_constant)
                if not isinstance(request, dict):
                    fail("invalid_request", "A request object is required")
                candidate = request.get("id")
                if not ((type(candidate) is int and 0 <= candidate < 2**64) or
                        (isinstance(candidate, str) and len(candidate) <= 128)):
                    fail("invalid_request", "A request id is required")
                request_id = candidate
                result = worker.dispatch(request.get("method"), request.get("params", {}))
                response = {"id": request_id, "result": result}
            except FileError as error:
                response = {"id": request_id, "error": {"code": error.code,
                                                       "message": error.message}}
            except (ValueError, UnicodeError, RecursionError):
                response = {"id": request_id, "error": {"code": "invalid_request",
                                                       "message": "Invalid JSON request"}}
            except Exception:
                # Never send tracebacks or OS exception text containing host paths.
                response = {"id": request_id, "error": {"code": "internal_error",
                                                       "message": "File worker failed"}}
                oversized = True
            output = encode(response)
            if len(output) + 1 > MAX_LINE_BYTES:
                output = encode({"id": request_id, "error": {"code": "response_too_large",
                                                            "message": "Response limit exceeded"}})
                oversized = True
            sys.stdout.write(output + "\n")
            sys.stdout.flush()
            if oversized:
                break
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    finally:
        worker.close()


if __name__ == "__main__":
    main()
