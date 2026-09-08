use super::{
    auth,
    client::{ClientSession, ConnectOptions},
    gateway, identity,
    store::*,
    transfers::TransferManager,
    transport::RelayClient,
};
use crate::{
    collector,
    models::{Server, Snapshot},
    ssh_connection::SshPasswords,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::watch;

pub type ServerContext = Arc<dyn Fn(&str) -> Result<(Server, SshPasswords), String> + Send + Sync>;
pub type EventSink = Arc<dyn Fn(&str, Value) + Send + Sync>;
pub(super) struct OwnerConnection {
    pub generation: String,
    pub share_id: String,
    pub stop: watch::Sender<bool>,
}
struct GuestConnection {
    generation: String,
    state: String,
    last_error: Option<String>,
    session: Option<Arc<ClientSession>>,
    stop: watch::Sender<bool>,
}
type SnapshotCell = Arc<tokio::sync::Mutex<Option<(Instant, Snapshot)>>>;

pub struct SharingRuntime {
    pub store: ShareStore,
    pub(super) context: ServerContext,
    events: EventSink,
    pub(super) peers: Mutex<HashMap<String, OwnerConnection>>,
    guests: Mutex<HashMap<String, GuestConnection>>,
    snapshots: Mutex<HashMap<String, SnapshotCell>>,
    owner_online: AtomicBool,
    started: AtomicBool,
    shutdown: AtomicBool,
    routes_changed: AtomicBool,
    transfers: TransferManager,
}

impl SharingRuntime {
    pub fn new(store: ShareStore, context: ServerContext, events: EventSink) -> Arc<Self> {
        Arc::new(Self {
            store,
            context,
            transfers: TransferManager::new(events.clone()),
            events,
            peers: Mutex::new(HashMap::new()),
            guests: Mutex::new(HashMap::new()),
            snapshots: Mutex::new(HashMap::new()),
            owner_online: AtomicBool::new(false),
            started: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
            routes_changed: AtomicBool::new(true),
        })
    }
    pub fn is_shutdown(&self) -> bool {
        self.shutdown.load(Ordering::Acquire)
    }
    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::Release);
        if let Ok(peers) = self.peers.lock() {
            for p in peers.values() {
                let _ = p.stop.send(true);
            }
        }
        if let Ok(guests) = self.guests.lock() {
            for (id, g) in guests.iter() {
                let _ = g.stop.send(true);
                if let Some(s) = &g.session {
                    s.close();
                }
                self.transfers.cancel_resource(id);
            }
        }
    }
    pub fn has_active_shares(&self) -> bool {
        self.store.snapshot().is_ok_and(|s| {
            s.shares
                .iter()
                .any(|s| !s.paused && s.expires_at > now_ms())
        })
    }
    pub fn start(self: &Arc<Self>) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            runtime.poll_owner().await;
        });
    }
    async fn poll_owner(self: Arc<Self>) {
        let mut registered = HashMap::<String, (Instant, u64)>::new();
        let mut jobs = tokio::task::JoinSet::new();
        while !self.is_shutdown() {
            while jobs.try_join_next().is_some() {}
            let result = async {
                let data = self.store.snapshot()?;
                let Some(token) = data.owner_token.as_deref() else {
                    return Err("共享网关未配置".to_string());
                };
                let relay = RelayClient::new(&data.relay_url)?;
                // Keep polling even when many routes need restoring after a relay
                // restart. A bounded refresh avoids the public HTTP rate limit.
                let changed = self.routes_changed.swap(false, Ordering::AcqRel);
                let mut desired = Vec::new();
                for share in &data.shares {
                    if share.paused || share.expires_at <= now_ms() {
                        continue;
                    }
                    for member in &share.members {
                        desired.push((&member.route_id, &member.route_token, share.expires_at));
                    }
                    for invitation in &share.invitations {
                        if invitation.expires_at > now_ms() {
                            desired.push((
                                &invitation.route_id,
                                &invitation.route_token,
                                invitation.expires_at,
                            ));
                        }
                    }
                }
                let active: HashSet<_> = desired.iter().map(|(id, _, _)| (*id).clone()).collect();
                let obsolete: Vec<_> = registered
                    .keys()
                    .filter(|id| !active.contains(*id))
                    .cloned()
                    .collect();
                for route in obsolete.into_iter().take(3) {
                    relay.delete_route(token, &route).await?;
                    registered.remove(&route);
                }
                desired.sort_by_key(|(id, _, _)| registered.get(*id).map(|(last, _)| *last));
                for (id, route_token, expiry) in desired
                    .into_iter()
                    .filter(|(id, _, expiry)| {
                        changed
                            || registered.get(*id).is_none_or(|(last, saved)| {
                                last.elapsed() >= Duration::from_secs(30) || saved != expiry
                            })
                    })
                    .take(3)
                    .collect::<Vec<_>>()
                {
                    relay.register_route(token, id, route_token, expiry).await?;
                    registered.insert(id.clone(), (Instant::now(), expiry));
                }
                let tickets = relay.pending(token).await?;
                for ticket in tickets {
                    if jobs.len() >= 32 {
                        break;
                    }
                    let runtime = self.clone();
                    let relay = relay.clone();
                    jobs.spawn(async move {
                        let _ = gateway::serve(runtime, relay, ticket).await;
                    });
                }
                Ok::<(), String>(())
            }
            .await;
            self.owner_online.store(result.is_ok(), Ordering::Release);
            if result.is_err() {
                self.routes_changed.store(true, Ordering::Release);
            }
            tokio::time::sleep(Duration::from_secs(if result.is_ok() { 1 } else { 3 })).await;
        }
        jobs.abort_all();
        while jobs.join_next().await.is_some() {}
        self.owner_online.store(false, Ordering::Release);
    }

    pub async fn status(&self) -> Result<Value, String> {
        let data = self.store.snapshot()?;
        let peers = self.peers.lock().map_err(|_| "共享状态不可用")?;
        let guests = self.guests.lock().map_err(|_| "共享状态不可用")?;
        let shares: Vec<_> = data
            .shares
            .iter()
            .map(|s| s.view(|id| peers.contains_key(id)))
            .collect();
        let received: Vec<_> = data
            .received
            .iter()
            .map(|s| {
                let connection = guests.get(&s.id);
                s.view(
                    connection.map_or("offline", |c| c.state.as_str()),
                    connection.and_then(|c| c.last_error.clone()),
                )
            })
            .collect();
        Ok(
            json!({"relayUrl":data.relay_url,"configured":data.owner_token.is_some(),
            "ownerOnline":self.owner_online.load(Ordering::Acquire),"shares":shares,"received":received}),
        )
    }
    pub async fn configure(
        self: &Arc<Self>,
        relay_url: String,
        owner_token: String,
    ) -> Result<(), String> {
        let owner_token = owner_token.trim();
        if !(32..=128).contains(&owner_token.len())
            || !owner_token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("网关密钥格式无效".into());
        }
        let relay = RelayClient::new(relay_url.trim())?;
        relay.verify_owner(owner_token).await?;
        self.store.update(|s| {
            if s.owner_identity.is_none() {
                s.owner_identity = Some(identity::generate_owner_identity()?);
            }
            s.relay_url = relay_url.trim().into();
            s.owner_token = Some(owner_token.into());
            Ok(())
        })?;
        self.routes_changed.store(true, Ordering::Release);
        self.start();
        Ok(())
    }
    pub async fn create(
        &self,
        server_id: String,
        name: String,
        expires_in_hours: u64,
        capabilities: Capabilities,
        default_path: String,
    ) -> Result<Value, String> {
        if !(1..=168).contains(&expires_in_hours) {
            return Err("共享有效期应为 1–168 小时".into());
        }
        if !capabilities.monitor && !capabilities.terminal && !capabilities.files {
            return Err("请至少开放一项能力".into());
        }
        let name = auth::label(&name, 80)?;
        crate::terminal::quote_remote_path(&default_path)?;
        let (server, passwords) = (self.context)(&server_id)?;
        // Preflight uses RackTop's existing strict host-key and credential path.
        collector::collect_with_password(&server, Some(&passwords), false, false).await?;
        let share = OwnedShare {
            id: uuid::Uuid::new_v4().to_string(),
            server_id,
            name,
            expires_at: now_ms() + expires_in_hours * 3_600_000,
            default_path,
            capabilities,
            paused: false,
            members: vec![],
            invitations: vec![],
        };
        self.store.update(|s| {
            if s.owner_token.is_none() {
                return Err("请先配置共享网关".into());
            }
            if s.shares.len() >= 8 {
                return Err("最多创建 8 个共享，请先移除过期共享".into());
            }
            s.shares.push(share.clone());
            Ok(())
        })?;
        Ok(json!(share.view(|_| false)))
    }
    pub async fn invite(&self, share_id: String, expires_in_minutes: u64) -> Result<Value, String> {
        if !(1..=30).contains(&expires_in_minutes) {
            return Err("邀请码有效期应为 1–30 分钟".into());
        }
        let secret = identity::random_token();
        let route_id = identity::random_route_id();
        let route_token = identity::random_token();
        let data = self.store.snapshot()?;
        let token = data.owner_token.as_deref().ok_or("请先配置共享网关")?;
        let identity = data.owner_identity.as_ref().ok_or("请先配置共享网关")?;
        let share = data
            .shares
            .iter()
            .find(|s| s.id == share_id)
            .ok_or("共享不存在")?;
        if share.paused || share.expires_at <= now_ms() {
            return Err("共享已暂停或过期".into());
        }
        let expires_at = share.expires_at.min(now_ms() + expires_in_minutes * 60_000);
        let code = identity::encode_invitation(&identity::Invitation {
            relay_url: data.relay_url.clone(),
            route_id: route_id.clone(),
            route_token: route_token.clone(),
            owner_cert_der: identity.cert_der.clone(),
            invite_secret: secret.clone(),
            resource_name: share.name.clone(),
        })?;
        self.store.update(|s| {
            for share in &mut s.shares {
                share.invitations.retain(|i| i.expires_at > now_ms());
            }
            let count: usize = s
                .shares
                .iter()
                .map(|s| s.members.len() + s.invitations.len())
                .sum();
            if count >= 64 {
                return Err("共享设备及待使用邀请达到 64 个上限".into());
            }
            let share = s
                .shares
                .iter_mut()
                .find(|s| s.id == share_id)
                .ok_or("共享不存在")?;
            if share.paused || share.expires_at <= now_ms() {
                return Err("共享已暂停或过期".into());
            }
            if share.members.len() >= 8 || share.invitations.len() >= 8 {
                return Err("当前共享的设备或待使用邀请已达 8 个上限".into());
            }
            share.invitations.push(PendingInvitation {
                route_id: route_id.clone(),
                route_token: route_token.clone(),
                secret_hash: auth::secret_hash(&secret),
                expires_at,
            });
            Ok(())
        })?;
        let relay = RelayClient::new(&data.relay_url)?;
        if let Err(error) = relay
            .register_route(token, &route_id, &route_token, expires_at)
            .await
        {
            let _ = self.store.update(|s| {
                for share in &mut s.shares {
                    share.invitations.retain(|i| i.route_id != route_id);
                }
                Ok(())
            });
            return Err(error);
        }
        self.routes_changed.store(true, Ordering::Release);
        Ok(json!({"code":code,"expiresAt":expires_at,"shareId":share_id}))
    }
    fn stop_owner(&self, share_id: &str, member_id: Option<&str>) {
        if let Ok(peers) = self.peers.lock() {
            for (id, peer) in peers.iter() {
                if peer.share_id == share_id && member_id.is_none_or(|m| m == id) {
                    let _ = peer.stop.send(true);
                }
            }
        }
        self.routes_changed.store(true, Ordering::Release);
    }
    async fn delete_routes(&self, routes: Vec<String>) -> Result<(), String> {
        let data = self.store.snapshot()?;
        let Some(token) = data.owner_token else {
            return Ok(());
        };
        let relay = RelayClient::new(&data.relay_url)?;
        let mut failed = false;
        for route in routes {
            if relay.delete_route(&token, &route).await.is_err() {
                failed = true
            }
        }
        if failed {
            Err("本机已停止授权；中继暂不可达，旧入口将拒绝操作并自动过期".into())
        } else {
            Ok(())
        }
    }
    pub async fn pause(&self, share_id: String, paused: bool) -> Result<(), String> {
        let routes = self.store.update(|s| {
            let share = s
                .shares
                .iter_mut()
                .find(|s| s.id == share_id)
                .ok_or("共享不存在")?;
            share.paused = paused;
            Ok(share
                .members
                .iter()
                .map(|m| m.route_id.clone())
                .chain(share.invitations.iter().map(|i| i.route_id.clone()))
                .collect())
        })?;
        self.routes_changed.store(true, Ordering::Release);
        if paused {
            self.stop_owner(&share_id, None);
            self.delete_routes(routes).await?;
        }
        Ok(())
    }
    pub async fn revoke_member(&self, share_id: String, member_id: String) -> Result<(), String> {
        let route = self.store.update(|s| {
            let share = s
                .shares
                .iter_mut()
                .find(|s| s.id == share_id)
                .ok_or("共享不存在")?;
            let i = share
                .members
                .iter()
                .position(|m| m.id == member_id)
                .ok_or("成员不存在")?;
            Ok(share.members.remove(i).route_id)
        })?;
        self.stop_owner(&share_id, Some(&member_id));
        self.delete_routes(vec![route]).await
    }
    pub async fn delete(&self, share_id: String) -> Result<(), String> {
        let routes = self.store.update(|s| {
            let i = s
                .shares
                .iter()
                .position(|s| s.id == share_id)
                .ok_or("共享不存在")?;
            let share = s.shares.remove(i);
            Ok(share
                .members
                .into_iter()
                .map(|m| m.route_id)
                .chain(share.invitations.into_iter().map(|i| i.route_id))
                .collect())
        })?;
        self.stop_owner(&share_id, None);
        if let Ok(mut cache) = self.snapshots.lock() {
            cache.remove(&share_id);
        }
        self.delete_routes(routes).await
    }
    pub(super) async fn owner_snapshot(&self, share: &OwnedShare) -> Result<Value, String> {
        let cell = {
            self.snapshots
                .lock()
                .map_err(|_| "采样状态不可用")?
                .entry(share.id.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(None)))
                .clone()
        };
        let mut cached = cell.lock().await;
        if let Some((time, snapshot)) = &*cached {
            if time.elapsed() < Duration::from_secs(2) {
                return Ok(json!(snapshot));
            }
        }
        let (server, passwords) = (self.context)(&share.server_id)
            .map_err(|_| "提供者暂时无法访问此资源的本机配置或凭据")?;
        let snapshot = collector::collect_with_password(&server, Some(&passwords), false, false)
            .await
            .map_err(|_| "远端监控采样失败，请让提供者在 RackTop 中检查资源连接")?;
        let value = json!(&snapshot);
        *cached = Some((Instant::now(), snapshot));
        Ok(value)
    }

    fn guest_events(&self, id: &str) -> EventSink {
        let id = id.to_string();
        let events = self.events.clone();
        Arc::new(move |kind, data| {
            let Some(session_id) = data.get("sessionId").and_then(Value::as_str) else {
                return;
            };
            match kind {
                "terminalData" => {
                    if let Some(encoded) = data.get("dataBase64").and_then(Value::as_str) {
                        events(
                            "sharing-terminal-output",
                            json!({"resourceId":id,"sessionId":session_id,"data":encoded}),
                        );
                    }
                }
                "terminalExit" => events(
                    "sharing-terminal-exit",
                    json!({"resourceId":id,"sessionId":session_id}),
                ),
                _ => {}
            }
        })
    }
    fn device(&self) -> Result<identity::DeviceIdentity, String> {
        let data = self.store.snapshot()?;
        if let Some(device) = data.device_identity {
            return Ok(device);
        }
        self.store.update(|s| {
            Ok(s.device_identity
                .get_or_insert_with(identity::generate_device_identity)
                .clone())
        })
    }
    pub async fn accept(
        self: &Arc<Self>,
        code: String,
        device_name: String,
    ) -> Result<Value, String> {
        let invitation = identity::decode_invitation(code.trim())?;
        let device_name = auth::label(&device_name, 80)?;
        let device = self.device()?;
        let data = self.store.snapshot()?;
        if let Some(existing) = data
            .received
            .iter()
            .find(|s| s.route_id == invitation.route_id && s.relay_url == invitation.relay_url)
        {
            self.connect(existing.id.clone()).await?;
            let status = self.status().await?;
            return status["received"]
                .as_array()
                .and_then(|items| items.iter().find(|r| r["id"] == existing.id))
                .cloned()
                .ok_or("共享状态不可用".into());
        }
        if data.received.len() >= 32 {
            return Err("最多保存 32 个访客资源".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (session, info) = ClientSession::connect(
            ConnectOptions {
                relay_url: invitation.relay_url.clone(),
                route_id: invitation.route_id.clone(),
                route_token: invitation.route_token.clone(),
                owner_cert_der: invitation.owner_cert_der.clone(),
                device,
                device_name: device_name.clone(),
                invite_secret: Some(invitation.invite_secret),
            },
            self.guest_events(&id),
        )
        .await?;
        let resource = ReceivedShare {
            id: id.clone(),
            name: info.resource_name,
            owner_label: "资源提供者".into(),
            expires_at: info.expires_at,
            default_path: ".".into(),
            capabilities: info.capabilities,
            relay_url: invitation.relay_url,
            route_id: invitation.route_id,
            route_token: invitation.route_token,
            owner_cert_der: invitation.owner_cert_der,
            member_id: info.member_id,
            device_name,
        };
        if let Err(error) = self.store.update(|s| {
            if s.received.len() >= 32 || s.received.iter().any(|r| r.route_id == resource.route_id)
            {
                return Err("此共享已加入或访客资源已满，请刷新重试".into());
            }
            s.received.push(resource.clone());
            Ok(())
        }) {
            session.close();
            return Err(error);
        }
        self.attach(resource.clone(), Some(session))?;
        Ok(json!(resource.view("online", None)))
    }
    fn attach(
        self: &Arc<Self>,
        resource: ReceivedShare,
        initial: Option<Arc<ClientSession>>,
    ) -> Result<(), String> {
        let generation = uuid::Uuid::new_v4().to_string();
        let (stop, stopped) = watch::channel(false);
        let mut guests = self.guests.lock().map_err(|_| "共享状态不可用")?;
        if let Some(previous) = guests.insert(
            resource.id.clone(),
            GuestConnection {
                generation: generation.clone(),
                state: if initial.is_some() {
                    "online"
                } else {
                    "connecting"
                }
                .into(),
                last_error: None,
                session: initial.clone(),
                stop,
            },
        ) {
            let _ = previous.stop.send(true);
            if let Some(session) = previous.session {
                session.close();
            }
        }
        drop(guests);
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            runtime
                .maintain_guest(resource, generation, initial, stopped)
                .await;
        });
        Ok(())
    }
    async fn maintain_guest(
        self: Arc<Self>,
        resource: ReceivedShare,
        generation: String,
        mut session: Option<Arc<ClientSession>>,
        mut stopped: watch::Receiver<bool>,
    ) {
        let mut delay = 2;
        loop {
            if *stopped.borrow() || self.is_shutdown() {
                break;
            }
            if resource.expires_at <= now_ms() {
                self.guest_state(
                    &resource.id,
                    &generation,
                    "error",
                    Some("共享已过期".into()),
                    None,
                );
                break;
            }
            if session.as_ref().is_some_and(|s| s.is_alive()) {
                tokio::select! {_=stopped.changed()=>break,_=tokio::time::sleep(Duration::from_secs(1))=>{}}
                continue;
            }
            if let Some(previous) = session.take() {
                previous.close();
                self.transfers.cancel_resource(&resource.id);
            }
            self.guest_state(&resource.id, &generation, "connecting", None, None);
            let attempt = async {
                ClientSession::connect(
                    ConnectOptions {
                        relay_url: resource.relay_url.clone(),
                        route_id: resource.route_id.clone(),
                        route_token: resource.route_token.clone(),
                        owner_cert_der: resource.owner_cert_der.clone(),
                        device: self.device()?,
                        device_name: resource.device_name.clone(),
                        invite_secret: None,
                    },
                    self.guest_events(&resource.id),
                )
                .await
            };
            let result = tokio::select! {_=stopped.changed()=>break,result=attempt=>result};
            match result {
                Ok((connected, info)) => {
                    if info.member_id != resource.member_id
                        || info.expires_at != resource.expires_at
                    {
                        connected.close();
                        self.guest_state(
                            &resource.id,
                            &generation,
                            "error",
                            Some("设备授权与已保存记录不一致".into()),
                            None,
                        );
                        break;
                    }
                    if !self.guest_state(
                        &resource.id,
                        &generation,
                        "online",
                        None,
                        Some(connected.clone()),
                    ) {
                        connected.close();
                        break;
                    }
                    session = Some(connected);
                    delay = 2;
                }
                Err(error) => {
                    self.guest_state(&resource.id, &generation, "error", Some(error), None);
                    tokio::select! {_=stopped.changed()=>break,_=tokio::time::sleep(Duration::from_secs(delay))=>{}}
                    delay = (delay * 2).min(30);
                }
            }
        }
        if let Some(session) = session {
            session.close();
        }
    }
    fn guest_state(
        &self,
        id: &str,
        generation: &str,
        state: &str,
        error: Option<String>,
        session: Option<Arc<ClientSession>>,
    ) -> bool {
        let Ok(mut guests) = self.guests.lock() else {
            return false;
        };
        let Some(guest) = guests.get_mut(id) else {
            return false;
        };
        if guest.generation != generation {
            return false;
        }
        guest.state = state.into();
        guest.last_error = error;
        guest.session = session;
        true
    }
    pub async fn connect(self: &Arc<Self>, id: String) -> Result<(), String> {
        let resource = self
            .store
            .snapshot()?
            .received
            .into_iter()
            .find(|r| r.id == id)
            .ok_or("访客资源不存在")?;
        if resource.expires_at <= now_ms() {
            return Err("共享已过期".into());
        }
        {
            let guests = self.guests.lock().map_err(|_| "共享状态不可用")?;
            if guests.get(&id).is_some_and(|g| {
                g.state == "connecting" || g.session.as_ref().is_some_and(|s| s.is_alive())
            }) {
                return Ok(());
            }
        }
        self.attach(resource, None)
    }
    pub async fn disconnect(&self, id: String) -> Result<(), String> {
        if let Some(guest) = self
            .guests
            .lock()
            .map_err(|_| "共享状态不可用")?
            .remove(&id)
        {
            let _ = guest.stop.send(true);
            if let Some(session) = guest.session {
                session.close();
            }
        }
        self.transfers.cancel_resource(&id);
        Ok(())
    }
    pub async fn forget(&self, id: String) -> Result<(), String> {
        self.disconnect(id.clone()).await?;
        self.store.update(|s| {
            s.received.retain(|r| r.id != id);
            Ok(())
        })
    }
    fn session(&self, id: &str) -> Result<Arc<ClientSession>, String> {
        self.guests
            .lock()
            .map_err(|_| "共享状态不可用")?
            .get(id)
            .and_then(|g| g.session.clone())
            .filter(|s| s.is_alive())
            .ok_or("共享资源尚未连接".into())
    }
    pub async fn snapshot(&self, id: String) -> Result<Value, String> {
        let mut value = self
            .session(&id)?
            .request("monitor.snapshot", json!({}))
            .await?;
        value["serverId"] = json!(id);
        Ok(value)
    }
    pub async fn terminal_open(
        &self,
        id: String,
        columns: u16,
        rows: u16,
    ) -> Result<String, String> {
        let session = self.session(&id)?;
        let response = session
            .request("terminal.start", json!({"columns":columns,"rows":rows}))
            .await;
        match response {
            Ok(value) => match value.get("sessionId").and_then(Value::as_str) {
                Some(id) => Ok(id.into()),
                None => {
                    session.close();
                    Err("终端响应无效，连接已关闭以清理会话".into())
                }
            },
            Err(error) => {
                session.close();
                Err(error)
            }
        }
    }
    pub async fn terminal_input(
        &self,
        id: String,
        session_id: String,
        data: String,
    ) -> Result<(), String> {
        if data.len() > 48 * 1024 {
            return Err("单次终端输入超过 48 KiB".into());
        }
        self.session(&id)?
            .request(
                "terminal.write",
                json!({"sessionId":session_id,"dataBase64":STANDARD.encode(data.as_bytes())}),
            )
            .await?;
        Ok(())
    }
    pub async fn terminal_resize(
        &self,
        id: String,
        session_id: String,
        columns: u16,
        rows: u16,
    ) -> Result<(), String> {
        self.session(&id)?
            .request(
                "terminal.resize",
                json!({"sessionId":session_id,"columns":columns,"rows":rows}),
            )
            .await?;
        Ok(())
    }
    pub async fn terminal_close(&self, id: String, session_id: String) -> Result<(), String> {
        self.session(&id)?
            .request("terminal.close", json!({"sessionId":session_id}))
            .await?;
        Ok(())
    }
    pub async fn list_files(&self, id: String, path: String) -> Result<Value, String> {
        let response = self
            .session(&id)?
            .request("files.list", json!({"path":path}))
            .await?;
        let path = response
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim_matches('/');
        let parent = if path.is_empty() || path == "." {
            None
        } else {
            Some(path.rsplit_once('/').map_or(".", |(p, _)| p))
        };
        let entries:Vec<Value>=response.get("entries").and_then(Value::as_array).ok_or("文件目录响应无效")?.iter().map(|e|json!({
            "name":e["name"],"path":e["path"],"isDir":e["type"]=="directory","isSymlink":false,"size":e["size"],"modified":e["mtimeMs"]
        })).collect();
        Ok(
            json!({"path":if path.is_empty(){"."}else{path},"parent":parent,"entries":entries,"truncated":response["truncated"]}),
        )
    }
    pub async fn upload(&self, id: String, directory: String) -> Result<Option<Value>, String> {
        self.transfers
            .upload(&id, self.session(&id)?, &directory)
            .await
            .map(|v| v.map(|v| json!(v)))
    }
    pub async fn download(&self, id: String, path: String) -> Result<Option<Value>, String> {
        self.transfers
            .download(&id, self.session(&id)?, &path)
            .await
            .map(|v| v.map(|v| json!(v)))
    }
    pub async fn cancel_transfer(&self, transfer_id: String) -> Result<(), String> {
        self.transfers.cancel(&transfer_id)
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
