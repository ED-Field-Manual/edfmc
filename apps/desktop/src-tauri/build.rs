//! Build-time configuration.
//!
//! The Frontier login needs the Client ID Frontier issues to EDFM Companion and
//! the redirect URI registered with it. Neither is a secret (it is a PKCE
//! public client: no Shared Key is used), and neither is something a commander
//! should be asked to type, so they are built in.
//!
//! Read from the environment, or from `apps/desktop/.env.local` -- the file the
//! app's other build settings (Inara's approval flags) already live in, and
//! which git ignores:
//!
//!     EDFMC_FRONTIER_CLIENT_ID=...
//!     EDFMC_FRONTIER_REDIRECT_URI=http://localhost:<port>/auth
//!
//! Not `VITE_`-prefixed on purpose: the frontend has no use for them. Until both
//! are set the app shows "Awaiting Frontier API Approval". See docs/FRONTIER-AUTH.md.

const KEYS: [&str; 2] = ["EDFMC_FRONTIER_CLIENT_ID", "EDFMC_FRONTIER_REDIRECT_URI"];

fn main() {
    let file = std::path::Path::new("..").join(".env.local");
    println!("cargo:rerun-if-changed={}", file.display());
    let from_file = std::fs::read_to_string(&file).unwrap_or_default();
    for key in KEYS {
        println!("cargo:rerun-if-env-changed={key}");
        let value = std::env::var(key).ok().or_else(|| {
            from_file.lines().find_map(|line| {
                let (k, v) = line.trim().split_once('=')?;
                (k.trim() == key).then(|| v.trim().trim_matches('"').to_string())
            })
        });
        if let Some(v) = value.filter(|v| !v.is_empty()) {
            println!("cargo:rustc-env={key}={v}");
        }
    }
    tauri_build::build()
}
