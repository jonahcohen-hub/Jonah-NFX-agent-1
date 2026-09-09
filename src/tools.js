import fs from 'fs/promises'
import path from 'path'

const NOTES_FILE = path.join(process.cwd(), 'notes.json')
const REMINDERS_FILE = path.join(process.cwd(), 'reminders.json')

async function readNotes() {
  try {
    const raw = await fs.readFile(NOTES_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return []
  }
}

async function writeNotes(notes) {
  await fs.writeFile(NOTES_FILE, JSON.stringify(notes, null, 2))
}

async function readReminders() {
  try {
    const raw = await fs.readFile(REMINDERS_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return []
  }
}

async function writeReminders(reminders) {
  await fs.writeFile(REMINDERS_FILE, JSON.stringify(reminders, null, 2))
}

// Called on a timer from index.js (which owns the live WhatsApp socket) to
// find reminders whose time has come. Marks them sent so they only fire once.
export async function popDueReminders() {
  const reminders = await readReminders()
  const now = Date.now()
  const due = reminders.filter((r) => !r.sent && r.dueAt <= now)
  if (due.length === 0) return []
  const updated = reminders.map((r) => (due.includes(r) ? { ...r, sent: true } : r))
  await writeReminders(updated)
  return due
}

// Example tools to demonstrate the pattern. Add more here (calendar, search,
// internal APIs, etc.) and Claude will pick them up automatically.
export const tools = [
  {
    name: 'get_current_datetime',
    description: 'Get the current date and time.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'add_note',
    description: 'Save a shared note or reminder that any team member can later retrieve.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The note content to save.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'list_notes',
    description: 'List all previously saved shared notes/reminders.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'schedule_reminder',
    description:
      "Schedule a WhatsApp message to be sent back to this same chat at a future time (e.g. 'remind me in 20 minutes' or 'follow up with me tomorrow'). The agent will proactively send the message itself when the time comes, without the user needing to message first.",
    input_schema: {
      type: 'object',
      properties: {
        minutes_from_now: {
          type: 'number',
          description: 'How many minutes from now to send the reminder.',
        },
        message: { type: 'string', description: 'The reminder text to send at that time.' },
      },
      required: ['minutes_from_now', 'message'],
    },
  },
]

export async function executeTool(name, input, jid) {
  switch (name) {
    case 'get_current_datetime':
      return new Date().toString()
    case 'add_note': {
      const notes = await readNotes()
      notes.push({ text: input.text, from: jid, at: new Date().toISOString() })
      await writeNotes(notes)
      return 'Note saved.'
    }
    case 'list_notes': {
      const notes = await readNotes()
      if (notes.length === 0) return 'No notes saved yet.'
      return notes.map((n, i) => `${i + 1}. ${n.text}`).join('\n')
    }
    case 'schedule_reminder': {
      const minutes = Math.max(1, Number(input.minutes_from_now) || 1)
      const dueAt = Date.now() + minutes * 60000
      const reminders = await readReminders()
      reminders.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        jid,
        message: input.message,
        dueAt,
        sent: false,
      })
      await writeReminders(reminders)
      return `Reminder scheduled for ${new Date(dueAt).toLocaleString()}.`
    }
    default:
      return `Unknown tool: ${name}`
  }
}
