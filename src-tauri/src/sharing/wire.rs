use super::store::Capabilities;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Wire {
    Challenge {
        nonce: String,
    },
    Authenticate {
        public_key: String,
        signature: String,
        device_name: String,
        invite_secret: Option<String>,
    },
    AuthenticateReusable {
        public_key: String,
        signature: String,
        device_name: String,
        invite_secret: String,
    },
    Authenticated {
        member_id: String,
        resource_name: String,
        expires_at: u64,
        capabilities: Capabilities,
    },
    AuthenticatedReusable {
        member_id: String,
        resource_name: String,
        expires_at: u64,
        capabilities: Capabilities,
        member_route_id: String,
        member_route_token: String,
    },
    Rejected {
        message: String,
    },
    Request {
        id: String,
        method: String,
        params: Value,
    },
    Response {
        id: String,
        result: Option<Value>,
        error: Option<String>,
    },
    Event {
        kind: String,
        data: Value,
    },
}
