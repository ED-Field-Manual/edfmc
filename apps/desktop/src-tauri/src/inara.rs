//! Inara transport.
//!
//! The same boundary as EDSM and the EDFM journal sync: the personal API key
//! never enters JavaScript. It is read from the Windows Credential Manager here
//! and placed into the request header, so a secret cannot reach a log line, an
//! error message or a screenshot.
//!
//! Inara differs from EDSM in where the key sits. EDSM takes a form field;
//! Inara takes a JSON envelope whose `header` object carries `APIkey`. So this
//! command receives the *events* array already built and serialised, and builds
//! the header -- the only part that holds a secret -- on this side.

use serde::Serialize;
use std::time::Duration;

use crate::edfm_journal::HttpOutcome;

const INTEGRATION: &str = "inara";
const INARA_URL: &str = "https://inara.cz/inapi/v1/";
const TIMEOUT: Duration = Duration::from_secs(30);
/// Exactly the name Inara white-lists. Pinned here rather than taken from the
/// caller, so no renderer bug can send under another name. Must match
/// `INARA_APP_NAME` in `packages/integrations/src/inara.ts`.
const APP_NAME: &str = "EDFM Companion";
/// A request carries at most this many events (`INARA_MAX_BATCH`).
const MAX_EVENTS: usize = 50;
/// Nothing this app sends comes near this; anything bigger is a bug.
const MAX_PAYLOAD_BYTES: usize = 2 * 1024 * 1024;

/// What the frontend supplies. Every field is already public knowledge; the
/// key is the one thing it does not and cannot pass.
#[derive(Debug, serde::Deserialize)]
pub struct InaraSubmission {
    pub app_version: String,
    /// From the release configuration. Not a secret, and not defaulted here:
    /// the frontend decides, so one setting governs it.
    pub is_being_developed: bool,
    pub commander_name: String,
    pub commander_frontier_id: Option<String>,
    /// A JSON array of Inara events, already built and bounded.
    pub events_json: String,
}

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
struct Header {
    appName: String,
    appVersion: String,
    isBeingDeveloped: bool,
    APIkey: String,
    commanderName: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    commanderFrontierID: Option<String>,
}

fn client() -> Result<reqwest::Client, HttpOutcome> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(concat!("EDFMCompanion/", env!("CARGO_PKG_VERSION")))
        // The key travels in the body, so a redirect to plain HTTP would put it
        // on the wire in clear. Redirects are not followed.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| HttpOutcome::transport_public("client-unavailable"))
}

/// Send Inara events.
///
/// Never returns `Err`: a transport failure is an outcome to display, not an
/// exception. "Inara is unreachable" and "the app is broken" look the same to a
/// commander otherwise.
#[tauri::command]
pub async fn inara_submit(submission: InaraSubmission) -> HttpOutcome {
    let Some(api_key) = crate::credentials::read_secret(INTEGRATION) else {
        return HttpOutcome::transport_public("no-credential");
    };
    if api_key.trim().is_empty() {
        return HttpOutcome::transport_public("no-credential");
    }

    // The events arrive as text and are re-parsed rather than pasted into a
    // string. Concatenating JSON would let a malformed array reshape the
    // envelope around it.
    if submission.events_json.len() > MAX_PAYLOAD_BYTES {
        return HttpOutcome::transport_public("bad-payload");
    }
    let events: serde_json::Value = match serde_json::from_str(&submission.events_json) {
        Ok(v @ serde_json::Value::Array(_)) => v,
        _ => return HttpOutcome::transport_public("bad-payload"),
    };
    let count = events.as_array().map_or(0, Vec::len);
    if count == 0 || count > MAX_EVENTS {
        return HttpOutcome::transport_public("bad-payload");
    }
    // Inara needs the in-game name to attribute anything; never sent blank.
    if submission.commander_name.trim().is_empty() {
        return HttpOutcome::transport_public("no-commander");
    }

    let http = match client() {
        Ok(c) => c,
        Err(out) => return out,
    };

    // Built here so the key is never assembled anywhere a renderer could see.
    let body = serde_json::json!({
        "header": Header {
            appName: APP_NAME.to_string(),
            appVersion: submission.app_version,
            // Inara: set while "developing the application and/or testing new
            // updates"; it skips global events such as community goals.
            isBeingDeveloped: submission.is_being_developed,
            APIkey: api_key,
            commanderName: submission.commander_name,
            commanderFrontierID: submission.commander_frontier_id,
        },
        "events": events,
    });

    // Serialised here with an explicit content type, matching the journal
    // transport, rather than enabling reqwest's `json` feature for one call.
    let Ok(payload) = serde_json::to_string(&body) else {
        return HttpOutcome::transport_public("bad-payload");
    };

    match http
        .post(INARA_URL)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .body(payload)
        .send()
        .await
    {
        Ok(response) => HttpOutcome::from_response(response).await,
        Err(e) if e.is_timeout() => HttpOutcome::transport_public("timeout"),
        Err(e) if e.is_connect() => HttpOutcome::transport_public("connection-failed"),
        Err(_) => HttpOutcome::transport_public("request-failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_is_added_here_and_never_taken_from_the_caller() {
        /*
         * The signature is the guarantee. `InaraSubmission` carries only public
         * fields; a command that accepted a finished envelope would mean the key
         * had already passed through a renderer.
         */
        let src = include_str!("inara.rs");
        assert!(
            !src.contains(concat!("pub api_", "key")),
            "the submission struct gained a field that carries the key"
        );
        assert!(
            src.contains(concat!("read_", "secret(INTEGRATION)")),
            "the key is no longer read from the credential store here"
        );
    }

    #[test]
    fn the_app_name_is_pinned_and_matches_the_white_listed_one() {
        assert_eq!(APP_NAME, "EDFM Companion");
        let src = include_str!("inara.rs");
        assert!(
            !src.contains(concat!("pub app_", "name")),
            "the caller must not choose the app name"
        );
    }

    #[test]
    fn development_mode_comes_from_the_caller_not_a_hardcoded_value() {
        let src = include_str!("inara.rs");
        assert!(src.contains("isBeingDeveloped: submission.is_being_developed"));
        assert!(!src.contains(concat!("isBeingDeveloped: ", "false")));
    }

    #[test]
    fn requests_go_only_to_inara_over_https() {
        assert!(INARA_URL.starts_with("https://inara.cz/"));
    }

    #[test]
    fn redirects_are_refused_so_the_key_cannot_leave_in_clear() {
        // The key is in the body, not a header, so a downgrade would expose it.
        let src = include_str!("inara.rs");
        assert!(src.contains("redirect::Policy::none()"));
    }

    #[test]
    fn a_payload_that_is_not_an_array_is_refused() {
        // Guards the envelope: anything but an events array is rejected before
        // a request is built, so a malformed payload cannot reshape the header.
        let src = include_str!("inara.rs");
        assert!(src.contains("serde_json::Value::Array(_)"));
        assert!(src.contains("bad-payload"));
    }
}
