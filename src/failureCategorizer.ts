import { ValidationOutcome, SalesSignals } from './types';

export type FailureCategory =
  | 'misunderstood_intent'
  | 'generic_non_answer'
  | 'irrelevant_answer'
  | 'hallucinated_fitment'
  | 'missing_clarification'
  | 'premature_recommendation'
  | 'no_cta_or_next_step'
  | 'contradiction'
  | 'unstable_repeated_answer'
  | 'long_context_degradation'
  | 'timeout_or_technical_failure';

export function categorizeFailure(input: {
  validation: ValidationOutcome;
  sales: SalesSignals;
  isTechnicalFailure: boolean;
  contradiction?: boolean;
  unstableRepeated?: boolean;
  longContextDegradation?: boolean;
}): FailureCategory[] {
  const out: FailureCategory[] = [];

  if (input.isTechnicalFailure) out.push('timeout_or_technical_failure');
  if (input.validation.emptyResponse) out.push('generic_non_answer');
  if (input.validation.keywordMiss) out.push('misunderstood_intent');
  if (input.validation.schemaDrift) out.push('irrelevant_answer');
  if (input.sales.potentialUnsafeFitment) out.push('hallucinated_fitment');
  if (!input.sales.askedClarifyingQuestion) out.push('missing_clarification');
  if (input.sales.earlyRecommendation) out.push('premature_recommendation');
  if (!input.sales.hasCommercialCta) out.push('no_cta_or_next_step');
  if (input.contradiction) out.push('contradiction');
  if (input.unstableRepeated) out.push('unstable_repeated_answer');
  if (input.longContextDegradation) out.push('long_context_degradation');
  if (input.sales.tooGeneric && !out.includes('generic_non_answer')) out.push('generic_non_answer');

  return [...new Set(out)];
}
