use racktop_lib::{collector, models::{Server, Snapshot}};

#[tokio::main]
async fn main() {
    let targets: Vec<String> = std::env::args().skip(1).collect();
    if targets.first().map(String::as_str) == Some("--racktop-ssh-proxy") {
        if let Err(error) = racktop_lib::ssh_connection::run_proxy(&targets[1..]) { eprintln!("{error}"); std::process::exit(1); }
        return;
    }
    if targets.first().map(String::as_str) == Some("--managed-directory-fixture") {
        match racktop_lib::managed_servers::exercise_directory_fixture(targets.get(1).map(String::as_str).unwrap_or("")).await {
            Ok(result) => println!("{result}"), Err(error) => { eprintln!("{error}"); std::process::exit(1); }
        }
        return;
    }
    if targets.first().map(String::as_str) == Some("--managed-credentials-fixture") {
        match racktop_lib::team::exercise_credentials_fixture(targets.get(1).map(String::as_str).unwrap_or("")).await {
            Ok(result) => println!("{result}"), Err(error) => { eprintln!("{error}"); std::process::exit(1); }
        }
        return;
    }
    if let Ok(password) = std::env::var("RACKTOP_ASKPASS_PASSWORD") { print!("{password}"); return; }
    if targets.first().map(String::as_str) == Some("--password-test") {
        if let Err(error) = password_test().await { eprintln!("{error}"); std::process::exit(1); }
        return;
    }
    #[cfg(target_os = "linux")]
    if targets.first().map(String::as_str) == Some("--download-update-test") {
        if let Err(error) = download_update_test(&targets[1..]).await { eprintln!("{error}"); std::process::exit(1); }
        return;
    }
    #[cfg(target_os = "linux")]
    if targets.first().map(String::as_str) == Some("--verify-flatpak-bundle") {
        let result = (|| {
            let bytes = std::fs::read(targets.get(1).ok_or("missing package")?).map_err(|e| e.to_string())?;
            if let Some(signature) = targets.get(3) {
                racktop_lib::linux_update::verify_package_signature(&bytes, &std::fs::read_to_string(signature).map_err(|e| e.to_string())?)?;
            }
            let bundle = racktop_lib::flatpak_update::validate_bundle(&bytes, targets.get(2).ok_or("missing version")?)?;
            Ok::<_, String>(serde_json::json!({"version": bundle.version, "commit": bundle.commit}))
        })();
        match result { Ok(info) => println!("{info}"), Err(error) => { eprintln!("{error}"); std::process::exit(1); } }
        return;
    }
    #[cfg(target_os = "linux")]
    if targets.first().map(String::as_str) == Some("--flatpak-install-fixture") {
        let result = async {
            // This integration-only command may install solely in the Focal
            // test container's explicit /flatpak-user mount, never a host profile.
            let info = std::fs::read_to_string("/.flatpak-info").map_err(|e| e.to_string())?;
            if !info.lines().any(|line| line.starts_with("app-path=/flatpak-user/app/")) {
                return Err("fixture installation requires isolated /flatpak-user deployment".into());
            }
            let source = targets.get(1).ok_or("missing fixture bundle")?;
            let version = targets.get(2).ok_or("missing fixture version")?;
            let bytes = std::fs::read(source).map_err(|e| e.to_string())?;
            let bundle = racktop_lib::flatpak_update::validate_bundle(&bytes, version)?;
            let installation = racktop_lib::flatpak_update::detect().await?;
            let previous = installation.before_update(version).await?;
            let directory = installation.temporary_directory()?;
            let package = directory.path().join("fixture.flatpak");
            std::fs::write(&package, bytes).map_err(|e| e.to_string())?;
            installation.install(&package, &bundle, &previous).await?;
            installation.relaunch(&bundle).await?;
            Ok::<_, String>(serde_json::json!({"version": bundle.version, "commit": bundle.commit, "scope": installation.scope.argument(), "installedAndRelaunched": true}))
        }.await;
        match result { Ok(info) => println!("{info}"), Err(error) => { eprintln!("{error}"); std::process::exit(1); } }
        return;
    }
    #[cfg(target_os = "linux")]
    if targets.first().map(String::as_str) == Some("--verify-update-files") {
        let result = async {
            let package = std::path::Path::new(targets.get(1).ok_or("missing package")?);
            let signature = std::fs::read_to_string(targets.get(2).ok_or("missing signature")?).map_err(|e| e.to_string())?;
            racktop_lib::linux_update::verify_package_signature(&std::fs::read(package).map_err(|e| e.to_string())?, &signature)?;
            racktop_lib::linux_update::validate_deb(package, targets.get(3).map(String::as_str).unwrap_or(env!("CARGO_PKG_VERSION"))).await?;
            Ok::<(), String>(())
        }.await;
        if let Err(error) = result { eprintln!("{error}"); std::process::exit(1); }
        println!("Linux update signature and package metadata verified");
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
        let server = Server { managed: None,
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

/// A loopback-only download fixture; this binary is never bundled in RackTop.
#[cfg(target_os = "linux")]
async fn download_update_test(args: &[String]) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let endpoint = args.first().ok_or("missing endpoint")?;
    if !endpoint.starts_with("http://127.0.0.1:") { return Err("test endpoint must use loopback".into()); }
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.package_info_mut().version = args.get(1).ok_or("missing current version")?.parse().map_err(|e: semver::Error| e.to_string())?;
    // Optional disposable public key is only accepted by this integration-only,
    // loopback-restricted probe. Production always embeds the release public key.
    let test_public_key = args.get(3).map(std::fs::read_to_string).transpose().map_err(|e| e.to_string())?;
    context.config_mut().plugins.0.insert("updater".into(), serde_json::json!({
        "pubkey": test_public_key.as_deref().unwrap_or(include_str!("../../linux-updater.pub")).trim(),
        "dangerousInsecureTransportProtocol": true
    }));
    let app = tauri::test::mock_builder().plugin(tauri_plugin_updater::Builder::new().build()).build(context).map_err(|e| e.to_string())?;
    let flatpak = args.get(2).map(String::as_str) == Some("flatpak");
    let updater = app.updater_builder().target(if flatpak { "linux-x86_64-flatpak" } else { "linux-x86_64-deb" }).no_proxy()
        .endpoints(vec![endpoint.parse().map_err(|_| "invalid endpoint")?]).map_err(|e| e.to_string())?
        .timeout(std::time::Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else { println!("no update"); return Ok(()); };
    if update.download_url.host_str() != Some("127.0.0.1") { return Err("test download must use loopback".into()); }
    let mut received = 0;
    let bytes = update.download(|length, _| received += length, || {}).await.map_err(|e| e.to_string())?;
    if bytes.len() != received || received == 0 { return Err("download progress mismatch".into()); }
    let directory = tempfile::tempdir().map_err(|e| e.to_string())?;
    if flatpak {
        let bundle = racktop_lib::flatpak_update::validate_bundle(&bytes, &update.version)?;
        if update.raw_json["platforms"]["linux-x86_64-flatpak"]["commit"].as_str() != Some(bundle.commit.as_str()) { return Err("Flatpak manifest commit mismatch".into()); }
        println!("verified update {}: {received} bytes", update.version);
        return Ok(());
    }
    let path = directory.path().join("update.deb");
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    racktop_lib::linux_update::validate_deb(&path, &update.version).await?;
    println!("verified update {}: {received} bytes", update.version);
    Ok(())
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
