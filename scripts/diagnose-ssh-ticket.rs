//! Standalone synthetic AF_UNIX timing diagnostic. No app, credentials, or Cargo.
//! rustc --edition=2021 -O mac-token-timing.rs -o mac-token-timing
//! ./mac-token-timing [rounds=3] [parallel=1] > timing.jsonl
use std::{fs, io::{self, Read, Write}, os::unix::{fs::PermissionsExt, net::{UnixListener, UnixStream}, io::AsRawFd},
    path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
// F_GETFL is 3 on the two diagnostic targets. Only inspect our own sockets.
unsafe extern "C" { fn fcntl(fd: std::os::raw::c_int, command: std::os::raw::c_int, ...) -> std::os::raw::c_int; }
fn record_flags(trace: &Trace, stage: &str, fd: std::os::raw::c_int) {
    let flags=unsafe {fcntl(fd,3)};
    if flags<0 {trace.note(stage,0,Some(&io::Error::last_os_error()));}
    else {trace.note(stage,flags as u128,None);}
}
struct State { stopped: AtomicBool }
#[derive(Clone)]
struct Trace { start: Instant, events: Arc<Mutex<Vec<String>>> }
impl Trace {
    fn note(&self, stage: &str, value: u128, error: Option<&io::Error>) {
        let elapsed = self.start.elapsed().as_micros();
        let kind = error.map(|e| format!("{:?}", e.kind())).unwrap_or_else(|| "ok".into());
        let code = error.and_then(io::Error::raw_os_error).unwrap_or(0);
        self.events.lock().unwrap().push(format!(
            "{{\"elapsed_us\":{elapsed},\"stage\":\"{stage}\",\"value\":{value},\"kind\":\"{kind}\",\"os_code\":{code}}}"));
    }
}
struct Cleanup(PathBuf);
impl Drop for Cleanup { fn drop(&mut self) { let _=fs::remove_file(self.0.join("socket")); let _=fs::remove_dir(&self.0); } }
// Exact production read_token function copied from src-tauri/src/askpass.rs:
fn read_token(stream: &mut std::os::unix::net::UnixStream, state: &State, operation_deadline: Instant) -> Option<[u8; 32]> {
        // A per-read timeout alone can be renewed by a slow sender. Bound the
        // complete fixed-size ticket, including all partial reads, to 100 ms.
        let deadline = (Instant::now() + Duration::from_millis(100)).min(operation_deadline);
        let mut token = [0; 32];
        let mut received = 0;
        while received < token.len() {
            if state.stopped.load(Ordering::Acquire) { return None; }
            let remaining = deadline.checked_duration_since(Instant::now()).filter(|time| !time.is_zero())?;
            stream.set_read_timeout(Some(remaining)).ok()?;
            match stream.read(&mut token[received..]) {
                Ok(0) => return None,
                Ok(count) => received += count,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return None,
            }
        }
        (!state.stopped.load(Ordering::Acquire) && Instant::now() < deadline).then_some(token)
    }

// Same token algorithm, with events buffered in memory. Original mode above is
// the control for any overhead introduced by tracing and timeout readback.
fn read_token_traced(stream: &mut UnixStream, state: &State, operation_deadline: Instant, trace: &Trace) -> Option<[u8;32]> {
    let deadline=(Instant::now()+Duration::from_millis(100)).min(operation_deadline);
    let mut token=[0;32];
    let mut received=0;
    while received<token.len() {
        if state.stopped.load(Ordering::Acquire) { trace.note("reject_cancelled",received as u128,None); return None; }
        let Some(remaining)=deadline.checked_duration_since(Instant::now()).filter(|time|!time.is_zero()) else {
            trace.note("reject_deadline_before_read",received as u128,None); return None;
        };
        let configured=stream.set_read_timeout(Some(remaining));
        trace.note("set_read_timeout_us",remaining.as_micros(),configured.as_ref().err());
        if configured.is_err() { return None; }
        match stream.read_timeout() {
            Ok(value)=>trace.note("read_timeout_getter_us",value.map(|v|v.as_micros()).unwrap_or(0),None),
            Err(error)=>trace.note("read_timeout_getter_error",0,Some(&error)),
        }
        trace.note("read_begin_total_received",received as u128,None);
        match stream.read(&mut token[received..]) {
            Ok(0)=> { trace.note("read_eof",received as u128,None); return None; }
            Ok(count)=> { received+=count; trace.note("read_return_bytes",count as u128,None); }
            Err(error) if error.kind()==io::ErrorKind::Interrupted=> { trace.note("read_interrupted",received as u128,Some(&error)); continue; }
            Err(error)=> { trace.note("read_error",received as u128,Some(&error)); return None; }
        }
    }
    let valid=!state.stopped.load(Ordering::Acquire) && Instant::now()<deadline;
    trace.note(if valid {"ticket_complete_within_deadline"} else {"reject_complete_after_deadline"},received as u128,None);
    valid.then_some(token)
}

fn run_case(case:usize,traced:bool,pattern:usize)->String {
    let trace=Trace{start:Instant::now(),events:Arc::new(Mutex::new(Vec::new()))};
    let nonce=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let directory=PathBuf::from(format!("/tmp/rt-token-diag-{}-{nonce}-{case}",std::process::id()));
    fs::create_dir(&directory).unwrap();
    let _cleanup=Cleanup(directory.clone());
    fs::set_permissions(&directory,fs::Permissions::from_mode(0o700)).unwrap();
    let socket=directory.join("socket");
    let listener=UnixListener::bind(&socket).unwrap();
    fs::set_permissions(&socket,fs::Permissions::from_mode(0o600)).unwrap();
    listener.set_nonblocking(true).unwrap();
    trace.note("listener_nonblocking_enabled",1,None);
    record_flags(&trace,"listener_fd_flags",listener.as_raw_fd());
    let server_trace=trace.clone();
    let server=thread::spawn(move || {
        let end=Instant::now()+Duration::from_secs(3);
        let mut stream=loop {
            match listener.accept() {
                Ok((stream,_))=>break stream,
                Err(error) if error.kind()==io::ErrorKind::WouldBlock && Instant::now()<end=>thread::sleep(Duration::from_millis(10)),
                Err(error)=> { server_trace.note("accept_error",0,Some(&error)); return false; }
            }
        };
        server_trace.note("accepted",0,None);
        record_flags(&server_trace,"accepted_fd_flags_before",stream.as_raw_fd());
        let blocking=stream.set_nonblocking(false);
        server_trace.note("set_nonblocking_false",0,blocking.as_ref().err());
        if blocking.is_err() { return false; }
        record_flags(&server_trace,"accepted_fd_flags_after",stream.as_raw_fd());
        record_flags(&server_trace,"listener_fd_flags_after",listener.as_raw_fd());
        let timeout=stream.set_write_timeout(Some(Duration::from_millis(100)));
        server_trace.note("set_write_timeout_us",100_000,timeout.as_ref().err());
        if timeout.is_err() { return false; }
        let state=State{stopped:AtomicBool::new(false)};
        server_trace.note("read_token_enter",0,None);
        let result=if traced {read_token_traced(&mut stream,&state,Instant::now()+Duration::from_secs(60),&server_trace)}
                   else {read_token(&mut stream,&state,Instant::now()+Duration::from_secs(60))};
        server_trace.note("read_token_return",usize::from(result.is_some()) as u128,None);
        if let Some(token)=result {
            if token!=[b'0';32] {server_trace.note("synthetic_ticket_mismatch",0,None);return false;}
            server_trace.note("server_header_write_begin",4,None);
            let header=stream.write_all(&32u32.to_be_bytes());
            server_trace.note("server_header_write",4,header.as_ref().err());
            if header.is_err() {return false;}
            server_trace.note("server_synthetic_payload_write_begin",32,None);
            let payload=stream.write_all(&token);
            server_trace.note("server_synthetic_payload_write",32,payload.as_ref().err());
            payload.is_ok()
        } else { false }
    });
    let client_result=(||->io::Result<bool> {
        trace.note("connect_begin",0,None);
        let mut stream=UnixStream::connect(&socket)?;
        trace.note("connect_complete",0,None);
        stream.set_read_timeout(Some(Duration::from_secs(1)))?;
        if pattern==0 {
            trace.note("write_full_begin",32,None);
            let result=stream.write_all(&[b'0';32]);
            trace.note("write_full_return",32,result.as_ref().err());
            result?;
        } else {
            let gaps=match pattern {1=>[0,20],2=>[20,20],_=>[60,60]};
            for part in 0..2 {
                trace.note(if part==0 {"sleep1_begin_us"} else {"sleep2_begin_us"},gaps[part]*1000,None);
                thread::sleep(Duration::from_millis(gaps[part] as u64));
                trace.note(if part==0 {"sleep1_end"} else {"sleep2_end"},0,None);
                trace.note(if part==0 {"write1_begin"} else {"write2_begin"},16,None);
                let result=stream.write_all(&[b'0';16]);
                trace.note(if part==0 {"write1_return"} else {"write2_return"},16,result.as_ref().err());
                result?;
            }
        }
        let mut length=[0;4];
        trace.note("client_header_read_begin",0,None);
        let result=stream.read_exact(&mut length);
        trace.note("client_header_read_return",4,result.as_ref().err());
        result?;
        if u32::from_be_bytes(length)!=32 {return Ok(false);}
        let mut payload=[0;32];
        let result=stream.read_exact(&mut payload);
        trace.note("client_payload_read_return",32,result.as_ref().err());
        result?;
        Ok(payload==[b'0';32])
    })();
    if let Err(ref error)=client_result {trace.note("client_failure",0,Some(error));}
    let server_ok=server.join().unwrap();
    let client_ok=client_result.unwrap_or(false);
    let events=trace.events.lock().unwrap().join(",");
    let pattern_name=["full","0+20","20+20","60+60"][pattern];
    format!("{{\"os\":\"{}\",\"arch\":\"{}\",\"case\":{case},\"pattern\":\"{pattern_name}\",\"mode\":\"{}\",\"server_ok\":{server_ok},\"client_ok\":{client_ok},\"events\":[{events}]}}",std::env::consts::OS,std::env::consts::ARCH,if traced {"traced"} else {"original"})
}

fn main() {
    let args:Vec<_>=std::env::args().skip(1).collect();
    let rounds:usize=args.first().map(|v|v.parse().expect("rounds must be an integer")).unwrap_or(3);
    let parallel:usize=args.get(1).map(|v|v.parse().expect("parallel must be an integer")).unwrap_or(1);
    assert!(args.len()<=2 && (1..=20).contains(&rounds) && (1..=8).contains(&parallel),"usage: diag [rounds 1..20] [parallel 1..8]");
    for round in 0..rounds {
        for traced in [false,true] {
            for pattern in 0..4 {
                let handles:Vec<_>=(0..parallel).map(|lane| {
                    let case=round*parallel*8+usize::from(traced)*parallel*4+pattern*parallel+lane;
                    thread::spawn(move || run_case(case,traced,pattern))
                }).collect();
                for handle in handles {println!("{}",handle.join().unwrap());}
            }
        }
    }
}
