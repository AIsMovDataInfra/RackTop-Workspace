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
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};

pub const TEAM_URL: &str = "https://136.0.110.161";

// Intentionally neither Debug nor Serialize: this DTO must never cross IPC or
// become part of the stored account / ordinary server directory.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedCredentials {
    server_id: String,
    company: String,
    version: u64,
    credential_revision: u64,
    password: Option<String>,
    jump_password: Option<String>,
}
impl SharedCredentials {
    fn into_passwords(self, managed: &crate::models::ManagedServer) -> Result<crate::ssh_connection::SshPasswords, String> {
        let valid = |password: &Option<String>| password.as_ref().is_none_or(|s| !s.is_empty() && s.len() <= 4096 && !s.contains(['\0', '\r', '\n']));
        if self.server_id != managed.remote_id || self.company != managed.company || self.version != managed.version || self.credential_revision != managed.credential_revision
            || self.password.is_some() != managed.has_password || self.jump_password.is_some() != managed.has_jump_password || !valid(&self.password) || !valid(&self.jump_password) {
            return Err("管理员密码响应与当前连接不匹配，请刷新目录".into());
        }
        Ok(crate::ssh_connection::SshPasswords { target: self.password, proxy: self.jump_password })
    }
}

fn check_credential_session(state: &Stored, managed: &crate::models::ManagedServer) -> Result<(), String> {
    if !state.matches_session(state) || state.account_id.as_deref() != Some(&managed.account_id)
        || state.user.as_ref().is_none_or(|user| { let scope = user_scope(user); scope != "*" && scope != managed.company }) {
        return Err("团队账号或组织已变化，请重新连接".into());
    }
    Ok(())
}
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
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopedBindings {
    source_id: String,
    bindings: BTreeMap<String, Binding>,
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
    #[serde(default)]
    binding_scope: Option<String>,
    #[serde(default)]
    scope_bindings: BTreeMap<String, ScopedBindings>,
    #[serde(skip)]
    generation: u64,
    #[serde(skip)]
    login_pending: bool,
    #[serde(skip)]
    scope_pending: bool,
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
            binding_scope: None,
            scope_bindings: BTreeMap::new(),
            generation: 0,
            login_pending: false,
            scope_pending: false,
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
        if self.binding_scope.is_none() {
            if let Some(user) = self.user.clone() {
                self.enter_scope(&user);
            }
        }
    }
    fn advance(&mut self) {
        self.generation = self.generation.wrapping_add(1);
    }
    fn begin_login(&mut self) -> u64 {
        self.advance();
        self.login_pending = true;
        self.scope_pending = false;
        self.generation
    }
    fn enter_scope(&mut self, user: &Value) {
        let next = user_scope(user);
        if let Some(previous) = &self.binding_scope {
            if previous != &next {
                self.scope_bindings.insert(previous.clone(), ScopedBindings {
                    source_id: self.source_id.clone(),
                    bindings: std::mem::take(&mut self.bindings),
                });
                if let Some(saved) = self.scope_bindings.remove(&next) {
                    self.source_id = saved.source_id;
                    self.bindings = saved.bindings;
                } else {
                    self.source_id = uuid::Uuid::new_v4().to_string();
                }
            }
        }
        self.binding_scope = Some(next);
    }
    fn matches_session(&self, expected: &Stored) -> bool {
        !self.login_pending && !self.scope_pending && self.token.is_some()
            && self.generation == expected.generation && self.token == expected.token
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
            self.scope_bindings.clear();
            self.binding_scope = None;
            self.source_id = uuid::Uuid::new_v4().to_string();
        }
        self.enter_scope(&user);
        self.preset = false;
        self.account_id = Some(id.to_owned());
        self.token = Some(token);
        self.user = Some(user);
        self.expires_at = expires_at;
        self.login_pending = false;
        self.scope_pending = false;
        self.advance();
        Ok(())
    }
    fn clear_login(&mut self) -> Option<String> {
        self.migrate_account();
        self.advance();
        self.login_pending = false;
        self.scope_pending = false;
        self.user = None;
        self.expires_at = None;
        self.token.take()
    }
    fn is_admin(&self) -> bool {
        !self.login_pending && !self.scope_pending
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
        if self.generation != generation || self.token.as_deref() != Some(token) || self.login_pending || self.scope_pending {
            return Ok(());
        }
        if self.user.as_ref().and_then(|value| value.get("id")) != user.get("id") {
            return Err("团队账号状态已变化，请重新登录".into());
        }
        if self.user.as_ref() != Some(&user) {
            self.enter_scope(&user);
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
    app: OnceLock<tauri::AppHandle>,
    directory_lock: tokio::sync::Mutex<()>,
    #[cfg(any(test, feature = "integration-probe"))]
    test_url: Option<String>,
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
            app: OnceLock::new(),
            directory_lock: tokio::sync::Mutex::new(()),
            #[cfg(any(test, feature = "integration-probe"))]
            test_url: None,
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
        #[cfg(any(test, feature = "integration-probe"))]
        if self.test_url.is_some() { return Ok(()); } // Loopback fixtures never write an OS keyring, including on HTTP 401.
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
        let changed = guard.as_ref().unwrap().generation != value.generation;
        if changed { self.invalidate_directory("团队账号或组织已变化，请重新验证权限")?; }
        if persist { self.persist(&value)?; }
        let generation = value.generation;
        *guard = Some(value);
        if changed { self.changes.send_replace(generation); }
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
        self.invalidate_directory("已退出团队账号，请重新登录")?;
        self.changes.send_replace(value.generation);
        let error = self.persist(value).err();
        Ok((token, error))
    }
    pub fn status(&self) -> Result<Value, String> {
        Ok(self.read()?.public_status())
    }
    async fn refresh_status(&self) -> Result<Value, String> {
        let state = self.read()?;
        let Some(token) = state.token.as_deref().filter(|_| !state.login_pending && !state.scope_pending) else {
            return self.status();
        };
        let session = match self.request(reqwest::Method::GET, "/api/session", Some(token), None).await {
            Ok(value) => value,
            Err(error) => { self.invalidate_directory_for(&state, "无法验证团队权限，请联网后重试")?; return Err(error); }
        };
        let refreshed = login_user(session.get("user")).and_then(|user|
            self.update(state.user.as_ref() != Some(&user), |value| value.refresh_user(state.generation, token, user)));
        if let Err(error) = refreshed {
            // A locked keyring must not retain a lease after the server reports
            // a changed identity, nor after an invalid identity response.
            self.invalidate_directory_for(&state, "团队身份验证未完成，请重新登录或解锁钥匙串")?;
            return Err(error);
        }
        self.status()
    }
    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Result<Value, String> {
        self.request_with_scope(method, path, token, body, None).await
    }
    async fn request_with_scope(
        &self,
        method: reqwest::Method,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
        scope: Option<&Stored>,
    ) -> Result<Value, String> {
        // All routes are built here, not supplied by a remote resource or arbitrary WebView URL.
        #[cfg(any(test, feature = "integration-probe"))]
        let base = self.test_url.as_deref().unwrap_or(TEAM_URL);
        #[cfg(not(any(test, feature = "integration-probe")))]
        let base = TEAM_URL;
        let mut request = self
            .client
            .request(method, format!("{base}{path}"))
            .header("Origin", TEAM_URL);
        if path.ends_with("/credentials") { request = request.header("Cache-Control", "no-store"); }
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(scope) = scope {
            if !self.read()?.matches_session(scope) {
                return Err("团队账号或组织已变化，请刷新后重试".into());
            }
            request = request.header("X-RackTop-Company", company_header(scope.user.as_ref()));
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
        let response_limit = if path == "/api/servers" || path == "/api/servers?schema=2" { 16 * 1024 * 1024 } else if path.ends_with("/credentials") { 64 * 1024 } else { 2 * 1024 * 1024 };
        if response.content_length().is_some_and(|n| n > response_limit)
        {
            return Err("预约中心响应过大".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "预约中心响应中断")? {
            if bytes.len() + chunk.len() > response_limit as usize {
                return Err("预约中心响应过大".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "预约中心返回了无法识别的数据")?;
        if !status.is_success() {
            if status.as_u16() == 409 && value.pointer("/error/code").and_then(Value::as_str) == Some("COMPANY_CHANGED") {
                return Err("COMPANY_CHANGED: 当前组织已变化，请刷新后重试".into());
            }
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
    async fn switch_company(&self, company: String) -> Result<Value, String> {
        if !is_team_company(&company) {
            return Err("请选择有效组织".into());
        }
        let (generation, token) = self.update(true, |value| {
            if value.login_pending || value.scope_pending {
                return Err("账号操作进行中，请稍后重试".into());
            }
            let token = value.token.clone().ok_or("请先登录团队账号")?;
            let companies = value.user.as_ref().and_then(|user| user.get("companies")).and_then(Value::as_array);
            if !companies.is_some_and(|items| items.iter().any(|item| item.as_str() == Some(company.as_str()))) {
                return Err("此账号未加入该组织，请刷新后重试".into());
            }
            value.advance();
            value.scope_pending = true;
            Ok((value.generation, token))
        })?;
        // The server may complete a switch after a transport failure. Scoped business requests
        // cannot then run against the wrong company; the next status refresh reconciles it.
        let response = self.request(reqwest::Method::POST, "/api/auth/company", Some(&token), Some(json!({"company":company}))).await;
        let result = response.and_then(|session| login_user(session.get("user")));
        match result {
            Ok(user) => {
                self.update(false, |value| {
                    if value.generation != generation || value.token.as_deref() != Some(&token) || !value.scope_pending {
                        return Err("组织切换已取消，请刷新后重试".into());
                    }
                    value.scope_pending = false;
                    value.refresh_user(generation, &token, user)?;
                    value.advance();
                    Ok(())
                })?;
                self.update(true, |_| Ok(()))?;
            }
            Err(error) => {
                let _ = self.update(false, |value| {
                    if value.generation == generation && value.token.as_deref() == Some(&token) {
                        value.scope_pending = false;
                        value.advance();
                    }
                    Ok(())
                });
                return Err(error);
            }
        }
        self.status()
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
                            .request_with_scope(
                                reqwest::Method::POST,
                                "/api/resources/sync",
                                Some(token),
                                Some(body),
                                Some(&state),
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
    fn invalidate_directory(&self, reason: &str) -> Result<(), String> {
        if let Some(app) = self.app.get() {
            let ids = app.state::<Database>().invalidate_managed(reason)?;
            crate::managed_servers::changed(app, &ids);
        }
        Ok(())
    }
    fn invalidate_directory_for(&self, expected: &Stored, reason: &str) -> Result<(), String> {
        let guard = self.value.lock().map_err(|_| "团队设置暂时不可用")?;
        if guard.as_ref().is_some_and(|value| value.matches_session(expected)) { self.invalidate_directory(reason)?; }
        Ok(())
    }
    async fn pull_directory(&self) -> Result<(), String> {
        let Ok(_round) = self.directory_lock.try_lock() else { return Ok(()); };
        let Some(app) = self.app.get() else { return Ok(()); };
        let expected = self.read()?;
        if expected.login_pending || expected.scope_pending || expected.token.is_none() { return Ok(()); }
        let scope = expected.user.as_ref().map(user_scope).unwrap_or_default();
        if scope != "*" && !is_team_company(&scope) {
            return self.invalidate_directory_for(&expected, "请先选择已分配的组织");
        }
        let result = async {
            let value = self.request_with_scope(reqwest::Method::GET, "/api/servers?schema=2", expected.token.as_deref(), None, Some(&expected)).await?;
            crate::managed_servers::Directory::parse(value, &scope)
        }.await;
        let directory = match result {
            Ok(directory) => directory,
            Err(error) => {
                self.invalidate_directory_for(&expected, "无法验证组织服务器权限，请联网刷新")?;
                return Err(error);
            }
        };
        let ids = match self.apply_directory_if_current(&expected, &directory, &app.state::<Database>()) {
            Ok(ids) => ids,
            Err(error) => { self.invalidate_directory_for(&expected, "组织服务器目录校验失败，请重新刷新")?; return Err(error); }
        };
        crate::managed_servers::directory_changed(app, &ids);
        Ok(())
    }
    /// Shared SSH passwords live only in this operation's native memory. Every
    /// call rechecks live server authorization; there is no disk/keyring cache or
    /// fallback to a member's old password if the cloud credential is unavailable.
    pub(crate) async fn ssh_passwords(&self, database: &Database, server: &Server, allow_prompt: bool) -> Result<Option<crate::ssh_connection::SshPasswords>, String> {
        let Some(managed) = server.managed.as_ref().filter(|m| m.has_password || m.has_jump_password) else {
            return database.get_ssh_passwords(server, allow_prompt);
        };
        let expected = self.read()?;
        check_credential_session(&expected, managed)?;
        let operation = async {
            let path = format!("/api/servers/{}/credentials", managed.remote_id);
            let value = self.request_with_scope(reqwest::Method::POST, &path, expected.token.as_deref(),
                Some(json!({"version":managed.version,"credentialRevision":managed.credential_revision})), Some(&expected)).await
                .map_err(|_| "无法领取管理员密码，请刷新目录或联系管理员")?;
            // Never expose the response (including error messages) to IPC, logs,
            // exports, or serde Debug output. Decode only the exact secret DTO.
            let credentials: SharedCredentials = serde_json::from_value(value).map_err(|_| "管理员密码响应无效，请刷新目录")?;
            let current = self.read()?;
            if !current.matches_session(&expected) { return Err("团队账号或组织已变化，请重新连接".into()); }
            check_credential_session(&current, managed)?;
            database.check_managed_server(server)?;
            let actual = database.get_server(&server.id)?;
            if actual.managed.as_ref().is_none_or(|m| m.version != managed.version) { return Err("组织服务器版本已变化，请重新连接".into()); }
            let shared = credentials.into_passwords(managed)?;
            // A local private key / password may still be used for the other hop.
            // The local reader explicitly skips every shared-password slot.
            let mut passwords = database.local_ssh_passwords(server, allow_prompt)?.unwrap_or_default();
            if managed.has_password { passwords.target = shared.target; }
            if managed.has_jump_password { passwords.proxy = shared.proxy; }
            Ok(Some(passwords))
        };
        let result = crate::managed_servers::authorized(database, &[server], operation).await;
        if result.is_err() {
            let ids = database.invalidate_managed_credentials(server)?;
            if let Some(app) = self.app.get() { crate::managed_servers::changed(app, &ids); }
        }
        result
    }
    fn apply_directory_if_current(&self, expected: &Stored, directory: &crate::managed_servers::Directory, database: &Database) -> Result<Vec<String>, String> {
        let account = expected.account_id.as_deref().ok_or("缺少团队账号标识")?;
        {
            let guard = self.value.lock().map_err(|_| "团队设置暂时不可用")?;
            if !guard.as_ref().is_some_and(|value| value.matches_session(expected)) { return Ok(Vec::new()); }
            // Quarantine before a credential prompt can delay the metadata write.
            let ids = database.quarantine_directory(account, directory)?;
            if let Some(app) = self.app.get() { crate::managed_servers::changed(app, &ids); }
        }
        // Never hold the team lock while waiting for a keyring operation.
        // Logout/expiry can invalidate leases without acquiring this gate.
        let _gate = database.managed_gate.lock().map_err(|e| e.to_string())?;
        let guard = self.value.lock().map_err(|_| "团队设置暂时不可用")?;
        if !guard.as_ref().is_some_and(|value| value.matches_session(expected)) { return Ok(Vec::new()); }
        database.apply_directory_locked(account, directory, now_ms())
    }
    pub fn start(self: Arc<Self>, app: tauri::AppHandle) {
        let _ = self.app.set(app.clone());
        let lease_app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut expiry = tokio::time::interval(Duration::from_secs(1));
            loop {
                expiry.tick().await;
                if let Ok(ids) = lease_app.state::<Database>().expire_managed() { crate::managed_servers::changed(&lease_app, &ids); }
            }
        });
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut changes = self.changes.subscribe();
            loop {
                tokio::select! { _ = interval.tick() => (), _ = changes.changed() => () }
                if self.refresh_status().await.is_err() { continue; }
                // An older team service may not expose the directory; that does
                // not prevent login, reservations, or personal inventory sync.
                let _ = self.pull_directory().await;
                let data = {
                    let db = app.state::<Database>();
                    db.list_servers().and_then(|s| db.list_latest_snapshots().map(|v| (s, v)))
                };
                if let Ok((servers, snapshots)) = data { let _ = self.sync(servers, snapshots).await; }
            }
        });
    }
}

// This provisioning entry point exists only in the explicitly built local setup helper.
// It cannot be called through a Tauri command or the public reservation service.
#[cfg(feature = "integration-probe")]
pub async fn exercise_credentials_fixture(endpoint: &str) -> Result<Value, String> {
    let url = reqwest::Url::parse(endpoint).map_err(|_| "invalid fixture URL")?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || url.path() != "/" {
        return Err("credential fixture requires a loopback HTTP origin".into());
    }
    if std::env::var_os("RACKTOP_TEST_KNOWN_HOSTS").is_none() { return Err("fixture requires an isolated known_hosts file".into()); }
    let local = tempfile::tempdir().map_err(|_| "cannot create disposable fixture")?;
    let database = Database::open(&local.path().join("fixture.sqlite"))?;
    let mut manager = TeamManager::new(local.path())?;
    manager.test_url = Some(endpoint.trim_end_matches('/').into());
    manager.client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(10)).build().map_err(|_| "cannot initialize fixture client")?;
    let mut state = Stored::default();
    let generation = state.begin_login();
    state.finish_login(generation, "fixture-shared-credentials-token".into(), json!({"id":"fixture-account","name":"Fixture","role":"admin","isSuperAdmin":true,"company":""}), None)?;
    *manager.value.lock().map_err(|_| "fixture state unavailable")? = Some(state.clone());
    let value = manager.request_with_scope(reqwest::Method::GET, "/api/servers?schema=2", state.token.as_deref(), None, Some(&state)).await?;
    let rows = value.get("servers").and_then(Value::as_array).ok_or("fixture directory missing servers")?;
    if rows.is_empty() || rows.iter().any(|row| {
        let loopback = |host: Option<&str>| host.is_some_and(|s| matches!(s,"127.0.0.1" | "::1"));
        !loopback(row.get("host").and_then(Value::as_str)) || row.get("hasPassword") != Some(&json!(true))
            || (row.get("jump").is_some_and(|v| !v.is_null()) && (!loopback(row.pointer("/jump/host").and_then(Value::as_str)) || row.get("hasJumpPassword") != Some(&json!(true))))
    }) { return Err("fixture permits only loopback targets with shared passwords for each hop".into()); }
    let directory = crate::managed_servers::Directory::parse(value, "*")?;
    database.apply_directory("fixture-account", &directory, crate::managed_servers::now_ms())?;
    let servers = database.list_servers()?;
    for server in &servers {
        // Repeat the actual read to prove that subsequent operations do not use
        // a persisted or cached shared password. Never print command stderr.
        for _ in 0..2 {
            let passwords = manager.ssh_passwords(&database, server, false).await?;
            crate::managed_servers::authorized(&database, &[server], async {
                let (mut command, target) = crate::collector::configured_ssh_command(server, passwords.as_ref())?;
                let output = command.arg(target).arg("printf '__RACKTOP_SHARED_PASSWORD_READY__'").output().await.map_err(|_| "fixture SSH failed")?;
                if !output.status.success() || output.stdout != b"__RACKTOP_SHARED_PASSWORD_READY__" { return Err("fixture SSH authentication or fixed marker failed".into()); }
                Ok(())
            }).await?;
        }
    }
    if !database.session_passwords.lock().map_err(|_| "fixture cache unavailable")?.is_empty() { return Err("shared credentials entered local cache".into()); }
    Ok(json!({"servers":servers.len(),"sshConnections":servers.len()*2,"sharedPasswordsPersisted":false,"liveCredentialFetchPerOperation":true}))
}

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
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("账号姓名无效")?;
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
    if let Some(companies) = value.get("companies") {
        let items = companies.as_array().ok_or("账号组织列表无效")?;
        let mut seen = BTreeSet::new();
        if items.len() > 4 || items.iter().any(|item| !item.as_str().is_some_and(|company| is_team_company(company) && seen.insert(company))) {
            return Err("账号组织列表无效".into());
        }
        if let Some(company) = value.get("company").and_then(Value::as_str) {
            if !seen.contains(company) { return Err("账号当前组织不在归属列表中".into()); }
        }
        projected["companies"] = companies.clone();
    }
    if let Some(is_super_admin) = value.get("isSuperAdmin") {
        if !is_super_admin.is_boolean() { return Err("账号权限无效".into()); }
        projected["isSuperAdmin"] = is_super_admin.clone();
    }
    if let Some(version) = value.get("version") {
        if !version.as_u64().is_some_and(|number| number > 0) { return Err("账号版本无效".into()); }
        projected["version"] = version.clone();
    }
    if let Some(avatar) = value.get("avatar").and_then(Value::as_str).filter(|value| value.len() <= 64) {
        projected["avatar"] = json!(avatar);
    }
    Ok(projected)
}

fn user_scope(user: &Value) -> String {
    if user.get("isSuperAdmin") == Some(&Value::Bool(true)) {
        "*".into()
    } else {
        match user.get("company") {
            None => "legacy".into(),
            Some(Value::String(company)) => company.clone(),
            _ => "unassigned".into(),
        }
    }
}

fn company_header(user: Option<&Value>) -> String {
    let company = user.and_then(|user| user.get("company")).and_then(Value::as_str).unwrap_or("");
    let mut encoded = String::new();
    for byte in company.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
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
    if server.managed.is_some() { return Err("组织服务器不能作为个人连接上传，请由管理员维护团队目录".into()); }
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
pub async fn team_switch_company(state: State<'_, TeamState>, company: String) -> Result<Value, String> {
    state.0.switch_company(company).await
}
#[tauri::command]
pub async fn team_data(state: State<'_, TeamState>) -> Result<Value, String> {
    let session = state.0.read()?;
    let token = session.token.as_deref().ok_or("请先登录团队账号")?;
    let resources = state
        .0
        .request_with_scope(
            reqwest::Method::GET,
            "/api/resources",
            Some(token),
            None,
            Some(&session),
        )
        .await?;
    let reservations = state
        .0
        .request_with_scope(
            reqwest::Method::GET,
            "/api/reservations",
            Some(token),
            None,
            Some(&session),
        )
        .await?;
    if !state.0.read()?.matches_session(&session) {
        return Err("团队账号或组织已变化，请刷新后重试".into());
    }
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
        if database.get_server(id)?.managed.is_some() { return Err("组织服务器不能作为个人连接上传".into()); }
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
        let mut with_avatar = account.clone();
        with_avatar["avatar"] = json!("robot");
        assert_eq!(login_user(Some(&with_avatar)).unwrap()["avatar"], "robot");
        with_avatar["avatar"] = json!("a".repeat(65));
        assert!(login_user(Some(&with_avatar)).unwrap().get("avatar").is_none());
    }

    #[test]
    fn team_organization_switch_preserves_each_selection_without_publishing_to_another_company() {
        let mut value = signed_in();
        let mut account_a = user("member-1");
        account_a["company"] = json!("A公司");
        account_a["companies"] = json!(["A公司", "西浦"]);
        value.user = Some(account_a.clone());
        // An upgraded profile has no bindingScope; adopt its existing organization once.
        value.binding_scope = None;
        value.migrate_account();
        let source_a = value.source_id.clone();
        let snapshot_a = value.clone();
        let mut account_b = account_a.clone();
        account_b["company"] = json!("西浦");
        value.refresh_user(value.generation, "test-session-token", account_b.clone()).unwrap();
        assert!(!value.matches_session(&snapshot_a));
        assert!(value.bindings.is_empty());
        assert_ne!(source_a, value.source_id);
        value.select(value.generation, vec!["connection-c".into()]).unwrap();
        let source_b = value.source_id.clone();
        let mut value: Stored = serde_json::from_str(&serde_json::to_string(&value).unwrap()).unwrap();
        value.refresh_user(value.generation, "test-session-token", account_a).unwrap();
        assert_eq!(value.source_id, source_a);
        assert_eq!(value.bindings["connection-a"].resource_id.as_deref(), Some("cloud-resource"));
        assert!(!value.bindings.contains_key("connection-c"));
        value.refresh_user(value.generation, "test-session-token", account_b).unwrap();
        assert_eq!(value.source_id, source_b);
        assert_eq!(value.bindings.keys().map(String::as_str).collect::<Vec<_>>(), ["connection-c"]);
        let generation = value.begin_login();
        value.finish_login(generation, "another-token".into(), user("member-2"), None).unwrap();
        assert!(value.scope_bindings.is_empty());
        assert!(value.bindings.is_empty());
    }

    #[test]
    fn team_company_context_header_is_ascii_and_memberships_are_validated() {
        let account = json!({"id":"member-1","name":"成员","username":"member","role":"member", "company":"西浦", "companies":["A公司","西浦"]});
        assert_eq!(company_header(Some(&account)), "%E8%A5%BF%E6%B5%A6");
        assert_eq!(company_header(None), "");
        assert_eq!(login_user(Some(&account)).unwrap()["companies"], account["companies"]);
        for companies in [json!(["A公司"]), json!(["西浦","西浦"]), json!(["未知公司"]), json!("西浦")] {
            let mut invalid = account.clone();
            invalid["companies"] = companies;
            assert!(login_user(Some(&invalid)).is_err());
        }
        let mut value = signed_in();
        let previous = value.clone();
        value.scope_pending = true;
        assert!(!value.matches_session(&previous));
        assert!(!value.is_admin());
        value.clear_login();
        assert!(!value.scope_pending);
        assert!(!value.matches_session(&previous));
    }

    #[test]
    fn managed_directory_cannot_commit_after_logout_or_organization_switch() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("directory.sqlite")).unwrap();
        let manager = TeamManager::new(dir.path()).unwrap();
        let mut stored = Stored::default();
        let generation = stored.begin_login();
        let mut account = user("member-1"); account["company"] = json!("A公司");
        stored.finish_login(generation, "fixture-session".into(), account, None).unwrap();
        let expected = stored.clone();
        *manager.value.lock().unwrap() = Some(stored);
        let directory = crate::managed_servers::Directory::parse(json!({"schemaVersion":1,"revision":"a".repeat(64),"servers":[{
            "id":"00000000-0000-4000-8000-000000000001","company":"A公司","name":"GPU 1","host":"node.example","port":22,"username":"worker","jump":null,"enabled":true,"version":1,"updatedAt":"2026-09-11T12:00:00.000Z"
        }]}), "A公司").unwrap();
        manager.value.lock().unwrap().as_mut().unwrap().clear_login();
        assert!(manager.apply_directory_if_current(&expected, &directory, &db).unwrap().is_empty());
        assert!(db.list_servers().unwrap().is_empty());
        let mut switched = expected.clone(); switched.user.as_mut().unwrap()["company"] = json!("B公司"); switched.advance();
        *manager.value.lock().unwrap() = Some(switched);
        assert!(manager.apply_directory_if_current(&expected, &directory, &db).unwrap().is_empty());
        assert!(db.list_servers().unwrap().is_empty());
        *manager.value.lock().unwrap() = Some(expected.clone());
        assert_eq!(manager.apply_directory_if_current(&expected, &directory, &db).unwrap().len(),1);
    }

    fn shared_fixture() -> (tempfile::TempDir, Database, TeamManager, Server, Value) {
        let dir=tempfile::tempdir().unwrap();
        let db=Database::open(&dir.path().join("shared.sqlite")).unwrap();
        let mut manager=TeamManager::new(dir.path()).unwrap();
        manager.client=reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(3)).build().unwrap();
        let mut state=Stored::default();let generation=state.begin_login();
        let mut account=user("fixture-account");account["company"]=json!("A公司");
        state.finish_login(generation,"fixture-shared-token".into(),account,None).unwrap();
        *manager.value.lock().unwrap()=Some(state);
        let row=json!({"id":"00000000-0000-4000-8000-000000000001","company":"A公司","name":"Shared","host":"node.example","port":22,"username":"worker","jump":{"host":"jump.example","port":2222,"username":"hop"},"enabled":true,"version":1,"updatedAt":"2026-09-12T01:00:00.000Z","hasPassword":true,"hasJumpPassword":true,"credentialRevision":1});
        let directory=crate::managed_servers::Directory::parse(json!({"schemaVersion":2,"revision":"a".repeat(64),"servers":[row.clone()]}),"A公司").unwrap();
        db.apply_directory("fixture-account",&directory,crate::managed_servers::now_ms()).unwrap();
        let server=db.list_servers().unwrap().pop().unwrap();
        (dir,db,manager,server,row)
    }

    fn shared_response(server: &Server) -> Value {
        let m=server.managed.as_ref().unwrap();
        json!({"serverId":m.remote_id,"company":m.company,"version":m.version,"credentialRevision":m.credential_revision,"password":"  合成 target 密码  ","jumpPassword":"独立 jump 密码"})
    }

    // Loopback HTTP bytes exercise the production reqwest path without reading a
    // real keyring, changing a user profile, or connecting to the team service.
    fn serve_shared_response(value: Value, status: u16, delay: Duration) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read,Write};
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url=format!("http://{}",listener.local_addr().unwrap());
        let handle=std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let start=std::time::Instant::now();
            let (mut stream,_)=loop { match listener.accept() { Ok(pair)=>break pair,Err(error) if error.kind()==std::io::ErrorKind::WouldBlock && start.elapsed()<Duration::from_secs(3)=>std::thread::sleep(Duration::from_millis(2)),Err(error)=>panic!("fixture accept: {error}") } };
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut bytes=Vec::new();let mut buffer=[0;2048];
            loop {
                let n=stream.read(&mut buffer).unwrap();if n==0 { break; }bytes.extend_from_slice(&buffer[..n]);
                if let Some(end)=bytes.windows(4).position(|s|s==b"\r\n\r\n") {
                    let head=String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    let length=head.lines().find_map(|line|line.strip_prefix("content-length: ")).and_then(|s|s.parse::<usize>().ok()).unwrap_or(0);
                    if bytes.len()>=end+4+length { break; }
                }
            }
            std::thread::sleep(delay);
            let body=value.to_string();let response=format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",body.len());
            let _=stream.write_all(response.as_bytes());
            String::from_utf8(bytes).unwrap()
        });
        (url,handle)
    }

    #[tokio::test]
    async fn shared_credentials_use_live_device_scope_keep_hops_separate_and_never_persist() {
        let (dir,db,mut manager,server,_)=shared_fixture();
        for _ in 0..2 {
            let (url,http)=serve_shared_response(shared_response(&server),200,Duration::ZERO); manager.test_url=Some(url);
            let passwords=manager.ssh_passwords(&db,&server,false).await.unwrap().unwrap();
            assert_eq!(passwords.target.as_deref(),Some("  合成 target 密码  "));
            assert_eq!(passwords.proxy.as_deref(),Some("独立 jump 密码"));
            let request=http.join().unwrap();
            assert!(request.starts_with("POST /api/servers/00000000-0000-4000-8000-000000000001/credentials HTTP/1.1"));
            let head=request.to_lowercase(); assert!(head.contains("authorization: bearer fixture-shared-token"));
            assert!(head.contains("x-racktop-company: a%e5%85%ac%e5%8f%b8"));assert!(head.contains("cache-control: no-store"));
            let body:Value=serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();assert_eq!(body,json!({"version":1,"credentialRevision":1}));
            assert!(!format!("{passwords:?}").contains("密码"));
        }
        assert!(db.session_passwords.lock().unwrap().is_empty());
        for entry in std::fs::read_dir(dir.path()).unwrap() {
            let bytes=std::fs::read(entry.unwrap().path()).unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains("合成 target 密码"));
            assert!(!String::from_utf8_lossy(&bytes).contains("独立 jump 密码"));
        }
        assert!(!serde_json::to_string(&db.list_servers().unwrap()).unwrap().contains("合成 target 密码"));
    }

    #[tokio::test]
    async fn shared_credential_denial_or_bad_binding_has_no_local_fallback_or_response_leak() {
        for (field,value,status) in [("error",json!({"message":"SERVER-SECRET-MUST-NOT-LEAK"}),403),("error",json!({"message":"SESSION-SECRET-MUST-NOT-LEAK"}),401),("password",json!("x".repeat(4097)),200),("version",json!(2),200),("credentialRevision",json!(2),200),("company",json!("B公司"),200),("serverId",json!("other"),200),("password",Value::Null,200),("jumpPassword",json!("bad\nsecret"),200)] {
            let (_dir,db,mut manager,server,_)=shared_fixture();
            db.session_passwords.lock().unwrap().insert(server.id.clone(),"old-local-password".into());
            let mut response=shared_response(&server);response[field]=value;
            let (url,http)=serve_shared_response(response,status,Duration::ZERO);manager.test_url=Some(url);
            let error=manager.ssh_passwords(&db,&server,false).await.unwrap_err();
            assert!(!error.contains("SECRET") && !error.contains("secret") && !error.contains("old-local-password"));
            assert!(db.get_server(&server.id).is_err());assert!(db.session_passwords.lock().unwrap().is_empty());
            http.join().unwrap();
        }
    }

    #[tokio::test]
    async fn shared_credential_response_cannot_survive_rotation_scope_change_or_revoke_regrant() {
        for change in ["scope","rotation","regrant"] {
            let (_dir,db,mut manager,server,mut row)=shared_fixture();
            let (url,http)=serve_shared_response(shared_response(&server),200,Duration::from_millis(80));manager.test_url=Some(url);
            let operation=manager.ssh_passwords(&db,&server,false);
            let invalidate=async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                if change=="scope" {
                    let mut state=manager.value.lock().unwrap();let state=state.as_mut().unwrap();state.user.as_mut().unwrap()["company"]=json!("B公司");state.advance();
                } else {
                    if change=="rotation" { row["version"]=json!(2);row["credentialRevision"]=json!(2); }
                    else { db.invalidate_managed("fixture revoked").unwrap(); }
                    let directory=crate::managed_servers::Directory::parse(json!({"schemaVersion":2,"revision":"b".repeat(64),"servers":[row]}),"A公司").unwrap();
                    db.apply_directory("fixture-account",&directory,crate::managed_servers::now_ms()).unwrap();
                }
            };
            let (result,())=tokio::join!(operation,invalidate);assert!(result.is_err(),"{change}");http.join().unwrap();
            assert!(db.session_passwords.lock().unwrap().is_empty());
        }
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
        for username in ["中".to_owned(), "a".to_owned(), " A.+ @ 中文 ! ".repeat(80), "Cafe\u{301}".to_owned()] {
            for password in ["密".to_owned(), " ".repeat(12), "中文密码 ! ".repeat(100)] {
                assert!(validate_login_input(&username, &password).is_ok());
            }
            let projected = login_user(Some(
                &json!({"id":"member-1","name":username,"username":username,"role":"member"}),
            ))
            .unwrap();
            assert_eq!(projected["username"], username);
            assert_eq!(projected["name"], username);
        }
        assert!(validate_login_input(" \t ", "密").is_err());
        assert!(validate_login_input("中", "").is_err());
        assert!(login_user(Some(
            &json!({"id":"member-1","name":"成员","username":"   ","role":"member"})
        ))
        .is_err());
        assert!(login_user(Some(
            &json!({"id":"member-1","name":"   ","username":"成员","role":"member"})
        ))
        .is_err());
    }

    #[test]
    fn team_inventory_rejects_managed_connections_even_with_cached_hardware_and_an_old_binding() {
        let (mut server,snapshot)=fixture();
        for available in [true,false] {
            server.managed=Some(crate::models::ManagedServer { account_id:"member-1".into(),company:"A公司".into(),remote_id:"remote".into(),available,reason:None,version:1,has_password:false,has_jump_password:false,credential_revision:0,epoch:0 });
            assert!(inventory_payload(&server,Some(&snapshot),"old-personal-source",Some("old-resource"),1_000_000).unwrap_err().contains("个人连接"));
        }
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
