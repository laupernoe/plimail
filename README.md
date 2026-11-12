<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="media/plimail-logo-light.png">
    <img src="media/plimail-logo-dark.png" width="320" alt="plimail">
  </picture>
</p>

<p align="center">A lighter, self-hosted unified webmail client with calendars.</p>

<p align="center">
  <a href="LICENSE">AGPL-3.0</a> ·
  <a href="https://github.com/laupernoe/plimail">Source code</a> ·
  <a href="https://github.com/laupernoe/plimail/issues">Issues</a>
</p>

Plimail puts every IMAP mailbox you own in one inbox, and keeps your calendars next to it. It runs
as a handful of Docker containers on your own server (Node/Express backend, React frontend,
PostgreSQL, Redis), and your mail stays on your mail servers: Plimail caches headers and bodies
for speed, and sends flag changes, moves and deletes back to IMAP.

> Plimail is a fork of MailFlow by Matt (https://github.com/maathimself/mailflow), licensed AGPL-3.0.
> See [NOTICE](NOTICE) for what changed.

## What it does

- **Unified inbox** across any number of IMAP/SMTP accounts, with OAuth sign-in for Google and Microsoft
- **Threads, search, snooze, rules, categories, unsubscribe, scheduled send, drafts**
- **Calendars** over CalDAV, with their own settings and an upcoming-events pane
- **Contacts**, served to phones and desktop apps as a CardDAV address book, with autocomplete learned from sent mail
- **Themes, layouts, keyboard shortcuts and 11 interface languages**
- **PWA, desktop (Electron) and Android shells**, web push notifications
- **Single sign-on** (OIDC), TOTP, invite-only registration, API tokens
- Remote images are proxied, and message HTML is sanitized before it is stored

## Run it

You need Docker with the compose plugin.

```bash
git clone https://github.com/laupernoe/plimail.git
cd plimail
cp .env.example .env
```

Edit `.env` and set at least:

| Variable | What |
|---|---|
| `SESSION_SECRET` | at least 32 random characters (`openssl rand -hex 32`) |
| `DB_PASSWORD` | password for the bundled PostgreSQL |
| `ENCRYPTION_KEY` | exactly 64 hex characters (`openssl rand -hex 32`). Lose it and stored account passwords cannot be decrypted |
| `APP_URL` | the URL you will open Plimail at |

```bash
docker compose up -d --build
```

Open `https://localhost` (or the port you set with `APP_PORT`) and create the first account,
which becomes the administrator. Plimail's nginx serves a self-signed certificate unless you set
`NGINX_TLS=off` behind your own reverse proxy, or run `docker compose --profile https up -d` for
automatic Let's Encrypt certificates through Caddy (set `DOMAIN` and `ACME_EMAIL`). Every setting
is documented in `.env.example`.

`docker-compose.ghcr.yml` is the same stack from prebuilt `ghcr.io/laupernoe/plimail-*` images.

### Updating and backups

```bash
git pull
docker compose up -d --build
```

Migrations are applied at startup. Admins can download and restore a full backup under
Settings, Administration, Backup. Keep your `ENCRYPTION_KEY` with the backup.

> Existing installs: the environment variables (`MAILFLOW_*`), database name, Docker volumes and
> network keep their original `mailflow` names, so an install of MailFlow upgrades in place.

## Development

Node 22.

```bash
cd backend  && npm ci && npm test && npm run lint
cd frontend && npm ci && npm test && npm run lint && npm run build
```

See `CLAUDE.md` and `CONTRIBUTING.md` for how the code fits together and how to contribute.

## License and source

Plimail is free software under the [GNU AGPL-3.0](LICENSE). If you run a modified version for other
people, section 13 requires you to offer them its source; the Settings, About page links to
https://github.com/laupernoe/plimail for that.

Plimail is a fork of MailFlow by Matt (https://github.com/maathimself/mailflow), licensed AGPL-3.0.
The original copyright notices are kept; the modifications are listed in [NOTICE](NOTICE).
