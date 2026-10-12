use crate::{error::ApiError, state::AppState, wallet_validation::validate_wallet_address};
use serde_json::{Value, json};
async fn rpc(
    state: &AppState,
    url: Option<&str>,
    method: &str,
    params: Value,
) -> Result<Value, ApiError> {
    let url = url.ok_or_else(|| {
        ApiError::new(
            "PROVIDER_NOT_CONFIGURED",
            "Wallet services are not configured yet.",
        )
    })?;
    let response = state
        .http
        .post(url)
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
        .send()
        .await
        .map_err(|_| ApiError::unavailable())?;
    if !response.status().is_success() {
        return Err(ApiError::unavailable());
    }
    let body: Value = response.json().await.map_err(|_| ApiError::unavailable())?;
    if body.get("error").is_some() {
        return Err(ApiError::new(
            "PROVIDER_REJECTED",
            "The wallet provider could not complete this request. Check your wallet, network and sponsorship eligibility.",
        ));
    }
    body.get("result")
        .cloned()
        .ok_or_else(ApiError::unavailable)
}
pub async fn chain_rpc(state: &AppState, method: &str, params: Value) -> Result<Value, ApiError> {
    rpc(
        state,
        state.config.alchemy_rpc_url.as_deref(),
        method,
        params,
    )
    .await
}
pub async fn wallet_rpc(state: &AppState, method: &str, params: Value) -> Result<Value, ApiError> {
    rpc(
        state,
        state.config.alchemy_wallet_url.as_deref(),
        method,
        params,
    )
    .await
}
pub async fn verify_chain(state: &AppState) -> Result<(), ApiError> {
    let chain = chain_rpc(state, "eth_chainId", json!([])).await?;
    if hex_u64(&chain) != Some(state.config.chain_id) {
        return Err(ApiError::new(
            "UNSUPPORTED_NETWORK",
            "The blockchain provider is connected to a different network.",
        ));
    }
    Ok(())
}
pub async fn usdc_balance(state: &AppState, address: &str) -> Result<u128, ApiError> {
    let address = validate_wallet_address(address)?;
    verify_chain(state).await?;
    let data = format!("0x70a08231{:0>64}", &address[2..]);
    let result = chain_rpc(
        state,
        "eth_call",
        json!([{ "to": state.config.usdc_address, "data": data }, "latest"]),
    )
    .await?;
    let encoded = result
        .as_str()
        .and_then(|s| s.strip_prefix("0x"))
        .ok_or_else(ApiError::unavailable)?;
    u128::from_str_radix(encoded, 16).map_err(|_| ApiError::unavailable())
}
pub fn hex_u64(value: &Value) -> Option<u64> {
    value
        .as_str()
        .and_then(|s| s.strip_prefix("0x"))
        .and_then(|s| u64::from_str_radix(s, 16).ok())
}
#[derive(Debug, PartialEq)]
pub enum ReceiptState {
    Pending,
    Confirmed,
    Failed,
}
pub fn receipt_state(value: &Value) -> Result<ReceiptState, ApiError> {
    if value.is_null() {
        return Ok(ReceiptState::Pending);
    }
    match value.get("status").and_then(Value::as_str) {
        Some("0x1")
            if value
                .get("transactionHash")
                .and_then(Value::as_str)
                .is_some_and(valid_hash) =>
        {
            Ok(ReceiptState::Confirmed)
        }
        Some("0x0") => Ok(ReceiptState::Failed),
        _ => Err(ApiError::unavailable()),
    }
}
pub fn valid_hash(hash: &str) -> bool {
    hash.len() == 66 && hash.starts_with("0x") && hash[2..].bytes().all(|c| c.is_ascii_hexdigit())
}
pub fn contains_transfer(
    receipt: &Value,
    token: &str,
    sender: &str,
    recipient: &str,
    amount: i64,
) -> bool {
    receipt
        .get("logs")
        .and_then(Value::as_array)
        .is_some_and(|logs| contains_transfer_logs(logs, token, sender, recipient, amount))
}
fn contains_transfer_logs(
    logs: &[Value],
    token: &str,
    sender: &str,
    recipient: &str,
    amount: i64,
) -> bool {
    if amount <= 0
        || validate_wallet_address(sender).is_err()
        || validate_wallet_address(recipient).is_err()
    {
        return false;
    }
    const TRANSFER: &str = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    let topic = |address: &str| format!("0x{:0>64}", &address[2..].to_ascii_lowercase());
    logs.iter().any(|log| {
        log["address"]
            .as_str()
            .is_some_and(|address| address.eq_ignore_ascii_case(token))
            && log["topics"][0].as_str() == Some(TRANSFER)
            && log["topics"][1]
                .as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case(&topic(sender)))
            && log["topics"][2]
                .as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case(&topic(recipient)))
            && log["data"]
                .as_str()
                .and_then(|s| s.strip_prefix("0x"))
                .and_then(|s| u128::from_str_radix(s, 16).ok())
                == Some(amount as u128)
    })
}

/// EntryPoint emits one outcome per operation; the outer receipt can succeed when an operation reverts.
pub fn operation_outcome<'a>(
    receipt: &'a Value,
    prepared: &Value,
    token: &str,
    recipient: &str,
    amount: i64,
) -> Result<Option<(&'a str, ReceiptState)>, ApiError> {
    use alloy_primitives::U256;
    const EVENT: &str = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
    const BEFORE_EXECUTION: &str =
        "0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972";
    let entrypoint = match prepared["type"].as_str() {
        Some("user-operation-v070") => "0x0000000071727de22e5e9d8baf0edac6f37da032",
        Some("user-operation-v060") => "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789",
        _ => return Err(ApiError::unavailable()),
    };
    let sender = validate_wallet_address(
        prepared["data"]["sender"]
            .as_str()
            .ok_or_else(ApiError::unavailable)?,
    )?;
    let nonce = prepared["data"]["nonce"]
        .as_str()
        .and_then(|value| value.strip_prefix("0x"))
        .and_then(|value| U256::from_str_radix(value, 16).ok())
        .ok_or_else(ApiError::unavailable)?;
    let sender_topic = format!("0x{:0>64}", &sender[2..]);
    let logs = receipt["logs"]
        .as_array()
        .ok_or_else(ApiError::unavailable)?;
    let mut start = None;
    let mut outcome = None;
    for (index, log) in logs.iter().enumerate() {
        if !log["address"]
            .as_str()
            .is_some_and(|address| address.eq_ignore_ascii_case(entrypoint))
        {
            continue;
        }
        if log["topics"][0].as_str() == Some(BEFORE_EXECUTION) {
            start = Some(index + 1);
            continue;
        }
        if log["topics"][0].as_str() != Some(EVENT) {
            continue;
        }
        if log["topics"][2]
            .as_str()
            .is_some_and(|topic| topic.eq_ignore_ascii_case(&sender_topic))
        {
            let data = log["data"]
                .as_str()
                .and_then(|value| value.strip_prefix("0x"))
                .filter(|value| value.len() == 256)
                .and_then(|value| hex::decode(value).ok())
                .ok_or_else(ApiError::unavailable)?;
            if U256::from_be_slice(&data[..32]) == nonce {
                let hash = log["topics"][1]
                    .as_str()
                    .filter(|value| valid_hash(value))
                    .ok_or_else(ApiError::unavailable)?;
                if log["topics"].as_array().map(Vec::len) != Some(4)
                    || data[32..63].iter().any(|byte| *byte != 0)
                    || data[63] > 1
                    || outcome.is_some()
                {
                    return Err(ApiError::unavailable());
                }
                let start = start.ok_or_else(ApiError::unavailable)?;
                let transferred =
                    contains_transfer_logs(&logs[start..index], token, &sender, recipient, amount);
                outcome = Some((
                    hash,
                    if data[63] == 1 && transferred {
                        ReceiptState::Confirmed
                    } else {
                        ReceiptState::Failed
                    },
                ));
            }
        }
        // Logs from preceding operations cannot prove this operation transferred funds.
        start = Some(index + 1);
    }
    Ok(outcome)
}
