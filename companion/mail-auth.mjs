#!/usr/bin/env node
// mail-auth.mjs: one-time Google sign-in that mints a READ-ONLY Gmail token for mail-facade.mjs.
//
// Why a separate token: the facade is reachable over the tailnet, so it must hold the narrowest credential
// that does the job. This asks for `gmail.readonly` and nothing else (no send, modify, Drive or Calendar),
// and refuses to save the token if a different Google account signed in than the one configured.
//
// Flow (OAuth 2.0 for installed apps, RFC 8252, with PKCE RFC 7636):
//   1. Listen on a random 127.0.0.1 port; print the Google consent URL.
//   2. The owner opens the URL, signs in, approves "read your email".
//   3. Google redirects the browser to http://127.0.0.1:<port>/?code=...; we exchange the code (+ PKCE verifier)
//      for a refresh token, check the mailbox address, and write the token file.
//
// Reads the same config as the facade (default .local/mail.json; override with MAIL_CONFIG):
//   oauthClientFile  path to a Google "installed" OAuth client JSON ({"installed":{client_id,client_secret,...}})
//   tokenFile        where to write the token (relative paths resolve from the repo root)
//   expectedAccount  the mailbox address that must sign in
//
// Usage: node companion/mail-auth.mjs        (waits up to 10 minutes for the browser round trip)
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const TIMEOUT_MS = 10 * 60 * 1000;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = process.env.MAIL_CONFIG || resolve(repoRoot, ".local", "mail.json");

function fail(message) {
  console.error(`[mail-auth] ERROR: ${message}`);
  process.exit(1);
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`cannot read ${what} ${path}: ${e.message}`);
  }
}

const config = readJson(configPath, "config");
const clientFile = config.oauthClientFile;
if (typeof clientFile !== "string" || !existsSync(clientFile)) fail(`oauthClientFile not found: ${clientFile}`);
const client = readJson(clientFile, "OAuth client").installed;
if (!client?.client_id || !client?.client_secret) fail("OAuth client JSON has no installed.client_id / client_secret");
if (typeof config.expectedAccount !== "string" || !config.expectedAccount.includes("@")) fail("expectedAccount must be an email address");
if (typeof config.tokenFile !== "string") fail("tokenFile must be a path");
const tokenPath = isAbsolute(config.tokenFile) ? config.tokenFile : resolve(repoRoot, config.tokenFile);

// PKCE: the verifier never leaves this process; Google only sees its SHA-256 (the challenge), so an
// intercepted authorization code is useless without it.
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const verifier = b64url(randomBytes(48));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(16)); // ties the redirect to this run (CSRF guard)

const server = createServer();
await new Promise((ok, ko) => { server.once("error", ko); server.listen(0, "127.0.0.1", ok); });
const redirectUri = `http://127.0.0.1:${server.address().port}`;

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: SCOPE,
  code_challenge: challenge,
  code_challenge_method: "S256",
  access_type: "offline", // ask for a refresh token
  prompt: "consent",      // force a refresh token even if this client was approved before
  login_hint: config.expectedAccount,
  state,
}).toString();

console.log(`[mail-auth] Open this URL, sign in as ${config.expectedAccount}, and approve read-only Gmail access:\n`);
console.log(authUrl.toString());
console.log(`\n[mail-auth] Waiting up to ${TIMEOUT_MS / 60000} minutes for the redirect to ${redirectUri} ...`);

const code = await new Promise((ok, ko) => {
  const timer = setTimeout(() => ko(new Error("timed out waiting for the browser redirect")), TIMEOUT_MS);
  server.on("request", (req, res) => {
    const url = new URL(req.url || "/", redirectUri);
    if (url.pathname !== "/") { res.writeHead(404); res.end(); return; }
    const done = (status, text) => { res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }); res.end(text); };
    if (url.searchParams.get("state") !== state) { done(400, "State mismatch. Close this tab."); return; }
    const error = url.searchParams.get("error");
    if (error) { done(400, `Google returned: ${error}. Close this tab.`); clearTimeout(timer); ko(new Error(`consent refused: ${error}`)); return; }
    const value = url.searchParams.get("code");
    if (!value) { done(400, "No code in the redirect. Close this tab."); return; }
    done(200, "Done. You can close this tab and return to Claude Code.");
    clearTimeout(timer);
    ok(value);
  });
}).catch((e) => fail(e.message)).finally(() => server.close());

const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: verifier,
  }),
});
const token = await tokenResponse.json().catch(() => ({}));
if (!tokenResponse.ok || !token.refresh_token) fail(`token exchange failed (${tokenResponse.status}): ${token.error || "no refresh_token"}`);

// Granted scopes can differ from requested ones (the user can untick boxes); require exactly read-only Gmail.
const granted = String(token.scope || "").split(/\s+/).filter(Boolean);
if (!granted.includes(SCOPE)) fail(`gmail.readonly was not granted (granted: ${granted.join(", ") || "none"})`);

const profile = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
  headers: { Authorization: `Bearer ${token.access_token}` },
}).then((r) => r.json());
if (String(profile.emailAddress || "").toLowerCase() !== config.expectedAccount.toLowerCase()) {
  fail(`signed in as ${profile.emailAddress || "unknown"}, expected ${config.expectedAccount}; token NOT saved`);
}

mkdirSync(dirname(tokenPath), { recursive: true });
writeFileSync(tokenPath, JSON.stringify({
  account: profile.emailAddress,
  scopes: granted,
  refresh_token: token.refresh_token,
  created: new Date().toISOString(),
}, null, 2) + "\n");
console.log(`[mail-auth] Saved a ${granted.join(" ")} token for ${profile.emailAddress} to ${tokenPath}`);
