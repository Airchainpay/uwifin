//! Use the provider's transfer API; only persist deposits with finalized, canonical receipts.
use crate::{
    alchemy::{chain_rpc, hex_u64},
    error::ApiError,
    state::AppState,
};
use serde_json::json;
#[derive(sqlx::FromRow)]
struct Wallet {
    id: String,
    user_id: String,
    address: String,
    history_block: u64,
    history_end: Option<u64>,
    history_page: Option<String>,
}
pub async fn reconcile(state: &AppState) -> Result<(), ApiError> {
    if !state.config.wallet_enabled() {
        return Ok(());
    }
    if state.config.is_solana() {
        return crate::solana_deposits::reconcile(state).await;
    }
    let wallets: Vec<Wallet> = sqlx::query_as("SELECT id,user_id,CAST(address AS CHAR) AS address,history_block,history_end,history_page FROM wallets WHERE verified_at IS NOT NULL AND network = ? ORDER BY history_checked_at,id LIMIT 5")
        .bind(&state.config.network).fetch_all(&state.pool).await?;
    for wallet in wallets {
        if let Err(error) = sync(state, &wallet).await {
            tracing::warn!(
                wallet_id = wallet.id,
                error_code = error.error.code,
                "Deposit history unavailable"
            );
        }
        sqlx::query("UPDATE wallets SET history_checked_at = NOW() WHERE id = ?")
            .bind(&wallet.id)
            .execute(&state.pool)
            .await?;
    }
    Ok(())
}
async fn sync(state: &AppState, wallet: &Wallet) -> Result<(), ApiError> {
    crate::alchemy::verify_chain(state).await?;
    let tip = hex_u64(&chain_rpc(state, "eth_blockNumber", json!([])).await?)
        .ok_or_else(ApiError::unavailable)?;
    let Some(finalized) = tip.checked_sub(state.config.confirmations) else {
        return Ok(());
    };
    let end = wallet.history_end.unwrap_or(finalized).min(finalized);
    if wallet.history_block > end {
        return Ok(());
    }
    let mut params = json!({"fromBlock":format!("0x{:x}",wallet.history_block),"toBlock":format!("0x{end:x}"),"toAddress":wallet.address,"contractAddresses":[state.config.usdc_address],"category":["erc20"],"withMetadata":true,"excludeZeroValue":true,"order":"asc","maxCount":"0xa"});
    if let Some(page) = &wallet.history_page {
        params["pageKey"] = json!(page);
    }
    let result = match chain_rpc(state, "alchemy_getAssetTransfers", json!([params])).await {
        Ok(result) => result,
        Err(error) => {
            // Provider page tokens can expire; replay the same bounded range safely.
            if wallet.history_page.is_some() && error.error.code == "PROVIDER_REJECTED" {
                sqlx::query("UPDATE wallets SET history_page = NULL WHERE id = ?")
                    .bind(&wallet.id)
                    .execute(&state.pool)
                    .await?;
            }
            return Err(error);
        }
    };
    let transfers = result["transfers"]
        .as_array()
        .ok_or_else(ApiError::unavailable)?;
    let asset: String = sqlx::query_scalar("SELECT id FROM assets WHERE network = ? AND contract_address = ? AND decimals = 6 AND symbol = 'USDC'")
        .bind(&state.config.network).bind(&state.config.usdc_address).fetch_one(&state.pool).await?;
    for item in transfers {
        let get = |key: &str| item[key].as_str().ok_or_else(ApiError::unavailable);
        let hash = get("hash")?;
        let sender = crate::wallet_validation::validate_wallet_address(get("from")?)?;
        if !crate::alchemy::valid_hash(hash)
            || !get("to")?.eq_ignore_ascii_case(&wallet.address)
            || !item["rawContract"]["address"]
                .as_str()
                .is_some_and(|v| v.eq_ignore_ascii_case(&state.config.usdc_address))
        {
            return Err(ApiError::unavailable());
        }
        let amount = item["rawContract"]["value"]
            .as_str()
            .and_then(|v| v.strip_prefix("0x"))
            .and_then(|v| i64::from_str_radix(v, 16).ok())
            .filter(|v| *v > 0)
            .ok_or_else(ApiError::unavailable)?;
        let reference = get("uniqueId")?;
        if reference.len() > 255 {
            return Err(ApiError::unavailable());
        }
        let receipt = chain_rpc(state, "eth_getTransactionReceipt", json!([hash])).await?;
        let block = hex_u64(&receipt["blockNumber"]).ok_or_else(ApiError::unavailable)?;
        if block > end
            || receipt["transactionHash"] != hash
            || receipt["status"] != "0x1"
            || !crate::alchemy::contains_transfer(
                &receipt,
                &state.config.usdc_address,
                &sender,
                &wallet.address,
                amount,
            )
        {
            return Err(ApiError::unavailable());
        }
        let canonical = chain_rpc(
            state,
            "eth_getBlockByNumber",
            json!([receipt["blockNumber"], false]),
        )
        .await?;
        if canonical["hash"].is_null() || canonical["hash"] != receipt["blockHash"] {
            return Err(ApiError::unavailable());
        }
        let timestamp = hex_u64(&canonical["timestamp"])
            .and_then(|v| chrono::DateTime::from_timestamp(i64::try_from(v).ok()?, 0))
            .ok_or_else(ApiError::unavailable)?;
        sqlx::query("INSERT INTO transactions (id,user_id,wallet_id,network,tx_hash,sender,recipient,asset_id,amount_atomic,status,kind,external_reference,created_at,confirmed_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'CONFIRMED','received',?,?,?,NOW()) ON DUPLICATE KEY UPDATE id = id")
            .bind(uuid::Uuid::new_v4().to_string()).bind(&wallet.user_id).bind(&wallet.id).bind(&state.config.network).bind(hash).bind(&sender).bind(&wallet.address).bind(&asset).bind(amount).bind(reference).bind(timestamp).bind(timestamp).execute(&state.pool).await?;
    }
    let page = result["pageKey"].as_str();
    sqlx::query(
        "UPDATE wallets SET history_block = ?,history_end = ?,history_page = ? WHERE id = ?",
    )
    .bind(if page.is_some() {
        wallet.history_block
    } else {
        end + 1
    })
    .bind(page.map(|_| end))
    .bind(page)
    .bind(&wallet.id)
    .execute(&state.pool)
    .await?;
    Ok(())
}
