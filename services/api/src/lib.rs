pub mod admin;
pub mod alchemy;
pub mod auth;
pub mod config;
pub mod db;
pub mod deposits;
pub mod error;
pub mod networks;
pub mod payments;
pub mod security;
pub mod solana;
pub mod solana_deposits;
pub mod state;
pub mod transaction;
pub mod wallet;
pub mod wallet_validation;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    middleware,
    routing::{get, post},
};
use serde_json::json;
use state::AppState;
fn api() -> Router<AppState> {
    Router::new()
        .route("/capabilities", get(capabilities))
        .route("/admin/:section", get(admin::list))
        .route("/admin/:section/:id", axum::routing::patch(admin::toggle))
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/password", post(auth::change_password))
        .route("/auth/revoke-sessions", post(auth::revoke_other_sessions))
        .route("/auth/me", get(auth::me))
        .route("/users/me", get(auth::me).patch(auth::update_profile))
        .route(
            "/wallets",
            get(wallet::list_wallets).post(wallet::create_wallet),
        )
        .route("/wallets/challenge", post(wallet::challenge))
        .route("/wallets/:id", get(wallet::get_wallet))
        .route("/wallets/:id/balances", get(wallet::get_wallet_balances))
        .route(
            "/transactions",
            get(transaction::list_transactions).post(transaction::create_transaction),
        )
        .route("/transactions/:id/rpc", post(transaction::wallet_operation))
        .route("/transactions/:id", get(transaction::get_transaction))
        .route(
            "/payments",
            get(payments::list_payments).post(payments::create_payment),
        )
        .route("/payments/offramp", get(payments::offramp_availability))
        .route("/payments/stripe/webhook", post(payments::webhook))
}
pub fn app(state: AppState) -> Router {
    let mut routes = Router::new().nest("/api/v1", api().with_state(state.clone()));
    for provider in &state.config.providers {
        let scoped = state
            .for_network(&provider.network)
            .expect("validated network");
        routes = routes.nest(
            &format!("/api/v1/networks/{}", provider.network),
            api().with_state(scoped),
        );
    }
    routes
        .route("/health", get(|| async { Json(json!({ "status": "ok" })) }))
        .route("/ready", get(ready).with_state(state.clone()))
        .fallback(|| async { error::ApiError::new("NOT_FOUND", "Endpoint not found.") })
        .layer(DefaultBodyLimit::max(65_536))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security::request_controls,
        ))
}
async fn ready(State(state): State<AppState>) -> (StatusCode, Json<serde_json::Value>) {
    let database = sqlx::query("SELECT 1").execute(&state.pool).await.is_ok();
    let providers = state.config.transfers_enabled();
    let ready = database && providers;
    (
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(
            json!({ "status": if ready { "ready" } else { "not_ready" }, "database": database, "wallet_configuration": providers, "onramp": state.config.onramp_enabled(), "offramp": false }),
        ),
    )
}
async fn capabilities(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(
        json!({ "networks": state.config.providers.iter().map(|p| json!({"id": p.network, "label": crate::networks::details(&p.network).expect("validated network").2})).collect::<Vec<_>>(), "network_label": crate::networks::details(&state.config.network).expect("validated network").2, "transfers_enabled": state.config.transfers_enabled(), "family": if state.config.is_solana() { "solana" } else { "evm" }, "network": state.config.network, "chain_id": state.config.chain_id, "usdc_address": state.config.usdc_address, "wallet_enabled": state.config.wallet_enabled(), "sponsorship_enabled": state.config.alchemy_policy_id.is_some(), "onramp_enabled": state.config.onramp_enabled(), "stripe_mode": if state.config.stripe_live() { "live" } else { "test" }, "offramp_enabled": false }),
    )
}
