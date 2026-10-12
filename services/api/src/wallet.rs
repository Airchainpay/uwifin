use crate::{
    auth::{authorize, session_token},
    error::ApiError,
    security::{audit, hash},
    state::AppState,
    transaction::format_amount,
    wallet_validation::validate_wallet_address,
};
use alloy_primitives::PrimitiveSignature;
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
// Binary address collations preserve Solana case. SELECT projections cast to the connection
// charset because SQLx otherwise treats these VARCHAR columns as binary data.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct WalletResponse {
    pub id: String,
    pub address: String,
    pub network: String,
    pub wallet_type: String,
    pub signer_address: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}
pub async fn list_wallets(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<WalletResponse>>, ApiError> {
    let user = authorize(&state, &headers).await?;
    Ok(Json(sqlx::query_as("SELECT id, CAST(address AS CHAR) AS address, network, wallet_type, CAST(signer_address AS CHAR) AS signer_address, created_at FROM wallets WHERE user_id = ? AND verified_at IS NOT NULL AND network = ? ORDER BY created_at DESC")
        .bind(user.id).bind(&state.config.network).fetch_all(&state.pool).await?))
}
pub async fn owned_wallet(
    state: &AppState,
    user_id: &str,
    wallet_id: &str,
) -> Result<WalletResponse, ApiError> {
    sqlx::query_as("SELECT id, CAST(address AS CHAR) AS address, network, wallet_type, CAST(signer_address AS CHAR) AS signer_address, created_at FROM wallets WHERE id = ? AND user_id = ? AND verified_at IS NOT NULL AND network = ?")
        .bind(wallet_id).bind(user_id).bind(&state.config.network).fetch_optional(&state.pool).await?
        .ok_or_else(|| ApiError::new("NOT_FOUND", "Wallet not found."))
}
pub async fn get_wallet(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<WalletResponse>, ApiError> {
    let user = authorize(&state, &headers).await?;
    Ok(Json(owned_wallet(&state, &user.id, &id).await?))
}
pub async fn get_wallet_balances(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user = authorize(&state, &headers).await?;
    let wallet = owned_wallet(&state, &user.id, &id).await?;
    let balance = crate::alchemy::usdc_balance(&state, &wallet.address).await?;
    Ok(Json(
        serde_json::json!([{ "asset": "USDC", "network": state.config.network, "balance": format_amount(balance), "contract_address": state.config.usdc_address }]),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChallengeRequest {
    signer_address: String,
}
pub async fn challenge(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ChallengeRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user = authorize(&state, &headers).await?;
    state.limits.check(format!("wallet:{}", user.id), 5)?;
    if !state.config.wallet_enabled() {
        return Err(ApiError::new(
            "PROVIDER_NOT_CONFIGURED",
            "Wallet setup is temporarily unavailable. Please try again later.",
        ));
    }
    let address = if state.config.is_solana() {
        crate::solana::validate_address(&req.signer_address)?
    } else {
        validate_wallet_address(&req.signer_address)?
    };
    let id = uuid::Uuid::new_v4().to_string();
    let expires = chrono::Utc::now() + chrono::Duration::minutes(5);
    let message = format!(
        "UwiFin wallet setup\n\nPrepare your wallet for your UwiFin account. This signature does not transfer funds.\n\nOrigin: {}\nAccount: {}\nSigner: {}\nNetwork: {}\nChallenge: {}\nExpires: {}",
        state.config.app_base_url,
        user.id,
        address,
        state.config.network,
        id,
        expires.to_rfc3339()
    );
    sqlx::query("INSERT INTO wallet_challenges (id, user_id, session_hash, signer_address, message, expires_at, network) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(&id).bind(user.id).bind(hash(session_token(&headers)?)).bind(address).bind(&message).bind(expires).bind(&state.config.network).execute(&state.pool).await?;
    Ok(Json(
        serde_json::json!({ "id": id, "message": message, "expires_at": expires }),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WalletCreateRequest {
    challenge_id: String,
    signature: String,
}
#[derive(sqlx::FromRow)]
struct Challenge {
    signer_address: String,
    message: String,
}
pub fn verify_ownership(message: &str, signature: &str, expected: &str) -> bool {
    PrimitiveSignature::from_str(signature)
        .ok()
        .and_then(|sig| sig.recover_address_from_msg(message.as_bytes()).ok())
        .is_some_and(|address| format!("{address:#x}").eq_ignore_ascii_case(expected))
}
pub async fn create_wallet(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<WalletCreateRequest>,
) -> Result<Json<WalletResponse>, ApiError> {
    let user = authorize(&state, &headers).await?;
    state.limits.check(format!("wallet-link:{}", user.id), 5)?;
    let mut tx = state.pool.begin().await?;
    let challenge = sqlx::query_as::<_, Challenge>("SELECT CAST(signer_address AS CHAR) AS signer_address, message FROM wallet_challenges WHERE id = ? AND user_id = ? AND session_hash = ? AND consumed_at IS NULL AND expires_at > NOW() AND network = ? FOR UPDATE")
        .bind(&req.challenge_id).bind(&user.id).bind(hash(session_token(&headers)?)).bind(&state.config.network).fetch_optional(&mut *tx).await?
        .ok_or_else(|| ApiError::new("INVALID_REQUEST", "This wallet challenge has expired or was already used. Retry wallet setup."))?;
    let verified = if state.config.is_solana() {
        crate::solana::verify_ownership(
            &challenge.message,
            &req.signature,
            &challenge.signer_address,
        )
    } else {
        verify_ownership(
            &challenge.message,
            &req.signature,
            &challenge.signer_address,
        )
    };
    if !verified {
        return Err(ApiError::new(
            "FORBIDDEN",
            "The wallet signature could not be verified.",
        ));
    }
    // Serialize connections for this user and reuse an already verified signing account.
    sqlx::query("SELECT id FROM users WHERE id = ? FOR UPDATE")
        .bind(&user.id)
        .fetch_one(&mut *tx)
        .await?;
    let existing: Option<(String,)> = sqlx::query_as("SELECT id FROM wallets WHERE user_id = ? AND signer_address = ? AND network = ? AND verified_at IS NOT NULL LIMIT 1")
        .bind(&user.id).bind(&challenge.signer_address).bind(&state.config.network).fetch_optional(&mut *tx).await?;
    if let Some((id,)) = existing {
        sqlx::query("UPDATE wallet_challenges SET consumed_at = NOW() WHERE id = ?")
            .bind(&req.challenge_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(Json(owned_wallet(&state, &user.id, &id).await?));
    }
    let (address, provider_id, wallet_type) = if state.config.is_solana() {
        crate::solana::verify_chain(&state).await?;
        (challenge.signer_address.clone(), None, "signing_account")
    } else {
        let response = crate::alchemy::wallet_rpc(&state, "wallet_requestAccount", serde_json::json!([{
        "signerAddress": challenge.signer_address, "creationHint": { "accountType": "sma-b" }
    }])).await?;
        let address = validate_wallet_address(
            response["accountAddress"]
                .as_str()
                .ok_or_else(ApiError::unavailable)?,
        )?;
        let provider_id = response["id"]
            .as_str()
            .filter(|id| id.len() <= 64)
            .ok_or_else(ApiError::unavailable)?;
        (address, Some(provider_id.to_owned()), "smart_account")
    };
    let id = uuid::Uuid::new_v4().to_string();
    let existing: Option<(String, String)> = sqlx::query_as(
        "SELECT id, user_id FROM wallets WHERE address = ? AND network = ? FOR UPDATE",
    )
    .bind(&address)
    .bind(&state.config.network)
    .fetch_optional(&mut *tx)
    .await?;
    let id = if let Some((existing_id, owner)) = existing {
        if owner != user.id {
            return Err(ApiError::new(
                "CONFLICT",
                "This wallet is already connected to another UwiFin account.",
            ));
        }
        existing_id
    } else {
        sqlx::query("INSERT INTO wallets (id, user_id, address, network, wallet_type, signer_address, provider_account_id, verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())")
            .bind(&id).bind(&user.id).bind(&address).bind(&state.config.network).bind(wallet_type).bind(&challenge.signer_address).bind(provider_id).execute(&mut *tx).await?;
        id
    };
    sqlx::query("UPDATE wallet_challenges SET consumed_at = NOW() WHERE id = ?")
        .bind(req.challenge_id)
        .execute(&mut *tx)
        .await?;
    audit(&mut tx, &user.id, "wallet.ownership_verified").await?;
    tx.commit().await?;
    Ok(Json(owned_wallet(&state, &user.id, &id).await?))
}
