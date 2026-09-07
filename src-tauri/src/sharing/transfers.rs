//! Native, streaming guest-side transfers. Only native dialogs supply local paths;
//! neither JavaScript nor the remote RPC peer chooses a local read/write target.
use super::client::ClientSession;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{OwnedSemaphorePermit, Semaphore},
    time::timeout,
};

const CHUNK_BYTES: usize = 48 * 1024;
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024 * 1024;
const EVENT: &str = "sharing-transfer-progress";
type Events = Arc<dyn Fn(&str, Value) + Send + Sync>;
type RpcFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;

// Private abstraction permits bounded local protocol fixtures in tests, without
// exposing an API through which callers could inject a local filesystem path.
trait FileRemote: Send + Sync {
    fn request<'a>(&'a self, method: &'a str, params: Value) -> RpcFuture<'a>;
    fn is_alive(&self) -> bool;
    fn close(&self);
}
impl FileRemote for ClientSession {
    fn request<'a>(&'a self, method: &'a str, params: Value) -> RpcFuture<'a> {
        Box::pin(ClientSession::request(self, method, params))
    }
    fn is_alive(&self) -> bool {
        ClientSession::is_alive(self)
    }
    fn close(&self) {
        ClientSession::close(self);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferStarted {
    pub transfer_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    transfer_id: String,
    resource_id: String,
    direction: &'static str,
    name: String,
    transferred: u64,
    total: Option<u64>,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip)]
    last_emit: Option<Instant>,
}
impl Progress {
    fn emit(&mut self, events: &Events, force: bool) {
        if force
            || self
                .last_emit
                .is_none_or(|last| last.elapsed() >= Duration::from_millis(150))
        {
            if let Ok(value) = serde_json::to_value(&*self) {
                events(EVENT, value);
            }
            self.last_emit = Some(Instant::now());
        }
    }
}

struct Control {
    resource_id: String,
    cancelled: Arc<AtomicBool>,
}
struct Inner {
    events: Events,
    slots: Arc<Semaphore>,
    controls: Mutex<HashMap<String, Control>>,
}
pub struct TransferManager {
    inner: Arc<Inner>,
}

struct Reservation {
    id: String,
    resource_id: String,
    cancelled: Arc<AtomicBool>,
    _permit: OwnedSemaphorePermit,
    inner: Arc<Inner>,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if let Ok(mut controls) = self.inner.controls.lock() {
            controls.remove(&self.id);
        }
    }
}

impl TransferManager {
    pub fn new(events: Events) -> Self {
        Self {
            inner: Arc::new(Inner {
                events,
                slots: Arc::new(Semaphore::new(4)),
                controls: Mutex::new(HashMap::new()),
            }),
        }
    }

    fn reserve(&self, resource_id: &str) -> Result<Reservation, String> {
        if resource_id.is_empty() {
            return Err("共享资源无效".into());
        }
        let permit = self
            .inner
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| "最多同时传输 4 个文件，请等待或取消已有传输")?;
        let id = uuid::Uuid::new_v4().to_string();
        let cancelled = Arc::new(AtomicBool::new(false));
        self.inner
            .controls
            .lock()
            .map_err(|_| "文件传输状态不可用")?
            .insert(
                id.clone(),
                Control {
                    resource_id: resource_id.into(),
                    cancelled: cancelled.clone(),
                },
            );
        Ok(Reservation {
            id,
            resource_id: resource_id.into(),
            cancelled,
            _permit: permit,
            inner: self.inner.clone(),
        })
    }

    pub async fn upload(
        &self,
        resource_id: &str,
        session: Arc<ClientSession>,
        directory: &str,
    ) -> Result<Option<TransferStarted>, String> {
        let directory = relative_path(directory, true)?;
        if !session.is_alive() {
            return Err("共享资源尚未连接".into());
        }
        let reservation = self.reserve(resource_id)?;
        let Some(file) = rfd::AsyncFileDialog::new()
            .set_title("选择要上传到共享资源的文件")
            .pick_file()
            .await
        else {
            return Ok(None);
        };
        if reservation.cancelled.load(Ordering::Acquire) || !session.is_alive() {
            return Err("共享连接已关闭或传输已取消".into());
        }
        let path = file.path().to_path_buf();
        let name = local_name(&path)?;
        let destination = if directory.is_empty() {
            name.clone()
        } else {
            format!("{directory}/{name}")
        };
        relative_path(&destination, false)?;
        Ok(Some(self.start(
            reservation,
            session,
            "upload",
            destination,
            path,
            name,
        )))
    }

    pub async fn download(
        &self,
        resource_id: &str,
        session: Arc<ClientSession>,
        path: &str,
    ) -> Result<Option<TransferStarted>, String> {
        let path = relative_path(path, false)?;
        if !session.is_alive() {
            return Err("共享资源尚未连接".into());
        }
        let reservation = self.reserve(resource_id)?;
        let name = path.rsplit('/').next().unwrap().to_string();
        // A remote filename is only a suggestion; the native dialog chooses and
        // authorizes the actual destination. Strip native separator/control chars.
        let suggestion: String = name
            .chars()
            .map(|c| {
                if c == '\\' || c == '/' || c.is_control() {
                    '_'
                } else {
                    c
                }
            })
            .collect();
        let Some(file) = rfd::AsyncFileDialog::new()
            .set_title("保存共享资源文件（不会覆盖已有文件）")
            .set_file_name(suggestion)
            .save_file()
            .await
        else {
            return Ok(None);
        };
        if reservation.cancelled.load(Ordering::Acquire) || !session.is_alive() {
            return Err("共享连接已关闭或传输已取消".into());
        }
        Ok(Some(self.start(
            reservation,
            session,
            "download",
            path,
            file.path().to_path_buf(),
            name,
        )))
    }

    fn start(
        &self,
        reservation: Reservation,
        remote: Arc<dyn FileRemote>,
        direction: &'static str,
        remote_path: String,
        local_path: PathBuf,
        name: String,
    ) -> TransferStarted {
        let started = TransferStarted {
            transfer_id: reservation.id.clone(),
        };
        let mut progress = Progress {
            transfer_id: reservation.id.clone(),
            resource_id: reservation.resource_id.clone(),
            direction,
            name,
            transferred: 0,
            total: None,
            status: "running",
            error: None,
            last_emit: None,
        };
        progress.emit(&reservation.inner.events, true);
        tokio::spawn(async move {
            let result = if direction == "upload" {
                upload_file(
                    remote.as_ref(),
                    &remote_path,
                    &local_path,
                    &reservation.cancelled,
                    &mut progress,
                    &reservation.inner.events,
                )
                .await
            } else {
                download_file(
                    remote.as_ref(),
                    &remote_path,
                    &local_path,
                    &reservation.cancelled,
                    &mut progress,
                    &reservation.inner.events,
                )
                .await
            };
            match result {
                Ok(()) => progress.status = "completed",
                Err(Failure::Cancelled) => progress.status = "cancelled",
                Err(Failure::Error(error)) => {
                    progress.status = "error";
                    progress.error = Some(error);
                }
            }
            progress.emit(&reservation.inner.events, true);
            drop(reservation);
        });
        started
    }

    pub fn cancel(&self, transfer_id: &str) -> Result<(), String> {
        let controls = self
            .inner
            .controls
            .lock()
            .map_err(|_| "文件传输状态不可用")?;
        if let Some(control) = controls.get(transfer_id) {
            control.cancelled.store(true, Ordering::Release);
        }
        Ok(())
    }

    pub fn cancel_resource(&self, resource_id: &str) {
        if let Ok(controls) = self.inner.controls.lock() {
            for control in controls
                .values()
                .filter(|control| control.resource_id == resource_id)
            {
                control.cancelled.store(true, Ordering::Release);
            }
        }
    }
}
impl Drop for TransferManager {
    fn drop(&mut self) {
        if let Ok(controls) = self.inner.controls.lock() {
            for control in controls.values() {
                control.cancelled.store(true, Ordering::Release);
            }
        }
    }
}

#[derive(Debug)]
enum Failure {
    Cancelled,
    Error(String),
}
impl From<String> for Failure {
    fn from(error: String) -> Self {
        Self::Error(error)
    }
}
impl From<&str> for Failure {
    fn from(error: &str) -> Self {
        Self::Error(error.into())
    }
}
fn check_cancel(cancelled: &AtomicBool) -> Result<(), Failure> {
    if cancelled.load(Ordering::Acquire) {
        Err(Failure::Cancelled)
    } else {
        Ok(())
    }
}

fn relative_path(value: &str, root_allowed: bool) -> Result<String, String> {
    if root_allowed && (value.is_empty() || value == ".") {
        return Ok(String::new());
    }
    if value.is_empty()
        || value.len() > 4096
        || value.contains('\0')
        || value.split('/').count() > 128
        || value.split('/').any(|part| {
            part.is_empty() || part == "." || part == ".." || part.starts_with(".racktop-upload-")
        })
    {
        return Err("请选择共享根目录内的相对路径".into());
    }
    Ok(value.into())
}
fn local_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "所选文件名必须是有效的 UTF-8".into())
}

fn logical_remote_error(error: &str) -> bool {
    [
        "not_found:",
        "already_exists:",
        "permission_denied:",
        "unsafe_path:",
        "not_directory:",
        "invalid_path:",
        "disk_full:",
        "io_error:",
        "invalid_params:",
        "invalid_transfer:",
        "too_many_transfers:",
        "file_changed:",
        "not_file:",
        "file_too_large:",
        "invalid_offset:",
        "incomplete:",
        "size_mismatch:",
        "hash_mismatch:",
    ]
    .iter()
    .any(|prefix| error.starts_with(prefix))
}
async fn rpc(remote: &dyn FileRemote, method: &str, params: Value) -> Result<Value, String> {
    if !remote.is_alive() {
        return Err("共享连接已断开".into());
    }
    match timeout(Duration::from_secs(35), remote.request(method, params)).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => {
            if !logical_remote_error(&error) {
                remote.close();
            }
            Err(error)
        }
        Err(_) => {
            remote.close();
            Err("文件请求超时，连接已关闭；如正在提交，请先核实目标文件".into())
        }
    }
}
fn protocol_error(remote: &dyn FileRemote) -> String {
    remote.close();
    "文件传输响应校验失败，连接已关闭；不会自动覆盖或重试目标文件".into()
}
fn transfer_id(remote: &dyn FileRemote, value: &Value) -> Result<String, String> {
    value
        .get("transferId")
        .and_then(Value::as_str)
        .filter(|id| id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .map(str::to_string)
        .ok_or_else(|| protocol_error(remote))
}
fn number(remote: &dyn FileRemote, value: &Value, key: &str) -> Result<u64, String> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| protocol_error(remote))
}
fn verified_hash(remote: &dyn FileRemote, value: &Value, expected: &str) -> Result<(), String> {
    match value.get("sha256").and_then(Value::as_str) {
        Some(actual) if actual == expected => Ok(()),
        _ => Err(protocol_error(remote)),
    }
}

#[derive(PartialEq, Eq)]
struct Fingerprint {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    #[cfg(unix)]
    ctime: (i64, i64),
}
impl Fingerprint {
    fn of(metadata: &std::fs::Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            dev: metadata.dev(),
            #[cfg(unix)]
            ino: metadata.ino(),
            #[cfg(unix)]
            ctime: (metadata.ctime(), metadata.ctime_nsec()),
        }
    }
}

async fn upload_file(
    remote: &dyn FileRemote,
    remote_path: &str,
    local_path: &Path,
    cancelled: &AtomicBool,
    progress: &mut Progress,
    events: &Events,
) -> Result<(), Failure> {
    check_cancel(cancelled)?;
    let metadata = tokio::fs::metadata(local_path)
        .await
        .map_err(|_| "无法读取所选文件信息")?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return Err("只能上传不超过 100 GiB 的常规文件".into());
    }
    let mut source = tokio::fs::File::open(local_path)
        .await
        .map_err(|_| "无法打开所选文件")?;
    let metadata = source
        .metadata()
        .await
        .map_err(|_| "无法读取所选文件信息")?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return Err("只能上传不超过 100 GiB 的常规文件".into());
    }
    let initial = Fingerprint::of(&metadata);
    let total = metadata.len();
    progress.total = Some(total);
    progress.emit(events, true);
    check_cancel(cancelled)?;
    let opened = rpc(
        remote,
        "files.write_open",
        json!({"path":remote_path,"size":total}),
    )
    .await?;
    let id = transfer_id(remote, &opened)?;
    if opened.get("path").and_then(Value::as_str) != Some(remote_path)
        || number(remote, &opened, "maxChunkBytes")? != CHUNK_BYTES as u64
    {
        return Err(protocol_error(remote).into());
    }
    let mut committed = false;
    let result: Result<(), Failure> = async {
        let mut hash = Sha256::new();
        let mut buffer = vec![0u8; CHUNK_BYTES];
        let mut offset = 0u64;
        while offset < total {
            check_cancel(cancelled)?;
            if Fingerprint::of(&source.metadata().await.map_err(|_| "无法检查上传源文件")?) != initial { return Err("上传源文件已发生变化，请重新选择文件".into()); }
            let wanted = (total - offset).min(CHUNK_BYTES as u64) as usize;
            source.read_exact(&mut buffer[..wanted]).await.map_err(|_| "上传源文件已变化或无法读取")?;
            if Fingerprint::of(&source.metadata().await.map_err(|_| "无法检查上传源文件")?) != initial { return Err("上传源文件已发生变化，请重新选择文件".into()); }
            hash.update(&buffer[..wanted]);
            let next = offset + wanted as u64;
            let response = rpc(remote, "files.write_chunk", json!({"transferId":id,"offset":offset,"dataBase64":STANDARD.encode(&buffer[..wanted])})).await?;
            if transfer_id(remote, &response)? != id || number(remote, &response, "nextOffset")? != next { return Err(protocol_error(remote).into()); }
            offset = next;
            progress.transferred = offset;
            progress.emit(events, false);
        }
        check_cancel(cancelled)?;
        if Fingerprint::of(&source.metadata().await.map_err(|_| "无法检查上传源文件")?) != initial { return Err("上传源文件已发生变化，请重新选择文件".into()); }
        let digest = format!("{:x}", hash.finalize());
        let response = rpc(remote, "files.write_commit", json!({"transferId":id,"sha256":digest})).await?;
        verified_hash(remote, &response, &digest)?;
        if response.get("path").and_then(Value::as_str) != Some(remote_path) || number(remote, &response, "size")? != total { return Err(protocol_error(remote).into()); }
        // Cancellation racing a successful commit cannot undo publication. Report
        // the completed result honestly and never delete the published file.
        committed = true;
        Ok(())
    }.await;
    if !committed && remote.is_alive() {
        if let Err(error) = rpc(remote, "files.write_cancel", json!({"transferId":id})).await {
            if !error.starts_with("invalid_transfer:") {
                remote.close();
            }
        }
    }
    result
}

async fn download_file(
    remote: &dyn FileRemote,
    remote_path: &str,
    local_path: &Path,
    cancelled: &AtomicBool,
    progress: &mut Progress,
    events: &Events,
) -> Result<(), Failure> {
    check_cancel(cancelled)?;
    // symlink_metadata detects dangling symlinks too: no existing directory entry
    // may be replaced, even if the native save dialog offered overwrite approval.
    match tokio::fs::symlink_metadata(local_path).await {
        Ok(_) => return Err("目标文件已存在，请选择新的文件名；已有文件不会被覆盖".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("无法检查所选保存位置".into()),
    }
    let parent = local_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or("保存目录无效")?
        .to_path_buf();
    let temporary = tokio::task::spawn_blocking(move || {
        tempfile::Builder::new()
            .prefix(".racktop-download-")
            .tempfile_in(parent)
    })
    .await
    .map_err(|_| "无法创建下载临时文件")?
    .map_err(|_| "无法在保存目录创建私有临时文件")?;
    let (file, temporary_path) = temporary.into_parts();
    let mut file = tokio::fs::File::from_std(file);
    check_cancel(cancelled)?;
    let opened = rpc(remote, "files.read_open", json!({"path":remote_path})).await?;
    let id = transfer_id(remote, &opened)?;
    let total = number(remote, &opened, "size")?;
    if total > MAX_FILE_BYTES
        || opened.get("path").and_then(Value::as_str) != Some(remote_path)
        || !opened
            .get("fingerprint")
            .and_then(Value::as_str)
            .is_some_and(|value| {
                value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
    {
        return Err(protocol_error(remote).into());
    }
    progress.total = Some(total);
    progress.emit(events, true);
    let mut remote_closed = false;
    let result: Result<(), Failure> = async {
        let mut hash = Sha256::new();
        let mut offset = 0u64;
        while offset < total {
            check_cancel(cancelled)?;
            let wanted = (total - offset).min(CHUNK_BYTES as u64) as usize;
            let response = rpc(
                remote,
                "files.read_chunk",
                json!({"transferId":id,"offset":offset,"maxBytes":wanted}),
            )
            .await?;
            let encoded = response
                .get("dataBase64")
                .and_then(Value::as_str)
                .ok_or_else(|| protocol_error(remote))?;
            if encoded.len() > CHUNK_BYTES.div_ceil(3) * 4 {
                return Err(protocol_error(remote).into());
            }
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|_| protocol_error(remote))?;
            let next = offset + bytes.len() as u64;
            if bytes.len() != wanted
                || transfer_id(remote, &response)? != id
                || number(remote, &response, "offset")? != offset
                || number(remote, &response, "nextOffset")? != next
                || response.get("eof").and_then(Value::as_bool) != Some(next == total)
            {
                return Err(protocol_error(remote).into());
            }
            check_cancel(cancelled)?;
            file.write_all(&bytes)
                .await
                .map_err(|_| "无法写入下载临时文件，请检查磁盘空间")?;
            hash.update(&bytes);
            offset = next;
            progress.transferred = offset;
            progress.emit(events, false);
        }
        check_cancel(cancelled)?;
        let digest = format!("{:x}", hash.finalize());
        let response = rpc(remote, "files.read_close", json!({"transferId":id})).await?;
        remote_closed = true;
        if transfer_id(remote, &response)? != id || number(remote, &response, "size")? != total {
            return Err(protocol_error(remote).into());
        }
        verified_hash(remote, &response, &digest)?;
        check_cancel(cancelled)?;
        file.flush().await.map_err(|_| "无法完成下载文件写入")?;
        file.sync_all()
            .await
            .map_err(|_| "无法同步下载文件到磁盘")?;
        check_cancel(cancelled)?;
        Ok(())
    }
    .await;
    if !remote_closed && remote.is_alive() {
        // read_close on an incomplete download deliberately returns incomplete
        // while still releasing the remote handle. Other cleanup errors close SSH.
        if let Err(error) = rpc(remote, "files.read_close", json!({"transferId":id})).await {
            if !error.starts_with("incomplete:") && !error.starts_with("invalid_transfer:") {
                remote.close();
            }
        }
    }
    result?;
    check_cancel(cancelled)?;
    let file = file.into_std().await;
    let destination = local_path.to_path_buf();
    let cancelled_before_publish = cancelled.load(Ordering::Acquire);
    if cancelled_before_publish {
        return Err(Failure::Cancelled);
    }
    tokio::task::spawn_blocking(move || {
        tempfile::NamedTempFile::from_parts(file, temporary_path)
            .persist_noclobber(destination)
            .map(|_| ())
            .map_err(|error| {
                if error.error.kind() == std::io::ErrorKind::AlreadyExists {
                    "目标文件已出现，请选择新的文件名；已有文件未被覆盖".to_string()
                } else {
                    "无法原子保存下载文件；已有文件未被覆盖".to_string()
                }
            })
    })
    .await
    .map_err(|_| "无法完成下载文件保存")??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "1234567890abcdef1234567890abcdef";
    #[derive(Default)]
    struct MockState {
        source: Vec<u8>,
        uploaded: Option<Vec<u8>>,
        pending: Option<Vec<u8>>,
        path: String,
        read_offset: usize,
        read_active: bool,
        bad_hash: bool,
        bad_offset: bool,
        cancels: usize,
        read_closes: usize,
        maximum_chunk: usize,
        cancel_after_chunk: Option<Arc<AtomicBool>>,
        before_commit: Option<Box<dyn Fn() + Send>>,
        before_read_close: Option<Box<dyn Fn() + Send>>,
    }
    struct MockRemote {
        alive: AtomicBool,
        state: Mutex<MockState>,
    }
    impl MockRemote {
        fn new(source: Vec<u8>) -> Self {
            Self {
                alive: AtomicBool::new(true),
                state: Mutex::new(MockState {
                    source,
                    ..MockState::default()
                }),
            }
        }
    }
    impl FileRemote for MockRemote {
        fn request<'a>(&'a self, method: &'a str, params: Value) -> RpcFuture<'a> {
            Box::pin(async move {
                let mut state = self.state.lock().unwrap();
                match method {
                    "files.write_open" => {
                        if state.uploaded.is_some() {
                            return Err("already_exists: target exists".into());
                        }
                        state.pending = Some(Vec::new());
                        state.path = params["path"].as_str().unwrap().into();
                        Ok(json!({"transferId":ID,"path":state.path,"maxChunkBytes":CHUNK_BYTES}))
                    }
                    "files.write_chunk" => {
                        let data = STANDARD
                            .decode(params["dataBase64"].as_str().unwrap())
                            .unwrap();
                        assert!(data.len() <= CHUNK_BYTES);
                        state.maximum_chunk = state.maximum_chunk.max(data.len());
                        let pending = state.pending.as_mut().unwrap();
                        assert_eq!(params["offset"], pending.len());
                        pending.extend_from_slice(&data);
                        let next = pending.len();
                        if let Some(flag) = &state.cancel_after_chunk {
                            flag.store(true, Ordering::Release);
                        }
                        Ok(json!({"transferId":ID,"nextOffset":next}))
                    }
                    "files.write_commit" => {
                        let data = state.pending.take().unwrap();
                        let hash = format!("{:x}", Sha256::digest(&data));
                        assert_eq!(params["sha256"], hash);
                        if let Some(callback) = state.before_commit.take() {
                            callback();
                        }
                        let value = json!({"path":state.path,"size":data.len(),"sha256":hash});
                        state.uploaded = Some(data);
                        Ok(value)
                    }
                    "files.write_cancel" => {
                        state.pending = None;
                        state.cancels += 1;
                        Ok(json!({"cancelled":true}))
                    }
                    "files.read_open" => {
                        state.read_offset = 0;
                        state.read_active = true;
                        Ok(
                            json!({"transferId":ID,"path":params["path"],"size":state.source.len(),"fingerprint":"0".repeat(64)}),
                        )
                    }
                    "files.read_chunk" => {
                        assert_eq!(params["offset"], state.read_offset);
                        let count = params["maxBytes"].as_u64().unwrap() as usize;
                        assert!(count <= CHUNK_BYTES);
                        let offset = state.read_offset;
                        let next = (offset + count).min(state.source.len());
                        let data = STANDARD.encode(&state.source[offset..next]);
                        state.read_offset = next;
                        if let Some(flag) = &state.cancel_after_chunk {
                            flag.store(true, Ordering::Release);
                        }
                        Ok(
                            json!({"transferId":ID,"offset":offset,"nextOffset":next + usize::from(state.bad_offset),
                            "dataBase64":data,"eof":next == state.source.len()}),
                        )
                    }
                    "files.read_close" => {
                        state.read_active = false;
                        state.read_closes += 1;
                        if state.read_offset != state.source.len() {
                            return Err("incomplete: unfinished".into());
                        }
                        if let Some(callback) = state.before_read_close.take() {
                            callback();
                        }
                        let hash = if state.bad_hash {
                            "f".repeat(64)
                        } else {
                            format!("{:x}", Sha256::digest(&state.source))
                        };
                        Ok(json!({"transferId":ID,"size":state.source.len(),"sha256":hash}))
                    }
                    _ => panic!("unexpected method {method}"),
                }
            })
        }
        fn is_alive(&self) -> bool {
            self.alive.load(Ordering::Acquire)
        }
        fn close(&self) {
            self.alive.store(false, Ordering::Release);
        }
    }
    fn progress(direction: &'static str) -> Progress {
        Progress {
            transfer_id: "transfer".into(),
            resource_id: "resource".into(),
            direction,
            name: "file.bin".into(),
            transferred: 0,
            total: None,
            status: "running",
            error: None,
            last_emit: None,
        }
    }
    fn no_events() -> Events {
        Arc::new(|_, _| {})
    }

    #[tokio::test]
    async fn native_upload_streams_exact_chunks_and_commit_hash() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source");
        let data: Vec<u8> = (0..CHUNK_BYTES * 3 + 13).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &data).unwrap();
        let remote = MockRemote::new(Vec::new());
        let mut status = progress("upload");
        upload_file(
            &remote,
            "folder/source",
            &path,
            &AtomicBool::new(false),
            &mut status,
            &no_events(),
        )
        .await
        .unwrap();
        let state = remote.state.lock().unwrap();
        assert_eq!(state.uploaded.as_ref().unwrap(), &data);
        assert_eq!(state.maximum_chunk, CHUNK_BYTES);
        assert_eq!(state.cancels, 0);
        assert_eq!(status.transferred, data.len() as u64);
    }

    #[tokio::test]
    async fn upload_cancel_cleans_pending_and_successful_commit_wins_cancel_race() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source");
        std::fs::write(&path, vec![5; CHUNK_BYTES + 1]).unwrap();
        let remote = MockRemote::new(Vec::new());
        let cancelled = Arc::new(AtomicBool::new(false));
        remote.state.lock().unwrap().cancel_after_chunk = Some(cancelled.clone());
        assert!(matches!(
            upload_file(
                &remote,
                "target",
                &path,
                &cancelled,
                &mut progress("upload"),
                &no_events()
            )
            .await,
            Err(Failure::Cancelled)
        ));
        assert!(remote.state.lock().unwrap().pending.is_none());
        assert!(remote.state.lock().unwrap().uploaded.is_none());
        assert_eq!(remote.state.lock().unwrap().cancels, 1);
        cancelled.store(false, Ordering::Release);
        remote.state.lock().unwrap().cancel_after_chunk = None;
        let flag = cancelled.clone();
        remote.state.lock().unwrap().before_commit =
            Some(Box::new(move || flag.store(true, Ordering::Release)));
        upload_file(
            &remote,
            "target",
            &path,
            &cancelled,
            &mut progress("upload"),
            &no_events(),
        )
        .await
        .unwrap();
        assert!(remote.state.lock().unwrap().uploaded.is_some());
    }

    #[tokio::test]
    async fn native_download_verifies_hash_and_publishes_without_overwrite() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("saved");
        let data = vec![42; CHUNK_BYTES * 2 + 9];
        let remote = MockRemote::new(data.clone());
        download_file(
            &remote,
            "source",
            &destination,
            &AtomicBool::new(false),
            &mut progress("download"),
            &no_events(),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), data);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        assert!(
            download_file(
                &remote,
                "source",
                &destination,
                &AtomicBool::new(false),
                &mut progress("download"),
                &no_events()
            )
            .await
            .is_err()
        );
        assert_eq!(std::fs::read(&destination).unwrap(), data);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&destination)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    async fn destination_created_during_download_is_preserved_and_empty_files_complete() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("race");
        let remote = MockRemote::new(vec![9; 71]);
        let concurrent = destination.clone();
        remote.state.lock().unwrap().before_read_close = Some(Box::new(move || {
            std::fs::write(&concurrent, b"existing user file").unwrap()
        }));
        assert!(
            download_file(
                &remote,
                "source",
                &destination,
                &AtomicBool::new(false),
                &mut progress("download"),
                &no_events()
            )
            .await
            .is_err()
        );
        assert_eq!(std::fs::read(&destination).unwrap(), b"existing user file");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        let empty = directory.path().join("empty");
        let remote = MockRemote::new(Vec::new());
        download_file(
            &remote,
            "empty",
            &empty,
            &AtomicBool::new(false),
            &mut progress("download"),
            &no_events(),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::metadata(&empty).unwrap().len(), 0);
        upload_file(
            &remote,
            "empty-upload",
            &empty,
            &AtomicBool::new(false),
            &mut progress("upload"),
            &no_events(),
        )
        .await
        .unwrap();
        assert_eq!(
            remote
                .state
                .lock()
                .unwrap()
                .uploaded
                .as_ref()
                .unwrap()
                .len(),
            0
        );
    }

    #[tokio::test]
    async fn bad_download_hash_or_offsets_leave_no_local_file_or_temp() {
        for bad_hash in [true, false] {
            let directory = tempfile::tempdir().unwrap();
            let remote = MockRemote::new(vec![1; 200]);
            remote.state.lock().unwrap().bad_hash = bad_hash;
            remote.state.lock().unwrap().bad_offset = !bad_hash;
            let result = download_file(
                &remote,
                "source",
                &directory.path().join("saved"),
                &AtomicBool::new(false),
                &mut progress("download"),
                &no_events(),
            )
            .await;
            assert!(result.is_err());
            assert!(!remote.is_alive());
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        }
    }

    #[tokio::test]
    async fn download_cancel_releases_remote_handle_and_removes_partial_file() {
        let directory = tempfile::tempdir().unwrap();
        let remote = MockRemote::new(vec![1; CHUNK_BYTES + 1]);
        let cancelled = Arc::new(AtomicBool::new(false));
        remote.state.lock().unwrap().cancel_after_chunk = Some(cancelled.clone());
        let result = download_file(
            &remote,
            "source",
            &directory.path().join("saved"),
            &cancelled,
            &mut progress("download"),
            &no_events(),
        )
        .await;
        assert!(matches!(result, Err(Failure::Cancelled)));
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        assert!(!remote.state.lock().unwrap().read_active);
        assert_eq!(remote.state.lock().unwrap().read_closes, 1);
        assert!(remote.is_alive());
    }

    #[tokio::test]
    async fn local_source_mutation_is_detected_and_remote_temp_cancelled() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source");
        std::fs::write(&path, b"original").unwrap();
        let modify = path.clone();
        let events: Events = Arc::new(move |_, _| {
            std::fs::write(&modify, b"modified!").unwrap();
        });
        let remote = MockRemote::new(Vec::new());
        assert!(
            upload_file(
                &remote,
                "target",
                &path,
                &AtomicBool::new(false),
                &mut progress("upload"),
                &events
            )
            .await
            .is_err()
        );
        assert!(remote.state.lock().unwrap().uploaded.is_none());
        assert_eq!(remote.state.lock().unwrap().cancels, 1);
    }

    #[test]
    fn reservations_bound_dialogs_and_transfers_and_cancel_only_selected_resource() {
        let manager = TransferManager::new(no_events());
        let a = manager.reserve("a").unwrap();
        let b = manager.reserve("b").unwrap();
        let c = manager.reserve("a").unwrap();
        let d = manager.reserve("b").unwrap();
        assert!(manager.reserve("overflow").is_err());
        manager.cancel_resource("a");
        assert!(a.cancelled.load(Ordering::Acquire) && c.cancelled.load(Ordering::Acquire));
        assert!(!b.cancelled.load(Ordering::Acquire) && !d.cancelled.load(Ordering::Acquire));
        drop(a);
        assert!(manager.reserve("released").is_ok());
        for path in [
            "/absolute",
            "../escape",
            "a/../b",
            "a//b",
            ".racktop-upload-x",
        ] {
            assert!(relative_path(path, false).is_err());
        }
    }
}
