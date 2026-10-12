use crate::{
    auth::authorize,
    error::ApiError,
    security::{audit, hash},
    state::AppState,
    wallet::owned_wallet,
    wallet_validation::{validate_network, validate_wallet_address},
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
pub fn parse_amount(value: &str) -> Result<i64, ApiError> {
    let invalid = || {
        ApiError::new(
            "INVALID_REQUEST",
            "Enter a positive amount with at most six decimal places.",
        )
    };
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || whole.len() > 18
        || !whole.bytes().all(|c| c.is_ascii_digit())
        || fraction.len() > 6
        || !fraction.bytes().all(|c| c.is_ascii_digit())
        || (value.contains('.') && fraction.is_empty())
    {
        return Err(invalid());
    }
    let whole = whole.parse::<i64>().map_err(|_| invalid())?;
    let fraction = format!("{fraction:0<6}")
        .parse::<i64>()
        .map_err(|_| invalid())?;
    whole
        .checked_mul(1_000_000)
        .and_then(|amount| amount.checked_add(fraction))
        .filter(|amount| *amount > 0)
        .ok_or_else(invalid)
}
pub fn format_amount(value: u128) -> String {
    format!("{}.{:06}", value / 1_000_000, value % 1_000_000)
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactionStatus {
    Created,
    Validating,
    Ready,
    Submitted,
    Pending,
    Confirmed,
    Failed,
}
impl TransactionStatus {
    pub fn can_transition_to(self, next: Self) -> bool {
        use TransactionStatus::*;
        matches!(
            (self, next),
            (Created, Validating | Failed)
                | (Validating, Ready | Failed)
                | (Ready, Submitted | Failed)
                | (Submitted, Pending | Failed)
                | (Pending, Confirmed | Failed)
        )
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateTransactionRequest {
    pub wallet_id: String,
    pub network: String,
    pub asset: String,
    pub recipient: String,
    pub amount: String,
}
#[derive(Serialize, sqlx::FromRow)]
pub(crate) struct TransactionRecord {
    id: String,
    kind: String,
    status: String,
    tx_hash: Option<String>,
    user_operation_hash: Option<String>,
    gas_used: Option<i64>,
    gas_price: Option<i64>,
    error_code: Option<String>,
    sender: String,
    recipient: String,
    amount_atomic: i64,
    network: String,
    created_at: chrono::DateTime<chrono::Utc>,
    confirmed_at: Option<chrono::DateTime<chrono::Utc>>,
    request_fingerprint: Option<String>,
    wallet_id: String,
    user_id: String,
    call_id: Option<String>,
    prepared_call: Option<sqlx::types::Json<serde_json::Value>>,
    signed_call: Option<sqlx::types::Json<serde_json::Value>>,
    prepared_expires_at: Option<chrono::DateTime<chrono::Utc>>,
}
pub(crate) fn record_json(record: &TransactionRecord) -> serde_json::Value {
    serde_json::json!({
        "id": record.id, "status": record.status.to_ascii_lowercase(), "tx_hash": record.tx_hash,
        "sender": record.sender, "recipient": record.recipient, "address": if record.kind == "received" { &record.sender } else { &record.recipient },
        "asset": "USDC", "amount": format_amount(record.amount_atomic as u128), "amount_atomic": record.amount_atomic.to_string(),
        "network": record.network, "created_at": record.created_at, "confirmed_at": record.confirmed_at,
        "user_operation_hash": record.user_operation_hash, "gas_used": record.gas_used.map(|v| v.to_string()), "gas_price": record.gas_price.map(|v| v.to_string()), "error_code": record.error_code,
        "kind": record.kind, "name": "Wallet transfer", "call_id": record.call_id
    })
}
pub async fn create_transaction(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut req): Json<CreateTransactionRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    let user = authorize(&state, &headers).await?;
    crate::admin::require_enabled(&state).await?;
    state.limits.check(format!("transfer:{}", user.id), 10)?;
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .filter(|key| {
            (8..=128).contains(&key.len())
                && key
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        })
        .ok_or_else(|| {
            ApiError::new(
                "INVALID_REQUEST",
                "A valid Idempotency-Key header is required.",
            )
        })?;
    validate_network(&req.network, &state.config.network)?;
    if req.asset != "USDC" {
        return Err(ApiError::new(
            "UNSUPPORTED_ASSET",
            "Only USDC is supported.",
        ));
    }
    req.recipient = validate_wallet_address(&req.recipient)?;
    let amount = parse_amount(&req.amount)?;
    if amount > state.config.transfer_limit_atomic {
        return Err(ApiError::new(
            "INVALID_REQUEST",
            "This transfer exceeds the permitted amount.",
        ));
    }
    req.amount = format_amount(amount as u128);
    let fingerprint = hash(&serde_json::to_string(&req).map_err(|_| ApiError::unavailable())?);
    let existing = sqlx::query_as::<_, TransactionRecord>(
        "SELECT * FROM transactions WHERE user_id = ? AND idempotency_key = ?",
    )
    .bind(&user.id)
    .bind(key)
    .fetch_optional(&state.pool)
    .await?;
    if let Some(record) = existing {
        if record.request_fingerprint.as_deref() != Some(&fingerprint) {
            return Err(ApiError::new(
                "CONFLICT",
                "This idempotency key was already used for different transfer details.",
            ));
        }
        return Ok((StatusCode::OK, Json(record_json(&record))));
    }
    let wallet = owned_wallet(&state, &user.id, &req.wallet_id).await?;
    if wallet.network != req.network {
        return Err(ApiError::new(
            "UNSUPPORTED_NETWORK",
            "The wallet and transaction networks must match.",
        ));
    }
    if wallet.address.eq_ignore_ascii_case(&req.recipient) {
        return Err(ApiError::new(
            "INVALID_REQUEST",
            "Choose a recipient other than your own wallet.",
        ));
    }
    let asset_id: String = sqlx::query_scalar("SELECT id FROM assets WHERE symbol = 'USDC' AND network = ? AND contract_address = ? AND decimals = 6 AND is_active = TRUE")
        .bind(&state.config.network).bind(&state.config.usdc_address).fetch_optional(&state.pool).await?.ok_or_else(|| ApiError::new("UNSUPPORTED_ASSET", "This asset is currently unavailable."))?;
    if crate::alchemy::usdc_balance(&state, &wallet.address).await? < amount as u128 {
        return Err(ApiError::new(
            "INSUFFICIENT_BALANCE",
            "Insufficient USDC balance.",
        ));
    }
    let mut tx = state.pool.begin().await?;
    let id = uuid::Uuid::new_v4().to_string();
    // UNIQUE(user_id, idempotency_key) makes concurrent retries safe.
    let inserted = sqlx::query("INSERT INTO transactions (id, user_id, wallet_id, network, sender, recipient, asset_id, amount_atomic, status, idempotency_key, request_fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?, NOW(), NOW()) ON DUPLICATE KEY UPDATE id = id")
        .bind(&id).bind(&user.id).bind(&wallet.id).bind(&state.config.network).bind(&wallet.address).bind(&req.recipient).bind(asset_id).bind(amount).bind(key).bind(&fingerprint).execute(&mut *tx).await?;
    let record = sqlx::query_as::<_, TransactionRecord>(
        "SELECT * FROM transactions WHERE user_id = ? AND idempotency_key = ?",
    )
    .bind(&user.id)
    .bind(key)
    .fetch_one(&mut *tx)
    .await?;
    if record.request_fingerprint.as_deref() != Some(&fingerprint) {
        return Err(ApiError::new(
            "CONFLICT",
            "This idempotency key was already used for different transfer details.",
        ));
    }
    if inserted.rows_affected() == 1 && record.id == id {
        audit(&mut tx, &user.id, "transaction.intent_created").await?;
    }
    tx.commit().await?;
    // A new record is only an intent; preparation and signed submission are separate steps.
    Ok((
        if record.id == id {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(record_json(&record)),
    ))
}
pub async fn get_transaction(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user = authorize(&state, &headers).await?;
    let record = sqlx::query_as::<_, TransactionRecord>(
        "SELECT * FROM transactions WHERE id = ? AND user_id = ?",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new("NOT_FOUND", "Transaction not found."))?;
    Ok(Json(record_json(&record)))
}
#[derive(Deserialize)]
pub struct TransactionQuery {
    page: Option<u32>,
    limit: Option<u32>,
    status: Option<String>,
    kind: Option<String>,
    q: Option<String>,
}
pub async fn list_transactions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TransactionQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user = authorize(&state, &headers).await?;
    let page = query.page.unwrap_or(1);
    let limit = query.limit.unwrap_or(20);
    if page == 0 || page > 100_000 || limit == 0 || limit > 100 {
        return Err(ApiError::new(
            "INVALID_REQUEST",
            "Use page >= 1 and limit between 1 and 100.",
        ));
    }
    let status = query.status.map(|status| status.to_ascii_uppercase());
    if status.as_ref().is_some_and(|status| {
        ![
            "CREATED",
            "VALIDATING",
            "READY",
            "SUBMITTED",
            "PENDING",
            "CONFIRMED",
            "FAILED",
        ]
        .contains(&status.as_str())
    }) {
        return Err(ApiError::new(
            "INVALID_REQUEST",
            "Unsupported transaction status.",
        ));
    }
    let kind = query.kind.filter(|value| value != "all");
    if kind
        .as_ref()
        .is_some_and(|value| !["sent", "received"].contains(&value.as_str()))
    {
        return Err(ApiError::new("INVALID_REQUEST", "Invalid transfer type."));
    }
    let search = query.q.unwrap_or_default();
    if search.len() > 128 {
        return Err(ApiError::new("INVALID_REQUEST", "Search is too long."));
    }
    let records = sqlx::query_as::<_, TransactionRecord>("SELECT * FROM transactions WHERE user_id = ? AND (? IS NULL OR status = ?) AND (? IS NULL OR kind = ?) AND (? = '' OR LOCATE(?, CONCAT(id,' ',sender,' ',recipient,' ',COALESCE(tx_hash,''),' USDC Wallet transfer')) > 0) ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?")
        .bind(user.id).bind(&status).bind(&status).bind(&kind).bind(&kind).bind(&search).bind(&search).bind(limit).bind((page-1)*limit).fetch_all(&state.pool).await?;
    Ok(Json(
        serde_json::json!({ "transactions": records.iter().map(record_json).collect::<Vec<_>>(), "page": page, "limit": limit }),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WalletRpcRequest {
    method: String,
    params: serde_json::Value,
}
pub async fn wallet_operation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<WalletRpcRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user = authorize(&state, &headers).await?;
    // Only these three calls exist. The backend constructs every executable call.
    match req.method.as_str() {
        "wallet_prepareCalls" => prepare(&state, &user.id, &id).await.map(Json),
        "wallet_sendPreparedCalls" => submit(&state, &user.id, &id, &req.params).await.map(Json),
        "wallet_getCallsStatus" => {
            reconcile_one(&state, &id, &user.id).await?;
            let record = load_record(&state, &id, &user.id).await?;
            Ok(Json(
                serde_json::json!({ "id": record.call_id, "status": match record.status.as_str() { "CONFIRMED" => 200, "FAILED" => 500, _ => 100 } }),
            ))
        }
        _ => Err(ApiError::new(
            "FORBIDDEN",
            "This wallet operation is not permitted.",
        )),
    }
}
async fn load_record(
    state: &AppState,
    id: &str,
    user: &str,
) -> Result<TransactionRecord, ApiError> {
    sqlx::query_as("SELECT * FROM transactions WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::new("NOT_FOUND", "Transaction not found."))
}
async fn prepare(state: &AppState, user: &str, id: &str) -> Result<serde_json::Value, ApiError> {
    crate::admin::require_enabled(state).await?;
    state.limits.check(format!("prepare:{user}"), 10)?;
    let policy = state.config.alchemy_policy_id.as_ref().ok_or_else(|| {
        ApiError::new(
            "PROVIDER_NOT_CONFIGURED",
            "Sponsored transfers are temporarily unavailable.",
        )
    })?;
    let mut tx = state.pool.begin().await?;
    let record = sqlx::query_as::<_, TransactionRecord>(
        "SELECT * FROM transactions WHERE id = ? AND user_id = ? FOR UPDATE",
    )
    .bind(id)
    .bind(user)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::new("NOT_FOUND", "Transaction not found."))?;
    if record.status == "READY"
        && record
            .prepared_expires_at
            .is_some_and(|expires| expires > chrono::Utc::now())
    {
        return record
            .prepared_call
            .map(|call| call.0)
            .ok_or_else(ApiError::unavailable);
    }
    if !["CREATED", "READY"].contains(&record.status.as_str()) {
        return Err(ApiError::new(
            "CONFLICT",
            "This transfer has already been submitted. Check its status.",
        ));
    }
    let wallet = owned_wallet(state, user, &record.wallet_id).await?;
    if crate::alchemy::usdc_balance(state, &wallet.address).await? < record.amount_atomic as u128 {
        return Err(ApiError::new(
            "INSUFFICIENT_BALANCE",
            "Insufficient USDC balance.",
        ));
    }
    let spent: String = sqlx::query_scalar("SELECT CAST(COALESCE(SUM(amount_atomic), 0) AS CHAR) FROM transactions WHERE user_id = ? AND kind = 'sent' AND status IN ('SUBMITTED','PENDING','CONFIRMED') AND created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)")
        .bind(user).fetch_one(&mut *tx).await?;
    let spent = spent.parse::<i128>().map_err(|_| ApiError::unavailable())?;
    if spent + record.amount_atomic as i128 > state.config.transfer_limit_atomic as i128 * 5 {
        return Err(ApiError::new(
            "RATE_LIMITED",
            "Your daily transfer limit has been reached.",
        ));
    }
    // The generated unique active_wallet_id prevents overlapping signed operations.
    sqlx::query("UPDATE transactions SET status = 'VALIDATING', updated_at = NOW() WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|error| {
            if error
                .as_database_error()
                .is_some_and(|error| error.is_unique_violation())
            {
                ApiError::new(
                    "CONFLICT",
                    "A transfer is already in progress for this wallet. Wait for its result.",
                )
            } else {
                error.into()
            }
        })?;
    let calldata = format!(
        "0xa9059cbb{:0>64}{:064x}",
        &record.recipient[2..],
        record.amount_atomic
    );
    let prepared = crate::alchemy::wallet_rpc(
        state,
        "wallet_prepareCalls",
        serde_json::json!([{
            "from": record.sender, "chainId": format!("0x{:x}", state.config.chain_id),
            "calls": [{ "to": state.config.usdc_address, "data": calldata, "value": "0x0" }],
            "capabilities": { "paymasterService": { "policyId": policy } }
        }]),
    )
    .await?;
    validate_prepared(&prepared, &record.sender, state.config.chain_id)?;
    sqlx::query("UPDATE transactions SET status = 'READY', prepared_call = ?, prepared_expires_at = DATE_ADD(NOW(), INTERVAL 3 MINUTE), updated_at = NOW() WHERE id = ?")
        .bind(sqlx::types::Json(&prepared)).bind(id).execute(&mut *tx).await?;
    audit(&mut tx, user, "transaction.prepared").await?;
    tx.commit().await?;
    Ok(prepared)
}
pub fn validate_prepared(
    call: &serde_json::Value,
    sender: &str,
    chain: u64,
) -> Result<(), ApiError> {
    // Dedicated MAv2 smart accounts do not require EIP-7702 authorizations.
    if !matches!(
        call["type"].as_str(),
        Some("user-operation-v070" | "user-operation-v060")
    ) || crate::alchemy::hex_u64(&call["chainId"]) != Some(chain)
    {
        return Err(ApiError::new(
            "PROVIDER_REJECTED",
            "Unsupported wallet preparation response.",
        ));
    }
    let valid_nonce = call["data"]["nonce"]
        .as_str()
        .and_then(|value| value.strip_prefix("0x"))
        .is_some_and(|value| {
            !value.is_empty()
                && value.len() <= 64
                && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        });
    if !call["data"]["sender"]
        .as_str()
        .is_some_and(|address| address.eq_ignore_ascii_case(sender))
        || !call["signatureRequest"].is_object()
        || !valid_nonce
    {
        return Err(ApiError::new(
            "PROVIDER_REJECTED",
            "The prepared transfer does not match your wallet.",
        ));
    }
    let sponsored = call["data"]["paymaster"]
        .as_str()
        .is_some_and(|value| crate::wallet_validation::validate_wallet_address(value).is_ok())
        || call["data"]["paymasterAndData"]
            .as_str()
            .is_some_and(|value| {
                value.get(..42).is_some_and(|prefix| {
                    crate::wallet_validation::validate_wallet_address(prefix).is_ok()
                })
            });
    if !sponsored || call["feePayment"]["sponsored"] != true {
        return Err(ApiError::new(
            "PROVIDER_REJECTED",
            "This transfer is not eligible for sponsored gas.",
        ));
    }
    Ok(())
}
pub fn attach_signature(
    prepared: &serde_json::Value,
    submitted: &serde_json::Value,
) -> Result<serde_json::Value, ApiError> {
    let invalid = || {
        ApiError::new(
            "FORBIDDEN",
            "The signed transfer does not match the prepared transfer.",
        )
    };
    if submitted["type"] != prepared["type"]
        || submitted["chainId"] != prepared["chainId"]
        || submitted["data"] != prepared["data"]
    {
        return Err(invalid());
    }
    let signature = &submitted["signature"];
    let valid = signature["type"] == "secp256k1"
        && signature["data"].as_str().is_some_and(|sig| {
            sig.len() == 132
                && sig.starts_with("0x")
                && sig[2..].bytes().all(|c| c.is_ascii_hexdigit())
        });
    if !valid {
        return Err(invalid());
    }
    Ok(
        serde_json::json!({ "type": prepared["type"], "data": prepared["data"], "chainId": prepared["chainId"], "signature": signature }),
    )
}
async fn submit(
    state: &AppState,
    user: &str,
    id: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, ApiError> {
    crate::admin::require_enabled(state).await?;
    state.limits.check(format!("submit:{user}"), 10)?;
    let mut tx = state.pool.begin().await?;
    let record = sqlx::query_as::<_, TransactionRecord>(
        "SELECT * FROM transactions WHERE id = ? AND user_id = ? FOR UPDATE",
    )
    .bind(id)
    .bind(user)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::new("NOT_FOUND", "Transaction not found."))?;
    if let Some(call_id) = record.call_id {
        return Ok(serde_json::json!({ "id": call_id }));
    }
    if record.status == "SUBMITTED" {
        tx.commit().await?;
        return send_stored(state, id, user).await;
    }
    if record.status != "READY"
        || record
            .prepared_expires_at
            .is_none_or(|expires| expires <= chrono::Utc::now())
    {
        return Err(ApiError::new(
            "CONFLICT",
            "The transfer review expired. Review your transfer again before signing.",
        ));
    }
    let prepared = record.prepared_call.ok_or_else(ApiError::unavailable)?.0;
    let signed = attach_signature(&prepared, &params[0])?;
    sqlx::query("UPDATE transactions SET signed_call = ?, status = 'SUBMITTED', submitted_at = NOW(), updated_at = NOW() WHERE id = ?")
        .bind(sqlx::types::Json(&signed)).bind(id).execute(&mut *tx).await?;
    audit(&mut tx, user, "transaction.submission_requested").await?;
    tx.commit().await?;
    // Durable before the external side effect. Ambiguous failures retry identical bytes/nonce.
    send_stored(state, id, user).await
}
async fn send_stored(
    state: &AppState,
    id: &str,
    user: &str,
) -> Result<serde_json::Value, ApiError> {
    let record = load_record(state, id, user).await?;
    if let Some(call_id) = record.call_id {
        return Ok(serde_json::json!({ "id": call_id }));
    }
    let signed = record.signed_call.ok_or_else(ApiError::unavailable)?.0;
    let response = crate::alchemy::wallet_rpc(
        state,
        "wallet_sendPreparedCalls",
        serde_json::json!([signed]),
    )
    .await?;
    let call_id = response["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 255)
        .ok_or_else(ApiError::unavailable)?;
    sqlx::query("UPDATE transactions SET call_id = ?, status = 'PENDING', updated_at = NOW() WHERE id = ? AND user_id = ? AND status = 'SUBMITTED'")
        .bind(call_id).bind(id).bind(user).execute(&state.pool).await?;
    Ok(serde_json::json!({ "id": call_id }))
}
pub async fn reconcile_one(state: &AppState, id: &str, user: &str) -> Result<(), ApiError> {
    let mut record = load_record(state, id, user).await?;
    if record.status == "SUBMITTED" && record.call_id.is_none() {
        send_stored(state, id, user).await?;
        record = load_record(state, id, user).await?;
    }
    if !["SUBMITTED", "PENDING"].contains(&record.status.as_str()) {
        return Ok(());
    }
    let Some(call_id) = record.call_id.as_ref() else {
        return Ok(());
    };
    let status =
        crate::alchemy::wallet_rpc(state, "wallet_getCallsStatus", serde_json::json!([call_id]))
            .await?;
    let code = status["status"]
        .as_u64()
        .or_else(|| crate::alchemy::hex_u64(&status["status"]))
        .ok_or_else(ApiError::unavailable)?;
    let hash = status["receipts"][0]["transactionHash"]
        .as_str()
        .filter(|hash| crate::alchemy::valid_hash(hash));
    if code == 400 && hash.is_none() {
        sqlx::query("UPDATE transactions SET status = 'FAILED', error_code = 'PROVIDER_REJECTED', signed_call = NULL, updated_at = NOW() WHERE id = ? AND status IN ('SUBMITTED','PENDING')").bind(id).execute(&state.pool).await?;
        return Ok(());
    }
    let Some(hash) = hash else {
        return Ok(());
    };
    crate::alchemy::verify_chain(state).await?;
    let receipt = crate::alchemy::chain_rpc(
        state,
        "eth_getTransactionReceipt",
        serde_json::json!([hash]),
    )
    .await?;
    if receipt.is_null() {
        return Ok(());
    }
    if !receipt["transactionHash"]
        .as_str()
        .is_some_and(|value| value.eq_ignore_ascii_case(hash))
    {
        return Err(ApiError::unavailable());
    }
    sqlx::query(
        "UPDATE transactions SET tx_hash = ? WHERE id = ? AND status IN ('SUBMITTED','PENDING')",
    )
    .bind(hash)
    .bind(id)
    .execute(&state.pool)
    .await?;
    let block =
        crate::alchemy::hex_u64(&receipt["blockNumber"]).ok_or_else(ApiError::unavailable)?;
    let current =
        crate::alchemy::chain_rpc(state, "eth_blockNumber", serde_json::json!([])).await?;
    let current = crate::alchemy::hex_u64(&current).ok_or_else(ApiError::unavailable)?;
    if current < block || current - block + 1 < state.config.confirmations {
        return Ok(());
    }
    let canonical = crate::alchemy::chain_rpc(
        state,
        "eth_getBlockByNumber",
        serde_json::json!([receipt["blockNumber"], false]),
    )
    .await?;
    if canonical["hash"] != receipt["blockHash"] || canonical["hash"].is_null() {
        return Ok(());
    }
    let (operation_hash, result) = match crate::alchemy::receipt_state(&receipt)? {
        crate::alchemy::ReceiptState::Failed => (None, "FAILED"),
        crate::alchemy::ReceiptState::Confirmed => {
            let prepared = record
                .prepared_call
                .as_ref()
                .ok_or_else(ApiError::unavailable)?;
            let Some((hash, outcome)) = crate::alchemy::operation_outcome(
                &receipt,
                &prepared.0,
                &state.config.usdc_address,
                &record.recipient,
                record.amount_atomic,
            )?
            else {
                return Ok(());
            };
            (
                Some(hash),
                if outcome == crate::alchemy::ReceiptState::Confirmed {
                    "CONFIRMED"
                } else {
                    "FAILED"
                },
            )
        }
        crate::alchemy::ReceiptState::Pending => return Ok(()),
    };
    let mut tx = state.pool.begin().await?;
    let updated = sqlx::query("UPDATE transactions SET status = ?, tx_hash = ?, user_operation_hash = ?, gas_used = ?, gas_price = ?, confirmed_at = CASE WHEN ? = 'CONFIRMED' THEN NOW() ELSE NULL END, signed_call = NULL, error_code = CASE WHEN ? = 'FAILED' THEN 'TRANSACTION_FAILED' ELSE NULL END, updated_at = NOW() WHERE id = ? AND status IN ('SUBMITTED','PENDING')")
        .bind(result).bind(hash).bind(operation_hash).bind(crate::alchemy::hex_u64(&receipt["gasUsed"]).and_then(|v| i64::try_from(v).ok())).bind(crate::alchemy::hex_u64(&receipt["effectiveGasPrice"]).and_then(|v| i64::try_from(v).ok())).bind(result).bind(result).bind(id).execute(&mut *tx).await?;
    if updated.rows_affected() == 1 {
        audit(
            &mut tx,
            user,
            if result == "CONFIRMED" {
                "transaction.confirmed"
            } else {
                "transaction.failed"
            },
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
pub async fn reconcile_pending(state: &AppState) -> Result<(), ApiError> {
    sqlx::query("UPDATE transactions SET status = 'CREATED', prepared_call = NULL, updated_at = NOW() WHERE status = 'READY' AND prepared_expires_at < NOW()").execute(&state.pool).await?;
    let pending: Vec<(String, String)> = sqlx::query_as("SELECT id, user_id FROM transactions WHERE status IN ('SUBMITTED','PENDING') ORDER BY updated_at ASC LIMIT 50").fetch_all(&state.pool).await?;
    for (id, user) in pending {
        if let Err(error) = reconcile_one(state, &id, &user).await {
            tracing::warn!(
                transaction_id = id,
                error_code = error.error.code,
                "Transaction reconciliation deferred"
            );
        }
        sqlx::query("UPDATE transactions SET updated_at = NOW() WHERE id = ? AND status IN ('SUBMITTED','PENDING')").bind(&id).execute(&state.pool).await?;
    }
    Ok(())
}
