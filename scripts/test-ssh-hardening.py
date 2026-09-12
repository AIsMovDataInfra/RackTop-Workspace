#!/usr/bin/env python3
"""Synthetic loopback SSH acceptance tests; no real profile, keyring or relay.

Usage: python3 scripts/test-ssh-hardening.py /absolute/path/ssh-hardening-probe
Requires Paramiko and an integration-probe build. Linux runs the actual remote
Python file worker; other Unix platforms emulate its file RPC to test transport.
Only descendants of this script's explicitly spawned synthetic probe are sampled
for argv/environ. Their contents and passwords are never written to result files.
"""
import base64
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import select
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

import paramiko
from ssh_hardening_monitor import assert_password_free, process_kind, read_snapshot

logging.getLogger("paramiko").setLevel(logging.CRITICAL)
REPO = Path(__file__).resolve().parents[1]
PROBE = Path(sys.argv[1]).resolve()
if not PROBE.is_file():
    raise SystemExit("Build the isolated Rust integration harness first")
RUN = Path(tempfile.mkdtemp(prefix="racktop-ssh-hardening-")).resolve()
RUN.chmod(0o700)
FIXTURE_ID = secrets.token_hex(16)
(RUN / ".fixture-id").write_text(FIXTURE_ID)
LINUX = sys.platform.startswith("linux") and Path("/proc/self/stat").exists()
SSH_PATH = "/app/bin:/usr/bin:/bin" if Path("/.flatpak-info").is_file() else "/usr/bin:/bin"
TARGET_A = "  Synthetic target A 密码 only 2026  "
TARGET_B = "Synthetic target B distinct !@# 2026"
JUMP = "Synthetic jump-only different 2026"
LEGACY_A = "Synthetic inherited legacy target should be removed"
LEGACY_B = "Synthetic inherited legacy proxy should be removed"
SECRETS = [value.encode() for value in [TARGET_A, TARGET_B, JUMP, LEGACY_A, LEGACY_B]]
SECRET_KINDS = dict(zip(["target-a", "target-b", "jump", "inherited-legacy-target", "inherited-legacy-proxy"], SECRETS))
INHERITED_FIELDS = ["RACKTOP_ASKPASS_PASSWORD", "RACKTOP_PROXY_PASSWORD", "RACKTOP_ASKPASS_SOCKET",
                    "RACKTOP_ASKPASS_TOKEN", "RACKTOP_PROXY_ASKPASS_TOKEN", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE"]
# Auxiliary commands can finish between /proc samples. Check their executed
# environments deterministically, then exec the real tool with unchanged argv.
SHIMS = RUN / "ssh-tools"
SHIMS.mkdir(mode=0o700)
AUX_AUDIT = RUN / "ssh-tools-audit.txt"
for tool in ["ssh-keyscan", "ssh-keygen"]:
    executable = shutil.which(tool, path=SSH_PATH)
    if not executable:
        raise SystemExit(f"Missing synthetic fixture dependency: {tool}")
    lines = ["#!/bin/sh", "clean=1"]
    for key in INHERITED_FIELDS:
        lines += [f'if [ "${{{key}+x}}" = x ]; then',
                  f"  printf '%s\\n' '{tool}:{key}' >> {shlex.quote(str(AUX_AUDIT))}", "  clean=0", "fi"]
    lines += ['[ "$clean" = 1 ] || exit 97',
              f"printf '%s\\n' '{tool}:clean' >> {shlex.quote(str(AUX_AUDIT))}",
              f'exec {shlex.quote(executable)} "$@"']
    shim = SHIMS / tool
    shim.write_text("\n".join(lines) + "\n")
    shim.chmod(0o700)
SSH_PATH = str(SHIMS) + ":" + SSH_PATH
source = (REPO / "src-tauri/src/collector.rs").read_text()
SAMPLE = json.loads(re.search(r'const SAMPLE: &str = ("(?:[^"\\]|\\.)*");', source).group(1)).encode()
WORKER_PATH = REPO / "src-tauri/src/sharing/remote_files.py"
WORKER_COMMAND = "python3 -u -c '" + WORKER_PATH.read_text().replace("'", "'\\''") + "'"
METRICS = {"sshProcessesSampled": 0, "helperProcessesSampled": 0, "unrelatedHelperRejected": 0,
           "auxiliaryProcessesSampled": 0, "preExecForksObserved": 0,
           "replaysRejected": 0, "passwordFreeChildEnvironment": True if LINUX else "not checked: no Linux /proc",
           "passwordFreeArguments": True if LINUX else "not checked: no Linux /proc",
           "noCrossDelivery": True, "noPlaintextFiles": True,
           "fileWorker": "repository Linux Python worker" if LINUX else "in-memory file RPC fixture"}
METRICS_LOCK = threading.Lock()


def close_channel(channel):
    # SSH peers may already have closed during expected failures/cancellation.
    # Ignore only teardown I/O errors, never assertions or protocol failures.
    try:
        channel.close()
    except (EOFError, OSError):
        pass


class Authentication(paramiko.ServerInterface):
    def __init__(self, service):
        self.service = service
        self.destinations = {}
        self.command = None
        self.ready = threading.Event()

    def get_allowed_auths(self, username):
        return "password"

    def check_auth_password(self, username, password):
        accepted = username == "tester" and password == self.service.password
        crossed = password in [TARGET_A, TARGET_B, JUMP] and password != self.service.password
        with self.service.lock:
            self.service.attempts.append((accepted, crossed))
        if crossed:
            with METRICS_LOCK:
                METRICS["noCrossDelivery"] = False
        return paramiko.AUTH_SUCCESSFUL if accepted else paramiko.AUTH_FAILED

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == "session" and not self.service.jump else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_direct_tcpip_request(self, chanid, origin, destination):
        allowed = {("127.0.0.1", service.port) for service in TARGETS}
        if self.service.jump and self.service.forwarding and destination in allowed:
            self.destinations[chanid] = destination
            return paramiko.OPEN_SUCCEEDED
        return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_pty_request(self, *args):
        return True

    def check_channel_exec_request(self, channel, command):
        decoded = command.decode("utf-8")
        if not (decoded == WORKER_COMMAND or "__RACKTOP_" in decoded or "racktop-terminal-ok" in decoded):
            return False
        self.command = decoded
        self.ready.set()
        return True


class Service:
    def __init__(self, password, jump=False):
        self.password, self.jump = password, jump
        self.key = paramiko.RSAKey.generate(2048)
        self.attempts = []
        self.lock = threading.Lock()
        self.forwarding, self.running = True, True
        self.delay = .25
        self.connections, self.workers = [], []
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.port = self.listener.getsockname()[1]
        self.listener.listen(32)
        self.listener.settimeout(.2)
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while self.running:
            try:
                client, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self.connection, args=(client,), daemon=True).start()

    def connection(self, client):
        transport = paramiko.Transport(client)
        self.connections.append(transport)
        authentication = Authentication(self)
        try:
            # Ensures the synthetic process monitor can sample SSH before askpass.
            time.sleep(self.delay)
            transport.add_server_key(self.key)
            transport.start_server(server=authentication)
            while self.running and transport.is_active():
                channel = transport.accept(.2)
                if channel is None:
                    continue
                if self.jump:
                    remote = socket.create_connection(authentication.destinations[channel.get_id()], timeout=5)
                    threading.Thread(target=self.relay, args=(channel, remote), daemon=True).start()
                elif authentication.ready.wait(5):
                    if authentication.command == WORKER_COMMAND:
                        self.file_worker(channel)
                    else:
                        data = SAMPLE if "__RACKTOP_" in authentication.command else b"racktop-terminal-ok\n"
                        channel.sendall(data)
                        channel.send_exit_status(0)
                        close_channel(channel)
        except (EOFError, OSError, paramiko.SSHException):
            pass
        finally:
            transport.close()

    def file_worker(self, channel):
        if not LINUX:
            self.file_protocol_fixture(channel)
            return
        # Execute only the fixed checked-in worker, never a received command.
        worker = subprocess.Popen([sys.executable, "-u", str(WORKER_PATH)], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  env={"PATH": "/usr/bin:/bin", "HOME": str(RUN)})
        self.workers.append(worker)
        def incoming():
            try:
                while True:
                    data = channel.recv(65536)
                    if not data:
                        break
                    worker.stdin.write(data)
                    worker.stdin.flush()
            except (OSError, EOFError):
                pass
            finally:
                try:
                    worker.stdin.close()
                except OSError:
                    pass
        threading.Thread(target=incoming, daemon=True).start()
        try:
            while True:
                data = os.read(worker.stdout.fileno(), 65536)
                if not data:
                    break
                channel.sendall(data)
            worker.wait(timeout=5)
            channel.send_exit_status(worker.returncode or 0)
        except (OSError, EOFError, subprocess.TimeoutExpired):
            worker.kill()
        finally:
            close_channel(channel)

    @staticmethod
    def file_protocol_fixture(channel):
        # macOS cannot execute the Linux worker's /proc/self/fd publish syscall.
        # Exercise the real GatewayOps/SSH stream using only this bounded RPC
        # fixture, without executing any command or writing arbitrary paths.
        buffer = b""
        stored = b""
        pending = bytearray()
        try:
            while True:
                data = channel.recv(65536)
                if not data:
                    break
                buffer += data
                if len(buffer) > 128 * 1024:
                    break
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    request = json.loads(line)
                    method, params = request["method"], request["params"]
                    result = None
                    error = None
                    if method == "init":
                        root = Path(params["root"]).resolve()
                        if root.parent != RUN:
                            raise ValueError("root escaped disposable fixture")
                        result = {"root": "."}
                    elif method == "write_open" and params.get("path") == "round-trip.bin" and not stored:
                        pending = bytearray()
                        result = {"transferId": "synthetic-upload"}
                    elif method == "write_chunk" and params.get("transferId") == "synthetic-upload" and params.get("offset") == len(pending):
                        pending.extend(base64.b64decode(params["dataBase64"], validate=True))
                        if len(pending) > 128 * 1024:
                            raise ValueError("file fixture size exceeded")
                        result = {"nextOffset": len(pending)}
                    elif method == "write_commit" and params.get("transferId") == "synthetic-upload" and params.get("sha256") == hashlib.sha256(pending).hexdigest():
                        stored = bytes(pending)
                        result = {"sha256": hashlib.sha256(stored).hexdigest()}
                    elif method == "read_open" and params.get("path") == "round-trip.bin":
                        result = {"transferId": "synthetic-download", "size": len(stored)}
                    elif method == "read_chunk" and params.get("transferId") == "synthetic-download":
                        offset = params["offset"]
                        chunk = stored[offset:offset + min(params["maxBytes"], 48 * 1024)]
                        result = {"dataBase64": base64.b64encode(chunk).decode(), "eof": offset + len(chunk) == len(stored)}
                    elif method == "read_close" and params.get("transferId") == "synthetic-download":
                        result = {"sha256": hashlib.sha256(stored).hexdigest()}
                    else:
                        error = {"code": "invalid_path", "message": "Fixture rejects this operation"}
                    response = {"id": request["id"], "result": result} if error is None else {"id": request["id"], "error": error}
                    channel.sendall((json.dumps(response) + "\n").encode())
        except (EOFError, OSError, ValueError, KeyError, TypeError):
            pass
        finally:
            close_channel(channel)

    @staticmethod
    def relay(channel, remote):
        try:
            while True:
                ready, _, _ = select.select([channel, remote], [], [], 1)
                for source in ready:
                    data = source.recv(65536)
                    if not data:
                        return
                    (remote if source is channel else channel).sendall(data)
        except (OSError, EOFError):
            pass
        finally:
            close_channel(channel)
            try:
                remote.close()
            except (EOFError, OSError):
                pass

    def close(self):
        self.running = False
        self.listener.close()
        for transport in self.connections:
            transport.close()
        for worker in self.workers:
            if worker.poll() is None:
                worker.kill()
            worker.wait(timeout=5)


def descendants(root):
    found, queue = set(), [root]
    while queue:
        parent = queue.pop()
        try:
            tasks = list(Path(f"/proc/{parent}/task").iterdir())
        except OSError:
            continue
        for task in tasks:
            try:
                children = [int(value) for value in (task / "children").read_text().split()]
            except OSError:
                continue
            for child in children:
                if child not in found:
                    found.add(child)
                    queue.append(child)
    return found


def helper_attempt(channel):
    env = {"PATH": SSH_PATH, "HOME": str(RUN),
           "RACKTOP_ASKPASS_SOCKET": channel[0], "RACKTOP_ASKPASS_TOKEN": channel[1]}
    result = subprocess.run([str(PROBE)], env=env, capture_output=True, timeout=5)
    assert result.returncode != 0 and result.stdout == b"", "An unrelated synthetic helper received a password"


class Monitor:
    def __init__(self, process):
        self.process, self.stop = process, threading.Event()
        self.channels, self.observed, self.errors = set(), set(), []
        self.thread = threading.Thread(target=self.run, daemon=True)
        if LINUX:
            self.thread.start()

    def run(self):
        try:
            while not self.stop.is_set():
                for pid in descendants(self.process.pid):
                    snapshot = read_snapshot(pid)
                    if snapshot is None:
                        continue
                    kind = process_kind(snapshot, self.process.pid, PROBE, os.fsencode(PROBE) + b"\0")
                    if kind is None:
                        continue
                    assert_password_free(snapshot, kind, SECRET_KINDS)
                    identity = (pid, snapshot.started, kind)
                    if identity not in self.observed:
                        self.observed.add(identity)
                        with METRICS_LOCK:
                            metric = {"ssh": "sshProcessesSampled", "helper": "helperProcessesSampled",
                                      "pre-exec": "preExecForksObserved"}.get(kind, "auxiliaryProcessesSampled")
                            METRICS[metric] += 1
                    if kind == "pre-exec":
                        continue
                    values = snapshot.values
                    endpoint = values.get(b"RACKTOP_ASKPASS_SOCKET")
                    token = values.get(b"RACKTOP_ASKPASS_TOKEN")
                    if endpoint and token:
                        channel = (endpoint.decode(), token.decode())
                        if channel not in self.channels:
                            self.channels.add(channel)
                            helper_attempt(channel)
                            with METRICS_LOCK:
                                METRICS["unrelatedHelperRejected"] += 1
                self.stop.wait(.01)
        except BaseException as error:
            self.errors.append(error)

    def finish(self):
        if not LINUX:
            return
        self.stop.set()
        self.thread.join(timeout=10)
        assert not self.thread.is_alive(), "Synthetic process monitor did not stop"
        if self.errors:
            raise self.errors[0]
        for channel in self.channels:
            helper_attempt(channel)
            with METRICS_LOCK:
                METRICS["replaysRejected"] += 1
            assert not Path(channel[0]).exists(), "Operation ended with a live askpass socket"


TARGETS = [Service(TARGET_A), Service(TARGET_B)]
JUMPER = Service(JUMP, jump=True)
known_hosts = RUN / "known_hosts"
known_hosts.write_text("".join(f"[127.0.0.1]:{service.port} {service.key.get_name()} {service.key.get_base64()}\n" for service in [*TARGETS, JUMPER]))
known_hosts.chmod(0o600)


def endpoint(target=0, jump=False):
    service = TARGETS[target]
    return {"server": {"id": f"synthetic-{target}-{int(jump)}", "name": "Synthetic loopback",
            "host": "127.0.0.1", "port": service.port, "username": "tester", "tags": [],
            "samplingIntervalSeconds": 2, "historyRetentionDays": 1, "authMethod": "password", "status": "unknown",
            "proxyJump": f"tester@127.0.0.1:{JUMPER.port}" if jump else None,
            "proxyUsePassword": jump, "saveProxyPassword": False,
            # Managed connections use -F /dev/null for both target and jump;
            # HOME alone does not prevent OpenSSH reading the real passwd home.
            "managed": {"accountId": "synthetic-account", "company": "A公司",
                        "remoteId": "00000000-0000-4000-8000-000000000001",
                        "available": True, "reason": None, "version": 1,
                        "hasPassword": True, "hasJumpPassword": jump, "credentialRevision": 1}},
            "targetPassword": service.password, "proxyPassword": JUMP if jump else None}


def call(action, definition=None, expect_failure=False, **extra):
    data = dict(definition or endpoint(), action=action, fixtureRoot=str(RUN), fixtureId=FIXTURE_ID, **extra)
    env = {"PATH": SSH_PATH, "HOME": str(RUN), "TERM": "xterm",
           "TMPDIR": str(RUN.parent),
           "RACKTOP_TEST_KNOWN_HOSTS": str(known_hosts),
           "RACKTOP_ASKPASS_PASSWORD": LEGACY_A, "RACKTOP_PROXY_PASSWORD": LEGACY_B}
    process = subprocess.Popen([str(PROBE)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    monitor = Monitor(process)
    try:
        stdout, stderr = process.communicate(json.dumps(data).encode(), timeout=45)
    except BaseException:
        process.kill()
        process.communicate()
        raise
    finally:
        monitor.finish()
    assert not any(secret in stdout + stderr for secret in SECRETS), "Synthetic password appeared in result output"
    if AUX_AUDIT.exists():
        audit = AUX_AUDIT.read_text().splitlines()
        allowed = {f"{tool}:{key}" for tool in ["ssh-keyscan", "ssh-keygen"] for key in ["clean", *INHERITED_FIELDS]}
        assert all(record in allowed for record in audit), "Invalid synthetic auxiliary audit record"
        inherited = sorted({record for record in audit if not record.endswith(":clean")})
        assert not inherited, "Synthetic auxiliary SSH fields were inherited: " + ", ".join(inherited)
    diagnostic = stderr[-2048:].decode("utf-8", errors="replace")
    assert (process.returncode != 0) == expect_failure, f"Synthetic {action} ({data['server']['id']}) returned {process.returncode}; expected_failure={expect_failure}; stderr={diagnostic}"
    if not expect_failure:
        assert json.loads(stdout)["passed"] is True


results = {}
try:
    for through_jump in [False, True]:
        suffix = "jump" if through_jump else "direct"
        for action in ["collect", "terminal", "files"]:
            root = RUN / f"files-{suffix}"
            root.mkdir(exist_ok=True)
            call(action, endpoint(jump=through_jump), root=str(root))
            results[f"{action}_{suffix}"] = True
    before = len(TARGETS[0].attempts)
    call("scan", endpoint(jump=True))
    assert len(TARGETS[0].attempts) == before, "Host-key scan delivered target credentials"
    results["host_key_scan_has_only_jump_credentials"] = True
    audit = AUX_AUDIT.read_text().splitlines()
    assert audit and set(audit) == {"ssh-keyscan:clean", "ssh-keygen:clean"}, "An auxiliary SSH tool inherited askpass fields"
    results["auxiliary_tools_reject_inherited_askpass_fields"] = True
    endpoints = [endpoint(target=index % 2, jump=index % 3 != 0) for index in range(8)]
    call("concurrent", endpoints=endpoints)
    results["eight_concurrent_operations_keep_distinct_passwords"] = True
    wrong = endpoint(jump=True)
    wrong["targetPassword"] = "synthetic wrong target"
    call("collect", wrong, expect_failure=True)
    wrong = endpoint(jump=True)
    wrong["proxyPassword"] = "synthetic wrong jump"
    before = len(TARGETS[0].attempts)
    call("collect", wrong, expect_failure=True)
    assert len(TARGETS[0].attempts) == before
    results["wrong_target_and_jump_passwords_fail_closed"] = True
    JUMPER.forwarding = False
    call("collect", endpoint(jump=True), expect_failure=True)
    JUMPER.forwarding = True
    results["forwarding_denial_does_not_fall_back"] = True
    TARGETS[0].delay = 2
    call("cancel")
    TARGETS[0].delay = .25
    results["cancel_closes_unconsumed_channel"] = True
    old_key = TARGETS[0].key
    TARGETS[0].key = paramiko.RSAKey.generate(2048)
    before = len(TARGETS[0].attempts)
    call("collect", expect_failure=True)
    assert len(TARGETS[0].attempts) == before
    TARGETS[0].key = old_key
    results["changed_host_key_blocks_authentication"] = True
    assert METRICS["noCrossDelivery"]
    if LINUX:
        assert METRICS["sshProcessesSampled"] >= 10 and METRICS["unrelatedHelperRejected"] >= 5
    for path in RUN.rglob("*"):
        if path.is_file():
            assert not any(secret in path.read_bytes() for secret in SECRETS), "A regular fixture output file contains password bytes"
    results.update(METRICS)
    results["passed"] = True
    (RUN / "results.json").write_text(json.dumps(results, indent=2))
    print(json.dumps({"passed": True, "checks": len(results), "run": str(RUN), **METRICS}))
finally:
    for service in [JUMPER, *TARGETS]:
        service.close()
