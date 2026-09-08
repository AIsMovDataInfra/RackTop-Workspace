//! One-time local inventory provisioning. Explicit integration-probe build only; never bundled.
//! Reads non-credential source/binding metadata from stdin and stores it in the OS keyring.
use std::io::Read;

#[tokio::main]
async fn main() {
    let result = (|| -> Result<usize, String> {
        if std::env::args_os().len() != 1 {
            return Err(
                "用法：team-setup；从标准输入读取 profilePath、sourceId 和 bindings 的 JSON".into(),
            );
        }
        let mut input = Vec::new();
        std::io::stdin()
            .take(65_537)
            .read_to_end(&mut input)
            .map_err(|_| "无法读取预配置 JSON")?;
        if input.len() > 65_536 {
            return Err("预配置 JSON 超过大小限制".into());
        }
        let value = serde_json::from_slice(&input).map_err(|_| "预配置必须是有效 JSON")?;
        racktop_lib::team::prepare_profile(value)
    })();
    match result {
        Ok(count) => println!("{}", serde_json::json!({"ok":true,"bindings":count})),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
