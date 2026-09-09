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
  `list_notes`) showing the pattern for giving the agent real capabilities.
  Add more tools here (calendar, internal APIs, search, etc.) and update the
  `tools` array + `executeTool` switch.

## Notes

- Group chats are ignored by default (see the `@g.us` check in
  `src/index.js`) — remove that check if you want it to also respond in a
  group.
- History is kept in memory per process; restarting the agent clears
  conversation context (but not saved notes, which persist in
  `notes.json`).
- For always-on use, run this on a small always-on host (a spare machine,
  a cheap VPS, etc.) rather than a laptop that sleeps.
