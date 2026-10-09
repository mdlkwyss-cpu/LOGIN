# IRONE Discord Key System

Discord bot `/key` + public key-validation API. The `/key` command is registered only in the configured Discord server (`GUILD_ID`), and responses are ephemeral (visible only to the requesting user). Existing commands are preserved when `/key` is created or updated.

## Required environment variables

- `DISCORD_TOKEN`: Discord Bot token. Set in Render Environment; never commit it to source control.
- `DISCORD_CLIENT_ID`: Application ID from Discord Developer Portal.
- `GUILD_ID`: the target Discord server ID, not the Application ID.
- `DATABASE_FILE`: both services must use the exact same database file. Render disk path: `/var/data/keys.db`.
- `KEY_PREFIX`: optional; defaults to `IRONE`.
- `PORT`: provided by Render automatically.

## Run locally

1. Copy `.env.example` to `.env` and fill in the values privately.
2. Install dependencies from the project root: `npm install`.
3. Start both API and bot together: `npm start`.
4. Test `http://127.0.0.1:3000/health` locally (or the configured local port).

API endpoints:
- `GET /health`
- `POST /api/keys/consume` with JSON body `{ "key": "IRONE-XXXXXXXX" }`. A successful key is marked used once.

## Deploy to Render

This repository includes `render.yaml` for one web service running both the API and Discord bot. It configures a paid `starter` web service and a 1 GB persistent disk so the SQLite database survives restarts/redeploys. **Review Render's current pricing before creating the service; this configuration can incur charges.** Free Render web services spin down when idle and do not support persistent disks, so they are not suitable for this SQLite always-on setup.

1. Upload this project to a private GitHub repository. Do not add `.env`, live tokens, or database files to GitHub.
2. In Render, create a Blueprint from that repository and review the service plan/disk costs before confirming.
3. Enter `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `GUILD_ID` when Render asks for environment values. Keep them private.
4. After deploy, open `https://YOUR-SERVICE.onrender.com/health`. It should return `{ "ok": true, "service": "irone-key-api" }`.
5. In the Android login project, use `https://YOUR-SERVICE.onrender.com/api/keys/consume` as the API URL, replacing `YOUR-SERVICE` with the actual Render hostname.

Do not use `127.0.0.1` in an Android app when the API is hosted on Render; use the public HTTPS URL.
