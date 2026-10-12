//! Vetted native USDC deployments (Circle); token addresses cannot be overridden.
pub const MAINNETS: [&str; 3] = ["base", "eth-mainnet", "solana-mainnet"];
pub const SOLANA_USDC: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
pub fn details(network: &str) -> anyhow::Result<(u64, &'static str, &'static str)> {
    Ok(match network {
        "base" => (
            8453,
            "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "Base mainnet",
        ),
        "eth-mainnet" => (
            1,
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "Ethereum mainnet",
        ),
        // Solana has no EVM chain ID. Zero must never be passed to an EVM signer.
        "solana-mainnet" => (0, SOLANA_USDC, "Solana mainnet"),
        "base-sepolia" => (
            84532,
            "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            "Base Sepolia · Testnet",
        ),
        _ => anyhow::bail!("Unsupported network"),
    })
}
#[derive(Clone)]
pub struct ProviderConfig {
    pub network: String,
    pub rpc_url: Option<String>,
    pub wallet_url: Option<String>,
    pub policy_id: Option<String>,
}

pub fn alchemy_rpc_url(network: &str, key: &str) -> String {
    let host = if network == "base" {
        "base-mainnet"
    } else {
        network
    };
    format!("https://{host}.g.alchemy.com/v2/{key}")
}
