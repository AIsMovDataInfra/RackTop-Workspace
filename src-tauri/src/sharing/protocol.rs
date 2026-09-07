use serde::{Serialize, de::DeserializeOwned};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_FRAME_BYTES: usize = 128 * 1024;

struct FrameBuffer(Vec<u8>);
impl std::io::Write for FrameBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_FRAME_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "frame too large",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Framing belongs inside authenticated TLS. Messages can span many WebSocket chunks.
pub async fn write_frame<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> Result<(), String> {
    let mut buffer = FrameBuffer(Vec::new());
    serde_json::to_writer(&mut buffer, value).map_err(|_| "共享消息无法编码或超过 128 KiB 上限")?;
    let body = buffer.0;
    if body.is_empty() || body.len() > MAX_FRAME_BYTES {
        return Err("共享消息超过 128 KiB 上限".into());
    }
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        writer.write_all(&(body.len() as u32).to_be_bytes()).await?;
        writer.write_all(&body).await?;
        writer.flush().await
    })
    .await
    .map_err(|_| "共享消息发送超时")?
    .map_err(|_| "共享连接已断开".into())
}

pub async fn read_frame<R: AsyncRead + Unpin, T: DeserializeOwned>(
    reader: &mut R,
) -> Result<T, String> {
    let length = reader.read_u32().await.map_err(|_| "共享连接已断开")? as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err("共享消息长度无效".into());
    }
    let mut body = vec![0u8; length];
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        reader.read_exact(&mut body),
    )
    .await
    .map_err(|_| "共享消息接收超时")?
    .map_err(|_| "共享消息不完整")?;
    serde_json::from_slice(&body).map_err(|_| "共享消息格式无效".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn large_json_survives_small_transport_chunks() {
        let (mut a, mut b) = tokio::io::duplex(97);
        let value = json!({"data": "x".repeat(100_000)});
        let expected = value.clone();
        let write = tokio::spawn(async move { write_frame(&mut a, &value).await.unwrap() });
        assert_eq!(
            read_frame::<_, serde_json::Value>(&mut b).await.unwrap(),
            expected
        );
        write.await.unwrap();
    }

    #[tokio::test]
    async fn oversized_header_is_rejected_before_body_allocation() {
        let mut bytes = ((MAX_FRAME_BYTES + 1) as u32)
            .to_be_bytes()
            .as_slice()
            .to_vec();
        assert!(
            read_frame::<_, serde_json::Value>(&mut bytes.as_slice())
                .await
                .is_err()
        );
        bytes.clear();
        assert!(
            write_frame(&mut bytes, &"x".repeat(MAX_FRAME_BYTES))
                .await
                .is_err()
        );
    }
}
