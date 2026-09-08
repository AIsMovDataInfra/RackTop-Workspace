#!/usr/bin/env python3
"""Verify macOS release artifacts on a native macOS runner; never use a real profile.

Requires Apple's command-line tools and minisign (brew install minisign). The
smoke check proves process survival and an isolated, empty database was created;
it deliberately does not claim that GUI interaction or SSH connections passed.
"""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time


ROOT = Path(__file__).resolve().parent.parent
ARCHES = {"aarch64-apple-darwin": "arm64", "x86_64-apple-darwin": "x86_64"}
SECRET_NAME = re.compile(r"SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIAL|CERTIFICATE", re.I)


class VerificationError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def clean_environment():
    return {
        key: value for key, value in os.environ.items()
        if not key.startswith(("APPLE_", "TAURI_SIGNING_", "NOTARY_"))
        and not SECRET_NAME.search(key)
    }


def run(command, *, env=None, timeout=180, text=True):
    result = subprocess.run(command, env=env or clean_environment(),
                            capture_output=True, text=text, timeout=timeout)
    if result.returncode:
        # Commands here contain artifact paths, never signing credentials.
        detail = result.stderr if text else result.stderr.decode(errors="replace")
        raise VerificationError(f"{Path(command[0]).name} failed: {detail[-1800:].strip()}")
    return result.stdout


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def bundle_manifest(app):
    """Compare all signed app bytes, symlinks and permission bits across containers."""
    entries = {}
    for path in sorted(app.rglob("*")):
        relative = path.relative_to(app).as_posix()
        info = path.lstat()
        mode = stat.S_IMODE(info.st_mode)
        if path.is_symlink():
            target = os.readlink(path)
            require(not Path(target).is_absolute(), f"Absolute app symlink: {relative}")
            require(path.resolve().is_relative_to(app.resolve()), f"Escaping app symlink: {relative}")
            entries[relative] = ["link", mode, target]
        elif path.is_file():
            require(path.name not in {".env", "id_rsa", "id_ed25519", "racktop.sqlite", "team.sqlite"}
                    and not path.name.endswith((".sqlite-wal", ".sqlite-shm")),
                    f"Unexpected private configuration in app: {relative}")
            entries[relative] = ["file", mode, sha256(path)]
        elif path.is_dir():
            entries[relative] = ["directory", mode]
        else:
            raise VerificationError(f"Unexpected special file in app: {relative}")
    return entries


def inspect_app(app, expected_arch, version, signing_mode, notarized):
    require(app.is_dir(), "RackTop.app is missing from the artifact")
    with (app / "Contents/Info.plist").open("rb") as source:
        info = plistlib.load(source)
    require(info.get("CFBundleShortVersionString") == version, "App version does not match release version")
    require(info.get("CFBundleVersion") == version, "App build version does not match release version")
    executable_name = info.get("CFBundleExecutable", "")
    require(executable_name and Path(executable_name).name == executable_name, "Invalid bundle executable name")
    executable = app / "Contents/MacOS" / executable_name
    require(executable.is_file(), "App executable is missing")
    actual_arches = run(["/usr/bin/lipo", "-archs", str(executable)]).split()
    require(actual_arches == [expected_arch], f"Wrong executable architecture: {actual_arches}")
    for filename in ("LICENSE", "NOTICE.md"):
        bundled = app / "Contents/Resources" / filename
        require(bundled.is_file(), f"App is missing {filename}")
        require(sha256(bundled) == sha256(ROOT / filename), f"App contains an outdated {filename}")
    run(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)])
    details = subprocess.run(["/usr/bin/codesign", "-dv", "--verbose=4", str(app)],
                             env=clean_environment(), capture_output=True, text=True, timeout=60)
    require(details.returncode == 0, "Cannot inspect the app signature")
    details = details.stdout + details.stderr
    if signing_mode == "ad-hoc":
        require("Signature=adhoc" in details, "Expected an ad-hoc app signature")
    else:
        require("Authority=Developer ID Application:" in details, "Expected a Developer ID Application signature")
        require("TeamIdentifier=not set" not in details and "TeamIdentifier=" in details,
                "Developer ID signature has no team identifier")
    if notarized:
        run(["/usr/bin/xcrun", "stapler", "validate", str(app)])
        run(["/usr/sbin/spctl", "--assess", "--type", "execute", "--verbose=2", str(app)])
    return info, executable, bundle_manifest(app)


def unpack_updater(archive, destination):
    # Validate before using Apple's tar, which preserves macOS metadata. Reject
    # symlink-parent traversal as well as direct ../ paths and special files.
    with tarfile.open(archive, "r:gz") as source:
        members = source.getmembers()
        require(len(members) <= 100000, "Updater archive has too many entries")
        total = 0
        names = set()
        symlinks = set()
        for member in members:
            name = PurePosixPath(member.name)
            require(not name.is_absolute() and ".." not in name.parts
                    and name.parts and name.parts[0] == "RackTop.app",
                    "Updater archive has an unsafe or unexpected path")
            require(str(name) not in names, "Updater archive contains duplicate paths")
            names.add(str(name))
            require(member.isdir() or member.isfile() or member.issym(), "Updater archive contains a special file or hardlink")
            total += member.size
            require(total <= 4 * 1024**3, "Updater archive exceeds the extraction size limit")
            if member.issym():
                target = PurePosixPath(member.linkname)
                require(not target.is_absolute(), "Updater archive contains an absolute symlink")
                normalized = os.path.normpath(str(name.parent / target))
                require(normalized == "RackTop.app" or normalized.startswith("RackTop.app/"),
                        "Updater archive contains an escaping symlink")
                symlinks.add(name)
        for member in members:
            require(not any(parent in symlinks for parent in PurePosixPath(member.name).parents),
                    "Updater archive writes through a symlink")
    run(["/usr/bin/tar", "-xzf", str(archive), "-C", str(destination)])


def verify_updater_signature(archive, public_key, temp):
    signature = Path(str(archive) + ".sig")
    require(signature.is_file(), "Updater .sig file is missing")
    minisign = os.environ.get("MINISIGN") or shutil.which("minisign")
    require(minisign, "minisign is required to verify the updater signature")
    for source, name in ((public_key, "updater.pub"), (signature, "updater.sig")):
        require(source.is_file() and source.stat().st_size < 16384, f"Missing or oversized {name}")
        try:
            decoded = base64.b64decode(b"".join(source.read_bytes().split()), validate=True)
        except ValueError as error:
            raise VerificationError(f"{name} is not a Tauri base64 minisign file") from error
        require(decoded.startswith(b"untrusted comment:"), f"Invalid minisign {name}")
        (temp / name).write_bytes(decoded)
    run([str(minisign), "-Vm", str(archive), "-p", str(temp / "updater.pub"),
         "-x", str(temp / "updater.sig")])


def smoke_test(app, executable, bundle_id, arch, temp, screenshot):
    require(platform.machine() == arch, "Smoke test requires a native runner matching the app architecture")
    require(isinstance(bundle_id, str) and re.fullmatch(r"[A-Za-z0-9.-]+", bundle_id), "Invalid bundle identifier")
    profile = temp / "smoke-home"
    profile.mkdir(mode=0o700)
    env = clean_environment()
    env.update({"HOME": str(profile), "CFFIXED_USER_HOME": str(profile),
                "XDG_CONFIG_HOME": str(profile / ".config"), "XDG_DATA_HOME": str(profile / ".local/share"),
                "XDG_CACHE_HOME": str(profile / ".cache"), "XDG_STATE_HOME": str(profile / ".local/state"),
                "TMPDIR": str(profile / "tmp")})
    (profile / "tmp").mkdir(mode=0o700)
    # Confirm the Foundation directory lookup used by Tauri honors our isolated
    # home before ever launching the app. No real profile files are opened.
    foundation_script = temp / "profile-path.swift"
    foundation_script.write_text('import Foundation\nprint(FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].path)\n')
    app_support = Path(run(["/usr/bin/xcrun", "swift", str(foundation_script)], env=env, timeout=180).strip())
    require(app_support.resolve().is_relative_to(profile.resolve()), "macOS ignored the isolated application-support home; refusing launch")
    logfile = temp / "smoke.log"
    result = {"nativeArchitecture": arch, "isolatedProfile": True, "guiInteractionTested": False}
    with logfile.open("wb") as output:
        process = subprocess.Popen([str(executable)], cwd=profile, env=env, stdout=output,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            started = time.monotonic()
            while time.monotonic() - started < 8:
                require(process.poll() is None, f"App exited during smoke test (exit {process.returncode})")
                time.sleep(0.2)
            database = app_support / bundle_id / "racktop.sqlite"
            require(database.is_file(), "App survived but did not initialize its isolated database")
            result["processSurvivedSeconds"] = 8
            result["isolatedDatabaseCreated"] = True
            if screenshot:
                # Capture only this process's window, never the whole desktop.
                window_script = temp / "window-id.swift"
                window_script.write_text('''import CoreGraphics
import Foundation
let pid = Int(CommandLine.arguments[1])!
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for window in windows {
  if (window[kCGWindowOwnerPID as String] as? Int) == pid,
     (window[kCGWindowLayer as String] as? Int) == 0,
     let id = window[kCGWindowNumber as String] as? Int {
    print(id); break
  }
}
''')
                try:
                    window = run(["/usr/bin/xcrun", "swift", str(window_script), str(process.pid)], env=env).strip()
                    require(window.isdigit(), "No app window available to capture")
                    screenshot.parent.mkdir(parents=True, exist_ok=True)
                    run(["/usr/sbin/screencapture", "-x", "-l", window, str(screenshot)], env=env)
                    result["screenshot"] = str(screenshot)
                except (VerificationError, subprocess.TimeoutExpired) as error:
                    result["screenshotUnavailable"] = str(error)
            require(process.poll() is None, "App exited before the smoke test completed")
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
    return result


def verify(args):
    require(sys.platform == "darwin", "Artifact verification must run on macOS; Linux syntax checks are not macOS validation")
    require(not args.notarized or args.signing_mode == "developer-id", "Notarization requires Developer ID signing")
    require(args.dmg.is_file(), "DMG does not exist")
    if args.signing_mode == "ad-hoc":
        require(args.dmg.name.endswith("-unsigned.dmg"), "Ad-hoc DMG must be named -unsigned.dmg")
        if args.updater:
            require(args.updater.name.endswith("-unsigned.app.tar.gz"), "Ad-hoc updater must be named -unsigned.app.tar.gz")
    result = {"version": args.version, "target": args.target, "signingMode": args.signing_mode,
              "notarized": args.notarized, "dmgSha256": sha256(args.dmg), "guiInteractionTested": False}
    run(["/usr/bin/hdiutil", "verify", str(args.dmg)])
    if args.signing_mode == "developer-id":
        run(["/usr/bin/codesign", "--verify", "--verbose=2", str(args.dmg)])
    if args.notarized:
        run(["/usr/bin/xcrun", "stapler", "validate", str(args.dmg)])
        run(["/usr/sbin/spctl", "--assess", "--type", "open", "--context", "context:primary-signature", str(args.dmg)])
    with tempfile.TemporaryDirectory(prefix="racktop-macos-check-") as directory:
        temp = Path(directory).resolve()
        mountpoint = temp / "volume"
        mountpoint.mkdir()
        attached = False
        try:
            run(["/usr/bin/hdiutil", "attach", str(args.dmg), "-readonly", "-nobrowse", "-noautoopen",
                 "-mountpoint", str(mountpoint)])
            attached = True
            require((mountpoint / "Applications").is_symlink()
                    and os.readlink(mountpoint / "Applications") == "/Applications", "DMG is missing the Applications link")
            info, executable, manifest = inspect_app(mountpoint / "RackTop.app", ARCHES[args.target],
                                                     args.version, args.signing_mode, args.notarized)
            result.update({"bundleIdentifier": info["CFBundleIdentifier"], "appEntryCount": len(manifest),
                           "dmgMountedAndVerified": True, "architectureVerified": True, "appSignatureVerified": True})
            if args.updater:
                require(args.updater.is_file(), "Updater archive does not exist")
                verify_updater_signature(args.updater, args.public_key, temp)
                extracted = temp / "updater"
                extracted.mkdir()
                unpack_updater(args.updater, extracted)
                _, _, updater_manifest = inspect_app(extracted / "RackTop.app", ARCHES[args.target],
                                                      args.version, args.signing_mode, args.notarized)
                require(manifest == updater_manifest, "DMG and updater contain different app bytes, symlinks or permissions")
                result.update({"updaterSha256": sha256(args.updater), "updaterSignatureVerified": True,
                               "dmgAndUpdaterAppsIdentical": True})
            if args.smoke:
                result["smoke"] = smoke_test(mountpoint / "RackTop.app", executable,
                                             info["CFBundleIdentifier"], ARCHES[args.target], temp, args.screenshot)
        finally:
            if attached:
                try:
                    run(["/usr/bin/hdiutil", "detach", str(mountpoint)], timeout=60)
                except (VerificationError, subprocess.TimeoutExpired):
                    run(["/usr/bin/hdiutil", "detach", "-force", str(mountpoint)], timeout=60)
    result["passed"] = True
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=ARCHES)
    parser.add_argument("--dmg", required=True, type=Path)
    parser.add_argument("--updater", type=Path)
    parser.add_argument("--public-key", type=Path, default=ROOT / "src-tauri/linux-updater.pub")
    parser.add_argument("--version", required=True)
    parser.add_argument("--signing-mode", choices=("ad-hoc", "developer-id"), default="ad-hoc")
    parser.add_argument("--notarized", action="store_true")
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--screenshot", type=Path)
    args = parser.parse_args()
    for attribute in ("dmg", "updater", "public_key", "report", "screenshot"):
        value = getattr(args, attribute)
        if value:
            setattr(args, attribute, value.resolve())
    try:
        result = verify(args)
    except (VerificationError, OSError, ValueError, tarfile.TarError, subprocess.TimeoutExpired) as error:
        result = {"passed": False, "error": str(error), "guiInteractionTested": False}
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
