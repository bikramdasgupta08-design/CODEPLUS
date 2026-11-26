# CODEPLUS — WhatsApp bot (`!` commands + no-prefix AI)

One bot, one WhatsApp login:

- **Normal text → AI reply.** No prefix needed.
- **`!` commands → controls** (`!help`, `!away`, `!ai`, `!aireset`, etc.).

Built with Baileys (no browser/Chrome needed) and Google Gemini.

## 1. Local setup

```bash
npm install
cp .env.example .env
# put your free Gemini key in .env: GEMINI_API_KEY=...
npm start
```

Scan the QR with **WhatsApp → Linked Devices**. The session is saved in `auth_info/`.

Run 24/7 with pm2:

```bash
sudo npm install -g pm2
pm2 start index.js --name codeplus
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $(whoami) --hp $HOME
```

## 2. How to chat

Just send a normal message:

```
hey, what can you do?
write a python function to reverse a string
```

CODEPLUS replies with AI and remembers the last 20 messages per chat.

### Commands

| Command | What it does |
|---|---|
| `!help` | Show all commands |
| `!ping` | Reply with pong |
| `!id` | Show the current chat ID |
| `!echo <text>` | Echo text back |
| `!time` | Show date/time |
| `!away [off\|message]` | Away auto-reply (owner only) |
| `!ai` | Show AI model/status |
| `!aireset` | Clear AI memory for this chat |

While `!away` is ON, incoming private messages get the away reply instead of AI.

## 3. Configuration

`config.js`:

- `ownerJids` — JIDs/LIDs allowed to use owner commands. Includes the official number and its WhatsApp LID alias.
- `aiModel` / `aiFallbackModels` — Gemini models (slow or overloaded models are aborted after 10s).
- `aiHistoryLength` — chat memory size.
- `aiReplyInGroups` — set `true` to answer in groups (default: DMs only).
- `systemPrompt` — CODEPLUS personality.

`.env`:

- `GEMINI_API_KEY` — required.
- `GEMINI_MODEL` — optional override.
- `PHONE_NUMBER` — digits only with country code, used for pairing (default `919073846974`).

## 4. Deploying to Render

This repo binds to `process.env.PORT` on `0.0.0.0`, so a Render **Web Service** passes the port check instead of failing with `Port scan timeout reached / Application exited early`.

1. Create a **Web Service** pointing at this repo (Node environment).
2. Start command: `npm start`.
3. Add environment variables in the Render dashboard (do **not** commit `.env`):
   ```
   GEMINI_API_KEY=your_key
   PHONE_NUMBER=919073846974
   ```
4. Deploy. The logs will show a short line:
   ```
   CODEPLUS pairing code: XXXXXXXX
   ```
5. On your phone: **WhatsApp → Linked Devices → Link with phone number → enter that code**.

No QR is printed on Render, so the logs stay small.

### Important Render limitations

- **Free web services sleep after 15 minutes with no traffic** and take ~1 minute to wake. A pinger that keeps it awake consumes almost the entire 750-hour monthly quota.
- **Free services have no persistent disk.** Every sleep/redeploy deletes `auth_info/`, so you must pair again (a new code appears in the logs).
- There is **no free background worker** on Render.
- Do not run a second copy paired to the same WhatsApp account — it will kick the other session into a reconnect loop.

For genuinely free 24/7 hosting with a persistent session, use an **Oracle Cloud Always Free ARM VM** (`VM.Standard.A1.Flex`, Ubuntu ARM64) and run the bot under pm2. See the local setup commands above.

## Notes

- The number is chosen by **which WhatsApp account you scan the QR with** — the bot cannot assign one.
- Keep `.env` and `auth_info/` private.
- Unofficial WhatsApp library: keep message volume reasonable.
