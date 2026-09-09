use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand::RngCore;
use serde::{Deserialize, Serialize};

pub const TRUSTED_RELAY_URL: &str = "https://136.0.110.161";
pub const INNER_SERVER_NAME: &str = "racktop-share.local";
const INVITATION_V1_PREFIX: &str = "racktop-share:1:";
const INVITATION_V2_PREFIX: &str = "racktop-share:2:";

// These structs intentionally do not implement Debug: key material must stay out of logs.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerIdentity {
    pub cert_der: String,
    pub key_der: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceIdentity {
    pub secret_key: String,
    pub public_key: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Invitation {
    pub relay_url: String,
    pub route_id: String,
    pub route_token: String,
    pub owner_cert_der: String,
    pub invite_secret: String,
    pub resource_name: String,
    // The protocol generation is carried by the textual prefix instead of the
    // JSON payload so older v1 decoders continue to reject v2 codes cleanly.
    #[serde(skip)]
    pub reusable: bool,
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn random_route_id() -> String {
    let mut bytes = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn generate_owner_identity() -> Result<OwnerIdentity, String> {
    let rcgen::CertifiedKey { cert, signing_key } =
        rcgen::generate_simple_self_signed(vec![INNER_SERVER_NAME.to_owned()])
            .map_err(|_| "无法生成共享证书")?;
    Ok(OwnerIdentity {
        cert_der: URL_SAFE_NO_PAD.encode(cert.der()),
        key_der: URL_SAFE_NO_PAD.encode(signing_key.serialize_der()),
    })
}

pub fn generate_device_identity() -> DeviceIdentity {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let key = SigningKey::from_bytes(&bytes);
    DeviceIdentity {
        secret_key: URL_SAFE_NO_PAD.encode(bytes),
        public_key: URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes()),
    }
}

pub fn sign(identity: &DeviceIdentity, message: &[u8]) -> Result<String, String> {
    let bytes: [u8; 32] = decode_bounded(&identity.secret_key, 32)?
        .try_into()
        .map_err(|_| "设备密钥无效")?;
    let signing = SigningKey::from_bytes(&bytes);
    if URL_SAFE_NO_PAD.encode(signing.verifying_key().as_bytes()) != identity.public_key {
        return Err("设备密钥不匹配".into());
    }
    Ok(URL_SAFE_NO_PAD.encode(signing.sign(message).to_bytes()))
}

pub fn verify(public_key: &str, message: &[u8], signature: &str) -> Result<(), String> {
    let key: [u8; 32] = decode_bounded(public_key, 32)?
        .try_into()
        .map_err(|_| "设备公钥无效")?;
    let key = VerifyingKey::from_bytes(&key).map_err(|_| "设备公钥无效")?;
    let signature =
        Signature::from_slice(&decode_bounded(signature, 64)?).map_err(|_| "设备签名无效")?;
    key.verify_strict(message, &signature)
        .map_err(|_| "设备身份验证失败".into())
}

pub fn decode_bounded(encoded: &str, maximum: usize) -> Result<Vec<u8>, String> {
    if encoded.len() > maximum.saturating_mul(4).div_ceil(3) + 4 {
        return Err("共享凭据长度无效".into());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "共享凭据格式无效")?;
    if bytes.is_empty() || bytes.len() > maximum {
        return Err("共享凭据长度无效".into());
    }
    Ok(bytes)
}

fn validate_invitation(invitation: &Invitation) -> Result<(), String> {
    if invitation.relay_url != TRUSTED_RELAY_URL {
        return Err("邀请码使用了未受信任的中继地址".into());
    }
    if decode_bounded(&invitation.route_id, 24)?.len() != 24
        || decode_bounded(&invitation.route_token, 32)?.len() != 32
        || decode_bounded(&invitation.invite_secret, 32)?.len() != 32
        || invitation.resource_name.is_empty()
        || invitation.resource_name.chars().count() > 200
        || invitation.resource_name.chars().any(char::is_control)
    {
        return Err("邀请码内容无效".into());
    }
    decode_bounded(&invitation.owner_cert_der, 4096)?;
    Ok(())
}

pub fn encode_invitation(invitation: &Invitation) -> Result<String, String> {
    validate_invitation(invitation)?;
    let json = serde_json::to_vec(invitation).map_err(|_| "无法生成邀请码")?;
    let prefix = if invitation.reusable {
        INVITATION_V2_PREFIX
    } else {
        INVITATION_V1_PREFIX
    };
    Ok(format!(
        "{prefix}{}",
        URL_SAFE_NO_PAD.encode(json)
    ))
}

pub fn decode_invitation(code: &str) -> Result<Invitation, String> {
    if code.len() > 16 * 1024 {
        return Err("邀请码过长".into());
    }
    let code = code.trim();
    let (payload, reusable) = if let Some(payload) = code.strip_prefix(INVITATION_V2_PREFIX) {
        (payload, true)
    } else if let Some(payload) = code.strip_prefix(INVITATION_V1_PREFIX) {
        (payload, false)
    } else {
        return Err("邀请码版本或格式无效".into());
    };
    let mut invitation: Invitation = serde_json::from_slice(&decode_bounded(payload, 12 * 1024)?)
        .map_err(|_| "邀请码内容无效")?;
    invitation.reusable = reusable;
    validate_invitation(&invitation)?;
    Ok(invitation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ed25519_verifies_only_the_original_message_and_key() {
        let device = generate_device_identity();
        let signature = sign(&device, b"challenge-one").unwrap();
        verify(&device.public_key, b"challenge-one", &signature).unwrap();
        assert!(verify(&device.public_key, b"challenge-two", &signature).is_err());
        assert!(
            verify(
                &generate_device_identity().public_key,
                b"challenge-one",
                &signature
            )
            .is_err()
        );
    }

    #[test]
    fn invitation_roundtrip_rejects_untrusted_destinations_and_oversized_input() {
        let owner = generate_owner_identity().unwrap();
        let mut invitation = Invitation {
            relay_url: TRUSTED_RELAY_URL.into(),
            route_id: random_route_id(),
            route_token: random_token(),
            owner_cert_der: owner.cert_der,
            invite_secret: random_token(),
            resource_name: "A100".into(),
            reusable: true,
        };
        let encoded = encode_invitation(&invitation).unwrap();
        assert!(encoded.starts_with(INVITATION_V2_PREFIX));
        assert_eq!(
            (
                decode_invitation(&encoded).unwrap().route_id,
                decode_invitation(&encoded).unwrap().reusable,
            ),
            (invitation.route_id.clone(), true)
        );
        invitation.reusable = false;
        let encoded = encode_invitation(&invitation).unwrap();
        assert!(encoded.starts_with(INVITATION_V1_PREFIX));
        assert!(!decode_invitation(&encoded).unwrap().reusable);
        invitation.relay_url = "https://attacker.invalid".into();
        assert!(encode_invitation(&invitation).is_err());
        assert!(decode_invitation(&"x".repeat(20_000)).is_err());
    }
}
