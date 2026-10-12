use serde_json::json;
use uwifin_api::{
    alchemy::{ReceiptState, contains_transfer, receipt_state},
    payments::verify_signature,
    transaction::{TransactionStatus, attach_signature, parse_amount, validate_prepared},
};
#[test]
fn exact_amounts_and_overflow() {
    assert_eq!(parse_amount("1.000001").unwrap(), 1000001);
    assert_eq!(parse_amount("9223372036854.775807").unwrap(), i64::MAX);
    for amount in [
        "0",
        "-1",
        "1e6",
        "1.0000001",
        "9223372036854.775808",
        "1.",
        ".1",
    ] {
        assert!(parse_amount(amount).is_err(), "{amount}");
    }
}
#[test]
fn terminal_states_cannot_be_reopened() {
    use TransactionStatus::*;
    assert!(Pending.can_transition_to(Confirmed));
    assert!(!Created.can_transition_to(Confirmed));
    assert!(!Confirmed.can_transition_to(Submitted));
    assert!(!Failed.can_transition_to(Pending));
}
#[test]
fn sponsorship_and_signed_payload_are_bound() {
    let sender = "0x1111111111111111111111111111111111111111";
    let mut prepared = json!({"type":"user-operation-v070", "chainId":"0x2105", "data":{"sender":sender,"paymaster":sender,"nonce":"0x0"},"signatureRequest":{"type":"personal_sign"},"feePayment":{"sponsored":true}});
    assert!(validate_prepared(&prepared, sender, 8453).is_ok());
    assert!(validate_prepared(&prepared, sender, 84532).is_err());
    let mut signed = prepared.clone();
    signed["signature"] = json!({"type":"secp256k1","data":format!("0x{}", "11".repeat(65))});
    assert!(attach_signature(&prepared, &signed).is_ok());
    signed["data"]["nonce"] = json!("0x1");
    assert!(attach_signature(&prepared, &signed).is_err());
    prepared["feePayment"]["sponsored"] = json!(false);
    assert!(validate_prepared(&prepared, sender, 8453).is_err());
    prepared["data"]["paymaster"] = json!("");
    prepared["data"]["paymasterAndData"] = json!("💰".repeat(30));
    assert!(validate_prepared(&prepared, sender, 8453).is_err());
}
#[test]
fn successful_http_is_not_settlement() {
    assert_eq!(receipt_state(&json!(null)).unwrap(), ReceiptState::Pending);
    assert!(receipt_state(&json!({"status":200})).is_err());
    assert_eq!(
        receipt_state(&json!({"status":"0x0"})).unwrap(),
        ReceiptState::Failed
    );
    let sender = "0x1111111111111111111111111111111111111111";
    let recipient = "0x2222222222222222222222222222222222222222";
    let token = "0x3333333333333333333333333333333333333333";
    let receipt = json!({"logs":[{"address": token, "topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",format!("0x{:0>64}",&sender[2..]),format!("0x{:0>64}",&recipient[2..])],"data":"0x0f4240"}]});
    assert!(contains_transfer(
        &receipt, token, sender, recipient, 1000000
    ));
    assert!(!contains_transfer(
        &receipt, token, sender, recipient, 1000001
    ));
    assert!(!contains_transfer(
        &receipt, recipient, sender, recipient, 1000000
    ));
    assert!(!contains_transfer(&receipt, token, "", recipient, 1000000));
}
#[test]
fn webhook_signature_replay_and_tampering() {
    use hmac::{Hmac, KeyInit, Mac};
    use sha2::Sha256;
    let secret = "synthetic-webhook-secret";
    let payload = br#"{"id":"evt_fixture"}"#;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(b"1000.");
    mac.update(payload);
    let digest = hex::encode(mac.finalize().into_bytes());
    // Independent HMAC-SHA256 reference produced with Python's standard library.
    assert_eq!(
        digest,
        "beeaf5bf7295f5bebca7c2443c3a90996312821cf8ee0be9ac7f7d90fa5fbd5d"
    );
    let signature = format!("t=1000,v1={digest}");
    assert!(verify_signature(secret, &signature, payload, 1001));
    assert!(!verify_signature(secret, &signature, payload, 1301));
    assert!(!verify_signature(secret, &signature, b"tampered", 1001));
    assert!(!verify_signature(
        secret,
        &format!("{signature},t=1000"),
        payload,
        1001
    ));
}

#[test]
fn settlement_is_bound_to_the_operation_and_its_logs() {
    use uwifin_api::alchemy::operation_outcome;
    let sender = "0x1111111111111111111111111111111111111111";
    let recipient = "0x2222222222222222222222222222222222222222";
    let token = "0x3333333333333333333333333333333333333333";
    let hash = format!("0x{}", "ab".repeat(32));
    let topic = |address: &str| format!("0x{:0>64}", &address[2..]);
    let transfer = json!({"address":token,"topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",topic(sender),topic(recipient)],"data":"0xf4240"});
    for (kind, entrypoint) in [
        (
            "user-operation-v070",
            "0x0000000071727de22e5e9d8baf0edac6f37da032",
        ),
        (
            "user-operation-v060",
            "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789",
        ),
    ] {
        let prepared = json!({"type":kind,"data":{"sender":sender,"nonce":"0x10000000000000000"}});
        let before = json!({"address":entrypoint,"topics":["0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972"]});
        let event = |nonce: u128, success: u8| json!({"address":entrypoint,"topics":["0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f",hash,topic(sender),topic(recipient)],"data":format!("0x{nonce:064x}{success:064x}{:064x}{:064x}",10,20)});
        let check = |logs| {
            let receipt = json!({"logs":logs});
            operation_outcome(&receipt, &prepared, token, recipient, 1000000)
                .map(|outcome| outcome.map(|(hash, state)| (hash.to_owned(), state)))
        };
        let nonce = 1u128 << 64;
        assert_eq!(
            check(json!([before, transfer, event(nonce, 1)])).unwrap(),
            Some((hash.clone(), ReceiptState::Confirmed))
        );
        // Outer success and even a matching Transfer cannot override operation failure.
        assert_eq!(
            check(json!([before, transfer, event(nonce, 0)])).unwrap(),
            Some((hash.clone(), ReceiptState::Failed))
        );
        assert_eq!(
            check(json!([before, event(nonce, 1)])).unwrap(),
            Some((hash.clone(), ReceiptState::Failed))
        );
        // Transfers from validation and neighboring operations do not settle this intent.
        assert_eq!(
            check(json!([transfer, before, event(nonce, 1)])).unwrap(),
            Some((hash.clone(), ReceiptState::Failed))
        );
        assert_eq!(
            check(json!([
                before,
                transfer,
                event(nonce + 1, 1),
                event(nonce, 1)
            ]))
            .unwrap(),
            Some((hash.clone(), ReceiptState::Failed))
        );
        assert_eq!(
            check(json!([
                before,
                event(nonce, 1),
                transfer,
                event(nonce + 1, 1)
            ]))
            .unwrap(),
            Some((hash.clone(), ReceiptState::Failed))
        );
        assert_eq!(
            check(json!([before, transfer, event(nonce + 1, 1)])).unwrap(),
            None
        );
        let mut wrong_sender = event(nonce, 1);
        wrong_sender["topics"][2] = json!(topic(recipient));
        assert_eq!(
            check(json!([before, transfer, wrong_sender])).unwrap(),
            None
        );
        let mut wrong_entrypoint = event(nonce, 1);
        wrong_entrypoint["address"] = json!(token);
        assert_eq!(
            check(json!([before, transfer, wrong_entrypoint])).unwrap(),
            None
        );
        assert!(check(json!([before, transfer, event(nonce, 2)])).is_err());
        assert!(check(json!([before, transfer, event(nonce, 1), event(nonce, 1)])).is_err());
        let mut malformed = event(nonce, 1);
        malformed["data"] = json!("💰");
        assert!(check(json!([before, transfer, malformed])).is_err());
        assert!(check(json!([transfer, event(nonce, 1)])).is_err());
        let mut wrong_transfer = transfer.clone();
        wrong_transfer["address"] = json!(recipient);
        assert_eq!(
            check(json!([before, wrong_transfer, event(nonce, 1)])).unwrap(),
            Some((hash.clone(), ReceiptState::Failed))
        );
    }
}
