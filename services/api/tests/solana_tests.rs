use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;
use uwifin_api::{networks, solana, solana_deposits};
fn owner(seed: u8) -> (SigningKey, String) {
    let key = SigningKey::from_bytes(&[seed; 32]);
    let address = bs58::encode(key.verifying_key().as_bytes()).into_string();
    (key, address)
}
#[test]
fn native_usdc_network_allowlist() {
    assert_eq!(networks::details("base").unwrap().0, 8453);
    assert_eq!(networks::details("eth-mainnet").unwrap().0, 1);
    assert_eq!(
        networks::details("solana-mainnet").unwrap().1,
        networks::SOLANA_USDC
    );
    assert!(networks::details("solana-devnet").is_err());
    assert!(networks::details("polygon").is_err());
}
#[test]
fn solana_ownership_preserves_case_and_rejects_wrong_signers() {
    let (key, address) = owner(1);
    let (_, other) = owner(2);
    assert_eq!(solana::validate_address(&address).unwrap(), address);
    for invalid in [
        "",
        "0x1111111111111111111111111111111111111111",
        "11111111111111111111111111111111",
    ] {
        assert!(solana::validate_address(invalid).is_err());
    }
    let message = "challenge: mainnet; user: synthetic; nonce: unique";
    let signature = STANDARD.encode(key.sign(message.as_bytes()).to_bytes());
    assert!(solana::verify_ownership(message, &signature, &address));
    assert!(!solana::verify_ownership(
        "another challenge",
        &signature,
        &address
    ));
    assert!(!solana::verify_ownership(message, &signature, &other));
    assert!(!solana::verify_ownership(message, "malformed", &address));
}
fn sponsored_bytes(sender: &str, recipient: &str, rent_payer: &str) -> (Vec<u8>, String) {
    let (sponsor_key, sponsor) = owner(4);
    let blockhash = bs58::encode([3; 32]).into_string();
    let message = solana::transfer_message(
        sender, recipient, 1_234_567, &blockhash, &sponsor, rent_payer,
    )
    .unwrap();
    let mut raw = vec![0; 129];
    raw[0] = 2;
    raw[1..65].copy_from_slice(&sponsor_key.sign(&message).to_bytes());
    raw.extend_from_slice(&message);
    (raw, sponsor)
}
#[test]
fn sponsored_transaction_requires_valid_sponsor_and_sponsored_rent() {
    let (_, sender) = owner(1);
    let (_, recipient) = owner(2);
    let (_, sponsor) = owner(4);
    let (mut raw, _) = sponsored_bytes(&sender, &recipient, &sponsor);
    let encoded = STANDARD.encode(&raw);
    assert_eq!(
        solana::validate_sponsored(&encoded, &sender, &recipient, 1_234_567)
            .unwrap()
            .0,
        sponsor
    );
    assert!(solana::validate_sponsored(&encoded, &sender, &recipient, 1_234_568).is_err());
    let (owner_rent, _) = sponsored_bytes(&sender, &recipient, &sender);
    assert!(
        solana::validate_sponsored(&STANDARD.encode(owner_rent), &sender, &recipient, 1_234_567)
            .is_err()
    );
    raw[1..65].fill(0);
    assert!(
        solana::validate_sponsored(&STANDARD.encode(&raw), &sender, &recipient, 1_234_567).is_err()
    );
}
#[test]
fn signed_solana_message_is_immutable_and_receipt_must_match() {
    let (key, address) = owner(1);
    let (_, recipient) = owner(2);
    let (_, sponsor) = owner(4);
    let (unsigned, _) = sponsored_bytes(&address, &recipient, &sponsor);
    let prepared = json!({"transaction":STANDARD.encode(&unsigned)});
    let mut signed = unsigned.clone();
    signed[65..129].copy_from_slice(&key.sign(&unsigned[129..]).to_bytes());
    let accepted = solana::attach_signature(
        &prepared,
        &json!({"transaction":STANDARD.encode(&signed)}),
        &address,
    )
    .unwrap();
    assert!(
        solana::attach_signature(
            &prepared,
            &json!({"transaction":STANDARD.encode(&signed)}),
            &recipient
        )
        .is_err()
    );
    let signature = accepted["signature"].as_str().unwrap();
    assert_eq!(signature, bs58::encode(&unsigned[1..65]).into_string());
    let receipt = json!({"transaction":[STANDARD.encode(&signed), "base64"]});
    assert!(solana::receipt_matches(&receipt, signature, &prepared));
    assert!(!solana::receipt_matches(&receipt, "wrong", &prepared));
    let mut missing_sponsor = signed.clone();
    missing_sponsor[1..65].fill(0);
    assert!(
        solana::attach_signature(
            &prepared,
            &json!({"transaction":STANDARD.encode(missing_sponsor)}),
            &address
        )
        .is_err()
    );
    *signed.last_mut().unwrap() ^= 1;
    let changed_signature = key.sign(&signed[129..]).to_bytes();
    signed[65..129].copy_from_slice(&changed_signature);
    assert!(
        solana::attach_signature(
            &prepared,
            &json!({"transaction":STANDARD.encode(&signed)}),
            &address
        )
        .is_err()
    );
    assert!(solana::attach_signature(&prepared, &json!({"transaction":"AA=="}), &address).is_err());
}
#[test]
fn default_alchemy_hosts_match_provider_networks() {
    assert_eq!(
        networks::alchemy_rpc_url("base", "fixture"),
        "https://base-mainnet.g.alchemy.com/v2/fixture"
    );
    for network in ["eth-mainnet", "solana-mainnet", "base-sepolia"] {
        assert_eq!(
            networks::alchemy_rpc_url(network, "fixture"),
            format!("https://{network}.g.alchemy.com/v2/fixture")
        );
    }
}
#[test]
fn deposits_only_count_native_usdc_net_credits() {
    let (_, address) = owner(1);
    let account = solana::associated_account(&address).unwrap().to_string();
    let balance = |amount: &str| json!({"accountIndex":1,"mint":networks::SOLANA_USDC,"owner":address,"programId":solana::TOKEN_PROGRAM,"uiTokenAmount":{"amount":amount,"decimals":6}});
    let mut receipt = json!({"transaction":{"message":{"accountKeys":[{"pubkey":address},{"pubkey":account}]}},"meta":{"preTokenBalances":[balance("10")],"postTokenBalances":[balance("1000010")]}});
    assert_eq!(
        solana_deposits::net_credit(&receipt, &account, &address).unwrap(),
        Some(1_000_000)
    );
    receipt["meta"]["postTokenBalances"] = json!([balance("1")]);
    assert_eq!(
        solana_deposits::net_credit(&receipt, &account, &address).unwrap(),
        None
    );
    receipt["meta"]["postTokenBalances"][0]["mint"] = json!(address);
    assert!(solana_deposits::net_credit(&receipt, &account, &address).is_err());
}
