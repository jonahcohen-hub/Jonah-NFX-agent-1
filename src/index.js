import 'dotenv/config'
import express from 'express'
import twilio from 'twilio'
import { handleMessage } from './agent.js'
import { popDueReminders } from './tools.js'

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_NUMBER, // e.g. "whatsapp:+14155238886" (the sandbox number, or your own once approved)
  ALLOWED_NUMBERS,
  PORT = 3000,
} = process.env

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_NUMBER) {
  console.error(
    'Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_WHATSAPP_NUMBER in .env - see .env.example.'
  )
  process.exit(1)
}

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)

// Each entry is either a bare phone number in E.164 format ("+972501234567")
// or "Name:+972501234567" to also make that contact addressable by name via
// the send_message tool. Twilio always reports the sender's real phone
// number (no WhatsApp privacy-ID quirks like Baileys' "@lid").
const ALLOWED_ENTRIES = (ALLOWED_NUMBERS || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const separatorIndex = entry.indexOf(':')
    const name = separatorIndex === -1 ? null : entry.slice(0, separatorIndex).trim()
    const number = separatorIndex === -1 ? entry : entry.slice(separatorIndex + 1).trim()
    return { name, number }
  })

const ALLOWED_NUMBERS_SET = new Set(ALLOWED_ENTRIES.map((e) => e.number))
const CONTACTS = new Map(ALLOWED_ENTRIES.filter((e) => e.name).map((e) => [e.name.toLowerCase(), e.number]))

async function sendWhatsApp(toNumber, body) {
  await client.messages.create({
    from: TWILIO_WHATSAPP_NUMBER,
    to: `whatsapp:${toNumber}`,
    body,
  })
}

const app = express()
app.use(express.urlencoded({ extended: false }))

// Twilio signs webhook requests; validating confirms they really came from
// Twilio. Off by default to avoid signature/host mismatches while testing
// through ngrok - turn on (TWILIO_VALIDATE_WEBHOOK=true) once you're running
// somewhere with a stable public URL (e.g. Railway).
const validateWebhook = (process.env.TWILIO_VALIDATE_WEBHOOK || 'false').toLowerCase() === 'true'
const webhookMiddleware = validateWebhook ? twilio.webhook({ validate: true }) : (_req, _res, next) => next()

app.post('/webhook', webhookMiddleware, (req, res) => {
  // Ack immediately with empty TwiML so Twilio doesn't retry/time out while
  // we go call Claude - the actual reply is sent separately via the REST API.
  res.type('text/xml').send('<Response></Response>')

  const from = (req.body.From || '').replace('whatsapp:', '')
  const text = req.body.Body || ''
  if (!from || !text) return

  if (ALLOWED_NUMBERS_SET.size > 0 && !ALLOWED_NUMBERS_SET.has(from)) {
    console.log(`Ignoring message from non-allowlisted number: ${from}`)
    return
  }

  const context = {
    jid: from,
    contacts: CONTACTS,
    sendMessage: sendWhatsApp,
  }

  handleMessage(from, text, context)
    .then((reply) => sendWhatsApp(from, reply))
    .catch(async (err) => {
      console.error('Error handling message:', err)
      await sendWhatsApp(from, 'Sorry, something went wrong processing that.').catch((e) =>
        console.error('Also failed to send the error fallback message:', e)
      )
    })
})

app.get('/', (_req, res) => res.send('NFX WhatsApp agent is running.'))

app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}.`)
  console.log('Set your public URL + "/webhook" as the Twilio WhatsApp sandbox/number webhook.')
})

// Checks for due reminders on a timer, independent of incoming messages, so
// the agent can message people proactively rather than only reacting.
setInterval(async () => {
  try {
    const due = await popDueReminders()
    for (const reminder of due) {
      await sendWhatsApp(reminder.jid, reminder.message)
    }
  } catch (err) {
    console.error('Error sending due reminders:', err)
  }
}, 30_000)
