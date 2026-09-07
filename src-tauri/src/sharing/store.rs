use super::identity::{DeviceIdentity, OwnerIdentity};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

pub const DEFAULT_RELAY: &str = "https://136.0.110.161";
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub monitor: bool,
    pub terminal: bool,
    pub files: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: String,
    pub device_name: String,
    pub public_key: String,
    pub route_id: String,
    pub route_token: String,
    pub paired_at: u64,
    pub last_seen_at: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInvitation {
    pub route_id: String,
    pub route_token: String,
    pub secret_hash: String,
    pub expires_at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedShare {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub expires_at: u64,
    pub default_path: String,
    pub capabilities: Capabilities,
    pub paused: bool,
    pub members: Vec<Member>,
    pub invitations: Vec<PendingInvitation>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivedShare {
    pub id: String,
    pub name: String,
    pub owner_label: String,
    pub expires_at: u64,
    pub default_path: String,
    pub capabilities: Capabilities,
    pub relay_url: String,
    pub route_id: String,
    pub route_token: String,
    pub owner_cert_der: String,
    pub member_id: String,
    pub device_name: String,
}

// All records, route capabilities and private keys live in one OS keyring item.
// Public views below are explicitly projected; never serialize Persisted to a WebView.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Persisted {
    pub version: u32,
    pub relay_url: String,
    pub owner_token: Option<String>,
    pub owner_identity: Option<OwnerIdentity>,
    pub device_identity: Option<DeviceIdentity>,
    pub shares: Vec<OwnedShare>,
    pub received: Vec<ReceivedShare>,
}

impl Default for Persisted {
    fn default() -> Self {
        Self {
            version: 1,
            relay_url: DEFAULT_RELAY.into(),
            owner_token: None,
            owner_identity: None,
            device_identity: None,
            shares: vec![],
            received: vec![],
        }
    }
}

enum Persistence {
    Keyring(keyring::Entry),
    #[cfg(any(test, feature = "integration-probe"))]
    Memory,
}
pub struct ShareStore {
    persistence: Persistence,
    value: Mutex<Option<Persisted>>,
}

impl ShareStore {
    pub fn new(profile: &Path) -> Result<Self, String> {
        let profile_key = format!(
            "profile-{:x}",
            Sha256::digest(profile.to_string_lossy().as_bytes())
        );
        let entry = keyring::Entry::new("com.racktop.sharing.v1", &profile_key)
            .map_err(|_| "无法访问系统钥匙串，请先解锁系统凭据存储".to_string())?;
        Ok(Self {
            persistence: Persistence::Keyring(entry),
            value: Mutex::new(None),
        })
    }
    #[cfg(any(test, feature = "integration-probe"))]
    pub fn memory(value: Persisted) -> Self {
        Self {
            persistence: Persistence::Memory,
            value: Mutex::new(Some(value)),
        }
    }

    fn load(&self, guard: &mut Option<Persisted>) -> Result<(), String> {
        if guard.is_some() {
            return Ok(());
        }
        match &self.persistence {
            Persistence::Keyring(entry) => match entry.get_password() {
                Ok(text) => {
                    if text.len() > 512 * 1024 {
                        return Err("共享凭据存储超出大小限制".into());
                    }
                    let value: Persisted = serde_json::from_str(&text)
                        .map_err(|_| "共享凭据无法解析，已保留原记录".to_string())?;
                    if value.version != 1 {
                        return Err("此版本无法读取共享凭据，请更新 RackTop".into());
                    }
                    *guard = Some(value);
                }
                Err(keyring::Error::NoEntry) => *guard = Some(Persisted::default()),
                Err(_) => return Err("系统钥匙串尚未解锁或不可用；请解锁后重试".into()),
            },
            #[cfg(any(test, feature = "integration-probe"))]
            Persistence::Memory => *guard = Some(Persisted::default()),
        }
        Ok(())
    }
    pub fn snapshot(&self) -> Result<Persisted, String> {
        let mut guard = self.value.lock().map_err(|_| "共享凭据暂不可用")?;
        self.load(&mut guard)?;
        Ok(guard.as_ref().unwrap().clone())
    }
    pub fn update<T>(
        &self,
        mutation: impl FnOnce(&mut Persisted) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self.value.lock().map_err(|_| "共享凭据暂不可用")?;
        self.load(&mut guard)?;
        let mut next = guard.as_ref().unwrap().clone();
        let result = mutation(&mut next)?;
        let encoded = serde_json::to_string(&next).map_err(|_| "无法保存共享凭据")?;
        if encoded.len() > 512 * 1024 {
            return Err("共享凭据存储已满，请移除不再使用的共享".into());
        }
        match &self.persistence {
            Persistence::Keyring(entry) => entry
                .set_password(&encoded)
                .map_err(|_| "无法保存到系统钥匙串；修改未应用，请解锁后重试")?,
            #[cfg(any(test, feature = "integration-probe"))]
            Persistence::Memory => {}
        }
        *guard = Some(next);
        Ok(result)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberView {
    pub id: String,
    pub device_name: String,
    pub paired_at: u64,
    pub last_seen_at: Option<u64>,
    pub connected: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedShareView {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub expires_at: u64,
    pub default_path: String,
    pub capabilities: Capabilities,
    pub paused: bool,
    pub members: Vec<MemberView>,
}
impl OwnedShare {
    pub fn view(&self, connected: impl Fn(&str) -> bool) -> OwnedShareView {
        OwnedShareView {
            id: self.id.clone(),
            server_id: self.server_id.clone(),
            name: self.name.clone(),
            expires_at: self.expires_at,
            default_path: self.default_path.clone(),
            capabilities: self.capabilities,
            paused: self.paused,
            members: self
                .members
                .iter()
                .map(|m| MemberView {
                    id: m.id.clone(),
                    device_name: m.device_name.clone(),
                    paired_at: m.paired_at,
                    last_seen_at: m.last_seen_at,
                    connected: connected(&m.id),
                })
                .collect(),
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivedShareView {
    pub id: String,
    pub name: String,
    pub owner_label: String,
    pub expires_at: u64,
    pub capabilities: Capabilities,
    pub state: String,
    pub last_error: Option<String>,
    pub default_path: String,
}
impl ReceivedShare {
    pub fn view(&self, state: &str, last_error: Option<String>) -> ReceivedShareView {
        ReceivedShareView {
            id: self.id.clone(),
            name: self.name.clone(),
            owner_label: self.owner_label.clone(),
            expires_at: self.expires_at,
            capabilities: self.capabilities,
            state: state.into(),
            last_error,
            default_path: self.default_path.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_mutation_does_not_change_saved_state() {
        let store = ShareStore::memory(Persisted::default());
        let result: Result<(), String> = store.update(|s| {
            s.owner_token = Some("secret".into());
            Err("fail".into())
        });
        assert!(result.is_err());
        assert!(store.snapshot().unwrap().owner_token.is_none());
    }
    #[test]
    fn public_projection_omits_route_tokens_and_keys() {
        let member = Member {
            id: "m".into(),
            device_name: "Guest".into(),
            public_key: "PRIVATE_MARKER_PUBLIC_KEY".into(),
            route_id: "PRIVATE_MARKER_ROUTE".into(),
            route_token: "PRIVATE_MARKER_TOKEN".into(),
            paired_at: 1,
            last_seen_at: None,
        };
        let share = OwnedShare {
            id: "s".into(),
            server_id: "server".into(),
            name: "Resource".into(),
            expires_at: 9,
            default_path: ".".into(),
            capabilities: Capabilities::default(),
            paused: false,
            members: vec![member],
            invitations: vec![],
        };
        assert!(
            !serde_json::to_string(&share.view(|_| false))
                .unwrap()
                .contains("PRIVATE_MARKER")
        );
    }
}
