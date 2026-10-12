//! Index net USDC credits to the wallet's associated token account, once per finalized transaction.
use crate::{alchemy::chain_rpc, error::ApiError, state::AppState};
use serde_json::{Value, json};
#[derive(sqlx::FromRow)]
struct Wallet {
    id: String,
    user_id: String,
    address: String,
    solana_history_cursor: Option<String>,
    solana_history_head: Option<String>,
    solana_history_before: Option<String>,
}
pub async fn reconcile(state: &AppState) -> Result<(), ApiError> {
    crate::solana::verify_chain(state).await?;
    let wallets: Vec<Wallet> = sqlx::query_as("SELECT id,user_id,CAST(address AS CHAR) AS address,solana_history_cursor,solana_history_head,solana_history_before FROM wallets WHERE verified_at IS NOT NULL AND network = ? ORDER BY history_checked_at,id LIMIT 5")
        .bind(&state.config.network).fetch_all(&state.pool).await?;
    for wallet in wallets {
        if let Err(error) = sync(state, &wallet).await {
            tracing::warn!(
                wallet_id = wallet.id,
                error_code = error.error.code,
                "Solana deposit history unavailable"
            );
        }
        sqlx::query("UPDATE wallets SET history_checked_at = NOW() WHERE id = ?")
            .bind(&wallet.id)
            .execute(&state.pool)
            .await?;
    }
    Ok(())
}
fn token_amount(receipt: &Value, field: &str, index: u64, owner: &str) -> Result<u64, ApiError> {
    let balances = receipt["meta"][field]
        .as_array()
        .ok_or_else(ApiError::unavailable)?;
    let Some(balance) = balances
        .iter()
        .find(|entry| entry["accountIndex"].as_u64() == Some(index))
    else {
        return Ok(0);
    };
    if balance["mint"] != crate::networks::SOLANA_USDC
        || balance["owner"] != owner
        || balance["programId"] != crate::solana::TOKEN_PROGRAM
        || balance["uiTokenAmount"]["decimals"] != 6
    {
        return Err(ApiError::unavailable());
    }
    balance["uiTokenAmount"]["amount"]
        .as_str()
        .and_then(|v| v.parse().ok())
        .ok_or_else(ApiError::unavailable)
}
pub fn net_credit(receipt: &Value, account: &str, owner: &str) -> Result<Option<i64>, ApiError> {
    let keys = receipt["transaction"]["message"]["accountKeys"]
        .as_array()
        .ok_or_else(ApiError::unavailable)?;
    let index = keys
        .iter()
        .position(|key| key["pubkey"].as_str() == Some(account))
        .ok_or_else(ApiError::unavailable)? as u64;
    let before = token_amount(receipt, "preTokenBalances", index, owner)?;
    let after = token_amount(receipt, "postTokenBalances", index, owner)?;
    Ok(after
        .checked_sub(before)
        .filter(|amount| *amount > 0)
        .and_then(|amount| i64::try_from(amount).ok()))
}
async fn sync(state: &AppState, wallet: &Wallet) -> Result<(), ApiError> {
    let account = crate::solana::associated_account(&wallet.address)?.to_string();
    let mut options = json!({"commitment":"finalized", "limit":10});
    if let Some(cursor) = &wallet.solana_history_cursor {
        options["until"] = json!(cursor);
    }
    if let Some(before) = &wallet.solana_history_before {
        options["before"] = json!(before);
    }
    let response = chain_rpc(state, "getSignaturesForAddress", json!([account, options])).await?;
    let signatures = response.as_array().ok_or_else(ApiError::unavailable)?;
    let head = wallet
        .solana_history_head
        .as_deref()
        .or_else(|| signatures.first().and_then(|s| s["signature"].as_str()));
    let asset: String = sqlx::query_scalar("SELECT id FROM assets WHERE network = ? AND contract_address = ? AND symbol = 'USDC' AND decimals = 6")
        .bind(&state.config.network).bind(&state.config.usdc_address).fetch_one(&state.pool).await?;
    for item in signatures {
        let signature = item["signature"]
            .as_str()
            .filter(|s| bs58::decode(s).into_vec().is_ok_and(|v| v.len() == 64))
            .ok_or_else(ApiError::unavailable)?;
        let receipt = chain_rpc(state, "getTransaction", json!([signature, {"commitment":"finalized", "encoding":"jsonParsed", "maxSupportedTransactionVersion":0}])).await?;
        if receipt["transaction"]["signatures"][0] != signature
            || receipt["meta"].get("err").is_none()
        {
            return Err(ApiError::unavailable());
        }
        if !receipt["meta"]["err"].is_null() {
            continue;
        }
        let Some(amount) = net_credit(&receipt, &account, &wallet.address)? else {
            continue;
        };
        let timestamp = receipt["blockTime"]
            .as_i64()
            .and_then(|v| chrono::DateTime::from_timestamp(v, 0))
            .ok_or_else(ApiError::unavailable)?;
        // A transaction may contain multiple credits/debits. Do not invent a single sender.
        sqlx::query("INSERT INTO transactions (id,user_id,wallet_id,network,tx_hash,sender,recipient,asset_id,amount_atomic,status,kind,external_reference,created_at,confirmed_at,updated_at) VALUES (?,?,?,?,?,'USDC deposit',?,?,?,'CONFIRMED','received',?,?,?,NOW()) ON DUPLICATE KEY UPDATE id = id")
            .bind(uuid::Uuid::new_v4().to_string()).bind(&wallet.user_id).bind(&wallet.id).bind(&state.config.network).bind(signature).bind(&wallet.address).bind(&asset).bind(amount).bind(format!("solana:{signature}")).bind(timestamp).bind(timestamp).execute(&state.pool).await?;
    }
    if signatures.len() == 10 {
        let before = signatures
            .last()
            .and_then(|s| s["signature"].as_str())
            .ok_or_else(ApiError::unavailable)?;
        sqlx::query(
            "UPDATE wallets SET solana_history_head = ?,solana_history_before = ? WHERE id = ?",
        )
        .bind(head)
        .bind(before)
        .bind(&wallet.id)
        .execute(&state.pool)
        .await?;
    } else {
        sqlx::query("UPDATE wallets SET solana_history_cursor = COALESCE(?,solana_history_cursor),solana_history_head = NULL,solana_history_before = NULL WHERE id = ?")
            .bind(head).bind(&wallet.id).execute(&state.pool).await?;
    }
    Ok(())
}
