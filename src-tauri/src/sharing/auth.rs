use super::{
    identity,
    store::{Member, OwnedShare, Persisted, ShareStore, now_ms},
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

pub struct Authentication {
    pub share: OwnedShare,
    pub member: Member,
    pub reusable_pairing: bool,
    pub member_created: bool,
}

pub fn active_route_count(data: &Persisted, now: u64) -> usize {
    data.shares
        .iter()
        .filter(|share| !share.paused && share.expires_at > now)
        .map(|share| {
            share.members.len()
                + share
                    .invitations
                    .iter()
                    .filter(|invitation| invitation.expires_at > now)
                    .count()
        })
        .sum()
}

pub fn authenticate(
    store: &ShareStore,
    route_id: &str,
    public_key: &str,
    signature: &str,
    nonce: &str,
    invitation_secret: Option<&str>,
    device_name: &str,
    reusable_invitation: bool,
) -> Result<Authentication, String> {
    let device_name = label(device_name, 80)?;
    identity::verify(
        public_key,
        &authentication_message(nonce, route_id, public_key),
        signature,
    )?;
    store.update(|data| {
        let now = now_ms();
        let active_route_count = active_route_count(data, now);
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
            if reusable_invitation {
                return Err("可重复邀请码只能用于首次配对".into());
            }
            if member.public_key != public_key {
                return Err("此邀请已绑定另一台设备".into());
            }
            member.last_seen_at = Some(now);
            let member = member.clone();
            return Ok(Authentication {
                share: share.clone(),
                member,
                reusable_pairing: false,
                member_created: false,
            });
        }
        let position = share
            .invitations
            .iter()
            .position(|i| i.route_id == route_id && i.expires_at > now)
            .ok_or("邀请码已过期或被兑换")?;
        let invitation = &share.invitations[position];
        if invitation.reusable != reusable_invitation {
            return Err("邀请码版本与资源提供者不匹配，请更新 RackTop 后重试".into());
        }
        let secret = invitation_secret.ok_or("请提供邀请码")?;
        if secret.len() > 128 || invitation.secret_hash != secret_hash(secret) {
            return Err("邀请码无效".into());
        }
        if reusable_invitation {
            if let Some(member) = share.members.iter_mut().find(|m| m.public_key == public_key) {
                member.device_name = device_name;
                member.last_seen_at = Some(now);
                let member = member.clone();
                return Ok(Authentication {
                    share: share.clone(),
                    member,
                    reusable_pairing: true,
                    member_created: false,
                });
            }
        }
        if share.members.len() >= 8 {
            return Err("此共享已达到 8 台设备上限".into());
        }
        if reusable_invitation && active_route_count >= 64 {
            return Err("共享设备及待使用邀请达到 64 个上限".into());
        }
        let (member_route_id, member_route_token) = if reusable_invitation {
            (identity::random_route_id(), identity::random_token())
        } else {
            let invitation = share.invitations.remove(position);
            (invitation.route_id, invitation.route_token)
        };
        let member = Member {
            id: uuid::Uuid::new_v4().to_string(),
            device_name,
            public_key: public_key.into(),
            route_id: member_route_id,
            route_token: member_route_token,
            paired_at: now,
            last_seen_at: Some(now),
        };
        share.members.push(member.clone());
        Ok(Authentication {
            share: share.clone(),
            member,
            reusable_pairing: reusable_invitation,
            member_created: true,
        })
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
                    reusable: false,
                    invite_secret: None,
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
        let authenticated = authenticate(
            &store,
            &route,
            &a.public_key,
            &sig,
            &nonce,
            Some(&secret),
            "Alice",
            false,
        )
        .unwrap();
        let member = authenticated.member;
        let sig_b = sign(&b, &authentication_message(&nonce, &route, &b.public_key)).unwrap();
        assert!(
            authenticate(
                &store,
                &route,
                &b.public_key,
                &sig_b,
                &nonce,
                Some(&secret),
                "Bob",
                false,
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
                "Alice",
                false,
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
                "Guest",
                false,
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
                "Guest",
                false,
            )
            .is_err()
        );
    }

    #[test]
    fn reusable_invite_pairs_multiple_devices_with_independent_routes_and_is_idempotent() {
        let (store, route, secret) = setup();
        store
            .update(|data| {
                data.shares[0].invitations[0].reusable = true;
                data.shares[0].invitations[0].invite_secret = Some(secret.clone());
                Ok(())
            })
            .unwrap();
        let pair = |device: &DeviceIdentity, name: &str| {
            let nonce = random_token();
            let signature = sign(
                device,
                &authentication_message(&nonce, &route, &device.public_key),
            )
            .unwrap();
            authenticate(
                &store,
                &route,
                &device.public_key,
                &signature,
                &nonce,
                Some(&secret),
                name,
                true,
            )
            .unwrap()
        };
        let a = generate_device_identity();
        let b = generate_device_identity();
        let first = pair(&a, "Alice");
        let second = pair(&b, "Bob");
        assert!(first.member_created && second.member_created);
        assert!(first.reusable_pairing && second.reusable_pairing);
        assert_ne!(first.member.route_id, second.member.route_id);
        assert_ne!(first.member.route_id, route);
        assert_ne!(second.member.route_id, route);
        let again = pair(&a, "Alice renamed");
        assert!(!again.member_created);
        assert_eq!(again.member.id, first.member.id);
        assert_eq!(again.member.route_id, first.member.route_id);
        let saved = store.snapshot().unwrap();
        assert_eq!(saved.shares[0].members.len(), 2);
        assert_eq!(saved.shares[0].invitations.len(), 1);
        assert_eq!(saved.shares[0].members[0].device_name, "Alice renamed");
    }

    fn filler_share(id: usize, members: usize) -> OwnedShare {
        OwnedShare {
            id: format!("filler-{id}"),
            server_id: "server".into(),
            name: "Filler".into(),
            expires_at: now_ms() + 60_000,
            default_path: ".".into(),
            capabilities: Capabilities::default(),
            paused: false,
            members: (0..members)
                .map(|member| Member {
                    id: format!("filler-{id}-{member}"),
                    device_name: "Fixture".into(),
                    public_key: format!("fixture-key-{id}-{member}"),
                    route_id: random_route_id(),
                    route_token: random_token(),
                    paired_at: now_ms(),
                    last_seen_at: None,
                })
                .collect(),
            invitations: vec![],
        }
    }

    #[test]
    fn active_route_count_ignores_inactive_shares_and_expired_invitations() {
        let (store, _, _) = setup();
        let now = now_ms();
        store
            .update(|data| {
                data.shares[0].members.push(filler_share(9, 1).members.remove(0));
                data.shares[0].invitations.push(PendingInvitation {
                    route_id: random_route_id(),
                    route_token: random_token(),
                    secret_hash: secret_hash("expired"),
                    expires_at: now.saturating_sub(1),
                    reusable: true,
                    invite_secret: Some("expired".into()),
                });
                let mut paused = filler_share(10, 8);
                paused.paused = true;
                let mut expired = filler_share(11, 8);
                expired.expires_at = now.saturating_sub(1);
                data.shares.extend([paused, expired]);
                Ok(())
            })
            .unwrap();
        assert_eq!(active_route_count(&store.snapshot().unwrap(), now), 2);
    }

    #[test]
    fn route_capacity_rejects_only_new_reusable_members_without_breaking_existing_or_v1() {
        let (store, route, secret) = setup();
        let existing = generate_device_identity();
        store
            .update(|data| {
                data.shares[0].invitations[0].reusable = true;
                data.shares[0].invitations[0].invite_secret = Some(secret.clone());
                data.shares[0].members = (0..7)
                    .map(|index| Member {
                        id: format!("existing-{index}"),
                        device_name: "Existing".into(),
                        public_key: if index == 0 {
                            existing.public_key.clone()
                        } else {
                            format!("existing-key-{index}")
                        },
                        route_id: random_route_id(),
                        route_token: random_token(),
                        paired_at: now_ms(),
                        last_seen_at: None,
                    })
                    .collect();
                data.shares.extend((0..7).map(|index| filler_share(index, 8)));
                Ok(())
            })
            .unwrap();
        let authenticate_device = |device: &DeviceIdentity| {
            let nonce = random_token();
            let signature = sign(
                device,
                &authentication_message(&nonce, &route, &device.public_key),
            )
            .unwrap();
            authenticate(
                &store,
                &route,
                &device.public_key,
                &signature,
                &nonce,
                Some(&secret),
                "Device",
                true,
            )
        };
        assert!(!authenticate_device(&existing).unwrap().member_created);
        assert!(authenticate_device(&generate_device_identity()).is_err());
        assert_eq!(store.snapshot().unwrap().shares[0].members.len(), 7);

        let (legacy_store, legacy_route, legacy_secret) = setup();
        legacy_store
            .update(|data| {
                data.shares.extend((0..7).map(|index| filler_share(index, 8)));
                data.shares.push(filler_share(7, 7));
                Ok(())
            })
            .unwrap();
        let legacy_device = generate_device_identity();
        let nonce = random_token();
        let signature = sign(
            &legacy_device,
            &authentication_message(&nonce, &legacy_route, &legacy_device.public_key),
        )
        .unwrap();
        assert!(
            authenticate(
                &legacy_store,
                &legacy_route,
                &legacy_device.public_key,
                &signature,
                &nonce,
                Some(&legacy_secret),
                "Legacy device",
                false,
            )
            .is_ok()
        );
        let saved = legacy_store.snapshot().unwrap();
        assert!(saved.shares[0].invitations.is_empty());
        assert_eq!(saved.shares[0].members.len(), 1);
    }
}
