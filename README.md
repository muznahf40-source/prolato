# Prolato Physician Outreach Pipeline — Render deployment

This is a real, standalone version of the outreach tracker: a Node/Express
server with a Postgres-backed key-value store, instead of Claude's
artifact storage. It's meant to be deployed on Render so it works outside
of Claude entirely — no Claude account, no artifact link, just a normal
website with a database behind it.

## ⚠️ Read this before you deploy: the free Postgres database gets deleted

This is important enough to put at the top rather than the bottom.
Render's **free** PostgreSQL databases are **automatically and permanently
deleted 30 days after creation** (a 14-day grace period to upgrade, then
it's gone — no backups, no recovery). If you deploy this on the free
Blueprint below and don't upgrade the database before then, every
contact, note, and scheduled visit your team enters **will be wiped out**.

For a real team tool you intend to keep using, upgrade the database to a
paid instance (Render's cheapest paid Postgres tier is a few dollars a
month) **before** the 30-day mark. You can do this any time from the
database's page in the Render dashboard — no code changes needed, no
downtime beyond a couple of minutes while it migrates.

The free web *service* (as opposed to the database) doesn't get deleted,
but it does spin down after 15 minutes of no traffic and takes 30–60
seconds to wake back up on the next visit. Annoying, not dangerous — the
database expiration is the one that can actually lose your data.

## What's in here

- `server.js` — a small Express server. Serves the front-end and exposes
  two API routes (`GET /api/kv/:key`, `POST /api/kv/:key`) that read/write
  a single row in Postgres. This is the same shape as Claude's `window.storage`
  API, so almost none of the front-end logic had to change.
- `public/index.html` — the entire tracker (HTML, CSS, and JS in one file),
  seeded with your current 168 contacts.
- `render.yaml` — a Render "Blueprint" that creates both the web service
  and a free Postgres database in one step.
- `package.json` — just `express` and `pg` as dependencies.

## Deploying on Render (recommended: Blueprint, ~2 minutes)

1. Put this folder in a GitHub repo (see "Getting this onto GitHub" below
   if you haven't done that part yet).
2. In the Render dashboard, click **New +** → **Blueprint**.
3. Connect the GitHub repo. Render will read `render.yaml` automatically
   and show you a plan to create:
   - a free Postgres database (`prolato-outreach-db`)
   - a free web service (`prolato-outreach-pipeline`)
4. Click **Apply**. Render provisions both and automatically wires the
   database's connection string into the web service's `DATABASE_URL`
   environment variable — you don't need to copy/paste anything.
5. Once it finishes deploying, Render gives you a URL like
   `https://prolato-outreach-pipeline.onrender.com`. That's the real,
   permanent link to share with your team — send that one instead of
   any Claude artifact link.

## Deploying manually (if you'd rather not use the Blueprint)

1. In Render: **New +** → **PostgreSQL**. Create a free database, name it
   whatever you like. Copy its "Internal Database URL" once it's ready.
2. **New +** → **Web Service**. Connect the same repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Add an environment variable `DATABASE_URL` set to the internal
     database URL you copied.
3. Deploy. The server creates its own database table automatically the
   first time it starts (see `ensureTable()` in `server.js`), so there's
   no manual schema step.

## Getting this onto GitHub (if it's not there yet)

If you don't already have this in a repo:

```bash
cd prolato-outreach-pipeline
git init
git add .
git commit -m "Initial commit"
```

Then create an empty repo on GitHub and follow the push instructions
GitHub shows you (`git remote add origin ...`, `git push -u origin main`).

## Important differences from the Claude artifact version

- **No more Claude-specific passcode/session tricks** — those were
  already removed in the artifact version and stayed removed here.
- **Real persistence** — every contact, note, and scheduled visit lives
  in an actual Postgres row now, not in Claude's storage. It'll survive
  regardless of what happens to the original Claude conversation.
- **Free-tier Render specifics**: free web services spin down after 15
  minutes of no traffic (30–60 second wake-up on the next visit — no data
  loss, just a delay). The free Postgres database is the one that matters:
  it's deleted 30 days after creation unless upgraded — see the warning at
  the top of this file. Render also caps free workspaces at 750 instance
  hours/month combined across services, which is enough for one service
  running continuously.
- **Syncing between teammates** still works the same way it did in the
  Claude version: the page polls the server every 15 seconds for changes,
  so a colleague's new entry shows up for everyone else shortly after —
  no manual refresh required.
