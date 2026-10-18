// @landed/supply — the supply track's pure functions (docs/leads-model.md).
// Parsers for public job sources, the hard filters and the fit score land
// here in their own PRs; priority is the first.
export { daysUntil, priority, UNRANKED, UNSCORED_FIT, urgency, type PriorityInput } from './priority'
export {
  listsForBrief, MAX_AGE_DAYS, MAX_PER_LIST, parseSimplifyListings, placeMatches, roleMatches, selectForBrief,
  simplifyObservationId, simplifySourceOf, SIMPLIFY_LISTS, toFoundJob, type SimplifyList, type SimplifyListing,
} from './simplify'
