# dsh-web-startup-auth

[中文](README.md) | **English**

A [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) plugin that enables **remote web startup with username/password authentication**.

> **⚠️ Version tracking notice**: This project only tracks the official `next` dist-tag (the pre-stable release channel) and does not follow the `alpha` preview channel.

![Login page](docs/login-page.png)

The stock `@deepseek-ai/dsh-web-app/startup` **hard-rejects `--host 0.0.0.0`** for safety. This plugin replaces it and adds an auth layer (login/register page + signed session cookies), letting you safely expose `dsh web` on a LAN or any non-loopback interface.

## Features

- **Remote startup**: `--host 0.0.0.0` works, replacing the stock launcher's hard rejection.
- **Login/register page**: A remote first visit guides you through setting the admin credentials, then shows the login page; matches DSH's black/white/blue style.
- **Password-free local access**: the decision is made per **request**, not per bind address — a request is trusted only when its TCP peer address *and* its `Host` header are both loopback. A browser on the same machine opening `http://127.0.0.1:<port>/` needs no registration or login; LAN clients and requests forwarded by a reverse proxy (`Host` names the public domain) always need a session.
- **Session authentication**: Signed session cookie (`dsh_sid`, 14-day expiry, `HttpOnly` + `SameSite=Lax`).
- **API protection**: Every registered route (`/api/*` and third-party RPC routes, except `/api/auth/*` and `/login`) requires a valid session, otherwise returns 401 or refuses the handshake.
- **"Auth" tab in the settings panel**: Injects an "Auth" page into the DSH settings panel with **Sign out**, **Change username**, and **Change password**.
- **Remote-scenario fixes** (LAN/HTTP pitfalls):
  - `crypto.randomUUID` polyfill — the API is missing in non-secure contexts; without it every RPC fails.
  - Native browser-auth bridge — dsh 0.1.2 ships its own browser authentication (signed `dsh-auth-*` cookies) and requires the cookie on `/api` and on `index.html` with **no loopback exemption** (even the local browser must first swap a launch-token URL). This plugin mints that cookie for callers that already passed ITS authentication — a valid `dsh_sid` session, or a genuine loopback request (loopback TCP peer *and* loopback `Host`): page navigations pick it up in a single 303 hop and the login responses hand it out directly, so the printed token URL is never needed. Username/password plus revocable sessions stay the only auth entry point; the upstream cookie merely lets requests through upstream's own gate.

## Install

This plugin is a DSH **bundle** (the `dsh.bundle.patch` in `package.json` ships a `cordis.patch.yml`). After `dsh plugin` installation the patch layer applies **automatically** — no manual config editing.

```sh
# Option 1: from source
git clone <repo-url>
cd dsh-web-startup-auth
npm install        # install build dependencies (typescript etc.)
npm run build      # compile src/ to lib/ (the runtime loads lib/ artifacts)
dsh plugin --profile web add .

# Option 2: from the npm registry (re-run the same command to upgrade an existing install)
dsh plugin --profile web add dsh-web-startup-auth@latest
```

> `dsh plugin` forwards to pnpm and requires `--profile <name>`; `add .` installs the current directory as a `link:` dependency.

Start:

```sh
dsh web --host 0.0.0.0
```

> Or, if applying the patch manually with `--patch ./cordis.patch.yml`:
> `dsh --profile web --patch ./cordis.patch.yml --host 0.0.0.0`

## Usage

1. Open `http://<host-ip>:<port>/` in a browser (from the same machine use `http://127.0.0.1:<port>/`, which needs no login).
2. A remote first visit redirects to `/login`, showing the "set admin credentials" registration form.
3. After registering you are auto-logged-in and land in the UI; subsequent visits require login.
4. Sign out / change username / change password: open the **Settings panel → Auth** tab in the UI (there is also a standalone entry; `POST /api/auth/logout` clears the session cookie).

Credentials and the session secret live in `~/.dsh/web-auth.json`:

- Passwords are stored as **scrypt** hashes (random salt, 64 bytes); plaintext is never saved.
- Session cookies are signed with a random key using **HMAC-SHA256** to prevent forgery.
- **Forgot password**: on the server machine run `dsh --profile web auth-reset` for an interactive reset (or `dsh --profile web auth-reset --password <new-password>` non-interactively). Resetting **rotates the session secret and invalidates every issued session**.
- **Change username / repair a username containing control characters**: `dsh --profile web auth-reset --username <new-username>` (can be combined with `--password`). Also rotates the session secret. Usernames are normalized at register/login/change time by stripping C0 control characters (0x00–0x1F) and DEL (0x7F) — if an older version already stored a DEL-polluted username verbatim, this command repairs it.
- Fallback: delete `~/.dsh/web-auth.json` and restart to re-register (also invalidates all sessions, but requires a restart).

## Index

If you are looking for an out-of-the-box IDE built for the Agent era, check out [Omniterm](https://github.com/GDWhisper/OmniTerm)

## Security notes

- This plugin provides authentication but **not transport encryption**. Over plaintext HTTP, credentials and traffic can be sniffed on the same network — **use only on a trusted LAN** or put an HTTPS reverse proxy in front.
- Sessions last 14 days; tighten by editing `SESSION_MAX_AGE_SEC` in `src/auth.ts`.
- Password hashing uses Node's built-in `crypto.scryptSync`; no third-party dependency.
- **Sessions cannot be revoked server-side**: `dsh_sid` is a self-contained signed cookie; `/api/auth/logout` only clears it on the browser side. A leaked cookie (e.g. sniffed over plaintext HTTP) cannot be individually revoked within its 14-day window. **Exceptions**: `dsh --profile web auth-reset`, the "Change password" and "Change username" actions in the settings panel all **rotate the session secret**, invalidating all sessions at once (after the change the current session is re-issued, so you stay signed in).
- **First-registration window**: while no credentials are set, any visitor can register as admin. **Complete the first registration before exposing the service to an untrusted network.**
- **Login throttling**: login failures are rate-limited per client IP — 5 consecutive failures lock the client out for 30 seconds (in-memory only, not persisted); registration requires a password of at least 8 characters. Throttling covers `/api/auth/login`, `/api/auth/change-password`, and `/api/auth/change-username` (a wrong old/current password also counts). For stricter protection, add general rate limiting at your reverse proxy.
- **Credential file permissions**: `~/.dsh/web-auth.json` (password hash + session signing key) is saved with `0600`, its directory with `0700`; the plugin repairs overly-broad permissions left by older versions at startup.
- **`--trusted-host`**: kept only for CLI compatibility with the stock launcher; it **plays no part in this plugin's auth decisions** — remote clients always need a valid session; there is no "trusted host skips login".
- **Reverse-proxy deployments (nginx, …)**: binding dsh to `127.0.0.1` and letting the proxy terminate TLS and forward is supported. The proxy **must forward the real `Host`** (nginx does by default via `proxy_set_header Host $host;`; pass `--trusted-host <domain>` so DSH's own Host fence accepts it); once authenticated, the plugin mints the upstream native browser cookie under the request's **real `Host`** (the public domain), so upstream's gate accepts the request. If the proxy instead hard-codes `Host: 127.0.0.1`, the plugin reads the request as local and **lets all traffic through unauthenticated** — do not configure it that way. `X-Forwarded-For` is never consulted (a client can forge it); trust is decided solely by the TCP peer address and `Host`.
- **Upstream compatibility (dsh 0.1.2 baseline)**: From dsh rc.8 through 0.1.1, DSH's frontend decided loopback-ness from the **browser address bar hostname** (`connection.isLoopback`), so in a remote browser the settings mirror ran in memory mode and plugin-config cards / the Models page were unusable; this plugin injected a script into the SPA index flipping that flag to a constant `true` the moment the connection plugin activated. 0.1.2's real cookie authentication gets a remote browser **into the UI**, but the settings mirror still keys off the same flag — a LAN browser still gets a `memory` mirror that never reads the host, and the Models (provider directory) section of the settings panel reports "settings are unavailable in this browser". Restoring the old getter override breaks the web boot (A/B verified: 26 frontend plugins stayed pending), so as of 0.1.2 the fix is instead injecting **`window.__DSH_TRANSPORT__ = { ownsHost: true }`**: the connection client reads that hook at construction and reports `isLoopback` as `true` (api/rpc fields fall back safely when absent, and the cordis service is not rewritten), so every settings surface — Models included — renders normally from both LAN and loopback browsers. Remaining browser-side shims: that transport hook and the `crypto.randomUUID` polyfill (needed for plaintext-HTTP non-secure contexts).

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsc -p tsconfig.json + tsdown, output to lib/
```

- `tsc` compiles the node-side source (`src/*.ts`) and type declarations to `lib/` and `lib/types/`.
- `tsdown` bundles the frontend plugin (`src/client/index.tsx`) into the browser bundle `lib/client.js` (the `window.__ModuleLoader__.load` registration format). Rebuild after changing frontend code; a `link:` install in the profile picks up new artifacts automatically.
- The `@deepseek-ai/dsh-client-*` packages the frontend plugin depends on are used only for types and building; at runtime they are provided by DSH's frontend module table.

## License

[MIT](./LICENSE)
