# Messenger Glass — TODOS

Updated: 2026-11-04. Design of record: `docs/design.md`. Phases: `docs/design.md` §9.

| # | Item | Status | Waits on |
|---|---|---|---|
| 1 | P0: approve `docs/design.md` | done 2026-11-04 (approved after the owner's edit) | — |
| 2 | §8 Q2: where the containers run | decided 2026-11-04: host PC, WSL2 (Ubuntu) + Docker Engine | — |
| 3 | §8 Q3: read the Even Hub SDK docs on background alerts | done 2026-11-04: no background delivery; §6 updated | — |
| 4 | P1: WSL2 Ubuntu + Docker Engine with a startup task; Synapse + Postgres + mautrix-whatsapp behind `tailscale serve` on :8448 | not started; unblocked | owner present for the WhatsApp QR scan |
| 5 | P2: app chat list + thread reader; build step merges `app/app.local.json` into the manifest | not started | item 4 |
| 6 | P3: STT companion + voice reply with review | not started | item 5 |
| 7 | P4: Signal + Telegram bridges | not started | item 4 |
| 8 | P5: setup guide for fork-and-build users | not started | items 4–7 |

Done 2026-11-04: §8 Q4 (private beta only) and Q5 (public GitHub repo) decided by the owner.
