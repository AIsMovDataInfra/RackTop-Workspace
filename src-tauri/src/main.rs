#![cfg_attr(all(target_os = "windows", not(debug_assertions)), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--racktop-ssh-proxy") {
        if let Err(error) = racktop_lib::ssh_connection::run_proxy(&args[1..]) { eprintln!("{error}"); std::process::exit(1); }
        return;
    }
    if let Ok(password) = std::env::var("RACKTOP_ASKPASS_PASSWORD") {
        print!("{password}");
        return;
    }
    racktop_lib::run();
}
