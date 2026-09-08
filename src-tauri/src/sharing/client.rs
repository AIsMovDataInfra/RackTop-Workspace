use super::{
    auth::{authentication_message, label},
    identity::{self, DeviceIdentity},
    protocol::{MAX_FRAME_BYTES, read_frame, write_frame},
    store::{Capabilities, now_ms},
    transport::{RelayClient, SharedStream},
    wire::Wire,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot, watch};

pub type EventSink = Arc<dyn Fn(&str, Value) + Send + Sync>;
type Reply = Result<Value, String>;
type Pending = Mutex<HashMap<String, oneshot::Sender<Reply>>>;
const MAX_PENDING: usize = 32;

// No Debug implementation: this object includes invitation and device credentials.
pub struct ConnectOptions {
    pub relay_url: String,
    pub route_id: String,
    pub route_token: String,
    pub owner_cert_der: String,
    pub device: DeviceIdentity,
    pub device_name: String,
    pub invite_secret: Option<String>,
}

pub struct AuthenticatedInfo {
    pub member_id: String,
    pub resource_name: String,
    pub expires_at: u64,
    pub capabilities: Capabilities,
}

#[derive(Clone, Copy)]
struct Timing {
    request: Duration,
    ping: Duration,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            request: Duration::from_secs(30),
            ping: Duration::from_secs(5),
        }
    }
}

pub struct ClientSession {
    alive: AtomicBool,
    outgoing: mpsc::Sender<Wire>,
    pending: Pending,
    stop: watch::Sender<bool>,
    timing: Timing,
}

struct RequestGuard<'a> {
    pending: &'a Pending,
    id: String,
}
impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}

// Task errors, cancellation and unwinding all close the other half of the session.
struct CloseOnDrop(Weak<ClientSession>);
impl Drop for CloseOnDrop {
    fn drop(&mut self) {
        if let Some(session) = self.0.upgrade() {
            session.close();
        }
    }
}

impl ClientSession {
    pub async fn connect(
        options: ConnectOptions,
        events: EventSink,
    ) -> Result<(Arc<Self>, AuthenticatedInfo), String> {
        label(&options.device_name, 80)?;
        let relay = RelayClient::new(&options.relay_url)?;
        let ticket = relay
            .connect_guest(&options.route_id, &options.route_token)
            .await?;
        let stream = relay
            .connect_visitor(&ticket, &options.owner_cert_der)
            .await?;
        let (stream, info) = authenticate_stream(stream, &options).await?;
        Ok((Self::start(stream, events, Timing::default()), info))
    }

    fn start(stream: SharedStream, events: EventSink, timing: Timing) -> Arc<Self> {
        let (outgoing, mut incoming_writes) = mpsc::channel(32);
        let (stop, _) = watch::channel(false);
        let session = Arc::new(Self {
            alive: AtomicBool::new(true),
            outgoing,
            pending: Mutex::new(HashMap::new()),
            stop,
            timing,
        });
        let (mut reader, mut writer) = tokio::io::split(stream);

        let weak = Arc::downgrade(&session);
        let mut stopped = session.stop.subscribe();
        tokio::spawn(async move {
            let _cleanup = CloseOnDrop(weak);
            loop {
                let message = tokio::select! {
                    biased;
                    _ = stopped.changed() => break,
                    message = incoming_writes.recv() => match message { Some(message) => message, None => break },
                };
                let sent = tokio::select! {
                    biased;
                    _ = stopped.changed() => break,
                    result = write_frame(&mut writer, &message) => result,
                };
                if sent.is_err() {
                    break;
                }
            }
        });

        let weak = Arc::downgrade(&session);
        let mut stopped = session.stop.subscribe();
        tokio::spawn(async move {
            let _cleanup = CloseOnDrop(weak.clone());
            loop {
                let message: Wire = tokio::select! {
                    biased;
                    _ = stopped.changed() => break,
                    message = read_frame(&mut reader) => match message { Ok(message) => message, Err(_) => break },
                };
                let Some(session) = weak.upgrade() else {
                    break;
                };
                if !session.is_alive() {
                    break;
                }
                match message {
                    Wire::Response { id, result, error } => {
                        let reply = match (result, error) {
                            (Some(result), None) => Ok(result),
                            (None, Some(error)) => Err(error),
                            _ => {
                                session.close();
                                break;
                            }
                        };
                        let waiter = session
                            .pending
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .remove(&id);
                        // A late response to a cancelled/timed-out request is never replayed.
                        if let Some(waiter) = waiter {
                            let _ = waiter.send(reply);
                        }
                    }
                    Wire::Event { kind, data }
                        if kind == "terminalData" || kind == "terminalExit" =>
                    {
                        events(&kind, data);
                    }
                    Wire::Event { .. } => {}
                    _ => {
                        session.close();
                        break;
                    }
                }
            }
        });

        let weak = Arc::downgrade(&session);
        let mut stopped = session.stop.subscribe();
        tokio::spawn(async move {
            let _cleanup = CloseOnDrop(weak.clone());
            let mut tick =
                tokio::time::interval_at(tokio::time::Instant::now() + timing.ping, timing.ping);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! { biased; _ = stopped.changed() => break, _ = tick.tick() => {} }
                let Some(session) = weak.upgrade() else {
                    break;
                };
                let result = tokio::select! {
                    biased;
                    _ = stopped.changed() => break,
                    result = session.request("session.ping", serde_json::json!({})) => result,
                };
                if result.is_err() {
                    session.close();
                    break;
                }
            }
        });
        session
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        if !self.is_alive() {
            return Err("共享连接已断开".into());
        }
        if !params.is_object() {
            return Err("共享请求参数必须为对象".into());
        }
        if method.is_empty()
            || method.len() > 128
            || !method
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_')
        {
            return Err("共享操作名称无效".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let message = Wire::Request {
            id: id.clone(),
            method: method.into(),
            params,
        };
        // Validate size without constructing a second unbounded JSON copy.
        serde_json::to_writer(SizeLimit(0), &message).map_err(|_| "共享请求超过 128 KiB 上限")?;
        let (send, receive) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            if !self.is_alive() {
                return Err("共享连接已断开".into());
            }
            if pending.len() >= MAX_PENDING {
                return Err("共享请求繁忙，请稍后重试".into());
            }
            pending.insert(id.clone(), send);
        }
        let _guard = RequestGuard {
            pending: &self.pending,
            id,
        };
        self.outgoing
            .try_send(message)
            .map_err(|_| "共享请求队列已满或连接已关闭")?;
        tokio::time::timeout(self.timing.request, receive)
            .await
            .map_err(|_| "共享请求超时，请确认远端执行结果；请求不会自动重放")?
            .map_err(|_| "共享连接已断开")?
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub fn close(&self) {
        if !self.alive.swap(false, Ordering::AcqRel) {
            return;
        }
        for (_, pending) in self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
        {
            let _ = pending.send(Err("共享连接已断开".into()));
        }
        let _ = self.stop.send(true);
    }
}

impl Drop for ClientSession {
    fn drop(&mut self) {
        self.close();
    }
}

struct SizeLimit(usize);
impl std::io::Write for SizeLimit {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        if self.0 > MAX_FRAME_BYTES {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

async fn authenticate_stream(
    mut stream: SharedStream,
    options: &ConnectOptions,
) -> Result<(SharedStream, AuthenticatedInfo), String> {
    let info = tokio::time::timeout(Duration::from_secs(30), async {
        let nonce = match read_frame::<_, Wire>(&mut stream).await? {
            Wire::Challenge { nonce } => nonce,
            Wire::Rejected { message } => return Err(message),
            _ => return Err("资源提供者未发送有效身份挑战".into()),
        };
        if identity::decode_bounded(&nonce, 32)?.len() != 32 {
            return Err("身份挑战格式无效".into());
        }
        let signature = identity::sign(
            &options.device,
            &authentication_message(&nonce, &options.route_id, &options.device.public_key),
        )?;
        write_frame(
            &mut stream,
            &Wire::Authenticate {
                public_key: options.device.public_key.clone(),
                signature,
                device_name: label(&options.device_name, 80)?,
                invite_secret: options.invite_secret.clone(),
            },
        )
        .await?;
        match read_frame::<_, Wire>(&mut stream).await? {
            Wire::Authenticated {
                member_id,
                resource_name,
                expires_at,
                capabilities,
            } => {
                let member_id = label(&member_id, 128)?;
                let resource_name = label(&resource_name, 200)?;
                if expires_at <= now_ms() {
                    return Err("资源共享已过期".into());
                }
                Ok(AuthenticatedInfo {
                    member_id,
                    resource_name,
                    expires_at,
                    capabilities,
                })
            }
            Wire::Rejected { message } => Err(message),
            _ => Err("资源提供者身份响应无效".into()),
        }
    })
    .await
    .map_err(|_| "共享设备身份验证超时")??;
    Ok((stream, info))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn quiet() -> EventSink {
        Arc::new(|_, _| {})
    }
    fn test_timing() -> Timing {
        Timing {
            request: Duration::from_secs(2),
            ping: Duration::from_secs(3600),
        }
    }
    fn pair(events: EventSink, timing: Timing) -> (Arc<ClientSession>, tokio::io::DuplexStream) {
        let (a, b) = tokio::io::duplex(256 * 1024);
        (ClientSession::start(Box::new(a), events, timing), b)
    }
    async fn wait_until(predicate: impl Fn() -> bool) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !predicate() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn concurrent_requests_are_correlated_when_responses_arrive_in_reverse_order() {
        let (client, mut remote) = pair(quiet(), test_timing());
        let first_client = client.clone();
        let first =
            tokio::spawn(async move { first_client.request("files.list", json!({"n": 1})).await });
        let second_client = client.clone();
        let second =
            tokio::spawn(async move { second_client.request("files.list", json!({"n": 2})).await });
        let mut requests = Vec::new();
        for _ in 0..2 {
            let Wire::Request { id, params, .. } = read_frame(&mut remote).await.unwrap() else {
                panic!("request");
            };
            assert!(uuid::Uuid::parse_str(&id).is_ok());
            requests.push((id, params));
        }
        for (id, params) in requests.into_iter().rev() {
            write_frame(
                &mut remote,
                &Wire::Response {
                    id,
                    result: Some(params),
                    error: None,
                },
            )
            .await
            .unwrap();
        }
        assert_eq!(first.await.unwrap().unwrap(), json!({"n": 1}));
        assert_eq!(second.await.unwrap().unwrap(), json!({"n": 2}));
        client.close();
    }

    #[tokio::test]
    async fn disconnect_fails_pending_immediately_and_close_is_idempotent() {
        let (client, mut remote) = pair(quiet(), test_timing());
        let request_client = client.clone();
        let request =
            tokio::spawn(async move { request_client.request("terminal.start", json!({})).await });
        let _: Wire = read_frame(&mut remote).await.unwrap();
        drop(remote);
        assert!(
            tokio::time::timeout(Duration::from_millis(200), request)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(!client.is_alive());
        client.close();
        client.close();
        assert!(client.request("session.ping", json!({})).await.is_err());
    }

    #[tokio::test]
    async fn cancelling_request_futures_releases_pending_capacity_without_replaying() {
        let (client, mut remote) = pair(quiet(), test_timing());
        let request_client = client.clone();
        let request =
            tokio::spawn(async move { request_client.request("files.list", json!({})).await });
        let _: Wire = read_frame(&mut remote).await.unwrap();
        request.abort();
        let _ = request.await;
        assert_eq!(client.pending.lock().unwrap().len(), 0);
        let request_client = client.clone();
        let next =
            tokio::spawn(async move { request_client.request("session.ping", json!({})).await });
        let Wire::Request { id, method, .. } = read_frame(&mut remote).await.unwrap() else {
            panic!("request");
        };
        assert_eq!(method, "session.ping");
        write_frame(
            &mut remote,
            &Wire::Response {
                id,
                result: Some(json!(true)),
                error: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(next.await.unwrap().unwrap(), json!(true));
        client.close();
    }

    #[tokio::test]
    async fn pending_and_serialized_message_limits_are_enforced() {
        let (client, _remote) = pair(quiet(), test_timing());
        assert!(
            client
                .request("files.list", json!({"data":"x".repeat(MAX_FRAME_BYTES)}))
                .await
                .is_err()
        );
        assert!(client.request("session.ping", Value::Null).await.is_err());
        let mut requests = Vec::new();
        for _ in 0..32 {
            let clone = client.clone();
            requests.push(tokio::spawn(async move {
                clone.request("files.list", json!({})).await
            }));
        }
        wait_until(|| client.pending.lock().unwrap().len() == 32).await;
        assert!(
            client
                .request("files.list", json!({}))
                .await
                .unwrap_err()
                .contains("繁忙")
        );
        client.close();
        for request in requests {
            assert!(request.await.unwrap().is_err());
        }
    }

    #[tokio::test]
    async fn only_terminal_events_are_emitted_and_malformed_response_closes_session() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let events = captured.clone();
        let (client, mut remote) = pair(
            Arc::new(move |kind, data| events.lock().unwrap().push((kind.to_string(), data))),
            test_timing(),
        );
        for kind in ["saveServer", "terminalData", "terminalExit"] {
            write_frame(
                &mut remote,
                &Wire::Event {
                    kind: kind.into(),
                    data: json!({"terminalId": "t"}),
                },
            )
            .await
            .unwrap();
        }
        wait_until(|| captured.lock().unwrap().len() == 2).await;
        assert_eq!(captured.lock().unwrap()[0].0, "terminalData");
        write_frame(
            &mut remote,
            &Wire::Response {
                id: "invalid".into(),
                result: None,
                error: None,
            },
        )
        .await
        .unwrap();
        wait_until(|| !client.is_alive()).await;
    }

    #[tokio::test]
    async fn failed_keepalive_closes_without_replaying_ping() {
        let (client, mut remote) = pair(
            quiet(),
            Timing {
                request: Duration::from_millis(30),
                ping: Duration::from_millis(10),
            },
        );
        let Wire::Request { method, params, .. } = read_frame(&mut remote).await.unwrap() else {
            panic!("ping");
        };
        assert_eq!(method, "session.ping");
        assert!(params.is_object());
        wait_until(|| !client.is_alive()).await;
        assert!(read_frame::<_, Wire>(&mut remote).await.is_err());
    }

    fn options() -> ConnectOptions {
        ConnectOptions {
            relay_url: identity::TRUSTED_RELAY_URL.into(),
            route_id: identity::random_route_id(),
            route_token: identity::random_token(),
            owner_cert_der: String::new(),
            device: identity::generate_device_identity(),
            device_name: "Test device".into(),
            invite_secret: Some(identity::random_token()),
        }
    }

    #[tokio::test]
    async fn authentication_signs_fresh_nonce_bound_to_route_and_public_key() {
        let options = options();
        let route = options.route_id.clone();
        let public = options.device.public_key.clone();
        let secret = options.invite_secret.clone();
        let nonce = identity::random_token();
        let (client, mut remote) = tokio::io::duplex(8192);
        let authenticate =
            tokio::spawn(async move { authenticate_stream(Box::new(client), &options).await });
        write_frame(
            &mut remote,
            &Wire::Challenge {
                nonce: nonce.clone(),
            },
        )
        .await
        .unwrap();
        let Wire::Authenticate {
            public_key,
            signature,
            invite_secret,
            ..
        } = read_frame(&mut remote).await.unwrap()
        else {
            panic!("authenticate");
        };
        assert_eq!(public_key, public);
        assert_eq!(invite_secret, secret);
        identity::verify(
            &public,
            &authentication_message(&nonce, &route, &public),
            &signature,
        )
        .unwrap();
        assert!(
            identity::verify(
                &public,
                &authentication_message(&identity::random_token(), &route, &public),
                &signature
            )
            .is_err()
        );
        assert!(
            identity::verify(
                &public,
                &authentication_message(&nonce, "another-route", &public),
                &signature
            )
            .is_err()
        );
        write_frame(
            &mut remote,
            &Wire::Authenticated {
                member_id: "member".into(),
                resource_name: "A100".into(),
                expires_at: now_ms() + 60_000,
                capabilities: Capabilities {
                    monitor: true,
                    terminal: true,
                    files: true,
                },
            },
        )
        .await
        .unwrap();
        let (_, info) = authenticate.await.unwrap().unwrap();
        assert_eq!(info.member_id, "member");
        assert!(info.capabilities.terminal);
    }

    #[tokio::test]
    async fn authentication_rejects_malformed_challenge_and_owner_rejection() {
        for message in [
            Wire::Challenge {
                nonce: "weak".into(),
            },
            Wire::Rejected {
                message: "Revoked".into(),
            },
        ] {
            let (client, mut remote) = tokio::io::duplex(8192);
            write_frame(&mut remote, &message).await.unwrap();
            assert!(
                authenticate_stream(Box::new(client), &options())
                    .await
                    .is_err()
            );
            assert!(read_frame::<_, Wire>(&mut remote).await.is_err());
        }
    }

    #[tokio::test]
    async fn dropping_last_session_reference_closes_background_stream_tasks() {
        let (client, mut remote) = pair(quiet(), test_timing());
        let weak = Arc::downgrade(&client);
        drop(client);
        assert!(weak.upgrade().is_none());
        assert!(
            tokio::time::timeout(
                Duration::from_millis(200),
                read_frame::<_, Wire>(&mut remote)
            )
            .await
            .unwrap()
            .is_err()
        );
    }
}
