use crate::{
    auth::{UserResponse, authorize},
    error::ApiError,
    security::audit,
    state::AppState,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::{Value, json};

async fn admin(state: &AppState, headers: &HeaderMap) -> Result<UserResponse, ApiError> {
    let user = authorize(state, headers).await?;
    if user.role != "admin" {
        return Err(ApiError::new(
            "FORBIDDEN",
            "Administrator access is required.",
        ));
    }
    Ok(user)
}
#[derive(Deserialize)]
pub struct Page {
    page: Option<u32>,
}
pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(section): Path<String>,
    Query(page): Query<Page>,
) -> Result<Json<Value>, ApiError> {
    admin(&state, &headers).await?;
    let page = page.page.unwrap_or(1);
    if !(1..=100_000).contains(&page) {
        return Err(ApiError::new("INVALID_REQUEST", "Invalid page."));
    }
    // Explicit projections keep credentials and signed payloads out of the admin API.
    let query = match section.as_str() {
        "users" => {
            "SELECT JSON_OBJECT('id',id,'email',email,'name',name,'status',status,'role',role,'created_at',created_at) FROM users ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?"
        }
        "transactions" => {
            "SELECT JSON_OBJECT('id',id,'user_id',user_id,'network',network,'amount_atomic',CAST(amount_atomic AS CHAR),'status',status,'tx_hash',tx_hash,'error_code',error_code,'updated_at',updated_at) FROM transactions ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?"
        }
        "payments" => {
            "SELECT JSON_OBJECT('id',id,'user_id',user_id,'status',status,'provider_reference',provider_reference,'fiat_currency',fiat_currency,'fiat_amount_minor',CAST(fiat_amount_minor AS CHAR),'created_at',created_at) FROM payments ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?"
        }
        "events" => {
            "SELECT JSON_OBJECT('id',id,'user_id',user_id,'event_type',event_type,'request_id',request_id,'created_at',created_at) FROM audit_events ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?"
        }
        "assets" => {
            "SELECT JSON_OBJECT('id',id,'symbol',symbol,'network',network,'contract_address',contract_address,'is_active',is_active) FROM assets ORDER BY network,id LIMIT 50 OFFSET ?"
        }
        "networks" => {
            "SELECT JSON_OBJECT('id',id,'is_active',is_active) FROM networks ORDER BY id LIMIT 50 OFFSET ?"
        }
        "errors" => {
            "SELECT JSON_OBJECT('id',id,'user_id',user_id,'status',status,'error_code',error_code,'updated_at',updated_at) FROM transactions WHERE status = 'FAILED' OR (status IN ('SUBMITTED','PENDING') AND submitted_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE)) ORDER BY updated_at,id LIMIT 50 OFFSET ?"
        }
        _ => return Err(ApiError::new("NOT_FOUND", "Unknown admin section.")),
    };
    let rows: Vec<String> = sqlx::query_scalar(query)
        .bind((page - 1) * 50)
        .fetch_all(&state.pool)
        .await?;
    let records: Vec<Value> = rows
        .iter()
        .map(|row| serde_json::from_str(row).map_err(|_| ApiError::unavailable()))
        .collect::<Result<_, _>>()?;
    Ok(Json(json!({"records":records,"page":page})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Toggle {
    active: bool,
}
pub async fn toggle(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((section, id)): Path<(String, String)>,
    Json(req): Json<Toggle>,
) -> Result<Json<Value>, ApiError> {
    let user = admin(&state, &headers).await?;
    let query = match section.as_str() {
        "assets" => "UPDATE assets SET is_active = ? WHERE id = ?",
        "networks" => "UPDATE networks SET is_active = ? WHERE id = ?",
        _ => return Err(ApiError::new("NOT_FOUND", "Unknown setting.")),
    };
    // Only allow re-enabling the configured, vetted token. Old scaffold rows stay disabled.
    if section == "assets" && req.active {
        let valid: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM assets WHERE id = ? AND network = ? AND contract_address = ? AND decimals = 6 AND symbol = 'USDC'")
            .bind(&id).bind(&state.config.network).bind(&state.config.usdc_address).fetch_one(&state.pool).await?;
        if valid == 0 {
            return Err(ApiError::new(
                "INVALID_REQUEST",
                "Only the configured USDC asset can be enabled.",
            ));
        }
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query(query)
        .bind(req.active)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    audit(
        &mut tx,
        &user.id,
        &format!(
            "admin.{section}.{}:{id}",
            if req.active { "enabled" } else { "disabled" }
        ),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"active":req.active})))
}
pub async fn require_enabled(state: &AppState) -> Result<(), ApiError> {
    let active: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM networks n JOIN assets a ON a.network = n.id WHERE n.id = ? AND n.is_active = TRUE AND a.is_active = TRUE AND a.contract_address = ? AND a.decimals = 6 AND a.symbol = 'USDC'")
        .bind(&state.config.network).bind(&state.config.usdc_address).fetch_one(&state.pool).await?;
    if active == 0 {
        return Err(ApiError::new(
            "SERVICE_UNAVAILABLE",
            "Transfers and purchases on this network are paused.",
        ));
    }
    Ok(())
}
