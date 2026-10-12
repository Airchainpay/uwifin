use crate::{
    error::ApiError,
    security::{audit, hash},
    state::AppState,
};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{TryRng, rngs::SysRng};
use serde::{Deserialize, Serialize};

/// Hash on a blocking worker: Argon2 generates a fresh OS-random salt for each call.
fn hash_password(password: &str) -> Result<String, ApiError> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|hash| hash.to_string())
        .map_err(|_| ApiError::unavailable())
}

/// Stored PHC parameters are used when verifying hashes created by earlier versions.
fn verify_password(password: &str, stored_hash: &str) -> Result<bool, ApiError> {
    let parsed = PasswordHash::new(stored_hash).map_err(|_| ApiError::unavailable())?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok())
}

fn generate_session_token() -> Result<String, ApiError> {
    let mut bytes = [0u8; 32];
    SysRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| ApiError::unavailable())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct UserResponse {
    pub id: String,
    pub email: String,
    pub name: String,
    pub role: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    pub email: String,
    pub password: String,
    pub name: Option<String>,
}
#[derive(Serialize)]
pub struct SessionResponse {
    pub user: UserResponse,
    pub session_id: String,
}

fn email(value: &str) -> Result<String, ApiError> {
    let value = value.trim().to_ascii_lowercase();
    if value.len() > 254
        || !value.is_ascii()
        || value.bytes().any(|c| c.is_ascii_whitespace())
        || value.matches('@').count() != 1
    {
        return Err(ApiError::new(
            "INVALID_REQUEST",
            "Enter a valid email address.",
        ));
    }
    let (local, domain) = value
        .split_once('@')
        .ok_or_else(|| ApiError::new("INVALID_REQUEST", "Enter a valid email address."))?;
    if local.is_empty() || !domain.contains('.') || domain.starts_with('.') || domain.ends_with('.')
    {
        return Err(ApiError::new(
            "INVALID_REQUEST",
            "Enter a valid email address.",
        ));
    }
    Ok(value)
}
pub fn validate_name(value: &str) -> Result<String, ApiError> {
    let name = value.trim();
    if !(2..=60).contains(&name.chars().count()) || name.chars().any(char::is_control) {
        return Err(ApiError::new(
            "INVALID_REQUEST",
            "Name must contain 2 to 60 characters.",
        ));
    }
    Ok(name.into())
}
pub fn session_token(headers: &HeaderMap) -> Result<&str, ApiError> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|token| token.len() >= 32 && token.len() <= 128)
        .ok_or_else(|| ApiError::new("UNAUTHORIZED", "Please sign in to continue."))
}
pub async fn authorize(state: &AppState, headers: &HeaderMap) -> Result<UserResponse, ApiError> {
    let token = session_token(headers)?;
    let user = sqlx::query_as::<_, UserResponse>("SELECT u.id, u.email, u.name, u.role, u.created_at FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.session_hash = ? AND s.revoked_at IS NULL AND s.expires_at > NOW() AND u.status = 'active'")
        .bind(hash(token)).fetch_optional(&state.pool).await?.ok_or_else(|| ApiError::new("UNAUTHORIZED", "Your session has expired. Please sign in again."))?;
    state.limits.check(format!("user:{}", user.id), 120)?;
    tracing::info!(
        request_id = crate::security::request_id(),
        user_id = user.id,
        operation = "authorize",
        "request authenticated"
    );
    Ok(user)
}
async fn issue(connection: &mut sqlx::MySqlConnection, user_id: &str) -> Result<String, ApiError> {
    let token = generate_session_token()?;
    sqlx::query("INSERT INTO sessions (id, user_id, session_hash, expires_at, created_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY), NOW())")
        .bind(uuid::Uuid::new_v4().to_string()).bind(user_id).bind(hash(&token)).execute(connection).await?;
    Ok(token)
}
pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<Credentials>,
) -> Result<(StatusCode, Json<SessionResponse>), ApiError> {
    let email = email(&req.email)?;
    let name = validate_name(req.name.as_deref().unwrap_or("UwiFin user"))?;
    if !(12..=128).contains(&req.password.len()) {
        return Err(ApiError::new(
            "INVALID_REQUEST",
            "Use a password between 12 and 128 characters.",
        ));
    }
    state
        .limits
        .check(format!("auth-email:{}", hash(&email)), 5)?;
    let permit = state
        .password_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::new("RATE_LIMITED", "Please try again shortly."))?;
    let password_hash = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        hash_password(&req.password)
    })
    .await
    .map_err(|_| ApiError::unavailable())??;
    let user_id = uuid::Uuid::new_v4().to_string();
    let mut tx = state.pool.begin().await?;
    let inserted = sqlx::query("INSERT INTO users (id, email, name, password_hash, status, created_at, updated_at, last_login_at) VALUES (?, ?, ?, ?, 'active', NOW(), NOW(), NOW())")
        .bind(&user_id).bind(&email).bind(&name).bind(password_hash).execute(&mut *tx).await;
    if let Err(err) = inserted {
        return Err(
            if err
                .as_database_error()
                .is_some_and(|err| err.is_unique_violation())
            {
                ApiError::new(
                    "INVALID_REQUEST",
                    "An account could not be created with these details. Try signing in.",
                )
            } else {
                err.into()
            },
        );
    }
    let session_id = issue(&mut tx, &user_id).await?;
    audit(&mut tx, &user_id, "account.registered").await?;
    let user = sqlx::query_as::<_, UserResponse>(
        "SELECT id, email, name, role, created_at FROM users WHERE id = ?",
    )
    .bind(&user_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(SessionResponse { user, session_id }),
    ))
}
#[derive(sqlx::FromRow)]
struct LoginRecord {
    id: String,
    password_hash: String,
    status: String,
}
pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<Credentials>,
) -> Result<Json<SessionResponse>, ApiError> {
    let email = email(&req.email)?;
    if req.password.is_empty() || req.password.len() > 128 {
        return Err(ApiError::new("UNAUTHORIZED", "Invalid email or password."));
    }
    state
        .limits
        .check(format!("auth-email:{}", hash(&email)), 5)?;
    let record = sqlx::query_as::<_, LoginRecord>(
        "SELECT id, password_hash, status FROM users WHERE email = ?",
    )
    .bind(&email)
    .fetch_optional(&state.pool)
    .await?;
    let permit = state
        .password_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::new("RATE_LIMITED", "Please try again shortly."))?;
    let stored_hash = record.as_ref().map(|user| user.password_hash.clone());
    let valid = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if let Some(stored_hash) = stored_hash {
            verify_password(&req.password, &stored_hash).unwrap_or(false)
        } else {
            // Spend the same password-hashing work for unknown accounts.
            let _ = hash_password(&req.password);
            false
        }
    })
    .await
    .map_err(|_| ApiError::unavailable())?;
    let record = record
        .filter(|user| valid && user.status == "active")
        .ok_or_else(|| ApiError::new("UNAUTHORIZED", "Invalid email or password."))?;
    let mut tx = state.pool.begin().await?;
    // Serialize session issuance with password changes, which revoke sessions under this row lock.
    let current: (String, String) =
        sqlx::query_as("SELECT password_hash, status FROM users WHERE id = ? FOR UPDATE")
            .bind(&record.id)
            .fetch_one(&mut *tx)
            .await?;
    if current.0 != record.password_hash || current.1 != "active" {
        return Err(ApiError::new("UNAUTHORIZED", "Invalid email or password."));
    }
    let session_id = issue(&mut tx, &record.id).await?;
    sqlx::query("UPDATE users SET last_login_at = NOW() WHERE id = ?")
        .bind(&record.id)
        .execute(&mut *tx)
        .await?;
    audit(&mut tx, &record.id, "account.login").await?;
    let user = sqlx::query_as::<_, UserResponse>(
        "SELECT id, email, name, role, created_at FROM users WHERE id = ?",
    )
    .bind(&record.id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(SessionResponse { user, session_id }))
}
pub async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<UserResponse>, ApiError> {
    Ok(Json(authorize(&state, &headers).await?))
}
pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user = authorize(&state, &headers).await?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE sessions SET revoked_at = NOW() WHERE session_hash = ? AND user_id = ?")
        .bind(hash(session_token(&headers)?))
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    audit(&mut tx, &user.id, "account.logout").await?;
    tx.commit().await?;
    Ok(Json(serde_json::json!({ "status": "logged_out" })))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileUpdate {
    name: String,
}
pub async fn update_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ProfileUpdate>,
) -> Result<Json<UserResponse>, ApiError> {
    let mut user = authorize(&state, &headers).await?;
    let name = validate_name(&req.name)?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE users SET name = ?, updated_at = NOW() WHERE id = ?")
        .bind(&name)
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    audit(&mut tx, &user.id, "account.profile_updated").await?;
    tx.commit().await?;
    user.name = name;
    Ok(Json(user))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PasswordChange {
    current_password: String,
    new_password: String,
}
pub async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<PasswordChange>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user = authorize(&state, &headers).await?;
    state.limits.check(format!("password:{}", user.id), 5)?;
    if req.current_password.len() > 128 || !(12..=128).contains(&req.new_password.len()) {
        return Err(ApiError::new(
            "INVALID_REQUEST",
            "Use a new password between 12 and 128 characters.",
        ));
    }
    let old: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = ?")
        .bind(&user.id)
        .fetch_one(&state.pool)
        .await?;
    let previous = old.clone();
    let permit = state
        .password_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::new("RATE_LIMITED", "Try again shortly."))?;
    let new = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if !verify_password(&req.current_password, &old)? {
            return Err(ApiError::new(
                "FORBIDDEN",
                "The current password is incorrect.",
            ));
        }
        hash_password(&req.new_password)
    })
    .await
    .map_err(|_| ApiError::unavailable())??;
    let mut tx = state.pool.begin().await?;
    let changed = sqlx::query(
        "UPDATE users SET password_hash = ?,updated_at = NOW() WHERE id = ? AND password_hash = ?",
    )
    .bind(new)
    .bind(&user.id)
    .bind(previous)
    .execute(&mut *tx)
    .await?;
    if changed.rows_affected() != 1 {
        return Err(ApiError::new(
            "CONFLICT",
            "Your password changed. Sign in again.",
        ));
    }
    sqlx::query("UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND session_hash <> ? AND revoked_at IS NULL").bind(&user.id).bind(hash(session_token(&headers)?)).execute(&mut *tx).await?;
    audit(&mut tx, &user.id, "account.password_changed").await?;
    tx.commit().await?;
    Ok(Json(serde_json::json!({"status":"updated"})))
}
pub async fn revoke_other_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user = authorize(&state, &headers).await?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND session_hash <> ? AND revoked_at IS NULL").bind(&user.id).bind(hash(session_token(&headers)?)).execute(&mut *tx).await?;
    audit(&mut tx, &user.id, "account.other_sessions_revoked").await?;
    tx.commit().await?;
    Ok(Json(serde_json::json!({"status":"revoked"})))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Generated with Argon2 0.5.3's defaults and the synthetic salt "uwifin-test-salt!".
    const LEGACY_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$dXdpZmluLXRlc3Qtc2FsdCE$Gr/O/SUJR0TPjfo3bgY7HpGBYdC4qHM9g+kQNiDbQhg";

    #[test]
    fn verifies_passwords_created_before_the_upgrade() {
        assert!(verify_password("legacy-password-123", LEGACY_HASH).unwrap());
        assert!(!verify_password("incorrect-password", LEGACY_HASH).unwrap());
        assert!(verify_password("legacy-password-123", "malformed-hash").is_err());
    }

    #[test]
    fn password_hashes_keep_the_parameters_and_use_fresh_salts() {
        let password = "synthetic-password-123";
        let first = hash_password(password).unwrap();
        let second = hash_password(password).unwrap();
        for encoded in [&first, &second] {
            assert!(encoded.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"));
            assert!(verify_password(password, encoded).unwrap());
            assert!(!verify_password("incorrect-password", encoded).unwrap());
        }
        let first = PasswordHash::new(&first).unwrap();
        let second = PasswordHash::new(&second).unwrap();
        assert!(first.salt.is_some());
        assert!(second.salt.is_some());
        assert_ne!(first.salt, second.salt);
    }

    #[test]
    fn session_tokens_remain_random_and_url_safe() {
        let first = generate_session_token().unwrap();
        let second = generate_session_token().unwrap();
        assert_ne!(first, second);
        for token in [first, second] {
            assert_eq!(token.len(), 43);
            assert!(
                token
                    .bytes()
                    .all(|byte| { byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' })
            );
            assert_eq!(URL_SAFE_NO_PAD.decode(&token).unwrap().len(), 32);
            let mut headers = HeaderMap::new();
            headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
            assert_eq!(session_token(&headers).unwrap(), token);
        }
    }

    #[test]
    fn session_hashes_keep_the_sha256_format() {
        assert_eq!(
            hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
