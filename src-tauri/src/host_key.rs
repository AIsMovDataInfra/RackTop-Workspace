use crate::models::{HostKeyInfo, Server};
use base64::{engine::general_purpose::{STANDARD, STANDARD_NO_PAD}, Engine};
use sha2::{Digest, Sha256};
use std::{fs::OpenOptions, io::Write, path::PathBuf, process::Stdio};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tokio::{process::Command, time::{timeout, Duration}};

fn jump_server(server: &Server) -> Result<Server, String> {
    let jump = crate::ssh_connection::parse_jump(server.proxy_jump.as_deref().ok_or("缺少跳板机地址")?)?;
    let mut proxy = server.clone();
    proxy.host = jump.host;
    proxy.port = jump.port;
    proxy.username = jump.username;
    proxy.proxy_jump = None;
    proxy.proxy_use_password = false;
    proxy.ssh_alias = None;
    Ok(proxy)
}

pub async fn scan_with_passwords(server: &Server, passwords: Option<&crate::ssh_connection::SshPasswords>) -> Result<HostKeyInfo, String> {
    if server.proxy_jump.as_deref().is_some_and(|value| !value.is_empty()) {
        // Confirm an explicit jump's key before sending it any credentials.
        if let Ok(proxy) = jump_server(server) {
            let mut info = scan_direct(&proxy).await?;
            info.is_proxy = true;
            if info.changed || !known_key_matches(&proxy, &info).await? { return Ok(info); }
        } else if server.proxy_use_password {
            return Err("独立跳板机密码需要 用户名@主机:端口".into());
        }
        return scan_through_jump(server, passwords).await;
    }
    scan_direct(server).await
}

async fn scan_through_jump(server: &Server, passwords: Option<&crate::ssh_connection::SshPasswords>) -> Result<HostKeyInfo, String> {
    let directory = tempfile::tempdir().map_err(|error| error.to_string())?;
    let key_path = directory.path().join("untrusted-known-hosts");
    let options = crate::ssh_connection::options(server, passwords, Some(&key_path))?;
    let mut command = Command::new("ssh");
    command.args(options.args).envs(options.env).args(["-N", "-p", &server.port.to_string(), "-l", &server.username, &server.host])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
    let result = timeout(Duration::from_secs(12), command.output()).await;
    let text = std::fs::read_to_string(&key_path).unwrap_or_default();
    let line = text.lines().find(|line| !line.starts_with('#') && !line.trim().is_empty());
    let Some(line) = line else {
        return Err(match result {
            Ok(Ok(output)) => crate::collector::classify_ssh_error(&String::from_utf8_lossy(&output.stderr)),
            Ok(Err(error)) => format!("无法通过跳板机获取主机指纹：{error}"),
            Err(_) => "通过跳板机获取主机指纹超时".into(),
        });
    };
    let mut info = parse_line(&server.id, &server.host, line)?;
    info.changed = known_key_changed(server, &info).await?;
    Ok(info)
}

async fn scan_direct(server: &Server) -> Result<HostKeyInfo, String> {
    let mut command = Command::new("ssh-keyscan");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = timeout(
        Duration::from_secs(8),
        command
            .args(["-T", "5", "-p", &server.port.to_string(), &server.host])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| "扫描 SSH Host Key 超时".to_string())?
    .map_err(|error| format!("无法运行 ssh-keyscan：{error}"))?;
    if !output.status.success() && output.stdout.is_empty() {
        return Err(format!("无法获取 Host Key：{}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().filter(|line| !line.starts_with('#')).max_by_key(|line| algorithm_priority(line)).ok_or("服务器未返回可用 Host Key")?;
    let mut info = parse_line(&server.id, &server.host, line)?;
    info.changed = known_key_changed(server, &info).await?;
    Ok(info)
}

async fn known_key_changed(server: &Server, scanned: &HostKeyInfo) -> Result<bool, String> {
    let path = known_hosts_path()?;
    if !path.exists() { return Ok(false); }
    let lookup = if server.port == 22 { server.host.clone() } else { format!("[{}]:{}", server.host, server.port) };
    let mut command = Command::new("ssh-keygen");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command.args(["-F", &lookup, "-f", &path.to_string_lossy()]).output().await.map_err(|error| format!("无法核对现有 Host Key：{error}"))?;
    if !output.status.success() || output.stdout.is_empty() { return Ok(false); }
    let scanned_fields: Vec<&str> = scanned.key_line.split_whitespace().collect();
    let known_output = String::from_utf8_lossy(&output.stdout);
    let known_lines: Vec<&str> = known_output.lines().filter(|line| !line.starts_with('#')).collect();
    let same_key = known_lines.iter().any(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        fields.len() >= 3 && scanned_fields.len() >= 3 && fields[1] == scanned_fields[1] && fields[2] == scanned_fields[2]
    });
    Ok(!known_lines.is_empty() && !same_key)
}

fn algorithm_priority(line: &str) -> u8 {
    if line.contains("ssh-ed25519") { 3 } else if line.contains("ecdsa-") { 2 } else { 1 }
}

fn parse_line(server_id: &str, host: &str, line: &str) -> Result<HostKeyInfo, String> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() != 3 || !fields[1].starts_with("ssh-") && !fields[1].starts_with("ecdsa-") {
        return Err("ssh-keyscan 返回了无效格式".into());
    }
    let key = STANDARD.decode(fields[2]).map_err(|_| "Host Key Base64 无效")?;
    let digest = Sha256::digest(key);
    Ok(HostKeyInfo { is_proxy: false, server_id: server_id.into(), host: host.into(), algorithm: fields[1].into(), fingerprint: format!("SHA256:{}", STANDARD_NO_PAD.encode(digest)), key_line: line.into(), changed: false })
}

pub fn trust(server: &Server, info: &HostKeyInfo) -> Result<(), String> {
    let proxy;
    let server = if info.is_proxy { proxy = jump_server(server)?; &proxy } else { server };
    if server.id != info.server_id || server.host != info.host {
        return Err("Host Key 与目标服务器不匹配".into());
    }
    if info.changed {
        return Err("Host Key 已发生变化。为防止中间人攻击，RackTop 不会覆盖现有密钥；请先通过可信渠道核实并手动更新 known_hosts。".into());
    }
    let expected = if server.port == 22 { server.host.clone() } else { format!("[{}]:{}", server.host, server.port) };
    if info.key_line.split_whitespace().next() != Some(expected.as_str()) {
        return Err("Host Key 的地址或端口与待确认的服务器不匹配".into());
    }
    let verified = parse_line(&server.id, &server.host, &info.key_line)?;
    if verified.fingerprint != info.fingerprint {
        return Err("Host Key 指纹校验失败".into());
    }
    let path = known_hosts_path()?;
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if !existing.lines().any(|line| line.trim() == info.key_line.trim()) {
        let mut file = OpenOptions::new().create(true).append(true).open(&path).map_err(|error| format!("无法写入 {}：{error}", path.display()))?;
        writeln!(file, "{}", info.key_line.trim()).map_err(|error| error.to_string())?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn known_key_matches(server: &Server, info: &HostKeyInfo) -> Result<bool, String> {
    let path = known_hosts_path()?;
    let lookup = if server.port == 22 { server.host.clone() } else { format!("[{}]:{}", server.host, server.port) };
    let output = Command::new("ssh-keygen").args(["-F", &lookup, "-f", &path.to_string_lossy()]).output().await.map_err(|error| error.to_string())?;
    let scanned: Vec<_> = info.key_line.split_whitespace().collect();
    Ok(String::from_utf8_lossy(&output.stdout).lines().filter(|line| !line.starts_with('#')).any(|line| {
        let fields: Vec<_> = line.split_whitespace().collect();
        fields.len() >= 3 && fields[1..3] == scanned[1..3]
    }))
}

pub(crate) fn known_hosts_path() -> Result<PathBuf, String> {
    #[cfg(feature = "integration-probe")]
    if let Some(path) = std::env::var_os("RACKTOP_TEST_KNOWN_HOSTS") { return Ok(PathBuf::from(path)); }
    dirs::home_dir().map(|home| home.join(".ssh").join("known_hosts")).ok_or_else(|| "无法定位 ~/.ssh/known_hosts".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fingerprint() {
        let info = parse_line("id", "example.com", "example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEr7NxQ0wNIrsiOqW1FrpSGbP/2Y8cDrn2NQHQkM8p4Y").unwrap();
        assert!(info.fingerprint.starts_with("SHA256:"));
        assert_eq!(info.algorithm, "ssh-ed25519");
    }

    #[test]
    fn refuses_to_overwrite_a_changed_host_key() {
        let server = Server { id: "id".into(), name: "GPU".into(), location: None, host: "example.com".into(), port: 22, username: "user".into(), ssh_alias: None, identity_file: None, proxy_jump: None, proxy_use_password: false, save_proxy_password: false, tags: Vec::new(), sampling_interval_seconds: 2, history_retention_days: 30, remote_history_enabled: false, remote_history_last_sync_at: None, sort_order: 0, auth_method: "sshAgent".into(), status: "unknown".into(), last_error: None, last_seen_at: None };
        let mut info = parse_line("id", "example.com", "example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEr7NxQ0wNIrsiOqW1FrpSGbP/2Y8cDrn2NQHQkM8p4Y").unwrap();
        info.changed = true;
        assert!(trust(&server, &info).unwrap_err().contains("不会覆盖"));
    }
}
