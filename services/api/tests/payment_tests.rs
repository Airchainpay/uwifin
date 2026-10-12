use serde_json::json;
use uwifin_api::{networks::stripe_network, payments::validate_session};

#[test]
fn onramp_binds_native_usdc_to_the_saved_wallet_and_network() {
    for (network, destination, address) in [
        ("base", "base", "0xAb11111111111111111111111111111111111111"),
        (
            "eth-mainnet",
            "ethereum",
            "0xAb11111111111111111111111111111111111111",
        ),
        (
            "solana-mainnet",
            "solana",
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        ),
    ] {
        assert_eq!(stripe_network(network), Some(destination));
        let session = json!({
            "object": "crypto.onramp_session", "livemode": false,
            "metadata": {"uwifin_payment_id": "payment", "uwifin_user_id": "user"},
            "transaction_details": {
                "destination_currency": "usdc", "destination_network": destination,
                "lock_wallet_address": true, "wallet_addresses": {destination: address}
            }
        });
        let verify = |session: &serde_json::Value| {
            validate_session(session, "payment", "user", address, network, false)
        };
        assert!(verify(&session).is_ok());
        for (field, bad) in [
            ("destination_currency", json!("eth")),
            ("destination_network", json!("polygon")),
            ("lock_wallet_address", json!(false)),
            ("wallet_address", json!("different-wallet")),
        ] {
            let mut changed = session.clone();
            changed["transaction_details"][field] = bad;
            assert!(verify(&changed).is_err(), "{network}: {field}");
        }
        let mut changed = session.clone();
        changed["transaction_details"]["wallet_addresses"][destination] =
            json!(address.to_lowercase());
        assert_eq!(verify(&changed).is_ok(), network != "solana-mainnet");
        assert!(validate_session(&session, "other", "user", address, network, false).is_err());
        assert!(validate_session(&session, "payment", "other", address, network, false).is_err());
        assert!(validate_session(&session, "payment", "user", address, network, true).is_err());
    }
    assert_eq!(stripe_network("base-sepolia"), None);
    assert_eq!(stripe_network("unsupported"), None);
}
