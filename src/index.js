import 'dotenv/config'
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import { handleMessage } from './agent.js'

// Entries can be a bare phone number (assumed @s.whatsapp.net) or a full JID
// (e.g. "158892331946229@lid" - WhatsApp's newer privacy ID format, which
// doesn't map back to a phone number).
const ALLOWED_JIDS = new Set(
  (process.env.ALLOWED_NUMBERS || '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => (n.includes('@') ? n : `${n}@s.whatsapp.net`))
)

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
  })

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
        const reply = await handleMessage(sender, text)
        await sock.sendMessage(sender, { text: reply })
      } catch (err) {
        console.error('Error handling message:', err)
        await sock.sendMessage(sender, { text: 'Sorry, something went wrong processing that.' })
      }
    }
  })
}

start()
