use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
#[derive(Debug, Serialize)]
pub struct ApiError {
    pub error: ErrorDetail,
}
#[derive(Debug, Serialize)]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
    pub request_id: String,
}
impl ApiError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            error: ErrorDetail {
                code: code.into(),
                message: message.into(),
                request_id: crate::security::request_id(),
            },
        }
    }
    pub fn unavailable() -> Self {
        Self::new(
            "SERVICE_UNAVAILABLE",
            "This service is temporarily unavailable. Please try again.",
        )
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(_: sqlx::Error) -> Self {
        Self::new("INTERNAL_ERROR", "Unable to complete this request.")
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self.error.code.as_str() {
            "UNAUTHORIZED" => StatusCode::UNAUTHORIZED,
            "FORBIDDEN" => StatusCode::FORBIDDEN,
            "NOT_FOUND" => StatusCode::NOT_FOUND,
            "CONFLICT" => StatusCode::CONFLICT,
            "RATE_LIMITED" => StatusCode::TOO_MANY_REQUESTS,
            "SERVICE_UNAVAILABLE" | "PROVIDER_NOT_CONFIGURED" => StatusCode::SERVICE_UNAVAILABLE,
            "INTERNAL_ERROR" => StatusCode::INTERNAL_SERVER_ERROR,
            _ => StatusCode::BAD_REQUEST,
        };
        (status, Json(self)).into_response()
    }
}
