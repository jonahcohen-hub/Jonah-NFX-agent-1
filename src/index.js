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
const CONTACTS = new Map(ALLOWED_ENTRIES.filter((e) => e.name).map((e) => [e.name.toLowerCase(), e.jid]))

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
      if (shouldReconnect) start()
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

      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
      if (!text) continue

      try {
        await sock.sendPresenceUpdate('composing', sender)
        const context = {
          jid: sender,
          contacts: CONTACTS,
          sendMessage: async (toJid, messageText) => {
            await sock.sendMessage(toJid, { text: messageText })
          },
        }
        const reply = await handleMessage(sender, text, context)
        await sock.sendMessage(sender, { text: reply })
      } catch (err) {
        console.error('Error handling message:', err)
        await sock.sendMessage(sender, { text: 'Sorry, something went wrong processing that.' })
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
      await currentSock.sendMessage(reminder.jid, { text: reminder.message })
    }
  } catch (err) {
    console.error('Error sending due reminders:', err)
  }
}, 30_000)

start()
