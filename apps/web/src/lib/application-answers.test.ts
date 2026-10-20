// Application answers: validation, the agent's ```landed-answers block, and
// saving what it read over what the user had.
import { describe, expect, test } from 'vitest'
import { addUnanswered, answerPending, answeredCount, EMPTY_ANSWERS, extractAnswers, mergeAnswers, parseApplicationAnswers, questionKey, sameQuestion, skipPending } from '@landed/schema/application-answers'

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

describe('questions forms asked that nothing answered', () => {
  const now = '2026-10-19T10:00:00.000Z'
  const later = '2026-10-20T10:00:00.000Z'

  test('the same question, however a form words it', () => {
    expect(questionKey('Phone number (required) *')).toBe('phone number')
    expect(sameQuestion('How many years of Python experience do you have?', 'Years of experience with Python')).toBe(true)
    expect(sameQuestion('Experience in data analytics?', 'Experience in data engineering?')).toBe(false)
    expect(sameQuestion('Shirt size', 'Shoe size')).toBe(false)
    expect(sameQuestion('学历', '学历')).toBe(true)
  })

  test('asked on three sites → one question, counted three times', () => {
    let a = addUnanswered(EMPTY_ANSWERS, [{ question: 'What is your T-shirt size?', options: ['S', 'M', 'L'], site: 'boards.greenhouse.io' }], now)
    a = addUnanswered(a, [{ question: 'T-shirt size *', site: 'jobs.lever.co' }], now)
    a = addUnanswered(a, [{ question: 'What is your t-shirt size?', site: 'jobs.ashbyhq.com' }], later)
    expect(a.unanswered).toHaveLength(1)
    expect(a.unanswered[0]).toMatchObject({ question: 'What is your T-shirt size?', options: ['S', 'M', 'L'], seen: 3, last_seen: later, key: null })
    expect(a.unanswered[0].sites).toEqual(['jobs.ashbyhq.com', 'jobs.lever.co', 'boards.greenhouse.io'])
  })

  test('never asks what is answered, skipped or sensitive', () => {
    const base = { ...EMPTY_ANSWERS, heard_from: 'LinkedIn', custom: [{ question: 'Years of Python experience', answer: '4' }], skipped: [questionKey('Favourite color?')] }
    const a = addUnanswered(base, [
      { question: 'How did you hear about us?', key: 'heard_from' },
      { question: 'How many years of Python experience do you have?' },
      { question: 'Favourite color?' },
      { question: 'Gender', key: 'gender' },
      { question: 'Date of birth', key: 'date_of_birth' },
      { question: 'Are you 18 or older?', key: 'adult' },
    ], now)
    expect(a.unanswered.map((q) => q.question)).toEqual(['Are you 18 or older?'])
  })

  test('an answer goes to the field it is about, else to other questions', () => {
    let a = addUnanswered(EMPTY_ANSWERS, [
      { question: 'How did you hear about this job?', key: 'heard_from' },
      { question: 'Are you 18 or older?', key: 'adult', options: ['Yes', 'No'] },
      { question: 'What is your T-shirt size?', options: ['S', 'M', 'L'] },
    ], now)
    a = answerPending(a, 'How did you hear about this job?', 'A friend')
    a = answerPending(a, 'Are you 18 or older?', 'Yes')
    a = answerPending(a, 'What is your T-shirt size?', 'M')
    expect(a).toMatchObject({ heard_from: 'A friend', adult: 'yes', custom: [{ question: 'What is your T-shirt size?', answer: 'M' }], unanswered: [] })
    // A yes/no question takes only yes or no; a blank answer changes nothing.
    const b = addUnanswered(EMPTY_ANSWERS, [{ question: 'Willing to travel?', key: 'travel' }], now)
    expect(answerPending(b, 'Willing to travel?', 'Sometimes')).toBe(b)
    expect(answerPending(b, 'Willing to travel?', '  ')).toBe(b)
  })

  test("don't ask again sticks; saving answers elsewhere keeps the list and drops what they answer", () => {
    let a = addUnanswered(EMPTY_ANSWERS, [{ question: 'Favourite color?' }, { question: 'City you live in', key: 'city' }], now)
    a = skipPending(a, 'Favourite color?')
    expect(addUnanswered(a, [{ question: 'Favourite color?' }], later).unanswered.map((q) => q.question)).toEqual(['City you live in'])
    const merged = mergeAnswers(a, { ...EMPTY_ANSWERS, city: 'Seattle' })
    expect(merged.unanswered).toEqual([])
    expect(merged.skipped).toEqual(a.skipped)
  })

  test('stored lists are validated', () => {
    const a = parseApplicationAnswers({
      unanswered: [
        { question: 'T-shirt size', key: null, options: ['S', 7, 'M'], sites: ['a.com'], seen: 2, last_seen: now },
        { question: 'Gender', key: 'gender' },
        { question: '' },
        { question: 'Made-up key', key: 'not_a_field' },
      ],
      skipped: ['x', 'x', 3],
    })
    expect(a.unanswered).toEqual([
      { question: 'T-shirt size', key: null, options: ['S', 'M'], sites: ['a.com'], seen: 2, last_seen: now },
      { question: 'Made-up key', key: null, options: [], sites: [], seen: 1, last_seen: '' },
    ])
    expect(a.skipped).toEqual(['x'])
  })
})

test('a "worked here before: yes" read from one form is not saved for every company', () => {
  const block = (body: string) => '```landed-answers\n' + body + '\n```'
  expect(extractAnswers(block('{"legal_first_name":"Alex","previously_employed":"yes"}')).answers?.previously_employed).toBeNull()
  expect(extractAnswers(block('{"legal_first_name":"Alex","previously_employed":"no"}')).answers?.previously_employed).toBe('no')
})

test('what was filled in on its own is kept, validated, and survives an agent\'s read', () => {
  const parsed = parseApplicationAnswers({
    city: 'Seattle',
    prefilled: {
      city: { value: 'Seattle', from: 'resume' },
      preferred_locations: { value: ['Seattle', ' ', 'New York', 'Boston', 'Austin'], from: 'search' },
      date_of_birth: { value: 'October 30', from: 'resume' }, // never filled in on its own
      github: { value: 'https://github.com/x', from: 'somewhere' },
      linkedin: { value: 42, from: 'resume' },
    },
  })
  expect(parsed.prefilled).toEqual({
    city: { value: 'Seattle', from: 'resume' },
    preferred_locations: { value: ['Seattle', 'New York', 'Boston'], from: 'search' },
  })
  expect(answeredCount(parsed)).toBe(1)
  expect(mergeAnswers(parsed, parseApplicationAnswers({ github: 'https://github.com/alexrivera-example' })).prefilled).toEqual(parsed.prefilled)
  expect(parseApplicationAnswers({ prefilled: [1, 2] }).prefilled).toEqual({})
})
