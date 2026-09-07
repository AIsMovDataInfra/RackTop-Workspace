use racktop_lib::{collector, models::{Server, Snapshot}};

#[tokio::main]
async fn main() {
    let targets: Vec<String> = std::env::args().skip(1).collect();
    if targets.first().map(String::as_str) == Some("--racktop-ssh-proxy") {
        if let Err(error) = racktop_lib::ssh_connection::run_proxy(&targets[1..]) { eprintln!("{error}"); std::process::exit(1); }
        return;
    }
    if let Ok(password) = std::env::var("RACKTOP_ASKPASS_PASSWORD") { print!("{password}"); return; }
    if targets.first().map(String::as_str) == Some("--password-test") {
        if let Err(error) = password_test().await { eprintln!("{error}"); std::process::exit(1); }
        return;
    }
    let targets = if targets.is_empty() {
        vec!["tongzh@10.201.37.233".into(), "tongzh@10.201.127.132".into()]
    } else {
        targets
    };
    let mut tasks = tokio::task::JoinSet::new();
    for (index, target) in targets.into_iter().enumerate() {
        let (username, host) = target.split_once('@').unwrap_or(("tongzh", target.as_str()));
        let server = Server {
            id: format!("probe-{index}"), name: target.clone(), location: None, host: host.into(), port: 22, username: username.into(),
            ssh_alias: None, identity_file: None, proxy_jump: None, proxy_use_password: false, save_proxy_password: false, tags: vec!["integration-test".into()],
            sampling_interval_seconds: 2, history_retention_days: 1, remote_history_enabled: false, remote_history_last_sync_at: None, sort_order: index as i64, auth_method: "sshAgent".into(),
            status: "unknown".into(), last_error: None, last_seen_at: None,
        };
        tasks.spawn(async move { (target, collector::collect(&server).await) });
    }
    let mut snapshots: Vec<Snapshot> = Vec::new();
    let mut failures = Vec::new();
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok((_target, Ok(snapshot))) => snapshots.push(snapshot),
            Ok((target, Err(error))) => failures.push(format!("{target}: {error}")),
            Err(error) => failures.push(format!("采集任务异常：{error}")),
        }
    }
    snapshots.sort_by(|left, right| left.server_id.cmp(&right.server_id));
    println!("{}", serde_json::to_string_pretty(&snapshots).expect("serialize snapshots"));
    if !failures.is_empty() {
        eprintln!("{}", failures.join("\n"));
        std::process::exit(1);
    }
}


#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasswordTest {
    database: std::path::PathBuf,
    draft: Option<racktop_lib::models::ServerDraft>,
    server_id: Option<String>,
    action: String,
    trusted_fingerprint: Option<String>,
}

async fn password_test() -> Result<(), String> {
    use std::io::Read;
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).map_err(|e| e.to_string())?;
    let test: PasswordTest = serde_json::from_str(&input).map_err(|e| e.to_string())?;
    let database = racktop_lib::storage::Database::open(&test.database)?;
    let server = match test.draft { Some(draft) => database.save_server(draft)?, None => database.get_server(test.server_id.as_deref().ok_or("missing server id")?)? };
    let passwords = database.get_ssh_passwords(&server, true)?;
    match test.action.as_str() {
        "scan" | "trust" => {
            let info = racktop_lib::host_key::scan_with_passwords(&server, passwords.as_ref()).await?;
            if test.action == "trust" {
                if test.trusted_fingerprint.as_deref() != Some(&info.fingerprint) { return Err("test fingerprint does not match fixture".into()); }
                racktop_lib::host_key::trust(&server, &info)?;
            }
            println!("{}", serde_json::to_string(&info).unwrap());
        }
        "collect" => {
            let result = collector::collect_with_password(&server, passwords.as_ref(), true, false).await?;
            println!("{}", serde_json::to_string(&result).unwrap());
        }
        "terminal" => println!("{}", racktop_lib::password_terminal_probe(&server, passwords.as_ref())?),
        "credentials" => {
            let passwords = passwords.unwrap_or_default();
            // Assertions use disposable fixture passwords supplied independently.
            if passwords.target.as_deref() != std::env::var("RACKTOP_TEST_EXPECT_TARGET").ok().as_deref() || passwords.proxy.as_deref() != std::env::var("RACKTOP_TEST_EXPECT_PROXY").ok().as_deref() { return Err("credential round trip failed".into()); }
            println!("credential round trip passed");
        }
        "delete" => {
            database.delete_server(&server.id)?;
            for service in ["com.racktop.desktop", "com.racktop.desktop.proxy"] {
                if !matches!(keyring::Entry::new(service, &server.id).map_err(|e| e.to_string())?.get_password(), Err(keyring::Error::NoEntry)) { return Err("deleted credential still exists".into()); }
            }
            println!("deleted credentials verified");
        }
        _ => return Err("unknown test action".into()),
    }
    Ok(())
}
