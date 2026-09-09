import fs from 'fs/promises'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { tools, executeTool } from './tools.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'
const MAX_TURNS = 10
const HISTORY_FILE = path.join(process.cwd(), 'histories.json')

const SYSTEM_PROMPT = `You are a helpful assistant for the NFX team, reachable over WhatsApp.
Keep replies short and conversational, suitable for a chat message rather than a long document.
Use the available tools when a request calls for looking something up or taking an action.
You can message other approved contacts on request using send_message (see list_contacts for who's
available) - only ever send to people from that approved list, never anywhere else.`

// Stored per sender as a list of "turns" rather than a flat message list.
// Each turn is one complete exchange: the user's message, any tool_use /
// tool_result pairs in between, and the final assistant reply. Trimming
// drops whole turns from the front, which guarantees a tool_use block is
// never separated from its tool_result - Claude's API rejects a history
// where those are split apart.
let turnsByJid = new Map()
let historiesLoaded = false

async function loadHistories() {
  if (historiesLoaded) return
  historiesLoaded = true
  try {
    const raw = await fs.readFile(HISTORY_FILE, 'utf8')
    turnsByJid = new Map(Object.entries(JSON.parse(raw)))
  } catch {
    turnsByJid = new Map()
  }
}

async function saveHistories() {
  await fs.writeFile(HISTORY_FILE, JSON.stringify(Object.fromEntries(turnsByJid), null, 2))
}

function getTurns(jid) {
  if (!turnsByJid.has(jid)) turnsByJid.set(jid, [])
  return turnsByJid.get(jid)
}

export async function handleMessage(jid, text, context) {
  console.log('[trace] handleMessage: loading histories')
  await loadHistories()
  console.log('[trace] handleMessage: histories loaded')

  const turns = getTurns(jid)
  const priorMessages = turns.flat()
  const currentTurn = [{ role: 'user', content: text }]

  console.log('[trace] handleMessage: calling anthropic, prior message count:', priorMessages.length)
  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools,
    messages: [...priorMessages, ...currentTurn],
  })
  console.log('[trace] handleMessage: anthropic responded, stop_reason:', response.stop_reason)

  while (response.stop_reason === 'tool_use') {
    currentTurn.push({ role: 'assistant', content: response.content })

    const toolResults = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      console.log('[trace] handleMessage: executing tool', block.name)
      const result = await executeTool(block.name, block.input, context)
      console.log('[trace] handleMessage: tool result', result)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      })
    }
    currentTurn.push({ role: 'user', content: toolResults })

    console.log('[trace] handleMessage: calling anthropic again after tool use')
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages: [...priorMessages, ...currentTurn],
    })
    console.log('[trace] handleMessage: anthropic responded, stop_reason:', response.stop_reason)
  }

  currentTurn.push({ role: 'assistant', content: response.content })

  turns.push(currentTurn)
  while (turns.length > MAX_TURNS) turns.shift()

  console.log('[trace] handleMessage: saving histories')
  await saveHistories()
  console.log('[trace] handleMessage: histories saved')

  const replyText = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()

  return replyText || "I'm not sure how to respond to that."
}
