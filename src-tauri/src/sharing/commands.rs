//! Thin WebView command boundary. Secret persistence, validation, authorization,
//! and public DTO projection are owned by SharingRuntime, never by the WebView.
use super::{SharingManager, store::Capabilities};
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub async fn sharing_status(state: State<'_, SharingManager>) -> Result<Value, String> {
    let runtime = state.inner().0.clone();
    runtime.status().await
}

#[tauri::command]
pub async fn sharing_configure(
    state: State<'_, SharingManager>,
    relay_url: String,
    owner_token: String,
) -> Result<(), String> {
    let runtime = state.inner().0.clone();
    runtime.configure(relay_url, owner_token).await
}

#[tauri::command]
pub async fn sharing_create(
    state: State<'_, SharingManager>,
    server_id: String,
    name: String,
    expires_in_hours: u64,
    capabilities: Capabilities,
    default_path: String,
) -> Result<Value, String> {
    let runtime = state.inner().0.clone();
    runtime
        .create(
            server_id,
            name,
            expires_in_hours,
            capabilities,
            default_path,
        )
        .await
}

#[tauri::command]
pub async fn sharing_invite(
    state: State<'_, SharingManager>,
    share_id: String,
    expires_in_minutes: u64,
) -> Result<Value, String> {
    let runtime = state.inner().0.clone();
    runtime.invite(share_id, expires_in_minutes).await
}

#[tauri::command]
pub async fn sharing_pause(
    state: State<'_, SharingManager>,
    share_id: String,
    paused: bool,
) -> Result<(), String> {
    let runtime = state.inner().0.clone();
    runtime.pause(share_id, paused).await
}

#[tauri::command]
pub async fn sharing_revoke_member(
    state: State<'_, SharingManager>,
    share_id: String,
    member_id: String,
) -> Result<(), String> {
    let runtime = state.inner().0.clone();
    runtime.revoke_member(share_id, member_id).await
}

#[tauri::command]
pub async fn sharing_delete(
    state: State<'_, SharingManager>,
    share_id: String,
) -> Result<(), String> {
    let runtime = state.inner().0.clone();
    runtime.delete(share_id).await
}

#[tauri::command]
pub async fn sharing_accept(
    state: State<'_, SharingManager>,
    code: String,
    device_name: String,
) -> Result<Value, String> {
    let runtime = state.inner().0.clone();
    runtime.accept(code, device_name).await
}

#[tauri::command]
pub async fn sharing_connect(state: State<'_, SharingManager>, id: String) -> Result<(), String> {
    let runtime = state.inner().0.clone();
    runtime.connect(id).await
}

#[tauri::command]
pub async fn sharing_disconnect(
    state: State<'_, SharingManager>,
    id: String,
) -> Result<(), String> {
    let runtime = state.inner().0.clone();
    runtime.disconnect(id).await
}

#[tauri::command]
pub async fn sharing_forget(state: State<'_, SharingManager>, id: String) -> Result<(), String> {
    let runtime = state.inner().0.clone();
    runtime.forget(id).await
}

#[tauri::command]
pub async fn sharing_snapshot(
    state: State<'_, SharingManager>,
    id: String,
) -> Result<Value, String> {
    let runtime = state.inner().0.clone();
    runtime.snapshot(id).await
}

#[tauri::command]
pub async fn sharing_terminal_open(
    state: State<'_, SharingManager>,
    id: String,
    columns: u16,
    rows: u16,
) -> Result<String, String> {
    let runtime = state.inner().0.clone();
    runtime.terminal_open(id, columns, rows).await
}

#[tauri::command]
pub async fn sharing_terminal_input(
    state: State<'_, SharingManager>,
    id: String,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let runtime = state.inner().0.clone();
    runtime.terminal_input(id, session_id, data).await
}

#[tauri::command]
pub async fn sharing_terminal_resize(
    state: State<'_, SharingManager>,
    id: String,
    session_id: String,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    let runtime = state.inner().0.clone();
    runtime.terminal_resize(id, session_id, columns, rows).await
}

#[tauri::command]
pub async fn sharing_terminal_close(
    state: State<'_, SharingManager>,
    id: String,
    session_id: String,
) -> Result<(), String> {
    let runtime = state.inner().0.clone();
    runtime.terminal_close(id, session_id).await
}

#[tauri::command]
pub async fn sharing_list_files(
    state: State<'_, SharingManager>,
    id: String,
    path: String,
) -> Result<Value, String> {
    let runtime = state.inner().0.clone();
    runtime.list_files(id, path).await
}

#[tauri::command]
pub async fn sharing_upload(
    state: State<'_, SharingManager>,
    id: String,
    directory: String,
) -> Result<Option<Value>, String> {
    let runtime = state.inner().0.clone();
    runtime.upload(id, directory).await
}

#[tauri::command]
pub async fn sharing_download(
    state: State<'_, SharingManager>,
    id: String,
    path: String,
) -> Result<Option<Value>, String> {
    let runtime = state.inner().0.clone();
    runtime.download(id, path).await
}

#[tauri::command]
pub async fn sharing_cancel_transfer(
    state: State<'_, SharingManager>,
    transfer_id: String,
) -> Result<(), String> {
    let runtime = state.inner().0.clone();
    runtime.cancel_transfer(transfer_id).await
}
