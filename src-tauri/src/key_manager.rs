//! Local SSH identities. Only public material and paths cross the command boundary.
use crate::models::Server;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

static KEY_OPERATIONS: Mutex<()> = Mutex::new(());
const MAX_PUBLIC_BYTES: u64 = 32 * 1024;
const MAX_REGISTRY_BYTES: u64 = 1024 * 1024;
const KEYGEN_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyInfo {
    pub id: String,
    pub name: String,
    pub public_key: String,
    pub public_key_path: Option<String>,
    pub private_key_path: Option<String>,
    pub algorithm: String,
    pub fingerprint: String,
    pub source: String,
    pub warning: Option<String>,
    pub used_by: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyRecord {
    path: PathBuf,
    name: String,
    source: String,
    hidden: bool,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    version: u32,
    keys: BTreeMap<String, KeyRecord>,
}

struct KeyManager {
    home: PathBuf,
    ssh: PathBuf,
    root: PathBuf,
}

pub fn list(servers: &[Server]) -> Result<Vec<SshKeyInfo>, String> {
    with_manager(|manager| manager.list(servers))
}

pub fn generate(name: String, algorithm: String, passphrase: String) -> Result<SshKeyInfo, String> {
    with_manager(|manager| manager.generate(&name, &algorithm, &passphrase))
}

pub fn import(path: String, name: Option<String>, servers: &[Server]) -> Result<SshKeyInfo, String> {
    with_manager(|manager| manager.import(&path, name.as_deref(), servers))
}

pub fn rename(id: String, name: String, servers: &[Server]) -> Result<(), String> {
    with_manager(|manager| manager.update(&id, Some(&name), false, servers))
}

pub fn forget(id: String, servers: &[Server]) -> Result<(), String> {
    with_manager(|manager| manager.update(&id, None, true, servers))
}

fn with_manager<T>(operation: impl FnOnce(KeyManager) -> Result<T, String>) -> Result<T, String> {
    let _lock = KEY_OPERATIONS.lock().map_err(|_| "密钥管理器暂时不可用，请重启 RackTop".to_string())?;
    let home = dirs::home_dir().ok_or("无法定位用户主目录")?;
    operation(KeyManager::new(home))
}

impl KeyManager {
    fn new(home: PathBuf) -> Self {
        let ssh = home.join(".ssh");
        let root = ssh.join("racktop");
        Self { home, ssh, root }
    }

    fn registry_path(&self) -> PathBuf { self.root.join("keys.json") }

    fn load_registry(&self) -> Result<Registry, String> {
        let path = self.registry_path();
        if !path_exists(&path)? { return Ok(Registry { version: 1, ..Registry::default() }); }
        let bytes = read_regular(&path, MAX_REGISTRY_BYTES)?;
        let registry: Registry = serde_json::from_slice(&bytes)
            .map_err(|_| "密钥目录 keys.json 已损坏；为保留原数据，RackTop 不会覆盖它。请修复或备份后移开该文件".to_string())?;
        if registry.version != 1 { return Err("密钥目录版本不受支持，未修改原文件".into()); }
        for (id, record) in &registry.keys {
            validate_absolute_path(&record.path)?;
            if id != &key_id(&record.path) || !matches!(record.source.as_str(), "discovered" | "generated" | "imported") {
                return Err("密钥目录包含无效记录，未修改原文件".into());
            }
            validate_name(&record.name)?;
        }
        Ok(registry)
    }

    fn lock_registry(&self) -> Result<File, String> {
        ensure_private_directory(&self.ssh)?;
        ensure_private_directory(&self.root)?;
        let path = self.root.join("keys.lock");
        reject_symlinks(&path)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let file = options.open(&path).map_err(|_| "无法锁定密钥目录".to_string())?;
        if !file.metadata().map_err(|_| "无法检查密钥目录锁")?.is_file() {
            return Err("密钥目录锁不是普通文件".into());
        }
        let started = Instant::now();
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(file),
                Err(std::fs::TryLockError::WouldBlock) if started.elapsed() < Duration::from_secs(5) => std::thread::sleep(Duration::from_millis(25)),
                _ => return Err("另一个 RackTop 正在修改密钥目录，请稍后重试".into()),
            }
        }
    }

    fn save_registry(&self, registry: &Registry) -> Result<(), String> {
        let path = self.registry_path();
        reject_symlinks(&path)?;
        let bytes = serde_json::to_vec_pretty(registry).map_err(|_| "无法保存密钥目录")?;
        if bytes.len() as u64 > MAX_REGISTRY_BYTES { return Err("密钥目录已达到大小上限".into()); }
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root).map_err(|_| "无法写入密钥目录")?;
        set_private_permissions(temporary.path())?;
        temporary.write_all(&bytes).and_then(|_| temporary.as_file().sync_all()).map_err(|_| "无法写入密钥目录")?;
        temporary.persist(&path).map_err(|_| "无法原子保存密钥目录，原文件未被截断")?;
        #[cfg(unix)] File::open(&self.root).and_then(|file| file.sync_all()).map_err(|_| "无法同步密钥目录")?;
        Ok(())
    }

    fn expand_path(&self, value: &str) -> Result<PathBuf, String> {
        let value = value.trim();
        if value.is_empty() || value.chars().any(char::is_control) { return Err("请输入有效的密钥绝对路径".into()); }
        let path = if let Some(relative) = value.strip_prefix("~/").or_else(|| value.strip_prefix("~\\")) {
            self.home.join(relative)
        } else { PathBuf::from(value) };
        validate_absolute_path(&path)?;
        Ok(path.components().collect())
    }

    fn candidates(&self, registry: &Registry, servers: &[Server]) -> Result<BTreeMap<String, KeyRecord>, String> {
        let mut candidates = BTreeMap::new();
        if path_exists(&self.ssh)? {
            reject_symlinks(&self.ssh)?;
            for entry in fs::read_dir(&self.ssh).map_err(|_| "无法读取 ~/.ssh 目录")? {
                let entry = entry.map_err(|_| "无法读取 ~/.ssh 中的文件")?;
                let path = entry.path();
                if path.extension() == Some(OsStr::new("pub")) {
                    insert_discovered(&mut candidates, path);
                } else if looks_like_private_key(&path) {
                    insert_discovered(&mut candidates, path);
                }
            }
        }
        for server in servers {
            if let Some(value) = server.identity_file.as_deref() {
                if let Ok(path) = self.expand_path(value) { insert_discovered(&mut candidates, path); }
            }
        }
        candidates.extend(registry.keys.clone());
        Ok(candidates)
    }

    fn list(&self, servers: &[Server]) -> Result<Vec<SshKeyInfo>, String> {
        let registry = self.load_registry()?;
        let mut keys: Vec<_> = self.candidates(&registry, servers)?.into_iter()
            .filter(|(_, record)| !record.hidden)
            .map(|(id, record)| self.inspect_or_warning(id, record, servers)).collect();
        keys.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()).then(left.id.cmp(&right.id)));
        Ok(keys)
    }

    fn inspect_or_warning(&self, id: String, record: KeyRecord, servers: &[Server]) -> SshKeyInfo {
        match self.inspect(&record, servers) {
            Ok(key) => key,
            Err(error) => SshKeyInfo {
                id, name: record.name, public_key: String::new(),
                public_key_path: is_public_path(&record.path).then(|| display_path(&record.path)),
                private_key_path: (!is_public_path(&record.path) && looks_like_private_key(&record.path)).then(|| display_path(&record.path)),
                algorithm: "未知".into(), fingerprint: String::new(), source: record.source,
                warning: Some(error), used_by: self.used_by(&record.path, servers),
            },
        }
    }

    fn used_by(&self, path: &Path, servers: &[Server]) -> Vec<String> {
        let id = key_id(path);
        let mut names: Vec<_> = servers.iter().filter(|server| server.identity_file.as_deref()
            .and_then(|value| self.expand_path(value).ok()).is_some_and(|identity| key_id(&identity) == id))
            .map(|server| server.name.clone()).collect();
        names.sort(); names.dedup(); names
    }

    fn inspect(&self, record: &KeyRecord, servers: &[Server]) -> Result<SshKeyInfo, String> {
        reject_symlinks(&record.path)?;
        let private = if is_public_path(&record.path) { record.path.with_extension("") } else { record.path.clone() };
        let public = public_path(&private);
        let has_private = path_exists(&private)?;
        if has_private { check_regular(&private, 4 * 1024 * 1024)?; }
        let has_public = path_exists(&public)?;
        let public_text = if has_public {
            String::from_utf8(read_regular(&public, MAX_PUBLIC_BYTES)?).map_err(|_| "公钥文件不是 UTF-8 文本")?
        } else if has_private { derive_public(&private)? } else { return Err("密钥文件已不存在，请检查路径或移出列表".into()); };
        let (public_key, algorithm, fingerprint) = validate_public(&public_text)?;
        let mut warning = None;
        let mut usable_private = has_private && looks_like_private_key(&private);
        if has_private && has_public {
            if !usable_private {
                warning = Some("同名私钥的格式无法识别，请检查私钥文件".into());
            } else { match derive_public(&private) {
                Ok(derived) => {
                    let (_, _, private_fingerprint) = validate_public(&derived)?;
                    if private_fingerprint != fingerprint {
                        usable_private = false;
                        warning = Some("同名公钥与私钥不匹配，请核对文件；暂不能用这对文件连接服务器".into());
                    }
                }
                Err(_) => warning = Some("私钥可能已加密；尚未验证它与公钥是否匹配".into()),
            } }
        }
        #[cfg(unix)] if has_private {
            use std::os::unix::fs::PermissionsExt;
            if fs::metadata(&private).map_err(|_| "无法检查私钥权限")?.permissions().mode() & 0o077 != 0 {
                append_warning(&mut warning, "私钥权限过宽，建议将权限设为 600");
            }
        }
        Ok(SshKeyInfo {
            id: key_id(&record.path), name: record.name.clone(), public_key,
            public_key_path: has_public.then(|| display_path(&public)),
            private_key_path: usable_private.then(|| display_path(&private)),
            algorithm, fingerprint, source: record.source.clone(), warning,
            used_by: self.used_by(&record.path, servers),
        })
    }

    fn generate(&self, name: &str, algorithm: &str, passphrase: &str) -> Result<SshKeyInfo, String> {
        let name = validate_name(name)?;
        if !matches!(algorithm, "ed25519" | "rsa4096") { return Err("请选择 Ed25519 或 RSA 4096".into()); }
        if passphrase.len() > 1024 || passphrase.chars().any(char::is_control) {
            return Err("密码不能含换行或控制字符，且最长为 1024 字节".into());
        }
        let _lock = self.lock_registry()?;
        let mut registry = self.load_registry()?;
        let keys = self.root.join("keys");
        ensure_private_directory(&keys)?;
        let directory = tempfile::Builder::new().prefix("key-").tempdir_in(&keys).map_err(|_| "无法创建密钥目录")?;
        set_directory_permissions(directory.path())?;
        let key_type = if algorithm == "rsa4096" { "rsa" } else { "ed25519" };
        let private = directory.path().join(format!("id_{key_type}"));
        if path_exists(&private)? || path_exists(&public_path(&private))? { return Err("目标密钥文件已存在，未覆盖文件".into()); }
        let mut args = vec![OsString::from("-q"), OsString::from("-t"), OsString::from(key_type)];
        if key_type == "rsa" { args.extend([OsString::from("-b"), OsString::from("4096")]); }
        args.extend([OsString::from("-C"), OsString::from(&name), OsString::from("-f"), private.as_os_str().to_owned()]);
        // No -N argument: passphrases are delivered through an anonymous pipe only.
        let mut input = format!("{passphrase}\n{passphrase}\n").into_bytes();
        let outcome = run_keygen(&args, &input);
        input.fill(0);
        outcome.map_err(|error| format!("无法生成密钥：{error}"))?;
        set_private_permissions(&private)?;
        let record = KeyRecord { path: private, name, source: "generated".into(), hidden: false };
        let mut info = self.inspect(&record, &[])?;
        // Both files were created together in an exclusive directory by this process.
        info.warning = None;
        registry.keys.insert(info.id.clone(), record);
        self.save_registry(&registry)?;
        let _ = directory.keep();
        Ok(info)
    }

    fn import(&self, value: &str, name: Option<&str>, servers: &[Server]) -> Result<SshKeyInfo, String> {
        let path = self.expand_path(value)?;
        check_regular(&path, 4 * 1024 * 1024)?;
        let name = validate_name(name.unwrap_or_else(|| path.file_name().and_then(OsStr::to_str).unwrap_or("SSH 密钥")))?;
        let _lock = self.lock_registry()?;
        let mut registry = self.load_registry()?;
        let id = key_id(&path);
        let source = registry.keys.get(&id).filter(|record| record.source == "generated")
            .map(|record| record.source.clone()).unwrap_or_else(|| "imported".into());
        let record = KeyRecord { path, name, source, hidden: false };
        let info = self.inspect(&record, servers)?;
        registry.keys.insert(info.id.clone(), record);
        self.save_registry(&registry)?;
        Ok(info)
    }

    fn update(&self, id: &str, name: Option<&str>, hidden: bool, servers: &[Server]) -> Result<(), String> {
        let name = name.map(validate_name).transpose()?;
        let _lock = self.lock_registry()?;
        let mut registry = self.load_registry()?;
        let mut record = self.candidates(&registry, servers)?.remove(id).ok_or("找不到该密钥，请刷新列表")?;
        if let Some(name) = name { record.name = name; }
        record.hidden = hidden;
        registry.keys.insert(id.into(), record);
        self.save_registry(&registry)
    }
}

fn insert_discovered(records: &mut BTreeMap<String, KeyRecord>, path: PathBuf) {
    if validate_absolute_path(&path).is_err() { return; }
    let name = validate_name(path.file_name().and_then(OsStr::to_str).unwrap_or("SSH 密钥").trim_end_matches(".pub"))
        .unwrap_or_else(|_| "SSH 密钥".into());
    records.entry(key_id(&path)).or_insert(KeyRecord { path, name, source: "discovered".into(), hidden: false });
}

fn looks_like_private_key(path: &Path) -> bool {
    if check_regular(path, 4 * 1024 * 1024).is_err() { return false; }
    let mut prefix = [0_u8; 64];
    let Ok(mut file) = File::open(path) else { return false; };
    let Ok(count) = file.read(&mut prefix) else { return false; };
    let line = std::str::from_utf8(&prefix[..count]).unwrap_or("").lines().next().unwrap_or("");
    matches!(line, "-----BEGIN OPENSSH PRIVATE KEY-----" | "-----BEGIN RSA PRIVATE KEY-----" | "-----BEGIN EC PRIVATE KEY-----" | "-----BEGIN DSA PRIVATE KEY-----" | "-----BEGIN PRIVATE KEY-----" | "-----BEGIN ENCRYPTED PRIVATE KEY-----")
}

fn validate_name(value: &str) -> Result<String, String> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("密钥名称应为 1–80 个字符，且不能含换行或控制字符".into());
    }
    Ok(name.into())
}

fn is_public_path(path: &Path) -> bool { path.extension() == Some(OsStr::new("pub")) }
fn public_path(private: &Path) -> PathBuf { let mut path = private.as_os_str().to_owned(); path.push(".pub"); PathBuf::from(path) }
fn display_path(path: &Path) -> String { path.to_string_lossy().into_owned() }
fn key_id(path: &Path) -> String {
    let path = if is_public_path(path) { path.with_extension("") } else { path.to_path_buf() };
    let digest = Sha256::digest(path.to_string_lossy().as_bytes());
    format!("key-{:x}", digest)
}

fn append_warning(warning: &mut Option<String>, message: &str) {
    match warning { Some(existing) => { existing.push_str("；"); existing.push_str(message); }, None => *warning = Some(message.into()) }
}

fn validate_absolute_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || path.components().any(|component| matches!(component, Component::ParentDir)) || path.to_str().is_none_or(|value| value.chars().any(char::is_control)) {
        return Err("密钥路径必须是绝对路径或 ~/ 路径，不能包含 .. 或控制字符".into());
    }
    Ok(())
}

fn path_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(format!("无法访问路径 {}", path.display())),
    }
}

fn reject_symlinks(path: &Path) -> Result<(), String> {
    validate_absolute_path(path)?;
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Err(format!("为避免访问错误文件，密钥路径不能使用符号链接：{}", ancestor.display())),
            Ok(_) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err(format!("无法检查路径 {}", ancestor.display())),
        }
    }
    Ok(())
}

fn check_regular(path: &Path, maximum: u64) -> Result<(), String> {
    reject_symlinks(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| format!("无法读取密钥文件 {}", path.display()))?;
    if !metadata.is_file() || metadata.len() > maximum { return Err("密钥必须是大小合理的普通文件".into()); }
    Ok(())
}

fn read_regular(path: &Path, maximum: u64) -> Result<Vec<u8>, String> {
    check_regular(path, maximum)?;
    let mut bytes = Vec::new();
    File::open(path).map_err(|_| "无法打开文件")?.take(maximum + 1).read_to_end(&mut bytes).map_err(|_| "无法读取文件")?;
    if bytes.len() as u64 > maximum { return Err("文件超过大小限制".into()); }
    Ok(bytes)
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    reject_symlinks(path)?;
    if path_exists(path)? {
        if !fs::metadata(path).map_err(|_| "无法检查密钥目录")?.is_dir() { return Err("密钥存储路径不是目录".into()); }
        // Never change permissions on an existing ~/.ssh directory or imported data.
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            if fs::metadata(path).map_err(|_| "无法检查密钥目录")?.permissions().mode() & 0o022 != 0 {
                return Err(format!("密钥目录允许其他用户写入，请先收紧权限：{}", path.display()));
            }
        }
    } else {
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
        builder.create(path).map_err(|_| format!("无法创建密钥目录 {}", path.display()))?;
        set_directory_permissions(path)?;
    }
    Ok(())
}

fn set_directory_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| "无法设置密钥目录权限")?; }
    #[cfg(not(unix))] let _ = path;
    Ok(())
}

fn set_private_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|_| "无法设置私钥权限")?; }
    #[cfg(not(unix))] let _ = path;
    Ok(())
}

fn validate_public(text: &str) -> Result<(String, String, String), String> {
    if text.len() as u64 > MAX_PUBLIC_BYTES { return Err("公钥内容过长".into()); }
    let mut lines = text.lines().filter(|line| !line.trim().is_empty());
    let line = lines.next().ok_or("公钥文件为空")?.trim();
    if lines.next().is_some() || line.chars().any(|character| character.is_control() && character != '\t') { return Err("请选择只包含一把 OpenSSH 公钥的文件".into()); }
    let mut fields = line.split_whitespace();
    let kind = fields.next().ok_or("公钥格式无效")?;
    if !matches!(kind, "ssh-ed25519" | "ssh-rsa" | "ssh-dss" | "ecdsa-sha2-nistp256" | "ecdsa-sha2-nistp384" | "ecdsa-sha2-nistp521" | "sk-ssh-ed25519@openssh.com" | "sk-ecdsa-sha2-nistp256@openssh.com") {
        return Err("请选择 OpenSSH 格式的用户公钥（例如 id_ed25519.pub）".into());
    }
    let encoded = fields.next().ok_or("公钥格式无效")?;
    let decoded = STANDARD.decode(encoded).map_err(|_| "公钥 Base64 内容无效")?;
    if decoded.len() < 4 { return Err("公钥内容无效".into()); }
    let length = u32::from_be_bytes(decoded[..4].try_into().unwrap()) as usize;
    if decoded.get(4..4_usize.saturating_add(length)) != Some(kind.as_bytes()) { return Err("公钥算法与内容不一致".into()); }
    let comment = fields.collect::<Vec<_>>().join(" ");
    let public = format!("{kind} {encoded}{}", if comment.is_empty() { String::new() } else { format!(" {comment}") });
    let output = run_keygen(&["-l", "-f", "-", "-E", "sha256"].map(OsString::from), format!("{public}\n").as_bytes())
        .map_err(|_| "公钥校验失败，请检查文件是否完整（系统需要安装 OpenSSH）".to_string())?;
    let mut parts = output.split_whitespace();
    let bits = parts.next().filter(|bits| bits.parse::<u32>().is_ok()).ok_or("无法读取公钥位数")?;
    let fingerprint = parts.next().filter(|value| value.starts_with("SHA256:")).ok_or("无法读取公钥指纹")?.to_string();
    let algorithm = match kind {
        "ssh-ed25519" => "Ed25519".into(), "ssh-rsa" => format!("RSA {bits}"), "ssh-dss" => "DSA（旧算法）".into(),
        value if value.starts_with("ecdsa-") => format!("ECDSA {}", value.trim_start_matches("ecdsa-sha2-")),
        _ => "FIDO 安全密钥".into(),
    };
    Ok((public, algorithm, fingerprint))
}

fn derive_public(private: &Path) -> Result<String, String> {
    check_regular(private, 4 * 1024 * 1024)?;
    // The explicitly empty -P prevents prompting for an encrypted existing identity.
    run_keygen(&[OsString::from("-y"), OsString::from("-P"), OsString::new(), OsString::from("-f"), private.as_os_str().to_owned()], b"")
        .map_err(|_| "无法从私钥读取公钥：若私钥有密码，请导入对应的 .pub 文件；同时检查私钥格式与权限".into())
}

fn run_keygen(args: &[OsString], input: &[u8]) -> Result<String, String> {
    let mut command = Command::new("ssh-keygen");
    for key in crate::ssh_connection::INHERITED_ASKPASS_ENV { command.env_remove(key); }
    command.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .env("SSH_ASKPASS_REQUIRE", "never").env_remove("SSH_ASKPASS");
    #[cfg(unix)] {
        use std::os::unix::process::CommandExt;
        unsafe extern "C" { fn setsid() -> i32; }
        // ssh-keygen otherwise prefers /dev/tty over the pipe when RackTop was
        // started in a terminal. setsid is async-signal-safe in this child hook.
        unsafe { command.pre_exec(|| if setsid() == -1 { Err(std::io::Error::last_os_error()) } else { Ok(()) }); }
    }
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn().map_err(|_| "无法启动 ssh-keygen，请安装系统 OpenSSH 客户端".to_string())?;
    let stdout = child.stdout.take().ok_or("无法读取 ssh-keygen 输出")?;
    let reader = std::thread::spawn(move || {
        let mut stored = Vec::new();
        let mut buffer = [0_u8; 4096];
        let mut stream = stdout;
        while let Ok(count) = stream.read(&mut buffer) {
            if count == 0 { break; }
            let retained = count.min((MAX_PUBLIC_BYTES as usize).saturating_sub(stored.len()));
            stored.extend_from_slice(&buffer[..retained]);
        }
        stored
    });
    let mut secret = input.to_vec();
    let stdin = child.stdin.take().ok_or("无法输入 ssh-keygen 数据")?;
    let writer = std::thread::spawn(move || {
        let mut stream = stdin;
        let result = stream.write_all(&secret);
        secret.fill(0);
        result
    });
    let started = Instant::now();
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => break if status.success() { Ok(()) } else { Err("ssh-keygen 未能处理密钥，请检查文件、密码或系统权限".to_string()) },
            Ok(None) if started.elapsed() < KEYGEN_TIMEOUT => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => { let _ = child.kill(); let _ = child.wait(); break Err("生成或读取密钥超时，请稍后重试".into()); },
            Err(_) => { let _ = child.kill(); let _ = child.wait(); break Err("无法等待 ssh-keygen 完成".into()); },
        }
    };
    let _ = writer.join();
    let bytes = reader.join().map_err(|_| "无法读取密钥处理结果")?;
    result?;
    String::from_utf8(bytes).map_err(|_| "ssh-keygen 返回了无效文本".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager() -> (tempfile::TempDir, KeyManager) {
        let directory = tempfile::tempdir().unwrap();
        // macOS tempdir may use /var -> /private/var. Normalize only this
        // newly created fixture root; production key paths still reject links.
        let manager = KeyManager::new(directory.path().canonicalize().unwrap());
        (directory, manager)
    }

    #[test]
    fn generates_ed25519_and_rsa_with_expected_fingerprints_and_permissions() {
        let (_directory, manager) = manager();
        for (algorithm, expected) in [("ed25519", "Ed25519"), ("rsa4096", "RSA 4096")] {
            let key = manager.generate("本地密钥", algorithm, "").unwrap();
            assert_eq!(key.algorithm, expected);
            assert!(key.fingerprint.starts_with("SHA256:"));
            assert_eq!(key.source, "generated");
            assert!(key.warning.is_none());
            let private = Path::new(key.private_key_path.as_ref().unwrap());
            let derived = derive_public(private).unwrap();
            assert_eq!(validate_public(&derived).unwrap().2, key.fingerprint);
            #[cfg(unix)] {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(fs::metadata(private).unwrap().permissions().mode() & 0o777, 0o600);
                assert_eq!(fs::metadata(private.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
            }
        }
        assert_eq!(manager.list(&[]).unwrap().len(), 2);
    }

    #[test]
    fn encrypted_key_never_stores_passphrase_in_metadata_or_returns_private_content() {
        let (_directory, manager) = manager();
        let secret = "testing phrase with spaces & $ symbols";
        let key = manager.generate("加密测试", "ed25519", secret).unwrap();
        assert!(derive_public(Path::new(key.private_key_path.as_ref().unwrap())).is_err());
        let metadata = fs::read_to_string(manager.registry_path()).unwrap();
        assert!(!metadata.contains(secret));
        let result = serde_json::to_string(&key).unwrap();
        assert!(!result.contains(secret));
        assert!(!result.contains("PRIVATE KEY"));
        assert!(manager.list(&[]).unwrap()[0].warning.as_ref().unwrap().contains("加密"));
        // Verify the exact supplied passphrase decrypts the file, through stdin.
        let decrypted = run_keygen(&[OsString::from("-y"), OsString::from("-f"), OsString::from(key.private_key_path.unwrap())], format!("{secret}\n").as_bytes()).unwrap();
        assert_eq!(validate_public(&decrypted).unwrap().2, key.fingerprint);
    }

    #[test]
    fn imports_by_reference_renames_hides_and_restores_without_changing_files() {
        let (_directory, manager) = manager();
        let generated = manager.generate("原始名称", "ed25519", "").unwrap();
        let private = PathBuf::from(generated.private_key_path.unwrap());
        let before = fs::read(&private).unwrap();
        let imported = manager.import(generated.public_key_path.as_ref().unwrap(), Some("导入名称"), &[]).unwrap();
        assert_eq!(imported.id, generated.id);
        manager.update(&imported.id, Some("新名称"), false, &[]).unwrap();
        assert_eq!(manager.list(&[]).unwrap()[0].name, "新名称");
        manager.update(&imported.id, None, true, &[]).unwrap();
        assert!(manager.list(&[]).unwrap().is_empty());
        assert_eq!(before, fs::read(&private).unwrap());
        manager.import(private.to_str().unwrap(), None, &[]).unwrap();
        assert_eq!(manager.list(&[]).unwrap().len(), 1);
        assert_eq!(before, fs::read(private).unwrap());
    }

    #[test]
    fn discovers_ssh_public_keys_and_can_derive_a_missing_public_file_without_writing_it() {
        let (_directory, manager) = manager();
        let generated = manager.generate("原始", "ed25519", "").unwrap();
        let discovered = manager.ssh.join("outside.pub");
        fs::copy(generated.public_key_path.unwrap(), &discovered).unwrap();
        let keys = manager.list(&[]).unwrap();
        assert_eq!(keys.len(), 2);
        assert!(keys.iter().any(|key| key.source == "discovered" && key.private_key_path.is_none()));
        let private = PathBuf::from(generated.private_key_path.unwrap());
        fs::remove_file(public_path(&private)).unwrap();
        let imported = manager.import(private.to_str().unwrap(), None, &[]).unwrap();
        assert!(imported.public_key_path.is_none());
        assert_eq!(imported.fingerprint, generated.fingerprint);
        assert!(!public_path(&private).exists());
    }

    #[test]
    fn discovers_private_only_files_and_reports_server_usage_outside_ssh_directory() {
        let (_directory, manager) = manager();
        let generated = manager.generate("原始", "ed25519", "").unwrap();
        let private_only = manager.ssh.join("my-old-identity");
        fs::copy(generated.private_key_path.as_ref().unwrap(), &private_only).unwrap();
        set_private_permissions(&private_only).unwrap();
        let external = manager.home.join("external-identity");
        fs::copy(generated.private_key_path.unwrap(), &external).unwrap();
        set_private_permissions(&external).unwrap();
        let server = Server { managed: None,
            id: "server-test".into(), name: "测试服务器".into(), location: None,
            host: "127.0.0.1".into(), port: 22, username: "test".into(), ssh_alias: None,
            identity_file: Some(display_path(&external)), proxy_jump: None,
            proxy_use_password: false, save_proxy_password: false, tags: vec![],
            sampling_interval_seconds: 2, history_retention_days: 90, remote_history_enabled: false,
            remote_history_last_sync_at: None, sort_order: 0, auth_method: "privateKey".into(),
            status: "unknown".into(), last_error: None, last_seen_at: None,
        };
        let keys = manager.list(&[server]).unwrap();
        assert_eq!(keys.len(), 3);
        let old = keys.iter().find(|key| key.id == key_id(&private_only)).unwrap();
        assert_eq!(old.fingerprint, generated.fingerprint);
        assert!(old.public_key_path.is_none());
        let referenced = keys.iter().find(|key| key.id == key_id(&external)).unwrap();
        assert_eq!(referenced.used_by, ["测试服务器"]);
        assert_eq!(referenced.source, "discovered");
        assert!(!public_path(&private_only).exists());
        assert!(!public_path(&external).exists());
    }

    #[test]
    fn encrypted_private_without_public_file_has_helpful_error_and_preserves_registry() {
        let (_directory, manager) = manager();
        let generated = manager.generate("加密", "ed25519", "secret for test").unwrap();
        let private = PathBuf::from(generated.private_key_path.unwrap());
        fs::remove_file(generated.public_key_path.unwrap()).unwrap();
        let before = fs::read(manager.registry_path()).unwrap();
        let error = manager.import(private.to_str().unwrap(), None, &[]).unwrap_err();
        assert!(error.contains(".pub"));
        assert_eq!(before, fs::read(manager.registry_path()).unwrap());
        let listed = manager.list(&[]).unwrap();
        assert!(listed[0].warning.as_ref().unwrap().contains(".pub"));
        assert!(listed[0].public_key.is_empty());
        assert!(listed[0].fingerprint.is_empty());
        assert!(listed[0].private_key_path.is_some());
    }

    #[test]
    fn missing_or_invalid_private_keys_are_visible_but_not_selectable() {
        let (_directory, manager) = manager();
        let generated = manager.generate("待检查", "ed25519", "").unwrap();
        let private = PathBuf::from(generated.private_key_path.unwrap());
        fs::write(&private, "not a private key").unwrap();
        let invalid = manager.list(&[]).unwrap();
        assert!(invalid[0].private_key_path.is_none());
        assert!(invalid[0].warning.as_ref().unwrap().contains("格式"));
        fs::remove_file(&private).unwrap();
        fs::remove_file(generated.public_key_path.unwrap()).unwrap();
        let missing = manager.list(&[]).unwrap();
        assert_eq!(missing.len(), 1);
        assert!(missing[0].private_key_path.is_none());
        assert!(missing[0].warning.is_some());
    }

    #[test]
    fn refuses_malformed_registry_and_leaves_it_intact() {
        let (_directory, manager) = manager();
        manager.generate("有效", "ed25519", "").unwrap();
        fs::write(manager.registry_path(), "{broken").unwrap();
        assert!(manager.generate("失败", "ed25519", "").unwrap_err().contains("已损坏"));
        assert!(manager.list(&[]).is_err());
        assert_eq!(fs::read_to_string(manager.registry_path()).unwrap(), "{broken");
    }

    #[test]
    fn rejects_invalid_inputs_and_mismatched_pairs() {
        let (_directory, manager) = manager();
        assert!(manager.generate("", "ed25519", "").is_err());
        assert!(manager.generate("name", "dsa", "").is_err());
        assert!(manager.generate("name", "ed25519", "a\nb").is_err());
        assert!(manager.import("../id_key", None, &[]).is_err());
        assert!(manager.expand_path("~/.ssh/../key").is_err());
        assert!(validate_public("ssh-ed25519 invalid-base64").is_err());
        assert!(validate_public("-----BEGIN OPENSSH PRIVATE KEY-----").is_err());
        let first = manager.generate("first", "ed25519", "").unwrap();
        let second = manager.generate("second", "ed25519", "").unwrap();
        fs::copy(second.public_key_path.unwrap(), first.public_key_path.as_ref().unwrap()).unwrap();
        let imported = manager.import(first.public_key_path.as_ref().unwrap(), None, &[]).unwrap();
        assert!(imported.warning.unwrap().contains("不匹配"));
        assert!(imported.private_key_path.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_keys_and_storage_directories() {
        use std::os::unix::fs::symlink;
        let (_directory, manager) = manager();
        let generated = manager.generate("real", "ed25519", "").unwrap();
        let alias = manager.home.join("alias.pub");
        symlink(generated.public_key_path.unwrap(), &alias).unwrap();
        let error = manager.import(alias.to_str().unwrap(), None, &[]).unwrap_err();
        assert!(error.contains("符号链接") && error.contains(alias.to_str().unwrap()));
        let other_home = manager.home.join("other-home");
        fs::create_dir(&other_home).unwrap();
        symlink(&manager.ssh, other_home.join(".ssh")).unwrap();
        let error = KeyManager::new(other_home.clone()).generate("bad", "ed25519", "").unwrap_err();
        assert!(error.contains("符号链接") && error.contains(other_home.join(".ssh").to_str().unwrap()));
        let home_alias = manager.home.join("home-alias");
        symlink(&manager.home, &home_alias).unwrap();
        let error = KeyManager::new(home_alias.clone()).generate("bad", "ed25519", "").unwrap_err();
        assert!(error.contains("符号链接") && error.contains(home_alias.to_str().unwrap()));
    }
}
