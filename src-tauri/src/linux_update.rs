use serde::Serialize;
use std::{path::Path, sync::{Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::{ipc::Channel, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use crate::flatpak_update::{self, Bundle, Installation};

pub const ENDPOINT: &str = "https://raw.githubusercontent.com/AIsMovDataInfra/RackTop-Workspace/updater/linux-amd64.json";
const PUBLIC_KEY: &str = include_str!("../linux-updater.pub");

/// Reject a signing-key mismatch in release automation before publication.
pub fn verify_package_signature(bytes: &[u8], signature: &str) -> Result<(), String> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let public = String::from_utf8(STANDARD.decode(PUBLIC_KEY.trim()).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    let signature = String::from_utf8(STANDARD.decode(signature.trim()).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    let public = minisign_verify::PublicKey::decode(&public).map_err(|error| error.to_string())?;
    let signature = minisign_verify::Signature::decode(&signature).map_err(|error| error.to_string())?;
    public.verify(bytes, &signature, true).map_err(|error| error.to_string())
}

#[derive(Default)]
pub struct LinuxUpdateState {
    pending: Mutex<Option<(Update, Option<Installation>)>>,
    installing: AtomicBool,
    installed: Mutex<Option<InstalledUpdate>>,
}

#[derive(Clone)]
enum InstalledUpdate { Deb(String), Flatpak(Installation, Bundle) }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo { version: String, date: Option<String> }

fn is_flatpak() -> bool { Path::new("/.flatpak-info").is_file() }

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    Started { #[serde(rename = "contentLength")] content_length: Option<u64> },
    Progress { #[serde(rename = "chunkLength")] chunk_length: usize },
    Finished,
}

pub fn validate_release(version: &str, url: &str, current: &str) -> Result<(), String> {
    validate_package_release(version, url, current, "deb")
}

pub fn validate_flatpak_release(version: &str, url: &str, current: &str) -> Result<(), String> {
    validate_package_release(version, url, current, "flatpak")
}

fn validate_package_release(version: &str, url: &str, current: &str, extension: &str) -> Result<(), String> {
    let candidate = semver::Version::parse(version).map_err(|_| "更新版本号无效")?;
    let installed = semver::Version::parse(current).map_err(|_| "当前版本号无效")?;
    if !candidate.pre.is_empty() || !candidate.build.is_empty() || candidate <= installed {
        return Err("更新版本必须是高于当前版本的正式版本号".into());
    }
    let expected = format!("https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v{version}/RackTop_{version}_linux-amd64.{extension}");
    if url != expected { return Err("更新安装包地址不属于受信任的 Linux 发布".into()); }
    Ok(())
}

#[tauri::command]
pub async fn check_linux_update(app: tauri::AppHandle, state: State<'_, LinuxUpdateState>) -> Result<Option<UpdateInfo>, String> {
    *state.pending.lock().map_err(|error| error.to_string())? = None;
    if std::env::consts::ARCH != "x86_64" { return Err("当前 Linux 更新通道仅提供 amd64 安装包".into()); }
    let installation = if is_flatpak() { Some(flatpak_update::detect().await?) } else { None };
    let target = if installation.is_some() { flatpak_update::TARGET } else { "linux-x86_64-deb" };
    let update = app.updater_builder().pubkey(PUBLIC_KEY.trim()).target(target)
        .endpoints(vec![ENDPOINT.parse().map_err(|_| "更新通道地址无效")?]).map_err(|error| error.to_string())?
        .timeout(Duration::from_secs(30)).build().map_err(|error| error.to_string())?
        .check().await.map_err(|error| format!("无法检查 Linux 更新：{error}"))?;
    if let Some(update) = &update {
        validate_package_release(&update.version, update.download_url.as_str(), env!("CARGO_PKG_VERSION"), if installation.is_some() { "flatpak" } else { "deb" })?;
    }
    let info = update.as_ref().map(|update| UpdateInfo { version: update.version.clone(), date: update.date.map(|date| date.to_string()) });
    *state.pending.lock().map_err(|error| error.to_string())? = update.map(|update| (update, installation));
    Ok(info)
}

pub async fn validate_deb(path: &Path, expected_version: &str) -> Result<(), String> {
    let output = tokio::process::Command::new("/usr/bin/dpkg-deb").args(["--show", "--showformat=${Package}\n${Version}\n${Architecture}\n"]).arg(path)
        .output().await.map_err(|error| format!("无法检查 Debian 安装包：{error}"))?;
    let expected = format!("rack-top\n{expected_version}\namd64\n");
    if !output.status.success() || output.stdout != expected.as_bytes() { return Err("安装包名称、版本或架构不匹配，已停止更新".into()); }
    Ok(())
}

async fn installed_version() -> Result<String, String> {
    let output = tokio::process::Command::new("/usr/bin/dpkg-query").args(["-W", "-f=${Version}", "rack-top"]).output().await.map_err(|error| error.to_string())?;
    if !output.status.success() { return Err("未找到已安装的 RackTop Debian 包".into()); }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[tauri::command]
pub async fn install_linux_update(state: State<'_, LinuxUpdateState>, version: String, on_event: Channel<DownloadEvent>) -> Result<(), String> {
    if state.installing.swap(true, Ordering::SeqCst) { return Err("更新正在进行，请勿重复安装".into()); }
    struct Reset<'a>(&'a AtomicBool);
    impl Drop for Reset<'_> { fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); } }
    let _reset = Reset(&state.installing);
    let (mut update, installation) = state.pending.lock().map_err(|error| error.to_string())?.clone().ok_or("请先重新检查更新")?;
    if installation.is_some() != is_flatpak() { return Err("安装格式已变化，请重新检查更新".into()); }
    if update.version != version { return Err("更新版本已变化，请重新检查更新".into()); }
    let extension = if installation.is_some() { "flatpak" } else { "deb" };
    validate_package_release(&version, update.download_url.as_str(), env!("CARGO_PKG_VERSION"), extension)?;
    // Keep an already running old process from reinstalling/downgrading a newer package.
    let previous_flatpak = if let Some(installation) = &installation {
        Some(installation.before_update(&version).await?)
    } else {
        validate_release(&version, update.download_url.as_str(), &installed_version().await?)?;
        None
    };
    update.timeout = Some(Duration::from_secs(300));
    let mut started = false;
    let bytes = update.download(|chunk_length, content_length| {
        if !started { let _ = on_event.send(DownloadEvent::Started { content_length }); started = true; }
        let _ = on_event.send(DownloadEvent::Progress { chunk_length });
    }, || {}).await.map_err(|error| format!("更新下载或签名校验失败：{error}"))?;
    // Tauri verifies the signature before returning bytes. No installer runs on unverified content.
    if let Some(installation) = installation {
        let bundle = flatpak_update::validate_bundle(&bytes, &version)?;
        if update.raw_json["platforms"][flatpak_update::TARGET]["commit"].as_str() != Some(bundle.commit.as_str()) {
            return Err("Flatpak 安装包 commit 与更新清单不匹配".into());
        }
        let directory = installation.temporary_directory()?;
        let path = directory.path().join(format!("RackTop_{version}_linux-amd64.flatpak"));
        std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
        let _ = on_event.send(DownloadEvent::Finished);
        installation.install(&path, &bundle, previous_flatpak.as_ref().ok_or("缺少原 Flatpak 安装状态")?).await?;
        *state.installed.lock().map_err(|error| error.to_string())? = Some(InstalledUpdate::Flatpak(installation, bundle));
        return Ok(());
    }
    let directory = tempfile::tempdir().map_err(|error| error.to_string())?;
    let path = directory.path().join(format!("RackTop_{version}_linux-amd64.deb"));
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    validate_deb(&path, &version).await?;
    validate_release(&version, update.download_url.as_str(), &installed_version().await?)?;
    let _ = on_event.send(DownloadEvent::Finished);
    let output = tokio::process::Command::new("/usr/bin/pkexec")
        .args(["/usr/bin/apt-get", "install", "-y", "--"]).arg(&path)
        .stdin(std::process::Stdio::null()).output().await.map_err(|error| format!("无法启动系统安装授权：{error}"))?;
    if !output.status.success() {
        if matches!(output.status.code(), Some(126 | 127)) { return Err("系统安装授权已取消或不可用。可重新点击更新并完成管理员授权。".into()); }
        return Err(format!("系统安装失败：{}", String::from_utf8_lossy(&output.stderr).chars().take(1500).collect::<String>()));
    }
    if installed_version().await? != version { return Err("安装程序已结束，但系统版本未更新，请重试或手动安装".into()); }
    *state.installed.lock().map_err(|error| error.to_string())? = Some(InstalledUpdate::Deb(version));
    Ok(())
}

#[tauri::command]
pub async fn relaunch_linux_app(app: tauri::AppHandle, state: State<'_, LinuxUpdateState>) -> Result<(), String> {
    let installed = state.installed.lock().map_err(|error| error.to_string())?.clone().ok_or("尚未完成安装")?;
    let expected = match installed {
        InstalledUpdate::Flatpak(installation, bundle) => {
            if !is_flatpak() { return Err("安装格式已变化，请手动打开 RackTop".into()); }
            installation.relaunch(&bundle).await?;
            app.exit(0);
            return Ok(());
        }
        InstalledUpdate::Deb(version) => version,
    };
    if is_flatpak() { return Err("Flatpak 不能启动 Debian 安装".into()); }
    if installed_version().await? != expected { return Err("系统版本发生变化，请手动重新打开 RackTop".into()); }
    // /proc/self/exe may refer to the deleted old binary after dpkg replaces it.
    std::process::Command::new("/usr/bin/racktop").spawn().map_err(|error| format!("更新已安装，请手动重新打开 RackTop：{error}"))?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn flatpak_and_debian_channels_cannot_be_confused() {
        let url = "https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.5.0/RackTop_2.5.0_linux-amd64.flatpak";
        assert!(validate_flatpak_release("2.5.0", url, "2.2.2").is_ok());
        assert!(validate_release("2.5.0", url, "2.2.2").is_err());
        assert!(validate_flatpak_release("2.5.0", &url.replace(".flatpak", ".deb"), "2.2.2").is_err());
        assert!(validate_flatpak_release("2.5.0", url, "2.5.0").is_err());
        assert!(validate_flatpak_release("2.5.0", url, "2.6.0").is_err());
    }
    #[test]
    fn accepts_only_newer_workspace_linux_packages() {
        let url = "https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/RackTop_2.0.0_linux-amd64.deb";
        assert!(validate_release("2.0.0", url, "1.30.0-linux.12").is_ok());
        assert!(validate_release("2.0.0", url, "1.30.0").is_ok());
        assert!(validate_release("2.0.0", url, "2.0.0").is_err());
        assert!(validate_release("2.0.0", url, "2.0.1").is_err());
        assert!(validate_release("2.0.0", &url.replace("RackTop-Workspace/", "RackTop/"), "1.30.0-linux.12").is_err());
        assert!(validate_release("2.0.0", &url.replace("https:", "http:"), "1.30.0-linux.12").is_err());
        assert!(validate_release("2.0.0", &url.replace("linux-amd64.deb", "macos-arm64.dmg"), "1.30.0-linux.12").is_err());
        assert!(validate_release("2.0.0-linux.1", url, "1.30.0-linux.12").is_err());
        assert!(validate_release("2.0.0+build", url, "1.30.0-linux.12").is_err());
    }
}
