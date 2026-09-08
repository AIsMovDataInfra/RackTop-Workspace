use crate::{
    models::{Server, Snapshot},
    storage::Database,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};

pub const TEAM_URL: &str = "https://136.0.110.161";
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Binding {
    resource_id: Option<String>,
    last_synced_at: Option<i64>,
    error: Option<String>,
}
// Credentials, account identity and selections remain in the OS keyring, never in a WebView DTO.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    source_id: String,
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    preset: bool,
    token: Option<String>,
    user: Option<Value>,
    expires_at: Option<Value>,
    bindings: BTreeMap<String, Binding>,
    #[serde(skip)]
    generation: u64,
    #[serde(skip)]
    login_pending: bool,
}
impl Default for Stored {
    fn default() -> Self {
        Self {
            source_id: uuid::Uuid::new_v4().to_string(),
            account_id: None,
            preset: false,
            token: None,
            user: None,
            expires_at: None,
            bindings: BTreeMap::new(),
            generation: 0,
            login_pending: false,
        }
    }
}
impl Stored {
    fn migrate_account(&mut self) {
        if self.account_id.is_none() {
            self.account_id = self
                .user
                .as_ref()
                .and_then(|u| u.get("id"))
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
    }
    fn advance(&mut self) {
        self.generation = self.generation.wrapping_add(1);
    }
    fn begin_login(&mut self) -> u64 {
        self.advance();
        self.login_pending = true;
        self.generation
    }
    fn finish_login(
        &mut self,
        generation: u64,
        token: String,
        user: Value,
        expires_at: Option<Value>,
    ) -> Result<(), String> {
        if self.generation != generation || !self.login_pending {
            return Err("登录操作已取消，请重新登录".into());
        }
        let id = user
            .get("id")
            .and_then(Value::as_str)
            .ok_or("预约中心没有返回账号信息")?;
        self.migrate_account();
        let adopt_preset = self.preset
            && self.account_id.is_none()
            && user.get("role").and_then(Value::as_str) == Some("admin");
        if self.account_id.as_deref() != Some(id) && !adopt_preset {
            self.bindings.clear();
            self.source_id = uuid::Uuid::new_v4().to_string();
        }
        self.preset = false;
        self.account_id = Some(id.to_owned());
        self.token = Some(token);
        self.user = Some(user);
        self.expires_at = expires_at;
        self.login_pending = false;
        self.advance();
        Ok(())
    }
    fn clear_login(&mut self) -> Option<String> {
        self.migrate_account();
        self.advance();
        self.login_pending = false;
        self.user = None;
        self.expires_at = None;
        self.token.take()
    }
    fn is_admin(&self) -> bool {
        !self.login_pending
            && self.token.is_some()
            && self
                .user
                .as_ref()
                .and_then(|u| u.get("role"))
                .and_then(Value::as_str)
                == Some("admin")
            && self.user.as_ref().is_some_and(user_has_company_access)
    }
    fn refresh_user(&mut self, generation: u64, token: &str, user: Value) -> Result<(), String> {
        // Status requests can finish after logout, another login, or a newer identity refresh.
        if self.generation != generation || self.token.as_deref() != Some(token) || self.login_pending {
            return Ok(());
        }
        if self.user.as_ref().and_then(|value| value.get("id")) != user.get("id") {
            return Err("团队账号状态已变化，请重新登录".into());
        }
        if self.user.as_ref() != Some(&user) {
            self.user = Some(user);
            self.advance();
        }
        Ok(())
    }
    fn company_required(&mut self, token: &str) {
        if self.token.as_deref() != Some(token) || self.login_pending {
            return;
        }
        if let Some(user) = self.user.as_mut() {
            if user.get("company") != Some(&Value::Null) || user.get("isSuperAdmin") != Some(&Value::Bool(false)) {
                user["company"] = Value::Null;
                user["isSuperAdmin"] = Value::Bool(false);
                self.advance();
            }
        }
    }
    fn can_sync(&self, generation: u64, token: &str, server_id: &str) -> bool {
        self.is_admin()
            && self.generation == generation
            && self.token.as_deref() == Some(token)
            && self.bindings.contains_key(server_id)
    }
    fn select(&mut self, generation: u64, server_ids: Vec<String>) -> Result<(), String> {
        if self.generation != generation || !self.is_admin() {
            return Err("账号状态已变化，请重新选择要同步的资源".into());
        }
        self.bindings.retain(|id, _| server_ids.contains(id));
        for id in server_ids {
            self.bindings.entry(id).or_default();
        }
        self.advance();
        Ok(())
    }
    #[cfg(any(test, feature = "integration-probe"))]
    fn prepare_metadata(
        &mut self,
        source_id: String,
        bindings: BTreeMap<String, String>,
    ) -> Result<usize, String> {
        if self.token.is_some()
            || self.user.is_some()
            || self.account_id.is_some()
            || self.expires_at.is_some()
            || !self.bindings.is_empty()
            || self.preset
            || self.login_pending
        {
            return Err("团队设置已有账号或资源配置，拒绝覆盖；原记录已保留".into());
        }
        let valid_id = |id: &str| {
            uuid::Uuid::parse_str(id)
                .map(|uuid| !uuid.is_nil())
                .unwrap_or(false)
        };
        if !valid_id(&source_id)
            || bindings.is_empty()
            || bindings.len() > 32
            || bindings
                .iter()
                .any(|(local, cloud)| !valid_id(local) || !valid_id(cloud))
        {
            return Err("预配置需要有效的来源 UUID 及 1–32 个服务器 UUID 映射".into());
        }
        self.source_id = source_id;
        self.bindings = bindings
            .into_iter()
            .map(|(id, resource_id)| {
                (
                    id,
                    Binding {
                        resource_id: Some(resource_id),
                        last_synced_at: None,
                        error: None,
                    },
                )
            })
            .collect();
        self.preset = true;
        self.advance();
        Ok(self.bindings.len())
    }
    fn public_status(&self) -> Value {
        json!({"url":TEAM_URL,"authenticated":self.token.is_some(),"user":if self.token.is_some() {self.user.as_ref()} else {None},"expiresAt":self.expires_at,"bindings":self.bindings})
    }
}

pub struct TeamManager {
    entry: keyring::Entry,
    value: Mutex<Option<Stored>>,
    // This lock only suppresses overlapping sync rounds. Auth and selection changes never wait for it.
    sync_lock: tokio::sync::Mutex<()>,
    changes: tokio::sync::watch::Sender<u64>,
    client: reqwest::Client,
}
impl TeamManager {
    pub fn new(profile: &Path) -> Result<Self, String> {
        let account = format!(
            "profile-{:x}",
            Sha256::digest(profile.to_string_lossy().as_bytes())
        );
        let (changes, _) = tokio::sync::watch::channel(0);
        Ok(Self {
            entry: keyring::Entry::new("com.racktop.team.v1", &account)
                .map_err(|_| "无法打开团队凭据存储")?,
            value: Mutex::new(None),
            sync_lock: tokio::sync::Mutex::new(()),
            changes,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .connect_timeout(Duration::from_secs(8))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "无法初始化预约服务连接")?,
        })
    }
    fn read(&self) -> Result<Stored, String> {
        let mut guard = self.value.lock().map_err(|_| "团队设置暂时不可用")?;
        if guard.is_none() {
            let mut value: Stored = match self.entry.get_password() {
                Ok(s) if s.len() <= 128 * 1024 => {
                    serde_json::from_str(&s).map_err(|_| "团队设置损坏，原记录已保留")?
                }
                Ok(_) => return Err("团队设置超过大小限制".into()),
                Err(keyring::Error::NoEntry) => Stored::default(),
                Err(_) => return Err("请先解锁系统钥匙串，再连接团队账号".into()),
            };
            value.migrate_account();
            *guard = Some(value);
        }
        Ok(guard.as_ref().unwrap().clone())
    }
    fn persist(&self, value: &Stored) -> Result<(), String> {
        let serialized = serde_json::to_string(value).map_err(|_| "无法保存团队设置")?;
        if serialized.len() > 128 * 1024 {
            return Err("团队设置超过大小限制".into());
        }
        self.entry
            .set_password(&serialized)
            .map_err(|_| "无法保存团队设置，请先解锁系统钥匙串".into())
    }
    fn update<T>(
        &self,
        persist: bool,
        edit: impl FnOnce(&mut Stored) -> Result<T, String>,
    ) -> Result<T, String> {
        let _ = self.read()?;
        let mut guard = self.value.lock().map_err(|_| "团队设置暂时不可用")?;
        let mut value = guard.as_ref().unwrap().clone();
        let result = edit(&mut value)?;
        if persist {
            self.persist(&value)?;
        }
        let changed = guard.as_ref().unwrap().generation != value.generation;
        let generation = value.generation;
        *guard = Some(value);
        if changed {
            self.changes.send_replace(generation);
        }
        Ok(result)
    }
    // Clearing the memory session is unconditional, even if a newly locked keyring prevents persistence.
    // The caller can still revoke the returned token and report the storage failure to the user.
    fn clear_session(
        &self,
        expected_token: Option<&str>,
    ) -> Result<(Option<String>, Option<String>), String> {
        let _ = self.read()?;
        let mut guard = self.value.lock().map_err(|_| "团队设置暂时不可用")?;
        let value = guard.as_mut().unwrap();
        if expected_token.is_some() && value.token.as_deref() != expected_token {
            return Ok((None, None));
        }
        let token = value.clear_login();
        self.changes.send_replace(value.generation);
        let error = self.persist(value).err();
        Ok((token, error))
    }
    pub fn status(&self) -> Result<Value, String> {
        Ok(self.read()?.public_status())
    }
    async fn refresh_status(&self) -> Result<Value, String> {
        let state = self.read()?;
        let Some(token) = state.token.as_deref().filter(|_| !state.login_pending) else {
            return self.status();
        };
        let session = self.request(reqwest::Method::GET, "/api/session", Some(token), None).await?;
        let user = login_user(session.get("user"))?;
        self.update(false, |value| value.refresh_user(state.generation, token, user))?;
        self.status()
    }
    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Result<Value, String> {
        // All routes are built here, not supplied by a remote resource or arbitrary WebView URL.
        let mut request = self
            .client
            .request(method, format!("{TEAM_URL}{path}"))
            .header("Origin", TEAM_URL);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| "无法连接预约中心，请检查网络后重试")?;
        let status = response.status();
        if status.as_u16() == 401 {
            if let Some(token) = token {
                let _ = self.clear_session(Some(token));
            }
            return Err("团队登录已失效，请重新登录".into());
        }
        if response
            .content_length()
            .is_some_and(|n| n > 2 * 1024 * 1024)
        {
            return Err("预约中心响应过大".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "预约中心响应中断")? {
            if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
                return Err("预约中心响应过大".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "预约中心返回了无法识别的数据")?;
        if !status.is_success() {
            if status.as_u16() == 403 && value.pointer("/error/code").and_then(Value::as_str) == Some("COMPANY_REQUIRED") {
                if let Some(token) = token {
                    // Keep the login session, but stop repeated background inventory requests.
                    let _ = self.update(false, |value| { value.company_required(token); Ok(()) });
                }
                return Err("COMPANY_REQUIRED: 请联系超级管理员分配公司后再使用预约和设备管理".into());
            }
            let message = value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .filter(|s| s.len() <= 500)
                .unwrap_or("预约中心暂时无法完成操作");
            return Err(message.into());
        }
        Ok(value)
    }
    async fn revoke(&self, token: &str) -> Result<(), String> {
        self.request(
            reqwest::Method::POST,
            "/api/auth/device-logout",
            Some(token),
            Some(json!({})),
        )
        .await
        .map(|_| ())
    }
    fn cancel_login_attempt(&self, generation: u64) {
        let _ = self.update(false, |v| {
            if v.generation == generation {
                v.login_pending = false;
                v.advance();
            }
            Ok(())
        });
    }
    async fn login(&self, username: String, password: String) -> Result<Value, String> {
        validate_login_input(&username, &password)?;
        // Verify both keyring read and write before the server creates a device credential.
        let (generation, old_token) = self.update(true, |v| {
            let token = v.token.clone();
            Ok((v.begin_login(), token))
        })?;
        // Do not cancel this HTTP response on logout: if it succeeds late, revoke the unused token.
        let response = self
            .request(
                reqwest::Method::POST,
                "/api/auth/device-login",
                None,
                Some(json!({"username":username,"password":password,"deviceName":"RackTop 桌面"})),
            )
            .await;
        let value = match response {
            Ok(v) => v,
            Err(e) => {
                self.cancel_login_attempt(generation);
                return Err(e);
            }
        };
        let token = match value
            .get("token")
            .and_then(Value::as_str)
            .filter(|s| s.len() <= 256 && s.len() >= 32)
        {
            Some(t) => t.to_owned(),
            None => {
                self.cancel_login_attempt(generation);
                return Err("预约中心没有返回有效登录凭据".into());
            }
        };
        let user = match login_user(value.get("user")) {
            Ok(user) => user,
            Err(error) => {
                self.cancel_login_attempt(generation);
                let _ = self.revoke(&token).await;
                return Err(error);
            }
        };
        let write = self.update(true, |v| {
            v.finish_login(
                generation,
                token.clone(),
                user,
                value.get("expiresAt").cloned(),
            )
        });
        if let Err(error) = write {
            self.cancel_login_attempt(generation);
            let _ = self.revoke(&token).await;
            return Err(error);
        }
        if let Some(old_token) = old_token.filter(|old| old != &token) {
            let _ = self.revoke(&old_token).await;
        }
        self.status()
    }
    async fn logout(&self) -> Result<(), String> {
        let (token, storage_error) = self.clear_session(None)?;
        // Local state is already logged out, and pending sync futures observe the generation change.
        let revocation = if let Some(token) = token {
            self.revoke(&token).await
        } else {
            Ok(())
        };
        if let Some(error) = storage_error {
            return Err(if revocation.is_err() {
                format!("已停止本机同步，但{error}，且未能确认远端会话撤销。请解锁钥匙串后再次退出，并在网页撤销此设备")
            } else {
                format!("远端会话已撤销并停止本机同步，但{error}；请解锁钥匙串后再次退出以清除本地保存记录")
            });
        }
        revocation.map_err(|_| {
            "已退出本机账号并停止同步；暂时无法确认远端会话撤销，请联网后在网页撤销此设备".into()
        })
    }
    async fn sync(&self, servers: Vec<Server>, snapshots: Vec<Snapshot>) -> Result<Value, String> {
        let Ok(_lock) = self.sync_lock.try_lock() else {
            return self.status();
        };
        let state = self.read()?;
        let Some(token) = state.token.as_deref() else {
            return self.status();
        };
        if !state.is_admin() {
            return self.status();
        }
        for (id, binding) in &state.bindings {
            let mut changes = self.changes.subscribe();
            if !self.read()?.can_sync(state.generation, token, id) {
                break;
            }
            let operation = async {
                match servers.iter().find(|s| &s.id == id) {
                    Some(server) => {
                        let body = inventory_payload(
                            server,
                            snapshots.iter().find(|s| &s.server_id == id),
                            &state.source_id,
                            binding.resource_id.as_deref(),
                            now_ms(),
                        )?;
                        let value = self
                            .request(
                                reqwest::Method::POST,
                                "/api/resources/sync",
                                Some(token),
                                Some(body),
                            )
                            .await?;
                        let resource_id = value
                            .pointer("/resource/id")
                            .and_then(Value::as_str)
                            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                            .ok_or("预约中心没有返回有效资源标识")?;
                        Ok::<_, String>(resource_id.to_owned())
                    }
                    None => Err("本地连接已移除；在线预约记录仍保留，请在网页停用资源".into()),
                }
            };
            let result = tokio::select! { biased; _ = changes.changed() => break, result = operation => result };
            self.update(true, |v| {
                if !v.can_sync(state.generation, token, id) {
                    return Ok(());
                }
                if let Some(current) = v.bindings.get_mut(id) {
                    match result {
                        Ok(resource_id) => {
                            current.resource_id = Some(resource_id);
                            current.last_synced_at = Some(now_ms());
                            current.error = None;
                        }
                        Err(error) => current.error = Some(error),
                    }
                }
                Ok(())
            })?;
        }
        self.status()
    }
    pub fn start(self: Arc<Self>, app: tauri::AppHandle) {
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let data = {
                    let db = app.state::<Database>();
                    db.list_servers()
                        .and_then(|s| db.list_latest_snapshots().map(|v| (s, v)))
                };
                if let Ok((servers, snapshots)) = data {
                    let _ = self.sync(servers, snapshots).await;
                }
            }
        });
    }
}

// This provisioning entry point exists only in the explicitly built local setup helper.
// It cannot be called through a Tauri command or the public reservation service.
#[cfg(feature = "integration-probe")]
pub fn prepare_profile(input: Value) -> Result<usize, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Setup {
        profile_path: String,
        source_id: String,
        bindings: BTreeMap<String, String>,
    }
    let setup: Setup = serde_json::from_value(input).map_err(|_| "预配置 JSON 字段无效")?;
    let profile = Path::new(&setup.profile_path);
    if !profile.is_absolute() || !profile.is_dir() {
        return Err("必须指定已有 RackTop 配置目录的绝对路径".into());
    }
    let manager = TeamManager::new(profile)?;
    manager.update(true, |value| {
        value.prepare_metadata(setup.source_id, setup.bindings)
    })
}

fn validate_login_input(username: &str, password: &str) -> Result<(), String> {
    if username.trim().is_empty() {
        return Err("请输入用户名".into());
    }
    // Existing accounts may have an all-space password; never trim it here.
    if password.is_empty() {
        return Err("请输入密码".into());
    }
    Ok(())
}

fn login_user(value: Option<&Value>) -> Result<Value, String> {
    let value = value.ok_or("预约中心没有返回账号信息")?;
    let valid = |key: &str, max| {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= max)
    };
    let id = valid("id", 100).ok_or("账号标识无效")?;
    let name = valid("name", 200).ok_or("账号姓名无效")?;
    let username = value
        .get("username")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("账号用户名无效")?;
    let role = valid("role", 20)
        .filter(|r| matches!(*r, "admin" | "member"))
        .ok_or("账号权限无效")?;
    let mut projected = json!({"id":id,"name":name,"username":username,"role":role});
    if let Some(company) = value.get("company") {
        if !company.is_null() && !company.as_str().is_some_and(is_team_company) {
            return Err("账号公司无效".into());
        }
        projected["company"] = company.clone();
    }
    if let Some(is_super_admin) = value.get("isSuperAdmin") {
        if !is_super_admin.is_boolean() { return Err("账号权限无效".into()); }
        projected["isSuperAdmin"] = is_super_admin.clone();
    }
    if let Some(version) = value.get("version") {
        if !version.as_u64().is_some_and(|number| number > 0) { return Err("账号版本无效".into()); }
        projected["version"] = version.clone();
    }
    Ok(projected)
}

fn is_team_company(company: &str) -> bool {
    matches!(company, "A公司" | "B公司" | "C公司" | "西浦")
}

fn user_has_company_access(user: &Value) -> bool {
    user.get("isSuperAdmin").and_then(Value::as_bool) == Some(true)
        || match user.get("company") {
            None => true, // Older account services did not have a company field.
            Some(company) => company.as_str().is_some_and(is_team_company),
        }
}

pub fn inventory_payload(
    server: &Server,
    snapshot: Option<&Snapshot>,
    source_id: &str,
    resource_id: Option<&str>,
    now: i64,
) -> Result<Value, String> {
    let snapshot = snapshot.ok_or("尚无硬件采样，请先连接此服务器")?;
    if snapshot.server_id != server.id {
        return Err("硬件采样与服务器不匹配，请重新采集".into());
    }
    let observed_at = snapshot
        .timestamp
        .checked_mul(1000)
        .filter(|time| *time >= 0)
        .ok_or("硬件采样时间无效")?;
    if observed_at > now.saturating_add(60_000) {
        return Err("硬件采样时间超前，请检查电脑时钟后重新采集".into());
    }
    // A degraded driver can expose a valid-looking partial list. It cannot establish complete inventory.
    let complete = snapshot.nvidia_smi == "available"
        && matches!(snapshot.status.as_str(), "online" | "warning");
    let fresh = complete && now.saturating_sub(observed_at) <= 90_000;
    let mut value = json!({"sourceId":source_id,"serverId":server.id,"name":server.name,"cluster":server.location.as_deref().filter(|v| !v.is_empty()).unwrap_or("我的服务器"),"gpus":[],"observedAt":observed_at,"status":"unknown"});
    if let Some(id) = resource_id {
        value["resourceId"] = json!(id);
    }
    if resource_id.is_none() && snapshot.gpus.is_empty() {
        return Err(
            "未取得可确认的 GPU 清单；CPU 资源请在预约网页手工登记，GPU 机器请先修复采集".into(),
        );
    }
    if !fresh {
        return if resource_id.is_some() {
            Ok(value)
        } else {
            Err("首次加入预约需要最近 90 秒内、驱动采集完整的在线 GPU 清单".into())
        };
    }
    if snapshot.gpus.is_empty() {
        return Err("自动同步仅支持有稳定 UUID 的 GPU 机器；CPU 资源请在预约网页手工登记".into());
    }
    if snapshot.gpus.len() > 64 {
        return Err("单台资源最多支持 64 张 GPU".into());
    }
    let mut uuids = BTreeSet::new();
    let mut indices = BTreeSet::new();
    let mut gpus = Vec::new();
    for gpu in &snapshot.gpus {
        let uuid = gpu
            .uuid
            .strip_prefix("GPU-")
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
            .filter(|id| !id.is_nil());
        let Some(uuid) = uuid else {
            return Err("无法获得完整、稳定的 GPU 身份，暂不支持此资源的自动预约同步".into());
        };
        if !uuids.insert(uuid) || !indices.insert(gpu.index) {
            return Err("硬件采样含有重复 GPU UUID 或编号，请重新采集".into());
        }
        if gpu.index > 63
            || !gpu.memory_total_mb.is_finite()
            || gpu.memory_total_mb <= 0.0
            || gpu.memory_total_mb > 16_777_216.0
        {
            return Err("GPU 编号或显存采样无效，请重新采集".into());
        }
        gpus.push(json!({"uuid":format!("GPU-{uuid}"),"index":gpu.index,"name":gpu.name,"memoryTotalMb":gpu.memory_total_mb}));
    }
    value["gpus"] = json!(gpus);
    value["status"] = json!("online");
    Ok(value)
}

pub struct TeamState(pub Arc<TeamManager>);
#[tauri::command]
pub async fn team_status(state: State<'_, TeamState>) -> Result<Value, String> {
    state.0.refresh_status().await
}
#[tauri::command]
pub async fn team_login(
    state: State<'_, TeamState>,
    username: String,
    password: String,
) -> Result<Value, String> {
    state.0.login(username, password).await
}
#[tauri::command]
pub async fn team_logout(state: State<'_, TeamState>) -> Result<(), String> {
    state.0.logout().await
}
#[tauri::command]
pub async fn team_data(state: State<'_, TeamState>) -> Result<Value, String> {
    let token = state.0.read()?.token;
    let resources = state
        .0
        .request(
            reqwest::Method::GET,
            "/api/resources",
            token.as_deref(),
            None,
        )
        .await?;
    let reservations = state
        .0
        .request(
            reqwest::Method::GET,
            "/api/reservations",
            token.as_deref(),
            None,
        )
        .await?;
    Ok(json!({"resources":resources["resources"],"reservations":reservations["reservations"]}))
}
#[tauri::command]
pub async fn team_select(
    state: State<'_, TeamState>,
    database: State<'_, Database>,
    server_ids: Vec<String>,
) -> Result<Value, String> {
    if server_ids.len() > 32 {
        return Err("最多同步 32 个服务器连接".into());
    }
    let generation = state.0.read()?.generation;
    for id in &server_ids {
        database.get_server(id)?;
    }
    state.0.update(true, |v| v.select(generation, server_ids))?;
    state
        .0
        .sync(database.list_servers()?, database.list_latest_snapshots()?)
        .await
}
#[tauri::command]
pub async fn team_sync(
    state: State<'_, TeamState>,
    database: State<'_, Database>,
) -> Result<Value, String> {
    state
        .0
        .sync(database.list_servers()?, database.list_latest_snapshots()?)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{GpuMetric, SystemMetric};

    fn user(id: &str) -> Value {
        json!({"id":id,"name":"成员","username":"member","role":"admin"})
    }
    fn signed_in() -> Stored {
        let mut value = Stored::default();
        let generation = value.begin_login();
        value
            .finish_login(
                generation,
                "test-session-token".into(),
                user("member-1"),
                Some(json!("2099-01-01T00:00:00.000Z")),
            )
            .unwrap();
        value.bindings.insert(
            "connection-a".into(),
            Binding {
                resource_id: Some("cloud-resource".into()),
                ..Default::default()
            },
        );
        value
            .bindings
            .insert("connection-b".into(), Binding::default());
        value
    }
    fn fixture() -> (Server, Snapshot) {
        let server: Server = serde_json::from_value(json!({
            "id":"connection-a","name":"训练节点","location":"研发集群","host":"private-host.example",
            "port":2222,"username":"ssh-secret-user","identityFile":"/private/secret-key",
            "proxyJump":"private-jump.example","tags":["private-tag"],"samplingIntervalSeconds":5,
            "historyRetentionDays":7,"authMethod":"key","status":"online"
        })).unwrap();
        let gpu = GpuMetric {
            index: 0,
            uuid: "GPU-00000000-0000-4000-8000-000000000001".into(),
            name: "NVIDIA A100".into(),
            memory_total_mb: 81920.0,
            ..Default::default()
        };
        let snapshot = Snapshot {
            server_id: server.id.clone(),
            hostname: "private-hostname".into(),
            username: "private-observed-user".into(),
            os_id: "private-os-id".into(),
            os_name: "private-os-name".into(),
            timestamp: 1000,
            status: "online".into(),
            accelerator_vendor: "nvidia".into(),
            system: SystemMetric::default(),
            gpus: vec![gpu],
            disks: vec![],
            processes: vec![],
            cpu_processes: vec![],
            processes_sampled: true,
            nvidia_smi: "available".into(),
            nvidia_message: Some("private-driver-diagnostic".into()),
        };
        (server, snapshot)
    }

    #[test]
    fn team_logout_and_same_account_relogin_preserve_authoritative_source_and_selection() {
        let mut value = signed_in();
        let source = value.source_id.clone();
        value.clear_login();
        assert!(!value.public_status()["authenticated"].as_bool().unwrap());
        assert!(value.public_status()["user"].is_null());
        assert_eq!(value.account_id.as_deref(), Some("member-1"));
        // Persistence round-trip exercises the logout state, with no operating-system credential access.
        let mut value: Stored =
            serde_json::from_str(&serde_json::to_string(&value).unwrap()).unwrap();
        let generation = value.begin_login();
        value
            .finish_login(generation, "new-token".into(), user("member-1"), None)
            .unwrap();
        assert_eq!(value.source_id, source);
        assert_eq!(
            value.bindings["connection-a"].resource_id.as_deref(),
            Some("cloud-resource")
        );
        let generation = value.begin_login();
        value
            .finish_login(
                generation,
                "other-account-token".into(),
                user("member-2"),
                None,
            )
            .unwrap();
        assert_ne!(value.source_id, source);
        assert!(value.bindings.is_empty());
    }

    #[test]
    fn team_generation_rejects_late_login_and_selection_after_logout_or_account_change() {
        let mut value = signed_in();
        let generation = value.begin_login();
        value.clear_login();
        assert!(value
            .finish_login(generation, "late-token".into(), user("member-1"), None)
            .is_err());
        assert!(value.token.is_none());
        let older = value.begin_login();
        let newer = value.begin_login();
        value
            .finish_login(newer, "current-token".into(), user("member-2"), None)
            .unwrap();
        assert!(value
            .finish_login(older, "stale-token".into(), user("member-1"), None)
            .is_err());
        assert!(value
            .select(older, vec!["old-account-connection".into()])
            .is_err());
        assert_eq!(value.token.as_deref(), Some("current-token"));
        assert!(value.bindings.is_empty());
    }

    #[test]
    fn team_cancelled_selection_invalidates_inflight_result_and_next_server() {
        let mut value = signed_in();
        let generation = value.generation;
        assert!(value.can_sync(generation, "test-session-token", "connection-b"));
        value
            .select(generation, vec!["connection-a".into()])
            .unwrap();
        assert!(!value.can_sync(generation, "test-session-token", "connection-a"));
        assert!(!value.can_sync(value.generation, "test-session-token", "connection-b"));
        assert!(value.can_sync(value.generation, "test-session-token", "connection-a"));
        value.begin_login();
        assert!(!value.can_sync(value.generation, "test-session-token", "connection-a"));
    }

    #[tokio::test]
    async fn team_generation_notification_cancels_a_pending_sync_without_waiting_for_http() {
        let mut value = signed_in();
        let (changes, mut receiver) = tokio::sync::watch::channel(value.generation);
        value.clear_login();
        changes.send_replace(value.generation);
        let stopped = tokio::time::timeout(Duration::from_millis(100), async {
            tokio::select! { biased;
                _ = receiver.changed() => true,
                _ = std::future::pending::<()>() => false,
            }
        })
        .await
        .unwrap();
        assert!(stopped);
    }

    #[test]
    fn team_status_and_login_user_project_only_public_account_fields() {
        let value = signed_in();
        let status = value.public_status();
        for key in [
            "token",
            "sourceId",
            "accountId",
            "generation",
            "loginPending",
        ] {
            assert!(status.get(key).is_none());
        }
        assert!(!status.to_string().contains("test-session-token"));
        let projected = login_user(Some(&json!({"id":"member-1","name":"成员","username":"member","role":"admin","password":"private-password","token":"private-token","email":"private-email"}))).unwrap();
        assert_eq!(projected.as_object().unwrap().len(), 4);
        assert!(!projected.to_string().contains("private-"));
        assert!(login_user(Some(
            &json!({"id":"1","name":"N","username":"u","role":"superuser"})
        ))
        .is_err());
    }

    #[test]
    fn team_company_projection_accepts_optional_safe_fields_and_rejects_invalid_values() {
        let account = json!({"id":"member-1","name":"成员","username":"member","role":"member","company":"西浦","isSuperAdmin":false,"version":2,"password":"private-password","recoveryRequestedAt":"private-date"});
        let projected = login_user(Some(&account)).unwrap();
        assert_eq!(projected["company"], "西浦");
        assert_eq!(projected["isSuperAdmin"], false);
        assert_eq!(projected["version"], 2);
        assert_eq!(projected.as_object().unwrap().len(), 7);
        assert!(!projected.to_string().contains("private-"));
        for (field, invalid) in [("company", json!("未知公司")), ("isSuperAdmin", json!("true")), ("version", json!(0))] {
            let mut candidate = account.clone();
            candidate[field] = invalid;
            assert!(login_user(Some(&candidate)).is_err());
        }
        let mut waiting = account.clone();
        waiting["company"] = Value::Null;
        assert!(login_user(Some(&waiting)).is_ok());
    }

    #[test]
    fn team_company_assignment_refreshes_identity_and_rejects_stale_results() {
        let mut value = signed_in();
        value.company_required("test-session-token");
        assert!(!value.is_admin());
        assert!(value.public_status()["authenticated"].as_bool().unwrap());
        let waiting_generation = value.generation;
        let mut assigned = user("member-1");
        assigned["company"] = json!("A公司");
        assigned["isSuperAdmin"] = json!(false);
        assigned["version"] = json!(2);
        value.refresh_user(waiting_generation, "test-session-token", assigned.clone()).unwrap();
        assert!(value.is_admin());
        assert_eq!(value.public_status()["user"]["company"], "A公司");
        let mut stale = assigned.clone();
        stale["company"] = Value::Null;
        stale["version"] = json!(1);
        value.refresh_user(waiting_generation, "test-session-token", stale).unwrap();
        assert!(value.is_admin());
        let generation = value.generation;
        value.clear_login();
        value.refresh_user(generation, "test-session-token", assigned).unwrap();
        assert!(value.user.is_none());
        assert!(value.token.is_none());
    }

    #[test]
    fn team_company_denial_keeps_session_and_stops_sync_until_assignment() {
        let mut value = signed_in();
        assert!(value.is_admin()); // Existing services without company metadata remain compatible.
        let generation = value.generation;
        value.company_required("test-session-token");
        assert!(!value.can_sync(generation, "test-session-token", "connection-a"));
        assert!(!value.can_sync(value.generation, "test-session-token", "connection-a"));
        assert_eq!(value.token.as_deref(), Some("test-session-token"));
        assert_eq!(value.bindings.len(), 2);
        value.user.as_mut().unwrap()["isSuperAdmin"] = json!(true);
        assert!(value.is_admin());
        value.company_required("old-token");
        assert!(value.is_admin());
    }

    #[test]
    fn team_login_accepts_short_unicode_and_long_credentials_without_trimming_passwords() {
        for username in ["中".to_owned(), "a".to_owned(), " A.+ @ 中文 ! ".repeat(80)] {
            for password in ["密".to_owned(), " ".repeat(12), "中文密码 ! ".repeat(100)] {
                assert!(validate_login_input(&username, &password).is_ok());
            }
            let projected = login_user(Some(
                &json!({"id":"member-1","name":"成员","username":username,"role":"member"}),
            ))
            .unwrap();
            assert_eq!(projected["username"], username);
        }
        assert!(validate_login_input(" \t ", "密").is_err());
        assert!(validate_login_input("中", "").is_err());
        assert!(login_user(Some(
            &json!({"id":"member-1","name":"成员","username":"   ","role":"member"})
        ))
        .is_err());
    }

    #[test]
    fn team_inventory_projection_never_sends_ssh_host_credentials_or_observed_process_data() {
        let (server, snapshot) = fixture();
        let value = inventory_payload(&server, Some(&snapshot), "source", None, 1_000_000).unwrap();
        assert_eq!(value["status"], "online");
        assert_eq!(value["observedAt"], 1_000_000);
        assert_eq!(value["gpus"][0]["memoryTotalMb"], 81920.0);
        let keys: BTreeSet<_> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            BTreeSet::from([
                "sourceId",
                "serverId",
                "name",
                "cluster",
                "gpus",
                "observedAt",
                "status"
            ])
        );
        assert!(!value.to_string().contains("private-"));
        assert!(!value.to_string().contains("ssh-secret"));
        for field in [
            "host",
            "hostname",
            "username",
            "identityFile",
            "proxyJump",
            "processes",
            "cpuProcesses",
            "system",
            "disks",
            "nvidiaMessage",
        ] {
            assert!(value.get(field).is_none());
        }
        assert_eq!(value["gpus"][0].as_object().unwrap().len(), 4);
    }

    #[test]
    fn team_inventory_rejects_bad_time_wrong_connection_duplicate_ids_and_fake_hardware() {
        let (server, mut snapshot) = fixture();
        assert!(inventory_payload(&server, Some(&snapshot), "source", None, 939_000).is_err());
        assert!(inventory_payload(&server, Some(&snapshot), "source", None, 940_000).is_ok());
        snapshot.timestamp = i64::MAX;
        assert!(inventory_payload(&server, Some(&snapshot), "source", None, 1_000_000).is_err());
        snapshot.timestamp = 1000;
        snapshot.server_id = "different-server".into();
        assert!(inventory_payload(&server, Some(&snapshot), "source", None, 1_000_000).is_err());
        snapshot.server_id = server.id.clone();
        let mut duplicate = snapshot.gpus[0].clone();
        duplicate.index = 1;
        snapshot.gpus.push(duplicate);
        assert!(
            inventory_payload(&server, Some(&snapshot), "source", None, 1_000_000)
                .unwrap_err()
                .contains("重复")
        );
        snapshot.gpus.pop();
        for uuid in [
            "unavailable-0000",
            "NPU-0-0",
            "GPU-test",
            "GPU-00000000-0000-0000-0000-000000000000",
        ] {
            snapshot.gpus[0].uuid = uuid.into();
            assert!(
                inventory_payload(&server, Some(&snapshot), "source", None, 1_000_000).is_err()
            );
        }
    }

    #[test]
    fn team_degraded_or_stale_samples_send_only_unknown_heartbeat_for_existing_resources() {
        let (server, mut snapshot) = fixture();
        let stale = inventory_payload(
            &server,
            Some(&snapshot),
            "source",
            Some("resource"),
            1_091_000,
        )
        .unwrap();
        assert_eq!(stale["status"], "unknown");
        assert_eq!(stale["gpus"], json!([]));
        assert_eq!(stale["observedAt"], 1_000_000);
        assert!(inventory_payload(&server, Some(&snapshot), "source", None, 1_091_000).is_err());
        snapshot.status = "warning".into();
        snapshot.nvidia_smi = "degraded".into();
        assert!(inventory_payload(&server, Some(&snapshot), "source", None, 1_000_000).is_err());
        let degraded = inventory_payload(
            &server,
            Some(&snapshot),
            "source",
            Some("resource"),
            1_000_000,
        )
        .unwrap();
        assert_eq!(degraded["gpus"], json!([]));
        assert_eq!(degraded["status"], "unknown");
        snapshot.nvidia_smi = "available".into();
        assert_eq!(
            inventory_payload(&server, Some(&snapshot), "source", None, 1_000_000).unwrap()
                ["status"],
            "online"
        );
        snapshot.gpus.clear();
        snapshot.nvidia_smi = "missing".into();
        assert!(
            inventory_payload(&server, Some(&snapshot), "source", None, 1_000_000)
                .unwrap_err()
                .contains("CPU 资源请在预约网页手工登记")
        );
    }
    #[test]
    fn team_preset_is_consumed_only_by_first_admin_and_never_by_a_member() {
        let source = "00000000-0000-4000-8000-000000000011";
        let local = "00000000-0000-4000-8000-000000000022";
        let cloud = "00000000-0000-4000-8000-000000000033";
        let mut preset = Stored::default();
        preset
            .prepare_metadata(
                source.into(),
                BTreeMap::from([(local.into(), cloud.into())]),
            )
            .unwrap();
        assert!(preset.token.is_none() && preset.user.is_none() && preset.account_id.is_none());
        assert!(!preset.is_admin());
        assert!(!preset.public_status()["authenticated"].as_bool().unwrap());
        assert!(preset.public_status().get("preset").is_none());
        // Simulate a real restart: no test reads or writes the operating-system keyring.
        let saved = serde_json::to_string(&preset).unwrap();
        let mut admin: Stored = serde_json::from_str(&saved).unwrap();
        let generation = admin.begin_login();
        admin
            .finish_login(generation, "admin-token".into(), user("first-admin"), None)
            .unwrap();
        assert!(!admin.preset);
        assert_eq!(admin.source_id, source);
        assert_eq!(admin.bindings[local].resource_id.as_deref(), Some(cloud));
        admin.clear_login();
        let generation = admin.begin_login();
        admin
            .finish_login(
                generation,
                "admin-relogin".into(),
                user("first-admin"),
                None,
            )
            .unwrap();
        assert_eq!(admin.source_id, source);
        assert!(admin.bindings.contains_key(local));

        let mut member: Stored = serde_json::from_str(&saved).unwrap();
        let generation = member.begin_login();
        let mut account = user("first-member");
        account["role"] = json!("member");
        member
            .finish_login(generation, "member-token".into(), account, None)
            .unwrap();
        assert!(!member.preset);
        assert_ne!(member.source_id, source);
        assert!(member.bindings.is_empty());
        assert!(!member.is_admin());
    }

    #[test]
    fn team_preset_setup_rejects_existing_settings_and_invalid_mapping_without_changing_them() {
        let source = "00000000-0000-4000-8000-000000000011".to_owned();
        let bindings = BTreeMap::from([(
            "00000000-0000-4000-8000-000000000022".to_owned(),
            "00000000-0000-4000-8000-000000000033".to_owned(),
        )]);
        let mut existing = signed_in();
        let before = serde_json::to_string(&existing).unwrap();
        assert!(existing
            .prepare_metadata(source.clone(), bindings.clone())
            .is_err());
        assert_eq!(serde_json::to_string(&existing).unwrap(), before);
        existing.clear_login();
        assert!(existing
            .prepare_metadata(source.clone(), bindings.clone())
            .is_err());
        let mut blank = Stored::default();
        let before = blank.source_id.clone();
        assert!(blank
            .prepare_metadata("bad-source".into(), bindings.clone())
            .is_err());
        assert_eq!(blank.source_id, before);
        assert!(!blank.preset);
        assert!(blank
            .prepare_metadata(source.clone(), BTreeMap::new())
            .is_err());
        assert_eq!(
            blank
                .prepare_metadata(source.clone(), bindings.clone())
                .unwrap(),
            1
        );
        assert!(blank.prepare_metadata(source, bindings).is_err());
    }
}
