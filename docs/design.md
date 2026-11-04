---
type: design
status: active
parent: null
blocked_by: []
updated: 2026-11-04
---

# Messenger Glass — design note

Updated: 2026-11-04. Status: **draft for the owner's approval.** No app code is written yet.

## 1. What it is

A unified-inbox app for Even Realities G2 glasses. It reads chats from WhatsApp, Signal, Telegram and other
networks on the glasses, and sends a reply by voice after the user reviews the transcript.

Every network reaches the app through a Matrix homeserver and one bridge per network (§3). **Each user
self-hosts every part.** No server run by the author, no relay, no cloud account. The messages are
decrypted only on the user's own machine.

## 2. Distribution model

**Fork, configure, build, upload to your own Even Hub beta channel.** This is the model of
[Orca Glass](https://github.com/2ero20ne/orca-glass).

- The Even Hub network allowlist in `app/app.json` is static and takes full origins only. Wildcards and bare
  hostnames are not supported (<https://hub.evenrealities.com/docs/build/networking>). So each user writes
  their own homeserver origin into their build. The tracked `app/app.json` carries a placeholder origin; the
  real one stays in an untracked local file (§4).
- The target user is a G2 power user who can run Docker containers and Tailscale.
- **Private beta only for now** (§8 Q4, decided by the owner 2026-11-04). No public Even Hub listing.

## 3. Architecture

```
G2 glasses ─BLE─ phone (Even Realities app, Even Hub web app)
                    │  HTTPS, tailnet only (one origin, e.g. https://<pc>.<tailnet>.ts.net:8448)
                    ▼
            tailscale serve on the user's PC
              ├─ /_matrix/*  ──> Matrix homeserver (localhost)
              │                    ├─ mautrix-whatsapp
              │                    ├─ mautrix-signal
              │                    ├─ mautrix-telegram
              │                    └─ further mautrix bridges (gmessages, meta, discord, slack ...)
              └─ /stt/*      ──> companion: speech-to-text (Whisper, localhost)
```

Decisions and the reason for each:

1. **The app speaks one protocol: the Matrix client-server API.** Every network appears as Matrix rooms. A
   new network is a new bridge on the server, with no app change. The alternative, one adapter per messenger
   in our own code, means owning the integration with every network; we don't.
2. **One origin for everything.** The allowlist needs one entry. `tailscale serve` routes by path. Nothing is
   exposed outside the tailnet. The homeserver, bridges and companion bind to `127.0.0.1` only.
3. **The homeserver is private to one user and does not federate.** It is a bridge hub only. Federation off
   removes most of the homeserver's attack surface and its operational load.
4. **v1 has no Matrix end-to-end encryption on the app side.** Bridged rooms run unencrypted between the
   bridge and the homeserver, both on the same machine, behind the tailnet. This avoids putting a Matrix E2EE
   library (Olm/Megolm, vodozemac) into the Even Hub web app. The network-side encryption (WhatsApp, Signal)
   ends at the bridge in any design, because the bridge is a client of that network.
5. **The app uses raw HTTP, not `matrix-js-sdk`.** It needs a small part of the API:
   - `/login` or a pasted access token
   - `/sync` (long-poll) for the room list and new messages
   - `/rooms/{id}/messages` for scroll-back
   - `/rooms/{id}/send/m.room.message` for the reply
   - `/rooms/{id}/receipt` for read state

   The full SDK is large for a WebView on the phone, and most of it is crypto we don't use (decision 4).
6. **Voice replies go through a small companion that does speech-to-text on the PC.** The app records with the
   `g2-microphone` permission and posts the audio to `/stt`. It shows the transcript for review, and sends the
   reply as text to Matrix only on an explicit click. Orca Glass uses the same flow (Whisper on the PC); the
   approach is reused, the code is not shared.
7. **The bridges are run, not written.** The mautrix bridges are maintained upstream (<https://docs.mau.fi/>).
   This repo carries their configuration, the deployment files and the setup guide.

## 4. Components and repo layout

| Path | Contents |
|---|---|
| `app/` | The Even Hub app: `app.json` manifest, TypeScript, Vite, `@evenrealities/even_hub_sdk`. |
| `app/app.local.json` | **Untracked.** The user's real origin, merged into the manifest at build time (P2). |
| `companion/` | The STT service: one HTTP endpoint, Whisper, localhost only, authenticated by the app's access token. |
| `server/` | Deployment for the homeserver and the bridges: compose file, config templates, setup guide. |
| `docs/` | This note and the user setup guide. |
| `INTERNAL.md` | **Untracked.** The maintainer's own machine, paths and private notes. |

## 5. Networks: order and notes

| # | Network | Bridge | Login | Notes |
|---|---|---|---|---|
| 1 | WhatsApp | mautrix-whatsapp (whatsmeow) | QR scan, takes one linked-device slot | WhatsApp/Meta terms prohibit unofficial clients. The user accepts the account risk. |
| 2 | Signal | mautrix-signal | Link as a Signal device | Signal allows several linked devices. |
| 3 | Telegram | mautrix-telegram | The user's own Telegram API ID | Tolerant of third-party clients. |
| later | Google Messages, Meta (Instagram/Messenger), Discord, Slack, email | the matching mautrix bridge | per bridge | Add after the first three are stable. |

WhatsApp allows four linked devices besides the phone. A user who already runs another WhatsApp bridge or
client keeps it; mautrix-whatsapp takes one more slot. Messenger Glass does not depend on any other bridge.

## 6. G2 user interface (v1)

The G2 display is 576 × 288. The interaction patterns follow Orca Glass, for familiarity:

- **Chat list:** unread first, network shown as a short tag (`WA`, `SG`, `TG`), last message preview.
- **Thread:** native scrolling text. Each new message shows the sender.
- **Voice reply:** hold to talk, release to review the transcript, click to send, double-click to cancel.
  **Nothing is ever sent without the review step.**
- **Read receipts:** off by default (opening a thread on the glasses does not mark it read on the network).
  This is a privacy default, reversible in settings.
- **New-message alerts come from the phone, not from this app** (§8 Q3). An Even Hub app runs only while it is
  open on the glasses. The networks' own phone notifications cover alerts; the app shows unread state when it
  is opened.
- **Resume is a cold start.** The app keeps the `/sync` `since` token and the room list in `localStorage`. It
  rebuilds everything else and syncs again on every launch or resume. On Android a backgrounded WebView can be
  reclaimed, and on both platforms an in-flight long-poll can stall in background.

## 7. Privacy of this repository

The repository is public. Tracked files never contain a machine name, a tailnet name, a local path, a phone
number, a contact name, an access token or a bridge session. Those live in untracked files (`INTERNAL.md`,
`app/app.local.json`, `.local/`). A pre-commit hook (`.githooks/pre-commit`) blocks a commit whose staged
changes match a pattern in the untracked `.local/private-patterns.txt`. Commits use the GitHub no-reply
address.

## 8. Open questions

| # | Question | Who decides | Status |
|---|---|---|---|
| Q1 | Homeserver: Synapse, or a Conduit-family server (Continuwuity / Tuwunel)? | agent default, reversible | **Synapse.** The mautrix documentation targets it. Revisit if its memory use is a problem. |
| Q2 | Where do the containers run: the host PC (Docker Desktop or WSL2), or an always-on NAS? | checked 2026-11-04; the owner picks | **Host PC:** read-only check, 2026-11-04: no Docker, Podman or Rancher Desktop. WSL 2.7 is installed, default version 2, no distros. P1 would install a runtime. **NAS (raised by the owner 2026-11-04):** a Synology DS1618+ (x86-64, 4-core Atom C3538; DSM 7 with the legacy Docker package, already running containers; on the tailnet). Assessment: the homeserver and bridges are light and fit, and an always-on host keeps the bridges connected when the PC is off. The STT companion does not fit: the Atom C3538 (Goldmont) has no AVX, so CPU Whisper is too slow. STT stays on the PC, so voice replies need the PC on, and the app needs a second allowlisted origin for `/stt` (§3 decision 2). Open before P1: installed RAM (4 GB stock), SSH (off today), compose under the legacy Docker package or DSM 7.2 Container Manager, `tailscale serve` on the NAS package. |
| Q3 | Can an Even Hub app receive new-message alerts when it is not open on the glasses? | read the Even Hub SDK docs, 2026-11-04 | **No.** Even Hub FAQ (updated 2026-10-09, <https://hub.evenrealities.com/docs/reference/faq>): "Can I receive push notifications? **No.** Plugins are foreground-only on the glasses." and "Can I make network calls while backgrounded? **No.** WebView is suspended on background; in-flight requests stall." The older Background & Lifecycle page (updated 2026-06-22, <https://hub.evenrealities.com/docs/build/background-lifecycle>) says the iOS WebView keeps running and Android "may be suspended under memory pressure". The design follows the newer, stricter FAQ (§6). The SDK listeners (`onEvenHubEvent`, `onAppLocationChanged`, `onDeviceStatusChanged`) have no documented background delivery. |
| Q4 | Public Even Hub listing, or private beta only? | decided by the owner, 2026-11-04 | **private beta only** |
| Q5 | Repo hosting | decided by the owner, 2026-11-04 | **public GitHub repo** `eugene8080/messenger-glass` |
| Q6 | Package ID | agent default, reversible until the first upload | `com.eugene8080.messengerglass` |

## 9. Phases

| Phase | Scope | Done when |
|---|---|---|
| P0 | This note, the repo layout, the manifest | The owner approves this note |
| P1 | `server/`: homeserver plus mautrix-whatsapp on the host PC, behind `tailscale serve` | A WhatsApp chat appears as a Matrix room, read with `curl` over the tailnet origin |
| P2 | `app/`: chat list and thread reader over `/sync`; build merges `app/app.local.json` | Readable on the G2 simulator, then on the glasses |
| P3 | `companion/` plus the voice reply with review | A reply sent from the glasses arrives in WhatsApp, and cancel sends nothing |
| P4 | Signal and Telegram bridges | Both show in the same chat list with their tags |
| P5 | Setup guide good enough for a fork-and-build user | A clean-machine run of the guide works end to end |
