//! Explicitly invoked integration probe, never bundled in the desktop app.
//! Owner token is read from stdin; invitations and credential material are never printed.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use racktop_lib::{
    models::Server,
    sharing::{
        client::{ClientSession, ConnectOptions},
        identity::{self, DeviceIdentity, Invitation},
        runtime::{EventSink, ServerContext, SharingRuntime},
        store::{Capabilities, Persisted, ShareStore},
        transport::RelayClient,
    },
    ssh_connection::SshPasswords,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::mpsc;

enum Mode {
    Exercise {
        database: PathBuf,
        server_id: String,
    },
    Configure {
        profile: PathBuf,
    },
}

fn parse_args(args: &[String]) -> Result<Mode, String> {
    let usage = "Usage: sharing-probe --database PATH --server-id ID | --configure-profile APP_DATA_DIR; relay owner token on stdin";
    match args {
        [flag, profile] if flag == "--configure-profile" => Ok(Mode::Configure {
            profile: profile.into(),
        }),
        [first, database, second, server_id]
            if first == "--database" && second == "--server-id" && !server_id.is_empty() =>
        {
            Ok(Mode::Exercise {
                database: database.into(),
                server_id: server_id.clone(),
            })
        }
        _ => Err(usage.into()),
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // These are the existing SSH helper paths, before stdin or normal logging.
    if args.first().map(String::as_str) == Some("--racktop-ssh-proxy") {
        if racktop_lib::ssh_connection::run_proxy(&args[1..]).is_err() {
            std::process::exit(1);
        }
        return;
    }
    if let Ok(password) = std::env::var("RACKTOP_ASKPASS_PASSWORD") {
        print!("{password}");
        return;
    }
    tauri::async_runtime::set(tokio::runtime::Handle::current());
    let result = async {
        let mode = parse_args(&args)?;
        let mut token = String::new();
        std::io::stdin()
            .take(257)
            .read_to_string(&mut token)
            .map_err(|_| "Cannot read owner token from stdin")?;
        let token = token.trim();
        if !(32..=128).contains(&token.len())
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("Invalid relay owner token format".into());
        }
        match mode {
            Mode::Configure { profile } => configure_profile(&profile, token).await,
            Mode::Exercise {
                database,
                server_id,
            } => exercise(&database, &server_id, token).await,
        }
    }
    .await;
    if let Err(error) = result {
        eprintln!("Sharing probe failed: {error}");
        std::process::exit(1);
    }
}

async fn configure_profile(profile: &Path, token: &str) -> Result<(), String> {
    // Save exactly the profile path the desktop uses; don't start a runtime here:
    // even pre-existing saved shares must not become active as a side effect.
    if !profile.is_absolute() || !profile.is_dir() {
        return Err("APP_DATA_DIR must be an existing absolute directory".into());
    }
    RelayClient::new(identity::TRUSTED_RELAY_URL)?
        .verify_owner(token)
        .await?;
    let store = ShareStore::new(profile)?;
    store.update(|data| {
        if data.owner_identity.is_none() {
            data.owner_identity = Some(identity::generate_owner_identity()?);
        }
        data.relay_url = identity::TRUSTED_RELAY_URL.into();
        data.owner_token = Some(token.into());
        Ok(())
    })?;
    println!(
        "PASS gateway configuration saved in OS credential storage; no sharing runtime started"
    );
    Ok(())
}

/// Avoid Database::open: it performs migrations and updates credential status.
/// A consistent read-only SQLite transaction loads only the explicitly chosen server.
fn server_context(database: &Path, id: &str) -> Result<ServerContext, String> {
    let connection = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "Cannot open RackTop database read-only")?;
    connection
        .execute_batch("BEGIN")
        .map_err(|_| "Cannot read RackTop database")?;
    let (server, credential_state): (Server, String) = connection.query_row(
        "SELECT id,name,location,host,port,username,ssh_alias,identity_file,proxy_jump,tags_json,sampling_interval_seconds,history_retention_days,remote_history_enabled,remote_history_last_sync_at,auth_method,status,last_error,last_seen_at,sort_order,proxy_use_password,credential_storage_state FROM servers WHERE id=?1",
        [id], |row| {
            let tags: String = row.get(9)?;
            Ok((Server {
                id: row.get(0)?, name: row.get(1)?, location: row.get(2)?, host: row.get(3)?, port: row.get(4)?, username: row.get(5)?,
                ssh_alias: row.get(6)?, identity_file: row.get(7)?, proxy_jump: row.get(8)?, tags: serde_json::from_str(&tags).unwrap_or_default(),
                sampling_interval_seconds: row.get(10)?, history_retention_days: row.get(11)?, remote_history_enabled: row.get(12)?,
                remote_history_last_sync_at: row.get(13)?, auth_method: row.get(14)?, status: row.get(15)?, last_error: row.get(16)?,
                last_seen_at: row.get(17)?, sort_order: row.get(18)?, proxy_use_password: row.get(19)?, save_proxy_password: false,
            }, row.get(20)?))
        }).map_err(|_| "Selected server does not exist or database schema is incompatible")?;
    let proxy_record: Option<(String, String)> = if server.proxy_use_password {
        connection
            .query_row(
                "SELECT proxy_jump,storage_state FROM proxy_credentials WHERE server_id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| "Cannot read proxy credential binding")?
    } else {
        None
    };
    connection
        .execute_batch("ROLLBACK")
        .map_err(|_| "Cannot finish database read")?;
    let target = if server.auth_method == "password" {
        Some(saved_password(
            "com.racktop.desktop",
            id,
            &credential_state,
        )?)
    } else {
        None
    };
    let proxy = if server.proxy_use_password {
        let (address, state) = proxy_record.ok_or("No saved proxy credential binding")?;
        if server.proxy_jump.as_deref() != Some(address.as_str()) {
            return Err("Saved proxy credential belongs to another endpoint".into());
        }
        Some(saved_password("com.racktop.desktop.proxy", id, &state)?)
    } else {
        None
    };
    let passwords = SshPasswords { target, proxy };
    // options() enforces strict known-host verification; the collector preflight
    // additionally checks the same explicit identity path used by the desktop.
    let options = racktop_lib::ssh_connection::options(&server, Some(&passwords), None)?;
    if !options
        .args
        .iter()
        .any(|arg| arg == "StrictHostKeyChecking=yes")
    {
        return Err("SSH strict host checking is unavailable".into());
    }
    Ok(Arc::new(move |requested| {
        if requested != server.id {
            return Err("Probe requested an unselected server".into());
        }
        Ok((server.clone(), passwords.clone()))
    }))
}

fn saved_password(service: &str, id: &str, state: &str) -> Result<String, String> {
    if state != "enabled" {
        return Err(
            "Required SSH credential is not saved and enabled; reconnect in RackTop first".into(),
        );
    }
    keyring::Entry::new(service, id)
        .map_err(|_| "Cannot access SSH credential storage")?
        .get_password()
        .map_err(|_| "Cannot read saved SSH credential; unlock credential storage first".into())
}

fn field(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("Response is missing {key}"))
}
fn ensure(condition: bool, message: &str) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}
fn quiet() -> EventSink {
    Arc::new(|_, _| {})
}

async fn exercise(database: &Path, server_id: &str, token: &str) -> Result<(), String> {
    let context = server_context(database, server_id)?;
    let owner = SharingRuntime::new(ShareStore::memory(Persisted::default()), context, quiet());
    let (event_tx, mut events) = mpsc::channel::<Value>(64);
    let sink: EventSink = Arc::new(move |kind, data| {
        if kind == "sharing-terminal-output" {
            let _ = event_tx.try_send(data);
        }
    });
    let guest = SharingRuntime::new(
        ShareStore::memory(Persisted::default()),
        Arc::new(|_| Err("Guest must never resolve an owner SSH configuration".into())),
        sink,
    );
    let mut share_id = None;
    let result = async {
        owner.configure(identity::TRUSTED_RELAY_URL.into(), token.into()).await?;
        owner.start();
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if owner.status().await?["ownerOnline"] == true { return Ok::<(), String>(()); }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }).await.map_err(|_| "Owner relay polling did not become ready")??;
        println!("PASS public HTTPS owner authentication and rendezvous polling");
        let share = owner.create(server_id.into(), "Disposable sharing probe".into(), 1,
            Capabilities { monitor: true, terminal: true, files: true }, ".".into()).await?;
        let id = field(&share, "id")?;
        share_id = Some(id.clone());
        println!("PASS owner SSH preflight using existing strict host verification");
        let invitation = owner.invite(id.clone(), 10).await?;
        let received = guest.accept(field(&invitation, "code")?, "Disposable runtime guest".into()).await?;
        let resource_id = field(&received, "id")?;
        // Include at least one production keepalive interval before exercising RPC.
        tokio::time::sleep(Duration::from_secs(6)).await;
        let snapshot = guest.snapshot(resource_id.clone()).await?;
        ensure(snapshot["serverId"] == resource_id, "Snapshot did not use guest virtual resource ID")?;
        println!("PASS Runtime → WSS → inner TLS → Runtime monitoring and idle keepalive");
        let terminal = guest.terminal_open(resource_id.clone(), 120, 30).await?;
        let run = uuid::Uuid::new_v4().simple().to_string();
        let mut remote_dir = None;
        let operations = async {
            let begin = format!("RACKTOP_{run}_BEGIN:");
            let end = format!(":RACKTOP_{run}_END");
            let command = format!("stty -echo; RT_PROBE_DIR=$(mktemp -d -- '.racktop-share-probe-{run}.tmp.XXXXXXXX') && printf '\\n%s%s%s\\n' '{begin}' \"$RT_PROBE_DIR\" '{end}'\n");
            guest.terminal_input(resource_id.clone(), terminal.clone(), command).await?;
            let directory = terminal_value(&mut events, &terminal, &begin, &end,
                |value| valid_temp_directory(value, &run)).await?;
            remote_dir = Some(directory.clone());
            let listing = guest.list_files(resource_id.clone(), directory.clone()).await?;
            ensure(listing["entries"].as_array().is_some_and(|e| e.is_empty()), "Fresh probe directory was not empty")?;
            println!("PASS arbitrary terminal command and file directory listing through Runtime");
            file_round_trip(&owner, &id, &directory).await?;
            Ok::<(), String>(())
        }.await;
        let cleanup = if let Some(directory) = remote_dir {
            // Delete only the exact probe file and rmdir the validated mktemp
            // directory. Never recurse or use a caller-supplied remote path.
            let begin = format!("RACKTOP_{run}_CLEAN:");
            let end = format!(":RACKTOP_{run}_DONE");
            let command = format!("rm -f -- '{directory}/probe.bin' && rmdir -- '{directory}' && printf '\\n%s%s%s\\n' '{begin}' 'ok' '{end}'\n");
            let result = async {
                guest.terminal_input(resource_id.clone(), terminal.clone(), command).await?;
                terminal_value(&mut events, &terminal, &begin, &end, |value| value == "ok").await?;
                Ok::<(), String>(())
            }.await;
            if result.is_err() { eprintln!("Probe cleanup incomplete; inspect only remote directory {directory}"); }
            result
        } else { Ok(()) };
        let _ = guest.terminal_close(resource_id.clone(), terminal).await;
        operations?;
        cleanup?;
        guest.forget(resource_id).await?;
        ensure(owner.store.snapshot()?.shares.iter().any(|s| s.id == id), "Guest forgetting resource removed owner's share")?;
        println!("PASS guest removal is local; temporary remote file and directory cleaned");
        Ok::<(), String>(())
    }.await;
    let cleanup = match share_id {
        Some(id) => owner.delete(id).await,
        None => Ok(()),
    };
    guest.shutdown();
    owner.shutdown();
    result?;
    cleanup?;
    println!(
        "PASS disposable shared resources and relay routes revoked; no profile records written"
    );
    Ok(())
}

fn valid_temp_directory(value: &str, run: &str) -> bool {
    value
        .strip_prefix(&format!(".racktop-share-probe-{run}.tmp."))
        .is_some_and(|suffix| {
            suffix.len() == 8 && suffix.bytes().all(|b| b.is_ascii_alphanumeric())
        })
}

async fn terminal_value(
    events: &mut mpsc::Receiver<Value>,
    session: &str,
    begin: &str,
    end: &str,
    validate: impl Fn(&str) -> bool,
) -> Result<String, String> {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut bytes = Vec::new();
        while let Some(value) = events.recv().await {
            if value["sessionId"] != session {
                continue;
            }
            let chunk = STANDARD
                .decode(field(&value, "data")?)
                .map_err(|_| "Invalid terminal event encoding")?;
            if bytes.len() + chunk.len() > 256 * 1024 {
                return Err("Probe terminal output exceeded limit".into());
            }
            bytes.extend(chunk);
            let text = String::from_utf8_lossy(&bytes);
            for (_, tail) in text
                .match_indices(begin)
                .map(|(at, _)| (at, &text[at + begin.len()..]))
            {
                if let Some((value, _)) = tail.split_once(end) {
                    if validate(value) {
                        return Ok(value.into());
                    }
                }
            }
        }
        Err("Terminal event stream closed before marker".into())
    })
    .await
    .map_err(|_| "Terminal marker did not arrive; SSH shell or gateway may be unavailable")?
}

fn options(invite: &Invitation, device: &DeviceIdentity, secret: bool) -> ConnectOptions {
    ConnectOptions {
        relay_url: invite.relay_url.clone(),
        route_id: invite.route_id.clone(),
        route_token: invite.route_token.clone(),
        owner_cert_der: invite.owner_cert_der.clone(),
        device: device.clone(),
        device_name: "Disposable file guest".into(),
        invite_secret: secret.then(|| invite.invite_secret.clone()),
    }
}

async fn file_round_trip(
    owner: &Arc<SharingRuntime>,
    share: &str,
    directory: &str,
) -> Result<(), String> {
    let response = owner.invite(share.into(), 10).await?;
    let invite = identity::decode_invitation(&field(&response, "code")?)?;
    let device = identity::generate_device_identity();
    let (session, info) = ClientSession::connect(options(&invite, &device, true), quiet()).await?;
    let result = transfer_bytes(&session, &format!("{directory}/probe.bin")).await;
    session.close();
    // Give owner-side worker EOF cleanup a chance to complete even on failure.
    tokio::time::sleep(Duration::from_secs(1)).await;
    result?;
    let (session, restored) =
        ClientSession::connect(options(&invite, &device, false), quiet()).await?;
    ensure(
        restored.member_id == info.member_id,
        "Reconnect created a different device grant",
    )?;
    let result = async {
        session.request("session.ping", json!({})).await?;
        println!("PASS reconnect reuses device grant without a new invitation");
        owner.revoke_member(share.into(), info.member_id).await?;
        tokio::time::timeout(Duration::from_secs(5), async {
            while session.is_alive() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .map_err(|_| "Revocation did not close existing device session")?;
        ensure(
            session
                .request("files.list", json!({"path": "."}))
                .await
                .is_err(),
            "Revoked device can still send RPC",
        )?;
        match ClientSession::connect(options(&invite, &device, false), quiet()).await {
            Ok((unexpected, _)) => {
                unexpected.close();
                return Err("Revoked device reconnected".into());
            }
            Err(_) => {}
        }
        println!("PASS revocation closes active session and rejects reconnect");
        Ok::<(), String>(())
    }
    .await;
    session.close();
    result
}

async fn transfer_bytes(session: &ClientSession, path: &str) -> Result<(), String> {
    let data: Vec<u8> = (0..(256 * 1024 + 37))
        .map(|n| ((n * 17 + n / 251) % 256) as u8)
        .collect();
    let expected = format!("{:x}", Sha256::digest(&data));
    let opened = session
        .request(
            "files.write_open",
            json!({"path": path, "size": data.len(), "sha256": expected}),
        )
        .await?;
    let transfer = field(&opened, "transferId")?;
    ensure(
        opened["maxChunkBytes"] == 48 * 1024,
        "Unexpected upload chunk limit",
    )?;
    let mut offset = 0;
    for chunk in data.chunks(48 * 1024) {
        let response = session.request("files.write_chunk", json!({"transferId": transfer, "offset": offset, "dataBase64": STANDARD.encode(chunk)})).await?;
        offset += chunk.len();
        ensure(response["nextOffset"] == offset, "Upload offset mismatch")?;
    }
    let committed = session
        .request(
            "files.write_commit",
            json!({"transferId": transfer, "sha256": expected}),
        )
        .await?;
    ensure(
        committed["sha256"] == expected && committed["size"] == data.len(),
        "Upload integrity mismatch",
    )?;
    let opened = session
        .request("files.read_open", json!({"path": path}))
        .await?;
    ensure(opened["size"] == data.len(), "Download size mismatch")?;
    let transfer = field(&opened, "transferId")?;
    let mut downloaded = Vec::new();
    while downloaded.len() < data.len() {
        let response = session
            .request(
                "files.read_chunk",
                json!({"transferId": transfer, "offset": downloaded.len(), "maxBytes": 48 * 1024}),
            )
            .await?;
        let chunk = STANDARD
            .decode(field(&response, "dataBase64")?)
            .map_err(|_| "Invalid download encoding")?;
        ensure(
            !chunk.is_empty()
                && chunk.len() <= 48 * 1024
                && downloaded.len() + chunk.len() <= data.len(),
            "Invalid download chunk length",
        )?;
        downloaded.extend(chunk);
        ensure(
            response["nextOffset"] == downloaded.len()
                && response["eof"] == (downloaded.len() == data.len()),
            "Download offset mismatch",
        )?;
    }
    let closed = session
        .request("files.read_close", json!({"transferId": transfer}))
        .await?;
    ensure(
        downloaded == data
            && format!("{:x}", Sha256::digest(&downloaded)) == expected
            && closed["sha256"] == expected,
        "Download SHA-256 mismatch",
    )?;
    println!(
        "PASS upload/commit/download: {} bytes, 48 KiB chunks, matching SHA-256",
        data.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modes_are_explicit_and_never_accept_cli_credentials() {
        assert!(parse_args(&["--configure-profile".into(), "/tmp/profile".into()]).is_ok());
        assert!(
            parse_args(&[
                "--database".into(),
                "/tmp/db".into(),
                "--server-id".into(),
                "fixture".into()
            ])
            .is_ok()
        );
        assert!(parse_args(&["--token".into(), "secret".into()]).is_err());
        assert!(parse_args(&[]).is_err());
    }
    #[test]
    fn cleanup_accepts_only_the_current_mktemp_directory() {
        assert!(valid_temp_directory(
            ".racktop-share-probe-run.tmp.Abc019XY",
            "run"
        ));
        for path in [
            ".",
            "..",
            "/tmp",
            "other",
            ".racktop-share-probe-other.tmp.Abc019XY",
            ".racktop-share-probe-run.tmp.Abc0/9XY",
            ".racktop-share-probe-run.tmp.Abc019XY/..",
        ] {
            assert!(!valid_temp_directory(path, "run"));
        }
    }
    #[tokio::test]
    async fn terminal_markers_survive_frame_splitting_and_ignore_command_echo() {
        let (tx, mut rx) = mpsc::channel(4);
        for data in ["echo 'BEGIN' '$value' 'END'\r\nBE", "GIN.safe.dirEND\r\n"] {
            tx.send(json!({"sessionId": "s", "data": STANDARD.encode(data)}))
                .await
                .unwrap();
        }
        assert_eq!(
            terminal_value(&mut rx, "s", "BEGIN", "END", |value| value == ".safe.dir")
                .await
                .unwrap(),
            ".safe.dir"
        );
    }
}
