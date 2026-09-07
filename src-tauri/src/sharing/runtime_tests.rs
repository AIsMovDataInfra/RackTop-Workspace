use super::*;
use std::sync::atomic::AtomicUsize;

fn member(id: &str) -> Member {
    Member {
        id: id.into(),
        device_name: id.into(),
        public_key: format!("public-{id}"),
        route_id: identity::random_route_id(),
        route_token: identity::random_token(),
        paired_at: now_ms(),
        last_seen_at: None,
    }
}
fn share(id: &str, members: Vec<Member>) -> OwnedShare {
    OwnedShare {
        id: id.into(),
        server_id: format!("original-server-{id}"),
        name: id.into(),
        expires_at: now_ms() + 60_000,
        default_path: ".".into(),
        capabilities: Capabilities {
            monitor: true,
            terminal: true,
            files: true,
        },
        paused: false,
        members,
        invitations: vec![],
    }
}
fn received(id: &str) -> ReceivedShare {
    ReceivedShare {
        id: id.into(),
        name: "Guest item".into(),
        owner_label: "Owner".into(),
        expires_at: now_ms() + 60_000,
        default_path: ".".into(),
        capabilities: Capabilities::default(),
        relay_url: DEFAULT_RELAY.into(),
        route_id: identity::random_route_id(),
        route_token: identity::random_token(),
        owner_cert_der: "test-fixture-never-connected".into(),
        member_id: "remote-member".into(),
        device_name: "Fixture".into(),
    }
}
fn runtime(data: Persisted) -> (Arc<SharingRuntime>, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let called = calls.clone();
    let runtime = SharingRuntime::new(
        ShareStore::memory(data),
        Arc::new(move |_| {
            called.fetch_add(1, Ordering::Relaxed);
            Err("Local SSH server context must not be reached by this lifecycle action".into())
        }),
        Arc::new(|_, _| {}),
    );
    (runtime, calls)
}
fn owner_peer(runtime: &SharingRuntime, share: &str, member: &str) -> watch::Receiver<bool> {
    let (stop, stopped) = watch::channel(false);
    runtime.peers.lock().unwrap().insert(
        member.into(),
        OwnerConnection {
            generation: uuid::Uuid::new_v4().to_string(),
            share_id: share.into(),
            stop,
        },
    );
    stopped
}
fn guest_peer(runtime: &SharingRuntime, id: &str, generation: &str) -> watch::Receiver<bool> {
    let (stop, stopped) = watch::channel(false);
    runtime.guests.lock().unwrap().insert(
        id.into(),
        GuestConnection {
            generation: generation.into(),
            state: "connecting".into(),
            last_error: None,
            session: None,
            stop,
        },
    );
    stopped
}

#[tokio::test]
async fn pausing_denies_requests_and_signals_only_that_shares_sessions_before_returning() {
    let a = member("a");
    let b = member("b");
    let (runtime, calls) = runtime(Persisted {
        shares: vec![share("first", vec![a.clone()]), share("second", vec![b])],
        ..Persisted::default()
    });
    let first = owner_peer(&runtime, "first", "a");
    let second = owner_peer(&runtime, "second", "b");
    assert!(
        auth::authorize_request(
            &runtime.store,
            "first",
            "a",
            &a.public_key,
            "terminal.start"
        )
        .is_ok()
    );
    runtime.pause("first".into(), true).await.unwrap();
    assert!(*first.borrow());
    assert!(!*second.borrow());
    assert!(
        auth::authorize_request(
            &runtime.store,
            "first",
            "a",
            &a.public_key,
            "terminal.start"
        )
        .is_err()
    );
    runtime.pause("first".into(), false).await.unwrap();
    // Resume permits a new connection, never revives the old SSH/transport session.
    assert!(*first.borrow());
    assert!(
        auth::authorize_request(
            &runtime.store,
            "first",
            "a",
            &a.public_key,
            "terminal.start"
        )
        .is_ok()
    );
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn revoking_a_member_signals_only_that_device_and_removes_its_authority() {
    let a = member("a");
    let b = member("b");
    let (runtime, calls) = runtime(Persisted {
        shares: vec![share("first", vec![a.clone(), b.clone()])],
        ..Persisted::default()
    });
    let first = owner_peer(&runtime, "first", "a");
    let second = owner_peer(&runtime, "first", "b");
    runtime
        .revoke_member("first".into(), "a".into())
        .await
        .unwrap();
    assert!(*first.borrow());
    assert!(!*second.borrow());
    for method in [
        "session.ping",
        "monitor.snapshot",
        "terminal.write",
        "files.write_commit",
    ] {
        assert!(
            auth::authorize_request(&runtime.store, "first", "a", &a.public_key, method).is_err()
        );
        assert!(
            auth::authorize_request(&runtime.store, "first", "b", &b.public_key, method).is_ok()
        );
    }
    assert!(
        runtime
            .revoke_member("first".into(), "missing".into())
            .await
            .is_err()
    );
    assert!(!*second.borrow());
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn deleting_a_share_stops_its_devices_and_preserves_other_share_and_guest_records() {
    let (runtime, calls) = runtime(Persisted {
        shares: vec![
            share("first", vec![member("a")]),
            share("second", vec![member("b")]),
        ],
        received: vec![received("guest")],
        ..Persisted::default()
    });
    let first = owner_peer(&runtime, "first", "a");
    let second = owner_peer(&runtime, "second", "b");
    runtime.delete("first".into()).await.unwrap();
    assert!(*first.borrow());
    assert!(!*second.borrow());
    let data = runtime.store.snapshot().unwrap();
    assert_eq!(data.shares.len(), 1);
    assert_eq!(data.shares[0].id, "second");
    assert_eq!(data.received.len(), 1);
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn guest_forget_cannot_delete_owner_share_even_with_matching_id_or_resolve_owner_server() {
    let (runtime, calls) = runtime(Persisted {
        shares: vec![share("same-id", vec![member("a")])],
        received: vec![received("same-id"), received("other")],
        ..Persisted::default()
    });
    let owner = owner_peer(&runtime, "same-id", "a");
    let guest = guest_peer(&runtime, "same-id", "generation");
    let other = guest_peer(&runtime, "other", "other-generation");
    runtime.forget("same-id".into()).await.unwrap();
    assert!(*guest.borrow());
    assert!(!*owner.borrow());
    assert!(!*other.borrow());
    let data = runtime.store.snapshot().unwrap();
    assert_eq!(data.shares.len(), 1);
    assert_eq!(data.shares[0].server_id, "original-server-same-id");
    assert_eq!(data.received.len(), 1);
    assert_eq!(data.received[0].id, "other");
    assert!(!runtime.guests.lock().unwrap().contains_key("same-id"));
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn disconnect_preserves_saved_guest_and_stale_generation_cannot_overwrite_new_connection() {
    let (runtime, _) = runtime(Persisted {
        received: vec![received("guest")],
        ..Persisted::default()
    });
    let stopped = guest_peer(&runtime, "guest", "new-generation");
    assert!(!runtime.guest_state(
        "guest",
        "old-generation",
        "error",
        Some("late failure".into()),
        None
    ));
    let status = runtime.status().await.unwrap();
    assert_eq!(status["received"][0]["state"], "connecting");
    assert!(!*stopped.borrow());
    runtime.disconnect("guest".into()).await.unwrap();
    assert!(*stopped.borrow());
    assert_eq!(runtime.store.snapshot().unwrap().received.len(), 1);
    assert!(!runtime.guest_state("guest", "new-generation", "online", None, None));
}

#[test]
fn shutdown_is_idempotent_and_signals_both_owner_and_guest_without_mutating_saved_grants() {
    let (runtime, calls) = runtime(Persisted {
        shares: vec![share("first", vec![member("a")])],
        received: vec![received("guest")],
        ..Persisted::default()
    });
    let owner = owner_peer(&runtime, "first", "a");
    let guest = guest_peer(&runtime, "guest", "generation");
    runtime.shutdown();
    runtime.shutdown();
    assert!(runtime.is_shutdown());
    assert!(*owner.borrow());
    assert!(*guest.borrow());
    let data = runtime.store.snapshot().unwrap();
    assert_eq!(data.shares[0].members.len(), 1);
    assert_eq!(data.received.len(), 1);
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}

#[test]
fn foreign_devices_unknown_methods_and_expired_grants_never_authorize_operations() {
    let a = member("a");
    let b = member("b");
    let (runtime, calls) = runtime(Persisted {
        shares: vec![
            share("first", vec![a.clone()]),
            share("second", vec![b.clone()]),
        ],
        ..Persisted::default()
    });
    for (share_id, member_id, key, method) in [
        ("first", "a", b.public_key.as_str(), "files.read_open"),
        ("first", "b", b.public_key.as_str(), "terminal.start"),
        ("second", "a", a.public_key.as_str(), "monitor.snapshot"),
        ("first", "a", a.public_key.as_str(), "delete_server"),
        ("first", "a", a.public_key.as_str(), "files.init"),
        ("first", "a", a.public_key.as_str(), "sharing.delete"),
    ] {
        assert!(auth::authorize_request(&runtime.store, share_id, member_id, key, method).is_err());
    }
    runtime
        .store
        .update(|data| {
            data.shares[0].expires_at = 1;
            Ok(())
        })
        .unwrap();
    assert!(
        auth::authorize_request(&runtime.store, "first", "a", &a.public_key, "session.ping")
            .is_err()
    );
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}
