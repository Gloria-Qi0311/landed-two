// Application answers: validation, the agent's ```landed-answers block, and
// saving what it read over what the user had.
import { describe, expect, test } from 'vitest'
import { EMPTY_ANSWERS, extractAnswers, mergeAnswers, parseApplicationAnswers } from '@landed/schema/application-answers'

const reply = (json: string) => `I read your IBM form.\n\n\`\`\`landed-answers\n${json}\n\`\`\`\n\nAnything to change?`

describe('the agent reads a filled form', () => {
  test('block → answers; text kept around it; consent never switched on by a read', () => {
    const out = extractAnswers(reply(JSON.stringify({
      legal_first_name: 'Alex', legal_last_name: 'Chen', country: 'United States', needs_sponsorship: 'yes', relocate: 'sure',
      preferred_locations: ['San Francisco, CA', 'Seattle, WA', 'Los Angeles, CA', 'Austin, TX'], agree_to_terms: true,
      custom: [{ question: 'Experience in Agile software development?', answer: 'I have performed this independently' }],
    })))
    expect(out.text).toBe('I read your IBM form.\n\nAnything to change?')
    expect(out.answers).toMatchObject({
      legal_first_name: 'Alex', country: 'United States', needs_sponsorship: 'yes', relocate: null, agree_to_terms: false,
      preferred_locations: ['San Francisco, CA', 'Seattle, WA', 'Los Angeles, CA'],
    })
    expect(out.answers?.custom).toHaveLength(1)
  })

  test('still streaming, broken JSON, or nothing read', () => {
    expect(extractAnswers('Reading…\n```landed-answers\n{"legal_fi').drafting).toBe(true)
    expect(extractAnswers(reply('{not json')).answers).toBeNull()
    expect(extractAnswers(reply('{"relocate": "maybe"}')).answers).toBeNull()
    expect(extractAnswers('no block here').answers).toBeNull()
  })
})

test('saving a read: what it read replaces, the rest stays, custom merges by question, consent stays', () => {
  const mine = parseApplicationAnswers({
    country: 'China', travel: 'no', agree_to_terms: true,
    custom: [{ question: 'Worked here before?', answer: 'No' }, { question: 'Experience in SQL?', answer: 'Some' }],
  })
  const read = { ...EMPTY_ANSWERS, country: 'United States', relocate: 'yes' as const, custom: [{ question: 'experience in SQL?', answer: 'Expert' }] }
  const merged = mergeAnswers(mine, read)
  expect(merged).toMatchObject({ country: 'United States', travel: 'no', relocate: 'yes', agree_to_terms: true })
  expect(merged.custom).toEqual([{ question: 'Worked here before?', answer: 'No' }, { question: 'experience in SQL?', answer: 'Expert' }])
})
