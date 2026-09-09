use super::identity::{INNER_SERVER_NAME, OwnerIdentity, TRUSTED_RELAY_URL, decode_bounded};
use futures_util::{SinkExt, StreamExt};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{net::IpAddr, sync::Arc, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream};
use tokio_rustls::{TlsAcceptor, TlsConnector, rustls};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};

const IO_TIMEOUT: Duration = Duration::from_secs(30);
const CHUNK_BYTES: usize = 32 * 1024;
const DIRECTION_BYTES_PER_SECOND: u64 = 1536 * 1024;

pub trait SharedIo: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> SharedIo for T {}
pub type SharedStream = Box<dyn SharedIo>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTicket {
    pub route_id: String,
    pub room_id: String,
    pub host_path: String,
    pub host_token: String,
    pub expires_at: u64,
    #[serde(default)]
    pub guest_ip: Option<IpAddr>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestTicket {
    pub room_id: String,
    pub guest_path: String,
    pub guest_token: String,
    pub expires_at: u64,
}

#[derive(Clone)]
pub struct RelayClient {
    base_url: String,
    client: reqwest::Client,
}

impl RelayClient {
    pub fn new(relay_url: &str) -> Result<Self, String> {
        if relay_url != TRUSTED_RELAY_URL {
            return Err("不允许使用未受信任的中继地址".into());
        }
        Self::build(relay_url)
    }

    fn build(relay_url: &str) -> Result<Self, String> {
        // Several HTTP clients coexist in Tauri; install a provider only if the
        // process has not chosen one. Never weaken certificate verification.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "无法初始化中继客户端")?;
        Ok(Self {
            base_url: relay_url.into(),
            client,
        })
    }

    /// Local probes only; this entry point is absent from normal production builds.
    #[cfg(any(test, feature = "integration-probe"))]
    pub fn new_for_probe(url: &str) -> Result<Self, String> {
        let parsed = reqwest::Url::parse(url).map_err(|_| "测试地址无效")?;
        if parsed.scheme() != "http"
            || parsed.host_str() != Some("127.0.0.1")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.path() != "/"
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err("测试中继必须位于 IPv4 loopback".into());
        }
        Self::build(url.trim_end_matches('/'))
    }

    async fn response<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, String> {
        let mut response = request
            .send()
            .await
            .map_err(|_| "无法连接中继，请检查网络")?;
        if !response.status().is_success() {
            return Err(match response.status().as_u16() {
                401 | 403 => "中继凭据无效或已撤销",
                404 | 410 => "共享入口暂不可用，请等待提供者重新上线",
                409 => "共享入口已被占用",
                429 => "共享连接过于频繁或容量已满，请稍后重试",
                503 => "资源提供者当前离线",
                _ => "中继请求失败",
            }
            .into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "中继响应不完整")? {
            if bytes.len() + chunk.len() > 128 * 1024 {
                return Err("中继响应过大".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| "中继响应无效".into())
    }

    pub async fn verify_owner(&self, owner_token: &str) -> Result<(), String> {
        #[derive(Deserialize)]
        struct Status {
            status: String,
        }
        let result: Status = self
            .response(
                self.client
                    .get(format!("{}/v1/owner", self.base_url))
                    .bearer_auth(owner_token),
            )
            .await?;
        if result.status != "ok" {
            return Err("中继认证响应无效".into());
        }
        Ok(())
    }

    pub async fn register_route(
        &self,
        owner_token: &str,
        route_id: &str,
        route_token: &str,
        expires_at: u64,
    ) -> Result<(), String> {
        validate_id(route_id)?;
        let _: serde_json::Value = self
            .response(
                self.client
                    .post(format!("{}/v1/routes", self.base_url))
                    .bearer_auth(owner_token)
                    .json(&serde_json::json!({
                        "routeId": route_id, "routeToken": route_token, "expiresAt": expires_at,
                    })),
            )
            .await?;
        Ok(())
    }

    pub async fn pending(&self, owner_token: &str) -> Result<Vec<HostTicket>, String> {
        #[derive(Deserialize)]
        struct Pending {
            tickets: Vec<HostTicket>,
        }
        let response: Pending = self
            .response(
                self.client
                    .get(format!("{}/v1/pending", self.base_url))
                    .bearer_auth(owner_token),
            )
            .await?;
        if response.tickets.len() > 16 {
            return Err("中继票据过多".into());
        }
        Ok(response.tickets)
    }

    pub async fn delete_route(&self, owner_token: &str, route_id: &str) -> Result<(), String> {
        validate_id(route_id)?;
        let _: serde_json::Value = self
            .response(
                self.client
                    .delete(format!("{}/v1/routes/{route_id}", self.base_url))
                    .bearer_auth(owner_token),
            )
            .await?;
        Ok(())
    }

    pub async fn connect_guest(
        &self,
        route_id: &str,
        route_token: &str,
    ) -> Result<GuestTicket, String> {
        validate_id(route_id)?;
        self.response(
            self.client
                .post(format!("{}/v1/routes/{route_id}/connect", self.base_url))
                .bearer_auth(route_token),
        )
        .await
    }

    pub async fn connect_host(
        &self,
        ticket: &HostTicket,
        identity: &OwnerIdentity,
    ) -> Result<SharedStream, String> {
        validate_id(&ticket.room_id)?;
        if ticket.host_path != format!("/v1/rooms/{}/host", ticket.room_id) {
            return Err("中继票据路径无效".into());
        }
        let stream = self
            .binary_stream(&ticket.host_path, &ticket.host_token)
            .await?;
        accept_inner(stream, identity).await
    }

    pub async fn connect_visitor(
        &self,
        ticket: &GuestTicket,
        owner_cert_der: &str,
    ) -> Result<SharedStream, String> {
        validate_id(&ticket.room_id)?;
        if ticket.guest_path != format!("/v1/rooms/{}/guest", ticket.room_id) {
            return Err("中继票据路径无效".into());
        }
        let stream = self
            .binary_stream(&ticket.guest_path, &ticket.guest_token)
            .await?;
        connect_inner(stream, owner_cert_der).await
    }

    async fn binary_stream(&self, path: &str, token: &str) -> Result<DuplexStream, String> {
        if decode_bounded(token, 32)?.len() != 32 {
            return Err("中继票据无效".into());
        }
        let base = self
            .base_url
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        let mut request = format!("{base}{path}")
            .into_client_request()
            .map_err(|_| "中继请求无效")?;
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {token}")
                .parse()
                .map_err(|_| "中继票据无效")?,
        );
        let config = WebSocketConfig::default()
            .max_message_size(Some(64 * 1024))
            .max_frame_size(Some(64 * 1024))
            .write_buffer_size(0)
            .max_write_buffer_size(128 * 1024);
        let (mut ws, _) = tokio::time::timeout(
            IO_TIMEOUT,
            connect_async_with_config(request, Some(config), false),
        )
        .await
        .map_err(|_| "中继连接超时")?
        .map_err(|_| "中继 TLS 或连接验证失败")?;
        tokio::time::timeout(IO_TIMEOUT, async {
            loop {
                match ws.next().await {
                    Some(Ok(Message::Text(text))) if text.as_str() == "{\"type\":\"ready\"}" => {
                        return Ok(());
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {
                        ws.flush().await.map_err(|_| "中继连接已关闭")?;
                    }
                    _ => return Err("中继配对失败"),
                }
            }
        })
        .await
        .map_err(|_| "等待资源提供者连接超时")??;
        let (application, bridge) = tokio::io::duplex(256 * 1024);
        let (mut bridge_read, mut bridge_write) = tokio::io::split(bridge);
        let (mut sender, mut receiver) = ws.split();
        tokio::spawn(async move {
            let incoming = async {
                while let Some(message) = receiver.next().await {
                    match message {
                        Ok(Message::Binary(data)) if !data.is_empty() => {
                            tokio::time::timeout(IO_TIMEOUT, bridge_write.write_all(&data))
                                .await
                                .map_err(|_| ())?
                                .map_err(|_| ())?;
                        }
                        Ok(Message::Ping(_) | Message::Pong(_)) => {}
                        _ => return Err::<(), ()>(()),
                    }
                }
                Ok(())
            };
            let outgoing = async {
                let mut chunk = vec![0u8; CHUNK_BYTES];
                let mut next_send = tokio::time::Instant::now();
                loop {
                    let count = bridge_read.read(&mut chunk).await.map_err(|_| ())?;
                    if count == 0 {
                        return Ok::<(), ()>(());
                    }
                    tokio::time::sleep_until(next_send).await;
                    tokio::time::timeout(
                        IO_TIMEOUT,
                        sender.send(Message::Binary(chunk[..count].to_vec().into())),
                    )
                    .await
                    .map_err(|_| ())?
                    .map_err(|_| ())?;
                    next_send = tokio::time::Instant::now()
                        + Duration::from_nanos(
                            (count as u64 * 1_000_000_000).div_ceil(DIRECTION_BYTES_PER_SECOND),
                        );
                }
            };
            // Dropping either failed direction drops both WS halves and both duplex halves.
            tokio::select! { _ = incoming => {}, _ = outgoing => {} }
        });
        Ok(application)
    }
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.len() != 32
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("共享路由标识无效".into());
    }
    Ok(())
}

async fn accept_inner(
    stream: DuplexStream,
    identity: &OwnerIdentity,
) -> Result<SharedStream, String> {
    let cert = CertificateDer::from(decode_bounded(&identity.cert_der, 4096)?);
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(decode_bounded(
        &identity.key_der,
        4096,
    )?));
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| "共享 TLS 配置失败")?
    .with_no_client_auth()
    .with_single_cert(vec![cert], key)
    .map_err(|_| "共享证书或密钥无效")?;
    let stream = tokio::time::timeout(
        IO_TIMEOUT,
        TlsAcceptor::from(Arc::new(config)).accept(stream),
    )
    .await
    .map_err(|_| "共享 TLS 握手超时")?
    .map_err(|_| "共享 TLS 握手失败")?;
    Ok(Box::new(stream))
}

async fn connect_inner(stream: DuplexStream, owner_cert_der: &str) -> Result<SharedStream, String> {
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(CertificateDer::from(decode_bounded(owner_cert_der, 4096)?))
        .map_err(|_| "邀请证书无效")?;
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| "共享 TLS 配置失败")?
    .with_root_certificates(roots)
    .with_no_client_auth();
    let server_name = ServerName::try_from(INNER_SERVER_NAME).map_err(|_| "共享 TLS 名称无效")?;
    let stream = tokio::time::timeout(
        IO_TIMEOUT,
        TlsConnector::from(Arc::new(config)).connect(server_name, stream),
    )
    .await
    .map_err(|_| "共享 TLS 握手超时")?
    .map_err(|_| "资源提供者证书验证失败")?;
    Ok(Box::new(stream))
}

#[cfg(test)]
mod tests {
    use super::super::{
        identity::generate_owner_identity,
        protocol::{read_frame, write_frame},
    };
    use super::*;

    #[tokio::test]
    async fn inner_tls_validates_invited_certificate_and_transfers_large_frame() {
        let owner = generate_owner_identity().unwrap();
        let (a, b) = tokio::io::duplex(4096);
        let (host, guest) =
            tokio::join!(accept_inner(a, &owner), connect_inner(b, &owner.cert_der));
        let (mut host, mut guest) = (host.unwrap(), guest.unwrap());
        let task =
            tokio::spawn(
                async move { write_frame(&mut host, &"x".repeat(100_000)).await.unwrap() },
            );
        let message: String = read_frame(&mut guest).await.unwrap();
        assert_eq!(message.len(), 100_000);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn wrong_owner_certificate_is_rejected() {
        let owner = generate_owner_identity().unwrap();
        let wrong = generate_owner_identity().unwrap();
        let (a, b) = tokio::io::duplex(4096);
        let (_host, guest) =
            tokio::join!(accept_inner(a, &owner), connect_inner(b, &wrong.cert_der));
        assert!(guest.is_err());
    }

    #[test]
    fn production_endpoint_and_ticket_paths_cannot_redirect_credentials() {
        assert!(RelayClient::new("https://attacker.invalid").is_err());
        assert!(RelayClient::new("http://136.0.110.161").is_err());
        assert!(validate_id("../../../etc/passwd").is_err());
    }

    #[test]
    fn owner_ticket_accepts_optional_valid_ip_addresses_and_rejects_invalid_values() {
        let base = serde_json::json!({
            "routeId": "a".repeat(32),
            "roomId": "b".repeat(32),
            "hostPath": format!("/v1/rooms/{}/host", "b".repeat(32)),
            "hostToken": "c".repeat(43),
            "expiresAt": 42
        });
        let without: HostTicket = serde_json::from_value(base.clone()).unwrap();
        assert!(without.guest_ip.is_none());
        for address in ["203.0.113.8", "2001:db8::8"] {
            let mut value = base.clone();
            value["guestIp"] = serde_json::Value::String(address.into());
            let ticket: HostTicket = serde_json::from_value(value).unwrap();
            assert_eq!(ticket.guest_ip.unwrap().to_string(), address);
        }
        let mut invalid = base;
        invalid["guestIp"] = serde_json::Value::String("not-an-ip".into());
        assert!(serde_json::from_value::<HostTicket>(invalid).is_err());
    }

    #[tokio::test]
    #[ignore = "requires RACKTOP_RELAY_DIR and permission to listen on loopback"]
    async fn real_node_relay_reconnects_and_carries_tls_frames() {
        use super::super::identity::{random_route_id, random_token};
        use std::{
            io::BufRead,
            process::{Command, Stdio},
        };
        struct ChildGuard(std::process::Child);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let directory = std::env::var("RACKTOP_RELAY_DIR").expect("RACKTOP_RELAY_DIR");
        let owner_token = random_token();
        let script = "import {createRelay} from './src/relay.mjs'; const r=createRelay({ownerToken:process.env.RELAY_TEST_TOKEN,heartbeatMs:100}); const a=await r.listen(0); console.log(a.port);";
        let mut process = ChildGuard(
            Command::new("node")
                .args(["--input-type=module", "-e", script])
                .current_dir(directory)
                .env("RELAY_TEST_TOKEN", &owner_token)
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        let mut port = String::new();
        std::io::BufReader::new(process.0.stdout.take().unwrap())
            .read_line(&mut port)
            .unwrap();
        let port: u16 = port.trim().parse().unwrap();
        let relay = RelayClient::new_for_probe(&format!("http://127.0.0.1:{port}")).unwrap();
        relay.verify_owner(&owner_token).await.unwrap();
        assert!(relay.verify_owner(&random_token()).await.is_err());
        let route_id = random_route_id();
        let route_token = random_token();
        let expires_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 60_000;
        relay
            .register_route(&owner_token, &route_id, &route_token, expires_at)
            .await
            .unwrap();
        assert!(relay.pending(&owner_token).await.unwrap().is_empty());
        let owner = generate_owner_identity().unwrap();
        let mut previous_room = String::new();
        for _ in 0..2 {
            let guest = relay.connect_guest(&route_id, &route_token).await.unwrap();
            assert_ne!(guest.room_id, previous_room);
            previous_room = guest.room_id.clone();
            let host = relay.pending(&owner_token).await.unwrap().pop().unwrap();
            let (host, guest) = tokio::join!(
                relay.connect_host(&host, &owner),
                relay.connect_visitor(&guest, &owner.cert_der)
            );
            let (mut host, mut guest) = (host.unwrap(), guest.unwrap());
            // The WS read task must also flush automatic heartbeat pongs while idle.
            tokio::time::sleep(Duration::from_millis(350)).await;
            let owner_task = tokio::spawn(async move {
                write_frame(&mut host, &"a".repeat(100_000)).await.unwrap();
                let response: String = read_frame(&mut host).await.unwrap();
                assert_eq!(response, "b".repeat(100_000));
            });
            let message: String = read_frame(&mut guest).await.unwrap();
            assert_eq!(message, "a".repeat(100_000));
            write_frame(&mut guest, &"b".repeat(100_000)).await.unwrap();
            owner_task.await.unwrap();
            drop(guest);
        }
        let guest = relay.connect_guest(&route_id, &route_token).await.unwrap();
        let host = relay.pending(&owner_token).await.unwrap().pop().unwrap();
        let wrong = generate_owner_identity().unwrap();
        let (_host, guest) = tokio::join!(
            relay.connect_host(&host, &owner),
            relay.connect_visitor(&guest, &wrong.cert_der)
        );
        assert!(guest.is_err());
        relay.delete_route(&owner_token, &route_id).await.unwrap();
        assert!(relay.connect_guest(&route_id, &route_token).await.is_err());
    }
}
