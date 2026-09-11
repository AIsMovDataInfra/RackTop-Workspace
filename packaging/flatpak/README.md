# Flatpak compatibility build

The Flatpak runs RackTop with the GNOME 50 runtime, which supplies WebKitGTK 4.1 and its C library independently of the host distribution. The native Debian package remains a separate build. A normal Ubuntu 22.04 AppImage still depends on a newer host glibc than Ubuntu 20.04 provides.

On a Linux x86_64 build machine, install `flatpak`, `flatpak-builder` and the normal RackTop Debian build prerequisites, then prepare the runtime:

```sh
flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user -y flathub org.gnome.Platform//50 org.gnome.Sdk//50
npm ci
bash scripts/package-linux.sh
bash scripts/package-flatpak.sh src-tauri/target/release/bundle/deb/RackTop_X.Y.Z_linux-amd64.deb
```

Use the actual current version in the final command. An optional second argument selects the output directory. The script checks the input Debian package name, version and architecture, stages its RackTop executable, and builds the pinned OpenSSH client and Ayatana tray libraries in the GNOME SDK. It retains third-party license files and tests dependency resolution, SSH key generation and the RackTop password helper against the **Platform** runtime before exporting. This build check does not replace an Ubuntu 20.04 desktop launch, keyring, connection and terminal acceptance test.

For Ubuntu 20.04 with stock Flatpak 1.6.5, use the offline runtime kit described in [the Linux guide](../../docs/LINUX.md). Its client can run GNOME 50 but cannot read today's Flathub summary, which exceeds its 10 MiB limit. Build that kit from the verified application bundle with `scripts/package-flatpak-runtime.sh RACKTOP.flatpak OUTPUT_DIRECTORY`. The kit includes GNOME 50 and the two Mesa GL.default extensions, verifies local SHA-256 checksums, and installs with `--no-deps --no-related` without network lookup. Existing runtime deployments are preserved.

Install a downloaded application bundle using a current Flatpak installation:

```sh
flatpak install --user ./RackTop_X.Y.Z_linux-amd64.flatpak
flatpak run com.racktop.desktop
```

The application bundle identifies Flathub as its runtime source. Its online first installation downloads GNOME and graphics runtimes. This repository does not publish an application update remote on Flathub: install the next RackTop `.flatpak` bundle to update RackTop. `flatpak update` updates runtimes installed from Flathub; the offline kit's runtimes have no update remote and must be replaced explicitly using the local bundle commands in the Linux guide. Its installer preserves existing runtimes. The in-app Debian installer is unavailable in this package.

## Host integration and limits

The intltool Perl compatibility patch is retained from [Flathub shared-modules](https://github.com/flathub/shared-modules/blob/master/intltool/intltool-perl5.26-regex-fixes.patch), with its original authors and upstream bug references. The old libdbusmenu configure script also needs its disabled Valgrind test conditional supplied explicitly; its C compiler mode is fixed to GNU C17 for current SDK compilers.

- RackTop's bundled `ssh`, `ssh-keygen` and `ssh-keyscan` run inside the Flatpak. Integrated PTYs, the `SSH_ASKPASS` helper and the independent password jump helper all see the same `/app/bin/racktop` executable. The host SSH agent socket is exposed through `ssh-auth`.
- The host filesystem permission preserves user-selected local project directories, mounted drives and `~/.ssh` access. Flatpak's reserved system paths, including `/usr` and `/etc`, still belong to its runtime. Host `/etc/ssh/ssh_config` and arbitrary host-only `ProxyCommand` programs are not automatically available; keep supported per-user SSH configuration in `~/.ssh/config` and use direct SSH or `ProxyJump` where possible.
- Secret Service, notifications and tray access use named D-Bus permissions. A running host Secret Service such as GNOME Keyring is required to save credentials.
- Only the explicit “open setup terminal” action invokes `flatpak-spawn --host x-terminal-emulator`. This requires the named Flatpak D-Bus permission and a terminal plus OpenSSH installed on the host. The wrapper forwards each argument unchanged. Normal monitoring and integrated SSH terminals use the bundled SSH client.
- Flatpak stores application data under `~/.var/app/com.racktop.desktop/data/com.racktop.desktop/`. It does not automatically copy or overwrite a Debian installation's database. Stop both applications and back up their data before any manual migration. SSH keys and Secret Service entries remain host resources.
- The runtime does not replace the host kernel, display server or graphics driver. Validate both X11 and Wayland where support is claimed, along with saved passwords, host-key trust, direct/jump SSH, the integrated terminal, project transfers and application restart.

Dependency archives are pinned by SHA-256. Runtime maintenance comes from GNOME/Flathub; update the pinned OpenSSH and Ayatana source versions when their upstream releases require it. Primary references: [Tauri Flatpak packaging](https://v2.tauri.app/distribute/flatpak/), [Flatpak permissions](https://docs.flatpak.org/en/latest/sandbox-permissions.html), [GNOME 50 runtime components](https://gitlab.gnome.org/GNOME/gnome-build-meta/-/blob/gnome-50/elements/sdk-platform.bst), [OpenSSH Portable](https://www.openssh.org/portable.html).

The manifest disables legacy automatic AppStream composition because Ubuntu 22.04 flatpak-builder expects `appstream-compose`, which GNOME 50 replaced with `appstreamcli`. The local bundle still includes its desktop launcher, icon and versioned metainfo; this workflow does not publish a Flathub catalog. CMake library directories are explicitly `/app/lib` so dependent tray modules and the runtime loader find them.
