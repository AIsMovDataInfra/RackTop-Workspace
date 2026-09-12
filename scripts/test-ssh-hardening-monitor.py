#!/usr/bin/env python3
"""Deterministic monitor regressions; only disposable, synthetic processes."""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import unittest

from ssh_hardening_monitor import Snapshot, assert_password_free, process_kind, read_snapshot


PROBE = Path("/fixture/ssh-hardening-probe")
ROOT_ARGV = bytes(PROBE) + b"\0"
SECRETS = {"target": b"synthetic-target-only", "inherited-legacy-target": b"synthetic-legacy-only"}
LEGACY = b"RACKTOP_ASKPASS_PASSWORD=" + SECRETS["inherited-legacy-target"] + b"\0"


class MonitorTests(unittest.TestCase):
    def sample(self, executable=PROBE, arguments=ROOT_ARGV, environment=LEGACY, parent=10):
        return Snapshot(11, parent, 42, executable, arguments, environment)

    def test_parent_fork_is_distinct_from_post_exec_helper(self):
        sample = self.sample()
        self.assertEqual(process_kind(sample, 10, PROBE, ROOT_ARGV), "pre-exec")
        assert_password_free(sample, "pre-exec", SECRETS)
        for sample in [self.sample(parent=20), self.sample(arguments=ROOT_ARGV + b"prompt\0"),
                       self.sample(environment=LEGACY + b"RACKTOP_ASKPASS_TOKEN=synthetic\0")]:
            self.assertEqual(process_kind(sample, 10, PROBE, ROOT_ARGV), "helper")
            with self.assertRaisesRegex(AssertionError, "legacy"):
                assert_password_free(sample, "helper", SECRETS)

    def test_all_ssh_programs_and_real_passwords_still_fail(self):
        for name in ["ssh", "ssh-keyscan", "ssh-keygen"]:
            sample = self.sample(executable=Path("/usr/bin") / name)
            self.assertEqual(process_kind(sample, 10, PROBE, ROOT_ARGV), name)
            with self.assertRaises(AssertionError):
                assert_password_free(sample, name, SECRETS)
        with self.assertRaisesRegex(AssertionError, "target"):
            assert_password_free(self.sample(environment=b"OTHER=" + SECRETS["target"]), "pre-exec", SECRETS)
        with self.assertRaisesRegex(AssertionError, "target"):
            assert_password_free(self.sample(environment=b"RACKTOP_ASKPASS_PASSWORD=" + SECRETS["target"]), "pre-exec", SECRETS)
        with self.assertRaisesRegex(AssertionError, "arguments"):
            assert_password_free(self.sample(arguments=SECRETS["target"], environment=b""), "helper", SECRETS)

    def test_exec_and_pid_reuse_cannot_mix_proc_records(self):
        def stat(start=42):
            fields = [b"S", b"10"] + [b"0"] * 17 + [str(start).encode()]
            return b"11 (name with ) parentheses) " + b" ".join(fields)
        for mutation in ["executable", "arguments", "identity", None]:
            counters = {}
            def read(name):
                counters[name] = counters.get(name, 0) + 1
                second = counters[name] == 2
                if name == "stat":
                    return stat(43 if mutation == "identity" and second else 42)
                if name == "cmdline":
                    return b"ssh\0" if mutation == "arguments" and second else ROOT_ARGV
                return LEGACY
            def link():
                counters["exe"] = counters.get("exe", 0) + 1
                return Path("/usr/bin/ssh") if mutation == "executable" and counters["exe"] == 2 else PROBE
            sample = read_snapshot(11, read, link)
            self.assertEqual(sample is None, mutation is not None)

    @unittest.skipUnless(sys.platform.startswith("linux") and Path("/proc/self/stat").exists(), "requires Linux /proc")
    def test_live_fork_then_exec_keeps_only_parent_sentinel_before_exec(self):
        ssh = shutil.which("ssh", path="/app/bin:/usr/bin:/bin")
        self.assertIsNotNone(ssh)
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        actor = '''import os,sys
pid=os.fork()
if pid:
 print(pid,flush=True)
 os.waitpid(pid,0)
else:
 os.read(0,1)
 os.execve(sys.argv[1],[sys.argv[1],"-F","/dev/null","-o","BatchMode=yes","-o","ConnectTimeout=3","-o","IdentityFile=none","-o","IdentityAgent=none","-o","PubkeyAuthentication=no","-o","UserKnownHostsFile=/dev/null","-o","GlobalKnownHostsFile=/dev/null","-p",sys.argv[2],"tester@127.0.0.1"],{"PATH":"/usr/bin:/bin"})
'''
        command = [sys.executable, "-c", actor, ssh, str(listener.getsockname()[1])]
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env={"PATH": "/usr/bin:/bin", "RACKTOP_ASKPASS_PASSWORD": SECRETS["inherited-legacy-target"].decode()})
        child = None
        try:
            child = int(process.stdout.readline())
            before = read_snapshot(child)
            root = read_snapshot(process.pid)
            self.assertIsNotNone(before)
            self.assertIsNotNone(root)
            self.assertIn(SECRETS["inherited-legacy-target"], before.environment)
            # This was the old monitor's false-positive classification.
            self.assertEqual(before.executable, root.executable)
            self.assertEqual(process_kind(before, process.pid, root.executable, root.arguments), "pre-exec")
            assert_password_free(before, "pre-exec", SECRETS)
            process.stdin.write(b"x")
            process.stdin.flush()
            deadline = time.monotonic() + 3
            after = None
            while time.monotonic() < deadline:
                after = read_snapshot(child)
                if after and after.executable.name == "ssh":
                    break
                time.sleep(.002)
            self.assertIsNotNone(after)
            self.assertEqual(after.started, before.started)
            self.assertEqual(process_kind(after, process.pid, root.executable, root.arguments), "ssh")
            assert_password_free(after, "ssh", SECRETS)
        finally:
            if child:
                try:
                    os.kill(child, 15)
                except ProcessLookupError:
                    pass
            process.communicate(timeout=5)
            listener.close()


if __name__ == "__main__":
    unittest.main()
