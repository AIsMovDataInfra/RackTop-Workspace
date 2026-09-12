use crate::{collector::{explicit_identity_file, visible_devices_variable}, models::Server};
use crate::ssh_keys::expand_identity_path;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex, mpsc},
    thread,
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

struct TerminalSession {
    server_id: String,
    authorization_epoch: Option<i64>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    _password_channel: Option<crate::askpass::Broker>,
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
}

impl TerminalManager {
    pub fn start(
        &self,
        app: AppHandle,
        server: &Server,
        password: Option<&crate::ssh_connection::SshPasswords>,
        authorization_epoch: Option<i64>,
        columns: u16,
        rows: u16,
        gpu_index: Option<u32>,
        accelerator_vendor: &str,
    ) -> Result<String, String> {
        let pty = native_pty_system();
        let pair = pty.openpty(PtySize {
            rows: rows.max(2),
            cols: columns.max(2),
            pixel_width: 0,
            pixel_height: 0,
        }).map_err(|error| format!("无法创建终端 PTY：{error}"))?;

        let (mut command, password_channel) = configured_ssh_command(server, password)?;
        if let Some(index) = gpu_index {
            let variable = visible_devices_variable(accelerator_vendor);
            command.arg(format!("export {variable}={index}; exec \"${{SHELL:-/bin/sh}}\" -l"));
        }
        let child = pair.slave.spawn_command(command).map_err(|error| format!("无法启动 SSH 终端：{error}"))?;
        if let Some(channel) = &password_channel { channel.bind_child(child.process_id()); }
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|error| format!("无法读取终端输出：{error}"))?;
        let writer = pair.master.take_writer().map_err(|error| format!("无法写入终端：{error}"))?;
        let session_id = Uuid::new_v4().to_string();
        let event_session_id = session_id.clone();
        let close_password_channel = password_channel.as_ref().map(|channel| channel.cancellation());

        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(length) => {
                        let _ = app.emit("terminal-output", TerminalOutput {
                            session_id: event_session_id.clone(),
                            data: STANDARD.encode(&buffer[..length]),
                        });
                    }
                }
            }
            if let Some(close) = close_password_channel { close(); }
            let _ = app.emit("terminal-exit", TerminalExit { session_id: event_session_id });
        });

        self.sessions.lock().map_err(|error| error.to_string())?.insert(session_id.clone(), TerminalSession {
            server_id: server.id.clone(),
            authorization_epoch,
            writer,
            child,
            master: pair.master,
            _password_channel: password_channel,
        });
        Ok(session_id)
    }

    pub fn write(&self, database: &crate::storage::Database, session_id: &str, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|error| error.to_string())?;
        Self::validate_session(&mut sessions, database, session_id)?;
        let session = sessions.get_mut(session_id).ok_or("终端会话已关闭")?;
        session.writer.write_all(data).and_then(|_| session.writer.flush()).map_err(|error| format!("终端写入失败：{error}"))
    }

    pub fn resize(&self, database: &crate::storage::Database, session_id: &str, columns: u16, rows: u16) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|error| error.to_string())?;
        Self::validate_session(&mut sessions, database, session_id)?;
        let session = sessions.get(session_id).ok_or("终端会话已关闭")?;
        session.master.resize(PtySize { rows: rows.max(2), cols: columns.max(2), pixel_width: 0, pixel_height: 0 }).map_err(|error| format!("终端尺寸调整失败：{error}"))
    }

    fn validate_session(sessions: &mut HashMap<String, TerminalSession>, database: &crate::storage::Database, id: &str) -> Result<(), String> {
        let session = sessions.get(id).ok_or("终端会话已关闭")?;
        if let Some(epoch) = session.authorization_epoch {
            if database.managed_epoch(&session.server_id)? != Some(epoch) || database.get_server(&session.server_id).is_err() {
                if let Some(mut session) = sessions.remove(id) { let _ = session.child.kill(); }
                return Err("组织服务器权限已变化，终端已关闭".into());
            }
        }
        Ok(())
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let Some(mut session) = self.sessions.lock().map_err(|error| error.to_string())?.remove(session_id) else { return Ok(()); };
        session.child.kill().map_err(|error| format!("终端关闭失败：{error}"))
    }

    pub fn close_servers(&self, ids: &[String]) {
        if let Ok(mut sessions) = self.sessions.lock() {
            let matching: Vec<_> = sessions.iter().filter(|(_, session)| ids.contains(&session.server_id)).map(|(id, _)| id.clone()).collect();
            for id in matching { if let Some(mut session) = sessions.remove(&id) { let _ = session.child.kill(); } }
        }
    }

    pub fn close_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, mut session) in sessions.drain() {
                let _ = session.child.kill();
            }
        }
    }
}

fn configured_ssh_command(server: &Server, password: Option<&crate::ssh_connection::SshPasswords>) -> Result<(CommandBuilder, Option<crate::askpass::Broker>), String> {
    configured_ssh_command_mode(server, password, false)
}

fn configured_ssh_command_mode(server: &Server, password: Option<&crate::ssh_connection::SshPasswords>, shared: bool) -> Result<(CommandBuilder, Option<crate::askpass::Broker>), String> {
    let mut command = CommandBuilder::new("ssh");
    if shared { command.args(shared_ssh_restrictions()); }
    command.arg("-tt");
    let options = crate::ssh_connection::options(server, password, None)?;
    for key in crate::ssh_connection::INHERITED_ASKPASS_ENV { command.env_remove(key); }
    command.args(options.args);
    for (key, value) in options.env { command.env(key, value); }
    if let Some(identity) = explicit_identity_file(server) {
        let identity = expand_identity_path(identity);
        // OpenSSH's explicit -i missing-file warning bypasses -E/LogLevel and
        // would reveal the owner's local path on a PTY. Fail without that path.
        if shared && (!identity.is_file() || std::fs::File::open(&identity).is_err()) {
            return Err("共享方配置的 SSH 私钥文件不存在或不可读，请让共享方检查服务器认证设置".into());
        }
        command.args(["-o", "IdentitiesOnly=yes"]);
        command.arg("-i");
        command.arg(identity);
    }
    if let Some(alias) = server.ssh_alias.as_deref().filter(|value| !value.is_empty()) {
        command.arg(alias);
    } else {
        command.args(["-p", &server.port.to_string(), &format!("{}@{}", server.username, server.host)]);
    }
    Ok((command, options.broker))
}

/// These options precede user SSH configuration: OpenSSH keeps the first value.
/// In particular, a guest must never reach the owner's agent or local commands
/// through the interactive SSH escape menu.
pub(crate) fn shared_ssh_restrictions() -> Vec<&'static str> {
    #[cfg(windows)]
    let diagnostic_sink = "NUL";
    #[cfg(not(windows))]
    let diagnostic_sink = "/dev/null";
    vec!["-e", "none", "-o", "ForwardAgent=no", "-o", "ForwardX11=no",
        "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no",
        "-o", "LocalCommand=none", "-o", "RemoteCommand=none",
        "-o", "ControlMaster=no", "-o", "ControlPath=none",
        "-E", diagnostic_sink, "-o", "LogLevel=QUIET"]
}

pub(crate) fn quote_remote_path(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 4096 || value.chars().any(|c| c == '\0' || c == '\r' || c == '\n') {
        return Err("共享默认目录无效".into());
    }
    if value == "~" { return Ok("\"$HOME\"".into()); }
    if let Some(suffix) = value.strip_prefix("~/") {
        return Ok(format!("\"$HOME\"/'{}'", suffix.replace('\'', "'\\''")));
    }
    Ok(format!("'{}'", value.replace('\'', "'\\''")))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SharedTerminalScope {
    pub peer_id: String,
    pub share_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SharedTerminalEvent {
    Data { #[serde(rename = "sessionId")] session_id: String, #[serde(rename = "dataBase64")] data_base64: String },
    Exit { #[serde(rename = "sessionId")] session_id: String },
}

struct SharedSession {
    scope: SharedTerminalScope,
    input: mpsc::SyncSender<Vec<u8>>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    _password_channel: Option<crate::askpass::Broker>,
}

/// Shared terminals have their own bounded output sink. They never emit Tauri
/// events, even when the owner has another local terminal open.
#[derive(Default)]
pub struct SharedTerminalManager {
    sessions: Arc<Mutex<HashMap<String, SharedSession>>>,
}

impl SharedTerminalManager {
    pub fn start(&self, server: &Server, password: Option<&crate::ssh_connection::SshPasswords>, scope: &SharedTerminalScope,
        columns: u16, rows: u16, default_path: &str, events: tokio::sync::mpsc::Sender<SharedTerminalEvent>) -> Result<String, String> {
        let directory = quote_remote_path(default_path)?;
        let mut sessions = self.sessions.lock().map_err(|_| "共享终端不可用")?;
        if sessions.len() >= 4 { return Err("每个共享连接最多打开 4 个终端".into()); }
        let pair = native_pty_system().openpty(PtySize { rows: rows.clamp(2, 500), cols: columns.clamp(2, 500), pixel_width: 0, pixel_height: 0 })
            .map_err(|error| format!("无法创建共享终端：{error}"))?;
        let (mut command, password_channel) = configured_ssh_command_mode(server, password, true)?;
        command.arg(format!("cd -- {directory} && exec \"${{SHELL:-/bin/sh}}\" -l"));
        let mut reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|error| error.to_string())?;
        let mut child = pair.slave.spawn_command(command).map_err(|_| "无法启动共享 SSH，请让共享方检查本机 SSH 环境")?;
        if let Some(channel) = &password_channel { channel.bind_child(child.process_id()); }
        drop(pair.slave);
        let killer = child.clone_killer();
        let mut output_killer = child.clone_killer();
        let mut input_killer = child.clone_killer();
        let (input, receiver) = mpsc::sync_channel::<Vec<u8>>(16);
        let id = Uuid::new_v4().to_string();
        sessions.insert(id.clone(), SharedSession { scope: scope.clone(), input, killer, master: pair.master, _password_channel: password_channel });
        drop(sessions);
        thread::spawn(move || {
            while let Ok(data) = receiver.recv() {
                if writer.write_all(&data).and_then(|_| writer.flush()).is_err() { break; }
            }
            let _ = input_killer.kill();
        });
        let sessions = self.sessions.clone();
        let output_id = id.clone();
        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(length) => {
                        if events.try_send(SharedTerminalEvent::Data { session_id: output_id.clone(), data_base64: STANDARD.encode(&buffer[..length]) }).is_err() {
                            // A slow/disconnected guest may not grow owner memory.
                            let _ = output_killer.kill();
                            break;
                        }
                    }
                }
            }
            let _ = output_killer.kill();
            let _ = child.wait();
            if let Ok(mut sessions) = sessions.lock() { sessions.remove(&output_id); }
            let _ = events.try_send(SharedTerminalEvent::Exit { session_id: output_id });
        });
        Ok(id)
    }

    pub fn write(&self, scope: &SharedTerminalScope, id: &str, data: &[u8]) -> Result<(), String> {
        if data.len() > 48 * 1024 { return Err("单次终端输入超过 48 KiB".into()); }
        let mut sessions = self.sessions.lock().map_err(|_| "共享终端不可用")?;
        let session = sessions.get_mut(id).ok_or("共享终端已关闭")?;
        if &session.scope != scope { return Err("终端不属于当前共享连接".into()); }
        if session.input.try_send(data.to_vec()).is_err() {
            let _ = session.killer.kill();
            sessions.remove(id);
            return Err("共享终端输入队列已满或已关闭".into());
        }
        Ok(())
    }

    pub fn resize(&self, scope: &SharedTerminalScope, id: &str, columns: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|_| "共享终端不可用")?;
        let session = sessions.get(id).ok_or("共享终端已关闭")?;
        if &session.scope != scope { return Err("终端不属于当前共享连接".into()); }
        session.master.resize(PtySize { rows: rows.clamp(2, 500), cols: columns.clamp(2, 500), pixel_width: 0, pixel_height: 0 }).map_err(|error| error.to_string())
    }

    pub fn close(&self, scope: &SharedTerminalScope, id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|_| "共享终端不可用")?;
        if let Some(session) = sessions.get(id) {
            if &session.scope != scope { return Err("终端不属于当前共享连接".into()); }
        }
        if let Some(mut session) = sessions.remove(id) { let _ = session.killer.kill(); }
        Ok(())
    }

    pub fn cleanup_scope(&self, scope: &SharedTerminalScope) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.retain(|_, session| {
                if &session.scope != scope { return true; }
                let _ = session.killer.kill();
                false
            });
        }
    }
}

impl Drop for SharedTerminalManager {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, mut session) in sessions.drain() { let _ = session.killer.kill(); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gpu_terminal_starts_with_a_fixed_export() {
        let command = format!("export CUDA_VISIBLE_DEVICES={}; exec \"${{SHELL:-/bin/sh}}\" -l", 3);
        assert_eq!(command, "export CUDA_VISIBLE_DEVICES=3; exec \"${SHELL:-/bin/sh}\" -l");
    }

    #[test]
    fn shared_terminal_disables_owner_side_ssh_features_before_saved_options() {
        let mut server: Server = serde_json::from_value(serde_json::json!({"id":"fixture","name":"fixture",
            "host":"example.invalid","port":22,"username":"worker","tags":[],"samplingIntervalSeconds":2,
            "historyRetentionDays":90,"authMethod":"sshAgent","status":"unknown"})).unwrap();
        let (command, _channel) = configured_ssh_command_mode(&server, None, true).unwrap();
        let args: Vec<_> = command.get_argv().iter().map(|arg| arg.to_string_lossy().to_string()).collect();
        assert_eq!(&args[..5], ["ssh", "-e", "none", "-o", "ForwardAgent=no"]);
        for option in ["ForwardX11=no", "ClearAllForwardings=yes", "PermitLocalCommand=no", "LocalCommand=none", "RemoteCommand=none", "StrictHostKeyChecking=yes", "LogLevel=QUIET"] {
            assert!(args.iter().any(|arg| arg == option));
        }
        let sink = if cfg!(windows) { "NUL" } else { "/dev/null" };
        assert!(args.windows(2).any(|pair| pair == ["-E", sink]));
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing-owner-identity");
        server.auth_method = "privateKey".into();
        server.identity_file = Some(missing.to_string_lossy().to_string());
        let error = configured_ssh_command_mode(&server, None, true).unwrap_err();
        assert!(!error.contains("missing-owner-identity"));
        assert!(!error.contains(&directory.path().to_string_lossy().to_string()));
    }

    #[test]
    #[cfg(unix)]
    fn remote_directory_quoting_preserves_shell_metacharacters_as_literal_bytes() {
        let path = "/tmp/a'b $HOME $(printf injected); *";
        let output = std::process::Command::new("/bin/sh").args(["-c", &format!("printf '%s' {}", quote_remote_path(path).unwrap())]).output().unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, path.as_bytes());
        assert!(quote_remote_path("bad\npath").is_err());
    }

    #[derive(Clone, Debug)]
    struct TestKiller(Arc<std::sync::atomic::AtomicBool>);
    impl portable_pty::ChildKiller for TestKiller {
        fn kill(&mut self) -> std::io::Result<()> { self.0.store(true, std::sync::atomic::Ordering::SeqCst); Ok(()) }
        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> { Box::new(self.clone()) }
    }

    #[test]
    #[cfg(unix)]
    fn shared_scope_cannot_write_resize_close_or_clean_another_terminal_and_input_is_bounded() {
        let manager = SharedTerminalManager::default();
        let scope = SharedTerminalScope { peer_id: "peer-a".into(), share_id: "share-a".into() };
        let other_peer = SharedTerminalScope { peer_id: "peer-b".into(), share_id: "share-a".into() };
        let other_share = SharedTerminalScope { peer_id: "peer-a".into(), share_id: "share-b".into() };
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (input, receiver) = mpsc::sync_channel(2);
        manager.sessions.lock().unwrap().insert("session".into(), SharedSession {
            scope: scope.clone(), input, killer: Box::new(TestKiller(killed.clone())), master: pair.master, _password_channel: None,
        });
        for foreign in [&other_peer, &other_share] {
            assert!(manager.write(foreign, "session", b"forbidden").is_err());
            assert!(manager.resize(foreign, "session", 80, 24).is_err());
            assert!(manager.close(foreign, "session").is_err());
            manager.cleanup_scope(foreign);
        }
        assert!(receiver.try_recv().is_err());
        assert!(!killed.load(std::sync::atomic::Ordering::SeqCst));
        manager.write(&scope, "session", b"one").unwrap();
        manager.write(&scope, "session", b"two").unwrap();
        assert!(manager.write(&scope, "session", b"over capacity").is_err());
        assert!(killed.load(std::sync::atomic::Ordering::SeqCst));
        assert!(manager.sessions.lock().unwrap().is_empty());
    }
}

#[cfg(feature = "integration-probe")]
pub fn password_probe(server: &Server, password: Option<&crate::ssh_connection::SshPasswords>) -> Result<String, String> {
    use std::io::Read;
    let pty = native_pty_system();
    let pair = pty.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let (mut command, password_channel) = configured_ssh_command(server, password)?;
    command.arg("printf 'racktop-terminal-ok\\n'");
    let mut child = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
    if let Some(channel) = &password_channel { channel.bind_child(child.process_id()); }
    drop(pair.slave);
    let mut text = String::new();
    pair.master.try_clone_reader().map_err(|e| e.to_string())?.read_to_string(&mut text).map_err(|e| e.to_string())?;
    let result = child.wait().map_err(|e| e.to_string())?;
    if !result.success() { return Err(text); }
    Ok(text)
}
