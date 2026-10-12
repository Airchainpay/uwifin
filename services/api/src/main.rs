use uwifin_api::{app, config::Config, db, state::AppState};
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt().json().init();
    let config = Config::from_env()?;
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(&config.database_url)
        .await?;
    db::run_migrations(&pool).await?;
    let state = AppState::new(pool, config);
    let worker_state = state.clone();
    let worker = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            for provider in &worker_state.config.providers {
                let scoped = worker_state
                    .for_network(&provider.network)
                    .expect("validated network");
                if let Err(error) = uwifin_api::transaction::reconcile_pending(&scoped).await {
                    tracing::warn!(
                        error_code = error.error.code,
                        "Transaction reconciliation unavailable"
                    );
                }
                if let Err(error) = uwifin_api::deposits::reconcile(&scoped).await {
                    tracing::warn!(
                        error_code = error.error.code,
                        "Deposit reconciliation unavailable"
                    );
                }
                if let Err(error) = uwifin_api::payments::reconcile_pending(&scoped).await {
                    tracing::warn!(
                        error_code = error.error.code,
                        "Payment reconciliation unavailable"
                    );
                }
            }
        }
    });
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await?;
    tracing::info!("UwiFin API listening on port 8080; financial providers require configuration");
    axum::serve(
        listener,
        app(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    worker.abort();
    Ok(())
}
