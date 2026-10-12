use crate::{config::Config, security::RateLimits};
use sqlx::MySqlPool;
use std::sync::Arc;
#[derive(Clone)]
pub struct AppState {
    pub pool: MySqlPool,
    pub config: Arc<Config>,
    pub http: reqwest::Client,
    pub limits: Arc<RateLimits>,
    pub password_slots: Arc<tokio::sync::Semaphore>,
}
impl AppState {
    pub fn for_network(&self, network: &str) -> anyhow::Result<Self> {
        let mut state = self.clone();
        state.config = Arc::new(self.config.for_network(network)?);
        Ok(state)
    }
    pub fn new(pool: MySqlPool, config: Config) -> Self {
        Self {
            pool,
            config: Arc::new(config),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(12))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("HTTP client configuration"),
            limits: Arc::new(RateLimits::default()),
            password_slots: Arc::new(tokio::sync::Semaphore::new(4)),
        }
    }
}
