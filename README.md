# First Person Boxer — online server

A small Node.js server for Online PvP: private two-player rooms, the lobby, and the authoritative match
(clock, rounds, every hit's result, stamina, guard, stun, knockdowns, scorecards, winner).
No accounts, no database, no secrets. Plain WebSockets (`ws` package).

## Run it on your computer (for testing)

```
npm install
npm start            # listens on port 8787
```
In the game: Online PvP → Server → `localhost:8787`.

## Put it online (Render, free)

1. Make a free GitHub account if you don't have one, create a new repository (e.g. `fpb-server`), and upload
   the files in this folder (`server.js`, `rules.js`, `package.json`, `package-lock.json`, `render.yaml`,
   `README.md`, `.gitignore`). Don't upload `node_modules`.
2. Make a free Render account at render.com (sign in with GitHub; no credit card needed for the free plan).
3. In Render: **New → Web Service** → pick your `fpb-server` repository.
   - Runtime: Node · Build command: `npm install` · Start command: `npm start`
   - Instance type: **Free** → **Create Web Service**.
4. When it says "Live", copy its address, e.g. `https://fpb-server-abcd.onrender.com`.
   Opening it in a browser shows "First Person Boxer online server is running".
5. Tell the game where it is (either way works):
   - In the game: Online PvP → Server → paste `fpb-server-abcd.onrender.com`. It's remembered on that device,
     and every invite link you send carries it, so your friend doesn't type anything.
   - Or for everyone who opens your site: edit `config.js` in the website folder before uploading it to Netlify
     (`window.FPB_SERVER='fpb-server-abcd.onrender.com';`).
6. Optional, tighter: in Render → Environment, set `ALLOWED_ORIGINS` to your game's address
   (e.g. `https://your-game.netlify.app`) so only your site can use the server.

## What the free plan means

- It goes to sleep after 15 minutes without any traffic. The first visit after that wakes it, which takes about a
  minute; the game shows "Waking the server…" and keeps trying. While a match or lobby is open it stays awake.
- Render may restart a free service now and then; rooms live in memory, so a restart ends any room in progress.
- Usage is tiny: a 3-minute round is roughly 1 MB of traffic per player.
- For no sleeping, Render's paid Starter instance (about $7/month) stays on all the time.

## Tests

With the server running (`FPB_DEV=1 npm start` enables a test-only hook; never set it on the real server):
```
node test/protocol_test.js     # rooms, lobby, settings modes, match flow, reconnection, rematch
node test/pvp_rules_test.js    # PvP combat rules: repeats, flurries, dodges, counters, rocked steps, knockdown causes
```
