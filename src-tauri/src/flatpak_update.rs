//! Flatpak keeps deployments outside the sandbox. Only verified application
//! bundles are handed to its host installer; runtimes and app data are retained.
use glib::{Bytes, KeyFile, KeyFileFlags, Variant, VariantDict, VariantTy};
use std::{ffi::{OsStr, OsString}, future::Future, path::{Path, PathBuf}, process::{Output, Stdio}, time::Duration};
use tokio::process::Command;

pub const TARGET: &str = "linux-x86_64-flatpak";
pub const APP_REF: &str = "app/com.racktop.desktop/x86_64/stable";
const RUNTIME: &str = "org.gnome.Platform/x86_64/50";
// OSTree's documented static-delta superblock, also used by Flatpak 1.6.5.
const BUNDLE_TYPE: &str = "(a{sv}tayay(a{sv}aya(say)sstayay)aya(uayttay)a(yaytt))";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Scope { User, System }
impl Scope {
    pub fn argument(self) -> &'static str { match self { Self::User => "--user", Self::System => "--system" } }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bundle { pub commit: String, pub version: String }

#[derive(Clone, Debug)]
pub struct Installation {
    pub scope: Scope,
    pub instance_path: PathBuf,
    pub initial_commit: String,
}

fn key_file(text: &str) -> Result<KeyFile, String> {
    let file = KeyFile::new();
    file.load_from_data(text, KeyFileFlags::NONE).map_err(|_| "Flatpak 元数据格式无效")?;
    Ok(file)
}

fn value(file: &KeyFile, group: &str, key: &str) -> Result<String, String> {
    file.string(group, key).map(|s| s.to_string()).map_err(|_| format!("Flatpak 元数据缺少 {group}/{key}"))
}

fn version_from_metadata(text: &str) -> Result<String, String> {
    let metadata = key_file(text)?;
    if value(&metadata, "Application", "name")? != "com.racktop.desktop"
        || value(&metadata, "Application", "runtime")?.trim_start_matches("runtime/") != RUNTIME {
        return Err("Flatpak 应用标识或运行时不匹配，已停止更新".into());
    }
    let version = value(&metadata, "X-RackTop Update", "version")?;
    let parsed = semver::Version::parse(&version).map_err(|_| "Flatpak 版本号无效")?;
    if !parsed.pre.is_empty() || !parsed.build.is_empty() { return Err("Flatpak 更新版本必须为正式版本号".into()); }
    Ok(version)
}

/// Call only after the complete bundle has passed the embedded public-key check.
/// GLib's checked parser reads the same ref/metadata/commit as Flatpak itself.
pub fn validate_bundle(bytes: &[u8], expected_version: &str) -> Result<Bundle, String> {
    let kind = VariantTy::new(BUNDLE_TYPE).map_err(|_| "Flatpak 验证类型无效")?;
    let variant = Variant::from_bytes_with_type(&Bytes::from(bytes), kind);
    if !variant.is_normal_form() { return Err("Flatpak 安装包格式无效".into()); }
    let metadata = VariantDict::new(Some(&variant.child_value(0)));
    let reference = metadata.lookup::<String>("ref").map_err(|_| "Flatpak ref 格式无效")?.ok_or("Flatpak 安装包缺少 ref")?;
    if reference != APP_REF { return Err("Flatpak 安装包名称、架构或分支不匹配".into()); }
    let text = metadata.lookup::<String>("metadata").map_err(|_| "Flatpak metadata 格式无效")?.ok_or("Flatpak 安装包缺少 metadata")?;
    let version = version_from_metadata(&text)?;
    if version != expected_version { return Err("Flatpak 安装包版本与更新清单不匹配".into()); }
    let checksum = variant.child_value(3).get::<Vec<u8>>().ok_or("Flatpak commit 格式无效")?;
    if checksum.len() != 32 { return Err("Flatpak commit 长度无效".into()); }
    // The embedded commit must actually hash to the bundle's target commit.
    use sha2::{Digest, Sha256};
    let commit_bytes = variant.child_value(4).data_as_bytes();
    if Sha256::digest(commit_bytes.as_ref()).as_slice() != checksum { return Err("Flatpak commit 校验失败".into()); }
    let commit = checksum.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(Bundle { commit, version })
}

fn host_command(watch_bus: bool) -> Command {
    let mut command = Command::new("/usr/bin/flatpak-spawn");
    // --host inherits the host session environment. Do not forward the sandbox's
    // XDG_DATA_HOME, which would select a different Flatpak user installation.
    command.args(["--host", "--directory=/"]);
    if watch_bus { command.arg("--watch-bus"); }
    command.args(["--env=PATH=/usr/bin:/bin", "--env=LC_ALL=C.UTF-8",
        "/usr/bin/env", "-u", "LD_LIBRARY_PATH", "-u", "LD_PRELOAD", "-u", "PYTHONHOME", "-u", "PYTHONPATH",
        "/usr/bin/flatpak"]);
    command.stdin(Stdio::null()).kill_on_drop(true);
    command
}

async fn output<I, S>(args: I, timeout: Duration) -> Result<Output, String>
where I: IntoIterator<Item = S>, S: AsRef<OsStr> {
    let mut command = host_command(true);
    command.args(args);
    tokio::time::timeout(timeout, command.output()).await
        .map_err(|_| "宿主 Flatpak 命令超时，请确认系统安装状态后重试")?
        .map_err(|error| format!("无法调用宿主 Flatpak：{error}"))
}

trait Host: Sync {
    fn run(&self, args: Vec<OsString>, timeout: Duration) -> impl Future<Output = Result<Output, String>> + Send;
}
struct HostBridge;
impl Host for HostBridge {
    fn run(&self, args: Vec<OsString>, timeout: Duration) -> impl Future<Output = Result<Output, String>> + Send { output(args, timeout) }
}

fn checked_text(output: Output) -> Result<String, String> {
    if !output.status.success() {
        return Err(format!("宿主 Flatpak 操作失败：{}", String::from_utf8_lossy(&output.stderr).chars().take(1500).collect::<String>()));
    }
    String::from_utf8(output.stdout).map(|s| s.trim().to_owned()).map_err(|_| "宿主 Flatpak 返回无效文本".into())
}

fn select_scope(app_path: &Path, locations: &[(Scope, PathBuf)]) -> Result<Scope, String> {
    let matched: Vec<_> = locations.iter().filter(|(_, path)| path.is_absolute() && path.join("files") == app_path).collect();
    match matched.as_slice() {
        [(scope, _)] => Ok(*scope),
        _ => Err("无法定位当前 Flatpak 安装，或应用已被其他进程更新。请关闭后重新打开；自定义系统安装请使用原安装方式更新。".into()),
    }
}

pub async fn detect() -> Result<Installation, String> {
    let text = std::fs::read_to_string("/.flatpak-info").map_err(|e| e.to_string())?;
    let (app_path, instance_path, initial_commit) = {
        let instance = key_file(&text)?;
        if value(&instance, "Application", "name")? != "com.racktop.desktop"
            || value(&instance, "Instance", "arch")? != "x86_64"
            || value(&instance, "Instance", "branch")? != "stable" {
            return Err("当前 Flatpak 应用、架构或分支不支持此更新通道".into());
        }
        (PathBuf::from(value(&instance, "Instance", "app-path")?),
         PathBuf::from(value(&instance, "Instance", "instance-path")?),
         value(&instance, "Instance", "app-commit")?)
    };
    if !app_path.is_absolute() || !instance_path.is_absolute() || !valid_commit(&initial_commit) {
        return Err("当前 Flatpak 安装路径或 commit 无效".into());
    }
    checked_text(output(["--version"], Duration::from_secs(20)).await?)?;
    let mut locations = Vec::new();
    for scope in [Scope::User, Scope::System] {
        let result = output(["info", scope.argument(), "--show-location", APP_REF], Duration::from_secs(20)).await?;
        if result.status.success() { locations.push((scope, PathBuf::from(checked_text(result)?))); }
    }
    let scope = select_scope(&app_path, &locations)?;
    Ok(Installation { scope, instance_path, initial_commit })
}

fn valid_commit(commit: &str) -> bool { commit.len() == 64 && commit.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) }

pub async fn installed(scope: Scope) -> Result<Bundle, String> {
    installed_with(&HostBridge, scope).await
}

async fn installed_with(host: &impl Host, scope: Scope) -> Result<Bundle, String> {
    let metadata = checked_text(host.run(["info", scope.argument(), "--show-metadata", APP_REF].map(OsString::from).into(), Duration::from_secs(20)).await?)?;
    let version = version_from_metadata(&metadata)?;
    let commit = checked_text(host.run(["info", scope.argument(), "--show-commit", APP_REF].map(OsString::from).into(), Duration::from_secs(20)).await?)?;
    if !valid_commit(&commit) { return Err("已安装 Flatpak commit 无效".into()); }
    Ok(Bundle { version, commit })
}

fn require_unchanged(actual: &Bundle, original: &Bundle) -> Result<(), String> {
    if actual != original { return Err("Flatpak 已被其他进程更新，请关闭后重新打开 RackTop".into()); }
    Ok(())
}

impl Installation {
    pub fn temporary_directory(&self) -> Result<tempfile::TempDir, String> {
        use std::os::unix::fs::PermissionsExt;
        // instance-path is the host-visible ~/.var/app/APP_ID path recorded by
        // Flatpak. Its cache is shared with the host, unlike sandbox /tmp.
        let cache = self.instance_path.join("cache");
        std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
        tempfile::Builder::new().prefix("racktop-update-").permissions(std::fs::Permissions::from_mode(0o700)).tempdir_in(cache).map_err(|e| e.to_string())
    }

    pub async fn before_update(&self, version: &str) -> Result<Bundle, String> {
        let actual = installed(self.scope).await?;
        if actual.commit != self.initial_commit { return Err("Flatpak 部署已变化，请重新打开 RackTop 再检查更新".into()); }
        let url = format!("https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v{version}/RackTop_{version}_linux-amd64.flatpak");
        super::linux_update::validate_flatpak_release(version, &url, &actual.version)?;
        Ok(actual)
    }

    pub async fn install(&self, path: &Path, bundle: &Bundle, previous: &Bundle) -> Result<(), String> {
        self.install_with(&HostBridge, path, bundle, previous).await
    }

    async fn install_with(&self, host: &impl Host, path: &Path, bundle: &Bundle, previous: &Bundle) -> Result<(), String> {
        require_unchanged(&installed_with(host, self.scope).await?, previous)?;
        // --noninteractive disables polkit authorization in Flatpak 1.6.5.
        // System deployments must allow the desktop agent to request permission.
        let confirmation = if self.scope == Scope::System { "--assumeyes" } else { "--noninteractive" };
        let mut args: Vec<OsString> = ["install", self.scope.argument(), confirmation, "--bundle", "--no-deps", "--no-related", "--or-update"].map(OsString::from).into();
        args.push(path.as_os_str().into());
        checked_text(host.run(args, Duration::from_secs(600)).await?)?;
        if installed_with(host, self.scope).await? != *bundle { return Err("安装命令已结束，但 Flatpak 版本或 commit 未匹配，请重新检查后重试".into()); }
        Ok(())
    }

    pub async fn relaunch(&self, bundle: &Bundle) -> Result<(), String> {
        if installed(self.scope).await? != *bundle { return Err("Flatpak 部署已变化，请使用原安装范围手动打开 RackTop".into()); }
        // No --watch-bus: the new deployment must survive the old app's exit.
        let mut command = host_command(false);
        command.args(["run", self.scope.argument(), APP_REF]).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(false);
        let mut child = command.spawn().map_err(|e| format!("更新已安装，请手动打开 RackTop：{e}"))?;
        tokio::time::sleep(Duration::from_millis(600)).await;
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if !status.success() { return Err("更新已安装，但自动启动失败。请手动打开 RackTop。".into()); }
        }
        // Reap flatpak-spawn if this process stays alive, without keeping it alive.
        tokio::spawn(async move { let _ = child.wait().await; });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use glib::variant::ToVariant;

    fn bundle(reference: &str, metadata: &str) -> Vec<u8> {
        let dict = VariantDict::new(None);
        dict.insert("ref", reference);
        dict.insert("metadata", metadata);
        let commit = (VariantDict::new(None), Vec::<u8>::new(), Vec::<(String, Vec<u8>)>::new(), "", "", 0u64, vec![0u8; 32], vec![0u8; 32]).to_variant();
        use sha2::{Digest, Sha256};
        let checksum = Sha256::digest(commit.data_as_bytes().as_ref()).to_vec();
        Variant::tuple_from_iter([dict.end(), 0u64.to_variant(), Vec::<u8>::new().to_variant(), checksum.to_variant(), commit,
            Vec::<u8>::new().to_variant(), Vec::<(u32, Vec<u8>, u64, u64, Vec<u8>)>::new().to_variant(), Vec::<(u8, Vec<u8>, u64, u64)>::new().to_variant()]).data_as_bytes().as_ref().to_vec()
    }
    fn metadata(version: &str) -> String { format!("[Application]\nname=com.racktop.desktop\nruntime={RUNTIME}\n[X-RackTop Update]\nversion={version}\n") }

    #[test]
    fn verifies_bundle_identity_and_version_before_installation() {
        let valid = bundle(APP_REF, &metadata("2.5.0"));
        assert_eq!(validate_bundle(&valid, "2.5.0").unwrap().version, "2.5.0");
        assert!(validate_bundle(&valid, "2.6.0").unwrap_err().contains("版本"));
        for wrong in ["app/com.other.app/x86_64/stable", "app/com.racktop.desktop/aarch64/stable", "app/com.racktop.desktop/x86_64/beta", "runtime/com.racktop.desktop/x86_64/stable"] {
            assert!(validate_bundle(&bundle(wrong, &metadata("2.5.0")), "2.5.0").is_err());
        }
        assert!(validate_bundle(&bundle(APP_REF, &metadata("2.5.0-beta")), "2.5.0-beta").is_err());
        assert!(validate_bundle(&bundle(APP_REF, &metadata("2.5.0").replace("/50", "/51")), "2.5.0").is_err());
        for invalid in [b"".as_slice(), b"not a Flatpak", &valid[..valid.len()/2]] { assert!(validate_bundle(invalid, "2.5.0").is_err()); }
    }

    #[test]
    fn keeps_running_scope_even_when_other_scope_is_also_installed() {
        let user = PathBuf::from("/home/user/.local/share/flatpak/app/id/commit");
        let system = PathBuf::from("/var/lib/flatpak/app/id/commit");
        let locations = [(Scope::User, user.clone()), (Scope::System, system.clone())];
        assert_eq!(select_scope(&user.join("files"), &locations).unwrap(), Scope::User);
        assert_eq!(select_scope(&system.join("files"), &locations).unwrap(), Scope::System);
        assert!(select_scope(Path::new("/old/deployment/files"), &locations).is_err());
        assert!(select_scope(&user.join("files"), &[(Scope::User, user.clone()), (Scope::System, user)]).is_err());
    }

    #[test]
    fn update_staging_is_host_visible_and_private() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let install = Installation { scope: Scope::User, instance_path: root.path().into(), initial_commit: "a".repeat(64) };
        let temp = install.temporary_directory().unwrap();
        assert_eq!(temp.path().parent().unwrap(), root.path().join("cache"));
        assert_eq!(temp.path().metadata().unwrap().permissions().mode() & 0o777, 0o700);
    }

    #[test]
    fn another_deployment_cannot_be_overwritten_by_an_old_process() {
        let before = Bundle { commit: "a".repeat(64), version: "2.5.0".into() };
        assert!(require_unchanged(&before, &before).is_ok());
        assert!(require_unchanged(&Bundle { commit: "b".repeat(64), version: "2.6.0".into() }, &before).is_err());
    }

    #[test]
    fn host_bridge_uses_fixed_commands_and_relaunch_survives_old_app() {
        let install = host_command(true);
        assert_eq!(install.as_std().get_program(), "/usr/bin/flatpak-spawn");
        let args: Vec<_> = install.as_std().get_args().collect();
        assert!(args.contains(&OsStr::new("--host")));
        assert!(args.contains(&OsStr::new("--watch-bus")));
        assert!(args.contains(&OsStr::new("/usr/bin/flatpak")));
        assert!(!args.contains(&OsStr::new("sh")));
        assert!(!host_command(false).as_std().get_args().any(|s| s == "--watch-bus"));
    }

    struct FakeHost {
        calls: std::sync::Mutex<Vec<Vec<OsString>>>,
        responses: std::sync::Mutex<std::collections::VecDeque<Result<Output, String>>>,
    }
    impl FakeHost {
        fn new(responses: Vec<Result<Output, String>>) -> Self { Self { calls: Default::default(), responses: std::sync::Mutex::new(responses.into()) } }
    }
    impl Host for FakeHost {
        fn run(&self, args: Vec<OsString>, _: Duration) -> impl Future<Output = Result<Output, String>> + Send {
            self.calls.lock().unwrap().push(args);
            let response = self.responses.lock().unwrap().pop_front().expect("unexpected host command");
            std::future::ready(response)
        }
    }
    fn success(text: &str) -> Result<Output, String> {
        use std::os::unix::process::ExitStatusExt;
        Ok(Output { status: std::process::ExitStatus::from_raw(0), stdout: text.as_bytes().into(), stderr: vec![] })
    }
    fn installation(scope: Scope) -> Installation { Installation { scope, instance_path: "/home/user/.var/app/com.racktop.desktop".into(), initial_commit: "a".repeat(64) } }

    #[tokio::test]
    async fn successful_install_preserves_scope_and_checks_new_deployment() {
        for scope in [Scope::User, Scope::System] {
            let before = Bundle { commit: "a".repeat(64), version: "2.5.0".into() };
            let after = Bundle { commit: "b".repeat(64), version: "2.6.0".into() };
            let host = FakeHost::new(vec![success(&metadata(&before.version)), success(&before.commit), success("installed"), success(&metadata(&after.version)), success(&after.commit)]);
            let path = Path::new("/home/user/.var/app/com.racktop.desktop/cache/private/update file.flatpak");
            installation(scope).install_with(&host, path, &after, &before).await.unwrap();
            let calls = host.calls.lock().unwrap();
            assert_eq!(calls.len(), 5);
            assert!(calls.iter().all(|args| args[1] == scope.argument()));
            assert_eq!(calls[2].last().unwrap(), path.as_os_str());
            assert_eq!(calls[2][2], if scope == Scope::System { "--assumeyes" } else { "--noninteractive" });
            for flag in ["--bundle", "--no-deps", "--no-related", "--or-update"] { assert!(calls[2].contains(&OsString::from(flag))); }
        }
    }

    #[tokio::test]
    async fn host_failure_or_concurrent_update_cannot_report_success() {
        let before = Bundle { commit: "a".repeat(64), version: "2.5.0".into() };
        let after = Bundle { commit: "b".repeat(64), version: "2.6.0".into() };
        let path = Path::new("/home/user/update.flatpak");
        let changed = FakeHost::new(vec![success(&metadata("2.7.0")), success(&"c".repeat(64))]);
        assert!(installation(Scope::User).install_with(&changed, path, &after, &before).await.unwrap_err().contains("其他进程"));
        assert_eq!(changed.calls.lock().unwrap().len(), 2);
        let denied = FakeHost::new(vec![success(&metadata(&before.version)), success(&before.commit), Err("host bridge denied".into())]);
        assert!(installation(Scope::System).install_with(&denied, path, &after, &before).await.unwrap_err().contains("denied"));
        assert_eq!(denied.calls.lock().unwrap().len(), 3);
        let unchanged = FakeHost::new(vec![success(&metadata(&before.version)), success(&before.commit), success(""), success(&metadata(&before.version)), success(&before.commit)]);
        assert!(installation(Scope::User).install_with(&unchanged, path, &after, &before).await.unwrap_err().contains("未匹配"));
    }
}
