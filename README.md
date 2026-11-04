# Messenger Glass

**WhatsApp, Signal, Telegram and more on your Even Realities G2 — from your own server.**

Messenger Glass is a unified inbox for G2 glasses. You read chats on the glasses and reply by voice; nothing is
sent until you review the transcript. Every network reaches the app through a Matrix homeserver and
[mautrix](https://docs.mau.fi/) bridges that **you run on your own PC**. There is no cloud service and no
account with us: your messages are decrypted only on your own machine.

> **Status (2026-11-04): design stage.** No app code yet. Read [the design note](docs/design.md).

## How it works

```
G2 glasses ─ phone (Even Hub app) ─ your Tailscale network ─ your PC
                                                               ├─ Matrix homeserver
                                                               │    ├─ mautrix-whatsapp
                                                               │    ├─ mautrix-signal
                                                               │    └─ mautrix-telegram ...
                                                               └─ speech-to-text companion
```

## Who it is for

G2 power users who can run Docker containers and Tailscale. You fork this repo, write your own server's
address into `app/app.json`, build the app, and upload it to your own Even Hub beta channel.

## Warning about unofficial clients

The WhatsApp bridge is built on whatsmeow, an unofficial WhatsApp Web client. WhatsApp's terms prohibit
unofficial clients, and accounts have been banned for using them. You take that risk for your own account.

## License

MIT. See [LICENSE](LICENSE).
