//! Scope-bound owner-side SSH operations. The caller authenticates the device and
//! share first, then constructs one instance from owner database records only.
pub use crate::terminal::{SharedTerminalEvent, SharedTerminalScope as OperationScope};
use crate::{
    collector::explicit_identity_file, models::Server, ssh_connection::SshPasswords,
    ssh_keys::expand_identity_path, terminal::SharedTerminalManager,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Mutex, mpsc, oneshot, watch},
    time::timeout,
};

const MAX_CHUNK: usize = 48 * 1024;
const MAX_LINE: usize = 128 * 1024;
const RPC_TIMEOUT: Duration = Duration::from_secs(30);
const REMOTE_WORKER: &str = include_str!("remote_files.py");

pub struct GatewayOps {
    server: Server,
    passwords: SshPasswords,
    scope: OperationScope,
    default_path: String,
    events: mpsc::Sender<SharedTerminalEvent>,
    terminals: SharedTerminalManager,
    files: Mutex<Option<RemoteFiles>>,
    closed: AtomicBool,
}

impl GatewayOps {
    pub fn new(
        server: Server,
        passwords: SshPasswords,
        scope: OperationScope,
        default_path: String,
        events: mpsc::Sender<SharedTerminalEvent>,
    ) -> Result<Self, String> {
        if scope.peer_id.is_empty() || scope.share_id.is_empty() {
            return Err("共享连接身份无效".into());
        }
        crate::terminal::quote_remote_path(&default_path)?;
        Ok(Self {
            server,
            passwords,
            scope,
            default_path,
            events,
            terminals: SharedTerminalManager::default(),
            files: Mutex::new(None),
            closed: AtomicBool::new(false),
        })
    }

    fn validate_scope(&self, scope: &OperationScope) -> Result<(), String> {
        if scope != &self.scope {
            return Err("操作不属于当前设备和共享资源".into());
        }
        if self.closed.load(Ordering::Acquire) {
            return Err("共享连接已关闭".into());
        }
        Ok(())
    }

    pub async fn handle(
        &self,
        scope: &OperationScope,
        method: &str,
        params: &Value,
    ) -> Result<Value, String> {
        self.validate_scope(scope)?;
        if !params.is_object() {
            return Err("操作参数必须是对象".into());
        }
        match method {
            "terminal.start" => {
                let columns = dimension(params, "columns", 100)?;
                let rows = dimension(params, "rows", 30)?;
                // Starting SSH only creates a local PTY/child; the network login
                // happens asynchronously in the SSH child, bounded by its timeout.
                let session_id = self.terminals.start(
                    &self.server,
                    Some(&self.passwords),
                    scope,
                    columns,
                    rows,
                    &self.default_path,
                    self.events.clone(),
                )?;
                // Disconnect may have raced a synchronous PTY spawn.
                if self.closed.load(Ordering::Acquire) {
                    let _ = self.terminals.close(scope, &session_id);
                    return Err("共享连接已关闭".into());
                }
                Ok(json!({"sessionId": session_id}))
            }
            "terminal.write" => {
                let id = string(params, "sessionId")?;
                let encoded = string(params, "dataBase64")?;
                if encoded.len() > MAX_CHUNK.div_ceil(3) * 4 {
                    return Err("单次终端输入超过 48 KiB".into());
                }
                let data = STANDARD
                    .decode(encoded)
                    .map_err(|_| "终端输入不是有效的 Base64")?;
                self.terminals.write(scope, id, &data)?;
                Ok(json!({"written": data.len()}))
            }
            "terminal.resize" => {
                self.terminals.resize(
                    scope,
                    string(params, "sessionId")?,
                    dimension(params, "columns", 100)?,
                    dimension(params, "rows", 30)?,
                )?;
                Ok(json!({"resized": true}))
            }
            "terminal.close" => {
                self.terminals.close(scope, string(params, "sessionId")?)?;
                Ok(json!({"closed": true}))
            }
            "files.list" | "files.read_open" | "files.read_chunk" | "files.read_close"
            | "files.write_open" | "files.write_chunk" | "files.write_commit"
            | "files.write_cancel" => {
                // The actor and all of its transfer handles belong to this fixed
                // scope. Guests cannot send init, change root, or choose an SSH host.
                let sender = {
                    let mut files = self.files.lock().await;
                    self.validate_scope(scope)?;
                    if files.is_none() {
                        *files = Some(RemoteFiles::start(
                            &self.server,
                            &self.passwords,
                            &self.default_path,
                        )?);
                    }
                    files.as_ref().unwrap().sender.clone()
                };
                let (reply, response) = oneshot::channel();
                sender
                    .try_send(FileRequest {
                        method: method.trim_start_matches("files.").into(),
                        params: params.clone(),
                        reply,
                    })
                    .map_err(|_| "共享文件请求队列已满或连接已关闭")?;
                // A cancelled caller does not cancel a half-written JSON request:
                // the actor finishes/drains it and keeps stream framing intact.
                timeout(Duration::from_secs(35), response)
                    .await
                    .map_err(|_| "共享文件操作超时")?
                    .map_err(|_| "共享文件 SSH 连接已关闭")?
            }
            _ => Err("不支持的共享操作".into()),
        }
    }

    pub async fn cleanup_scope(&self, scope: &OperationScope) -> Result<(), String> {
        if scope != &self.scope {
            return Err("操作不属于当前设备和共享资源".into());
        }
        self.closed.store(true, Ordering::Release);
        self.terminals.cleanup_scope(scope);
        let files = self.files.lock().await.take();
        if let Some(mut files) = files {
            files.close().await;
        }
        Ok(())
    }
}

impl Drop for GatewayOps {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
        self.terminals.cleanup_scope(&self.scope);
        // RemoteFiles::drop signals its actor; it closes stdin so the remote
        // worker can remove its own temporary files before SSH is killed.
    }
}

fn string<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("缺少字符串参数 {key}"))
}
fn dimension(params: &Value, key: &str, default: u16) -> Result<u16, String> {
    match params.get(key) {
        None => Ok(default),
        Some(value) => value
            .as_u64()
            .filter(|value| (2..=500).contains(value))
            .map(|value| value as u16)
            .ok_or_else(|| format!("终端 {key} 必须在 2 到 500 之间")),
    }
}

struct FileRequest {
    method: String,
    params: Value,
    reply: oneshot::Sender<Result<Value, String>>,
}
struct RemoteFiles {
    sender: mpsc::Sender<FileRequest>,
    stop: watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl RemoteFiles {
    fn start(server: &Server, passwords: &SshPasswords, root: &str) -> Result<Self, String> {
        Self::spawn(remote_command(server, passwords)?, root)
    }
    fn spawn(mut command: Command, root: &str) -> Result<Self, String> {
        let mut child = command.spawn().map_err(|_| "无法启动共享文件 SSH 进程")?;
        let stdin = child.stdin.take().ok_or("无法打开共享文件输入")?;
        let stdout = child.stdout.take().ok_or("无法打开共享文件输出")?;
        let mut stderr = child.stderr.take().ok_or("无法打开共享文件错误流")?;
        let (sender, requests) = mpsc::channel(8);
        let (stop, stopped) = watch::channel(false);
        let root = root.to_string();
        let task = tokio::spawn(async move {
            // Drain diagnostics without accumulating or exposing owner hostnames,
            // SSH configuration paths, credentials, or remote absolute paths.
            let diagnostics = tokio::spawn(async move {
                let mut buffer = [0u8; 4096];
                loop {
                    match stderr.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                }
            });
            file_actor(&mut child, stdin, stdout, requests, stopped, root).await;
            diagnostics.abort();
        });
        Ok(Self {
            sender,
            stop,
            task: Some(task),
        })
    }
    async fn close(&mut self) {
        let _ = self.stop.send(true);
        if let Some(mut task) = self.task.take() {
            if timeout(Duration::from_secs(4), &mut task).await.is_err() {
                task.abort();
            }
        }
    }
}
impl Drop for RemoteFiles {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}

fn remote_command(server: &Server, passwords: &SshPasswords) -> Result<Command, String> {
    let mut command = Command::new("ssh");
    command
        .args(crate::terminal::shared_ssh_restrictions())
        .arg("-T");
    let options = crate::ssh_connection::options(server, Some(passwords), None)?;
    command.args(options.args).envs(options.env);
    if let Some(identity) = explicit_identity_file(server) {
        command
            .args(["-o", "IdentitiesOnly=yes", "-i"])
            .arg(expand_identity_path(identity));
    }
    if let Some(alias) = server
        .ssh_alias
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        command.arg(alias);
    } else {
        command.args([
            "-p",
            &server.port.to_string(),
            &format!("{}@{}", server.username, server.host),
        ]);
    }
    command.arg(format!(
        "python3 -u -c '{}'",
        REMOTE_WORKER.replace('\'', "'\\''")
    ));
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    Ok(command)
}

async fn file_actor(
    child: &mut Child,
    mut stdin: ChildStdin,
    stdout: ChildStdout,
    mut requests: mpsc::Receiver<FileRequest>,
    mut stopped: watch::Receiver<bool>,
    root: String,
) {
    let mut stdout = BufReader::with_capacity(8192, stdout);
    let init_params = json!({"root": root});
    let initialized = tokio::select! {
        biased;
        _ = stopped.changed() => false,
        result = timeout(RPC_TIMEOUT, exchange(&mut stdin, &mut stdout, 0, "init", &init_params)) =>
            matches!(result, Ok(Ok(Ok(_)))),
    };
    let mut sequence = 1u64;
    if initialized {
        loop {
            let request = tokio::select! {
                biased;
                _ = stopped.changed() => break,
                request = requests.recv() => match request { Some(request) => request, None => break },
            };
            if request.reply.is_closed() {
                continue;
            }
            let result = tokio::select! {
                biased;
                _ = stopped.changed() => { let _ = request.reply.send(Err("共享连接已关闭".into())); break; },
                result = timeout(RPC_TIMEOUT, exchange(&mut stdin, &mut stdout, sequence, &request.method, &request.params)) => result,
            };
            sequence += 1;
            match result {
                Ok(Ok(value)) => {
                    // A cancelled open/chunk may have created a handle or advanced
                    // an offset the caller never received. Close the actor and
                    // clean its temporary files instead of leaving orphan state.
                    if request.reply.send(value).is_err() {
                        break;
                    }
                }
                Ok(Err(error)) => {
                    let _ = request.reply.send(Err(error));
                    break;
                }
                Err(_) => {
                    let _ = request
                        .reply
                        .send(Err("共享文件操作超时；连接已关闭".into()));
                    break;
                }
            }
        }
    }
    requests.close();
    while let Some(request) = requests.recv().await {
        let _ = request
            .reply
            .send(Err("共享文件 SSH 连接已关闭，请重新连接共享资源".into()));
    }
    let _ = stdin.shutdown().await;
    drop(stdin);
    // EOF lets the remote worker remove private upload temporary files. If SSH
    // does not exit promptly, force-kill and reap it rather than leak a child.
    if timeout(Duration::from_secs(2), child.wait()).await.is_err() {
        let _ = child.start_kill();
        let _ = timeout(Duration::from_secs(1), child.wait()).await;
    }
}

// Outer Result errors poison the transport. Inner Result errors are ordinary
// worker errors (conflict, invalid path, changed source) and preserve framing.
async fn exchange(
    stdin: &mut ChildStdin,
    stdout: &mut BufReader<ChildStdout>,
    id: u64,
    method: &str,
    params: &Value,
) -> Result<Result<Value, String>, String> {
    let mut encoded = serde_json::to_vec(&json!({"id": id, "method": method, "params": params}))
        .map_err(|_| "无效的共享文件请求")?;
    if encoded.len() > 70 * 1024 {
        return Ok(Err("共享文件请求过大".into()));
    }
    encoded.push(b'\n');
    stdin
        .write_all(&encoded)
        .await
        .map_err(|_| "共享文件 SSH 输入已关闭")?;
    stdin.flush().await.map_err(|_| "共享文件 SSH 输入已关闭")?;
    let mut line = Vec::with_capacity(8192);
    loop {
        let available = stdout
            .fill_buf()
            .await
            .map_err(|_| "共享文件 SSH 输出不可读")?;
        if available.is_empty() {
            return Err("共享文件 SSH 已关闭；请让共享方检查 SSH 和远端 Python 3".into());
        }
        let length = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if line.len() + length > MAX_LINE {
            return Err("共享文件响应超过安全上限".into());
        }
        line.extend_from_slice(&available[..length]);
        stdout.consume(length);
        if line.last() == Some(&b'\n') {
            break;
        }
    }
    let response: Value =
        serde_json::from_slice(&line).map_err(|_| "共享文件 SSH 返回了无效协议")?;
    if response.get("id").and_then(Value::as_u64) != Some(id) {
        return Err("共享文件响应编号不匹配".into());
    }
    if let Some(error) = response.get("error") {
        let code = error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("remote_error");
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("共享文件操作失败");
        return Ok(Err(format!("{code}: {message}")));
    }
    response
        .get("result")
        .cloned()
        .map(Ok)
        .ok_or_else(|| "共享文件响应缺少结果".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    fn server() -> Server {
        serde_json::from_value(
            json!({"id":"fixture","name":"fixture","host":"example.invalid","port":22,
            "username":"worker","tags":[],"samplingIntervalSeconds":2,"historyRetentionDays":90,
            "authMethod":"sshAgent","status":"unknown"}),
        )
        .unwrap()
    }
    #[tokio::test]
    async fn foreign_scope_and_closed_connection_never_start_ssh() {
        let scope = OperationScope {
            peer_id: "peer-a".into(),
            share_id: "share-a".into(),
        };
        let (events, _) = mpsc::channel(2);
        let ops = GatewayOps::new(
            server(),
            SshPasswords::default(),
            scope.clone(),
            "/tmp".into(),
            events,
        )
        .unwrap();
        let foreign = OperationScope {
            peer_id: "peer-b".into(),
            share_id: "share-a".into(),
        };
        for method in [
            "terminal.start",
            "terminal.write",
            "terminal.resize",
            "terminal.close",
            "files.list",
            "files.write_chunk",
        ] {
            assert!(
                ops.handle(&foreign, method, &json!({}))
                    .await
                    .unwrap_err()
                    .contains("不属于")
            );
        }
        assert!(
            ops.handle(&scope, "files.init", &json!({"root":"/"}))
                .await
                .is_err()
        );
        assert!(ops.files.lock().await.is_none());
        ops.cleanup_scope(&scope).await.unwrap();
        assert!(
            ops.handle(&scope, "files.list", &json!({"path":""}))
                .await
                .unwrap_err()
                .contains("已关闭")
        );
    }
    #[test]
    fn file_ssh_options_precede_config_and_never_contain_secrets() {
        let passwords = SshPasswords {
            target: Some("never-disclose".into()),
            proxy: None,
        };
        let command = remote_command(&server(), &passwords).unwrap();
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert_eq!(&args[..4], ["-e", "none", "-o", "ForwardAgent=no"]);
        assert!(args.iter().any(|arg| arg == "StrictHostKeyChecking=yes"));
        assert!(args.iter().any(|arg| arg == "ClearAllForwardings=yes"));
        assert!(!args.join(" ").contains("never-disclose"));
        assert!(args.last().unwrap().starts_with("python3 -u -c '"));
    }

    fn local_worker(root: &std::path::Path) -> RemoteFiles {
        let mut command = Command::new("python3");
        command
            .args(["-u", "-c", REMOTE_WORKER])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        RemoteFiles::spawn(command, root.to_str().unwrap()).unwrap()
    }
    async fn call(files: &RemoteFiles, method: &str, params: Value) -> Result<Value, String> {
        let (reply, response) = oneshot::channel();
        assert!(
            files
                .sender
                .try_send(FileRequest {
                    method: method.into(),
                    params,
                    reply
                })
                .is_ok()
        );
        timeout(Duration::from_secs(3), response)
            .await
            .unwrap()
            .unwrap()
    }

    #[tokio::test]
    #[cfg(target_os = "linux")]
    async fn actor_round_trip_checks_hash_offsets_and_conflicts_with_real_python() {
        let directory = tempfile::tempdir().unwrap();
        let mut files = local_worker(directory.path());
        let data = vec![0xa5u8; MAX_CHUNK];
        let digest = format!("{:x}", Sha256::digest(&data));
        let opened = call(
            &files,
            "write_open",
            json!({"path":"round-trip.bin","size":data.len()}),
        )
        .await
        .unwrap();
        let id = opened["transferId"].as_str().unwrap();
        let chunk = call(
            &files,
            "write_chunk",
            json!({"transferId":id,"offset":0,"dataBase64":STANDARD.encode(&data)}),
        )
        .await
        .unwrap();
        assert_eq!(chunk["nextOffset"], data.len());
        let committed = call(
            &files,
            "write_commit",
            json!({"transferId":id,"sha256":digest}),
        )
        .await
        .unwrap();
        assert_eq!(committed["sha256"], digest);
        assert!(
            call(&files, "write_open", json!({"path":"round-trip.bin"}))
                .await
                .unwrap_err()
                .starts_with("already_exists:")
        );
        let opened = call(&files, "read_open", json!({"path":"round-trip.bin"}))
            .await
            .unwrap();
        let id = opened["transferId"].as_str().unwrap();
        let chunk = call(
            &files,
            "read_chunk",
            json!({"transferId":id,"offset":0,"maxBytes":MAX_CHUNK}),
        )
        .await
        .unwrap();
        assert_eq!(
            STANDARD
                .decode(chunk["dataBase64"].as_str().unwrap())
                .unwrap(),
            data
        );
        assert_eq!(chunk["eof"], true);
        let closed = call(&files, "read_close", json!({"transferId":id}))
            .await
            .unwrap();
        assert_eq!(closed["sha256"], digest);
        files.close().await;
    }

    #[tokio::test]
    #[cfg(target_os = "linux")]
    async fn actor_disconnect_removes_only_its_pending_upload() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("existing"), b"keep").unwrap();
        let mut files = local_worker(directory.path());
        call(&files, "write_open", json!({"path":"pending"}))
            .await
            .unwrap();
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
        files.close().await;
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        assert_eq!(
            std::fs::read(directory.path().join("existing")).unwrap(),
            b"keep"
        );
        assert!(files.sender.is_closed());
    }
}
