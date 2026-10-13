// Agent chat history: conversations saved after every turn, listed newest
// first, picked back up with their history; the old tab-only transcript
// is migrated once.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { parseChatHistory } from '@landed/schema/conversation'
import { createLocalStore } from './store/local'

const calls: { input: Record<string, unknown> }[] = []
vi.mock('../hooks/runtimes', () => ({
  runOnComputer: async (_rt: string, _agent: string, _kind: string, input: Record<string, unknown>, onEvent: (e: unknown) => void) => {
    calls.push({ input })
    onEvent({ type: 'delta', text: 'Sure — ' })
    onEvent({ type: 'tool', name: 'WebSearch' })
    onEvent({ type: 'done', text: `Sure — about "${input.message}"` })
    return () => {}
  },
}))
const { useAgentChat, renameConversation, deleteConversation } = await import('./agent-chat')

let n = 0
const fresh = () => createLocalStore(`landed-chat-${++n}`)
const flush = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  calls.length = 0
  useAgentChat.setState({ userId: null, activeId: null, live: {} })
})

describe('agent chat history', () => {
  test('a new chat is saved with its title; a second message carries the history', async () => {
    const store = fresh()
    useAgentChat.getState().bind('u1', { store, onSaved: () => {} })
    await useAgentChat.getState().send('rt', 'claude', 'AI PM roles in the US for new grads')
    await flush()
    const [conv] = await store.listConversations()
    expect(conv.title).toBe('AI PM roles in the US for new grads')
    expect(conv.turns).toEqual([
      { role: 'user', text: 'AI PM roles in the US for new grads' },
      { role: 'agent', text: 'Sure — about "AI PM roles in the US for new grads"', tools: ['WebSearch'] },
    ])
    expect(calls[0].input).toMatchObject({ conversation_id: conv.id, history: [] })

    await useAgentChat.getState().send('rt', 'claude', 'I need H-1B sponsorship', conv)
    await flush()
    expect(calls[1].input.conversation_id).toBe(conv.id)
    expect((calls[1].input.history as unknown[]).length).toBe(2)
    expect((await store.listConversations())[0].turns).toHaveLength(4)
  })

  test('chats are listed newest first; opening one picks it up; new chat starts another; rename + delete', async () => {
    const store = fresh()
    useAgentChat.getState().bind('u2', { store, onSaved: () => {} })
    await useAgentChat.getState().send('rt', 'claude', 'first')
    await flush()
    useAgentChat.getState().newChat()
    await useAgentChat.getState().send('rt', 'claude', 'second')
    await flush()
    const list = await store.listConversations()
    expect(list.map((c) => c.title)).toEqual(['second', 'first'])

    useAgentChat.getState().open(list[1])
    expect(useAgentChat.getState().activeId).toBe(list[1].id)
    await renameConversation(list[1], 'Job direction')
    expect((await store.listConversations()).find((c) => c.id === list[1].id)!.title).toBe('Job direction')
    await deleteConversation(list[1].id)
    expect(useAgentChat.getState().activeId).toBeNull()
    expect((await store.listConversations()).map((c) => c.title)).toEqual(['second'])
  })

  test('the old tab-only transcript becomes the first saved chat', async () => {
    const store = fresh()
    sessionStorage.setItem('landed:agent-chat:u3', JSON.stringify({
      conversationId: '11111111-2222-4333-8444-555555555555',
      turns: [{ role: 'user', text: 'hello' }, { role: 'agent', text: 'hi!' }, { role: 'agent', text: '', pending: true }],
    }))
    let saved = false
    useAgentChat.getState().bind('u3', { store, onSaved: () => { saved = true } })
    await flush()
    const [conv] = await store.listConversations()
    expect(conv).toMatchObject({ id: '11111111-2222-4333-8444-555555555555', title: 'hello', turns: [{ role: 'user', text: 'hello' }, { role: 'agent', text: 'hi!' }] })
    expect(saved).toBe(true)
    expect(sessionStorage.getItem('landed:agent-chat:u3')).toBeNull()
  })

  test('history sent to the agent is recent, error-free and bounded', () => {
    const turns = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'agent' : 'user', text: `t${i}` }))
    const h = parseChatHistory([...turns, { role: 'agent', text: 'boom', error: true }, { role: 'system', text: 'x' }])
    expect(h).toHaveLength(24)
    expect(h.at(-1)).toEqual({ role: 'agent', text: 't39' })
    expect(parseChatHistory([{ role: 'user', text: 'x'.repeat(50_000) }])[0].text).toHaveLength(8_000)
  })
})
