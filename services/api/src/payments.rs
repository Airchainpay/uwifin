use crate::{auth::authorize, error::ApiError, security::audit, state::AppState};
use axum::{Json, body::Bytes, extract::State, http::HeaderMap};
use hmac::{Hmac, KeyInit, Mac};
use serde::Deserialize;
use sha2::Sha256;
pub fn verify_signature(secret: &str, signature: &str, payload: &[u8], now: i64) -> bool {
    let timestamp = signature
        .split(',')
        .filter_map(|part| part.trim().strip_prefix("t="))
        .collect::<Vec<_>>();
    if timestamp.len() != 1 {
        return false;
    }
    let Some(timestamp) = timestamp[0].parse::<i64>().ok() else {
        return false;
    };
    if now.abs_diff(timestamp) > 300 {
        return false;
    }
    for candidate in signature
        .split(',')
        .filter_map(|part| part.trim().strip_prefix("v1="))
    {
        let Ok(bytes) = hex::decode(candidate) else {
            continue;
        };
        let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
            return false;
        };
        mac.update(format!("{timestamp}.").as_bytes());
        mac.update(payload);
        if mac.verify_slice(&bytes).is_ok() {
            return true;
        }
    }
    false
}
#[derive(Deserialize)]
struct Event {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    livemode: bool,
    data: EventData,
}
#[derive(Deserialize)]
struct EventData {
    object: serde_json::Value,
}
#[derive(serde::Serialize, sqlx::FromRow)]
pub struct PaymentResponse {
    id: String,
    user_id: String,
    provider: String,
    provider_reference: Option<String>,
    payment_type: String,
    fiat_currency: String,
    fiat_amount_minor: i64,
    requested_amount_minor: Option<i64>,
    crypto_amount_atomic: i64,
    status: String,
    wallet_id: Option<String>,
    network: Option<String>,
    request_fingerprint: Option<String>,
    created_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreatePayment {
    wallet_id: String,
    amount: String,
    currency: String,
}
pub fn parse_minor(value: &str) -> Result<i64, ApiError> {
    let invalid = || {
        ApiError::new(
            "INVALID_REQUEST",
            "Enter a positive amount with up to two decimal places.",
        )
    };
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || whole.len() > 8
        || !whole.bytes().all(|c| c.is_ascii_digit())
        || fraction.len() > 2
        || !fraction.bytes().all(|c| c.is_ascii_digit())
        || (value.contains('.') && fraction.is_empty())
    {
        return Err(invalid());
    }
    let result = whole.parse::<i64>().map_err(|_| invalid())? * 100
        + format!("{fraction:0<2}")
            .parse::<i64>()
            .map_err(|_| invalid())?;
    if result <= 0 {
        return Err(invalid());
    }
    Ok(result)
}
async fn stripe_request(
    state: &AppState,
    method: reqwest::Method,
    path: &str,
    form: Option<&[(String, String)]>,
    key: Option<&str>,
) -> Result<serde_json::Value, ApiError> {
    let secret = state
        .config
        .stripe_secret_key
        .as_ref()
        .ok_or_else(ApiError::unavailable)?;
    let mut request = state
        .http
        .request(method, format!("{}{path}", state.config.stripe_api_url))
        .basic_auth(secret, Some(""));
    if let Some(form) = form {
        request = request.form(form);
    }
    if let Some(key) = key {
        request = request.header("Idempotency-Key", key);
    }
    let response = request.send().await.map_err(|_| ApiError::unavailable())?;
    if response.status() == reqwest::StatusCode::BAD_REQUEST
        || response.status() == reqwest::StatusCode::FORBIDDEN
    {
        return Err(ApiError::new(
            "PAYMENT_UNAVAILABLE",
            "Stripe cannot offer this purchase. Check your eligibility or try again later.",
        ));
    }
    if !response.status().is_success() {
        return Err(ApiError::unavailable());
    }
    response.json().await.map_err(|_| ApiError::unavailable())
}
fn provider_reference(value: &str) -> Result<&str, ApiError> {
    if !value.starts_with("cos_")
        || value.len() > 255
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
    {
        return Err(ApiError::unavailable());
    }
    Ok(value)
}
async fn get_session(state: &AppState, id: &str) -> Result<serde_json::Value, ApiError> {
    stripe_request(
        state,
        reqwest::Method::GET,
        &format!("/v1/crypto/onramp_sessions/{}", provider_reference(id)?),
        None,
        None,
    )
    .await
}
pub async fn create_payment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreatePayment>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user = authorize(&state, &headers).await?;
    crate::admin::require_enabled(&state).await?;
    state.limits.check(format!("payment:{}", user.id), 5)?;
    if !state.config.onramp_enabled() {
        return Err(ApiError::new(
            "PROVIDER_NOT_CONFIGURED",
            "Card purchases are not available for this wallet yet.",
        ));
    }
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .filter(|key| {
            (8..=128).contains(&key.len())
                && key
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        })
        .ok_or_else(|| ApiError::new("INVALID_REQUEST", "A valid Idempotency-Key is required."))?;
    let amount = parse_minor(&req.amount)?;
    if amount > 1_000_000 || !["USD", "EUR"].contains(&req.currency.as_str()) {
        return Err(ApiError::new(
            "INVALID_REQUEST",
            "Choose USD or EUR and an amount of 10,000 or less.",
        ));
    }
    let wallet = crate::wallet::owned_wallet(&state, &user.id, &req.wallet_id).await?;
    let fingerprint = crate::security::hash(&format!(
        "{}:{}:{}:{}",
        req.wallet_id, req.currency, amount, state.config.network
    ));
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO payments (id, user_id, provider, payment_type, fiat_currency, \
         fiat_amount_minor, requested_amount_minor, crypto_asset, crypto_amount_atomic, status, \
         wallet_id, network, idempotency_key, request_fingerprint, created_at, updated_at) \
         VALUES (?, ?, 'stripe', 'onramp', ?, 0, ?, 'USDC', 0, 'creating', ?, ?, ?, ?, NOW(), NOW()) \
         ON DUPLICATE KEY UPDATE id = id",
    )
    .bind(&id)
    .bind(&user.id)
    .bind(&req.currency)
    .bind(amount)
    .bind(&wallet.id)
    .bind(&state.config.network)
    .bind(key)
    .bind(&fingerprint)
    .execute(&state.pool)
    .await?;
    let record = sqlx::query_as::<_, PaymentResponse>(
        "SELECT * FROM payments WHERE user_id = ? AND idempotency_key = ?",
    )
    .bind(&user.id)
    .bind(key)
    .fetch_one(&state.pool)
    .await?;
    if record.request_fingerprint.as_deref() != Some(&fingerprint) {
        return Err(ApiError::new(
            "CONFLICT",
            "This purchase key was already used for different details.",
        ));
    }
    let session = if let Some(reference) = &record.provider_reference {
        get_session(&state, reference).await?
    } else {
        // Stripe retains keys for at least 24 hours. Never replay a stale ambiguous creation.
        if record.created_at < chrono::Utc::now() - chrono::Duration::hours(23) {
            return Err(ApiError::new(
                "CONFLICT",
                "This purchase requires support review before it can be retried.",
            ));
        }
        let form = vec![
            ("source_currency".into(), req.currency.to_ascii_lowercase()),
            (
                "source_amount".into(),
                format!("{}.{:02}", amount / 100, amount % 100),
            ),
            ("destination_currencies[]".into(), "usdc".into()),
            ("destination_currency".into(), "usdc".into()),
            ("destination_networks[]".into(), "base".into()),
            ("destination_network".into(), "base".into()),
            ("wallet_addresses[base]".into(), wallet.address.clone()),
            ("lock_wallet_address".into(), "true".into()),
            ("metadata[uwifin_payment_id]".into(), record.id.clone()),
            ("metadata[uwifin_user_id]".into(), user.id.clone()),
        ];
        stripe_request(
            &state,
            reqwest::Method::POST,
            "/v1/crypto/onramp_sessions",
            Some(&form),
            Some(&format!("uwifin-onramp-{}", record.id)),
        )
        .await?
    };
    let reference = provider_reference(session["id"].as_str().ok_or_else(ApiError::unavailable)?)?;
    validate_session(
        &session,
        &record.id,
        &user.id,
        &wallet.address,
        state.config.stripe_live(),
    )?;
    sqlx::query(
        "UPDATE payments SET provider_reference = ?, \
         status = CASE WHEN status = 'creating' THEN 'pending' ELSE status END, updated_at = NOW() \
         WHERE id = ? AND (provider_reference IS NULL OR provider_reference = ?)",
    )
    .bind(reference)
    .bind(&record.id)
    .bind(reference)
    .execute(&state.pool)
    .await?;
    let secret = session["client_secret"]
        .as_str()
        .filter(|v| v.starts_with("cos_"))
        .ok_or_else(ApiError::unavailable)?;
    Ok(Json(
        serde_json::json!({ "id": record.id, "client_secret": secret, "publishable_key": state.config.stripe_publishable_key, "status": session["status"] }),
    ))
}
pub fn validate_session(
    session: &serde_json::Value,
    id: &str,
    user: &str,
    address: &str,
    live: bool,
) -> Result<(), ApiError> {
    let details = &session["transaction_details"];
    let destination = details["wallet_address"]
        .as_str()
        .or_else(|| details["wallet_addresses"]["base"].as_str());
    if session["object"] != "crypto.onramp_session"
        || session["metadata"]["uwifin_payment_id"] != id
        || session["metadata"]["uwifin_user_id"] != user
        || session["livemode"].as_bool() != Some(live)
        || details["lock_wallet_address"] != true
        || details["destination_currency"] != "usdc"
        || details["destination_network"] != "base"
        || !destination.is_some_and(|wallet| wallet.eq_ignore_ascii_case(address))
    {
        return Err(ApiError::new(
            "PAYMENT_MISMATCH",
            "The payment destination could not be verified.",
        ));
    }
    Ok(())
}
pub async fn webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    let secret = state
        .config
        .stripe_webhook_secret
        .as_ref()
        .ok_or_else(ApiError::unavailable)?;
    let signature = headers
        .get("stripe-signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !verify_signature(secret, signature, &body, chrono::Utc::now().timestamp()) {
        return Err(ApiError::new(
            "INVALID_REQUEST",
            "Invalid webhook signature.",
        ));
    }
    let event: Event = serde_json::from_slice(&body)
        .map_err(|_| ApiError::new("INVALID_REQUEST", "Invalid webhook payload."))?;
    if event.id.is_empty()
        || event.id.len() > 255
        || event.kind.len() > 100
        || event.livemode != state.config.stripe_live()
    {
        return Err(ApiError::new(
            "INVALID_REQUEST",
            "Webhook mode or identity mismatch.",
        ));
    }
    let seen: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM webhook_events WHERE id = ?")
        .bind(&event.id)
        .fetch_one(&state.pool)
        .await?;
    if seen > 0 || event.kind != "crypto.onramp_session_updated" {
        return Ok(Json(serde_json::json!({"received": true})));
    }
    let reference = provider_reference(
        event.data.object["id"]
            .as_str()
            .ok_or_else(ApiError::unavailable)?,
    )?;
    // Retrieve authoritative current state, making out-of-order event delivery harmless.
    let session = get_session(&state, reference).await?;
    apply_session(&state, &session, Some((&event.id, &event.kind))).await?;
    Ok(Json(serde_json::json!({ "received": true })))
}
async fn apply_session(
    state: &AppState,
    session: &serde_json::Value,
    event: Option<(&str, &str)>,
) -> Result<(), ApiError> {
    let id = session["metadata"]["uwifin_payment_id"]
        .as_str()
        .ok_or_else(ApiError::unavailable)?;
    let reference = provider_reference(session["id"].as_str().ok_or_else(ApiError::unavailable)?)?;
    let mut tx = state.pool.begin().await?;
    let record = sqlx::query_as::<_, PaymentResponse>(
        "SELECT * FROM payments WHERE id = ? AND provider = 'stripe' FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(ApiError::unavailable)?;
    if record
        .provider_reference
        .as_ref()
        .is_some_and(|saved| saved != reference)
    {
        return Err(ApiError::unavailable());
    }
    let wallet = crate::wallet::owned_wallet(
        state,
        &record.user_id,
        record
            .wallet_id
            .as_deref()
            .ok_or_else(ApiError::unavailable)?,
    )
    .await?;
    validate_session(
        session,
        id,
        &record.user_id,
        &wallet.address,
        state.config.stripe_live(),
    )?;
    if let Some((event_id, kind)) = event {
        let inserted =
            sqlx::query("INSERT IGNORE INTO webhook_events (id, event_type) VALUES (?, ?)")
                .bind(event_id)
                .bind(kind)
                .execute(&mut *tx)
                .await?;
        if inserted.rows_affected() == 0 {
            tx.commit().await?;
            return Ok(());
        }
    }
    let status = match session["status"].as_str() {
        Some("fulfillment_complete") => "confirmed",
        Some("rejected") => "failed",
        Some("fulfillment_processing") => "processing",
        Some("initialized" | "requires_payment") => "pending",
        _ => return Err(ApiError::unavailable()),
    };
    let is_terminal = ["confirmed", "failed"].contains(&record.status.as_str());
    let would_regress = record.status == "processing" && status == "pending";
    if !(is_terminal || would_regress) {
        let details = &session["transaction_details"];
        let actual_fiat = details["source_amount"]
            .as_str()
            .filter(|s| !s.bytes().all(|c| c == b'0' || c == b'.'))
            .map(parse_minor)
            .transpose()?
            .unwrap_or(0);
        let actual_crypto = details["destination_amount"]
            .as_str()
            .filter(|s| !s.bytes().all(|c| c == b'0' || c == b'.'))
            .map(crate::transaction::parse_amount)
            .transpose()?
            .unwrap_or(0);
        let currency = details["source_currency"]
            .as_str()
            .unwrap_or(&record.fiat_currency)
            .to_ascii_uppercase();
        if !["USD", "EUR"].contains(&currency.as_str())
            || (status == "confirmed" && (actual_fiat == 0 || actual_crypto == 0))
        {
            return Err(ApiError::unavailable());
        }
        sqlx::query(
            "UPDATE payments SET status = ?, provider_reference = ?, fiat_currency = ?, \
             fiat_amount_minor = ?, crypto_amount_atomic = ?, updated_at = NOW() WHERE id = ?",
        )
        .bind(status)
        .bind(reference)
        .bind(currency)
        .bind(actual_fiat)
        .bind(actual_crypto)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        audit(&mut tx, &record.user_id, "payment.status_verified").await?;
    }
    tx.commit().await?;
    Ok(())
}
pub async fn list_payments(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user = authorize(&state, &headers).await?;
    let records = sqlx::query_as::<_, PaymentResponse>(
        "SELECT * FROM payments WHERE user_id = ? AND network = ? ORDER BY created_at DESC LIMIT 100",
    )
    .bind(user.id)
    .bind(&state.config.network)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        serde_json::json!({ "payments": records.iter().map(|record| serde_json::json!({ "id": record.id, "status": record.status, "fiat_currency": record.fiat_currency, "fiat_amount_minor": record.fiat_amount_minor.to_string(), "crypto_amount_atomic": record.crypto_amount_atomic.to_string(), "created_at": record.created_at })).collect::<Vec<_>>() }),
    ))
}
pub async fn reconcile_pending(state: &AppState) -> Result<(), ApiError> {
    if state.config.network != "base" {
        return Ok(());
    }
    if !state.config.onramp_enabled() {
        return Ok(());
    }
    let references: Vec<String> = sqlx::query_scalar(
        "SELECT provider_reference FROM payments WHERE provider = 'stripe' \
         AND provider_reference IS NOT NULL AND status IN ('pending','processing') \
         ORDER BY updated_at LIMIT 25",
    )
    .fetch_all(&state.pool)
    .await?;
    for reference in references {
        if let Ok(session) = get_session(state, &reference).await {
            let _ = apply_session(state, &session, None).await;
        }
    }
    Ok(())
}
pub async fn offramp_availability(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&state, &headers).await?;
    Ok(Json(
        serde_json::json!({ "available": false, "code": "PAYOUT_PROVIDER_REQUIRED", "message": "Cash-out to a bank or e-wallet is not available yet. Stripe Connect stablecoin payouts do not convert your wallet balance to fiat." }),
    ))
}
