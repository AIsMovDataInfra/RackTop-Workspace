use crate::models::Server;
use std::{ffi::OsString, path::Path};
use zeroize::Zeroize;

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

impl Drop for SshPasswords {
    fn drop(&mut self) { self.target.zeroize(); self.proxy.zeroize(); }
}

pub(crate) const INHERITED_ASKPASS_ENV: [&str; 7] = [
    "RACKTOP_ASKPASS_PASSWORD", "RACKTOP_PROXY_PASSWORD", crate::askpass::SOCKET_ENV,
    crate::askpass::TOKEN_ENV, crate::askpass::PROXY_TOKEN_ENV, "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE",
];

pub(crate) fn clear_inherited_askpass_env(command: &mut tokio::process::Command) {
    for key in INHERITED_ASKPASS_ENV { command.env_remove(key); }
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
    pub broker: Option<crate::askpass::Broker>,
}

pub fn options(server: &Server, passwords: Option<&SshPasswords>, probe_keys: Option<&Path>) -> Result<SshOptions, String> {
    let mut options = SshOptions { args: Vec::new(), env: Vec::new(), broker: None };
    let mut target_password = None;
    let mut proxy_password = None;
    if server.managed.is_some() {
        // An organization address cannot be redirected by a local Host stanza.
        options.args.extend(["-F".into(), if cfg!(windows) { "NUL" } else { "/dev/null" }.into()]);
    }
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
            target_password = Some(password);
        } else {
            setting("BatchMode=yes");
        }
    }
    if server.proxy_use_password {
        if !cfg!(any(target_os = "linux", target_os = "macos")) { return Err("独立跳板机密码目前仅支持 Linux 和 macOS 客户端".into()); }
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
        let isolated_config = if server.managed.is_some() { " no-config" } else { "" };
        // The proxy helper receives only operation-scoped capability metadata;
        // the password is delivered directly to the nested SSH's askpass child.
        options.args.extend(["-o".into(), format!("ProxyCommand={} --racktop-ssh-proxy {} {} {}{isolated_config}", quote(executable), quote(proxy), quote(&server.host), server.port)]);
        proxy_password = Some(password);
    } else if let Some(proxy) = server.proxy_jump.as_deref().filter(|value| !value.is_empty()) {
        options.args.extend(["-J".into(), proxy.into()]);
    }
    if target_password.is_some() || proxy_password.is_some() {
        let (broker, env) = crate::askpass::Broker::start(target_password, proxy_password)?;
        options.broker = Some(broker);
        options.env.extend(env);
        options.env.push(("SSH_ASKPASS".into(), std::env::current_exe().map_err(|error| error.to_string())?.into_os_string()));
        options.env.push(("SSH_ASKPASS_REQUIRE".into(), "force".into()));
        options.env.push(("DISPLAY".into(), "racktop:0".into()));
    }
    Ok(options)
}

/// Called before the desktop runtime or askpass handler, so the target password
/// can never accidentally be printed into the proxy's SSH byte stream.
pub fn run_proxy(args: &[String]) -> Result<(), String> {
    if args.len() != 3 && !(args.len() == 4 && args[3] == "no-config") { return Err("无效的跳板机连接参数".into()); }
    let jump = parse_jump(&args[0])?;
    let target_port = args[2].parse::<u16>().map_err(|_| "无效的目标端口")?;
    let target_host = &args[1];
    if target_port == 0 || target_host.is_empty() || target_host.starts_with('-') || !target_host.chars().all(|c| c.is_ascii_alphanumeric() || "_.-:".contains(c)) { return Err("无效的目标地址".into()); }
    let token = std::env::var_os(crate::askpass::PROXY_TOKEN_ENV).ok_or("没有可用的跳板机密码通道")?;
    let mut command = std::process::Command::new("ssh");
    if args.len() == 4 { command.args(["-F", if cfg!(windows) { "NUL" } else { "/dev/null" }]); }
    command.args(["-T", "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=no", "-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ProxyCommand=none", "-o", "ProxyJump=none"]);
    #[cfg(feature = "integration-probe")]
    if let Some(path) = std::env::var_os("RACKTOP_TEST_KNOWN_HOSTS") { command.args(["-o", &format!("UserKnownHostsFile={}", Path::new(&path).display())]); }
    command.args(["-p", &jump.port.to_string(), "-l", &jump.username, "-W", &format!("[{target_host}]:{target_port}"), &jump.host]);
    command.env(crate::askpass::TOKEN_ENV, token).env_remove(crate::askpass::PROXY_TOKEN_ENV)
        .env_remove("RACKTOP_ASKPASS_PASSWORD").env_remove("RACKTOP_PROXY_PASSWORD");
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use std::os::unix::process::CommandExt;
        Err(format!("无法启动跳板机 SSH：{}", command.exec()))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    { Err("独立跳板机密码目前仅支持 Linux 和 macOS 客户端".into()) }
}

/// The command and its child own the channel. Keeping this wrapper through
/// output()/spawn() prevents builders from dropping the channel before askpass.
pub(crate) struct SshCommand {
    command: tokio::process::Command,
    broker: Option<crate::askpass::Broker>,
}

impl SshCommand {
    pub(crate) fn new(mut command: tokio::process::Command, broker: Option<crate::askpass::Broker>) -> Self {
        // Builders clear inherited capability metadata before adding this
        // operation's values; keep the legacy plaintext fields absent too.
        command.env_remove("RACKTOP_ASKPASS_PASSWORD").env_remove("RACKTOP_PROXY_PASSWORD");
        Self { command, broker }
    }
    pub(crate) fn arg(&mut self, arg: impl AsRef<std::ffi::OsStr>) -> &mut Self { self.command.arg(arg); self }
    pub(crate) fn args<I, S>(&mut self, args: I) -> &mut Self where I: IntoIterator<Item=S>, S: AsRef<std::ffi::OsStr> { self.command.args(args); self }
    pub(crate) fn stdin(&mut self, value: std::process::Stdio) -> &mut Self { self.command.stdin(value); self }
    pub(crate) fn stdout(&mut self, value: std::process::Stdio) -> &mut Self { self.command.stdout(value); self }
    pub(crate) fn stderr(&mut self, value: std::process::Stdio) -> &mut Self { self.command.stderr(value); self }
    pub(crate) fn kill_on_drop(&mut self, value: bool) -> &mut Self { self.command.kill_on_drop(value); self }
    #[cfg(test)]
    pub(crate) fn as_std(&self) -> &std::process::Command { self.command.as_std() }
    pub(crate) fn spawn(&mut self) -> std::io::Result<SshChild> {
        let child = self.command.spawn()?;
        if let Some(broker) = &self.broker { broker.bind_child(child.id()); }
        Ok(SshChild { child, _broker: self.broker.take() })
    }
    pub(crate) async fn output(&mut self) -> std::io::Result<std::process::Output> {
        self.command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        self.spawn()?.wait_with_output().await
    }
}

pub(crate) struct SshChild {
    child: tokio::process::Child,
    _broker: Option<crate::askpass::Broker>,
}
impl std::ops::Deref for SshChild { type Target = tokio::process::Child; fn deref(&self) -> &Self::Target { &self.child } }
impl std::ops::DerefMut for SshChild { fn deref_mut(&mut self) -> &mut Self::Target { &mut self.child } }
impl SshChild {
    pub(crate) async fn wait_with_output(self) -> std::io::Result<std::process::Output> {
        let Self { child, _broker } = self;
        let result = child.wait_with_output().await;
        drop(_broker);
        result
    }
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

    #[tokio::test]
    #[cfg(unix)]
    async fn cancelling_an_output_operation_closes_its_password_channel() {
        let (broker, env) = crate::askpass::Broker::start(Some("synthetic-cancel-password"), None).unwrap();
        let endpoint = std::path::PathBuf::from(&env.iter().find(|(key, _)| key == crate::askpass::SOCKET_ENV).unwrap().1);
        let mut process = tokio::process::Command::new("sleep");
        process.arg("5").kill_on_drop(true);
        let mut command = SshCommand::new(process, Some(broker));
        assert!(tokio::time::timeout(std::time::Duration::from_millis(30), command.output()).await.is_err());
        assert!(!endpoint.exists());
    }

    #[test]
    #[cfg(unix)]
    fn a_failed_spawn_releases_the_operation_channel() {
        let (broker, env) = crate::askpass::Broker::start(Some("synthetic-spawn-password"), None).unwrap();
        let endpoint = std::path::PathBuf::from(&env.iter().find(|(key, _)| key == crate::askpass::SOCKET_ENV).unwrap().1);
        let mut command = SshCommand::new(tokio::process::Command::new("/racktop-fixture-no-such-executable"), Some(broker));
        assert!(command.spawn().is_err());
        drop(command);
        assert!(!endpoint.exists());
    }

    #[test]
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn credentials_are_not_in_arguments_and_probe_has_no_target_secret() {
        let server = password_server();
        let passwords = SshPasswords { target: Some("target-only".into()), proxy: Some("jump-only".into()) };
        let normal = options(&server, Some(&passwords), None).unwrap();
        assert!(!normal.args.join(" ").contains("target-only"));
        assert!(!normal.args.join(" ").contains("jump-only"));
        assert!(normal.args.iter().any(|arg| arg == "StrictHostKeyChecking=yes"));
        let directory = tempfile::tempdir().unwrap();
        let probe = options(&server, Some(&passwords), Some(&directory.path().join("keys"))).unwrap();
        assert!(!probe.env.iter().any(|(key, _)| key == crate::askpass::TOKEN_ENV));
        assert!(probe.env.iter().any(|(key, _)| key == crate::askpass::PROXY_TOKEN_ENV));
        assert!(!format!("{:?}", normal.env).contains("target-only"));
        assert!(!format!("{:?}", normal.env).contains("jump-only"));
        assert!(probe.args.iter().any(|arg| arg == "PreferredAuthentications=none"));
        let absent = SshPasswords { target: Some("target-only".into()), proxy: None };
        assert!(options(&server, Some(&absent), None).err().unwrap().contains("跳板机密码"));
    }

    #[test]
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn jump_and_askpass_helpers_use_the_running_app_and_separate_passwords() {
        let server = password_server();
        let passwords = SshPasswords { target: Some("target-only".into()), proxy: Some("jump-only".into()) };
        let options = options(&server, Some(&passwords), None).unwrap();
        let env: std::collections::HashMap<_, _> = options.env.into_iter().collect();
        let executable = std::env::current_exe().unwrap();
        assert_eq!(env.get(std::ffi::OsStr::new("SSH_ASKPASS")), Some(&executable.clone().into_os_string()));
        assert_eq!(env.get(std::ffi::OsStr::new("SSH_ASKPASS_REQUIRE")), Some(&OsString::from("force")));
        assert!(env.contains_key(std::ffi::OsStr::new(crate::askpass::TOKEN_ENV)));
        assert!(env.contains_key(std::ffi::OsStr::new(crate::askpass::PROXY_TOKEN_ENV)));
        assert_ne!(env.get(std::ffi::OsStr::new(crate::askpass::TOKEN_ENV)), env.get(std::ffi::OsStr::new(crate::askpass::PROXY_TOKEN_ENV)));
        assert!(options.args.iter().any(|arg| arg == &format!("ProxyCommand={} --racktop-ssh-proxy 'jump@jump.example:21022' 'target.example' 22", quote(executable.to_str().unwrap()))));
        assert_eq!(quote("/Applications/RackTop Preview.app/Contents/MacOS/racktop"), "'/Applications/RackTop Preview.app/Contents/MacOS/racktop'");
    }

    #[test]
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn unsupported_platform_rejects_independent_jump_password_without_starting_ssh() {
        let passwords = SshPasswords { target: Some("target-only".into()), proxy: Some("jump-only".into()) };
        assert!(options(&password_server(), Some(&passwords), None).err().unwrap().contains("仅支持 Linux 和 macOS"));
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
