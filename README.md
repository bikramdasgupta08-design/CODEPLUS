# CODEPLUS — WhatsApp bot (`!` / `/` commands + no-prefix AI)

One bot, one WhatsApp login:

- **Normal text → AI reply.** No prefix needed.
- **`!` or `/` commands → controls** (`!help`, `/help`, `!img`, `/img`, `!spam`, `/spam`, etc.).
- **`/` opens a tap-to-select command window** in WhatsApp.

Built with Baileys (no browser/Chrome needed), multi-provider AI, and keyless image generation.

## 1. Local setup (only for creating a session backup)

```bash
npm install
cp .env.example .env
# put your free Gemini key in .env: GEMINI_API_KEY=...
FORCE_QR=true npm start
```

Scan the QR with **WhatsApp → Linked Devices → Link a device** only when you intentionally need to create/replace the session file. It is printed in the terminal and saved to `qr.txt` (`cat qr.txt`). The session is saved in `auth_info/`. The current deployment does **not** run this locally; Render restores the saved session from a Secret File.

`npm install` now includes `sharp`, `pdf-lib` and `libphonenumber-js` for image conversion and number parsing. For higher-quality AI background removal, an optional local Python environment can be created (never committed):

```bash
python3 -m venv .venv-rembg
.venv-rembg/bin/pip install 'rembg[cpu]' onnxruntime
```

Without it, background removal still works using the built-in offline method.

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
| `!help` | Show the full text list |
| `/` or `/help` | Open the tap-to-select command window |
| `!menu` | Open the same command window |
| `!ping` / `/ping` | Reply with pong |
| `!id` | Show the current chat ID |
| `!echo <text>` | Echo text back |
| `!time` | Show current date/time in IST (India) |
| `!img <prompt>` | Generate and send an image |
| `!improve <text>` | Rewrite text more clearly (no chat-memory pollution) |
| `!summarize [count]` | Summarize recent chat messages |
| `!translate <language> <text>` | Translate text |
| `!pdf` / `!png` / `!nobg` | Convert a sent image to PDF / PNG / background-removed PNG |
| `!describe [question]` | AI description of a sent image (Gemini vision) |
| `!caption` | AI-written caption for a sent image |
| `!callerid [on\|off\|status\|lookup\|save\|remove]` | Caller ID mode (owner only) |
| `!safe [on\|off\|check <text>]` | Safe-chat scam checks (owner only) |
| `!guard [on\|off\|snapshot\|antiprune\|antinuke]` | Group anti-prune / anti-nuke (owner only) |
| `!away [off\|message]` | Away auto-reply (owner only) |
| `!spam [status\|on\|off\|unblock]` | Spam control / temporary blocks (owner only) |
| `!autoreply [add\|remove\|list\|on\|off]` | Keyword auto-replies (owner only) |
| `!ai` | Show AI/image/spam status |
| `!aireset` | Clear AI memory for this chat |

Every command accepts either `!` or `/`. Sending only `/` (or `/help`) makes CODEPLUS reply with a WhatsApp single-select list: tap a command and it runs instantly. This is a bot-provided picker; the unofficial WhatsApp API cannot modify WhatsApp's own keyboard suggestion bar. The picker is instant because it does not call AI or the web.

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

#### Working with images you send

Send an image and use the command as its caption, or reply to an image with the command:

```
!pdf        # image -> A4 PDF document
!png        # image -> PNG
!nobg       # remove background -> transparent PNG
!describe   # AI describes what is actually in the image
!caption    # AI writes a short caption + hashtags
!describe What text is written in this image?
```

Natural captions work too — just send an image captioned `make pdf`, `make png`, `remove background`, `caption` or `describe`.

Background removal uses AI cutout (`rembg`) when the optional Python environment `.venv-rembg` exists; otherwise it falls back to a keyless, offline border flood-fill that works well on solid-colour backgrounds (ID photos, product shots, screenshots). The AI environment is **not** committed or installed on Render; the offline fallback keeps that deployment working.

Image understanding uses Gemini vision on the same quality-ordered model chain as text (verified with `gemini-4-hydrogen`).

### Caller ID mode

Owner-only, from your own chat:

```
!callerid on                       # enable number lookups + call alerts
!callerid lookup 919073846974      # formatted number report
!callerid save 919073846974 | Ramesh | safe | known friend
!callerid save 9012345678 | Fraud call | scam | asking for OTP
!callerid remove 919073846974
!callerid status
```

With the mode ON:

- Sending a bare phone number in an enabled chat returns country, number type, validity, your saved label and any public reports found on the web.
- Incoming WhatsApp voice/video calls send an alert to your own chat with the number and saved label (Baileys exposes call events). Repeated alerts for the same number are throttled to one per 5 minutes.
- Public caller-ID databases are not reliably scrapable without paid APIs, so CODEPLUS is honest about that: it uses your own saved labels plus public news pages, and warns you not to trust caller ID alone for OTPs or payments.
- Set `CALLERID_LOOKUP_ON_CALL=true` in `.env` to also run a web lookup for each call alert.

State is saved in `callerid.json` (git-ignored).

### Safe chatting

Owner-only, per chat:

```
!safe on                  # scan incoming messages and guard AI replies here
!safe off
!safe check <text>        # scan a message/link for scam patterns
```

When ON, CODEPLUS:

- flags OTP/password requests, UPI/payment demands, suspicious short links, fake job/investment offers and threats,
- prepends a short scam warning before the AI answer when something looks risky,
- adds safety rules to the AI prompt so it refuses harmful requests and never asks for your OTP or credentials.

Detection is heuristic plus AI reasoning — useful, but not a guarantee. Verify independently.

### Group protection: anti-prune and anti-nuke

Owner-only. Use inside a group (or append a group JID from your own chat):

```
!guard on                 # enable both protections + save a safety snapshot
!guard snapshot           # refresh the saved subject/description/invite/members
!guard antiprune on       # restore members after a mass removal (needs admin)
!guard antinuke on        # detect and restore settings changes, recover deleted messages
!guard status             # show state and last incidents
!guard off
```

What it can actually do under Baileys:

- **Anti-prune:** if 2+ members are removed at once and the bot is admin, it re-adds them and reports the incident. Single removals are logged, not fought (so legitimate moderation still works).
- **Anti-nuke:** saves group subject, description, invite link and member list. If the subject/description changes, it restores them when admin and alerts the group + owner. If the bot itself is removed, it tries to rejoin using the saved invite link and alerts you otherwise.
- **Deleted messages:** recent group messages are kept in memory only; if one is deleted, the bot posts the original text with a warning (enabled by anti-nuke).

What it cannot do: stop WhatsApp admins from deleting the group, prevent account bans, or re-add members without admin rights. State is in `groupguard.json` (git-ignored).

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
- `aiModel` / `aiFallbackModels` — quality-ordered model chain (starts with Gemini 4 Hydrogen, then Gemini 3.x Pro/Flash variants). Rate-limited models are skipped automatically.
- `aiHistoryLength` — chat memory size.
- `aiReplyInGroups` — `true` answers in groups (current setting); set `false` for DMs only.
- `imageModels` / `imageFallbackUrl` / `imageTimeoutMs` — image generation chain.
- `spamEnabled` / `spamWindowMs` / `spamMaxMessages` / `spamBlockDurationMs` / `spamAutoBlock` — spam protection.
- `autoReplyFile` — where keyword auto-reply rules are saved (`autoreply.json`).
- `botStateFile` — where per-chat on/off states are saved (`bot-state.json`).
- `antiPruneThreshold` — number of simultaneous removals that triggers member restoration (default 2).
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

1. **Gemini** — `GEMINI_API_KEY`, starting with the strongest available model (**Gemini 4 Hydrogen**), then Gemini 3.8/3.7/3.6/3.5 Flash, Gemini 3.1 Pro, etc.
2. **Groq** — `GROQ_API_KEY`, model from `GROQ_MODEL`
3. **OpenRouter** — `OPENROUTER_API_KEY`, model from `OPENROUTER_MODEL`
4. **OpenAI** — `OPENAI_API_KEY`, model from `OPENAI_MODEL`
5. **Pollinations** — keyless free fallback, always available

Add any keys you have to `.env` (or Render environment). If a model/provider is down, overloaded, or rate-limited, the next one answers automatically. The keyless fallback also respects Pollinations' short rate limit and retries. `!ai` shows which providers are enabled and the full model order.

Accuracy improvements: the system prompt now asks the model to think carefully, give complete practical answers, prefer fresh web data, and admit uncertainty instead of guessing. The reasoning test (bat-and-ball problem) is answered correctly.

### Fresh information from the web

Before answering a normal message, CODEPLUS fetches a short, current context block from **Wikipedia** and **Google News** (India edition) and includes it in the AI prompt, along with the current IST date/time. This lets replies use recent information instead of only older training data. Lookups are cached for 10 minutes and fail silently, so a slow or blocked source never stops the bot. Disable with `webSearchEnabled: false` in `config.js`. `!ai` shows `Web lookup: on/off`.

## 4. Deploying to Render (recommended: Render-only, no QR)

This repo binds to `process.env.PORT` on `0.0.0.0`, so a Render **Web Service** passes the port check instead of failing with `Port scan timeout reached / Application exited early`.

1. Create **one** Web Service pointing at this repo (Node environment). Start command: `npm start`.
2. Add environment variables in the Render dashboard (do **not** commit `.env`):
   ```
   GEMINI_API_KEY=your_key
   PHONE_NUMBER=919073846974
   # optional extra AI providers:
   # GROQ_API_KEY=...
   # OPENROUTER_API_KEY=...
   # OPENAI_API_KEY=...
   ```
3. Upload the WhatsApp session as a **Render Secret File** named `wa-creds.json`. It is mounted at `/etc/secrets/wa-creds.json` and restored into `auth_info/creds.json` on every boot/redeploy. Keep this file private; it is the logged-in device credential. To refresh it after a deliberate manual re-link, copy `auth_info/creds.json` to `wa-creds.json` and re-upload.
4. **Turn off auto-deploy** for this service. A GitHub push is code-only; a redeploy should be manual so the paired WhatsApp device is not disturbed unnecessarily.
5. Add a UptimeRobot HTTP monitor that pings the public Render URL every **5 minutes**. Expected response: HTTP 200 with `CODEPLUS is running`.
6. Stop every other bot copy. Only **one** linked session may be active; running local and Render together logs one of them out.

QR generation is disabled by default. On a normal boot the logs should show only:

```
Bot is ready as Bikram Dasgupta
```

If the Secret File is missing or rejected, the service stays online, prints one clear warning, and silently retries every 30 seconds when the file changes — it never prints a QR and never shuts itself off. For a deliberate manual re-link only, set `FORCE_QR=true` (or `USE_PAIRING_CODE=true` for a code) and remove it immediately after linking.

### Important Render limitations

- **Free web services sleep after 15 minutes with no traffic** and take ~1 minute to wake. An UptimeRobot ping every 5 minutes keeps the service warm, but it still consumes most of the 750-hour monthly quota.
- **Free services have no persistent disk.** The Secret File is what survives deploys and avoids a new QR.
- There is **no free background worker** on Render.
- Do not run a second copy paired to the same WhatsApp account — it will kick the other session into a reconnect loop.

If you deliberately move away from Render, an Oracle Cloud Always Free ARM VM with pm2 is another full-persistence option, but it is not needed for the current Render-only setup.

## Notes

- The number is chosen by **which WhatsApp account you scan the QR with** — the bot cannot assign one.
- Keep `.env` and `auth_info/` private.
- Unofficial WhatsApp library: keep message volume reasonable.
