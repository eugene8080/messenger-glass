#!/usr/bin/env node
// mail-facade.mjs: a Beeper Desktop API facade that adds one READ-ONLY Gmail account to GazeChat.
//
// Why a facade: Beeper Desktop has no email support, and GazeChat speaks only the Beeper Desktop API.
// Rather than fork GazeChat's UI (and fight every upstream merge), this service sits between GazeChat and
// Beeper. Every request passes through to Beeper unchanged, except that:
//   - GET /v1/accounts         gains one extra account (accountID "email.<x>"; GazeChat tags it as email);
//   - GET /v1/chats            gains one chat per newsletter SENDER, merged into Beeper's pages by date;
//   - GET /v1/chats/{gmail id} and /v1/chats/{gmail id}/messages are answered from Gmail;
//   - GET /v1/chats/search and /v1/messages/search also match the Gmail items;
//   - any write to a Gmail chat (send, react, archive) gets 403; a draft PATCH is accepted and ignored,
//     because GazeChat syncs drafts as a side effect of opening a chat.
// WebSocket upgrades (/v1/ws) are piped straight to Beeper.
//
// Security model:
//   - Listens on 127.0.0.1 only; `tailscale serve` publishes it to the tailnet over HTTPS.
//   - Beeper still authenticates every pass-through request with the caller's own Beeper token.
//   - Gmail routes require a token that Beeper's /oauth/introspect reports as active, so only a holder of a
//     valid Beeper token can read the mail. Results are cached briefly to avoid an introspect per poll.
//   - The Google credential is a gmail.readonly refresh token (see mail-auth.mjs); nothing here can send,
//     modify or delete mail. Mail content is never logged: logs carry routes, status codes, counts, timings.
//   - CORS preflight is answered here and the browser Origin header is stripped before forwarding, so Beeper
//     sees a same-machine client. That keeps working if Beeper's Remote Access is later switched off.
//
// Configuration: .local/mail.json (untracked; override with MAIL_CONFIG). Keys: listenPort, beeperBase,
// oauthClientFile, tokenFile, expectedAccount, accountID, accountName, labelName, windowDays, maxMessages,
// refreshSeconds, maxTextChars.
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = process.env.MAIL_CONFIG || resolve(repoRoot, ".local", "mail.json");
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const INTROSPECT_OK_MS = 5 * 60 * 1000;   // trust an active token for 5 minutes
const INTROSPECT_BAD_MS = 30 * 1000;      // remember a rejected token for 30 seconds
const FETCH_CONCURRENCY = 3;              // parallel messages.get calls; 5 tripped Gmail's per-user rate limit

function log(message) {
  console.log(`[mail ${new Date().toISOString()}] ${message}`);
}
function fail(message) {
  console.error(`[mail] FATAL: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- configuration
let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (e) {
  fail(`cannot read config ${configPath}: ${e.message}`);
}
const need = (key, test, what) => { if (!test(config[key])) fail(`config ${key} must be ${what}`); return config[key]; };
const listenPort = need("listenPort", (v) => Number.isInteger(v) && v >= 1024 && v <= 65535, "a port 1024-65535");
const beeperBase = new URL(need("beeperBase", (v) => typeof v === "string" && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(v), "http://127.0.0.1:<port>"));
const accountID = need("accountID", (v) => typeof v === "string" && /^email\.[a-z0-9_-]+$/.test(v), 'like "email.work" (GazeChat maps the "email." prefix to its email tag)');
const accountName = need("accountName", (v) => typeof v === "string" && v.length > 0, "a display name");
const expectedAccount = need("expectedAccount", (v) => typeof v === "string" && v.includes("@"), "an email address");
const labelName = need("labelName", (v) => typeof v === "string" && v.length > 0, "a Gmail label name");
const windowDays = need("windowDays", (v) => Number.isInteger(v) && v >= 1 && v <= 365, "an integer 1-365");
const maxMessages = need("maxMessages", (v) => Number.isInteger(v) && v >= 1 && v <= 500, "an integer 1-500");
const refreshMs = 1000 * need("refreshSeconds", (v) => Number.isInteger(v) && v >= 30, "an integer >= 30");
const maxTextChars = need("maxTextChars", (v) => Number.isInteger(v) && v >= 500, "an integer >= 500");
const clientFile = need("oauthClientFile", (v) => typeof v === "string" && existsSync(v), "an existing OAuth client JSON");
const tokenPath = (() => { const p = need("tokenFile", (v) => typeof v === "string", "a path"); return isAbsolute(p) ? p : resolve(repoRoot, p); })();
if (!existsSync(tokenPath)) fail(`token file ${tokenPath} missing: run node companion/mail-auth.mjs first`);
const oauthClient = JSON.parse(readFileSync(clientFile, "utf8")).installed;
const storedToken = JSON.parse(readFileSync(tokenPath, "utf8"));
if (!storedToken.refresh_token) fail("token file has no refresh_token");
if (String(storedToken.account).toLowerCase() !== expectedAccount.toLowerCase()) fail("token file is for a different account");
if (!storedToken.scopes?.includes("https://www.googleapis.com/auth/gmail.readonly")) fail("token is not gmail.readonly");

// ---------------------------------------------------------------- Google access token (refreshed in memory only)
let accessToken = null;
let accessTokenExpiry = 0;
async function googleAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiry - 60_000) return accessToken;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: oauthClient.client_id,
      client_secret: oauthClient.client_secret,
      refresh_token: storedToken.refresh_token,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) throw new Error(`Google token refresh failed (${r.status} ${body.error || ""})`);
  accessToken = body.access_token;
  accessTokenExpiry = Date.now() + 1000 * (body.expires_in || 3600);
  return accessToken;
}
// Gmail signals rate limiting as 429, or as 403 with reason rateLimitExceeded / userRateLimitExceeded
// (seen 2026-11-26 on a cold fetch of 250 messages). Retry those with exponential back-off; any other
// error (a real permission problem, a deleted message) fails at once with Gmail's reason in the message.
const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
async function gmail(path) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${GMAIL}${path}`, {
      headers: { Authorization: `Bearer ${await googleAccessToken()}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.ok) return r.json();
    const body = await r.json().catch(() => ({}));
    const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || "";
    const limited = r.status === 429 || (r.status === 403 && RATE_REASONS.has(reason));
    if (!limited || attempt >= 4) throw new Error(`Gmail ${path.split("?")[0].replace(/\/messages\/[^/]+/, "/messages/<id>")} -> ${r.status} ${reason}`);
    await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt + Math.floor(Math.random() * 250)));
  }
}

// ---------------------------------------------------------------- MIME → readable text
const b64urlDecode = (s) => Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…", zwnj: "", zwj: "", shy: "" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
function htmlToText(html) {
  return decodeEntities(html
    .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li|table|section|article|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " "));
}
// Zero-width and line-separator characters that newsletters use as preheader padding. Built from code
// points so the source stays ASCII (U+2028/U+2029 are line terminators inside a regex literal).
const ZERO_WIDTH = new RegExp("[" + [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x034f, 0x00ad, 0xfeff]
  .map((c) => "\\u" + c.toString(16).padStart(4, "0")).join("") + "]", "g");
// Newsletter plain-text parts are full of tracking URLs; on a 576x288 display they are pure noise.
function tidy(text) {
  return text
    .replace(ZERO_WIDTH, "")                                   // zero-width/preheader padding characters
    .replace(/\(?\s*<?https?:\/\/[^\s)>\]]+>?\s*\)?/gi, " ")      // bare or bracketed URLs
    .replace(/\[\s*\]/g, " ")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function findPart(part, mime) {
  if (!part) return null;
  if (part.mimeType === mime && part.body?.data) return part;
  for (const child of part.parts || []) {
    const hit = findPart(child, mime);
    if (hit) return hit;
  }
  return null;
}
function bodyText(payload) {
  const plain = findPart(payload, "text/plain");
  const html = findPart(payload, "text/html");
  let text = plain ? b64urlDecode(plain.body.data) : html ? htmlToText(b64urlDecode(html.body.data)) : "";
  // Some senders put a stub ("view in browser") in text/plain; prefer the HTML when plain is tiny.
  if (plain && html && text.trim().length < 200) text = htmlToText(b64urlDecode(html.body.data));
  text = tidy(text);
  return text.length > maxTextChars ? `${text.slice(0, maxTextChars).trimEnd()}\n\n[… truncated]` : text;
}
function header(msg, name) {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value || "";
}
function parseFrom(value) {
  // "Name <addr@x>" | "<addr@x>" | "addr@x"; RFC 2047 encoded words are already decoded by Gmail's API.
  const m = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const email = (m ? m[2] : value).trim().toLowerCase();
  const name = (m ? m[1] : "").trim() || email;
  return { email, name };
}

// ---------------------------------------------------------------- Gmail cache: label → messages → chats
const messageCache = new Map(); // gmail id -> normalized record (immutable content; unread re-checked per refresh)
let labelId = null;
let snapshot = { chats: [], messagesByChat: new Map(), at: 0 };
let refreshing = null;
let lastError = null;

const chatIdFor = (senderKey) => `${accountID}:${createHash("sha256").update(senderKey).digest("hex").slice(0, 16)}`;
const isGmailChat = (id) => typeof id === "string" && id.startsWith(`${accountID}:`);

async function resolveLabelId() {
  if (labelId) return labelId;
  const { labels = [] } = await gmail("/labels");
  const hit = labels.find((l) => l.name === labelName);
  if (!hit) throw new Error(`Gmail label "${labelName}" not found`);
  labelId = hit.id;
  return labelId;
}
async function listIds(extraLabel) {
  const ids = [];
  let pageToken;
  const labels = [await resolveLabelId(), ...(extraLabel ? [extraLabel] : [])];
  do {
    const q = new URLSearchParams({ q: `newer_than:${windowDays}d`, maxResults: String(Math.min(100, maxMessages)) });
    labels.forEach((l) => q.append("labelIds", l));
    if (pageToken) q.set("pageToken", pageToken);
    const page = await gmail(`/messages?${q}`);
    for (const m of page.messages || []) ids.push(m.id);
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < maxMessages);
  return ids.slice(0, maxMessages);
}
async function fetchMessage(id) {
  const msg = await gmail(`/messages/${encodeURIComponent(id)}?format=full`);
  const from = parseFrom(header(msg, "from"));
  const subject = header(msg, "subject").trim() || "(no subject)";
  const ms = Number(msg.internalDate) || Date.now();
  return { id: msg.id, from, subject, ms, text: `${subject}\n\n${bodyText(msg.payload)}`.trim() };
}

async function refresh() {
  const started = Date.now();
  const [ids, unreadIds] = await Promise.all([listIds(), listIds("UNREAD")]);
  const unread = new Set(unreadIds);
  const missing = ids.filter((id) => !messageCache.has(id));
  for (let i = 0; i < missing.length; i += FETCH_CONCURRENCY) {
    const batch = missing.slice(i, i + FETCH_CONCURRENCY);
    const got = await Promise.allSettled(batch.map(fetchMessage));
    got.forEach((r, j) => { if (r.status === "fulfilled") messageCache.set(batch[j], r.value); else log(`skip one message: ${r.reason.message}`); });
  }
  const keep = new Set(ids);
  for (const id of messageCache.keys()) if (!keep.has(id)) messageCache.delete(id);

  // One chat per sender NAME: a newsletter is a "contact", each issue a message. Keyed by display name, not
  // address, because publishers send from several addresses (Bloomberg used two in the first test run) and
  // two chats with the same title are indistinguishable on the glasses.
  const bySender = new Map();
  for (const id of ids) {
    const rec = messageCache.get(id);
    if (!rec) continue;
    const key = rec.from.name.trim().toLowerCase() || rec.from.email;
    const list = bySender.get(key) || [];
    list.push({ ...rec, unread: unread.has(id) });
    bySender.set(key, list);
  }
  const chats = [];
  const messagesByChat = new Map();
  for (const [key, list] of bySender) {
    list.sort((a, b) => b.ms - a.ms); // newest first, as Beeper returns messages
    const email = list[0].from.email;  // newest message's address stands for the chat
    const chatID = chatIdFor(key);
    const sender = { id: email, fullName: list[0].from.name, cannotMessage: true, isSelf: false, isAdmin: false, isPending: false, isNetworkBot: false };
    const messages = list.map((m) => ({
      id: `${accountID}:${m.id}`,
      chatID,
      accountID,
      senderID: m.from.email,
      senderName: m.from.name,
      timestamp: new Date(m.ms).toISOString(),
      sortKey: String(m.ms),
      type: "TEXT",
      text: m.text,
      isSender: false,
      isDeleted: false,
      mentions: [],
      isUnread: m.unread,
    }));
    const newest = messages[0];
    // list is newest-first, so the LAST unread index is the oldest unread message.
    const oldestUnread = list.findLastIndex((m) => m.unread);
    chats.push({
      id: chatID,
      localChatID: chatID,
      accountID,
      network: "Email",
      title: list[0].from.name,
      description: email,
      type: "single",
      isReadOnly: true,
      participants: { items: [sender], hasMore: false, total: 1 },
      lastActivity: newest.timestamp,
      unreadCount: list.filter((m) => m.unread).length,
      unreadMentionsCount: 0,
      // Read marker sits just before the oldest unread message, mirroring Beeper's lastReadMessageSortKey.
      lastReadMessageSortKey: oldestUnread === -1 ? newest.sortKey : String(list[oldestUnread].ms - 1),
      draft: null,
      reminder: null,
      snooze: null,
      isArchived: false,
      isMarkedUnread: false,
      isMuted: false,
      isPinned: false,
      isLowPriority: false,
      messageExpirySeconds: null,
      preview: { ...newest, text: list[0].subject },
    });
    messagesByChat.set(chatID, messages);
  }
  chats.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
  snapshot = { chats, messagesByChat, at: Date.now() };
  lastError = null;
  log(`refreshed: ${ids.length} messages (${missing.length} fetched), ${chats.length} chats, ${unread.size} unread, ${Date.now() - started}ms`);
}

// Serve the last snapshot immediately; refresh in the background when it is stale. A cold start (empty
// snapshot) waits at most COLD_WAIT_MS: a full fetch can take ~2 minutes under Gmail's rate limit, and the
// chat list must not hang that long. Until the first fetch lands, Beeper's chats are served alone and the
// email chats appear on GazeChat's next poll.
const COLD_WAIT_MS = 3000;
async function gmailSnapshot() {
  const stale = Date.now() - snapshot.at > refreshMs;
  if (stale && !refreshing) {
    refreshing = refresh().catch((e) => { lastError = e; log(`refresh failed: ${e.message}`); }).finally(() => { refreshing = null; });
  }
  if (snapshot.at === 0 && refreshing) await Promise.race([refreshing, new Promise((ok) => setTimeout(ok, COLD_WAIT_MS))]);
  return snapshot;
}

// ---------------------------------------------------------------- caller authentication for Gmail routes
const tokenVerdicts = new Map(); // token hash -> { ok, until }
function callerToken(req, url) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : url.searchParams.get("access_token") || "";
}
async function callerAllowed(token) {
  if (!token) return false;
  const key = createHash("sha256").update(token).digest("hex");
  const cached = tokenVerdicts.get(key);
  if (cached && cached.until > Date.now()) return cached.ok;
  let ok = false;
  try {
    const r = await fetch(new URL("/oauth/introspect", beeperBase), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(5000),
    });
    ok = r.ok && (await r.json()).active === true;
  } catch { ok = false; }
  tokenVerdicts.set(key, { ok, until: Date.now() + (ok ? INTROSPECT_OK_MS : INTROSPECT_BAD_MS) });
  return ok;
}

// ---------------------------------------------------------------- HTTP plumbing
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Max-Age": "600",
};
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "origin", "referer"]);

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...CORS, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}
function forwardHeaders(incoming) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  out.host = beeperBase.host;
  return out;
}

// Stream a request to Beeper and stream the answer back (assets, uploads and everything not intercepted).
function proxy(req, res, body) {
  const upstream = httpRequest(new URL(req.url, beeperBase), { method: req.method, headers: forwardHeaders(req.headers) }, (up) => {
    const headers = { ...up.headers, ...CORS };
    delete headers["access-control-allow-origin"];
    res.writeHead(up.statusCode || 502, { ...headers, ...CORS });
    up.pipe(res);
  });
  upstream.on("error", (e) => { if (!res.headersSent) sendJson(res, 502, { message: "Beeper Desktop unreachable", code: "bad_gateway" }); log(`proxy error ${req.method} ${new URL(req.url, "http://x").pathname}: ${e.message}`); });
  if (body) upstream.end(body); else req.pipe(upstream);
}

// Fetch a Beeper JSON response so it can be merged (only for the few GETs we augment).
function beeperJson(req) {
  return new Promise((ok, ko) => {
    const upstream = httpRequest(new URL(req.url, beeperBase), { method: "GET", headers: forwardHeaders(req.headers) }, (up) => {
      const chunks = [];
      up.on("data", (c) => chunks.push(c));
      up.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        ok({ status: up.statusCode || 502, json, text, contentType: up.headers["content-type"] || "application/json" });
      });
      up.on("error", ko);
    });
    upstream.on("error", ko);
    upstream.end();
  });
}
function relay(res, r) {
  res.writeHead(r.status, { ...CORS, "Content-Type": r.contentType });
  res.end(r.text);
}

function gmailAccount() {
  return {
    accountID,
    loginID: expectedAccount,
    bridge: { id: "gmail-facade", type: "email", provider: "local" },
    network: "Email",
    user: { id: expectedAccount, email: expectedAccount, fullName: accountName, displayText: accountName, username: expectedAccount, isSelf: true },
    status: lastError ? "error" : "connected",
  };
}

// ---------------------------------------------------------------- routes
async function handle(req, res) {
  const url = new URL(req.url || "/", "http://x");
  const path = url.pathname;
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent); // ["v1","chats",id,"messages"]

  if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }

  // Requests that address a Gmail chat never reach Beeper (it would 404 or, worse, misroute).
  if (parts[0] === "v1" && parts[1] === "chats" && isGmailChat(parts[2])) {
    if (!(await callerAllowed(callerToken(req, url)))) { sendJson(res, 401, { message: "Invalid token", code: "unauthorized" }); return; }
    const snap = await gmailSnapshot();
    const chat = snap.chats.find((c) => c.id === parts[2]);
    if (req.method === "PATCH" && parts.length === 3) { sendJson(res, 200, chat || {}); return; } // draft sync: no-op
    if (req.method !== "GET") { sendJson(res, 403, { message: "This email account is read-only", code: "forbidden" }); return; }
    if (!chat) { sendJson(res, 404, { message: "Chat not found", code: "not_found" }); return; }
    if (parts.length === 3) { const { preview, ...rest } = chat; sendJson(res, 200, rest); return; }
    if (parts.length === 4 && parts[3] === "messages") {
      sendJson(res, 200, { items: snap.messagesByChat.get(chat.id) || [], hasMore: false, oldestCursor: null, newestCursor: null });
      return;
    }
    sendJson(res, 404, { message: "Not found", code: "not_found" });
    return;
  }

  // Augmented GETs: fetch Beeper's answer, add Gmail items, return the merge.
  if (req.method === "GET" && (path === "/v1/accounts" || path === "/v1/chats" || path === "/v1/chats/search" || path === "/v1/messages/search")) {
    const filter = url.searchParams.getAll("accountIDs");
    const gmailOnly = path === "/v1/chats" && filter.length > 0 && filter.every((a) => a === accountID);
    const wantGmail = filter.length === 0 || filter.includes(accountID);
    if (gmailOnly && !(await callerAllowed(callerToken(req, url)))) { sendJson(res, 401, { message: "Invalid token", code: "unauthorized" }); return; }
    const beeper = gmailOnly ? { status: 200, json: { items: [], hasMore: false, oldestCursor: null, newestCursor: null } } : await beeperJson(req);
    if (beeper.status !== 200 || !beeper.json) { relay(res, beeper); return; }      // Beeper rejected (e.g. bad token): pass it on
    if (!wantGmail) { relay(res, beeper); return; }
    // Beeper accepted the token for this request, but introspect is the explicit check for Gmail data.
    if (!gmailOnly && !(await callerAllowed(callerToken(req, url)))) { relay(res, beeper); return; }
    let snap;
    try { snap = await gmailSnapshot(); } catch { snap = snapshot; }

    if (path === "/v1/accounts") {
      sendJson(res, 200, Array.isArray(beeper.json) ? [...beeper.json, gmailAccount()] : beeper.json);
      return;
    }
    if (path === "/v1/chats") {
      const page = beeper.json;
      const items = Array.isArray(page.items) ? page.items : [];
      // Stateless merge by date: put every Gmail chat newer than this page's oldest Beeper chat on this page.
      // GazeChat drops chats it has already seen (by id), so repeats on later pages are harmless; on the last
      // page (hasMore false) the older Gmail chats are added too, so none is ever lost.
      const floor = page.hasMore && items.length ? items[items.length - 1].lastActivity : "";
      const extra = snap.chats.filter((c) => c.lastActivity >= floor && !items.some((i) => i.id === c.id));
      const merged = [...items, ...extra].sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
      sendJson(res, 200, { ...page, items: merged });
      return;
    }
    const q = (url.searchParams.get("q") || "").toLowerCase();
    if (path === "/v1/chats/search" && Array.isArray(beeper.json.items)) {
      const hits = q ? snap.chats.filter((c) => c.title.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)) : [];
      sendJson(res, 200, { ...beeper.json, items: [...beeper.json.items, ...hits] });
      return;
    }
    if (path === "/v1/messages/search" && Array.isArray(beeper.json.items)) {
      const hits = q ? [...snap.messagesByChat.values()].flat().filter((m) => m.text.toLowerCase().includes(q)).slice(0, 20) : [];
      sendJson(res, 200, { ...beeper.json, items: [...beeper.json.items, ...hits] });
      return;
    }
    relay(res, beeper);
    return;
  }

  proxy(req, res);
}

const server = createServer((req, res) => {
  const started = Date.now();
  handle(req, res).catch((e) => {
    log(`500 ${req.method} ${new URL(req.url || "/", "http://x").pathname}: ${e.message}`);
    if (!res.headersSent) sendJson(res, 500, { message: "facade error", code: "internal" });
  }).finally(() => {
    const p = new URL(req.url || "/", "http://x").pathname;
    if (p.includes(accountID) || res.statusCode >= 400) log(`${res.statusCode} ${req.method} ${p.replace(/[0-9a-f]{16}/g, "<chat>")} ${Date.now() - started}ms`);
  });
});

// WebSocket (/v1/ws): replay the upgrade request to Beeper over a raw socket and pipe both directions.
// Browsers cannot set headers on a WebSocket, so GazeChat puts its token in `?access_token=`; Beeper
// (checked 2026-11-26) answers that with 401 and accepts only `Authorization: Bearer`. Move the token
// from the query into the header so the live-update channel actually connects.
server.on("upgrade", (req, socket, head) => {
  const target = new URL(req.url || "/", "http://x");
  const queryToken = target.searchParams.get("access_token");
  target.searchParams.delete("access_token");
  const path = target.pathname + (target.search || "");
  const upstream = netConnect(Number(beeperBase.port), beeperBase.hostname, () => {
    const headers = Object.entries(req.headers)
      .filter(([k]) => !["host", "origin"].includes(k.toLowerCase()))
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
    if (queryToken && !req.headers.authorization) headers.push(`authorization: Bearer ${queryToken}`);
    upstream.write([`${req.method} ${path} HTTP/1.1`, `host: ${beeperBase.host}`, ...headers, "", ""].join("\r\n"));
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => { upstream.destroy(); socket.destroy(); };
  upstream.on("error", close);
  socket.on("error", close);
});

server.listen(listenPort, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${listenPort} -> Beeper ${beeperBase.origin}; account ${accountID}, label "${labelName}", ${windowDays}d`);
  gmailSnapshot().catch(() => {});
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
