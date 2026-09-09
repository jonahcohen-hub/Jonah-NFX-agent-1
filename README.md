# NFX WhatsApp Agent

A personal WhatsApp agent for a small team, powered by Claude. It connects to
WhatsApp the same way "WhatsApp Web / Linked Devices" does (via
[Baileys](https://github.com/WhiskeySockets/Baileys)) — no Meta Business API
approval needed. You pair it with a QR code and it runs as a linked device
on a WhatsApp account.

**Read this first:** this uses an unofficial protocol client, which is
against WhatsApp's Terms of Service. It's fine for low-volume personal/team
use, but avoid bot-like behavior (instant replies to everyone, high volume)
and don't be surprised if the number occasionally needs re-pairing after a
WhatsApp update. Use a spare number/SIM or a secondary WhatsApp Business app
install if you don't want to risk your personal number.

## Setup

1. **Install dependencies**
   ```
   npm install
   ```

2. **Configure environment**
   ```
   cp .env.example .env
   ```
   Fill in:
   - `ANTHROPIC_API_KEY` — your Claude API key.
   - `ALLOWED_NUMBERS` — comma-separated phone numbers (country code, digits
     only, e.g. `15551234567`) for the 3-4 team members allowed to use the
     agent. Anyone else who messages the number is ignored.

3. **Run it**
   ```
   npm start
   ```
   A QR code prints in the terminal. On the phone/number you want the agent
   to live on, open WhatsApp → Settings → Linked Devices → Link a Device,
   and scan it. Once connected, the terminal prints "Agent is live."

   Session credentials are saved to `auth_info/` so you don't need to
   re-scan on every restart (unless the device gets unlinked).

4. **Try it** — from one of the allowlisted numbers, message the WhatsApp
   number running the agent. It should reply.

## How it works

- `src/index.js` — connects to WhatsApp via Baileys, filters incoming
  messages to the allowlist, and forwards message text to the agent.
- `src/agent.js` — runs the Claude conversation/tool-use loop, keeping a
  short rolling history per sender.
- `src/tools.js` — example tools (`get_current_datetime`, `add_note`,
  `list_notes`, `schedule_reminder`) showing the pattern for giving the agent
  real capabilities. Add more tools here (calendar, internal APIs, search,
  etc.) and update the `tools` array + `executeTool` switch.
- `schedule_reminder` lets the agent message *you* proactively (e.g. "remind
  me in 20 minutes to call X"), not just reply to incoming messages. A timer
  in `src/index.js` checks every 30 seconds for due reminders and sends them
  through the live WhatsApp connection.

## Deploying for always-on use

Running `npm start` in a terminal only lasts as long as that terminal does.
For a WhatsApp number people can actually rely on, run it under a process
manager on a host that stays on (a small VPS, or a spare always-on machine).

### Option A: pm2 (simplest)

```
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # then run the command it prints, once, to enable boot startup
```

Useful commands: `pm2 logs nfx-whatsapp-agent` (see output / scan the QR code
on first run), `pm2 restart nfx-whatsapp-agent`, `pm2 stop nfx-whatsapp-agent`.

### Option B: systemd

A template unit file is at `deploy/nfx-whatsapp-agent.service`. Copy it,
fill in your user and the repo's absolute path, then:

```
sudo cp deploy/nfx-whatsapp-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nfx-whatsapp-agent
journalctl -u nfx-whatsapp-agent -f   # see output / scan the QR code on first run
```

Either way, you only need to scan the QR code once — after that the
`auth_info/` directory keeps the session alive across restarts (unless the
linked device gets logged out from the phone side).

### Option C: Railway

Railway logs are plain text, so scanning an ASCII-art QR code from the
dashboard is unreliable. Pair by code instead:

1. New Service in Railway → **Deploy from GitHub repo** → this repo, branch
   `claude/whatsapp-agent-capability-h54ivi`. Railway auto-detects Node and
   runs `npm start`.
2. Set environment variables in the Railway dashboard:
   - `ANTHROPIC_API_KEY`
   - `ALLOWED_NUMBERS`
   - `PAIRING_PHONE_NUMBER` — the WhatsApp number that will run the agent
     (country code, no `+`), used only for first-time pairing.
3. **Add a Volume** mounted at `/app/auth_info` (Settings → Volumes). Without
   this, every redeploy wipes the paired session and you'd have to re-pair
   from scratch.
4. Deploy, then open the deploy logs — a pairing code prints (e.g.
   `ABCD-1234`). On the phone with that WhatsApp number: **Settings → Linked
   Devices → Link a Device → Link with phone number instead**, and type the
   code.
5. Once paired, you can remove `PAIRING_PHONE_NUMBER` from the env vars —
   it's only read when no session exists yet.

No exposed port or domain is needed — this runs as a background worker, not
a web service.

## Notes

- Group chats are ignored by default (see the `@g.us` check in
  `src/index.js`) — remove that check if you want it to also respond in a
  group.
- History is kept in memory per process; restarting the agent clears
  conversation context (but not saved notes, which persist in
  `notes.json`).
