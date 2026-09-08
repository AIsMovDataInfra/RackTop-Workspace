use super::{
    auth, identity,
    operations::{GatewayOps, OperationScope, SharedTerminalEvent},
    protocol::{read_frame, write_frame},
    runtime::{OwnerConnection, SharingRuntime},
    store::now_ms,
    transport::{HostTicket, RelayClient},
    wire::Wire,
};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::{
    sync::{mpsc, watch},
    task::JoinSet,
};

// One authenticated device, one fixed resource. No guest-supplied SSH settings
// or local command names cross this dispatch boundary.
pub async fn serve(
    runtime: Arc<SharingRuntime>,
    relay: RelayClient,
    ticket: HostTicket,
) -> Result<(), String> {
    let persisted = runtime.store.snapshot()?;
    let active = persisted.shares.iter().any(|s| {
        !s.paused
            && s.expires_at > now_ms()
            && (s.members.iter().any(|m| m.route_id == ticket.route_id)
                || s.invitations
                    .iter()
                    .any(|i| i.route_id == ticket.route_id && i.expires_at > now_ms()))
    });
    if !active {
        return Err("共享授权已失效".into());
    }
    let identity = persisted.owner_identity.as_ref().ok_or("共享网关未配置")?;
    let mut stream = relay.connect_host(&ticket, identity).await?;
    let nonce = identity::random_token();
    write_frame(
        &mut stream,
        &Wire::Challenge {
            nonce: nonce.clone(),
        },
    )
    .await?;
    let authentication =
        tokio::time::timeout(Duration::from_secs(10), read_frame::<_, Wire>(&mut stream))
            .await
            .map_err(|_| "设备认证超时")??;
    let Wire::Authenticate {
        public_key,
        signature,
        device_name,
        invite_secret,
    } = authentication
    else {
        return Err("设备认证消息无效".into());
    };
    let (share, member) = match auth::authenticate(
        &runtime.store,
        &ticket.route_id,
        &public_key,
        &signature,
        &nonce,
        invite_secret.as_deref(),
        &device_name,
    ) {
        Ok(value) => value,
        Err(message) => {
            let _ = write_frame(&mut stream, &Wire::Rejected { message }).await;
            return Ok(());
        }
    };
    // Pairing changes an invitation route into a device route without handing
    // out another capability. Extend its lifetime before confirming pairing.
    relay
        .register_route(
            persisted.owner_token.as_deref().ok_or("共享网关未配置")?,
            &member.route_id,
            &member.route_token,
            share.expires_at,
        )
        .await?;
    let (server, passwords) = (runtime.context)(&share.server_id)?;
    let scope = OperationScope {
        peer_id: member.id.clone(),
        share_id: share.id.clone(),
    };
    let (events, mut event_rx) = mpsc::channel(32);
    let ops = Arc::new(GatewayOps::new(
        server,
        passwords,
        scope.clone(),
        share.default_path.clone(),
        events,
    )?);
    let generation = uuid::Uuid::new_v4().to_string();
    let (stop, mut stopped) = watch::channel(false);
    {
        let mut peers = runtime.peers.lock().map_err(|_| "共享状态不可用")?;
        if let Some(previous) = peers.insert(
            member.id.clone(),
            OwnerConnection {
                generation: generation.clone(),
                share_id: share.id.clone(),
                stop: stop.clone(),
            },
        ) {
            let _ = previous.stop.send(true);
        }
    }
    let result = async {
        auth::authorize_request(&runtime.store, &share.id, &member.id, &public_key, "session.ping")?;
        write_frame(&mut stream, &Wire::Authenticated { member_id: member.id.clone(), resource_name: share.name.clone(),
            expires_at: share.expires_at, capabilities: share.capabilities }).await?;
        let (mut reader, mut writer) = tokio::io::split(stream);
        let (incoming_tx, mut incoming_rx) = mpsc::channel(8);
        let mut reader_stopped = stopped.clone();
        let reader_task = tokio::spawn(async move {
            loop {
                // Never cancel a partial frame for an unrelated timer or event.
                let frame = tokio::select! {
                    _ = reader_stopped.changed() => break,
                    frame = read_frame::<_, Wire>(&mut reader) => frame,
                };
                let failed=frame.is_err();
                if incoming_tx.send(frame).await.is_err() || failed { break; }
            }
        });
        let (outgoing, mut output) = mpsc::channel::<Wire>(32);
        let writer_stop = stop.clone();
        let mut writer_stopped = stopped.clone();
        let writer_task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = writer_stopped.changed() => break,
                    item = output.recv() => {
                        let Some(item) = item else { break };
                        if tokio::time::timeout(Duration::from_secs(30), write_frame(&mut writer, &item)).await
                            .map_or(true, |r| r.is_err()) { break; }
                    }
                }
            }
            let _ = writer_stop.send(true);
        });
        let mut jobs = JoinSet::new();
        let mut validity = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                _ = stopped.changed() => break,
                _ = validity.tick() => {
                    if runtime.is_shutdown() || auth::authorize_request(&runtime.store, &share.id, &member.id, &public_key, "session.ping").is_err() { break; }
                }
                Some(_) = jobs.join_next(), if !jobs.is_empty() => {},
                event = event_rx.recv() => {
                    let Some(event) = event else { break };
                    let item = match event {
                        SharedTerminalEvent::Data {session_id, data_base64} => Wire::Event {kind:"terminalData".into(),data:json!({"sessionId":session_id,"dataBase64":data_base64})},
                        SharedTerminalEvent::Exit {session_id} => Wire::Event {kind:"terminalExit".into(),data:json!({"sessionId":session_id})},
                    };
                    if outgoing.try_send(item).is_err() { break; }
                }
                incoming = incoming_rx.recv() => {
                    let Some(Ok(Wire::Request {id,method,params})) = incoming else { break };
                    if id.len()>64 || id.is_empty() || !params.is_object() { break; }
                    if method=="session.ping" {
                        let allowed=auth::authorize_request(&runtime.store,&share.id,&member.id,&public_key,&method);
                        let response=match allowed {
                            Ok(_)=>Wire::Response{id,result:Some(json!({"ok":true})),error:None},
                            Err(error)=>Wire::Response{id,result:None,error:Some(error)},
                        };
                        if outgoing.try_send(response).is_err(){break}
                        continue;
                    }
                    if jobs.len()>=8 {
                        if outgoing.try_send(Wire::Response{id,result:None,error:Some("共享操作繁忙，请稍后重试".into())}).is_err(){break}
                        continue;
                    }
                    let allowed = auth::authorize_request(&runtime.store, &share.id, &member.id, &public_key, &method);
                    let runtime=runtime.clone(); let ops=ops.clone(); let scope=scope.clone();
                    let outgoing=outgoing.clone(); let stop=stop.clone(); let public_key=public_key.clone();
                    jobs.spawn(async move {
                        let result = async {
                            let share=allowed?;
                            // Recheck after scheduling so revocation cannot leave a queued command runnable.
                            auth::authorize_request(&runtime.store,&scope.share_id,&scope.peer_id,&public_key,&method)?;
                            match method.as_str() {
                                "session.ping" => Ok(json!({"ok":true})),
                                "monitor.snapshot" => runtime.owner_snapshot(&share).await,
                                _ => ops.handle(&scope,&method,&params).await,
                            }
                        }.await;
                        let message=match result {
                            Ok(value)=>Wire::Response{id,result:Some(value),error:None},
                            Err(error)=>Wire::Response{id,result:None,error:Some(error)},
                        };
                        if outgoing.try_send(message).is_err() { let _=stop.send(true); }
                    });
                }
            }
        }
        jobs.abort_all();
        while jobs.join_next().await.is_some() {}
        let _=stop.send(true);
        reader_task.abort(); let _=reader_task.await;
        writer_task.abort(); let _=writer_task.await;
        Ok::<(),String>(())
    }.await;
    // Cleanup is unconditional, including authentication-response write failures.
    let _ = ops.cleanup_scope(&scope).await;
    if let Ok(mut peers) = runtime.peers.lock() {
        if peers
            .get(&member.id)
            .is_some_and(|p| p.generation == generation)
        {
            peers.remove(&member.id);
        }
    }
    result
}
