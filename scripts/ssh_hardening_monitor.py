"""Linux /proc sampling helpers for the isolated SSH acceptance fixture only."""
from dataclasses import dataclass
from pathlib import Path
import os


SSH_PROGRAMS = {"ssh", "ssh-keyscan", "ssh-keygen"}
CAPABILITY_KEYS = {b"RACKTOP_ASKPASS_SOCKET", b"RACKTOP_ASKPASS_TOKEN", b"RACKTOP_PROXY_ASKPASS_TOKEN"}
LEGACY_LABELS = {b"RACKTOP_ASKPASS_PASSWORD": "inherited-legacy-target",
                 b"RACKTOP_PROXY_PASSWORD": "inherited-legacy-proxy"}


@dataclass(frozen=True)
class Snapshot:
    pid: int
    parent: int
    started: int
    executable: Path
    arguments: bytes
    environment: bytes

    @property
    def values(self):
        return dict(part.split(b"=", 1) for part in self.environment.split(b"\0") if b"=" in part)


def read_snapshot(pid, read_bytes=None, read_link=None):
    """Reject mixed fork/exec and PID-reuse samples; never log proc contents.

    The optional readers let deterministic tests interleave an exec between
    reads. Callers must restrict pid to their own synthetic descendants.
    """
    read_bytes = read_bytes or (lambda name: Path(f"/proc/{pid}/{name}").read_bytes())
    read_link = read_link or (lambda: Path(os.readlink(f"/proc/{pid}/exe")))
    try:
        def identity():
            fields = read_bytes("stat").rsplit(b") ", 1)[1].split()
            return int(fields[1]), int(fields[19])
        before = identity()
        executable = read_link()
        arguments = read_bytes("cmdline")
        environment = read_bytes("environ")
        if arguments != read_bytes("cmdline") or executable != read_link() or before != identity():
            return None
        return Snapshot(pid, *before, executable, arguments, environment)
    except (OSError, ValueError, IndexError):
        return None


def process_kind(snapshot, root_pid, probe, root_arguments):
    if snapshot.executable.name in SSH_PROGRAMS:
        return snapshot.executable.name
    if snapshot.executable != probe:
        return None
    # A fork initially has its parent's image, argv and initial environment.
    # It has not run exec with Command.env_remove yet. OpenSSH's actual
    # askpass/proxy helpers have an SSH parent and/or their own argv/metadata.
    if (snapshot.parent == root_pid and snapshot.arguments == root_arguments
            and not CAPABILITY_KEYS.intersection(snapshot.values)):
        return "pre-exec"
    return "helper"


def assert_password_free(snapshot, kind, secrets):
    """Report static fixture labels/keys only, never values or command text."""
    environment = snapshot.environment
    if kind == "pre-exec":
        # Only the two deliberately injected legacy sentinels are expected in
        # the parent's initial image. Real target/jump bytes still must fail.
        environment = b"\0".join(
            key + b"=" + value for key, value in snapshot.values.items()
            if key not in LEGACY_LABELS or value != secrets.get(LEGACY_LABELS[key]))
    for location, data in [("environment", environment), ("arguments", snapshot.arguments)]:
        matched = [label for label, value in secrets.items() if value in data]
        if matched:
            raise AssertionError(
                f"Synthetic {kind} {location} contains password bytes ({','.join(matched)})")
