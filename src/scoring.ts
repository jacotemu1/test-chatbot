import { ValidationOutcome } from './types';

export function scoreValidation(outcome: Omit<ValidationOutcome, 'score'>): ValidationOutcome['score'] {
  const hardFailure =
    outcome.parseFailure ||
    outcome.schemaDrift ||
    outcome.emptyResponse ||
    outcome.keywordMiss;

  if (hardFailure) return 'fail';
  if (outcome.genericFailureDetected || outcome.suspiciousSignals.length > 0 || outcome.knownFlakySemantic) {
    return 'warn';
  }
  return 'pass';
}
