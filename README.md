# NFX WhatsApp Agent

A personal WhatsApp agent for a small team, powered by Claude, built on
**Twilio's official WhatsApp Business API**. Unlike unofficial WhatsApp Web
clients (QR-code linking, Baileys, etc.), this doesn't risk your number
getting silently throttled or banned - it's a real, sanctioned integration.

## How it's built

- Twilio hosts the actual WhatsApp connection. Incoming messages arrive at
  a webhook URL you configure; replies go out via Twilio's REST API.
- This app is a small Express server (`src/index.js`) that receives that
  webhook, runs the message through Claude (`src/agent.js`), and sends the
  reply back through Twilio.
- Everything else - the Claude conversation/tool-use loop, contacts,
  reminders, persistent memory - is unchanged from before; only the
  transport (how messages get in and out) is different.

## Setup

### 1. Install dependencies
```
npm install
```

### 2. Get Twilio WhatsApp access
The fastest way to test is Twilio's **WhatsApp Sandbox** - free, works in
minutes, no business verification needed:
1. Log into the [Twilio Console](https://console.twilio.com)
2. Go to **Messaging -> Try it out -> Send a WhatsApp message**
3. Note the sandbox number and your unique join code
4. Each teammate who should be able to use the agent sends `join <your-code>`
   to that sandbox number once from WhatsApp (this opts them in; sandbox
   sessions expire after a few days of inactivity and need re-joining)

(Later, if you want a real branded number instead of the shared sandbox one,
apply for a dedicated WhatsApp-enabled Twilio number - that requires WhatsApp
Business Profile approval, similar in spirit to Meta's own verification.)

### 3. Configure environment
```
cp .env.example .env
```
Fill in:
- `ANTHROPIC_API_KEY` - your Claude API key
- `ALLOWED_NUMBERS` - e.g. `Jonah:+15551234567,Sarah:+15559876543` (E.164
  format, i.e. `+` and country code, no spaces/dashes)
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` - from the Twilio Console
  homepage
- `TWILIO_WHATSAPP_NUMBER` - the sandbox number from step 2, e.g.
  `whatsapp:+14155238886`

### 4. Expose your webhook and run it

**For local testing**, your machine needs a public URL Twilio can reach.
Use [ngrok](https://ngrok.com):
```
npx ngrok http 3000
```
This prints a public URL like `https://abcd1234.ngrok-free.app`. In the
Twilio Console (**Messaging -> Try it out -> Send a WhatsApp message**),
set the sandbox's "When a message comes in" webhook to:
```
https://abcd1234.ngrok-free.app/webhook
```

Then start the agent:
```
npm start
```

### 5. Try it
From one of the allowlisted numbers (that has joined the sandbox), send a
WhatsApp message to the sandbox number. It should reply.

## How it works (code)

- `src/index.js` - Express webhook server: receives incoming WhatsApp
  messages from Twilio, checks the allowlist, forwards text to the agent,
  and sends the reply back via Twilio's REST API. Also runs the
  reminder-check timer.
- `src/agent.js` - the Claude conversation/tool-use loop, with conversation
  history persisted per sender to `histories.json` (trimmed by whole
  "turns" so a tool call is never split from its result).
- `src/tools.js` - example tools: `get_current_datetime`, `add_note` /
  `list_notes`, `schedule_reminder` (agent messages you proactively later),
  `list_contacts` / `send_message` (agent can message another *approved*
  contact by name on request - refuses anyone not on the allowlist). Add
  more tools here and update the `tools` array + `executeTool` switch.

## Deploying for always-on use

Running `npm start` + ngrok only lasts as long as your terminal does. For a
number people can actually rely on, deploy to a host with a stable public
URL - **Railway** is a good fit:

1. New Service in Railway -> **Deploy from GitHub repo** -> this repo,
   branch `claude/whatsapp-agent-capability-h54ivi`. Railway auto-detects
   Node and runs `npm start`.
2. Set environment variables in the Railway dashboard (same as `.env`
   above). Railway assigns `PORT` automatically.
3. Once deployed, Railway gives you a public URL
   (`https://your-app.up.railway.app`). Set your Twilio number's webhook to
   `https://your-app.up.railway.app/webhook`.
4. Turn on `TWILIO_VALIDATE_WEBHOOK=true` now that the URL is stable, so
   the webhook only accepts genuine Twilio requests.

No QR codes, no pairing, no session to keep alive - Twilio owns the
WhatsApp connection itself, so a redeploy or restart doesn't lose anything
except in-memory state (which already persists to disk - see below).

## Notes

- Group messages aren't a concept here (Twilio's WhatsApp API is
  one-to-one with your business number), so there's nothing to filter out.
- Conversation history, notes, and reminders persist to
  `histories.json` / `notes.json` / `reminders.json` (all gitignored) -
  they survive restarts but are local to whatever machine/host runs the
  process.
- Twilio's Sandbox has real limits for anything beyond testing (shared
  number, "join" opt-in required, a sandbox banner in the recipient's
  WhatsApp) - for real day-to-day team use, apply for your own WhatsApp
  Business number through Twilio when you're ready.
