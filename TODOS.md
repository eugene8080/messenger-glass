# Messenger Glass — TODOS

Updated: 2026-11-26. Design of record: `docs/design.md`. Phases: `docs/design.md` §9.

| # | Item | Status | Waits on |
|---|---|---|---|
| 1 | P0: approve `docs/design.md` | done 2026-11-04 (approved after the owner's edit) | — |
| 2 | §8 Q2: where the containers run | decided 2026-11-04: host PC, WSL2 (Ubuntu) + Docker Engine | — |
| 3 | §8 Q3: read the Even Hub SDK docs on background alerts | done 2026-11-04: no background delivery; §6 updated | — |
| 4 | P1: WSL2 Ubuntu + Docker Engine with a startup task; Synapse + Postgres + mautrix-whatsapp behind `tailscale serve` on :8448 | shelved 2026-11-07 (§8 Q7) | owner present for the WhatsApp QR scan |
| 5 | P2: app chat list + thread reader; build step merges `app/app.local.json` into the manifest | shelved 2026-11-07 (§8 Q7) | item 4 |
| 6 | P3: STT companion + voice reply with review | shelved 2026-11-07 (§8 Q7) | item 5 |
| 7 | P4: Signal + Telegram bridges | shelved 2026-11-07 (§8 Q7) | item 4 |
| 8 | P5: setup guide for fork-and-build users | shelved 2026-11-07 (§8 Q7) | items 4–7 |
| 9 | §8 Q7: build vs. Beeper-based plugin | decided 2026-11-07: Beeper Desktop + fork `eugene8080/gazechat` | — |
| 10 | GazeChat fork on the glasses | done 2026-11-07: 1.0.14 on private beta; reading, images, voice messages and transcription confirmed on the glasses by the owner | — |
| 11 | GazeChat fork: offer `fix/dev-only-log` upstream as a PR | opened 2026-11-07: <https://github.com/builtproper/gazechat/pull/1> | builtproper (review) |
| 12 | Beeper as the WhatsApp source for the owner's other tools (details in `INTERNAL.md`) | not started; MCP first, the rest after 3–4 weeks of Beeper stability | owner |
| 13 | Speech-to-text for GazeChat voice replies | done 2026-11-07: `companion/stt-server.mjs` (OpenAI-compatible, whisper.cpp, bearer token, loopback) behind tailnet-only `tailscale serve`; starts at logon. Owner confirmed transcription from the glasses 2026-11-07 | — |
| 14 | Gmail in GazeChat: `companion/mail-facade.mjs` in front of Beeper adds one read-only email account (work mailbox, Gmail label "6. Newsletters", one chat per sender); dedicated `gmail.readonly` token | built 2026-11-26: logon task + tailnet-only HTTPS; 20/20 end-to-end checks pass through the tailnet origin (email chats, read-only 403s, token 401s, Beeper pass-through, WebSocket). Owner confirmed email chats on the glasses 2026-11-26, then judged GazeChat a poor reader for long email (six readable rows, large indent, total row, tap-to-reply too sensitive, email mixed with chats): replaced by #15 | #15: switch the facade back to Beeper-only after Orca Glass Email (E1) is confirmed on the glasses |
| 15 | Email, Chat and a later document Reader move into Orca Glass as modules beside Coding, one app (owner, 2026-11-26) | brief written 2026-11-26: <https://github.com/eugene8080/orca-glass/blob/windows-android-codex/docs/super-app-task.md> (S0 + E1 read-only first, then E2 reply, C chat, R reader); build not started | implementing agent; owner's Gmail consent per account at E1 |

Done 2026-11-04: §8 Q4 (private beta only) and Q5 (public GitHub repo) decided by the owner.
