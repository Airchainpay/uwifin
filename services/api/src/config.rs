/// Secrets are intentionally neither Debug nor Serialize.
#[derive(Clone)]
pub struct Config {
    pub providers: Vec<crate::networks::ProviderConfig>,
    pub app_env: String,
    pub app_base_url: String,
    pub database_url: String,
    pub network: String,
    pub chain_id: u64,
    pub usdc_address: String,
    pub alchemy_rpc_url: Option<String>,
    pub alchemy_wallet_url: Option<String>,
    pub alchemy_policy_id: Option<String>,
    pub stripe_api_url: String,
    pub stripe_secret_key: Option<String>,
    pub stripe_publishable_key: Option<String>,
    pub stripe_webhook_secret: Option<String>,
    pub stripe_onramp_enabled: bool,
    pub confirmations: u64,
    pub transfer_limit_atomic: i64,
}
impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let value = |key: &str| {
            std::env::var(key)
                .ok()
                .filter(|v| !v.is_empty() && !v.starts_with("your-") && !v.starts_with("change-me"))
        };
        let app_env = value("APP_ENV").unwrap_or_else(|| "development".into());
        let app_base_url = value("APP_BASE_URL").unwrap_or_else(|| "http://localhost:3000".into());
        let network = value("ALCHEMY_NETWORK").unwrap_or_else(|| "base".into());
        let (chain_id, usdc_address, _) = crate::networks::details(&network)?;
        if app_env == "production" {
            anyhow::ensure!(
                app_base_url.starts_with("https://"),
                "Production requires an HTTPS APP_BASE_URL"
            );
            anyhow::ensure!(
                value("DATABASE_URL").is_some(),
                "Production requires DATABASE_URL"
            );
        }
        let mut networks = crate::networks::MAINNETS.to_vec();
        if network == "base-sepolia" {
            networks.push("base-sepolia");
        }
        let mut providers = Vec::new();
        for name in networks {
            let prefix = match name {
                "base" => "BASE",
                "eth-mainnet" => "ETHEREUM",
                "solana-mainnet" => "SOLANA",
                _ => "BASE_SEPOLIA",
            };
            let key =
                value(&format!("{prefix}_ALCHEMY_API_KEY")).or_else(|| value("ALCHEMY_API_KEY"));
            // Legacy overrides apply only to the default network, never to another chain.
            let rpc_url = value(&format!("{prefix}_RPC_URL"))
                .or_else(|| {
                    if name == network {
                        value("ALCHEMY_RPC_URL")
                    } else {
                        None
                    }
                })
                .or_else(|| {
                    key.as_ref()
                        .map(|key| crate::networks::alchemy_rpc_url(name, key))
                });
            let wallet_url = if name == "solana-mainnet" {
                None
            } else {
                value(&format!("{prefix}_WALLET_URL"))
                    .or_else(|| {
                        if name == network {
                            value("ALCHEMY_WALLET_URL")
                        } else {
                            None
                        }
                    })
                    .or_else(|| key.map(|key| format!("https://api.g.alchemy.com/v2/{key}")))
            };
            let policy_id = value(&format!("{prefix}_POLICY_ID")).or_else(|| {
                if name == network {
                    value("ALCHEMY_POLICY_ID")
                } else {
                    None
                }
            });
            providers.push(crate::networks::ProviderConfig {
                network: name.into(),
                rpc_url,
                wallet_url,
                policy_id,
            });
        }
        let selected = providers
            .iter()
            .find(|p| p.network == network)
            .expect("configured network");
        let alchemy_rpc_url = selected.rpc_url.clone();
        let alchemy_wallet_url = selected.wallet_url.clone();
        let alchemy_policy_id = selected.policy_id.clone();
        let stripe_api_url =
            value("STRIPE_API_URL").unwrap_or_else(|| "https://api.stripe.com".into());
        for endpoint in providers
            .iter()
            .flat_map(|p| p.rpc_url.iter().chain(p.wallet_url.iter()))
            .chain(std::iter::once(&stripe_api_url))
        {
            let parsed = reqwest::Url::parse(endpoint)?;
            anyhow::ensure!(
                parsed.scheme() == "https"
                    || (app_env != "production"
                        && parsed.scheme() == "http"
                        && matches!(parsed.host_str(), Some("localhost" | "127.0.0.1"))),
                "Providers require HTTPS, except localhost development fixtures"
            );
        }
        if app_env == "production" {
            anyhow::ensure!(
                stripe_api_url == "https://api.stripe.com",
                "Production Stripe traffic must use api.stripe.com"
            );
        }
        let stripe_secret_key = value("STRIPE_SECRET_KEY");
        let stripe_publishable_key = value("STRIPE_PUBLISHABLE_KEY");
        if let Some(secret) = &stripe_secret_key {
            anyhow::ensure!(
                secret.starts_with("sk_test_") || secret.starts_with("sk_live_"),
                "Invalid Stripe key type"
            );
            if let Some(public) = &stripe_publishable_key {
                anyhow::ensure!(
                    (secret.starts_with("sk_live_") && public.starts_with("pk_live_"))
                        || (secret.starts_with("sk_test_") && public.starts_with("pk_test_")),
                    "Stripe key modes must agree"
                );
            }
        }
        let confirmations = value("BLOCK_CONFIRMATIONS")
            .unwrap_or_else(|| "3".into())
            .parse::<u64>()?;
        anyhow::ensure!(
            (1..=100).contains(&confirmations),
            "BLOCK_CONFIRMATIONS must be 1 to 100"
        );
        let transfer_limit_atomic = value("MAX_TRANSFER_ATOMIC")
            .unwrap_or_else(|| "1000000000".into())
            .parse::<i64>()?;
        anyhow::ensure!(
            transfer_limit_atomic > 0,
            "MAX_TRANSFER_ATOMIC must be positive"
        );
        Ok(Self {
            providers,
            database_url: value("DATABASE_URL")
                .unwrap_or_else(|| "mysql://uwifin:uwifin@localhost:3306/uwifin".into()),
            app_env,
            app_base_url,
            network,
            chain_id,
            usdc_address: usdc_address.into(),
            alchemy_rpc_url,
            alchemy_wallet_url,
            alchemy_policy_id,
            stripe_api_url,
            stripe_secret_key,
            stripe_publishable_key,
            stripe_webhook_secret: value("STRIPE_WEBHOOK_SECRET")
                .filter(|secret| secret.starts_with("whsec_") && secret.len() > 16),
            stripe_onramp_enabled: value("STRIPE_ONRAMP_ENABLED").as_deref() == Some("true"),
            confirmations,
            transfer_limit_atomic,
        })
    }
    pub fn for_network(&self, network: &str) -> anyhow::Result<Self> {
        let provider = self
            .providers
            .iter()
            .find(|p| p.network == network)
            .ok_or_else(|| anyhow::anyhow!("Network is not enabled in this deployment"))?;
        let (chain_id, usdc_address, _) = crate::networks::details(network)?;
        let mut config = self.clone();
        config.network = network.into();
        config.chain_id = chain_id;
        config.usdc_address = usdc_address.into();
        config.alchemy_rpc_url = provider.rpc_url.clone();
        config.alchemy_wallet_url = provider.wallet_url.clone();
        config.alchemy_policy_id = provider.policy_id.clone();
        Ok(config)
    }
    pub fn is_solana(&self) -> bool {
        self.network == "solana-mainnet"
    }
    pub fn transfers_enabled(&self) -> bool {
        self.wallet_enabled() && self.alchemy_policy_id.is_some()
    }
    pub fn wallet_enabled(&self) -> bool {
        self.alchemy_rpc_url.is_some() && (self.is_solana() || self.alchemy_wallet_url.is_some())
    }
    pub fn onramp_enabled(&self) -> bool {
        self.stripe_onramp_enabled
            && self.network == "base"
            && self.stripe_secret_key.is_some()
            && self.stripe_publishable_key.is_some()
            && self.stripe_webhook_secret.is_some()
    }
    pub fn stripe_live(&self) -> bool {
        self.stripe_secret_key
            .as_ref()
            .is_some_and(|key| key.starts_with("sk_live_"))
    }
}
