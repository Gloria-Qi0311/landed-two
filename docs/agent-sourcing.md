# Finding wild jobs with an agent

"Wild" jobs are postings on no list Landed reads itself: a job only on the
company's own site, one a hiring manager posted, one in a community thread or a
referral post. Landed's own code reads the SimplifyJobs and jobright lists and
the job boards of the companies the user follows. An agent's search exists for
everything else. This page is the playbook every searching agent follows, and
why (#138).

**One playbook for every agent.** The lines live in
`packages/schema/src/agent-sourcing.ts` (`SEARCH_PLAYBOOK`, `searchQueries`):

- the daemon's `job_search` system prompt (`apps/daemon/src/agents.ts`) sends
  them;
- cloud agents' `get_tasks` job-search instructions
  (`apps/server/src/routes/mcp.ts`) send the same lines.

Change the playbook there, and both follow.

## Where to look

In this order:

1. **The companies the brief names first**: their careers page and their job
   board.
2. **Job boards directly**, with `site:` searches for the role and level:
   `job-boards.greenhouse.io`, `boards.greenhouse.io`, `jobs.lever.co`,
   `jobs.ashbyhq.com`, `myworkdayjobs.com`, `jobs.smartrecruiters.com`,
   `apply.workable.com`. **Large employers outside tech** (banks, retail,
   healthcare, consulting, insurance) **mostly use Workday**. In the #138
   research, 25 of 30 product, data and business postings from jobright's lists
   were at such companies, with no Greenhouse, Lever or Ashby board. So for
   these roles `myworkdayjobs.com` comes first.
3. **Early-career programs**: new-grad and internship pages, "university
   recruiting", "early careers", rotational and analyst development programs,
   associate product manager programs.
4. **Startups**: this month's Hacker News "Ask HN: Who is hiring?" thread (its
   comments are free text; the Algolia API is open) and `ycombinator.com/jobs`
   (the page embeds its latest postings by role).
5. **Posts and referrals** (LinkedIn, X, forums, newsletters) only point to a
   posting. The agent finds the posting itself.

Never: sign in anywhere, get past a CAPTCHA, or scrape LinkedIn, Indeed,
Glassdoor or Handshake pages (403s, sign-in walls, and terms that forbid it;
see the table on #138). Reading LinkedIn through the user's own Chrome would
be a product and security decision for the owner.

`searchQueries(brief)` turns the brief into a few searches to start from. It
takes the first two roles and puts each on the boards, Workday first, with the
level ("intern", "new grad") and the first place that isn't remote. Then it
adds one early-careers search. The prompt lists them under "Searches to start
from"; the agent follows where they lead.

## Before reporting a posting

- **Opened.** The agent reads the posting's own page. A posting it hasn't
  opened is never reported, and nothing is invented.
- **The link is the application.** `job_url` is the company's careers site or
  its job board, never a social post, a job alert or a search page. When the
  agent found it on an aggregator (LinkedIn, Indeed, jobright, Simplify), it
  looks for the company's own page. It uses the aggregator's link only when
  there is none, and says so in `why`: auto apply can't apply through an
  aggregator.
- **Open.** The page shows the posting with a way to apply: not "no longer
  accepting applications", not a 404 or a redirect to a search page.
- **Recent.** Posted within about two months; `posted` as the page shows it.
- **Fits.** The role and the level: an internship search wants internships; a
  new-grad search takes no senior, staff, lead or manager titles and no more
  than about two years of experience asked. It's in a place the brief allows
  and never at an excluded company.
- `sponsorship` and `deadline` only as the posting (or what's publicly known)
  says; empty rather than a guess.

## One posting, one entry

The same company and title in several places is one entry, with the places in
`location` separated by "; ". At most 5 postings from one company, so one big
employer doesn't fill the run. Landed dedupes again on its side
(`ingestFoundJobs`, the processor's `sameJob`), against Leads, applications and
other sources.

## Budget

The agent stops once it has about 25 good matches, after about 15 searches, or
after opening about 40 pages, whichever comes first. Fewer good ones beat many
weak ones. The daemon's search times out at 20 minutes.

## Measuring it

For each fixed brief, run the search with the old prompt and with the new one,
then check every reported posting:

| Measure | How |
|---|---|
| **Good** | Its link opens (HTTP 200, not a search page or a "no longer accepting" page), it's the company's own site or a job board, and it isn't on a list Landed already reads (SimplifyJobs, jobright) |
| Dead link | The link fails, or the page says the posting is closed |
| Aggregator | The link is LinkedIn, Indeed, Glassdoor, jobright or SimplifyJobs, not the application |
| Wrong level | A senior, staff, lead or manager title in a new-grad or internship search |
| Cost | Tokens and dollars from Claude Code's result, and the time taken |

The fixed briefs and the numbers are in the PR that introduced this playbook
and on #138.
