import 'dotenv/config'
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import { handleMessage } from './agent.js'
import { popDueReminders } from './tools.js'

// Each entry is either a bare number/JID ("972501234567" or
// "158892331946229@lid" - WhatsApp's newer privacy ID format that doesn't
// map back to a phone number), or "Name:number" to also make that contact
// addressable by name via the send_message tool.
const ALLOWED_ENTRIES = (process.env.ALLOWED_NUMBERS || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const separatorIndex = entry.indexOf(':')
    const name = separatorIndex === -1 ? null : entry.slice(0, separatorIndex).trim()
    const raw = separatorIndex === -1 ? entry : entry.slice(separatorIndex + 1).trim()
    const jid = raw.includes('@') ? raw : `${raw}@s.whatsapp.net`
    return { name, jid }
  })

const ALLOWED_JIDS = new Set(ALLOWED_ENTRIES.map((e) => e.jid))

// The same person can appear under the same name with two JIDs (their real
// phone-based JID and a "@lid" privacy ID WhatsApp sometimes uses instead).
// Incoming messages can arrive tagged with either, but replying TO a @lid
// isn't reliably delivered - only receiving FROM one is. So for both
// send_message and replying to whoever just messaged, always prefer a
// phone-based JID for that name when one is listed.
const NAME_BY_JID = new Map(ALLOWED_ENTRIES.filter((e) => e.name).map((e) => [e.jid, e.name.toLowerCase()]))
const CONTACTS = new Map()
for (const e of ALLOWED_ENTRIES) {
  if (!e.name) continue
  const key = e.name.toLowerCase()
  const existing = CONTACTS.get(key)
  const isPhoneBased = e.jid.endsWith('@s.whatsapp.net')
  if (!existing || (isPhoneBased && !existing.endsWith('@s.whatsapp.net'))) {
    CONTACTS.set(key, e.jid)
  }
}

function resolveReplyJid(jid) {
  const name = NAME_BY_JID.get(jid)
  if (!name) return jid
  return CONTACTS.get(name) || jid
}

// Tracks the live socket so the reminder loop below can send proactive
// messages independent of any incoming message (and picks up the new socket
// automatically after a reconnect).
let currentSock = null

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
  })
  currentSock = sock

  // On a host with no camera-friendly QR display (e.g. reading logs in a
  // cloud dashboard), pair by code instead: set PAIRING_PHONE_NUMBER to the
  // WhatsApp number that will run the agent, then in WhatsApp go to
  // Settings -> Linked Devices -> Link a Device -> "Link with phone number
  // instead" and type the code printed below.
  if (!state.creds.registered && process.env.PAIRING_PHONE_NUMBER) {
    const code = await sock.requestPairingCode(process.env.PAIRING_PHONE_NUMBER)
    console.log(`Pairing code: ${code}`)
  }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr && !process.env.PAIRING_PHONE_NUMBER) {
      console.log('Scan this QR code with the WhatsApp account that will run the agent:')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log('Connection closed.', lastDisconnect?.error?.message, '- reconnecting:', shouldReconnect)
      if (shouldReconnect) {
        start()
      } else {
        // Truly logged out - a new QR/pairing is needed, which requires a
        // fresh process (the reminder timer below would otherwise keep this
        // one alive indefinitely with a dead connection and no way to
        // reconnect). Exiting lets a process manager (pm2/systemd) restart
        // it cleanly, or hands control back to your terminal.
        console.log('Logged out - exiting so this can be restarted and re-paired.')
        process.exit(1)
      }
    } else if (connection === 'open') {
      console.log('Connected to WhatsApp. Agent is live.')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (msg.key.fromMe) continue

      const sender = msg.key.remoteJid
      if (!sender || sender.endsWith('@g.us')) continue // ignore group chats

      if (ALLOWED_JIDS.size > 0 && !ALLOWED_JIDS.has(sender)) {
        console.log(`Ignoring message from non-allowlisted number: ${sender}`)
        continue
      }

      // Disappearing messages (and a couple of other wrappers) nest the
      // actual content one level deeper instead of at the top level.
      const inner =
        msg.message?.ephemeralMessage?.message ||
        msg.message?.viewOnceMessage?.message ||
        msg.message?.viewOnceMessageV2?.message ||
        msg.message
      const text = inner?.conversation || inner?.extendedTextMessage?.text || ''
      if (!text) {
        console.log('No plain text found in message, keys:', msg.message ? Object.keys(msg.message) : msg.message)
        continue
      }

      const replyJid = resolveReplyJid(sender)

      try {
        await sock.sendPresenceUpdate('composing', replyJid)
        console.log('[trace] presence sent, calling handleMessage for', sender, '(replying to', replyJid + ')')
        const context = {
          jid: sender,
          contacts: CONTACTS,
          sendMessage: async (toJid, messageText) => {
            await sock.sendMessage(toJid, { text: messageText })
          },
        }
        const reply = await handleMessage(sender, text, context)
        console.log('[trace] handleMessage returned:', reply)
        await sock.sendMessage(replyJid, { text: reply })
        console.log('[trace] reply sent successfully')
      } catch (err) {
        console.error('Error handling message:', err)
        await sock.sendMessage(replyJid, { text: 'Sorry, something went wrong processing that.' })
      }
    }
  })
}

// Checks for due reminders on a timer, independent of incoming messages, so
// the agent can message people proactively rather than only reacting.
setInterval(async () => {
  if (!currentSock) return
  try {
    const due = await popDueReminders()
    for (const reminder of due) {
      await currentSock.sendMessage(resolveReplyJid(reminder.jid), { text: reminder.message })
    }
  } catch (err) {
    console.error('Error sending due reminders:', err)
  }
}, 30_000)

start()
