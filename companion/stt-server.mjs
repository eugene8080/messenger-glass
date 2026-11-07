#!/usr/bin/env node
// stt-server.mjs: an OpenAI-compatible speech-to-text endpoint backed by a local whisper.cpp server.
//
// Why: Even Hub messaging apps (GazeChat) send voice to an "OpenAI-compatible" provider. This keeps the audio
// on the user's own PC: the app posts to this service (reached only through `tailscale serve`), which forwards
// the WAV to whisper.cpp's `whisper-server` on loopback. No third-party service sees the audio.
//
// Surface (the subset GazeChat uses; see src/services/speechProvider.ts and transcribePcmAudio there):
//   GET  /v1/models                 -> {"object":"list","data":[{"id":"whisper-1",...}]}
//   POST /v1/audio/transcriptions   multipart/form-data with "file" (WAV) and "model" -> {"text":"..."}
//   OPTIONS *                       CORS preflight (the app runs in the phone's WebView, a different origin)
// Every non-OPTIONS request needs `Authorization: Bearer <token>` matching the configured token.
//
// Configuration: a JSON file (default .local/stt.json, untracked; override with STT_CONFIG):
//   {
//     "listenPort": 8797,                       // loopback port; publish it with tailscale serve
//     "token": "<long random string>",          // what the app sends as its Speech API token
//     "whisperServer": "<path>/whisper-server.exe",
//     "model": "<path>/ggml-base.en.bin",
//     "vadModel": "<path>/ggml-silero-v5.1.2.bin"   // optional: skips silence so Whisper does not invent words
//   }
//
// Privacy: transcripts and audio are never logged. Logs carry only status codes, sizes and timings.
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = process.env.STT_CONFIG || resolve(repoRoot, ".local", "stt.json");
const MAX_BODY_BYTES = 25 * 1024 * 1024; // OpenAI's own upload limit; a 60 s 16 kHz mono WAV is ~2 MB.
const WHISPER_START_TIMEOUT_MS = 60_000;
const TRANSCRIBE_TIMEOUT_MS = 120_000;

function log(message) {
  console.log(`[stt ${new Date().toISOString()}] ${message}`);
}

function fail(message) {
  console.error(`[stt] FATAL: ${message}`);
  process.exit(1);
}

// ---------- configuration ----------
let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (e) {
  fail(`cannot read config ${configPath}: ${e.message}`);
}
const { listenPort, token, whisperServer, model, vadModel } = config;
if (!Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535) fail("listenPort must be an integer 1024-65535");
if (typeof token !== "string" || token.length < 32) fail("token must be a string of at least 32 characters");
for (const [name, path] of [["whisperServer", whisperServer], ["model", model]]) {
  if (typeof path !== "string" || !existsSync(path)) fail(`${name} not found: ${path}`);
}
const useVad = typeof vadModel === "string" && existsSync(vadModel);
const tokenBytes = Buffer.from(token, "utf8");

// ---------- whisper.cpp worker (kept resident so each request skips model load) ----------
let whisperBase = null; // "http://127.0.0.1:<port>" once healthy
let whisperChild = null;
let whisperStarting = null;

async function freeLoopbackPort() {
  // Reserve-then-release: ask the OS for a free port, close, hand it to whisper-server.
  const probe = createNetServer();
  await new Promise((ok, ko) => { probe.once("error", ko); probe.listen(0, "127.0.0.1", ok); });
  const { port } = probe.address();
  await new Promise((ok) => probe.close(ok));
  return port;
}

async function startWhisper() {
  const port = await freeLoopbackPort();
  // -nt: no timestamps in text; -sns: suppress non-speech tokens; --vad: Silero voice-activity detection.
  const args = ["-m", model, "--host", "127.0.0.1", "--port", String(port), "-nt", "-sns"];
  if (useVad) args.push("--vad", "-vm", vadModel);
  const child = spawn(whisperServer, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  whisperChild = child;
  child.stderr.on("data", () => {}); // drain; whisper-server prints transcripts here, which we never log
  child.on("exit", (code) => {
    log(`whisper-server exited (code ${code}); it restarts on the next request`);
    if (whisperChild === child) { whisperChild = null; whisperBase = null; }
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + WHISPER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (whisperChild !== child) throw new Error("whisper-server stopped during start-up");
    const ok = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false);
    if (ok) { whisperBase = base; log(`whisper-server ready on ${base} (vad=${useVad})`); return base; }
    await new Promise((r) => setTimeout(r, 300));
  }
  child.kill();
  throw new Error("whisper-server did not become healthy in time");
}

function ensureWhisper() {
  if (whisperBase) return Promise.resolve(whisperBase);
  whisperStarting ??= startWhisper().finally(() => { whisperStarting = null; });
  return whisperStarting;
}

// ---------- HTTP helpers ----------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "600",
};

function send(res, status, body) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { ...CORS, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

function authorized(req) {
  const header = req.headers.authorization || "";
  const presented = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "", "utf8");
  // timingSafeEqual needs equal lengths; the length check itself leaks only the length, not the content.
  return presented.length === tokenBytes.length && timingSafeEqual(presented, tokenBytes);
}

function readBody(req) {
  return new Promise((ok, ko) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { ko(Object.assign(new Error("payload too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", ko);
  });
}

// Forward the client's multipart body unchanged: whisper-server's /inference reads the same "file" field,
// ignores "model", and answers {"text": "..."} (response_format defaults to json), i.e. OpenAI's shape.
function forwardToWhisper(base, body, contentType) {
  return new Promise((ok, ko) => {
    const url = new URL("/inference", base);
    const upstream = httpRequest(url, {
      method: "POST",
      headers: { "Content-Type": contentType, "Content-Length": body.length },
      timeout: TRANSCRIBE_TIMEOUT_MS,
    }, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => ok({ status: r.statusCode || 502, text: Buffer.concat(chunks).toString("utf8") }));
      r.on("error", ko);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("whisper-server timed out")));
    upstream.on("error", ko);
    upstream.end(body);
  });
}

// ---------- routes ----------
const server = createServer(async (req, res) => {
  const started = Date.now();
  const path = new URL(req.url || "/", "http://x").pathname;
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
    if (!authorized(req)) { send(res, 401, { error: { message: "invalid or missing bearer token" } }); log(`401 ${req.method} ${path}`); return; }

    if (req.method === "GET" && path === "/v1/models") {
      send(res, 200, { object: "list", data: [{ id: "whisper-1", object: "model", owned_by: "local-whisper.cpp" }] });
      return;
    }

    if (req.method === "POST" && path === "/v1/audio/transcriptions") {
      const contentType = req.headers["content-type"] || "";
      if (!contentType.startsWith("multipart/form-data")) { send(res, 400, { error: { message: "expected multipart/form-data" } }); return; }
      const body = await readBody(req);
      const base = await ensureWhisper();
      const upstream = await forwardToWhisper(base, body, contentType);
      let text = "";
      try { text = String(JSON.parse(upstream.text).text ?? "").trim(); } catch { /* non-JSON error page */ }
      if (upstream.status !== 200) {
        send(res, 502, { error: { message: `whisper-server returned ${upstream.status}` } });
        log(`502 transcribe in=${body.length}B upstream=${upstream.status} ${Date.now() - started}ms`);
        return;
      }
      send(res, 200, { text });
      log(`200 transcribe in=${body.length}B out=${text.length}ch ${Date.now() - started}ms`);
      return;
    }

    send(res, 404, { error: { message: "not found" } });
  } catch (e) {
    const status = e.status || 500;
    send(res, status, { error: { message: status === 413 ? "payload too large" : "transcription failed" } });
    log(`${status} ${req.method} ${path}: ${e.message}`);
  }
});

server.listen(listenPort, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${listenPort} (loopback only)`);
  ensureWhisper().catch((e) => log(`whisper warm-up failed: ${e.message}`));
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { whisperChild?.kill(); server.close(() => process.exit(0)); });
}
process.on("exit", () => whisperChild?.kill());
