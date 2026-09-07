use crate::models::Server;
use std::{ffi::OsString, path::Path};

/// Credentials are deliberately separate from the serializable server model.
#[derive(Clone, Default)]
pub struct SshPasswords {
    pub target: Option<String>,
    pub proxy: Option<String>,
}

impl std::fmt::Debug for SshPasswords {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshPasswords").field("target", &self.target.is_some()).field("proxy", &self.proxy.is_some()).finish()
    }
}

#[derive(Debug, PartialEq)]
pub struct JumpHost {
    pub username: String,
    pub host: String,
    pub port: u16,
}

/// A single explicit hop keeps password ownership unambiguous. Existing -J
/// aliases/chains remain available when independent password mode is disabled.
pub fn parse_jump(value: &str) -> Result<JumpHost, String> {
    let invalid = || "独立跳板机密码需要 用户名@主机:端口，例如 user@jump.example.com:22；暂不支持多跳或 SSH Config 别名".to_string();
    let (username, address) = value.trim().split_once('@').ok_or_else(invalid)?;
    if username.is_empty() || username.starts_with('-') || !username.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)) { return Err(invalid()); }
    let (host, port) = if let Some(ipv6) = address.strip_prefix('[') {
        let (host, suffix) = ipv6.split_once(']').ok_or_else(invalid)?;
        host.parse::<std::net::Ipv6Addr>().map_err(|_| invalid())?;
        (host, if suffix.is_empty() { 22 } else { suffix.strip_prefix(':').ok_or_else(invalid)?.parse::<u16>().map_err(|_| invalid())? })
    } else {
        let (host, port) = match address.split_once(':') {
            Some((host, port)) => (host, port.parse::<u16>().map_err(|_| invalid())?),
            None => (address, 22),
        };
        if host.is_empty() || host.starts_with('-') || !host.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)) { return Err(invalid()); }
        (host, port)
    };
    if port == 0 { return Err(invalid()); }
    Ok(JumpHost { username: username.into(), host: host.into(), port })
}

fn quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\\''")) }

pub struct SshOptions {
    pub args: Vec<String>,
    pub env: Vec<(OsString, OsString)>,
}

pub fn options(server: &Server, passwords: Option<&SshPasswords>, probe_keys: Option<&Path>) -> Result<SshOptions, String> {
    let mut options = SshOptions { args: Vec::new(), env: Vec::new() };
    let mut setting = |value: &str| options.args.extend(["-o".into(), value.into()]);
    for value in ["ConnectTimeout=8", "ServerAliveInterval=5", "ServerAliveCountMax=2", "ControlMaster=no", "ControlPath=none"] { setting(value); }
    if let Some(path) = probe_keys {
        // This quarantined key file is never used for authenticated sessions.
        // No target credential is supplied; the caller still requires explicit trust.
        for value in ["StrictHostKeyChecking=accept-new", "GlobalKnownHostsFile=/dev/null", "BatchMode=yes", "PreferredAuthentications=none", "PubkeyAuthentication=no", "PasswordAuthentication=no", "KbdInteractiveAuthentication=no", "UpdateHostKeys=no", "VerifyHostKeyDNS=no", "HashKnownHosts=no"] { setting(value); }
        setting(&format!("UserKnownHostsFile={}", path.display()));
    } else {
        setting("StrictHostKeyChecking=yes");
        #[cfg(feature = "integration-probe")]
        if let Some(path) = std::env::var_os("RACKTOP_TEST_KNOWN_HOSTS") { setting(&format!("UserKnownHostsFile={}", Path::new(&path).display())); }
        if server.auth_method == "password" {
            let password = passwords.and_then(|value| value.target.as_deref()).ok_or("没有可用的目标服务器密码；请编辑服务器并重新输入密码")?;
            for value in ["BatchMode=no", "PreferredAuthentications=password,keyboard-interactive", "PubkeyAuthentication=no", "NumberOfPasswordPrompts=1"] { setting(value); }
            options.env.push(("RACKTOP_ASKPASS_PASSWORD".into(), password.into()));
        } else {
            setting("BatchMode=yes");
        }
    }
    if server.proxy_use_password {
        if !cfg!(target_os = "linux") { return Err("独立跳板机密码目前仅支持 Linux 客户端".into()); }
        let proxy = server.proxy_jump.as_deref().ok_or("请填写跳板机地址")?;
        parse_jump(proxy)?;
        if server.ssh_alias.as_deref().is_some_and(|value| !value.is_empty()) {
            return Err("独立跳板机密码请配合目标服务器的密码或私钥认证，并直接填写目标地址；暂不支持目标 SSH Config 别名".into());
        }
        if server.host.is_empty() || server.host.starts_with('-') || !server.host.chars().all(|c| c.is_ascii_alphanumeric() || "_.-:".contains(c)) {
            return Err("目标主机地址格式无效".into());
        }
        let password = passwords.and_then(|value| value.proxy.as_deref()).ok_or("没有可用的跳板机密码；请编辑服务器并重新输入跳板机密码")?;
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let executable = executable.to_str().ok_or("RackTop 安装路径不是有效的 UTF-8")?;
        // Secrets never appear in ProxyCommand or process arguments. The helper
        // gives the outer ssh only the jump password, and replaces itself with ssh.
        options.args.extend(["-o".into(), format!("ProxyCommand={} --racktop-ssh-proxy {} {} {}", quote(executable), quote(proxy), quote(&server.host), server.port)]);
        options.env.push(("RACKTOP_PROXY_PASSWORD".into(), password.into()));
    } else if let Some(proxy) = server.proxy_jump.as_deref().filter(|value| !value.is_empty()) {
        options.args.extend(["-J".into(), proxy.into()]);
    }
    if !options.env.is_empty() {
        options.env.push(("SSH_ASKPASS".into(), std::env::current_exe().map_err(|error| error.to_string())?.into_os_string()));
        options.env.push(("SSH_ASKPASS_REQUIRE".into(), "force".into()));
        options.env.push(("DISPLAY".into(), "racktop:0".into()));
    }
    Ok(options)
}

/// Called before the desktop runtime or askpass handler, so the target password
/// can never accidentally be printed into the proxy's SSH byte stream.
pub fn run_proxy(args: &[String]) -> Result<(), String> {
    if args.len() != 3 { return Err("无效的跳板机连接参数".into()); }
    let jump = parse_jump(&args[0])?;
    let target_port = args[2].parse::<u16>().map_err(|_| "无效的目标端口")?;
    let target_host = &args[1];
    if target_port == 0 || target_host.is_empty() || target_host.starts_with('-') || !target_host.chars().all(|c| c.is_ascii_alphanumeric() || "_.-:".contains(c)) { return Err("无效的目标地址".into()); }
    let password = std::env::var("RACKTOP_PROXY_PASSWORD").map_err(|_| "没有可用的跳板机密码")?;
    let mut command = std::process::Command::new("ssh");
    command.args(["-T", "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=no", "-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ProxyCommand=none", "-o", "ProxyJump=none"]);
    #[cfg(feature = "integration-probe")]
    if let Some(path) = std::env::var_os("RACKTOP_TEST_KNOWN_HOSTS") { command.args(["-o", &format!("UserKnownHostsFile={}", Path::new(&path).display())]); }
    command.args(["-p", &jump.port.to_string(), "-l", &jump.username, "-W", &format!("[{target_host}]:{target_port}"), &jump.host]);
    command.env("RACKTOP_ASKPASS_PASSWORD", password).env_remove("RACKTOP_PROXY_PASSWORD");
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        Err(format!("无法启动跳板机 SSH：{}", command.exec()))
    }
    #[cfg(not(target_os = "linux"))]
    { Err("独立跳板机密码目前仅支持 Linux 客户端".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn password_server() -> Server {
        serde_json::from_value(serde_json::json!({
            "id": "fixture", "name": "Fixture", "host": "target.example", "port": 22,
            "username": "worker", "tags": [], "samplingIntervalSeconds": 2,
            "historyRetentionDays": 90, "authMethod": "password", "status": "unknown",
            "proxyJump": "jump@jump.example:21022", "proxyUsePassword": true
        })).unwrap()
    }

    #[test]
    fn credentials_are_not_in_arguments_and_probe_has_no_target_secret() {
        let server = password_server();
        let passwords = SshPasswords { target: Some("target-only".into()), proxy: Some("jump-only".into()) };
        let normal = options(&server, Some(&passwords), None).unwrap();
        assert!(!normal.args.join(" ").contains("target-only"));
        assert!(!normal.args.join(" ").contains("jump-only"));
        assert!(normal.args.iter().any(|arg| arg == "StrictHostKeyChecking=yes"));
        let directory = tempfile::tempdir().unwrap();
        let probe = options(&server, Some(&passwords), Some(&directory.path().join("keys"))).unwrap();
        assert!(!probe.env.iter().any(|(key, _)| key == "RACKTOP_ASKPASS_PASSWORD"));
        assert!(probe.env.iter().any(|(key, _)| key == "RACKTOP_PROXY_PASSWORD"));
        assert!(probe.args.iter().any(|arg| arg == "PreferredAuthentications=none"));
        let absent = SshPasswords { target: Some("target-only".into()), proxy: None };
        assert!(options(&server, Some(&absent), None).err().unwrap().contains("跳板机密码"));
    }

    #[test]
    fn validates_explicit_jump_endpoints() {
        assert_eq!(parse_jump("alice@jump.example:21022").unwrap(), JumpHost { username: "alice".into(), host: "jump.example".into(), port: 21022 });
        assert_eq!(parse_jump("alice@[::1]:2222").unwrap().port, 2222);
        for input in ["alias", "-u@host", "alice@-x", "alice@host:0", "alice@host:65536", "alice@host,bob@other", "alice@host;id", "alice@host%h", "alice@$(id)", "alice@host\nother"] { assert!(parse_jump(input).is_err(), "{input}"); }
    }
    #[test]
    fn debug_does_not_disclose_either_password() {
        let passwords = SshPasswords { target: Some("target-secret".into()), proxy: Some("jump-secret".into()) };
        let debug = format!("{passwords:?}");
        assert!(!debug.contains("secret"));
    }
}
