//! Organization connection metadata is kept separate from personal connections.
//! Authorization is a short lease, never restored from disk after a restart.
use crate::{models::{ManagedServer, Server, ServerDraft}, storage::Database};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, net::IpAddr, time::{SystemTime, UNIX_EPOCH}};
use tauri::{Emitter, Manager};

pub(crate) const LEASE_MS: i64 = 75_000;
const AUTH_REQUIRED: &str = "请先配置本机 SSH 认证";
const EXPIRED: &str = "请联网重新验证团队权限";
const CREDENTIAL_FIELDS: [&str; 3] = ["hasPassword", "hasJumpPassword", "credentialRevision"];
pub(crate) fn now_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64 }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Destination { host: String, port: u16, username: String }
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteServer {
    id: String, company: String, name: String, host: String, port: u16, username: String,
    jump: Option<Destination>, enabled: bool, version: u64, updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    member_ids: Option<Vec<String>>,
    #[serde(default)]
    has_password: bool,
    #[serde(default)]
    has_jump_password: bool,
    #[serde(default)]
    credential_revision: u64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Directory { schema_version: u32, revision: String, servers: Vec<RemoteServer> }

fn text(value: &str, max: usize) -> bool { !value.is_empty() && value.trim() == value && value.chars().count() <= max && !value.chars().any(char::is_control) }
fn company(value: &str) -> bool { matches!(value, "A公司" | "B公司" | "C公司" | "西浦") }
fn destination(host: &str, port: u16, username: &str) -> bool {
    let valid_host = host.parse::<IpAddr>().is_ok() || host.split('.').all(|label| !label.is_empty() && label.len() <= 63
        && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && !label.starts_with('-') && !label.ends_with('-'));
    text(host, 253) && valid_host && port > 0 && text(username, 64)
        && username.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        && username.as_bytes()[0] != b'-' && username.as_bytes()[0] != b'.'
}
impl RemoteServer {
    fn proxy(&self) -> Option<String> { self.jump.as_ref().map(|jump| format!("{}@{}:{}", jump.username,
        if jump.host.contains(':') { format!("[{}]", jump.host) } else { jump.host.clone() }, jump.port)) }
    fn target_changed(&self, old: &Self) -> bool { self.host != old.host || self.port != old.port || self.username != old.username || self.jump != old.jump }
    fn credentials_changed(&self, old: &Self) -> bool {
        self.has_password != old.has_password || self.has_jump_password != old.has_jump_password || self.credential_revision != old.credential_revision
    }
}
impl Directory {
    pub(crate) fn parse(value: serde_json::Value, scope: &str) -> Result<Self, String> {
        // Defaults only migrate metadata already stored by older clients. On the
        // wire v2 must explicitly describe both credential sources and revision.
        let schema = value.get("schemaVersion").and_then(serde_json::Value::as_u64);
        if let Some(rows) = value.get("servers").and_then(serde_json::Value::as_array) {
            for row in rows {
                let keys = CREDENTIAL_FIELDS;
                if (schema == Some(1) && keys.iter().any(|key| row.get(key).is_some()))
                    || (schema == Some(2) && (row.get(keys[0]).and_then(serde_json::Value::as_bool).is_none()
                        || row.get(keys[1]).and_then(serde_json::Value::as_bool).is_none()
                        || row.get(keys[2]).and_then(serde_json::Value::as_u64).is_none())) {
                    return Err("组织服务器认证元数据格式无效".into());
                }
            }
        }
        let mut result: Self = serde_json::from_value(value).map_err(|_| "组织服务器目录格式无效")?;
        if !matches!(result.schema_version, 1 | 2) || result.revision.len() != 64 || !result.revision.bytes().all(|b| b.is_ascii_hexdigit()) || result.servers.len() > 2000 {
            return Err("组织服务器目录版本或大小无效".into());
        }
        let mut ids = HashSet::new();
        for server in &result.servers {
            if uuid::Uuid::parse_str(&server.id).is_err() || !ids.insert(&server.id) || !company(&server.company)
                || (scope != "*" && server.company != scope) || !text(&server.name, 24)
                || !destination(&server.host, server.port, &server.username)
                || server.jump.as_ref().is_some_and(|jump| !destination(&jump.host, jump.port, &jump.username))
                || server.version == 0 || server.version > 9_007_199_254_740_991 || !text(&server.updated_at, 64)
                || server.credential_revision > 9_007_199_254_740_991
                || ((server.has_password || server.has_jump_password) && server.credential_revision == 0)
                || (server.has_jump_password && server.jump.is_none())
                || server.member_ids.as_ref().is_some_and(|ids| ids.len() > 128 || ids.iter().any(|id| uuid::Uuid::parse_str(id).is_err())) {
                return Err("组织服务器目录包含越权组织、重复记录或无效连接字段".into());
            }
        }
        for server in &mut result.servers { server.member_ids = None; }
        Ok(result)
    }
}

pub(crate) fn initialize(connection: &Connection) -> Result<(), String> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS managed_servers (
        local_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE RESTRICT,
        account_id TEXT NOT NULL, company TEXT NOT NULL, remote_id TEXT NOT NULL,
        definition_json TEXT NOT NULL, version INTEGER NOT NULL,
        authorized_until INTEGER NOT NULL DEFAULT 0, configured INTEGER NOT NULL DEFAULT 0, reason TEXT, epoch INTEGER NOT NULL DEFAULT 0,
        UNIQUE(account_id,company,remote_id));
        ").map_err(|e| e.to_string())?;
    let columns = connection.prepare("PRAGMA table_info(managed_servers)").map_err(|e| e.to_string())?.query_map([], |row| row.get::<_, String>(1)).map_err(|e| e.to_string())?.collect::<Result<HashSet<_>, _>>().map_err(|e| e.to_string())?;
    if !columns.contains("epoch") { connection.execute("ALTER TABLE managed_servers ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0", []).map_err(|e| e.to_string())?; }
    connection.execute("UPDATE managed_servers SET authorized_until=0,epoch=epoch+1,reason='请联网重新验证团队权限'", []).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn decorate(connection: &Connection, servers: &mut [Server], now: i64) -> Result<(), String> {
    let mut query = connection.prepare("SELECT local_id,account_id,company,remote_id,version,authorized_until,configured,reason,definition_json,epoch FROM managed_servers").map_err(|e| e.to_string())?;
    let records = query.query_map([], |row| {
        let until: i64 = row.get(5)?;
        let configured: bool = row.get(6)?;
        let reason: Option<String> = row.get(7)?;
        let encoded: String = row.get(8)?;
        let definition: RemoteServer = serde_json::from_str(&encoded).map_err(|error| rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, Box::new(error)))?;
        let configured = configured || definition.has_password;
        Ok((row.get::<_, String>(0)?, ManagedServer { account_id: row.get(1)?, company: row.get(2)?, remote_id: row.get(3)?, version: row.get(4)?,
            has_password: definition.has_password, has_jump_password: definition.has_jump_password, credential_revision: definition.credential_revision, epoch: row.get(9)?,
            available: until > now && configured,
            reason: if until <= now { Some(reason.unwrap_or_else(|| EXPIRED.into())) } else if !configured { Some(AUTH_REQUIRED.into()) } else { None } }))
    }).map_err(|e| e.to_string())?.collect::<Result<HashMap<_, _>, _>>().map_err(|e| e.to_string())?;
    for server in servers {
        server.managed = records.get(&server.id).cloned();
        if let Some(managed) = &server.managed {
            // Effective authentication only. Shared secrets and mode overrides
            // never replace a member's local credentials on disk.
            if managed.has_password { server.auth_method = "password".into(); server.identity_file = None; }
            if managed.has_jump_password { server.proxy_use_password = true; server.save_proxy_password = false; }
            if !managed.available { server.status = "offline".into(); server.last_error = managed.reason.clone(); }
        }
    }
    Ok(())
}

pub(crate) fn changed(app: &tauri::AppHandle, ids: &[String]) {
    if ids.is_empty() { return; }
    app.state::<crate::terminal::TerminalManager>().close_servers(ids);
    let _ = app.emit("managed-servers-changed", serde_json::json!({"affectedIds":ids}));
}

pub(crate) fn directory_changed(app: &tauri::AppHandle, ids: &[String]) {
    if !ids.is_empty() {
        // Metadata refreshes do not terminate unaffected SSH sessions; target
        // changes were already quarantined and announced with affected IDs.
        let _ = app.emit("managed-servers-changed", serde_json::json!({"affectedIds":[]}));
    }
}

impl Database {
    pub(crate) fn managed_epoch(&self, id: &str) -> Result<Option<i64>, String> {
        self.connection.lock().map_err(|e| e.to_string())?.query_row("SELECT epoch FROM managed_servers WHERE local_id=?1", [id], |row| row.get(0)).optional().map_err(|e| e.to_string())
    }

    /// Stop affected endpoints before waiting for a pending credential prompt.
    /// The caller emits the terminal-close event before apply_directory waits.
    pub(crate) fn quarantine_directory(&self, account: &str, directory: &Directory) -> Result<Vec<String>, String> {
        let connection = self.connection.lock().map_err(|e| e.to_string())?;
        let rows = connection.prepare("SELECT local_id,account_id,company,remote_id,definition_json FROM managed_servers WHERE authorized_until>0").map_err(|e| e.to_string())?
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        let mut ids = Vec::new();
        for (id, owner, company, remote_id, encoded) in rows {
            let next = directory.servers.iter().find(|s| s.id == remote_id && s.company == company && s.enabled);
            let previous: RemoteServer = serde_json::from_str(&encoded).map_err(|_| "本机组织目录记录损坏")?;
            if owner != account || next.is_none_or(|s| s.target_changed(&previous) || s.credentials_changed(&previous)) {
                connection.execute("UPDATE managed_servers SET authorized_until=0,epoch=epoch+1,reason='组织服务器权限或目标已变化，请重新验证' WHERE local_id=?1", [&id]).map_err(|e| e.to_string())?;
                ids.push(id);
            }
        }
        self.forget_managed_session_credentials(&ids)?;
        if !ids.is_empty() { self.managed_changes.send_replace(()); }
        Ok(ids)
    }

    /// Caller holds the team generation lock until this transaction commits.
    pub(crate) fn apply_directory(&self, account: &str, directory: &Directory, now: i64) -> Result<Vec<String>, String> {
        let mut ids = self.quarantine_directory(account, directory)?;
        let _gate = self.managed_gate.lock().map_err(|e| e.to_string())?;
        ids.extend(self.apply_directory_locked(account, directory, now)?);
        ids.sort(); ids.dedup();
        Ok(ids)
    }
    /// The caller holds managed_gate, acquired before the team generation lock.
    pub(crate) fn apply_directory_locked(&self, account: &str, directory: &Directory, now: i64) -> Result<Vec<String>, String> {
        if !text(account, 128) { return Err("组织账号标识无效".into()); }
        let mut connection = self.connection.lock().map_err(|e| e.to_string())?;
        let transaction = connection.transaction().map_err(|e| e.to_string())?;
        let old = {
            let mut query = transaction.prepare("SELECT local_id,account_id,company,remote_id,definition_json,authorized_until,configured FROM managed_servers").map_err(|e| e.to_string())?;
            query.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, i64>(5)?, row.get::<_, bool>(6)?)))
                .map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        let mut affected = HashSet::new();
        let mut reset = Vec::new();
        for (id, owner, company, remote, _, until, _) in &old {
            if owner != account || !directory.servers.iter().any(|s| &s.company == company && &s.id == remote && s.enabled) {
                if *until > 0 { affected.insert(id.clone()); }
                transaction.execute("UPDATE managed_servers SET authorized_until=0,reason='此组织服务器已停用或当前账号无访问权限' WHERE local_id=?1", [id]).map_err(|e| e.to_string())?;
            }
        }
        for remote in &directory.servers {
            let previous = old.iter().find(|(_, owner, company, id, _, _, _)| owner == account && company == &remote.company && id == &remote.id);
            let id = previous.map(|p| p.0.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let mut encoded = serde_json::to_value(remote).map_err(|e| e.to_string())?;
            if directory.schema_version == 1 {
                // Missing metadata must remain distinguishable from explicit
                // schema 2 values when a newer service becomes available.
                if let Some(fields) = encoded.as_object_mut() { for key in CREDENTIAL_FIELDS { fields.remove(key); } }
            }
            let encoded = serde_json::to_string(&encoded).map_err(|e| e.to_string())?;
            let mut reset_local = false;
            if let Some((_, _, _, _, definition, until, _)) = previous {
                let value: serde_json::Value = serde_json::from_str(definition).map_err(|_| "本机组织目录记录损坏，原记录已保留")?;
                let legacy = CREDENTIAL_FIELDS.iter().all(|key| value.get(key).is_none());
                let earlier: RemoteServer = serde_json::from_value(value).map_err(|_| "本机组织目录记录损坏，原记录已保留")?;
                if directory.schema_version == 1 && !legacy { return Err("组织目录缺少已记录的认证元数据，请刷新后重试".into()); }
                let mut upgraded = earlier.clone();
                upgraded.has_password = remote.has_password;
                upgraded.has_jump_password = remote.has_jump_password;
                upgraded.credential_revision = remote.credential_revision;
                // 2.5 stored schema 1 at the current server version. Only fill
                // its entirely absent credential metadata; no existing field
                // or known credential value may change at the same version.
                let fills_legacy_metadata = legacy && directory.schema_version == 2 && remote == &upgraded;
                if remote.version < earlier.version || (remote.version == earlier.version && remote != &earlier && !fills_legacy_metadata) { return Err("组织目录返回旧版本或冲突记录，请刷新后重试".into()); }
                if remote.credential_revision < earlier.credential_revision { return Err("组织目录返回旧认证版本，请刷新后重试".into()); }
                reset_local = remote.target_changed(&earlier) || (earlier.has_password && !remote.has_password) || (earlier.has_jump_password && !remote.has_jump_password);
                if remote.credentials_changed(&earlier) { reset.push(id.clone()); }
                if remote != &earlier || (*until > now) != remote.enabled { affected.insert(id.clone()); }
                transaction.execute("UPDATE servers SET name=?2,host=?3,port=?4,username=?5,proxy_jump=?6 WHERE id=?1", params![id, remote.name, remote.host, remote.port, remote.username, remote.proxy()]).map_err(|e| e.to_string())?;
            } else {
                affected.insert(id.clone());
                transaction.execute("INSERT INTO servers(id,name,host,port,username,proxy_jump,tags_json,sampling_interval_seconds,history_retention_days,auth_method,status,sort_order)
                    VALUES(?1,?2,?3,?4,?5,?6,'[]',10,90,'sshAgent','unknown',COALESCE((SELECT MAX(sort_order)+1 FROM servers),0))",
                    params![id, remote.name, remote.host, remote.port, remote.username, remote.proxy()]).map_err(|e| e.to_string())?;
            }
            if reset_local {
                reset.push(id.clone());
                transaction.execute("UPDATE servers SET credential_storage_state='none',auth_method='sshAgent',identity_file=NULL,ssh_alias=NULL,proxy_use_password=0,status='unknown',last_error=NULL,last_seen_at=NULL WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
                transaction.execute("DELETE FROM proxy_credentials WHERE server_id=?1", [&id]).map_err(|e| e.to_string())?;
            }
            transaction.execute("INSERT INTO managed_servers(local_id,account_id,company,remote_id,definition_json,version,authorized_until,configured,reason)
                VALUES(?1,?2,?3,?4,?5,?6,?7,0,?8) ON CONFLICT(local_id) DO UPDATE SET definition_json=excluded.definition_json,version=excluded.version,
                authorized_until=excluded.authorized_until,configured=CASE WHEN ?9 THEN 0 ELSE managed_servers.configured END,reason=excluded.reason",
                params![id, account, remote.company, remote.id, encoded, remote.version, if remote.enabled { now + LEASE_MS } else { 0 }, if remote.enabled { None } else { Some("此组织服务器已停用") }, reset_local]).map_err(|e| e.to_string())?;
        }
        // Clear cached secrets before releasing the transaction / operation gate;
        // old keyring values remain inaccessible because persistence is disabled.
        self.forget_managed_session_credentials(&reset)?;
        transaction.commit().map_err(|e| e.to_string())?;
        self.managed_changes.send_replace(());
        Ok(affected.into_iter().collect())
    }

    pub(crate) fn forget_managed_session_credentials(&self, ids: &[String]) -> Result<(), String> {
        let mut passwords = self.session_passwords.lock().map_err(|e| e.to_string())?;
        let mut errors = self.credential_errors.lock().map_err(|e| e.to_string())?;
        for id in ids { for key in [id.clone(), format!("proxy:{id}")] { passwords.remove(&key); errors.remove(&key); } }
        Ok(())
    }

    pub(crate) fn invalidate_managed(&self, reason: &str) -> Result<Vec<String>, String> {
        // Never wait on the credential gate: a keyring dialog cannot postpone revocation.
        let connection = self.connection.lock().map_err(|e| e.to_string())?;
        let ids = connection.prepare("SELECT local_id FROM managed_servers WHERE authorized_until>0").map_err(|e| e.to_string())?
            .query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        connection.execute("UPDATE managed_servers SET authorized_until=0,epoch=epoch+1,reason=?1 WHERE authorized_until>0", [reason]).map_err(|e| e.to_string())?;
        self.forget_managed_session_credentials(&ids)?;
        self.managed_changes.send_replace(());
        Ok(ids)
    }

    pub(crate) fn invalidate_managed_credentials(&self, server: &Server) -> Result<Vec<String>, String> {
        let Some(managed) = &server.managed else { return Ok(Vec::new()); };
        let connection = self.connection.lock().map_err(|e| e.to_string())?;
        let changed = connection.execute("UPDATE managed_servers SET authorized_until=0,epoch=epoch+1,reason='无法领取管理员密码，请联网刷新或联系管理员' WHERE local_id=?1 AND epoch=?2 AND authorized_until>0", params![server.id, managed.epoch]).map_err(|e| e.to_string())?;
        let ids = if changed > 0 { vec![server.id.clone()] } else { Vec::new() };
        self.forget_managed_session_credentials(&ids)?;
        if !ids.is_empty() { self.managed_changes.send_replace(()); }
        Ok(ids)
    }

    /// The save operation holds managed_gate through keyring/cache changes.
    pub(crate) fn validate_managed_draft(&self, draft: &ServerDraft) -> Result<bool, String> {
        let Some(id) = draft.id.as_deref() else { return Ok(false); };
        let Some(server) = self.list_servers()?.into_iter().find(|s| s.id == id) else { return Ok(false); };
        let Some(managed) = &server.managed else { return Ok(false); };
        if draft.name.trim() != server.name || draft.host.trim() != server.host || draft.port != server.port || draft.username.trim() != server.username
            || draft.proxy_jump.as_deref().filter(|s| !s.trim().is_empty()).map(str::trim) != server.proxy_jump.as_deref()
            || draft.ssh_alias.as_deref().is_some_and(|s| !s.trim().is_empty()) || draft.location != server.location || draft.tags != server.tags {
            return Err("组织服务器的名称、地址与跳板机由管理员维护，请刷新目录后重试".into());
        }
        if !matches!(draft.auth_method.as_str(), "sshAgent" | "password" | "privateKey") { return Err("组织服务器仅支持本机 SSH Agent、密码或私钥认证".into()); }
        if draft.auth_method == "privateKey" && draft.identity_file.as_deref().is_none_or(|s| s.trim().is_empty()) { return Err("请选择本机 SSH 私钥".into()); }
        if managed.has_password && (draft.auth_method != "password" || draft.password.as_deref().is_some_and(|s| !s.is_empty()) || draft.save_password || draft.identity_file.as_deref().is_some_and(|s| !s.is_empty())) {
            return Err("此服务器使用管理员密码，请在网页由管理员修改".into());
        }
        if managed.has_jump_password && (!draft.proxy_use_password || draft.proxy_password.as_deref().is_some_and(|s| !s.is_empty()) || draft.save_proxy_password) {
            return Err("此跳板机使用管理员密码，请在网页由管理员修改".into());
        }
        if !managed.has_password && draft.auth_method == "password" && draft.password.as_deref().is_none_or(str::is_empty) && self.get_password(id, false)?.is_none() { return Err("请重新输入此组织服务器的 SSH 密码".into()); }
        Ok(true)
    }

    pub(crate) fn managed_setup(&self, draft: &ServerDraft) -> Result<Option<ManagedServer>, String> {
        // Authentication is not yet configured during setup, but the cloud lease
        // and every centrally managed destination must already be current.
        let Some(id) = draft.id.as_deref() else { return Ok(None); };
        let row: Option<(i64,)> = self.connection.lock().map_err(|e| e.to_string())?.query_row("SELECT authorized_until FROM managed_servers WHERE local_id=?1", [id], |row| Ok((row.get(0)?,))).optional().map_err(|e| e.to_string())?;
        let Some((until,)) = row else { return Ok(None); };
        if until <= now_ms() { return Err("此组织服务器授权已失效，请联网刷新目录".into()); }
        self.validate_managed_draft(draft)?;
        Ok(self.list_servers()?.into_iter().find(|s| s.id == id).and_then(|s| s.managed))
    }

    pub(crate) fn expire_managed(&self) -> Result<Vec<String>, String> {
        let connection = self.connection.lock().map_err(|e| e.to_string())?;
        let ids = connection.prepare("SELECT local_id FROM managed_servers WHERE authorized_until>0 AND authorized_until<=?1").map_err(|e| e.to_string())?
            .query_map([now_ms()], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        connection.execute("UPDATE managed_servers SET authorized_until=0,epoch=epoch+1,reason=?1 WHERE authorized_until>0 AND authorized_until<=?2", params![EXPIRED, now_ms()]).map_err(|e| e.to_string())?;
        self.forget_managed_session_credentials(&ids)?;
        if !ids.is_empty() { self.managed_changes.send_replace(()); }
        Ok(ids)
    }

    pub(crate) fn reject_managed_delete(&self, id: &str) -> Result<(), String> {
        if self.connection.lock().map_err(|e| e.to_string())?.query_row("SELECT 1 FROM managed_servers WHERE local_id=?1", [id], |_| Ok(())).optional().map_err(|e| e.to_string())?.is_some() {
            return Err("组织服务器由管理员维护，不能删除本机历史记录".into());
        }
        Ok(())
    }

    pub(crate) fn check_managed_server(&self, server: &Server) -> Result<(), String> {
        if server.managed.is_none() { return Ok(()); }
        let actual = self.get_server(&server.id)?;
        if actual.host != server.host || actual.port != server.port || actual.username != server.username || actual.proxy_jump != server.proxy_jump
            || actual.auth_method != server.auth_method || actual.identity_file != server.identity_file || actual.proxy_use_password != server.proxy_use_password
            || actual.managed.as_ref().zip(server.managed.as_ref()).is_none_or(|(a,b)| a.account_id != b.account_id || a.company != b.company || a.remote_id != b.remote_id || a.epoch != b.epoch || a.credential_revision != b.credential_revision || a.has_password != b.has_password || a.has_jump_password != b.has_jump_password) {
            return Err("组织服务器配置已变化，请重新打开连接".into());
        }
        Ok(())
    }
}

/// Drop cancellable SSH futures as soon as the lease or destination changes.
/// Every subprocess created by the collector uses kill_on_drop.
pub(crate) async fn authorized<T>(database: &Database, servers: &[&Server], operation: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    if servers.iter().all(|server| server.managed.is_none()) { return operation.await; }
    let epochs = servers.iter().filter(|s| s.managed.is_some()).map(|s| database.managed_epoch(&s.id).and_then(|epoch| epoch.map(|epoch| (s.id.clone(), epoch)).ok_or_else(|| "组织服务器已移除".into()))).collect::<Result<Vec<_>, String>>()?;
    guard(database, epochs, || { for server in servers { database.check_managed_server(server)?; } Ok(()) }, operation).await
}
pub(crate) async fn authorized_setup<T>(database: &Database, draft: &ServerDraft, operation: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    if database.managed_setup(draft)?.is_none() { return operation.await; }
    let id = draft.id.as_deref().ok_or("缺少组织服务器标识")?;
    let epoch = database.managed_epoch(id)?.ok_or("组织服务器已移除")?;
    guard(database, vec![(id.into(), epoch)], || database.managed_setup(draft).map(|_| ()), operation).await
}
async fn guard<T>(database: &Database, epochs: Vec<(String, i64)>, validate: impl Fn() -> Result<(), String>, operation: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    let check = || {
        for (id, expected) in &epochs { if database.managed_epoch(id)? != Some(*expected) { return Err("组织服务器授权已变化，请重新发起操作".into()); } }
        validate()
    };
    let mut changes = database.managed_changes.subscribe();
    let mut expiry = tokio::time::interval(std::time::Duration::from_secs(1));
    tokio::pin!(operation);
    loop {
        check()?;
        tokio::select! {
            biased;
            _ = changes.changed() => (),
            _ = expiry.tick() => (),
            result = &mut operation => { check()?; return result; }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn remote(id: u32, host: &str) -> serde_json::Value { json!({"id":format!("00000000-0000-4000-8000-{id:012}"),"company":"A公司","name":format!("Server {id}"),"host":host,"port":22,"username":"worker","jump":null,"enabled":true,"version":1,"updatedAt":"2026-09-11T12:00:00.000Z"}) }
    fn directory(rows: Vec<serde_json::Value>, scope: &str) -> Directory { Directory::parse(json!({"schemaVersion":1,"revision":"a".repeat(64),"servers":rows}),scope).unwrap() }
    fn database() -> (tempfile::TempDir, Database) { let dir = tempfile::tempdir().unwrap(); let db = Database::open(&dir.path().join("test.sqlite")).unwrap(); (dir,db) }
    fn draft(server: &Server) -> ServerDraft { ServerDraft { id:Some(server.id.clone()),name:server.name.clone(),location:server.location.clone(),host:server.host.clone(),port:server.port,username:server.username.clone(),ssh_alias:None,identity_file:None,proxy_jump:server.proxy_jump.clone(),proxy_use_password:false,tags:server.tags.clone(),sampling_interval_seconds:10,history_retention_days:90,remote_history_enabled:false,auth_method:"sshAgent".into(),password:None,save_password:false,proxy_password:None,save_proxy_password:false } }
    fn configured(db: &Database, row: serde_json::Value) -> Server { db.apply_directory("account-a", &directory(vec![row],"A公司"), now_ms()).unwrap(); let server = db.list_servers().unwrap().pop().unwrap(); db.save_server(draft(&server)).unwrap() }

    fn shared(mut row: serde_json::Value, target: bool, jump: bool, revision: u64) -> Directory {
        row["hasPassword"] = json!(target); row["hasJumpPassword"] = json!(jump); row["credentialRevision"] = json!(revision);
        Directory::parse(json!({"schemaVersion":2,"revision":"b".repeat(64),"servers":[row]}),"A公司").unwrap()
    }

    #[test]
    fn legacy_same_version_cache_receives_shared_password_metadata_after_restart() {
        let (dir,db)=database(); let mut row=remote(1,"node.example"); row["version"]=json!(8);
        row["jump"]=json!({"host":"jump.example","port":22,"username":"hop"});
        db.apply_directory("account-a",&directory(vec![row.clone()],"A公司"),now_ms()).unwrap();
        let id=db.list_servers().unwrap().pop().unwrap().id;
        // A released 2.5 client stores exactly the schema 1 fields even after
        // an administrator has changed shared credentials on the server.
        db.connection.lock().unwrap().execute("UPDATE managed_servers SET definition_json=?2 WHERE local_id=?1",params![id,serde_json::to_string(&row).unwrap()]).unwrap();
        db.connection.lock().unwrap().execute("INSERT INTO snapshots(server_id,timestamp,cpu_utilization,memory_utilization,gpu_json,payload_json) VALUES(?1,1,0,0,'{}','{}')",[&id]).unwrap();
        drop(db); let db=Database::open(&dir.path().join("test.sqlite")).unwrap();
        assert!(db.get_server(&id).is_err());
        db.session_passwords.lock().unwrap().insert(id.clone(),"stale-target-fixture".into());
        db.session_passwords.lock().unwrap().insert(format!("proxy:{id}"),"stale-hop-fixture".into());
        db.apply_directory("account-a",&shared(row,true,true,2),now_ms()).unwrap();
        let server=db.get_server(&id).unwrap(); let managed=server.managed.as_ref().unwrap();
        assert!(managed.available && managed.has_password && managed.has_jump_password);
        assert_eq!(managed.version,8); assert_eq!(managed.credential_revision,2);
        assert_eq!(server.auth_method,"password"); assert!(server.proxy_use_password);
        assert!(db.session_passwords.lock().unwrap().is_empty());
        assert_eq!(db.list_servers().unwrap().len(),1);
        assert_eq!(db.connection.lock().unwrap().query_row("SELECT COUNT(*) FROM snapshots WHERE server_id=?1",[&id],|r|r.get::<_,i64>(0)).unwrap(),1);
    }

    #[tokio::test]
    async fn schema_one_cache_upgrade_cancels_active_local_auth_without_losing_confirmation() {
        let (_dir,db)=database(); let mut row=remote(1,"node.example");
        row["jump"]=json!({"host":"jump.example","port":22,"username":"hop"});
        let server=configured(&db,row.clone()); let epoch=db.managed_epoch(&server.id).unwrap();
        let encoded:String=db.connection.lock().unwrap().query_row("SELECT definition_json FROM managed_servers WHERE local_id=?1",[&server.id],|r|r.get(0)).unwrap();
        let value:serde_json::Value=serde_json::from_str(&encoded).unwrap();
        assert!(CREDENTIAL_FIELDS.iter().all(|key|value.get(key).is_none()));
        db.session_passwords.lock().unwrap().insert(format!("proxy:{}",server.id),"old-hop-fixture".into());
        let servers=[&server];
        let operation=authorized(&db,&servers,std::future::pending::<Result<(),String>>());
        let upgrade=async {
            tokio::task::yield_now().await;
            db.apply_directory("account-a",&shared(row.clone(),false,true,1),now_ms()).unwrap();
        };
        let (result,())=tokio::time::timeout(std::time::Duration::from_secs(1),async{tokio::join!(operation,upgrade)}).await.unwrap();
        assert!(result.is_err()); assert_ne!(db.managed_epoch(&server.id).unwrap(),epoch);
        assert!(db.check_managed_server(&server).is_err());
        let fresh=db.get_server(&server.id).unwrap();
        assert!(fresh.managed.as_ref().unwrap().available); assert_eq!(fresh.auth_method,"sshAgent");
        assert!(fresh.proxy_use_password); assert!(db.session_passwords.lock().unwrap().is_empty());
        db.apply_directory("account-a",&shared(row,false,true,1),now_ms()).unwrap();
        assert!(db.get_server(&server.id).unwrap().managed.unwrap().available);
    }

    #[test]
    fn legacy_metadata_upgrade_rejects_changes_to_known_definition_fields() {
        for (field,value) in [("name",json!("Renamed")),("host",json!("other.example")),("port",json!(2222)),("username",json!("other")),
            ("jump",json!({"host":"jump.example","port":22,"username":"hop"})),("enabled",json!(false)),("updatedAt",json!("2026-09-12T00:00:00.000Z"))] {
            let (_dir,db)=database(); let original=remote(1,"node.example");
            let server=configured(&db,original.clone()); let mut changed=original.clone(); changed[field]=value;
            assert!(db.apply_directory("account-a",&shared(changed,true,false,1),now_ms()).is_err(),"{field}");
            let encoded:String=db.connection.lock().unwrap().query_row("SELECT definition_json FROM managed_servers WHERE local_id=?1",[&server.id],|r|r.get(0)).unwrap();
            assert_eq!(serde_json::from_str::<serde_json::Value>(&encoded).unwrap(),original,"{field}");
        }
    }

    #[test]
    fn same_version_metadata_changes_require_an_entirely_legacy_cache() {
        for field in CREDENTIAL_FIELDS {
            let (_dir,db)=database(); let row=remote(1,"node.example"); let server=configured(&db,row.clone());
            let mut partial=row.clone(); partial[field]=if field=="credentialRevision" {json!(0)} else {json!(false)};
            db.connection.lock().unwrap().execute("UPDATE managed_servers SET definition_json=?2 WHERE local_id=?1",params![server.id,serde_json::to_string(&partial).unwrap()]).unwrap();
            assert!(db.apply_directory("account-a",&shared(row,true,false,1),now_ms()).is_err(),"{field}");
        }
        for (old_target,old_revision,new_target,new_revision) in [(false,0,true,1),(true,1,true,2),(true,1,false,2),(true,2,true,1)] {
            let (_dir,db)=database(); let row=remote(1,"node.example");
            db.apply_directory("account-a",&shared(row.clone(),old_target,false,old_revision),now_ms()).unwrap();
            assert!(db.apply_directory("account-a",&shared(row,new_target,false,new_revision),now_ms()).is_err());
            let current=db.list_servers().unwrap().pop().unwrap().managed.unwrap();
            assert_eq!(current.has_password,old_target); assert_eq!(current.credential_revision,old_revision);
        }
    }

    #[test]
    fn schema_one_cannot_overwrite_schema_two_metadata_even_with_a_newer_version() {
        for (target,revision) in [(false,0),(true,1)] {
            for version in [1,2] {
                let (_dir,db)=database(); let mut row=remote(1,"node.example");
                db.apply_directory("account-a",&shared(row.clone(),target,false,revision),now_ms()).unwrap();
                let server=db.list_servers().unwrap().pop().unwrap();
                let before:String=db.connection.lock().unwrap().query_row("SELECT definition_json FROM managed_servers WHERE local_id=?1",[&server.id],|r|r.get(0)).unwrap();
                row["version"]=json!(version);
                assert!(db.apply_directory("account-a",&directory(vec![remote(2,"second.example"),row],"A公司"),now_ms()).is_err());
                let after:String=db.connection.lock().unwrap().query_row("SELECT definition_json FROM managed_servers WHERE local_id=?1",[&server.id],|r|r.get(0)).unwrap();
                assert_eq!(before,after); assert_eq!(db.list_servers().unwrap().len(),1);
            }
        }
    }

    #[test]
    fn shared_directory_is_explicit_and_cannot_contain_secret_fields() {
        let mut row = remote(1, "node.example");
        assert!(Directory::parse(json!({"schemaVersion":2,"revision":"a".repeat(64),"servers":[row.clone()]}),"A公司").is_err());
        row["hasPassword"]=json!(true); row["hasJumpPassword"]=json!(false); row["credentialRevision"]=json!(1);
        assert!(Directory::parse(json!({"schemaVersion":1,"revision":"a".repeat(64),"servers":[row.clone()]}),"A公司").is_err());
        row["password"]=json!("do-not-persist-fixture");
        assert!(Directory::parse(json!({"schemaVersion":2,"revision":"a".repeat(64),"servers":[row.clone()]}),"A公司").is_err());
        row.as_object_mut().unwrap().remove("password"); row["hasJumpPassword"]=json!(true);
        assert!(Directory::parse(json!({"schemaVersion":2,"revision":"a".repeat(64),"servers":[row]}),"A公司").is_err());
    }

    #[test]
    fn shared_password_is_ready_without_local_auth_and_cannot_be_overridden_or_cached() {
        let (_dir,db)=database(); let mut row=remote(1,"node.example");
        row["jump"]=json!({"host":"jump.example","port":22,"username":"hop"});
        db.apply_directory("account-a",&shared(row,true,true,1),now_ms()).unwrap();
        let server=db.list_servers().unwrap().pop().unwrap();
        assert!(server.managed.as_ref().unwrap().available); assert_eq!(server.auth_method,"password"); assert!(server.proxy_use_password);
        assert!(db.get_ssh_passwords(&server,false).is_err());
        db.session_passwords.lock().unwrap().insert(server.id.clone(),"stale-local-target".into());
        db.session_passwords.lock().unwrap().insert(format!("proxy:{}",server.id),"stale-local-hop".into());
        let local=db.local_ssh_passwords(&server,false).unwrap().unwrap(); assert!(local.target.is_none() && local.proxy.is_none());
        let mut settings=draft(&server); settings.auth_method="password".into(); settings.proxy_use_password=true;
        db.save_server(settings.clone()).unwrap();
        assert_eq!(db.connection.lock().unwrap().query_row("SELECT auth_method FROM servers WHERE id=?1",[&server.id],|r|r.get::<_,String>(0)).unwrap(),"sshAgent");
        settings.password=Some("member-override".into()); assert!(db.save_server(settings.clone()).is_err());
        settings.password=None; settings.proxy_password=Some("member-hop-override".into()); assert!(db.save_server(settings).is_err());
    }

    #[tokio::test]
    async fn shared_password_rotation_cancels_old_operations_and_clear_requires_local_reconfirmation() {
        let (_dir,db)=database(); let mut row=remote(1,"node.example");
        db.apply_directory("account-a",&shared(row.clone(),true,false,1),now_ms()).unwrap();
        let server=db.list_servers().unwrap().pop().unwrap();
        let old_epoch=db.managed_epoch(&server.id).unwrap();
        let rotate=async {
            tokio::task::yield_now().await;
            row["version"]=json!(2);
            db.apply_directory("account-a",&shared(row.clone(),true,false,2),now_ms()).unwrap();
        };
        let servers=[&server];
        let operation=authorized(&db,&servers,std::future::pending::<Result<(),String>>());
        let (result,())=tokio::time::timeout(std::time::Duration::from_secs(1),async{tokio::join!(operation,rotate)}).await.unwrap();
        assert!(result.is_err()); assert_ne!(db.managed_epoch(&server.id).unwrap(),old_epoch);
        assert!(db.check_managed_server(&server).is_err());
        let fresh=db.get_server(&server.id).unwrap(); assert!(fresh.managed.as_ref().unwrap().available);
        row["version"]=json!(3);
        db.apply_directory("account-a",&shared(row,false,false,3),now_ms()).unwrap();
        assert!(db.get_server(&server.id).is_err());
        let local=db.list_servers().unwrap().pop().unwrap(); assert_eq!(local.auth_method,"sshAgent");
        assert!(db.save_server(draft(&local)).unwrap().managed.unwrap().available);
    }

    #[test]
    fn jump_only_shared_password_preserves_confirmed_local_target_authentication() {
        let (_dir,db)=database(); let mut row=remote(1,"node.example");
        row["jump"]=json!({"host":"jump.example","port":22,"username":"hop"});
        db.apply_directory("account-a",&shared(row.clone(),false,true,1),now_ms()).unwrap();
        let server=db.list_servers().unwrap().pop().unwrap(); assert!(!server.managed.as_ref().unwrap().available);
        let mut local=draft(&server);local.proxy_use_password=true;
        let server=db.save_server(local).unwrap(); assert!(server.managed.as_ref().unwrap().available);
        row["version"]=json!(2);
        db.apply_directory("account-a",&shared(row,false,true,2),now_ms()).unwrap();
        assert!(db.get_server(&server.id).unwrap().managed.unwrap().available);
    }

    #[test]
    fn directory_rejects_unsafe_fields_and_wrong_scope_before_writing() {
        let good = remote(1,"node.example");
        for (field,value) in [("host",json!("-oProxyCommand=evil")),("username",json!("user;id")),("company",json!("B公司")),("port",json!(0)),("sshAlias",json!("evil")),("identityFile",json!("/tmp/key"))] {
            let mut row=good.clone();row[field]=value;
            assert!(Directory::parse(json!({"schemaVersion":1,"revision":"a".repeat(64),"servers":[row]}),"A公司").is_err(),"{field}");
        }
        assert!(Directory::parse(json!({"schemaVersion":1,"revision":"a".repeat(64),"servers":[good.clone(),good]}),"A公司").is_err());
        let mut ipv6=remote(2,"2001:db8::1");ipv6["jump"]=json!({"host":"2001:db8::2","port":2222,"username":"hop"});
        assert_eq!(directory(vec![ipv6],"A公司").servers[0].proxy().as_deref(),Some("hop@[2001:db8::2]:2222"));
    }

    #[test]
    fn mapping_never_merges_personal_connection_and_requires_local_authentication() {
        let (_dir,db)=database();
        let personal: ServerDraft=serde_json::from_value(json!({"name":"Personal","host":"node.example","port":22,"username":"worker","samplingIntervalSeconds":10,"historyRetentionDays":90,"authMethod":"sshAgent"})).unwrap();
        let personal=db.save_server(personal).unwrap();
        let snapshot=directory(vec![remote(1,"node.example")],"A公司");
        db.apply_directory("account-a",&snapshot,now_ms()).unwrap();
        let servers=db.list_servers().unwrap();assert_eq!(servers.len(),2);
        let managed=servers.iter().find(|s|s.managed.is_some()).unwrap();assert_ne!(managed.id,personal.id);
        assert!(db.get_server(&managed.id).unwrap_err().contains("认证"));
        let managed=db.save_server(draft(managed)).unwrap();assert!(managed.managed.as_ref().unwrap().available);
        db.apply_directory("account-a",&snapshot,now_ms()).unwrap();
        assert_eq!(db.list_servers().unwrap().iter().filter(|s|s.managed.is_some()).map(|s|s.id.clone()).collect::<Vec<_>>(),vec![managed.id.clone()]);
        assert!(db.get_server(&personal.id).is_ok());assert!(db.reject_managed_delete(&managed.id).is_err());
        assert!(db.delete_server(&managed.id).is_err());
    }

    #[test]
    fn target_change_clears_old_passwords_and_identity_without_losing_history() {
        let (_dir,db)=database();let mut row=remote(1,"node.example");
        let server=configured(&db,row.clone());
        let mut local=draft(&server);local.auth_method="password".into();local.password=Some("fixture-target-secret".into());
        let server=db.save_server(local).unwrap();
        db.session_passwords.lock().unwrap().insert(format!("proxy:{}",server.id),"fixture-hop-secret".into());
        db.connection.lock().unwrap().execute("UPDATE servers SET credential_storage_state='enabled',identity_file='/tmp/local-key' WHERE id=?1",[&server.id]).unwrap();
        db.connection.lock().unwrap().execute("INSERT INTO snapshots(server_id,timestamp,cpu_utilization,memory_utilization,gpu_json,payload_json) VALUES(?1,1,0,0,'{}','{}')",[&server.id]).unwrap();
        row["host"]=json!("replacement.example");row["version"]=json!(2);row["updatedAt"]=json!("2026-09-11T12:00:01.000Z");
        let affected=db.apply_directory("account-a",&directory(vec![row],"A公司"),now_ms()).unwrap();assert_eq!(affected,vec![server.id.clone()]);
        assert!(db.get_password(&server.id,false).unwrap().is_none());
        assert!(!db.session_passwords.lock().unwrap().contains_key(&format!("proxy:{}",server.id)));
        assert!(db.get_ssh_passwords(&server,false).is_err());
        let changed=db.list_servers().unwrap().pop().unwrap();assert_eq!(changed.host,"replacement.example");assert_eq!(changed.identity_file,None);assert!(!changed.managed.as_ref().unwrap().available);
        assert_eq!(db.connection.lock().unwrap().query_row("SELECT COUNT(*) FROM snapshots WHERE server_id=?1",[&server.id],|r|r.get::<_,i64>(0)).unwrap(),1);
        let mut empty=draft(&changed);empty.auth_method="password".into();assert!(db.save_server(empty).is_err());
    }

    #[test]
    fn account_and_company_changes_preserve_distinct_ids_and_remove_old_access() {
        let (_dir,db)=database();let a=configured(&db,remote(1,"node.example"));
        let mut b=remote(1,"node.example");b["company"]=json!("B公司");
        db.apply_directory("account-a",&directory(vec![b],"B公司"),now_ms()).unwrap();
        assert!(db.get_server(&a.id).is_err());
        db.apply_directory("account-b",&directory(vec![remote(1,"node.example")],"A公司"),now_ms()).unwrap();
        let servers=db.list_servers().unwrap();assert_eq!(servers.len(),3);
        let ids:HashSet<_>=servers.iter().map(|s|&s.id).collect();assert_eq!(ids.len(),3);
        assert!(servers.iter().filter(|s|s.managed.as_ref().unwrap().account_id=="account-a").all(|s|!s.managed.as_ref().unwrap().available));
        db.apply_directory("account-a",&directory(vec![remote(1,"node.example")],"A公司"),now_ms()).unwrap();assert!(db.get_server(&a.id).is_ok());
    }

    #[test]
    fn empty_snapshot_revocation_expiry_and_restart_keep_records_but_deny_connections() {
        let (dir,db)=database();let server=configured(&db,remote(1,"node.example"));
        db.apply_directory("account-a",&directory(vec![],"A公司"),now_ms()).unwrap();assert!(db.get_server(&server.id).is_err());assert_eq!(db.list_servers().unwrap().len(),1);
        db.apply_directory("account-a",&directory(vec![remote(1,"node.example")],"A公司"),now_ms()-LEASE_MS-1).unwrap();assert!(db.get_server(&server.id).is_err());
        assert_eq!(db.expire_managed().unwrap(),vec![server.id.clone()]);
        db.apply_directory("account-a",&directory(vec![remote(1,"node.example")],"A公司"),now_ms()).unwrap();assert!(db.get_server(&server.id).is_ok());
        drop(db);let db=Database::open(&dir.path().join("test.sqlite")).unwrap();assert!(db.get_server(&server.id).is_err());assert_eq!(db.list_servers().unwrap().len(),1);
    }

    #[test]
    fn local_draft_cannot_override_central_destination_or_enable_ssh_config() {
        let (_dir,db)=database();let server=configured(&db,remote(1,"node.example"));
        let mut edited=draft(&server);edited.host="other.example".into();assert!(db.save_server(edited).is_err());
        let mut edited=draft(&server);edited.ssh_alias=Some("alias".into());assert!(db.save_server(edited).is_err());
        let mut edited=draft(&server);edited.auth_method="sshConfig".into();assert!(db.save_server(edited).is_err());
        let mut edited=draft(&server);edited.sampling_interval_seconds=30;assert_eq!(db.save_server(edited).unwrap().sampling_interval_seconds,30);
        assert!(db.managed_setup(&draft(&server)).is_ok());db.invalidate_managed("fixture revoked").unwrap();assert!(db.managed_setup(&draft(&server)).is_err());
    }

    #[test]
    fn stale_or_conflicting_snapshot_rolls_back_whole_transaction() {
        let (_dir,db)=database();let mut first=remote(1,"node.example");first["version"]=json!(2);let _server=configured(&db,first.clone());
        let mut changed=first;changed["host"]=json!("other.example");
        for invalid in [remote(1,"node.example"),changed] {
            assert!(db.apply_directory("account-a",&directory(vec![remote(2,"second.example"),invalid],"A公司"),now_ms()).is_err());
            assert_eq!(db.list_servers().unwrap().len(),1);assert_eq!(db.list_servers().unwrap()[0].host,"node.example");
        }
    }

    #[tokio::test]
    async fn pending_network_operation_is_dropped_on_revocation_without_waiting_for_reply() {
        let (_dir,db)=database();let server=configured(&db,remote(1,"node.example"));
        let servers=[&server];
        let operation=authorized(&db,&servers,async { std::future::pending::<()>().await; Ok::<_,String>(()) });
        let revoke=async { tokio::task::yield_now().await; db.invalidate_managed("revoked").unwrap(); };
        let (result,())=tokio::time::timeout(std::time::Duration::from_secs(1),async { tokio::join!(operation,revoke) }).await.unwrap();assert!(result.is_err());
    }

    #[tokio::test]
    async fn quick_regrant_cannot_restore_an_operation_from_the_previous_authorization_epoch() {
        let (_dir,db)=database();let row=remote(1,"node.example");let server=configured(&db,row.clone());
        let servers=[&server];
        let operation=authorized(&db,&servers,async { std::future::pending::<()>().await; Ok::<_,String>(()) });
        let regrant=async {
            tokio::task::yield_now().await;
            db.invalidate_managed("revoked").unwrap();
            db.apply_directory("account-a",&directory(vec![row],"A公司"),now_ms()).unwrap();
            assert!(db.get_server(&server.id).is_ok());
        };
        let (result,())=tokio::time::timeout(std::time::Duration::from_secs(1),async { tokio::join!(operation,regrant) }).await.unwrap();
        assert!(result.unwrap_err().contains("授权已变化"));
    }

    #[test]
    fn revocation_does_not_wait_for_a_blocked_credential_dialog_and_late_secret_is_discarded() {
        let (_dir,db)=database();let server=configured(&db,remote(1,"node.example"));
        let (started_tx,started_rx)=std::sync::mpsc::channel();let (finish_tx,finish_rx)=std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let db_ref=&db;let server_ref=&server;
            let pending=scope.spawn(move || db_ref.with_managed_credentials(server_ref, || {
                started_tx.send(()).unwrap();finish_rx.recv().unwrap();
                db_ref.session_passwords.lock().unwrap().insert(server_ref.id.clone(),"late-fixture-secret".into());
                Ok("late-fixture-secret")
            }));
            started_rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
            let (revoked_tx,revoked_rx)=std::sync::mpsc::channel();
            scope.spawn(move || { revoked_tx.send(db_ref.invalidate_managed("revoked during keyring prompt")).unwrap(); });
            let revoked=revoked_rx.recv_timeout(std::time::Duration::from_secs(1));
            // Always release the fixture dialog, including assertion failures.
            finish_tx.send(()).unwrap();
            assert_eq!(revoked.unwrap().unwrap(),vec![server.id.clone()]);
            assert!(pending.join().unwrap().is_err());
        });
        assert!(!db.session_passwords.lock().unwrap().contains_key(&server.id));
        assert!(db.get_server(&server.id).is_err());
    }

    #[test]
    fn changed_target_is_quarantined_while_the_credential_gate_is_busy() {
        let (_dir,db)=database();let server=configured(&db,remote(1,"node.example"));
        let gate=db.managed_gate.lock().unwrap();
        let mut row=remote(1,"changed.example");row["version"]=json!(2);
        let ids=db.quarantine_directory("account-a",&directory(vec![row],"A公司")).unwrap();
        assert_eq!(ids,vec![server.id.clone()]);assert!(db.get_server(&server.id).is_err());
        drop(gate);
    }

    #[test]
    fn managed_ssh_bypasses_local_config_and_keeps_explicit_jump() {
        let (_dir,db)=database();let mut row=remote(1,"node.example");row["jump"]=json!({"host":"hop.example","port":2200,"username":"hop"});let server=configured(&db,row);
        let options=crate::ssh_connection::options(&server,None,None).unwrap();
        assert_eq!(&options.args[0..2],&["-F",if cfg!(windows){"NUL"}else{"/dev/null"}]);assert!(options.args.windows(2).any(|args|args==["-J","hop@hop.example:2200"]));
    }
}

/// A local fixture harness, excluded from distributed application builds.
#[cfg(feature = "integration-probe")]
pub async fn exercise_directory_fixture(endpoint: &str) -> Result<serde_json::Value, String> {
    let url = reqwest::Url::parse(endpoint).map_err(|e| e.to_string())?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") { return Err("directory fixture requires a loopback endpoint".into()); }
    let response = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(5)).build().map_err(|e| e.to_string())?
        .get(url).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
    let directory = Directory::parse(response.json().await.map_err(|e| e.to_string())?, "*")?;
    if directory.servers.is_empty() || directory.servers.iter().any(|s| !s.enabled) { return Err("fixture needs enabled directory entries".into()); }
    let local = tempfile::tempdir().map_err(|e| e.to_string())?;
    let database = Database::open(&local.path().join("fixture.sqlite"))?;
    let first = &directory.servers[0];
    let personal: ServerDraft = serde_json::from_value(serde_json::json!({"name":"Personal fixture","host":first.host,"port":first.port,"username":first.username,"samplingIntervalSeconds":10,"historyRetentionDays":90,"authMethod":"sshAgent"})).map_err(|e| e.to_string())?;
    let personal = database.save_server(personal)?;
    database.apply_directory("fixture-account", &directory, now_ms())?;
    let mut managed = Vec::new();
    for server in database.list_servers()?.into_iter().filter(|s| s.managed.is_some()) {
        if database.get_server(&server.id).is_ok() { return Err("unconfigured managed fixture was connectable".into()); }
        let draft: ServerDraft = serde_json::from_value(serde_json::to_value(&server).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        managed.push(database.save_server(draft)?);
    }
    if managed.len() != directory.servers.len() || managed.iter().any(|s| s.id == personal.id) { return Err("directory fixture overwrote a personal connection".into()); }
    // A real cancellable subprocess stands in for SSH; it never connects to
    // the exported fixture addresses or reads a real credential store.
    let mut child = tokio::process::Command::new("sleep").arg("30").kill_on_drop(true).spawn().map_err(|e| e.to_string())?;
    let pid = child.id().ok_or("fixture process has no id")?;
    let servers = [&managed[0]];
    let operation = authorized(&database, &servers, async move { child.wait().await.map_err(|e| e.to_string())?; Ok(()) });
    let revoke = async { tokio::time::sleep(std::time::Duration::from_millis(30)).await; database.invalidate_managed("fixture revoked") };
    let (cancelled, revoked) = tokio::time::timeout(std::time::Duration::from_secs(2), async { tokio::join!(operation, revoke) }).await.map_err(|_| "revocation did not cancel the pending operation")?;
    if cancelled.is_ok() || revoked?.len() != managed.len() { return Err("fixture revocation failed".into()); }
    let mut stopped = false;
    for _ in 0..20 {
        if !tokio::process::Command::new("kill").args(["-0", &pid.to_string()]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().await.map_err(|e| e.to_string())?.success() { stopped = true; break; }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    if !stopped { return Err("revoked fixture subprocess was not stopped".into()); }
    if managed.iter().any(|s| database.get_server(&s.id).is_ok()) || database.get_server(&personal.id).is_err() { return Err("fixture authorization isolation failed".into()); }
    let ids: HashSet<_> = managed.iter().map(|s| s.id.clone()).collect();
    database.apply_directory("fixture-account", &directory, now_ms())?;
    if !database.list_servers()?.iter().filter(|s| s.managed.is_some()).all(|s| ids.contains(&s.id)) { return Err("directory mapping changed after refresh".into()); }
    drop(database);
    let database = Database::open(&local.path().join("fixture.sqlite"))?;
    if database.list_servers()?.len() != managed.len() + 1 || managed.iter().any(|s| database.get_server(&s.id).is_ok()) { return Err("directory restart lease isolation failed".into()); }
    Ok(serde_json::json!({"managedConnections":managed.len(),"personalPreserved":true,"localAuthenticationRequired":true,"revocationStoppedSubprocess":true,"stableLocalIds":true,"restartRequiresAuthorization":true}))
}
