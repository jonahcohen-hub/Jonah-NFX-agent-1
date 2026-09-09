import fs from 'fs/promises'
import path from 'path'

const NOTES_FILE = path.join(process.cwd(), 'notes.json')

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
    default:
      return `Unknown tool: ${name}`
  }
}
