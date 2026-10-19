// @landed/supply — the supply track's pure functions (docs/leads-model.md).
// Parsers for public job sources, the hard filters and the fit score land
// here in their own PRs; priority is the first.
export { daysUntil, NO_DATE_URGENCY, priority, UNRANKED, UNSCORED_FIT, urgency, type PriorityInput } from './priority'
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
export { graduationOf, graduationWindow, isPutBack, outsideUS, PUT_BACK, screenPosting, type GradWindow, type ScreenInput } from './screen'
