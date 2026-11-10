// How an agent finds "wild" jobs: postings on no list Landed reads itself
// (#138; docs/agent-sourcing.md). One playbook for every agent that searches:
// the daemon's job_search (apps/daemon/src/agents.ts) sends these lines to
// whichever agent runs the search. Plain TS, no dependencies: the daemon
// bundles it.

import type { SearchBrief } from './search-brief.ts'

/** Where to look, what to check before reporting, one entry per posting,
 *  and when to stop. */
export const SEARCH_PLAYBOOK: readonly string[] = [
  'Where to look, in this order:',
  '1. The companies the brief names first: their careers page and their job board.',
  '2. Job boards directly, with site: searches for the role and level: job-boards.greenhouse.io, boards.greenhouse.io,',
  '   jobs.lever.co, jobs.ashbyhq.com, myworkdayjobs.com, jobs.smartrecruiters.com, apply.workable.com. Large',
  '   employers outside tech (banks, retail, healthcare, consulting, insurance) mostly use Workday: search',
  '   myworkdayjobs.com for product, data and business roles.',
  '3. Early-career programs: new grad and internship pages, "university recruiting", "early careers", rotational',
  '   and analyst development programs, associate product manager programs.',
  "4. Startups: this month's Hacker News \"Ask HN: Who is hiring?\" thread and ycombinator.com/jobs.",
  '5. Posts and referrals (LinkedIn, X, forums, newsletters) only point you to a posting: find the posting itself.',
  'Never sign in anywhere, get past a CAPTCHA, or scrape LinkedIn, Indeed, Glassdoor or Handshake pages.',
  '',
  'Before you report a posting:',
  "- Open the posting's own page and read it. Never report a posting you haven't opened. Never invent companies,",
  '  titles or links.',
  "- job_url is that page: the company's careers site or its job board (Greenhouse, Lever, Ashby, Workday…), never",
  '  a social post, a job alert or a search page. Found it on an aggregator (LinkedIn, Indeed, jobright, Simplify)?',
  "  Find the company's own page; use the aggregator's only when there is none, and say so in why.",
  '- It is open: the page shows the posting with a way to apply (not "no longer accepting applications", not a',
  '  404 or a redirect to a search page).',
  '- It is recent: posted within about two months. Give posted as the page shows it.',
  '- It fits the brief: the role and the level (an internship search wants internships; a new-grad search no',
  '  senior, staff, lead or manager titles and no more than about two years of experience asked), a place the',
  '  brief allows, never an excluded company.',
  "- sponsorship: what the posting says about visa sponsorship, or what is publicly known about the company's",
  '  sponsoring for this kind of role. Leave it empty rather than guess.',
  '- deadline: the application deadline if the posting states one (YYYY-MM-DD); new-grad programs often have one.',
  '',
  'One posting, one entry: the same company and title in several places is one entry, with the places in',
  'location separated by "; ". At most 5 postings from one company.',
  '',
  'Budget: stop once you have about 25 good matches, after about 15 searches, or after opening about 40 pages,',
  'whichever comes first. Fewer good ones beat many weak ones.',
]

const LEVEL = [
  [/\bintern(ship)?s?\b|co-?op|实习/i, 'intern'],
  [/new ?grad|graduate|entry|junior|early career|university|campus|校招|应届/i, 'new grad'],
] as const

/** A few searches to start from, built from the brief: its first roles on
 *  the job boards above (Workday first: product, data and business roles at
 *  large employers live there), with the level and the first place. */
export function searchQueries(brief: SearchBrief, max = 6): string[] {
  const said = [brief.seniority ?? '', ...brief.roles].join(' ')
  const level = LEVEL.find(([re]) => re.test(said))?.[1] ?? ''
  const place = brief.locations.find((l: string) => !/remote|远程/i.test(l))?.split(',')[0].trim() ?? ''
  const tail = [level && `"${level}"`, place].filter(Boolean).join(' ')
  const out: string[] = []
  for (const role of brief.roles.slice(0, 2)) {
    const r = `"${role.replace(/"/g, '').trim()}"`
    out.push(
      `site:myworkdayjobs.com ${r} ${tail}`.trim(),
      `site:job-boards.greenhouse.io ${r} ${tail}`.trim(),
      `site:jobs.lever.co OR site:jobs.ashbyhq.com ${r} ${tail}`.trim(),
    )
  }
  if (level) out.push(`${brief.roles[0] ? `"${brief.roles[0].replace(/"/g, '')}"` : ''} ${level === 'intern' ? 'internship' : 'new grad'} program early careers`.trim())
  return [...new Set(out)].slice(0, max)
}
