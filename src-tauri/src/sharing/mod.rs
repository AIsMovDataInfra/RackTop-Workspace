pub mod auth;
pub mod client;
pub mod commands;
mod gateway;
pub mod identity;
pub mod operations;
pub mod protocol;
pub mod runtime;
pub mod store;
pub mod transfers;
pub mod transport;
pub mod wire;

pub struct SharingManager(pub std::sync::Arc<runtime::SharingRuntime>);
