// lib/choice-answers.js: which question a label asks, what the saved
// answers say, and which option says it.
const CA = require('../lib/choice-answers.js')

const answers = {
  legal_first_name: 'Alex', legal_middle_name: null, legal_last_name: 'Chen', preferred_first_name: 'Lex', preferred_last_name: null,
  date_of_birth: 'March 3', address_line1: '100 Main St', city: 'Seattle', state: 'Washington', postal_code: '98105', country: 'United States',
  work_authorized: 'yes', needs_sponsorship: 'yes', earliest_start: 'June 2027', relocate: 'yes', travel: null,
  preferred_locations: ['San Francisco, CA', 'Seattle, WA'], open_to_other_locations: 'yes', previously_employed: 'no',
  non_compete: null, heard_from: 'Company careers website', talent_network: 'yes',
  gender: 'Male', hispanic_latino: 'no', race: 'Asian', veteran: 'no', disability: null,
  agree_to_terms: true, custom: [{ question: 'Experience in data analytics?', answer: 'Expert' }],
}

describe('classify', () => {
  test.each([
    ['If you are currently authorized to work in the US, will you require IBM sponsorship for an employment visa in the future?', 'needs_sponsorship'],
    ['Are you legally authorized to work in the United States?', 'work_authorized'],
    ['Are you currently authorized for employment in the U.S. without any restrictions to the length of employment period? (Answer "No" if you are in a non-immigrant status such as H, L, E, TN, B or F, including OPT, CPT)', 'work_authorized'],
    ['You consent to IBM processing the information you provide for the purpose of processing your application', 'consent'],
    ["I confirm that I have read, understand and agree to IBM's Privacy Policy.", 'consent'],
    ['If you have a preferred name that is different from your legal name, please select yes below; otherwise, please select no.', 'has_preferred_name'],
    ['Legal first name *', 'legal_first_name'],
    ['Preferred first name', 'preferred_first_name'],
    ['Legal middle name', 'legal_middle_name'],
    ['Please indicate your day and month of birth. This data is collected for pre-employment verification checks.', 'date_of_birth'],
    ['Address line 1', 'address_line1'],
    ['Zip code/Postal code', 'postal_code'],
    ['State/Province', 'state'],
    ['Country', 'country'],
    ['Have you ever worked at IBM before? Please answer Yes if you were employed by IBM as a regular, fixed term, or intern.', 'previously_employed'],
    ['First choice:', 'preferred_location_1'],
    ['If a position is not available in your preferred locations, would you like to be considered for positions in other locations?', 'open_to_other_locations'],
    ['If the location of the job is different from your current residence, are you willing to relocate?', 'relocate'],
    ['What date are you available to start full time, regular employment (Month/Year)?', 'earliest_start'],
    ['How did you hear about this opportunity?', 'heard_from'],
    ['Join talent network?', 'talent_network'],
    ['Gender:', 'gender'], ['Ethnicity:', 'hispanic_latino'], ['Race:', 'race'],
    ['Are you a protected veteran?', 'veteran'], ['Disability status', 'disability'],
    ["Today's date:", 'today'], ['Your name:', 'signature_name'],
    ['Are you 18 years of age or older?', 'adult'],
    ['Are you open to a onsite working model in which you would come into the office 5 days a week?', 'onsite'],
    ['LinkedIn Profile *', 'linkedin'],
    ['Website', 'website'],
    ['GitHub URL', 'github'],
    ['How did you hear about this job? (LinkedIn, Indeed, a friend…)', 'heard_from'],
    ['Are you a resident of China or South Korea?', null],
    ['Email address', null],
    ['Is the residential address you provided in your application different from your permanent address?', null],
  ])('%s → %s', (label, kind) => {
    expect(CA.classify(label)).toBe(kind)
  })
})

describe('answerFor', () => {
  test('yes/no, text, preferred name, locations, signature, today', () => {
    expect(CA.answerFor('needs_sponsorship', answers)).toEqual({ type: 'yesno', value: 'yes' })
    expect(CA.answerFor('travel', answers)).toBeNull()
    expect(CA.answerFor('has_preferred_name', answers)).toEqual({ type: 'yesno', value: 'yes' })
    expect(CA.answerFor('has_preferred_name', { ...answers, preferred_first_name: null })).toEqual({ type: 'yesno', value: 'no' })
    expect(CA.answerFor('preferred_location_2', answers)).toEqual({ type: 'text', value: 'Seattle, WA' })
    expect(CA.answerFor('preferred_location_3', answers)).toBeNull()
    expect(CA.answerFor('signature_name', answers)).toEqual({ type: 'text', value: 'Alex Chen' })
    const today = new Date(2026, 9, 15)
    expect(CA.answerFor('today', answers, { today })).toEqual({ type: 'text', value: '10/15/2026' })
    expect(CA.answerFor('today', answers, { today, dateInput: true })).toEqual({ type: 'text', value: '2026-10-15' })
  })

  test('a time-unrestricted authorization question is stricter than ordinary work authorization', () => {
    const question = 'Are you currently authorized for employment in the U.S. without any restrictions to the length of employment period? Answer No for non-immigrant status, including OPT, CPT.'
    expect(CA.answerFor('work_authorized', answers, { question })).toEqual({ type: 'yesno', value: 'no' })
    expect(CA.answerFor('work_authorized', { ...answers, needs_sponsorship: 'no' }, { question })).toBeNull()
    expect(CA.answerFor('work_authorized', { ...answers, work_authorized: 'no', needs_sponsorship: 'no' }, { question })).toEqual({ type: 'yesno', value: 'no' })
  })

  test('EEO left blank declines; consent only with the switch on; nothing without answers', () => {
    expect(CA.answerFor('disability', answers)).toEqual({ type: 'decline' })
    expect(CA.answerFor('race', { ...answers, race: null })).toEqual({ type: 'decline' })
    expect(CA.answerFor('consent', answers)).toEqual({ type: 'agree' })
    expect(CA.answerFor('consent', { ...answers, agree_to_terms: false })).toBeNull()
    expect(CA.answerFor('gender', null)).toBeNull()
  })
})

describe('pickOption', () => {
  const yes = { type: 'yesno', value: 'yes' }
  const no = { type: 'yesno', value: 'no' }
  test('yes / no, including long statements and Chinese', () => {
    expect(CA.pickOption(yes, ['Select…', 'Yes', 'No'])).toBe(1)
    expect(CA.pickOption(no, ['是', '否'])).toBe(1)
    expect(CA.pickOption(no, ['I identify as one or more of the classifications of protected veteran', 'I am not a protected veteran', "I don't wish to answer"])).toBe(1)
    expect(CA.pickOption(yes, ['Yes, I have a disability (or previously had one)', "No, I don't have a disability", "I don't wish to answer"])).toBe(0)
  })

  test('decline and agree', () => {
    expect(CA.pickOption({ type: 'decline' }, ['Yes', 'No', 'I do not wish to answer'])).toBe(2)
    expect(CA.pickOption({ type: 'agree' }, ['I consent to IBM processing the information', 'I do not consent to IBM Processing the information.'])).toBe(0)
    expect(CA.pickOption({ type: 'agree' }, ['I do not agree'])).toBe(-1)
  })

  test('text: exact, aliases, qualifiers — and never "female" for "male"', () => {
    const text = (value) => ({ type: 'text', value })
    expect(CA.pickOption(text('Male'), ['Female', 'Male', 'Decline to self-identify'])).toBe(1)
    expect(CA.pickOption(text('United States'), ['Canada', 'United States of America'])).toBe(1)
    expect(CA.pickOption(text('Washington'), ['WA', 'OR'])).toBe(0)
    expect(CA.pickOption(text('Asian'), ['White (Not Hispanic or Latino)', 'Asian (Not Hispanic or Latino)'])).toBe(1)
    expect(CA.pickOption(text('Company careers website'), ['LinkedIn', 'Referral'])).toBe(-1)
  })

  test('a tie is no answer', () => {
    expect(CA.pickOption({ type: 'yesno', value: 'yes' }, ['Yes', 'Yes'])).toBe(-1)
  })
})

describe('for the local model', () => {
  test('answer keys carry no sensitive values beyond what forms ask; facts skip EEO and birth date', () => {
    const keys = CA.answerFlat(answers)
    expect(keys).toMatchObject({ legal_first_name: 'Alex', city: 'Seattle', preferred_location_1: 'San Francisco, CA', 'Experience in data analytics?': 'Expert' })
    const facts = CA.answerFacts(answers, { school: 'Example University' }).join('\n')
    expect(facts).toMatch(/Needs visa sponsorship now or in the future: Yes/)
    expect(facts).toMatch(/School: Example University/)
    expect(facts).not.toMatch(/Male|Asian|March 3/)
  })
})

describe('worked here before? — the resume decides, not one saved yes/no', () => {
  const usBank = 'Have you previously worked as an employee or contractor for U.S. Bank or any of its related companies including any affiliates, subsidiaries, or predecessor organizations such as Elavon, U.S. Bancorp Investments, or Union Bank? If yes, please answer the questions below.'
  const base = { ...answers, previously_employed: null }
  const ask = (saved, employers, question = usBank, site = 'usbank.wd1.myworkdayjobs.com') =>
    CA.answerFor('previously_employed', { ...base, previously_employed: saved }, { employers, question, site })

  test('a company on the resume is Yes, whatever was saved', () => {
    expect(ask('no', ['Stripe', 'U.S. Bank'])).toEqual({ type: 'yesno', value: 'yes' })
    expect(ask(null, ['Union Bank, N.A.'])).toEqual({ type: 'yesno', value: 'yes' })
    expect(ask(null, ['US Bank'], 'Have you worked here before?')).toEqual({ type: 'yesno', value: 'yes' }) // the careers site's host
    expect(ask(null, ['IBM'], 'Have you ever worked at IBM before?', 'ibm.com')).toEqual({ type: 'yesno', value: 'yes' })
  })

  test('any other company: No when saved No or nothing; a saved Yes (about some other company) is left to the user', () => {
    expect(ask('no', ['Stripe'])).toEqual({ type: 'yesno', value: 'no' })
    expect(ask(null, ['Stripe', 'Globex'])).toEqual({ type: 'yesno', value: 'no' })
    expect(ask('yes', ['Stripe'])).toBeNull()
    expect(ask(null, [])).toBeNull()
    // Short names don't match inside other words or hosts.
    expect(CA.namesEmployer('Have you worked at Globex?', ['Glo'], 'glo.example')).toBe(false)
    expect(CA.namesEmployer('Have you worked for Meta or its affiliates?', ['Metaview'], '')).toBe(false)
  })

  test("the local model's facts carry the resume's employers, not a saved yes/no", () => {
    const facts = CA.answerFacts({ ...answers, previously_employed: 'yes' }, {}, ['Stripe', 'Globex']).join('\n')
    expect(facts).not.toMatch(/worked at this company/i)
    expect(facts).toMatch(/Employers on the resume \(the only ones they have worked for\): Stripe; Globex/)
  })
})
