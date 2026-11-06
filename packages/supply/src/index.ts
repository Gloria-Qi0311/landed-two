// @landed/supply — the supply track's pure functions (docs/leads-model.md).
// Parsers for public job sources, the hard filters and the fit score land
// here in their own PRs; priority is the first.
export { AGENT_RANK_WEIGHT, daysUntil, NO_DATE_URGENCY, priority, rankedFit, UNRANKED, UNSCORED_FIT, urgency, type PriorityInput } from './priority'
export { scoreFit, skillsMentioned, yearsAsked, yearsOnResume, type FitInput } from './fit'
export {
  levelMatches, listsForBrief, MAX_AGE_DAYS, tooSenior, MAX_PER_LIST, parseSimplifyListings, placeMatches, roleMatches, selectForBrief,
  simplifyObservationId, simplifySourceOf, SIMPLIFY_LISTS, toFoundJob, type SimplifyList, type SimplifyListing,
} from './simplify'
export {
  ATS, ATS_LABELS, boardFromUrl, boardKey, boardListUrl, boardObservationId, boardSourceOf, greenhouseJobUrl, htmlToText,
  MAX_DESCRIPTION, MAX_PER_BOARD, parseAshbyJobs, parseBoard, parseGreenhouseJob, parseGreenhouseJobs, parseLeverPostings,
  postingIdFromAtsKey, postingToFoundJob, selectPostings, slugCandidates, type Ats, type Board, type BoardPosting,
} from './ats'
export {
  isListingPage, JOBRIGHT_DIRECTIONS, JOBRIGHT_MAX_AGE_DAYS, JOBRIGHT_MAX_PER_LIST, jobrightDate, jobrightListsForBrief, jobrightObservationId,
  jobrightSourceOf, jobrightToFoundJob, jobrightUrl, matchBoardPosting, parseJobrightReadme, selectJobright, touchesRole,
  type JobrightDirection, type JobrightListing,
} from './jobright'
export { graduationOf, graduationWindow, isPutBack, outsideUS, PUT_BACK, screenPosting, type GradWindow, type ScreenInput } from './screen'
