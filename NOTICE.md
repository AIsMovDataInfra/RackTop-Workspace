# 来源与修改说明 / Attribution and Modifications

RackTop 原项目 / Original project: https://github.com/Tongzh-SEU/RackTop

原作者 / Original author: Tongzh-SEU and upstream contributors.

本 fork 当前维护者 / Current maintainer of this fork: AIsMov.

维护组织与仓库 / Organization and repository: AIsMovDataInfra — https://github.com/AIsMovDataInfra/RackTop

AIsMov is responsible for ongoing maintenance, feature development, issue handling and Linux/macOS distribution of this fork. This maintenance role is separate from the original authorship credited above.

This fork is based on upstream v1.25.4, commit `dcc2dc2fcc8a13ec8abc60a5086c03fef3ad0ff5`. Original copyright notices, Git history and the GPL-3.0 license are retained. No endorsement by the upstream author is implied. Third-party components retain their own licenses.

Changes made on 2026-09-06 and 2026-09-07 add Linux platform detection, native decorated windows, Secret Service credential storage, Debian packaging, Ubuntu CI checks, Linux release links, tests and documentation. Subsequent changes in this fork include separate target-server and jump-host passwords, signed Linux package updates, SSH connection configuration import/export, and local SSH key discovery, generation and management. Imported keys remain in their original files; removing a key from the management list preserves its files and server configuration. The detailed record is in `docs/VERSION_INFOS.md`; Git diffs identify the modified files. Windows downloads remain linked to official upstream releases. The initial Linux releases also linked upstream macOS downloads; this fork begins distributing its own macOS packages with version 1.27.0.

The corresponding source, dependency lockfiles and build scripts are included in the repository and each release's source archive. See `docs/LINUX.md` and `docs/MACOS.md` for reproducible build instructions and `LICENSE` for redistribution terms.

Changes made on 2026-09-08 add a separate team reservation web application, SQLite-backed whole-machine and GPU scheduling, Feishu authentication and optional group notifications, deployment materials, and related tests. This feature remains independent of the desktop monitoring and local SSH key store.

Changes made on 2026-09-08 for version 1.27.0 add native Apple Silicon and Intel macOS DMG packages, a separate signed Mac update channel, and Mac support for independent SSH jump-host passwords. These builds retain the community sharing gateway, invitation-based guest access, and online team reservation features. Without an Apple Developer ID certificate, packages are explicitly labeled as ad-hoc signed and not notarized.
