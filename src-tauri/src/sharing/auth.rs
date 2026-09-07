use super::{
    identity,
    store::{Member, OwnedShare, ShareStore, now_ms},
};
use sha2::{Digest, Sha256};

pub fn secret_hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub fn authentication_message(nonce: &str, route_id: &str, public_key: &str) -> Vec<u8> {
    serde_json::to_vec(&("racktop-share-device-v1", nonce, route_id, public_key)).unwrap()
}

pub fn label(value: &str, maximum: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > maximum || value.chars().any(char::is_control) {
        return Err("名称为空、过长或包含控制字符".into());
    }
    Ok(value.into())
}

pub fn authenticate(
    store: &ShareStore,
    route_id: &str,
    public_key: &str,
    signature: &str,
    nonce: &str,
    invitation_secret: Option<&str>,
    device_name: &str,
) -> Result<(OwnedShare, Member), String> {
    let device_name = label(device_name, 80)?;
    identity::verify(
        public_key,
        &authentication_message(nonce, route_id, public_key),
        signature,
    )?;
    store.update(|data| {
        let now = now_ms();
        let share = data
            .shares
            .iter_mut()
            .find(|s| {
                s.members.iter().any(|m| m.route_id == route_id)
                    || s.invitations.iter().any(|i| i.route_id == route_id)
            })
            .ok_or("邀请或成员授权已失效")?;
        if share.paused || share.expires_at <= now {
            return Err("资源共享已暂停或过期".into());
        }
        if let Some(member) = share.members.iter_mut().find(|m| m.route_id == route_id) {
            if member.public_key != public_key {
                return Err("此邀请已绑定另一台设备".into());
            }
            member.last_seen_at = Some(now);
            let member = member.clone();
            return Ok((share.clone(), member));
        }
        let position = share
            .invitations
            .iter()
            .position(|i| i.route_id == route_id && i.expires_at > now)
            .ok_or("邀请码已过期或被兑换")?;
        let invitation = &share.invitations[position];
        let secret = invitation_secret.ok_or("请提供一次性邀请码")?;
        if secret.len() > 128 || invitation.secret_hash != secret_hash(secret) {
            return Err("邀请码无效".into());
        }
        if share.members.len() >= 8 {
            return Err("此共享已达到 8 台设备上限".into());
        }
        let invitation = share.invitations.remove(position);
        let member = Member {
            id: uuid::Uuid::new_v4().to_string(),
            device_name,
            public_key: public_key.into(),
            route_id: invitation.route_id,
            route_token: invitation.route_token,
            paired_at: now,
            last_seen_at: Some(now),
        };
        share.members.push(member.clone());
        Ok((share.clone(), member))
    })
}

pub fn authorize_request(
    store: &ShareStore,
    share_id: &str,
    member_id: &str,
    public_key: &str,
    method: &str,
) -> Result<OwnedShare, String> {
    let data = store.snapshot()?;
    let share = data
        .shares
        .into_iter()
        .find(|s| s.id == share_id)
        .ok_or("资源共享已移除")?;
    if share.paused || share.expires_at <= now_ms() {
        return Err("资源共享已暂停或过期".into());
    }
    if !share
        .members
        .iter()
        .any(|m| m.id == member_id && m.public_key == public_key)
    {
        return Err("成员访问已撤销".into());
    }
    let allowed = match method {
        "monitor.snapshot" => share.capabilities.monitor,
        "terminal.start" | "terminal.write" | "terminal.resize" | "terminal.close" => {
            share.capabilities.terminal
        }
        "files.list" | "files.read_open" | "files.read_chunk" | "files.read_close"
        | "files.write_open" | "files.write_chunk" | "files.write_commit"
        | "files.write_cancel" => share.capabilities.files,
        "session.ping" => true,
        _ => false,
    };
    if !allowed {
        return Err("此共享未开放该操作".into());
    }
    Ok(share)
}

#[cfg(test)]
mod tests {
    use super::super::{identity::*, store::*};
    use super::*;
    fn setup() -> (ShareStore, String, String) {
        let route = random_route_id();
        let secret = random_token();
        let store = ShareStore::memory(Persisted {
            shares: vec![OwnedShare {
                id: "s".into(),
                server_id: "server".into(),
                name: "GPU".into(),
                expires_at: now_ms() + 60_000,
                default_path: ".".into(),
                capabilities: Capabilities {
                    monitor: true,
                    terminal: false,
                    files: true,
                },
                paused: false,
                members: vec![],
                invitations: vec![PendingInvitation {
                    route_id: route.clone(),
                    route_token: random_token(),
                    secret_hash: secret_hash(&secret),
                    expires_at: now_ms() + 30_000,
                }],
            }],
            ..Persisted::default()
        });
        (store, route, secret)
    }
    #[test]
    fn invite_is_device_bound_replay_fails_and_revocation_is_authoritative() {
        let (store, route, secret) = setup();
        let a = generate_device_identity();
        let b = generate_device_identity();
        let nonce = random_token();
        let sig = sign(&a, &authentication_message(&nonce, &route, &a.public_key)).unwrap();
        let (_, member) = authenticate(
            &store,
            &route,
            &a.public_key,
            &sig,
            &nonce,
            Some(&secret),
            "Alice",
        )
        .unwrap();
        let sig_b = sign(&b, &authentication_message(&nonce, &route, &b.public_key)).unwrap();
        assert!(
            authenticate(
                &store,
                &route,
                &b.public_key,
                &sig_b,
                &nonce,
                Some(&secret),
                "Bob"
            )
            .is_err()
        );
        assert!(
            authenticate(
                &store,
                &route,
                &a.public_key,
                &sig,
                &random_token(),
                None,
                "Alice"
            )
            .is_err()
        );
        assert!(
            authorize_request(&store, "s", &member.id, &a.public_key, "monitor.snapshot").is_ok()
        );
        assert!(
            authorize_request(&store, "s", &member.id, &a.public_key, "terminal.start").is_err()
        );
        assert!(authorize_request(&store, "s", &member.id, &a.public_key, "save_server").is_err());
        assert!(
            authorize_request(
                &store,
                "other",
                &member.id,
                &a.public_key,
                "monitor.snapshot"
            )
            .is_err()
        );
        store
            .update(|d| {
                d.shares[0].members.clear();
                Ok(())
            })
            .unwrap();
        assert!(
            authorize_request(&store, "s", &member.id, &a.public_key, "monitor.snapshot").is_err()
        );
    }
    #[test]
    fn paused_or_expired_shares_cannot_pair() {
        let (store, route, secret) = setup();
        let device = generate_device_identity();
        let nonce = random_token();
        let signature = sign(
            &device,
            &authentication_message(&nonce, &route, &device.public_key),
        )
        .unwrap();
        store
            .update(|s| {
                s.shares[0].paused = true;
                Ok(())
            })
            .unwrap();
        assert!(
            authenticate(
                &store,
                &route,
                &device.public_key,
                &signature,
                &nonce,
                Some(&secret),
                "Guest"
            )
            .is_err()
        );
        store
            .update(|s| {
                s.shares[0].paused = false;
                s.shares[0].expires_at = 1;
                Ok(())
            })
            .unwrap();
        assert!(
            authenticate(
                &store,
                &route,
                &device.public_key,
                &signature,
                &nonce,
                Some(&secret),
                "Guest"
            )
            .is_err()
        );
    }
}
