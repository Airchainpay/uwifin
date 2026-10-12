-- Keep existing records and checksums; add native USDC deployments only.
INSERT INTO networks (id) VALUES ('eth-mainnet'), ('solana-mainnet');
INSERT INTO assets (id, symbol, contract_address, network, decimals, is_active, created_at) VALUES
('ethereum-usdc', 'USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'eth-mainnet', 6, TRUE, NOW()),
('solana-usdc', 'USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'solana-mainnet', 6, TRUE, NOW());
-- Solana base58 addresses are case sensitive and can be 44 characters long.
ALTER TABLE wallets MODIFY address VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    MODIFY signer_address VARCHAR(44) CHARACTER SET ascii COLLATE ascii_bin NULL;
ALTER TABLE wallet_challenges MODIFY signer_address VARCHAR(44) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    ADD COLUMN network VARCHAR(50) NULL;
ALTER TABLE assets MODIFY contract_address VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL;
ALTER TABLE wallets ADD COLUMN solana_history_cursor VARCHAR(88) NULL,
    ADD COLUMN solana_history_head VARCHAR(88) NULL,
    ADD COLUMN solana_history_before VARCHAR(88) NULL;
