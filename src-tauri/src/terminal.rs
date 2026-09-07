use crate::{collector::{explicit_identity_file, visible_devices_variable}, models::Server};
use crate::ssh_keys::expand_identity_path;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Mutex,
    thread,
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

struct TerminalSession {
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
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

        let mut command = configured_ssh_command(server, password)?;
        if let Some(index) = gpu_index {
            let variable = visible_devices_variable(accelerator_vendor);
            command.arg(format!("export {variable}={index}; exec \"${{SHELL:-/bin/sh}}\" -l"));
        }
        let child = pair.slave.spawn_command(command).map_err(|error| format!("无法启动 SSH 终端：{error}"))?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|error| format!("无法读取终端输出：{error}"))?;
        let writer = pair.master.take_writer().map_err(|error| format!("无法写入终端：{error}"))?;
        let session_id = Uuid::new_v4().to_string();
        let event_session_id = session_id.clone();

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
            let _ = app.emit("terminal-exit", TerminalExit { session_id: event_session_id });
        });

        self.sessions.lock().map_err(|error| error.to_string())?.insert(session_id.clone(), TerminalSession {
            writer,
            child,
            master: pair.master,
        });
        Ok(session_id)
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|error| error.to_string())?;
        let session = sessions.get_mut(session_id).ok_or("终端会话已关闭")?;
        session.writer.write_all(data).and_then(|_| session.writer.flush()).map_err(|error| format!("终端写入失败：{error}"))
    }

    pub fn resize(&self, session_id: &str, columns: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|error| error.to_string())?;
        let session = sessions.get(session_id).ok_or("终端会话已关闭")?;
        session.master.resize(PtySize { rows: rows.max(2), cols: columns.max(2), pixel_width: 0, pixel_height: 0 }).map_err(|error| format!("终端尺寸调整失败：{error}"))
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let Some(mut session) = self.sessions.lock().map_err(|error| error.to_string())?.remove(session_id) else { return Ok(()); };
        session.child.kill().map_err(|error| format!("终端关闭失败：{error}"))
    }

    pub fn close_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, mut session) in sessions.drain() {
                let _ = session.child.kill();
            }
        }
    }
}

fn configured_ssh_command(server: &Server, password: Option<&crate::ssh_connection::SshPasswords>) -> Result<CommandBuilder, String> {
    let mut command = CommandBuilder::new("ssh");
    command.arg("-tt");
    let options = crate::ssh_connection::options(server, password, None)?;
    command.args(options.args);
    for (key, value) in options.env { command.env(key, value); }
    if let Some(identity) = explicit_identity_file(server) {
        command.args(["-o", "IdentitiesOnly=yes"]);
        command.arg("-i");
        command.arg(expand_identity_path(identity));
    }
    if let Some(alias) = server.ssh_alias.as_deref().filter(|value| !value.is_empty()) {
        command.arg(alias);
    } else {
        command.args(["-p", &server.port.to_string(), &format!("{}@{}", server.username, server.host)]);
    }
    Ok(command)
}

#[cfg(test)]
mod tests {
    #[test]
    fn gpu_terminal_starts_with_a_fixed_export() {
        let command = format!("export CUDA_VISIBLE_DEVICES={}; exec \"${{SHELL:-/bin/sh}}\" -l", 3);
        assert_eq!(command, "export CUDA_VISIBLE_DEVICES=3; exec \"${SHELL:-/bin/sh}\" -l");
    }
}

#[cfg(feature = "integration-probe")]
pub fn password_probe(server: &Server, password: Option<&crate::ssh_connection::SshPasswords>) -> Result<String, String> {
    use std::io::Read;
    let pty = native_pty_system();
    let pair = pty.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let mut command = configured_ssh_command(server, password)?;
    command.arg("printf 'racktop-terminal-ok\\n'");
    let mut child = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut text = String::new();
    pair.master.try_clone_reader().map_err(|e| e.to_string())?.read_to_string(&mut text).map_err(|e| e.to_string())?;
    let result = child.wait().map_err(|e| e.to_string())?;
    if !result.success() { return Err(text); }
    Ok(text)
}
