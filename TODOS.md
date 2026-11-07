# Messenger Glass — TODOS

Updated: 2026-11-07. Design of record: `docs/design.md`. Phases: `docs/design.md` §9.

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

Done 2026-11-04: §8 Q4 (private beta only) and Q5 (public GitHub repo) decided by the owner.
