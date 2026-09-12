//! Operation-scoped SSH password delivery. Password bytes never enter argv,
//! process environments or regular files. This reduces accidental disclosure;
//! it is not a security boundary against the owner of the client computer.
use std::{ffi::OsString, io::{Read, Write}, time::Duration};
use zeroize::Zeroizing;

pub const SOCKET_ENV: &str = "RACKTOP_ASKPASS_SOCKET";
pub const TOKEN_ENV: &str = "RACKTOP_ASKPASS_TOKEN";
pub const PROXY_TOKEN_ENV: &str = "RACKTOP_PROXY_ASKPASS_TOKEN";
const MAX_PASSWORD: usize = 64 * 1024;
const LIFETIME: Duration = Duration::from_secs(60);

/// Only the dedicated OpenSSH askpass invocation has both endpoint and token.
/// Proxy helpers run first and replace the target token with their own token.
pub fn run_helper() -> Option<Result<(), String>> {
    let endpoint = std::env::var_os(SOCKET_ENV);
    let token = std::env::var_os(TOKEN_ENV);
    if endpoint.is_none() && token.is_none() { return None; }
    Some((|| {
        let endpoint = endpoint.ok_or("缺少 SSH 密码通道")?;
        let token = token.ok_or("缺少 SSH 密码通道凭据")?;
        let password = receive(&endpoint, &token)?;
        let stdout = std::io::stdout();
        let mut output = stdout.lock();
        output.write_all(&password).and_then(|_| output.flush())
            .map_err(|_| "无法提供 SSH 密码".to_string())
    })())
}

#[cfg(unix)]
fn receive(endpoint: &std::ffi::OsStr, token: &std::ffi::OsStr) -> Result<Zeroizing<Vec<u8>>, String> {
    use std::os::unix::net::UnixStream;
    let fail = || "SSH 密码通道已关闭或已过期".to_string();
    let token = token.to_str().filter(|value| value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit())).ok_or_else(fail)?;
    let mut stream = UnixStream::connect(endpoint).map_err(|_| fail())?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).map_err(|_| fail())?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).map_err(|_| fail())?;
    stream.write_all(token.as_bytes()).map_err(|_| fail())?;
    let mut length = [0; 4];
    stream.read_exact(&mut length).map_err(|_| fail())?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_PASSWORD { return Err(fail()); }
    let mut password = Zeroizing::new(vec![0; length]);
    stream.read_exact(&mut password).map_err(|_| fail())?;
    Ok(password)
}

#[cfg(not(unix))]
fn receive(_: &std::ffi::OsStr, _: &std::ffi::OsStr) -> Result<Zeroizing<Vec<u8>>, String> {
    Err("当前平台尚不支持安全 SSH 密码通道".into())
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::{os::unix::{fs::PermissionsExt, net::UnixListener}, path::PathBuf,
        sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, thread, time::Instant};

    struct Slot { token: String, proxy: bool, password: Option<Zeroizing<Vec<u8>>> }
    struct State { stopped: AtomicBool, child: Mutex<Option<ProcessIdentity>>, slots: Mutex<Vec<Slot>> }

    #[derive(Clone, Copy, PartialEq, Eq)]
    struct ProcessIdentity { pid: u32, parent: u32, started: u64 }

    #[cfg(target_os = "linux")]
    fn process_identity(pid: u32) -> Option<ProcessIdentity> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // comm may contain spaces and parentheses; split after the last ') '.
        let fields: Vec<_> = stat.rsplit_once(") ")?.1.split_whitespace().collect();
        Some(ProcessIdentity { pid, parent: fields.get(1)?.parse().ok()?, started: fields.get(19)?.parse().ok()? })
    }

    #[cfg(target_os = "macos")]
    fn process_identity(pid: u32) -> Option<ProcessIdentity> {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info) as i32;
        let received = unsafe { libc::proc_pidinfo(pid.try_into().ok()?, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
        (received == size).then_some(ProcessIdentity { pid, parent: info.pbi_ppid, started: info.pbi_start_tvsec.saturating_mul(1_000_000).saturating_add(info.pbi_start_tvusec) })
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn process_identity(_: u32) -> Option<ProcessIdentity> { None }

    #[cfg(target_os = "linux")]
    fn peer_pid(stream: &std::os::unix::net::UnixStream) -> Option<u32> {
        use std::os::fd::AsRawFd;
        let mut peer: libc::ucred = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of_val(&peer) as libc::socklen_t;
        let status = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut peer as *mut libc::ucred).cast(), &mut size) };
        if status != 0 || size as usize != std::mem::size_of_val(&peer) || peer.uid != unsafe { libc::geteuid() } { return None; }
        peer.pid.try_into().ok()
    }

    #[cfg(target_os = "macos")]
    fn peer_pid(stream: &std::os::unix::net::UnixStream) -> Option<u32> {
        use std::os::fd::AsRawFd;
        let (mut uid, mut gid, mut pid) = (0, 0, 0 as libc::pid_t);
        let mut size = std::mem::size_of_val(&pid) as libc::socklen_t;
        let status = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
        if status != 0 || uid != unsafe { libc::geteuid() } { return None; }
        let status = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_LOCAL, libc::LOCAL_PEERPID, (&mut pid as *mut libc::pid_t).cast(), &mut size) };
        if status != 0 || size as usize != std::mem::size_of_val(&pid) { return None; }
        pid.try_into().ok()
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn peer_pid(_: &std::os::unix::net::UnixStream) -> Option<u32> { None }

    #[cfg(target_os = "linux")]
    fn executable(pid: u32) -> Option<PathBuf> { std::fs::read_link(format!("/proc/{pid}/exe")).ok() }

    #[cfg(target_os = "macos")]
    fn executable(pid: u32) -> Option<PathBuf> {
        use std::os::unix::ffi::OsStringExt;
        let mut path = vec![0u8; 4096];
        let count = unsafe { libc::proc_pidpath(pid.try_into().ok()?, path.as_mut_ptr().cast(), path.len() as u32) };
        if count <= 0 { return None; }
        path.truncate(path.iter().position(|byte| *byte == 0)?);
        Some(PathBuf::from(OsString::from_vec(path)))
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn executable(_: u32) -> Option<PathBuf> { None }

    fn authorized_peer(stream: &std::os::unix::net::UnixStream, state: &State, proxy: bool) -> bool {
        let Some(peer_pid) = peer_pid(stream) else { return false; };
        let Some(peer) = process_identity(peer_pid) else { return false; };
        // Binding follows spawn. A helper that wins that brief scheduling race
        // waits locally, without permitting any unbound credential request.
        let mut child = state.child.lock().ok().and_then(|child| *child);
        for _ in 0..20 {
            if child.is_some() || state.stopped.load(Ordering::Acquire) { break; }
            thread::sleep(Duration::from_millis(5));
            child = state.child.lock().ok().and_then(|child| *child);
        }
        let Some(child) = child else { return false; };
        #[cfg(test)]
        if peer.pid == std::process::id() && child.pid == peer.pid { return true; }
        if executable(peer_pid) != std::env::current_exe().ok() || process_identity(child.pid) != Some(child) { return false; }
        // Target askpass is the direct child of this operation's SSH. A proxy
        // askpass belongs to a nested SSH, never the target's askpass process.
        if (peer.parent != child.pid) != proxy { return false; }
        let Some(parent_exe) = executable(peer.parent) else { return false; };
        if parent_exe.file_name().is_none_or(|name| name != "ssh") { return false; }
        let mut ancestor = peer.parent;
        for _ in 0..16 {
            let Some(identity) = process_identity(ancestor) else { return false; };
            if identity == child { return true; }
            if identity.parent == ancestor || identity.parent <= 1 { break; }
            ancestor = identity.parent;
        }
        false
    }

    /// Kept by the command/child or PTY session, never in a global password pool.
    pub struct Broker {
        state: Arc<State>,
        worker: Option<thread::JoinHandle<()>>,
    }

    impl std::fmt::Debug for Broker {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("AskpassBroker") }
    }

    impl Broker {
        pub fn start(target: Option<&str>, proxy: Option<&str>) -> Result<(Self, Vec<(OsString, OsString)>), String> {
            Self::start_with_lifetime(target, proxy, LIFETIME)
        }

        fn start_with_lifetime(target: Option<&str>, proxy: Option<&str>, lifetime: Duration) -> Result<(Self, Vec<(OsString, OsString)>), String> {
            let fail = || "无法创建安全 SSH 密码通道".to_string();
            // /tmp keeps the Unix socket pathname below macOS's 104-byte limit,
            // including when the user's TMPDIR points into a long sandbox path.
            let directory = tempfile::Builder::new().prefix("racktop-askpass-").tempdir_in("/tmp").map_err(|_| fail())?;
            std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).map_err(|_| fail())?;
            let endpoint = directory.path().join("socket");
            let listener = UnixListener::bind(&endpoint).map_err(|_| fail())?;
            std::fs::set_permissions(&endpoint, std::fs::Permissions::from_mode(0o600)).map_err(|_| fail())?;
            listener.set_nonblocking(true).map_err(|_| fail())?;
            let mut env = vec![(SOCKET_ENV.into(), endpoint.as_os_str().to_owned())];
            let mut slots = Vec::new();
            for (name, password) in [(TOKEN_ENV, target), (PROXY_TOKEN_ENV, proxy)] {
                if let Some(password) = password {
                    if password.is_empty() || password.len() > MAX_PASSWORD || password.bytes().any(|byte| matches!(byte, 0 | b'\r' | b'\n')) { return Err("SSH 密码格式无效".into()); }
                    let token = uuid::Uuid::new_v4().simple().to_string();
                    env.push((name.into(), token.clone().into()));
                    slots.push(Slot { token, proxy: name == PROXY_TOKEN_ENV, password: Some(Zeroizing::new(password.as_bytes().to_vec())) });
                }
            }
            let state = Arc::new(State { stopped: AtomicBool::new(false), child: Mutex::new(None), slots: Mutex::new(slots) });
            let worker_state = state.clone();
            let worker = thread::Builder::new().name("racktop-askpass".into()).spawn(move || {
                let _directory = directory;
                serve(listener, endpoint, worker_state, lifetime);
            }).map_err(|_| fail())?;
            Ok((Self { state, worker: Some(worker) }, env))
        }

        pub fn bind_child(&self, pid: Option<u32>) { if let Ok(mut child) = self.state.child.lock() { *child = pid.and_then(process_identity); } }

        pub fn cancellation(&self) -> Box<dyn FnOnce() + Send> {
            let state = self.state.clone();
            Box::new(move || { state.stopped.store(true, Ordering::Release); if let Ok(mut slots) = state.slots.lock() { slots.clear(); } })
        }
    }

    fn serve(listener: UnixListener, endpoint: PathBuf, state: Arc<State>, lifetime: Duration) {
        let deadline = Instant::now() + lifetime;
        while !state.stopped.load(Ordering::Acquire) && Instant::now() < deadline {
            let pending = state.slots.lock().map(|slots| slots.iter().any(|slot| slot.password.is_some())).unwrap_or(false);
            if !pending { break; }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
                    let _ = stream.set_write_timeout(Some(Duration::from_millis(100)));
                    let mut token = [0; 32];
                    if stream.read_exact(&mut token).is_err() || state.stopped.load(Ordering::Acquire) || Instant::now() >= deadline { continue; }
                    let proxy = state.slots.lock().ok().and_then(|slots| slots.iter().find(|slot| slot.token.as_bytes() == token && slot.password.is_some()).map(|slot| slot.proxy));
                    let Some(proxy) = proxy else { continue; };
                    if !authorized_peer(&stream, &state, proxy) { continue; }
                    let password = state.slots.lock().ok().and_then(|mut slots| {
                        if state.stopped.load(Ordering::Acquire) || Instant::now() >= deadline { return None; }
                        slots.iter_mut().find(|slot| slot.token.as_bytes() == token).and_then(|slot| slot.password.take())
                    });
                    if let Some(password) = password {
                        // Consume even if the helper disconnects: an operation
                        // cannot replay a credential request after a failed read.
                        if !state.stopped.load(Ordering::Acquire) && Instant::now() < deadline
                            && stream.write_all(&(password.len() as u32).to_be_bytes()).is_ok() { let _ = stream.write_all(&password); }
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(5)),
                Err(_) => break,
            }
        }
        if let Ok(mut slots) = state.slots.lock() { slots.clear(); }
        drop(listener);
        let _ = std::fs::remove_file(endpoint);
    }

    impl Drop for Broker {
        fn drop(&mut self) {
            self.state.stopped.store(true, Ordering::Release);
            if let Ok(mut slots) = self.state.slots.lock() { slots.clear(); }
            if let Some(worker) = self.worker.take() { let _ = worker.join(); }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        fn env_value(env: &[(OsString, OsString)], name: &str) -> OsString { env.iter().find(|(key, _)| key == name).unwrap().1.clone() }
        #[test]
        fn slots_are_private_one_use_and_do_not_write_password_files() {
            let (broker, env) = Broker::start(Some("target-fixture"), Some("jump-fixture")).unwrap();
            broker.bind_child(Some(std::process::id()));
            let endpoint = env_value(&env, SOCKET_ENV);
            let directory = std::path::Path::new(&endpoint).parent().unwrap();
            assert_eq!(std::fs::metadata(directory).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(std::fs::read_dir(directory).unwrap().count(), 1);
            assert!(!format!("{env:?}").contains("target-fixture"));
            assert!(!format!("{env:?}").contains("jump-fixture"));
            assert!(receive(&endpoint, std::ffi::OsStr::new("00000000000000000000000000000000")).is_err());
            assert_eq!(&*receive(&endpoint, &env_value(&env, PROXY_TOKEN_ENV)).unwrap(), b"jump-fixture");
            assert!(receive(&endpoint, &env_value(&env, PROXY_TOKEN_ENV)).is_err());
            assert_eq!(&*receive(&endpoint, &env_value(&env, TOKEN_ENV)).unwrap(), b"target-fixture");
            assert!(receive(&endpoint, &env_value(&env, TOKEN_ENV)).is_err());
            drop(broker);
            assert!(!directory.exists());
        }
        #[test]
        fn unconsumed_passwords_expire_and_drop_closes_early() {
            let (broker, env) = Broker::start_with_lifetime(Some("fixture"), None, Duration::from_millis(15)).unwrap();
            thread::sleep(Duration::from_millis(30));
            assert!(receive(&env_value(&env, SOCKET_ENV), &env_value(&env, TOKEN_ENV)).is_err());
            assert!(broker.state.slots.lock().unwrap().is_empty());
            let (early, env) = Broker::start(Some("fixture"), None).unwrap();
            drop(early);
            assert!(receive(&env_value(&env, SOCKET_ENV), &env_value(&env, TOKEN_ENV)).is_err());
        }

        #[test]
        fn valid_token_without_the_bound_ssh_process_is_rejected_without_consumption() {
            let (broker, env) = Broker::start(Some(" identity bound 中文 "), None).unwrap();
            let endpoint = env_value(&env, SOCKET_ENV);
            let token = env_value(&env, TOKEN_ENV);
            assert!(receive(&endpoint, &token).is_err());
            let mut unrelated = std::process::Command::new("sleep").arg("2").spawn().unwrap();
            broker.bind_child(Some(unrelated.id()));
            assert!(receive(&endpoint, &token).is_err());
            broker.bind_child(Some(std::process::id()));
            assert_eq!(&*receive(&endpoint, &token).unwrap(), " identity bound 中文 ".as_bytes());
            let _ = unrelated.kill();
            let _ = unrelated.wait();
        }

        #[test]
        fn a_stalled_client_cannot_hold_the_guard_open() {
            let (broker, env) = Broker::start(Some("fixture"), None).unwrap();
            let _stream = std::os::unix::net::UnixStream::connect(env_value(&env, SOCKET_ENV)).unwrap();
            thread::sleep(Duration::from_millis(10));
            let started = Instant::now();
            drop(broker);
            assert!(started.elapsed() < Duration::from_secs(1));
        }
    }
}

#[cfg(unix)]
pub use platform::Broker;

#[cfg(not(unix))]
#[derive(Debug)]
pub struct Broker;
#[cfg(not(unix))]
impl Broker {
    pub fn start(_: Option<&str>, _: Option<&str>) -> Result<(Self, Vec<(OsString, OsString)>), String> { Err("当前平台尚不支持安全 SSH 密码通道".into()) }
    pub fn bind_child(&self, _: Option<u32>) {}
    pub fn cancellation(&self) -> Box<dyn FnOnce() + Send> { Box::new(|| {}) }
}
