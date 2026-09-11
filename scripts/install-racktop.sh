#!/usr/bin/env bash
# Install published binaries only. Run as the desktop user, not with sudo.
set -euo pipefail

racktop_fail() { printf 'RackTop：%s\n' "$*" >&2; return 1; }
racktop_download() {
  curl --fail --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 20 --retry 2 --output "$2" "$1"
}

racktop_ubuntu() {
  python3 - "$1" "$2" <<'PY'
import pathlib, shlex, sys
values = {}
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    if '=' in line and not line.startswith('#'):
        key, value = line.split('=', 1)
        parts = shlex.split(value)
        if len(parts) == 1:
            values[key] = parts[0]
if sys.argv[2] != 'x86_64' or values.get('ID') != 'ubuntu' or values.get('VERSION_ID') not in ('20.04', '22.04'):
    sys.exit('统一安装器目前支持 Ubuntu 20.04 / 22.04 的 Intel / AMD 64 位电脑。')
print(values['VERSION_ID'])
PY
}

racktop_flatpak_scope() {
  local user_commit='' system_commit=''
  if command -v flatpak >/dev/null 2>&1; then
    user_commit="$(flatpak info --user --show-commit com.racktop.desktop//stable 2>/dev/null || true)"
    system_commit="$(flatpak info --system --show-commit com.racktop.desktop//stable 2>/dev/null || true)"
  fi
  if [[ -n "$user_commit" && -n "$system_commit" ]]; then
    racktop_fail '检测到用户级和系统级两个 RackTop，请先确认要保留的安装范围。'; return 1
  fi
  if [[ -n "$system_commit" ]]; then printf 'system\n';
  elif [[ -n "$user_commit" ]]; then printf 'user\n';
  else printf 'none\n'; fi
}

racktop_read_feed() {
  python3 - "$1" "$2" <<'PY'
import json, re, sys
try:
    feed = json.load(open(sys.argv[1]))
    version = feed['version']
    if not isinstance(version, str) or not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
        raise ValueError('版本号无效')
    kind = sys.argv[2]
    entry = feed['platforms']['linux-x86_64-' + kind]
    base = 'https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v' + version
    name = 'RackTop_' + version + '_linux-amd64.' + kind
    if entry['url'] != base + '/' + name:
        raise ValueError('下载地址与发布版本不匹配')
    commit = entry.get('commit', '')
    if kind == 'flatpak' and not re.fullmatch(r'[a-f0-9]{64}', commit):
        raise ValueError('此发布尚未提供统一 Flatpak 安装信息')
    print(version)
    print(base)
    print(name)
    print(commit)
except (KeyError, ValueError, TypeError):
    sys.exit('发布清单尚未就绪或格式无效，请查看下载页，稍后重试。')
PY
}

racktop_check_download() {
  python3 - "$1" "$2" <<'PY'
import hashlib, pathlib, re, sys
checksums, package = map(pathlib.Path, sys.argv[1:])
expected = []
for line in checksums.read_text().splitlines():
    match = re.fullmatch(r'([a-fA-F0-9]{64}) [ *](.+)', line)
    if match and match[2] in (package.name, './' + package.name):
        expected.append(match[1].lower())
if len(expected) != 1:
    sys.exit('发布校验清单中缺少唯一的安装包摘要。')
digest = hashlib.sha256()
with package.open('rb') as source:
    for block in iter(lambda: source.read(1024 * 1024), b''):
        digest.update(block)
if digest.hexdigest() != expected[0]:
    sys.exit('安装包 SHA-256 校验失败，已停止安装。请重新下载。')
PY
}

racktop_extract_kit() {
  python3 - "$1" "$2" "$3" <<'PY'
import pathlib, sys, tarfile
archive, destination, version = sys.argv[1:]
expected = 'RackTop_' + version + '_flatpak_offline'
with tarfile.open(archive, 'r:gz') as source:
    members = source.getmembers()
    if not members or len(members) > 256 or sum(item.size for item in members) > 4 * 1024**3:
        sys.exit('运行时套件大小或内容无效。')
    paths = set()
    for item in members:
        path = pathlib.PurePosixPath(item.name)
        if (path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != expected
                or not (item.isfile() or item.isdir()) or item.name in paths):
            sys.exit('运行时套件含无效路径或文件，已停止安装。')
        paths.add(item.name)
    source.extractall(destination, members=members)
PY
}

racktop_runtime_present() {
  command -v flatpak >/dev/null 2>&1 && flatpak info "--$1" "$2/x86_64/$3" >/dev/null 2>&1
}

racktop_flatpak_install() {
  local scope="$1"; shift
  if [[ "$scope" == system ]]; then
    sudo /usr/bin/flatpak install --system --noninteractive --bundle --no-deps --no-related "$@"
  else
    flatpak install --user --noninteractive --bundle --no-deps --no-related "$@"
  fi
}

racktop_check_installed_flatpak() {
  local scope="$1" version="$2" wanted="$3" current metadata
  current="$(flatpak info "--$scope" --show-commit com.racktop.desktop//stable 2>/dev/null || true)"
  [[ -n "$current" ]] || return 0
  metadata="$(flatpak info "--$scope" --show-metadata com.racktop.desktop//stable)" || {
    racktop_fail '无法读取已安装 Flatpak 的元数据，已停止，避免覆盖现有安装。'; return 1
  }
  python3 - "$version" "$wanted" "$current" 3<<< "$metadata" <<'PY'
import configparser, os, re, sys
def version(value):
    if not isinstance(value, str) or not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', value):
        raise ValueError('版本号无效')
    return tuple(map(int, value.split('.')))
try:
    target, wanted, current = sys.argv[1:]
    candidate = version(target)
    if not all(re.fullmatch(r'[a-f0-9]{64}', value) for value in (wanted, current)):
        raise ValueError('commit 无效')
    metadata = configparser.ConfigParser(interpolation=None)
    with os.fdopen(3) as source:
        metadata.read_file(source)
    if (metadata.defaults() or metadata.get('Application', 'name') != 'com.racktop.desktop'
            or metadata.get('Application', 'runtime') != 'org.gnome.Platform/x86_64/50'):
        raise ValueError('应用身份或运行时不匹配')
    # The 2.2.2 compatibility bundle predates our version metadata. Allow its
    # initial upgrade; all new published bundles carry this section afterwards.
    if not metadata.has_section('X-RackTop Update'):
        sys.exit(0)
    installed = version(metadata.get('X-RackTop Update', 'version'))
    if installed > candidate:
        sys.exit('本机 Flatpak 版本比发布清单更新，已停止，避免降级。')
    if installed == candidate and current != wanted:
        sys.exit('本机 Flatpak 与发布清单版本相同但 commit 不同，已停止，避免覆盖其他构建。')
except (configparser.Error, ValueError, TypeError):
    sys.exit('已安装 Flatpak 的版本或身份信息无效，已停止，避免覆盖其他构建。')
PY
}

racktop_install_bundle() {
  local scope="$1" bundle="$2" wanted="$3" version="$4" current
  # Recheck after downloading or installing missing runtimes: another updater
  # may have installed a newer deployment while those operations were running.
  racktop_check_installed_flatpak "$scope" "$version" "$wanted"
  current="$(flatpak info "--$scope" --show-commit com.racktop.desktop//stable 2>/dev/null || true)"
  # Flatpak 1.6 rejects identical bundle commits, even with --or-update.
  if [[ "$current" != "$wanted" ]]; then
    racktop_flatpak_install "$scope" --or-update "$bundle"
  fi
  current="$(flatpak info "--$scope" --show-commit com.racktop.desktop//stable)"
  [[ "$current" == "$wanted" ]] || racktop_fail '安装后的 Flatpak 版本与发布清单不一致。'
}

racktop_install_main() {
  if [[ "${1:-}" == '--help' ]]; then
    printf '用法：bash install-racktop.sh\n支持 Ubuntu 20.04 / 22.04 amd64。Mac 请在 https://136.0.110.161/downloads/ 下载对应 DMG。\n'; return
  fi
  [[ $# == 0 ]] || { racktop_fail '未知参数；运行 bash install-racktop.sh --help 查看帮助。'; return 1; }
  [[ "$EUID" != 0 ]] || { racktop_fail '请使用普通桌面用户运行，不要在整个脚本前加 sudo。'; return 1; }
  [[ "$(uname -s)" == Linux ]] || { racktop_fail 'Mac 请在 https://136.0.110.161/downloads/ 下载对应芯片的 DMG。'; return 1; }
  for tool in curl python3 sha256sum; do
    command -v "$tool" >/dev/null || { racktop_fail "缺少 $tool，请先运行 sudo apt install curl python3，再重试。"; return 1; }
  done
  local ubuntu scope kind='deb'
  ubuntu="$(racktop_ubuntu /etc/os-release "$(uname -m)")"
  scope="$(racktop_flatpak_scope)"
  if [[ "$ubuntu" == 20.04 || "$scope" != none ]]; then kind='flatpak'; fi
  [[ "$scope" != none ]] || scope='user'
  if command -v pgrep >/dev/null && pgrep -u "$(id -u)" -x racktop >/dev/null; then
    racktop_fail '请先从 RackTop 菜单退出程序，再重新运行安装器。'; return 1
  fi
  umask 077
  racktop_install_work="$(mktemp -d "${TMPDIR:-/tmp}/racktop-install.XXXXXXXX")"
  trap 'rm -rf -- "$racktop_install_work"' EXIT
  local feed="$racktop_install_work/feed.json" parsed version base package commit
  printf '正在读取 RackTop 发布信息…\n'
  racktop_download 'https://raw.githubusercontent.com/AIsMovDataInfra/RackTop-Workspace/updater/linux-amd64.json' "$feed"
  parsed="$(racktop_read_feed "$feed" "$kind")"
  { read -r version; read -r base; read -r package; read -r commit || true; } <<< "$parsed"
  if [[ "$kind" == flatpak ]]; then racktop_check_installed_flatpak "$scope" "$version" "$commit"; fi
  racktop_download "$base/SHA256SUMS" "$racktop_install_work/SHA256SUMS"
  printf '安装 RackTop %s（Ubuntu %s，%s）\n' "$version" "$ubuntu" "$kind"
  if [[ "$kind" == deb ]]; then
    local installed
    installed="$(dpkg-query -W -f='${Version}' rack-top 2>/dev/null || true)"
    if [[ -n "$installed" ]] && dpkg --compare-versions "$installed" gt "$version"; then
      racktop_fail '本机 DEB 版本比发布清单更新，已停止，避免降级。'; return 1
    fi
    racktop_download "$base/$package" "$racktop_install_work/$package"
    racktop_check_download "$racktop_install_work/SHA256SUMS" "$racktop_install_work/$package"
    sudo apt install -- "$racktop_install_work/$package"
    printf '\n安装完成。请从应用菜单打开 RackTop。\n'
    return
  fi
  local need_kit=0 runtime branch
  for spec in 'org.gnome.Platform 50' 'org.freedesktop.Platform.GL.default 25.08' 'org.freedesktop.Platform.GL.default 25.08-extra'; do
    read -r runtime branch <<< "$spec"
    racktop_runtime_present "$scope" "$runtime" "$branch" || need_kit=1
  done
  if [[ "$need_kit" == 0 ]]; then
    local current
    current="$(flatpak info "--$scope" --show-commit com.racktop.desktop//stable 2>/dev/null || true)"
    if [[ "$current" == "$commit" ]]; then
      printf '已安装此发布版本，原资料保持不变。\n'; return
    fi
    racktop_download "$base/$package" "$racktop_install_work/$package"
    racktop_check_download "$racktop_install_work/SHA256SUMS" "$racktop_install_work/$package"
    racktop_install_bundle "$scope" "$racktop_install_work/$package" "$commit" "$version"
  else
    local archive="RackTop_${version}_linux-amd64-flatpak-offline.tar.gz" kit
    printf '首次安装或缺少运行时，将下载完整兼容套件…\n'
    racktop_download "$base/$archive" "$racktop_install_work/$archive"
    racktop_check_download "$racktop_install_work/SHA256SUMS" "$racktop_install_work/$archive"
    racktop_extract_kit "$racktop_install_work/$archive" "$racktop_install_work" "$version"
    kit="$racktop_install_work/RackTop_${version}_flatpak_offline"
    (cd "$kit" && sha256sum --check SHA256SUMS)
    [[ "$(cat "$kit/APP-COMMIT.txt")" == "$commit" ]] || { racktop_fail '套件版本与发布清单不一致。'; return 1; }
    if ! command -v flatpak >/dev/null; then sudo apt update; sudo apt install flatpak; fi
    for spec in 'org.gnome.Platform 50' 'org.freedesktop.Platform.GL.default 25.08' 'org.freedesktop.Platform.GL.default 25.08-extra'; do
      read -r runtime branch <<< "$spec"
      if ! racktop_runtime_present "$scope" "$runtime" "$branch"; then
        racktop_flatpak_install "$scope" "$kit/${runtime}_${branch}_x86_64.flatpak"
      fi
    done
    racktop_install_bundle "$scope" "$kit/$package" "$commit" "$version"
  fi
  printf '\n安装完成。原资料保留。启动：flatpak run --%s com.racktop.desktop\n' "$scope"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then racktop_install_main "$@"; fi
