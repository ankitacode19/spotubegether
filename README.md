# 🎵 SyncSpace

Watch YouTube together and listen to Spotify in sync — **no Premium needed, no accounts required**.

---

## What's inside

| File | Purpose |
|---|---|
| `server.js` | Node.js backend — WebSocket rooms + Spotify token proxy |
| `public/index.html` | Full frontend — landing page, YouTube room, Spotify room |
| `package.json` | Dependencies |

---

## How it works

### YouTube Together
Uses the **YouTube IFrame API** (100% official and free). Sync events (play, pause, seek, load) are broadcast over WebSockets to everyone in the room. No sign-in needed.

### Spotify Listen Along
Uses Spotify's **internal web player token endpoint** — the same one your browser uses when you open `open.spotify.com`. 

**Your `sp_dc` cookie flow:**
```
Your browser → POST /api/spotify/token (your server) → open.spotify.com/get_access_token → returns short-lived token → sent back to your browser
```
The cookie is **never stored, never logged**. It's forwarded once to Spotify, and only the resulting short-lived access token is kept in your browser session. Playback is controlled via the official **Spotify Web API** (`/v1/me/player`).

### Real-time sync
Built on **Socket.io** over WebSockets. Rooms are in-memory (no database needed). Rooms auto-delete when the last person leaves.

---

## Run locally

### 1. Prerequisites
- [Node.js 18+](https://nodejs.org) — check with `node -v`

### 2. Install & start

```bash
# Clone or download the project
git clone https://github.com/yourname/syncspace.git
cd syncspace

# Install dependencies
npm install

# Start the server
npm start
```

Open **http://localhost:3000** in your browser. Done!

For development with auto-restart on file changes:
```bash
npm run dev
```

---

## Deploy for free

### Option A — Railway (Recommended, easiest)

Railway gives you $5/month free credit which easily covers a small app like this.

1. Go to [railway.app](https://railway.app) and sign up (free, use GitHub login)
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Connect your GitHub account and select your repo
   - (Push your code to GitHub first: `git init && git add . && git commit -m "init" && git remote add origin YOUR_REPO_URL && git push`)
4. Railway auto-detects Node.js and runs `npm start`
5. Click **"Generate Domain"** in Settings → Networking to get a free URL like `syncspace.up.railway.app`

That's it. Your app is live.

---

### Option B — Render (Free tier, sleeps after 15min inactivity)

1. Go to [render.com](https://render.com) and sign up
2. Click **"New"** → **"Web Service"**
3. Connect your GitHub repo
4. Set:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
5. Click **"Create Web Service"**

⚠️ On Render's free tier, the server **sleeps after 15 minutes of inactivity** and takes ~30 seconds to wake up on the next request. Upgrade to Starter ($7/mo) to keep it always-on.

---

### Option C — Fly.io (Free tier, always-on)

Fly.io has a generous free tier that stays always-on.

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Login
fly auth login

# Launch (run from your project folder)
fly launch

# Deploy
fly deploy
```

Follow the prompts — Fly will auto-detect your Node app. Your app gets a free `*.fly.dev` URL.

---

## Environment variables (optional)

You can set these in your hosting platform's dashboard:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on (auto-set by most hosts) |
| `FRONTEND_URL` | `*` | CORS origin — set this to your domain in production e.g. `https://syncspace.up.railway.app` |

On Railway/Render/Fly, `PORT` is set automatically. You only need to set `FRONTEND_URL` if you see CORS errors.

---

## How to get your Spotify `sp_dc` cookie

1. Open [open.spotify.com](https://open.spotify.com) in Chrome/Edge/Firefox and **log in**
2. Press `F12` to open DevTools
3. Go to **Application** tab (Chrome/Edge) or **Storage** tab (Firefox)
4. Expand **Cookies** → click `https://open.spotify.com`
5. Find the cookie named **`sp_dc`** and copy its value

> **Is this safe for my account?**
> Yes — `sp_dc` is the same cookie your browser uses every time you open Spotify. This app only uses it to get a short-lived access token (valid for ~1 hour), then talks to Spotify's official API. It doesn't download music, doesn't modify your account, and doesn't do anything your browser doesn't already do. The cookie is never stored on the server.

---

## Project structure

```
syncspace/
├── server.js          ← Express + Socket.io backend
├── package.json
├── public/
│   └── index.html     ← Full frontend (single file)
└── README.md
```

---

## Tech stack

- **Backend:** Node.js, Express, Socket.io
- **Frontend:** Vanilla JS, Socket.io client, YouTube IFrame API
- **Sync:** WebSockets (Socket.io rooms)
- **Spotify:** Internal token endpoint + official Web API

---

## Limitations

- Rooms are **in-memory** — they reset if the server restarts. For persistent rooms, add Redis or a database.
- Spotify sync requires each user to have **Spotify open on a device** (it controls your existing player, doesn't stream audio)
- The `sp_dc` token expires after ~1 hour — users will need to reconnect
- YouTube sync requires the host to load a video URL; guests sync automatically on join

---

## License

MIT — use it however you want.
