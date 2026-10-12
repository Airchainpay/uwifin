//! Native USDC on Solana mainnet: external signing, fixed SPL instructions and finalized receipts.
use crate::{alchemy::chain_rpc, error::ApiError, state::AppState};
use base64::{Engine, engine::general_purpose::STANDARD};
use bincode::Options;
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::{Value, json};
use solana_hash::Hash;
use solana_instruction::{AccountMeta, Instruction};
use solana_message::{VersionedMessage, v0};
use solana_pubkey::Pubkey;
use std::str::FromStr;

pub const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const GENESIS_HASH: &str = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
fn pubkey(value: &str) -> Result<Pubkey, ApiError> {
    Pubkey::from_str(value)
        .map_err(|_| ApiError::new("INVALID_ADDRESS", "Enter a valid Solana wallet address."))
}
pub fn validate_address(address: &str) -> Result<String, ApiError> {
    let key = pubkey(address)?;
    // Only ordinary signing wallets are supported as recipients, not arbitrary token accounts/PDAs.
    if key == Pubkey::default() || !key.is_on_curve() {
        return Err(ApiError::new(
            "INVALID_ADDRESS",
            "Use a Solana signing wallet address, not a token account or program address.",
        ));
    }
    Ok(key.to_string())
}
pub fn verify_signature(message: &[u8], signature: &[u8], address: &str) -> bool {
    let Ok(key) = pubkey(address) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&key.to_bytes()) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(signature) else {
        return false;
    };
    key.verify_strict(message, &signature).is_ok()
}
pub fn verify_ownership(message: &str, signature: &str, address: &str) -> bool {
    STANDARD
        .decode(signature)
        .is_ok_and(|sig| verify_signature(message.as_bytes(), &sig, address))
}
pub async fn verify_chain(state: &AppState) -> Result<(), ApiError> {
    if chain_rpc(state, "getGenesisHash", json!([]))
        .await?
        .as_str()
        != Some(GENESIS_HASH)
    {
        return Err(ApiError::new(
            "UNSUPPORTED_NETWORK",
            "The Solana provider must use mainnet-beta.",
        ));
    }
    Ok(())
}
pub fn associated_account(owner: &str) -> Result<Pubkey, ApiError> {
    let owner = pubkey(owner)?;
    let mint = pubkey(crate::networks::SOLANA_USDC)?;
    let token = pubkey(TOKEN_PROGRAM)?;
    Ok(Pubkey::find_program_address(
        &[owner.as_ref(), token.as_ref(), mint.as_ref()],
        &pubkey(ASSOCIATED_PROGRAM)?,
    )
    .0)
}
pub async fn balance(state: &AppState, address: &str) -> Result<u128, ApiError> {
    verify_chain(state).await?;
    let account = associated_account(address)?.to_string();
    let result = chain_rpc(
        state,
        "getAccountInfo",
        json!([account, {"encoding":"jsonParsed", "commitment":"finalized"}]),
    )
    .await?;
    if result["value"].is_null() {
        return Ok(0);
    }
    let info = &result["value"]["data"]["parsed"]["info"];
    if result["value"]["owner"] != TOKEN_PROGRAM
        || info["mint"] != crate::networks::SOLANA_USDC
        || info["owner"] != address
        || info["tokenAmount"]["decimals"] != 6
    {
        return Err(ApiError::unavailable());
    }
    info["tokenAmount"]["amount"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .map(u128::from)
        .ok_or_else(ApiError::unavailable)
}
/// Compile exactly ATA creation + TransferChecked. Sponsorship replaces both fee and rent payers.
pub fn transfer_message(
    sender: &str,
    recipient: &str,
    amount: i64,
    blockhash: &str,
    fee_payer: &str,
    rent_payer: &str,
) -> Result<Vec<u8>, ApiError> {
    validate_address(sender)?;
    validate_address(recipient)?;
    if amount <= 0 || sender == recipient {
        return Err(ApiError::new("INVALID_REQUEST", "Invalid transfer."));
    }
    let owner = pubkey(sender)?;
    let recipient_owner = pubkey(recipient)?;
    let source = associated_account(sender)?;
    let destination = associated_account(recipient)?;
    let mint = pubkey(crate::networks::SOLANA_USDC)?;
    let token = pubkey(TOKEN_PROGRAM)?;
    let create = Instruction {
        program_id: pubkey(ASSOCIATED_PROGRAM)?,
        accounts: vec![
            AccountMeta::new(pubkey(rent_payer)?, true),
            AccountMeta::new(destination, false),
            AccountMeta::new_readonly(recipient_owner, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(Pubkey::default(), false),
            AccountMeta::new_readonly(token, false),
        ],
        data: vec![1], // CreateIdempotent; the sponsor must fund rent in the returned transaction.
    };
    let mut data = vec![12]; // SPL Token TransferChecked
    data.extend_from_slice(&(amount as u64).to_le_bytes());
    data.push(6);
    let transfer = Instruction {
        program_id: token,
        accounts: vec![
            AccountMeta::new(source, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(destination, false),
            AccountMeta::new_readonly(owner, true),
        ],
        data,
    };
    let hash = Hash::from_str(blockhash).map_err(|_| ApiError::unavailable())?;
    let message = v0::Message::try_compile(&pubkey(fee_payer)?, &[create, transfer], &[], hash)
        .map_err(|_| ApiError::unavailable())?;
    Ok(VersionedMessage::V0(message).serialize())
}
pub async fn prepare(
    state: &AppState,
    sender: &str,
    recipient: &str,
    amount: i64,
) -> Result<Value, ApiError> {
    let policy = state.config.alchemy_policy_id.as_ref().ok_or_else(|| {
        ApiError::new(
            "PROVIDER_NOT_CONFIGURED",
            "Sponsored Solana transfers are temporarily unavailable.",
        )
    })?;
    verify_chain(state).await?;
    let recipient_account = chain_rpc(
        state,
        "getAccountInfo",
        json!([recipient, {"encoding":"base64", "commitment":"finalized"}]),
    )
    .await?;
    let account = recipient_account
        .get("value")
        .ok_or_else(ApiError::unavailable)?;
    if !account.is_null()
        && (account["owner"] != "11111111111111111111111111111111"
            || account["executable"] != false)
    {
        return Err(ApiError::new(
            "INVALID_ADDRESS",
            "Use the recipient's Solana wallet address, not a token or program account.",
        ));
    }
    let recent = chain_rpc(
        state,
        "getLatestBlockhash",
        json!([{"commitment":"finalized"}]),
    )
    .await?;
    let blockhash = recent["value"]["blockhash"]
        .as_str()
        .ok_or_else(ApiError::unavailable)?;
    let height = recent["value"]["lastValidBlockHeight"]
        .as_u64()
        .ok_or_else(ApiError::unavailable)?;
    // Alchemy requires a placeholder fee payer not otherwise referenced by the instructions.
    let placeholder = Pubkey::new_unique().to_string();
    let message = transfer_message(sender, recipient, amount, blockhash, &placeholder, sender)?;
    let mut transaction = vec![0; MESSAGE_OFFSET];
    transaction[0] = 2;
    transaction.extend_from_slice(&message);
    let result = chain_rpc(
        state,
        "alchemy_requestFeePayer",
        json!([{
            "policyId":policy, "serializedTransaction":STANDARD.encode(transaction)
        }]),
    )
    .await?;
    let sponsored = result["serializedTransaction"]
        .as_str()
        .ok_or_else(ApiError::unavailable)?;
    let (sponsor, sponsored_blockhash) = validate_sponsored(sponsored, sender, recipient, amount)?;
    if result["usesDurableNonce"] != false {
        return Err(ApiError::unavailable());
    }
    let last_valid_height = if sponsored_blockhash == blockhash {
        height
    } else {
        result["lastValidBlockHeight"]
            .as_u64()
            .ok_or_else(ApiError::unavailable)?
    };
    Ok(json!({"type":"solana-transaction", "transaction":sponsored,
        "last_valid_height":last_valid_height, "blockhash":sponsored_blockhash,
        "fee_payer":sponsor, "sponsored":true}))
}
// Two signatures (fee payer + USDC owner), encoded with the canonical one-byte compact count.
const MESSAGE_OFFSET: usize = 1 + 2 * 64;
fn decode_transaction(encoded: &str) -> Result<Vec<u8>, ApiError> {
    let raw = STANDARD
        .decode(encoded)
        .map_err(|_| ApiError::unavailable())?;
    if raw.len() <= MESSAGE_OFFSET || raw.len() > 1232 || raw[0] != 2 {
        return Err(ApiError::unavailable());
    }
    Ok(raw)
}
fn decode_message(bytes: &[u8]) -> Result<VersionedMessage, ApiError> {
    let message: VersionedMessage = bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .with_limit(1232)
        .reject_trailing_bytes()
        .deserialize(bytes)
        .map_err(|_| ApiError::unavailable())?;
    message.sanitize().map_err(|_| ApiError::unavailable())?;
    if !matches!(&message, VersionedMessage::V0(m) if m.address_table_lookups.is_empty())
        || message.header().num_required_signatures != 2
        || message.serialize() != bytes
    {
        return Err(ApiError::unavailable());
    }
    Ok(message)
}
fn same_instructions(
    actual: &VersionedMessage,
    expected: &VersionedMessage,
    sender: &Pubkey,
) -> bool {
    let actual_keys = actual.static_account_keys();
    let expected_keys = expected.static_account_keys();
    actual_keys.len() == expected_keys.len()
        && actual_keys.iter().enumerate().all(|(index, key)| {
            expected_keys
                .iter()
                .position(|candidate| candidate == key)
                .is_some_and(|other| {
                    actual.is_signer(index) == expected.is_signer(other)
                        && (key == sender
                            || actual.is_maybe_writable(index, None)
                                == expected.is_maybe_writable(other, None))
                })
        })
        && actual.instructions().len() == expected.instructions().len()
        && actual
            .instructions()
            .iter()
            .zip(expected.instructions())
            .all(|(a, e)| {
                actual_keys[a.program_id_index as usize]
                    == expected_keys[e.program_id_index as usize]
                    && a.data == e.data
                    && a.accounts.len() == e.accounts.len()
                    && a.accounts
                        .iter()
                        .zip(&e.accounts)
                        .all(|(a, e)| actual_keys[*a as usize] == expected_keys[*e as usize])
            })
}
/// Accept only a valid sponsor signature, an unsigned owner slot, and the exact USDC intent.
/// The sponsor must pay both the network fee and ATA rent; no extra instructions or ALTs.
pub fn validate_sponsored(
    encoded: &str,
    sender: &str,
    recipient: &str,
    amount: i64,
) -> Result<(String, String), ApiError> {
    let raw = decode_transaction(encoded)?;
    let message = decode_message(&raw[MESSAGE_OFFSET..])?;
    let keys = message.static_account_keys();
    let sponsor = keys[0].to_string();
    let blockhash = message.recent_blockhash().to_string();
    if keys[1] != pubkey(sender)?
        || sponsor == sender
        || raw[65..MESSAGE_OFFSET] != [0; 64]
        || !verify_signature(&raw[MESSAGE_OFFSET..], &raw[1..65], &sponsor)
    {
        return Err(ApiError::new(
            "PROVIDER_REJECTED",
            "Solana sponsorship could not be verified.",
        ));
    }
    let expected = decode_message(&transfer_message(
        sender, recipient, amount, &blockhash, &sponsor, &sponsor,
    )?)?;
    if !same_instructions(&message, &expected, &pubkey(sender)?) {
        return Err(ApiError::new(
            "PROVIDER_REJECTED",
            "The sponsored transaction does not match the USDC transfer or rent sponsorship.",
        ));
    }
    Ok((sponsor, blockhash))
}

pub fn attach_signature(
    prepared: &Value,
    submitted: &Value,
    sender: &str,
) -> Result<Value, ApiError> {
    let invalid = || {
        ApiError::new(
            "FORBIDDEN",
            "The signed transaction does not match the reviewed USDC transfer.",
        )
    };
    let decode = |value: &Value| {
        STANDARD
            .decode(value.as_str().unwrap_or_default())
            .map_err(|_| invalid())
    };
    let unsigned = decode_transaction(prepared["transaction"].as_str().unwrap_or_default())
        .map_err(|_| invalid())?;
    let signed = decode(&submitted["transaction"])?;
    if signed.len() != unsigned.len()
        || signed[..65] != unsigned[..65]
        || signed[MESSAGE_OFFSET..] != unsigned[MESSAGE_OFFSET..]
        || !verify_signature(
            &signed[MESSAGE_OFFSET..],
            &signed[65..MESSAGE_OFFSET],
            sender,
        )
    {
        return Err(invalid());
    }
    Ok(
        json!({"transaction": STANDARD.encode(&signed), "signature":bs58::encode(&signed[1..65]).into_string()}),
    )
}
/// Persisted signature is also the transaction ID, so ambiguous submissions remain queryable.
pub async fn broadcast(state: &AppState, signed: &Value) -> Result<(), ApiError> {
    verify_chain(state).await?;
    let result = chain_rpc(state, "sendTransaction", json!([signed["transaction"], {"encoding":"base64", "preflightCommitment":"confirmed", "skipPreflight":false, "maxRetries":3}])).await?;
    if result != signed["signature"] {
        return Err(ApiError::unavailable());
    }
    Ok(())
}
/// Confirm the exact signed message, not only a provider status or matching token balance.
pub fn receipt_matches(receipt: &Value, signature: &str, prepared: &Value) -> bool {
    let Some(encoded) = receipt["transaction"][0].as_str() else {
        return false;
    };
    let Ok(raw) = STANDARD.decode(encoded) else {
        return false;
    };
    let Ok(unsigned) = STANDARD.decode(prepared["transaction"].as_str().unwrap_or_default()) else {
        return false;
    };
    raw.len() > MESSAGE_OFFSET
        && raw.len() == unsigned.len()
        && raw[0] == 2
        && raw[..65] == unsigned[..65]
        && bs58::encode(&raw[1..65]).into_string() == signature
        && raw[MESSAGE_OFFSET..] == unsigned[MESSAGE_OFFSET..]
}
