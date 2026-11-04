# Messenger Glass — TODOS

Updated: 2026-11-04. Design of record: `docs/design.md`. Phases: `docs/design.md` §9.

| # | Item | Status | Waits on |
|---|---|---|---|
| 1 | P0: approve `docs/design.md` | open; owner's change applied 2026-11-04 (third-party product reference removed) | owner |
| 2 | §8 Q2: check how Linux containers run on the host PC (Docker Desktop / WSL2) | checked 2026-11-04: PC has no runtime (WSL2, no distro); NAS candidate assessed (fits server, not STT) | owner: PC or NAS; NAS RAM |
| 3 | §8 Q3: read the Even Hub SDK docs on background alerts | done 2026-11-04: no background delivery; §6 updated | — |
| 4 | P1: homeserver + mautrix-whatsapp behind `tailscale serve` on :8448 | not started | items 1, 2 |
| 5 | P2: app chat list + thread reader; build step merges `app/app.local.json` into the manifest | not started | item 4 |
| 6 | P3: STT companion + voice reply with review | not started | item 5 |
| 7 | P4: Signal + Telegram bridges | not started | item 4 |
| 8 | P5: setup guide for fork-and-build users | not started | items 4–7 |

Done 2026-11-04: §8 Q4 (private beta only) and Q5 (public GitHub repo) decided by the owner.
