# Frontier login (OAuth 2.0 with PKCE)

Status: **prepared, not live.** EDFM Companion is awaiting Frontier's approval
for its Companion API (CAPI) client. Until the approved values are built in, the
Connections & Data Sharing screen shows **Awaiting Frontier API Approval** and
Connect is disabled. No request is made to Frontier.

This is login only. Nothing reads CAPI data yet (profile, market, shipyard,
fleet carrier); that comes after the login has been verified live.

## What is implemented

All of it is in `apps/desktop/src-tauri/src/frontier.rs`.

- **PKCE S256:**
  - a 32-byte random verifier and a separate 32-byte random `state`, from the OS random-number generator;
  - the challenge is base64url (no padding) of the binary SHA-256 of the verifier, checked against RFC 7636's own example.
- **Authorization URL:** `https://auth.frontierstore.net/auth` with:
  - `response_type=code`
  - `audience=frontier,steam,epic`
  - `scope=auth capi`
  - `client_id`
  - `code_challenge`
  - `code_challenge_method=S256`
  - `state`
  - `redirect_uri`
- **Browser login:** opened in the system browser. The commander logs in on Frontier's site, and the app never sees their password.
- **Callback:** a one-off listener on the loopback redirect (`http://localhost` / `127.0.0.1`), on both IPv4 and IPv6 for `localhost`.
  - It checks `state` with a constant-time comparison. A response with the wrong state is ignored, since it could be a stale tab.
  - An `error` response ends the login as "declined".
  - Stray requests, such as the favicon, get a 404.
  - The wait ends after 5 minutes, or on Cancel.
- **Code exchange:** a form POST to `/token` with `grant_type=authorization_code`, `client_id`, `code_verifier`, `code` and `redirect_uri`. **No client secret.** The Shared Key is not used or embedded anywhere.
- **Storage:**
  - Only the **refresh token** is stored, in Windows Credential Manager through the existing `credentials.rs` (entry `frontier`).
  - The **access token** is held in memory only. It is short-lived, and its JWE format may be larger than a Credential Manager entry can hold.
- **Refresh:** `access_token()` is used internally, not exposed as a command.
  - It refreshes 60 s before `expires_in` runs out, or when no access token is held.
  - Frontier rotates refresh tokens, so each new one replaces the old.
  - A refused refresh (`invalid_grant`, 401) disconnects. A network failure keeps the login.
- **Disconnect:** removes the stored refresh token and forgets the access token.

**Where tokens never go:** no Tauri command returns a token, failures cross to TypeScript as a category name (such as `denied` or `network`), nothing is logged, and the `Debug` output of a token set hides both tokens. Tests enforce the command signatures and the TypeScript side.

**UI:** a Frontier Developments card on the Connections & Data Sharing screen shows status, Connect, Disconnect, and Cancel while a login is waiting.

## Verified, and from where

| Fact | Source |
|---|---|
| Endpoints `/auth`, `/token`, `/decode` on `auth.frontierstore.net` | Frontier's OAuth guide (hosting.zaonce.net/docs/oauth2/instructions.html); EDMarketConnector `companion.py` |
| PKCE supported for client-side apps; binary (not hex) SHA-256 | Frontier's OAuth guide |
| Scopes `auth capi` (CAPI objects without `auth`) | EDMC; EDCD FDevIDs notes |
| Audience `frontier,steam,epic` | EDMC's current code (Frontier's 2019 guide lists `frontier, steam, xbox, psn, all`) |
| Token request fields; no client secret with PKCE | EDMC `companion.py` |
| Refresh tokens rotate and can expire | Frontier's OAuth guide |

## How this compares with EDMarketConnector

The login follows EDMC's current implementation (`companion.py` and `protocol.py`
on EDCD/EDMarketConnector `main`, reviewed 2026-10-10), which is the proven
approach for a desktop client.

| | EDMC | EDFM Companion |
|---|---|---|
| Authorization URL | `/auth?response_type=code&audience=frontier,steam,epic&scope=auth%20capi&client_id=…&code_challenge=…&code_challenge_method=S256&state=…&redirect_uri=…` | Identical, character for character (a test asserts it) |
| Verifier, state | 32 random bytes each, base64url without padding | Same |
| Challenge | base64url of the binary SHA-256 | Same |
| Code exchange | form POST to `/token`: `grant_type, client_id, code_verifier, code, redirect_uri`; no secret; 30 s timeout | Same |
| Refresh | form POST `grant_type=refresh_token, client_id, refresh_token`; the new refresh token replaces the old | Same |
| What is stored | Only the refresh token (EDMC's config file); access token in memory | Only the refresh token (Windows Credential Manager); access token in memory |
| Redirect | `localhost` listener, OS-chosen port, `http://localhost:<port>/auth` (Linux, or when forced on Windows); Windows default is its own `edmc://` scheme | The localhost listener only, on IPv4 and IPv6. No custom scheme |
| Callback check | path starts with `/auth`; `state` compared | Exact configured path; `state` compared in constant time; 5-minute timeout and Cancel |

Deliberate differences, left for after the login works:

- **EDMC keeps one refresh token per commander** and, after login, calls `/decode` to check that the Frontier account's `customer_id` matches the game's FID.
- **EDFM Companion keeps one login** and doesn't call `/decode`.

Both depend on CAPI use and per-commander handling, which are out of scope until Frontier authentication is operational.

## The redirect URI: HTTPS at registration

**Frontier's developer portal currently requires redirect URIs to be HTTPS when they are registered.**

This login receives the redirect on a plain-HTTP localhost listener, as EDMC's localhost handler does. That EDMC's client works with `http://localhost` **does not mean ours is approved for it**: EDMC's registration is its own. Until Frontier confirms the redirect URI for our client, the localhost callback is untested and may not be accepted.

What is not done, on purpose:

- **No website callback.** There is no HTTPS page on edfieldmanual.com that forwards the code back to the app.
- **No other workaround.** There is no custom scheme and no local HTTPS server with a self-signed certificate.

An `https://` redirect URI in the build is refused with a clear message ("not an http://localhost address"), not half-supported. If Frontier will only accept an HTTPS redirect for our client, the way the app receives the login has to be decided then, with Frontier's answer in hand.

## What stays untested until approval

- **The real login.** Every test uses mocked responses and a local stand-in for the token endpoint. No live authentication has been done.
- **Redirect URI acceptance.** See the HTTPS section above. Frontier has to confirm that our client may use `http://localhost`, and whether the port may vary (EDMC's handler uses a free port each time) or must be fixed.
- **`expires_in`.** It's standard OAuth but not in Frontier's guide. If Frontier doesn't send it, the access token is used until refused, and refresh-on-401 arrives with the first CAPI request.
- **Token sizes.** The refresh token must fit in a Credential Manager entry. Its size is unconfirmed until a real one exists.
- **The `epic` audience** is taken from EDMC, not from Frontier's documentation.

## What you need to provide once approved

1. **Client ID:** the GUID Frontier issues for the EDFM Companion client. **Not** the Shared Key; that must never go into the app.
2. **Redirect URI:** exactly as Frontier confirms it for our client.
   - It must be an `http://localhost` or `http://127.0.0.1` address, for example `http://localhost/auth` or `http://localhost:47731/auth`.
   - A URI without a port means "any free port", as EDMC's handler does it. Use that only if Frontier confirms a varying port is accepted; otherwise use the fixed port Frontier registered.
   - If Frontier only allows an `https://` URI, send it anyway: the app will refuse it, and that decision comes next (see the HTTPS section).

Use the EDFM Companion client's values, not the EDFM website's Frontier credentials.

## Where to put them

These are build settings, not something a commander types. Add them to `apps/desktop/.env.local`, the same git-ignored file that already holds the Inara build flags:

```
EDFMC_FRONTIER_CLIENT_ID=<the client id>
EDFMC_FRONTIER_REDIRECT_URI=http://localhost:<port>/auth
```

or set them as environment variables when building. `build.rs` reads them into the Rust build only; the frontend never gets them. Rebuild the app afterwards. The Client ID isn't a secret, so it can be committed later if you prefer.

## How to verify once approved

1. **Check the values:** build with the values set, then run `cargo test --lib frontier` in `apps/desktop/src-tauri`. A test fails if the values in the build are unusable, for example if the redirect isn't loopback.
2. **Check the screen:** open Connections & Data Sharing. The Frontier card should say **Not connected**, with Connect enabled.
3. **Log in:** press Connect, log in on Frontier's site, and approve.
   - The browser should show "Logged in to Frontier. You can close this tab".
   - The card should say **Connected**.
4. **Check the stored login:** Windows Credential Manager → Windows Credentials should show a `com.edfieldmanual.companion` entry for `frontier`.
5. **Check persistence:** restart the app. It should still say **Connected**.
6. **Disconnect:** the card should say **Not connected**, and the Credential Manager entry should be gone.
7. **If the login fails:** the card names the category, such as "Frontier did not grant access" or "could not receive the login response". A `redirect_uri` mismatch shows on Frontier's own page before any redirect happens; compare the registered URI with the value built in.
