# CODEPLUS — WhatsApp bot (`!` commands + no-prefix AI)

One bot, one WhatsApp login:

- **Normal text → AI reply.** No prefix needed.
- **`!` commands → controls** (`!help`, `!img`, `!improve`, `!spam`, `!autoreply`, `!ai`, etc.).

Built with Baileys (no browser/Chrome needed), multi-provider AI, and keyless image generation.

## 1. Local setup

```bash
npm install
cp .env.example .env
# put your free Gemini key in .env: GEMINI_API_KEY=...
npm start
```

Scan the QR with **WhatsApp → Linked Devices → Link a device**. It is printed in the terminal and also saved to `qr.txt` (`cat qr.txt`). The session is saved in `auth_info/`.

Run 24/7 with pm2:

```bash
sudo npm install -g pm2
pm2 start index.js --name codeplus
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $(whoami) --hp $HOME
```

## 2. How to chat

**In the owner's own chat, CODEPLUS is already on and all commands work.** In any friend's chat or group, send `!enable` once inside that chat to turn CODEPLUS on there. Until then that chat stays silent. Then just send a normal message:

```
hey, what can you do?
write a python function to reverse a string
```

CODEPLUS replies with AI and remembers the last 20 messages per chat. Send `!disable` inside a chat to pause only that chat; `!enable` there turns it back on.

### Commands

| Command | What it does |
|---|---|
| `!enable` | Enable CODEPLUS in THIS chat only (owner only) |
| `!disable` | Pause CODEPLUS in THIS chat only (owner only) |
| `!status` | Show this chat's switch status (owner only) |
| `!help` | Show all commands |
| `!ping` | Reply with pong |
| `!id` | Show the current chat ID |
| `!echo <text>` | Echo text back |
| `!time` | Show current date/time in IST (India) |
| `!img <prompt>` | Generate and send an image |
| `!improve <text>` | Rewrite text more clearly (no chat-memory pollution) |
| `!away [off\|message]` | Away auto-reply (owner only) |
| `!spam [status\|on\|off\|unblock]` | Spam control / temporary blocks (owner only) |
| `!autoreply [add\|remove\|list\|on\|off]` | Keyword auto-replies (owner only) |
| `!ai` | Show AI/image/spam status |
| `!aireset` | Clear AI memory for this chat |

While `!away` is ON, incoming private messages get the away reply instead of AI.

### Per-chat on/off switch

Every friend chat and group has its **own** switch. Only the owner can change it, by sending the command inside the target chat:

```
!enable    # enable CODEPLUS in this chat only
!status    # check this chat's state
!disable   # pause CODEPLUS in this chat only
```

- Your own number/chat (`+91 90738 46974`) is **on by default** and all commands always work there, even if you pause it.
- Friend chats and groups start **paused**. The bot sends nothing there — no AI, commands, away replies, auto-replies or spam warnings — until you send `!enable` in that chat.
- `!enable`, `!disable` and `!status` always work for the owner in any chat, even paused ones. Other people are ignored silently.
- State is stored per chat JID in `bot-state.json` (git-ignored) and survives restarts.

### Images

`!img <prompt>` tries Gemini image models first, then a keyless Pollinations fallback (no extra key needed). Your free Gemini key may have **zero image quota** — in that case the fallback handles it automatically. Pollinations' free tier allows about one image per 45 seconds, so CODEPLUS spaces requests and honors the server's retry delay; generation can take ~30 seconds.

### Keyword auto-replies

Owner-only examples:

```
!autoreply add price | Our plans start at ₹99
!autoreply add timing | We are open 9am–6pm
!autoreply list
!autoreply remove price
!autoreply off
```

Matching is case-insensitive substring matching. Rules are stored in `autoreply.json` (git-ignored) and checked before AI.

### Spam control

Enabled by default: more than 8 messages in 10 seconds from one sender gets them temporarily muted for 10 minutes and blocked on WhatsApp. Owner commands:

```
!spam status
!spam off      # disable protection
!spam on       # re-enable
!spam unblock <jid>
!spam unblock  # unblock everyone muted
```

Tune `spamWindowMs`, `spamMaxMessages`, `spamBlockDurationMs`, and `spamAutoBlock` in `config.js`. Owner numbers are always exempt.

## 3. Configuration

`config.js`:

- `ownerJids` — JIDs/LIDs allowed to use owner commands. Includes the official number and its WhatsApp LID alias.
- `aiModel` / `aiFallbackModels` — Gemini models (slow or overloaded models are aborted after 10s).
- `aiHistoryLength` — chat memory size.
- `aiReplyInGroups` — `true` answers in groups (current setting); set `false` for DMs only.
- `imageModels` / `imageFallbackUrl` / `imageTimeoutMs` — image generation chain.
- `spamEnabled` / `spamWindowMs` / `spamMaxMessages` / `spamBlockDurationMs` / `spamAutoBlock` — spam protection.
- `autoReplyFile` — where keyword auto-reply rules are saved (`autoreply.json`).
- `botStateFile` — where per-chat on/off states are saved (`bot-state.json`).
- `timeZone` — `Asia/Kolkata`; `!time` and AI date/time context use IST.
- `webSearchEnabled` / `webContextTimeoutMs` / `webCacheMs` / `webMaxChars` — fresh web context for replies.
- `systemPrompt` — CODEPLUS personality.

Group replies are routed to the group JID while per-sender identity drives owner checks, spam tracking and AI memory.

`.env`:

- `GEMINI_API_KEY` — required (or add one of the other providers below).
- `GEMINI_MODEL` — optional override.
- `PHONE_NUMBER` — digits only with country code, used for pairing (default `919073846974`).

### Multi-AI fallback

CODEPLUS tries providers in this order and uses the first one that answers:

1. **Gemini** — `GEMINI_API_KEY` (also tries 3 Gemini models in order)
2. **Groq** — `GROQ_API_KEY`, model from `GROQ_MODEL`
3. **OpenRouter** — `OPENROUTER_API_KEY`, model from `OPENROUTER_MODEL`
4. **OpenAI** — `OPENAI_API_KEY`, model from `OPENAI_MODEL`
5. **Pollinations** — keyless free fallback, always available

Add any keys you have to `.env` (or Render environment). If a provider is down, overloaded, or rate-limited, the next one answers automatically — including a keyless last resort. `!ai` shows which providers are enabled.

### Fresh information from the web

Before answering a normal message, CODEPLUS fetches a short, current context block from **Wikipedia** and **Google News** (India edition) and includes it in the AI prompt, along with the current IST date/time. This lets replies use recent information instead of only older training data. Lookups are cached for 10 minutes and fail silently, so a slow or blocked source never stops the bot. Disable with `webSearchEnabled: false` in `config.js`. `!ai` shows `Web lookup: on/off`.

## 4. Deploying to Render

This repo binds to `process.env.PORT` on `0.0.0.0`, so a Render **Web Service** passes the port check instead of failing with `Port scan timeout reached / Application exited early`.

1. Create a **Web Service** pointing at this repo (Node environment).
2. Start command: `npm start`.
3. Add environment variables in the Render dashboard (do **not** commit `.env`):
   ```
   GEMINI_API_KEY=your_key
   PHONE_NUMBER=919073846974
   # optional extra AI providers:
   # GROQ_API_KEY=...
   # OPENROUTER_API_KEY=...
   # OPENAI_API_KEY=...
   ```
4. Deploy. The QR is printed in the Render logs (and saved to `qr.txt` locally). On your phone: **WhatsApp → Linked Devices → Link a device → scan the QR**.

If you prefer a short 8-character code instead, set `USE_PAIRING_CODE=true` and look for `CODEPLUS pairing code: XXXXXXXX` in the logs.

### Important Render limitations

- **Free web services sleep after 15 minutes with no traffic** and take ~1 minute to wake. A pinger that keeps it awake consumes almost the entire 750-hour monthly quota.
- **Free services have no persistent disk.** Every sleep/redeploy deletes `auth_info/`, so you must pair again (a new QR appears in the logs).
- There is **no free background worker** on Render.
- Do not run a second copy paired to the same WhatsApp account — it will kick the other session into a reconnect loop.

For genuinely free 24/7 hosting with a persistent session, use an **Oracle Cloud Always Free ARM VM** (`VM.Standard.A1.Flex`, Ubuntu ARM64) and run the bot under pm2. See the local setup commands above.

## Notes

- The number is chosen by **which WhatsApp account you scan the QR with** — the bot cannot assign one.
- Keep `.env` and `auth_info/` private.
- Unofficial WhatsApp library: keep message volume reasonable.
