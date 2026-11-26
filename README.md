# CODEPLUS — AI WhatsApp Bot

A separate AI chatbot that replies to every message with **no prefix needed**. Built with Baileys + Google Gemini. It has its own login folder, so it runs independently of your other bot.

## 1. Get a free Gemini API key
1. Go to https://aistudio.google.com/app/apikey
2. Create an API key
3. Copy `.env.example` to `.env` and paste the key:

```bash
cp .env.example .env
nano .env
```

```
GEMINI_API_KEY=your_key_here
```

## 2. Install and run

```bash
cd /home/dasguptabiswanath959/wa-ai-bot
npm install
npm start
```

Scan the QR with **WhatsApp → Linked Devices** using the number you want CODEPLUS to run on. The login is saved in `auth_info/`.

## 3. Chat
Just send any normal message — no `!` needed. CODEPLUS replies using AI and remembers the last 20 messages per chat.

### Owner-only prefix commands
| Command | What it does |
|---|---|
| `!help` | List commands |
| `!reset` | Clear this chat's memory |
| `!prompt <text>` | Change the system prompt/personality |
| `!status` | Show model and settings |

Add the owner's JID/LID to `OWNER_JIDS` in `.env` to restrict these.

## Configuration
Edit `config.js` to change:
- `botName` — currently **CODEPLUS**
- `systemPrompt` — personality/instructions
- `replyInGroups` — set `true` to reply in groups too (default: DMs only)
- `historyLength` — conversation memory size

## pm2 (24/7)
```bash
sudo npm install -g pm2
pm2 start index.js --name codeplus
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $(whoami) --hp $HOME
```

## Notes
- The number is chosen by **which WhatsApp account you scan the QR with** — I can't assign a number.
- Keep `.env` and `auth_info/` private — they contain your API key and WhatsApp login.
- Unofficial library: keep volume low to avoid bans.
