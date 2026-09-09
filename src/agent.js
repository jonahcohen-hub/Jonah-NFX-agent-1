import Anthropic from '@anthropic-ai/sdk'
import { tools, executeTool } from './tools.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'
const MAX_HISTORY_MESSAGES = 20

const SYSTEM_PROMPT = `You are a helpful assistant for the NFX team, reachable over WhatsApp.
Keep replies short and conversational, suitable for a chat message rather than a long document.
Use the available tools when a request calls for looking something up or taking an action.`

const histories = new Map()

function getHistory(jid) {
  if (!histories.has(jid)) histories.set(jid, [])
  return histories.get(jid)
}

export async function handleMessage(jid, text) {
  const history = getHistory(jid)
  history.push({ role: 'user', content: text })

  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools,
    messages: history,
  })

  while (response.stop_reason === 'tool_use') {
    history.push({ role: 'assistant', content: response.content })

    const toolResults = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      const result = await executeTool(block.name, block.input, jid)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      })
    }
    history.push({ role: 'user', content: toolResults })

    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages: history,
    })
  }

  history.push({ role: 'assistant', content: response.content })

  while (history.length > MAX_HISTORY_MESSAGES) history.shift()

  const replyText = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()

  return replyText || "I'm not sure how to respond to that."
}
