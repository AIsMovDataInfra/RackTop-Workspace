//! Disposable loopback-only integration runner. Credentials enter only stdin.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use racktop_lib::{collector, host_key, models::Server, sharing::operations::{GatewayOps, OperationScope}, ssh_connection::SshPasswords};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io::Read, time::Duration};

fn endpoint(value: &Value) -> Result<(Server, SshPasswords), String> {
    let server: Server = serde_json::from_value(value["server"].clone()).map_err(|_| "invalid synthetic server")?;
    if server.host != "127.0.0.1" || server.username != "tester" || server.ssh_alias.is_some() || server.identity_file.is_some() {
        return Err("fixture permits only explicit loopback test endpoints".into());
    }
    if let Some(proxy) = &server.proxy_jump {
        let jump = racktop_lib::ssh_connection::parse_jump(proxy)?;
        if jump.host != "127.0.0.1" || jump.username != "tester" { return Err("fixture permits only loopback jumps".into()); }
    }
    let passwords = SshPasswords { target: value["targetPassword"].as_str().map(str::to_owned), proxy: value["proxyPassword"].as_str().map(str::to_owned) };
    Ok((server, passwords))
}

fn fixture_root(input: &Value) -> Result<std::path::PathBuf, String> {
    let raw = input["fixtureRoot"].as_str().ok_or("missing disposable fixture root")?;
    let root = std::path::Path::new(raw).canonicalize().map_err(|_| "fixture root unavailable")?;
    let temporary = std::env::temp_dir().canonicalize().map_err(|_| "temporary directory unavailable")?;
    let name = root.file_name().and_then(|value| value.to_str()).ok_or("invalid fixture directory")?;
    let suffix = name.strip_prefix("racktop-ssh-hardening-").ok_or("invalid fixture directory")?;
    if root.parent() != Some(temporary.as_path()) || suffix.len() < 6 || !suffix.bytes().all(|value| value.is_ascii_alphanumeric() || b"_-".contains(&value)) {
        return Err("fixture must use a freshly allocated temporary directory".into());
    }
    let expected = input["fixtureId"].as_str().ok_or("missing fixture identity")?;
    if expected.len() != 32 || !expected.bytes().all(|value| value.is_ascii_hexdigit())
        || std::fs::read_to_string(root.join(".fixture-id")).map_err(|_| "fixture identity unavailable")? != expected {
        return Err("fixture identity mismatch".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::metadata(&root).map_err(|_| "fixture metadata unavailable")?.permissions().mode() & 0o777 != 0o700 {
            return Err("fixture directory must be private".into());
        }
    }
    Ok(root)
}

async fn files(server: Server, passwords: SshPasswords, root: &str, fixture: &std::path::Path) -> Result<(), String> {
    let root = std::path::Path::new(root);
    let resolved = root.canonicalize().map_err(|_| "file fixture root unavailable")?;
    if !root.is_absolute() || !resolved.is_dir() || resolved.parent() != Some(fixture) { return Err("file root must be an immediate child of this fixture directory".into()); }
    let scope = OperationScope { peer_id: "synthetic-peer".into(), share_id: "synthetic-share".into() };
    let (events, _receiver) = tokio::sync::mpsc::channel(32);
    let gateway = GatewayOps::new(server, passwords, scope.clone(), root.to_str().unwrap().into(), events)?;
    let operation = async {
        let data: Vec<u8> = (0..100_123).map(|i| (i % 251) as u8).collect();
        let digest = format!("{:x}", Sha256::digest(&data));
        let result = gateway.handle(&scope, "files.write_open", &json!({"path":"round-trip.bin","size":data.len()})).await?;
        let id = result["transferId"].as_str().ok_or("missing upload handle")?;
        for (index, chunk) in data.chunks(48 * 1024).enumerate() {
            let offset = index * 48 * 1024;
            let result = gateway.handle(&scope, "files.write_chunk", &json!({"transferId":id,"offset":offset,"dataBase64":STANDARD.encode(chunk)})).await?;
            if result["nextOffset"] != json!(offset + chunk.len()) { return Err("upload offset mismatch".into()); }
        }
        let result = gateway.handle(&scope, "files.write_commit", &json!({"transferId":id,"sha256":digest})).await?;
        if result["sha256"] != digest { return Err("upload hash mismatch".into()); }
        let result = gateway.handle(&scope, "files.read_open", &json!({"path":"round-trip.bin"})).await?;
        let id = result["transferId"].as_str().ok_or("missing download handle")?;
        let mut read = Vec::new();
        loop {
            let result = gateway.handle(&scope, "files.read_chunk", &json!({"transferId":id,"offset":read.len(),"maxBytes":48 * 1024})).await?;
            read.extend(STANDARD.decode(result["dataBase64"].as_str().ok_or("missing download data")?).map_err(|_| "invalid download data")?);
            if result["eof"] == true { break; }
            if read.len() > data.len() { return Err("oversized download".into()); }
        }
        let result = gateway.handle(&scope, "files.read_close", &json!({"transferId":id})).await?;
        if result["sha256"] != digest || read != data { return Err("file round trip mismatch".into()); }
        let wrong_scope = OperationScope { peer_id: "unrelated-peer".into(), share_id: scope.share_id.clone() };
        if gateway.handle(&wrong_scope, "files.list", &json!({"path":"."})).await.is_ok() { return Err("wrong scope accepted".into()); }
        if gateway.handle(&scope, "files.read_open", &json!({"path":"../outside"})).await.is_ok() { return Err("path escaped fixture root".into()); }
        Ok(())
    }.await;
    gateway.cleanup_scope(&scope).await?;
    operation
}

async fn exercise(input: Value) -> Result<Value, String> {
    let fixture = fixture_root(&input)?;
    let action = input["action"].as_str().ok_or("missing action")?;
    let (server, passwords) = endpoint(&input)?;
    match action {
        "collect" => {
            let snapshot = collector::collect_with_password(&server, Some(&passwords), true, false).await?;
            if snapshot.status != "online" || snapshot.gpus.len() != 1 { return Err("invalid collection result".into()); }
        }
        "terminal" => {
            if !racktop_lib::password_terminal_probe(&server, Some(&passwords))?.contains("racktop-terminal-ok") { return Err("PTY did not return fixture marker".into()); }
        }
        "scan" => {
            let info = host_key::scan_with_passwords(&server, Some(&passwords)).await?;
            if info.is_proxy || info.fingerprint.is_empty() { return Err("expected target host fingerprint".into()); }
        }
        "files" => files(server, passwords, input["root"].as_str().ok_or("missing file root")?, &fixture).await?,
        "cancel" => {
            let result = tokio::time::timeout(Duration::from_millis(180), collector::collect_with_password(&server, Some(&passwords), true, false)).await;
            if result.is_ok() { return Err("slow fixture unexpectedly completed before cancellation".into()); }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        "concurrent" => {
            let mut tasks = tokio::task::JoinSet::new();
            for entry in input["endpoints"].as_array().ok_or("missing concurrent endpoints")? {
                let (server, passwords) = endpoint(entry)?;
                tasks.spawn(async move {
                    let snapshot = collector::collect_with_password(&server, Some(&passwords), true, false).await?;
                    if snapshot.status != "online" { return Err("concurrent collection failed".into()); }
                    Ok::<_, String>(())
                });
            }
            while let Some(result) = tasks.join_next().await { result.map_err(|_| "concurrent task aborted")??; }
        }
        _ => return Err("unknown synthetic action".into()),
    }
    Ok(json!({"action": action, "passed": true}))
}

#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--racktop-ssh-proxy") {
        if racktop_lib::ssh_connection::run_proxy(&args[1..]).is_err() { std::process::exit(1); }
        return;
    }
    if let Some(result) = racktop_lib::askpass::run_helper() { if result.is_err() { std::process::exit(1); } return; }
    if !args.is_empty() { std::process::exit(2); }
    let result = async {
        let mut input = String::new();
        std::io::stdin().take(128 * 1024).read_to_string(&mut input).map_err(|_| "fixture input unavailable")?;
        exercise(serde_json::from_str(&input).map_err(|_| "invalid fixture input")?).await
    }.await;
    match result {
        Ok(value) => println!("{value}"),
        Err(_) => { eprintln!("Synthetic SSH operation rejected or failed"); std::process::exit(1); }
    }
}
