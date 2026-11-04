# Messenger Glass — project conventions

Updated: 2026-11-04. Read the machine-level instructions first, then `INTERNAL.md` if it exists (untracked:
the maintainer's machine, paths and private notes).

- **This repository is public.** Never write a machine name, tailnet name, local path, phone number, contact
  name, access token or bridge session into a tracked file. Put them in `INTERNAL.md`, `app/app.local.json`
  or `.local/`. The pre-commit hook enforces this from `.local/private-patterns.txt`; it needs
  `git config core.hooksPath .githooks` once per clone. Never bypass it with `--no-verify`.
- **Design of record: `docs/design.md`.** Decisions, open questions and phases live there. Update it in the
  same commit as the work; do not start a second plan file.
- **Work list: `TODOS.md`.**
- **Never send a message on a real network during development or tests** without the owner's explicit request
  for that send. Use a test room or a synthetic fixture. Every reply path keeps the review step
  (`docs/design.md` §6).
- **Nothing listens beyond localhost** except through `tailscale serve`. Never use Tailscale Funnel or a public
  tunnel for this app.
- **Do not upload, promote or publish to Even Hub** without the owner's approval for that release.
- Stage by explicit path. Sign every commit with an `Agent: <provider> <model>` trailer.
