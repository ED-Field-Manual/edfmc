//! Frontier Developments login (OAuth 2.0, authorization code with PKCE).
//!
//! Prepared ahead of Frontier approving EDFM Companion for its Companion API
//! (CAPI). Until the approved Client ID and redirect URI are configured at build
//! time (see `config`), every entry point reports "not configured" and nothing
//! is sent anywhere. See docs/FRONTIER-AUTH.md.
//!
//! ## What is verified, and where from
//!
//! - **Endpoints**: `https://auth.frontierstore.net/auth`, `/token`, `/decode`
//!   (Frontier's OAuth guide, hosting.zaonce.net/docs/oauth2/instructions.html,
//!   and EDMarketConnector's `companion.py`).
//! - **PKCE S256**: the challenge is base64url (no padding) of the *binary*
//!   SHA-256 of the verifier; Frontier's guide warns specifically against a hex
//!   digest.
//! - **Scopes** `auth capi`: CAPI refuses a token without `auth` (EDCD FDevIDs).
//! - **Audience** `frontier,steam,epic`: what EDMC sends for PC players.
//!   Frontier's guide (2019) lists `frontier`, `steam`, `xbox`, `psn`, `all`;
//!   `epic` is taken from EDMC's current code.
//! - **Token request** (form-encoded POST to `/token`, no client secret):
//!   `grant_type=authorization_code, client_id, code_verifier, code,
//!   redirect_uri`; refresh: `grant_type=refresh_token, client_id,
//!   refresh_token` (EDMC). The Shared Key is never used or embedded.
//! - **Refresh tokens rotate**: "The refresh token will be updated each time a
//!   new access token is requested" (Frontier's guide), so every refresh stores
//!   the new one. They may also expire, after which the commander logs in again.
//!
//! ## Not verifiable before approval (isolated, see the docs)
//!
//! - **Redirect URI rules.** Frontier documents none. EDMC on Linux uses
//!   `http://localhost:<ephemeral port>/auth`, which works for its registration;
//!   whether a new registration accepts a loopback URI, and with which port
//!   rules, is Frontier's to confirm. Only loopback `http://localhost` /
//!   `http://127.0.0.1` URIs are supported here. A custom scheme (`edmc://`
//!   style) would need OS protocol registration, which is not built.
//! - **`expires_in`.** Standard OAuth, but not in Frontier's guide. When it is
//!   absent the access token is used until a CAPI call is refused.
//!
//! ## The boundary
//!
//! Tokens never leave Rust. No command returns one; errors are categories, not
//! server text (a response body could echo a code or token); nothing here logs.
//! Only the refresh token is persisted, in Windows Credential Manager through
//! `credentials.rs`. The access token lives in memory only: it is short-lived,
//! a JWE that may exceed what the credential store holds, and re-obtained from
//! the refresh token when needed.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};

pub const AUTH_SERVER: &str = "https://auth.frontierstore.net";
const AUTH_PATH: &str = "/auth";
const TOKEN_PATH: &str = "/token";
const SCOPE: &str = "auth capi";
const AUDIENCE: &str = "frontier,steam,epic";

/// The credential-store name the refresh token is filed under.
const INTEGRATION: &str = "frontier";

/// How long the commander has to finish logging in before the wait ends.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Refresh this long before the stated expiry, so a request is not sent with a
/// token that expires on the way.
const EXPIRY_MARGIN_S: u64 = 60;
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

// ------------------------------------------------------------------ config

/// Supplied at build time, never by the commander (see build.rs): the approved
/// Client ID and the redirect URI registered with it. Empty until approval.
const CLIENT_ID: Option<&str> = option_env!("EDFMC_FRONTIER_CLIENT_ID");
const REDIRECT_URI: Option<&str> = option_env!("EDFMC_FRONTIER_REDIRECT_URI");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub client_id: String,
    pub redirect: Redirect,
}

/// A loopback redirect: the browser is sent back to a listener in this app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redirect {
    /// `localhost` or `127.0.0.1`, as registered.
    pub host: String,
    /// Fixed when registered with a port; `None` means any free port, with the
    /// chosen one written into the URI (EDMC's approach on Linux).
    pub port: Option<u16>,
    pub path: String,
}

impl Redirect {
    fn uri(&self, port: u16) -> String {
        format!("http://{}:{}{}", self.host, port, self.path)
    }
}

/// Why the login cannot be used. Shown to the commander as-is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotReady {
    /// Normal until Frontier approves the app.
    AwaitingApproval,
    BadClientId,
    UnsupportedRedirect,
}

pub fn parse_config(client_id: Option<&str>, redirect_uri: Option<&str>) -> Result<Config, NotReady> {
    let client_id = client_id.map(str::trim).unwrap_or("");
    let redirect_uri = redirect_uri.map(str::trim).unwrap_or("");
    if client_id.is_empty() || redirect_uri.is_empty() {
        return Err(NotReady::AwaitingApproval);
    }
    // Frontier Client IDs are GUIDs; anything else is a configuration mistake,
    // not something to send to Frontier and find out.
    if client_id.len() > 64 || !client_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(NotReady::BadClientId);
    }
    let url = url::Url::parse(redirect_uri).map_err(|_| NotReady::UnsupportedRedirect)?;
    let host = url.host_str().unwrap_or("").to_string();
    if url.scheme() != "http" || !(host == "localhost" || host == "127.0.0.1") {
        return Err(NotReady::UnsupportedRedirect);
    }
    if url.query().is_some() || url.fragment().is_some() || !url.username().is_empty() {
        return Err(NotReady::UnsupportedRedirect);
    }
    Ok(Config {
        client_id: client_id.to_string(),
        redirect: Redirect { host, port: url.port(), path: url.path().to_string() },
    })
}

pub fn config() -> Result<Config, NotReady> {
    parse_config(CLIENT_ID, REDIRECT_URI)
}

// -------------------------------------------------------------------- PKCE

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

fn random_token() -> Result<String, Failure> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| Failure::Internal)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn challenge_for(verifier: &str) -> String {
    // Binary digest, then base64url: Frontier's guide warns against hex.
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn new_pkce() -> Result<Pkce, Failure> {
    let verifier = random_token()?;
    let challenge = challenge_for(&verifier);
    Ok(Pkce { verifier, challenge })
}

pub fn authorize_url(server: &str, client_id: &str, redirect_uri: &str, challenge: &str, state: &str) -> String {
    let mut url = url::Url::parse(server).expect("constant server URL");
    url.set_path(AUTH_PATH);
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("audience", AUDIENCE)
        .append_pair("scope", SCOPE)
        .append_pair("client_id", client_id)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("redirect_uri", redirect_uri);
    url.into()
}

// ---------------------------------------------------------------- outcomes

/// What went wrong, as a category. Never carries server text, a code or a token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Failure {
    NotConfigured,
    Busy,
    Cancelled,
    TimedOut,
    /// The commander declined at Frontier, or Frontier refused the request.
    Denied,
    /// The callback did not carry the state this login sent: not ours, ignored.
    StateMismatch,
    /// The redirect could not be received (the port is in use, say).
    CallbackUnavailable,
    /// Frontier said the code or refresh token is no longer valid.
    InvalidGrant,
    /// Frontier answered, but not with tokens.
    BadResponse,
    /// Frontier could not be reached.
    Network,
    StoreUnavailable,
    NotConnected,
    Internal,
}

impl Failure {
    pub fn message(self) -> &'static str {
        match self {
            Failure::NotConfigured => "Frontier login is not set up in this build yet.",
            Failure::Busy => "A Frontier login is already in progress.",
            Failure::Cancelled => "Login cancelled.",
            Failure::TimedOut => "The login was not finished in time. Try again.",
            Failure::Denied => "Frontier did not grant access.",
            Failure::StateMismatch => "The login response did not match this request, so it was ignored.",
            Failure::CallbackUnavailable => "EDFM Companion could not receive the login response.",
            Failure::InvalidGrant => "Frontier no longer accepts this login. Connect again.",
            Failure::BadResponse => "Frontier sent an unexpected response.",
            Failure::Network => "Frontier could not be reached.",
            Failure::StoreUnavailable => "Windows Credential Manager could not be used.",
            Failure::NotConnected => "Not connected to Frontier.",
            Failure::Internal => "Something went wrong inside EDFM Companion.",
        }
    }
}

// ----------------------------------------------------------------- callback

/// Read one HTTP request's target from the browser, e.g. `/auth?code=..&state=..`.
fn request_target(stream: &mut TcpStream) -> Option<String> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buf = [0u8; 8192];
    let mut len = 0;
    while len < buf.len() {
        let n = stream.read(&mut buf[len..]).ok()?;
        if n == 0 {
            break;
        }
        len += n;
        if buf[..len].windows(2).any(|w| w == b"\r\n") {
            break;
        }
    }
    let line = std::str::from_utf8(&buf[..len]).ok()?.lines().next()?.to_string();
    let mut parts = line.split(' ');
    match (parts.next(), parts.next()) {
        (Some("GET"), Some(target)) => Some(target.to_string()),
        _ => None,
    }
}

/// One request to the listener, judged.
#[derive(Debug, PartialEq, Eq)]
pub enum CallbackResult {
    /// Not the redirect (a favicon, say): answer it and keep waiting.
    NotOurs,
    Code(String),
    Failed(Failure),
}

/// Judge a request target against the redirect path and the state this login sent.
pub fn check_callback(target: &str, path: &str, state: &str) -> CallbackResult {
    let Ok(url) = url::Url::parse(&format!("http://localhost{target}")) else {
        return CallbackResult::NotOurs;
    };
    if url.path() != path {
        return CallbackResult::NotOurs;
    }
    let mut got_state = None;
    let mut code = None;
    let mut error = false;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "state" => got_state = Some(v.into_owned()),
            "code" => code = Some(v.into_owned()),
            "error" => error = true,
            _ => {}
        }
    }
    // State first: a response that is not for this login says nothing about it,
    // whatever else it carries.
    match got_state {
        Some(s) if constant_time_eq(s.as_bytes(), state.as_bytes()) => {}
        _ => return CallbackResult::Failed(Failure::StateMismatch),
    }
    if error {
        return CallbackResult::Failed(Failure::Denied);
    }
    match code {
        Some(c) if !c.is_empty() && c.len() <= 2048 => CallbackResult::Code(c),
        _ => CallbackResult::Failed(Failure::BadResponse),
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn respond(stream: &mut TcpStream, status: &str, text: &str) {
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>EDFM Companion</title>\
         <body style=\"font-family:Segoe UI,sans-serif;background:#121212;color:#ededed;padding:2rem\">\
         <p>{text}</p></body>"
    );
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

/// Listeners for the redirect: `localhost` may resolve to IPv4 or IPv6 in the
/// browser, so both are bound on the same port where possible.
pub fn bind(redirect: &Redirect) -> Result<(Vec<TcpListener>, u16), Failure> {
    let port = redirect.port.unwrap_or(0);
    let v4 = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).map_err(|_| Failure::CallbackUnavailable)?;
    let actual = v4.local_addr().map_err(|_| Failure::CallbackUnavailable)?.port();
    let mut listeners = vec![v4];
    if redirect.host == "localhost" {
        if let Ok(v6) = TcpListener::bind(SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], actual))) {
            listeners.push(v6);
        }
    }
    for l in &listeners {
        l.set_nonblocking(true).map_err(|_| Failure::CallbackUnavailable)?;
    }
    Ok((listeners, actual))
}

/// Wait for the browser to come back with a code, until cancelled or timed out.
pub fn wait_for_code(
    listeners: &[TcpListener],
    path: &str,
    state: &str,
    cancel: &AtomicBool,
    timeout: Duration,
) -> Result<String, Failure> {
    let deadline = Instant::now() + timeout;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(Failure::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(Failure::TimedOut);
        }
        for listener in listeners {
            let Ok((mut stream, _)) = listener.accept() else { continue };
            let _ = stream.set_nonblocking(false);
            let Some(target) = request_target(&mut stream) else { continue };
            match check_callback(&target, path, state) {
                CallbackResult::NotOurs => respond(&mut stream, "404 Not Found", "Not found."),
                CallbackResult::Code(code) => {
                    respond(&mut stream, "200 OK", "Logged in to Frontier. You can close this tab and return to EDFM Companion.");
                    return Ok(code);
                }
                CallbackResult::Failed(f) => {
                    respond(&mut stream, "400 Bad Request", f.message());
                    // A response that is not for this login is ignored, not fatal:
                    // it may be a stale tab. Anything else ends the login.
                    if f != Failure::StateMismatch {
                        return Err(f);
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

// ------------------------------------------------------------------- tokens

#[derive(Clone)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    /// Unix seconds, when Frontier said; None when it did not.
    pub expires_at: Option<u64>,
}

// Never print a token, even in a debug dump.
impl std::fmt::Debug for Tokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tokens").field("expires_at", &self.expires_at).finish_non_exhaustive()
    }
}

fn now_s() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Judge a `/token` response. The body is read here and goes nowhere else.
pub fn parse_token_response(status: u16, body: &str, now: u64) -> Result<Tokens, Failure> {
    let json: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    if !(200..300).contains(&status) {
        let error = json.get("error").and_then(|e| e.as_str()).unwrap_or("");
        return Err(if error == "invalid_grant" || error == "invalid_token" || status == 401 {
            Failure::InvalidGrant
        } else if error == "access_denied" {
            Failure::Denied
        } else {
            Failure::BadResponse
        });
    }
    let text = |k: &str| json.get(k).and_then(|v| v.as_str()).map(str::to_string).filter(|s| !s.is_empty());
    let (Some(access_token), Some(refresh_token)) = (text("access_token"), text("refresh_token")) else {
        return Err(Failure::BadResponse);
    };
    let expires_at = json.get("expires_in").and_then(|v| v.as_u64()).map(|s| now + s);
    Ok(Tokens { access_token, refresh_token, expires_at })
}

async fn post_token(server: &str, form: &[(&str, &str)]) -> Result<(u16, String), Failure> {
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .user_agent(concat!("EDFMCompanion/", env!("CARGO_PKG_VERSION")))
        // A redirect could carry the code or refresh token somewhere else.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Failure::Internal)?;
    let response = client
        .post(format!("{server}{TOKEN_PATH}"))
        .form(form)
        .send()
        .await
        .map_err(|_| Failure::Network)?;
    let status = response.status().as_u16();
    // Small: a token response is a few KB. Anything bigger is not one.
    let body = response.text().await.map_err(|_| Failure::Network)?;
    if body.len() > 64 * 1024 {
        return Err(Failure::BadResponse);
    }
    Ok((status, body))
}

pub async fn exchange_code(server: &str, client_id: &str, code: &str, verifier: &str, redirect_uri: &str) -> Result<Tokens, Failure> {
    let (status, body) = post_token(server, &[
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("code_verifier", verifier),
        ("code", code),
        ("redirect_uri", redirect_uri),
    ])
    .await?;
    parse_token_response(status, &body, now_s())
}

pub async fn refresh(server: &str, client_id: &str, refresh_token: &str) -> Result<Tokens, Failure> {
    let (status, body) = post_token(server, &[
        ("grant_type", "refresh_token"),
        ("client_id", client_id),
        ("refresh_token", refresh_token),
    ])
    .await?;
    parse_token_response(status, &body, now_s())
}

// -------------------------------------------------------------------- store

/// Where the refresh token is kept. Windows Credential Manager in the app; an
/// in-memory store in tests, so tests never touch the real one.
pub trait Store: Send + Sync {
    fn load(&self) -> Option<String>;
    fn save(&self, refresh_token: &str) -> Result<(), Failure>;
    fn clear(&self) -> Result<(), Failure>;
}

pub struct CredentialStore;

impl Store for CredentialStore {
    fn load(&self) -> Option<String> {
        crate::credentials::read_secret(INTEGRATION).filter(|s| !s.trim().is_empty())
    }
    fn save(&self, refresh_token: &str) -> Result<(), Failure> {
        crate::credentials::credential_set(INTEGRATION.to_string(), refresh_token.to_string())
            .map_err(|_| Failure::StoreUnavailable)
    }
    fn clear(&self) -> Result<(), Failure> {
        crate::credentials::credential_clear(INTEGRATION.to_string()).map_err(|_| Failure::StoreUnavailable)
    }
}

// -------------------------------------------------------------------- state

/// Login state for the running app. The access token is held here, in memory only.
#[derive(Default)]
pub struct FrontierState {
    access: Mutex<Option<(String, Option<u64>)>>,
    connecting: AtomicBool,
    cancel: AtomicBool,
}

impl FrontierState {
    fn remember(&self, tokens: &Tokens) {
        *self.access.lock().unwrap_or_else(|p| p.into_inner()) = Some((tokens.access_token.clone(), tokens.expires_at));
    }
    fn forget(&self) {
        *self.access.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

/// A full login: browser, callback, code exchange, storage.
pub async fn login(
    cfg: &Config,
    server: &str,
    state: &FrontierState,
    store: &dyn Store,
    open: impl FnOnce(&str) -> Result<(), Failure>,
    timeout: Duration,
) -> Result<(), Failure> {
    if state.connecting.swap(true, Ordering::SeqCst) {
        return Err(Failure::Busy);
    }
    state.cancel.store(false, Ordering::SeqCst);
    let result = async {
        let pkce = new_pkce()?;
        let csrf = random_token()?;
        let (listeners, port) = bind(&cfg.redirect)?;
        let redirect_uri = cfg.redirect.uri(port);
        open(&authorize_url(server, &cfg.client_id, &redirect_uri, &pkce.challenge, &csrf))?;
        let path = cfg.redirect.path.clone();
        let cancel = &state.cancel;
        // Polled on this task's thread in short sleeps; cheap, and cancellable.
        let code = tokio_free_wait(&listeners, &path, &csrf, cancel, timeout).await?;
        drop(listeners);
        let tokens = exchange_code(server, &cfg.client_id, &code, &pkce.verifier, &redirect_uri).await?;
        store.save(&tokens.refresh_token)?;
        state.remember(&tokens);
        Ok(())
    }
    .await;
    state.connecting.store(false, Ordering::SeqCst);
    result
}

/// `wait_for_code` without blocking the async runtime's worker for minutes.
async fn tokio_free_wait(
    listeners: &[TcpListener],
    path: &str,
    state: &str,
    cancel: &AtomicBool,
    timeout: Duration,
) -> Result<String, Failure> {
    let listeners: Vec<TcpListener> = listeners.iter().filter_map(|l| l.try_clone().ok()).collect();
    let (path, state) = (path.to_string(), state.to_string());
    // The flag is shared by pointer to a field of managed state, which outlives
    // the login; a copy of its value is polled through this Arc bridge.
    let flag = std::sync::Arc::new(AtomicBool::new(false));
    let worker_flag = flag.clone();
    let handle = tauri::async_runtime::spawn_blocking(move || {
        wait_for_code(&listeners, &path, &state, &worker_flag, timeout)
    });
    // Mirror the caller's cancel flag into the worker's until it finishes.
    let mut handle = handle;
    loop {
        if cancel.load(Ordering::SeqCst) {
            flag.store(true, Ordering::SeqCst);
        }
        tokio::select! {
            r = &mut handle => return r.map_err(|_| Failure::Internal)?,
            _ = tokio::time::sleep(Duration::from_millis(150)) => {}
        }
    }
}

/// A usable access token for a future CAPI request, refreshing when needed.
///
/// `pub(crate)` and not a command: tokens never reach the webview. Not used
/// yet; CAPI requests are out of scope until Frontier approves the app.
#[allow(dead_code)]
pub(crate) async fn access_token(cfg: &Config, server: &str, state: &FrontierState, store: &dyn Store) -> Result<String, Failure> {
    if let Some((token, expires_at)) = state.access.lock().unwrap_or_else(|p| p.into_inner()).clone() {
        let fresh = expires_at.map(|e| e > now_s() + EXPIRY_MARGIN_S).unwrap_or(true);
        if fresh {
            return Ok(token);
        }
    }
    let Some(refresh_token) = store.load() else { return Err(Failure::NotConnected) };
    match refresh(server, &cfg.client_id, &refresh_token).await {
        Ok(tokens) => {
            // Refresh tokens rotate: the old one is spent.
            store.save(&tokens.refresh_token)?;
            state.remember(&tokens);
            Ok(tokens.access_token)
        }
        Err(Failure::InvalidGrant) => {
            // Expired or revoked at Frontier: the login is over, not "try later".
            let _ = store.clear();
            state.forget();
            Err(Failure::NotConnected)
        }
        Err(other) => Err(other),
    }
}

// ----------------------------------------------------------------- commands

#[derive(Serialize)]
pub struct Status {
    /// False until the approved Client ID and redirect URI are built in.
    configured: bool,
    /// Why not, in words, when not configured.
    reason: Option<&'static str>,
    connected: bool,
    connecting: bool,
}

fn not_ready_reason(n: &NotReady) -> &'static str {
    match n {
        NotReady::AwaitingApproval => "Awaiting Frontier API Approval",
        NotReady::BadClientId => "The Frontier Client ID in this build is not valid.",
        NotReady::UnsupportedRedirect => "The Frontier redirect URI in this build is not a supported http://localhost address.",
    }
}

#[tauri::command]
pub fn frontier_status(state: tauri::State<'_, FrontierState>) -> Status {
    let cfg = config();
    Status {
        configured: cfg.is_ok(),
        reason: cfg.as_ref().err().map(not_ready_reason),
        connected: cfg.is_ok() && CredentialStore.load().is_some(),
        connecting: state.connecting.load(Ordering::SeqCst),
    }
}

/// Log in. Resolves when the login has finished, failed or been cancelled;
/// the result is a category, never a token.
#[tauri::command]
pub async fn frontier_connect(app: tauri::AppHandle, state: tauri::State<'_, FrontierState>) -> Result<(), Failure> {
    use tauri_plugin_opener::OpenerExt;
    let cfg = config().map_err(|_| Failure::NotConfigured)?;
    let opener = |url: &str| app.opener().open_url(url, None::<&str>).map_err(|_| Failure::Internal);
    login(&cfg, AUTH_SERVER, &state, &CredentialStore, opener, LOGIN_TIMEOUT).await
}

#[tauri::command]
pub fn frontier_cancel(state: tauri::State<'_, FrontierState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

/// Remove every local trace of the login: the stored refresh token and the
/// access token in memory. Frontier's side is unchanged; the commander can
/// revoke the app on Frontier's account pages.
#[tauri::command]
pub fn frontier_disconnect(state: tauri::State<'_, FrontierState>) -> Result<(), Failure> {
    state.forget();
    CredentialStore.clear()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener as StdListener;
    use std::sync::Arc;

    // ---- configuration

    #[test]
    fn unconfigured_until_both_values_exist() {
        assert_eq!(parse_config(None, None), Err(NotReady::AwaitingApproval));
        assert_eq!(parse_config(Some(""), Some("http://localhost/auth")), Err(NotReady::AwaitingApproval));
        assert_eq!(parse_config(Some("abc-123"), Some("  ")), Err(NotReady::AwaitingApproval));
        // Whatever this build was given must be usable: a typo in .env.local
        // fails here, not in front of the commander.
        if CLIENT_ID.is_none() || REDIRECT_URI.is_none() {
            assert_eq!(config(), Err(NotReady::AwaitingApproval));
        } else {
            assert!(config().is_ok(), "the Frontier values in this build are not usable: {:?}", config());
        }
    }

    #[test]
    fn accepts_loopback_redirects_only() {
        let id = Some("0a1b2c3d-0000-4000-8000-123456789abc");
        let ok = parse_config(id, Some("http://localhost:52341/auth")).unwrap();
        assert_eq!(ok.redirect, Redirect { host: "localhost".into(), port: Some(52341), path: "/auth".into() });
        assert_eq!(parse_config(id, Some("http://127.0.0.1/cb")).unwrap().redirect.port, None);
        for bad in ["edfmc://auth", "https://localhost/auth", "http://example.com/auth", "http://localhost/auth?x=1", "nonsense"] {
            assert_eq!(parse_config(id, Some(bad)), Err(NotReady::UnsupportedRedirect), "{bad}");
        }
        assert_eq!(parse_config(Some("not a guid!"), Some("http://localhost/auth")), Err(NotReady::BadClientId));
    }

    // ---- PKCE and the authorization URL

    #[test]
    fn pkce_matches_the_rfc_7636_example() {
        // RFC 7636 appendix B: the challenge is base64url of the binary SHA-256.
        assert_eq!(challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn verifiers_and_states_are_random_and_rfc_shaped() {
        let a = new_pkce().unwrap();
        let b = new_pkce().unwrap();
        assert_ne!(a.verifier, b.verifier);
        // 43 characters from 32 bytes: inside RFC 7636's 43..128, unreserved characters only.
        assert_eq!(a.verifier.len(), 43);
        assert!(a.verifier.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(random_token().unwrap(), random_token().unwrap());
    }

    #[test]
    fn authorization_url_carries_what_frontier_needs() {
        let url = authorize_url(AUTH_SERVER, "client-1", "http://localhost:5000/auth", "CHAL", "STATE");
        let parsed = url::Url::parse(&url).unwrap();
        assert_eq!(parsed.host_str(), Some("auth.frontierstore.net"));
        assert_eq!(parsed.path(), "/auth");
        let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["scope"], "auth capi");
        assert_eq!(q["audience"], "frontier,steam,epic");
        assert_eq!(q["client_id"], "client-1");
        assert_eq!(q["code_challenge"], "CHAL");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["state"], "STATE");
        assert_eq!(q["redirect_uri"], "http://localhost:5000/auth");
        assert!(!url.contains("secret"));
    }

    // ---- callback

    #[test]
    fn callback_requires_the_state_this_login_sent() {
        assert_eq!(check_callback("/auth?code=abc&state=S1", "/auth", "S1"), CallbackResult::Code("abc".into()));
        assert_eq!(check_callback("/auth?code=abc&state=S2", "/auth", "S1"), CallbackResult::Failed(Failure::StateMismatch));
        assert_eq!(check_callback("/auth?code=abc", "/auth", "S1"), CallbackResult::Failed(Failure::StateMismatch));
        assert_eq!(check_callback("/auth?error=access_denied&state=S1", "/auth", "S1"), CallbackResult::Failed(Failure::Denied));
        assert_eq!(check_callback("/auth?state=S1", "/auth", "S1"), CallbackResult::Failed(Failure::BadResponse));
        assert_eq!(check_callback("/favicon.ico", "/auth", "S1"), CallbackResult::NotOurs);
    }

    fn browser(port: u16, target: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET {target} HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    #[test]
    fn listener_ignores_strays_and_returns_the_code() {
        let redirect = Redirect { host: "127.0.0.1".into(), port: None, path: "/auth".into() };
        let (listeners, port) = bind(&redirect).unwrap();
        let cancel = AtomicBool::new(false);
        let t = std::thread::spawn(move || {
            assert!(browser(port, "/favicon.ico").starts_with("HTTP/1.1 404"));
            assert!(browser(port, "/auth?code=x&state=WRONG").starts_with("HTTP/1.1 400"));
            assert!(browser(port, "/auth?code=the-code&state=GOOD").starts_with("HTTP/1.1 200"));
        });
        let code = wait_for_code(&listeners, "/auth", "GOOD", &cancel, Duration::from_secs(10)).unwrap();
        t.join().unwrap();
        assert_eq!(code, "the-code");
    }

    #[test]
    fn cancelling_or_timing_out_ends_the_wait() {
        let redirect = Redirect { host: "127.0.0.1".into(), port: None, path: "/auth".into() };
        let (listeners, _) = bind(&redirect).unwrap();
        let cancel = AtomicBool::new(true);
        assert_eq!(wait_for_code(&listeners, "/auth", "S", &cancel, Duration::from_secs(10)), Err(Failure::Cancelled));
        let cancel = AtomicBool::new(false);
        assert_eq!(wait_for_code(&listeners, "/auth", "S", &cancel, Duration::from_millis(200)), Err(Failure::TimedOut));
    }

    #[test]
    fn a_port_already_in_use_is_reported() {
        let taken = StdListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let redirect = Redirect { host: "127.0.0.1".into(), port: Some(port), path: "/auth".into() };
        assert_eq!(bind(&redirect).err(), Some(Failure::CallbackUnavailable));
    }

    // ---- tokens, against a mocked token endpoint

    /// A one-shot HTTP server standing in for auth.frontierstore.net/token.
    /// Returns its base URL and a handle yielding the form it received.
    fn mock_token_endpoint(status: u16, body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        let listener = StdListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = s.read(&mut chunk).unwrap_or(0);
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some(i) = text.find("\r\n\r\n") {
                    let len: usize = text
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                        .unwrap_or(0);
                    if buf.len() >= i + 4 + len || n == 0 {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            write!(s, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            let text = String::from_utf8_lossy(&buf).to_string();
            text.split("\r\n\r\n").nth(1).unwrap_or("").to_string()
        });
        (base, handle)
    }

    fn form(body: &str) -> std::collections::HashMap<String, String> {
        url::form_urlencoded::parse(body.as_bytes()).into_owned().collect()
    }

    #[test]
    fn exchanges_the_code_with_the_verifier_and_no_secret() {
        let (base, got) = mock_token_endpoint(200, r#"{"access_token":"AT1","refresh_token":"RT1","expires_in":14400,"token_type":"Bearer"}"#);
        let tokens = tauri::async_runtime::block_on(exchange_code(&base, "client-1", "CODE", "VERIFIER", "http://localhost:5000/auth")).unwrap();
        let sent = form(&got.join().unwrap());
        assert_eq!(sent["grant_type"], "authorization_code");
        assert_eq!(sent["client_id"], "client-1");
        assert_eq!(sent["code"], "CODE");
        assert_eq!(sent["code_verifier"], "VERIFIER");
        assert_eq!(sent["redirect_uri"], "http://localhost:5000/auth");
        assert!(!sent.contains_key("client_secret"));
        assert_eq!((tokens.access_token.as_str(), tokens.refresh_token.as_str()), ("AT1", "RT1"));
        assert!(tokens.expires_at.unwrap() > now_s() + 14000);
        // Debug output never shows a token.
        assert!(!format!("{tokens:?}").contains("AT1"));
    }

    #[test]
    fn token_errors_become_categories_without_server_text() {
        assert_eq!(parse_token_response(400, r#"{"error":"invalid_grant","error_description":"RT-SECRET"}"#, 0).err(), Some(Failure::InvalidGrant));
        assert_eq!(parse_token_response(401, "", 0).err(), Some(Failure::InvalidGrant));
        assert_eq!(parse_token_response(500, "<html>oops</html>", 0).err(), Some(Failure::BadResponse));
        assert_eq!(parse_token_response(200, r#"{"access_token":"A"}"#, 0).err(), Some(Failure::BadResponse));
        let t = parse_token_response(200, r#"{"access_token":"A","refresh_token":"R"}"#, 0).unwrap();
        assert_eq!(t.expires_at, None); // not stated: not guessed
        for f in [Failure::InvalidGrant, Failure::BadResponse, Failure::Network, Failure::Denied] {
            assert!(!f.message().contains("RT-SECRET"));
        }
    }

    #[derive(Default)]
    struct MemoryStore(Mutex<Option<String>>);
    impl Store for MemoryStore {
        fn load(&self) -> Option<String> {
            self.0.lock().unwrap().clone()
        }
        fn save(&self, t: &str) -> Result<(), Failure> {
            *self.0.lock().unwrap() = Some(t.to_string());
            Ok(())
        }
        fn clear(&self) -> Result<(), Failure> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }

    fn cfg() -> Config {
        parse_config(Some("0a1b2c3d-0000-4000-8000-123456789abc"), Some("http://127.0.0.1/auth")).unwrap()
    }

    #[test]
    fn refresh_rotates_the_stored_token() {
        let (base, got) = mock_token_endpoint(200, r#"{"access_token":"AT2","refresh_token":"RT2","expires_in":14400}"#);
        let store = MemoryStore::default();
        store.save("RT1").unwrap();
        let state = FrontierState::default();
        let token = tauri::async_runtime::block_on(access_token(&cfg(), &base, &state, &store)).unwrap();
        let sent = form(&got.join().unwrap());
        assert_eq!((sent["grant_type"].as_str(), sent["refresh_token"].as_str()), ("refresh_token", "RT1"));
        assert_eq!(token, "AT2");
        assert_eq!(store.load().as_deref(), Some("RT2"));
        // Fresh now: no second request (there is no server left to answer one).
        assert_eq!(tauri::async_runtime::block_on(access_token(&cfg(), &base, &state, &store)).unwrap(), "AT2");
    }

    #[test]
    fn a_refused_refresh_disconnects() {
        let (base, _got) = mock_token_endpoint(400, r#"{"error":"invalid_grant"}"#);
        let store = MemoryStore::default();
        store.save("RT-old").unwrap();
        let state = FrontierState::default();
        let r = tauri::async_runtime::block_on(access_token(&cfg(), &base, &state, &store));
        assert_eq!(r, Err(Failure::NotConnected));
        assert_eq!(store.load(), None);
    }

    #[test]
    fn a_network_failure_keeps_the_login() {
        let store = MemoryStore::default();
        store.save("RT1").unwrap();
        let state = FrontierState::default();
        // Nothing listens on this port.
        let dead = { let l = StdListener::bind("127.0.0.1:0").unwrap(); format!("http://{}", l.local_addr().unwrap()) };
        let r = tauri::async_runtime::block_on(access_token(&cfg(), &dead, &state, &store));
        assert_eq!(r, Err(Failure::Network));
        assert_eq!(store.load().as_deref(), Some("RT1"));
    }

    #[test]
    fn full_login_against_mocks_stores_only_the_refresh_token() {
        let (base, got) = mock_token_endpoint(200, r#"{"access_token":"AT9","refresh_token":"RT9","expires_in":14400}"#);
        let store = Arc::new(MemoryStore::default());
        let state = FrontierState::default();
        // The "browser": read the URL it was told to open, then come back with a code.
        let open = |url: &str| {
            let u = url::Url::parse(url).unwrap();
            let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
            let redirect = url::Url::parse(&q["redirect_uri"]).unwrap();
            let port = redirect.port().unwrap();
            let s = q["state"].clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(200));
                browser(port, &format!("/auth?code=CODE9&state={s}"));
            });
            Ok(())
        };
        tauri::async_runtime::block_on(login(&cfg(), &base, &state, store.as_ref(), open, Duration::from_secs(10))).unwrap();
        let sent = form(&got.join().unwrap());
        assert_eq!(sent["code"], "CODE9");
        assert_eq!(store.load().as_deref(), Some("RT9"));
        assert!(!state.connecting.load(Ordering::SeqCst));
    }

    #[test]
    fn a_second_login_while_one_runs_is_refused() {
        let state = FrontierState::default();
        state.connecting.store(true, Ordering::SeqCst);
        let r = tauri::async_runtime::block_on(login(&cfg(), AUTH_SERVER, &state, &MemoryStore::default(), |_| Ok(()), Duration::from_secs(1)));
        assert_eq!(r, Err(Failure::Busy));
    }

    // ---- the boundary

    #[test]
    fn no_command_returns_a_token() {
        // Every #[tauri::command] here returns Status, (), or Result<(), Failure>.
        let source = include_str!("frontier.rs");
        let needle = concat!("#[tauri::", "command]");
        for (i, _) in source.match_indices(needle) {
            let sig = &source[i..(i + 400).min(source.len())];
            let sig = &sig[..sig.find('{').unwrap_or(sig.len())];
            assert!(
                sig.contains("-> Status") || sig.contains("Result<(), Failure>") || !sig.contains("->"),
                "a command may return something other than status or a category: {sig}"
            );
            assert!(!sig.contains("String"), "a command returns a String: {sig}");
        }
    }
}
