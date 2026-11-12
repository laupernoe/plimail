<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="media/plimail-logo-light.png">
    <img src="media/plimail-logo-dark.png" width="320" alt="Plimail">
  </picture>
</p>

# Plimail

A self-hosted, unified webmail client with calendars, shipped as one Docker image.

## Why this fork

Plimail is a fork of [MailFlow](https://github.com/maathimself/mailflow), created because it lacked
functionality and responsiveness for our needs. It keeps only what is necessary and aims for a
simple stack: CalDAV calendars and invitations were added; plugins, extra themes, integrations,
antispam and the mobile and desktop apps were removed.

## Features

- Unified inbox across any number of IMAP/SMTP accounts, with OAuth for Google and Microsoft
- Threads, search, snooze, rules, categories, scheduled send, drafts
- CalDAV calendars and meeting invitations
- Contacts, also served as a CardDAV address book
- Web push notifications, keyboard shortcuts, 11 interface languages
- Single sign-on (OIDC), TOTP, invite-only registration, API tokens
- Message HTML sanitized before it is stored; remote images proxied

## Quick start

You need Docker with the compose plugin.

```bash
curl -O https://raw.githubusercontent.com/laupernoe/plimail/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/laupernoe/plimail/main/.env.example
```

Fill in `.env`: `openssl rand -hex 32` for `SESSION_SECRET` and `ENCRYPTION_KEY`,
`openssl rand -hex 16` for `DB_PASSWORD`, and set `APP_URL`. Then:

```bash
docker compose up -d
```

Open `http://your-host:3000` and create the first account, which becomes the administrator.

## HTTPS

Plimail serves plain HTTP on port 3000; put your own reverse proxy (Caddy, Traefik, nginx…) in
front of it for HTTPS, forwarding `X-Forwarded-For` and `X-Forwarded-Proto` and WebSocket
upgrades on `/ws`.

## Configuration

Everything is set in `.env`.

| Variable | Required | Meaning |
|---|---|---|
| `SESSION_SECRET` | yes | Signs session cookies, at least 32 characters |
| `DB_PASSWORD` | yes | Password of the bundled PostgreSQL |
| `ENCRYPTION_KEY` | yes | 64 hex characters, encrypts stored account credentials. Keep it safe: if it changes, every account must be signed in again |
| `APP_URL` | yes | The URL people open, e.g. `https://mail.example.com`. WebSocket and sign-in redirects only accept this origin |
| `TRUST_PROXY_HOPS` | no | Reverse proxies in front of Plimail: `1` (default) or `0` when browsers connect directly. With `1`, make sure only the proxy can reach the port |
| `HTTP_PORT` | no | Host port, default `3000`; `127.0.0.1:3000` when the proxy is on the same host |

Session cookies are marked `Secure` only when the browser reached Plimail over HTTPS (as reported
by a trusted proxy), so plain HTTP on a LAN still works.

Optional settings, also read from `.env`:

- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`: web push (`npx web-push generate-vapid-keys`)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`: your own Google OAuth app (also settable in Settings, Email providers)
- `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`, `MS_REDIRECT_URI`, `MS_BUILTIN_APP`: Microsoft OAuth
- `IMAP_MAX_PERSISTENT_PER_HOST`: cap always-on IMAP connections per mail server (others are polled)
- `IMAGE_CACHE_MAX_MB`: size of the image proxy cache per user (default 512)
- `ALLOW_PRIVATE_IMAP_HOSTS=true`: allow mail servers on private addresses
- `SMTP_EHLO_NAME`, `LOG_LEVEL`, `UPDATE_CHECK_DISABLED=true`
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `REDIS_URL`: external PostgreSQL or Redis (database and user default to `mailflow`)

## Updating

```bash
docker compose pull && docker compose up -d
```

Migrations run at startup. Admins can download and restore a full backup under Settings,
Administration, Backup; keep `ENCRYPTION_KEY` with it.

## Development

Node 22. With PostgreSQL and Redis on localhost (database and user `mailflow`) and the required
variables plus `DB_HOST=localhost` and `REDIS_URL=redis://localhost:6379` in `backend/.env`:

```bash
cd backend && npm ci && npm run dev      # API on :3000
cd frontend && npm ci && npm run dev     # app on http://localhost:5173
```

Tests and lint: `npm test` and `npm run lint` in each directory. See `CLAUDE.md` for how the code
fits together.

## License

[AGPL-3.0](LICENSE). Plimail is based on MailFlow by Matt; the original copyright notices are
kept and the changes are listed in [NOTICE](NOTICE). If you run a modified version for other
people, section 13 requires you to offer them its source.
