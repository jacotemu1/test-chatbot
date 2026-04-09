import Ajv from 'ajv';
import { detectSuspiciousSignals } from './suspiciousDetector';
import { scoreValidation } from './scoring';
import { ChatResult, ValidationMode, ValidationOutcome, ValidationRule } from './types';

const ajv = new Ajv({ strict: false, allErrors: true });
const genericFailurePatterns = [
  /i\s+cannot/i,
  /i\s+can'?t\s+help\s+with\s+that/i,
  /something\s+went\s+wrong/i,
  /errore/i,
  /non\s+posso/i,
];

function pickAnswer(parsedBody: unknown, answerPath?: string): string {
  if (!parsedBody || typeof parsedBody !== 'object') return '';

  if (answerPath) {
    const segments = answerPath.split('.');
    let cursor: unknown = parsedBody;
    for (const segment of segments) {
      if (!cursor || typeof cursor !== 'object' || !(segment in cursor)) return '';
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    return typeof cursor === 'string' ? cursor : '';
  }

  const candidates = ['answer', 'output', 'message', 'text', 'response'];
  for (const key of candidates) {
    const val = (parsedBody as Record<string, unknown>)[key];
    if (typeof val === 'string') return val;
  }
  return '';
}

function enforceMode(mode: ValidationMode | undefined, input: {
  parseFailure: boolean;
  emptyResponse: boolean;
  schemaDrift: boolean;
  keywordMiss: boolean;
  genericFailureDetected: boolean;
}): Pick<ValidationOutcome, 'parseFailure' | 'emptyResponse' | 'schemaDrift' | 'keywordMiss' | 'genericFailureDetected'> {
  if (!mode) return input;

  switch (mode) {
    case 'latency_only':
      return { parseFailure: false, emptyResponse: false, schemaDrift: false, keywordMiss: false, genericFailureDetected: false };
    case 'schema_only':
      return { ...input, emptyResponse: false, keywordMiss: false, genericFailureDetected: false };
    case 'safety_check':
      return { ...input, keywordMiss: false };
    case 'consistency_check':
      return input;
    case 'keyword_match':
      return input;
    case 'non_empty':
      return { ...input, keywordMiss: false, schemaDrift: false };
    default:
      return input;
  }
}

export function validateResult(result: ChatResult, rule?: ValidationRule): ValidationOutcome {
  const parseFailure = !!(result.rawBody && !result.parsedBody);
  const answerText = pickAnswer(result.parsedBody, rule?.answerPath).trim();
  const emptyResponse = !answerText;

  let schemaDrift = false;
  if (rule?.jsonSchema && result.parsedBody) {
    const validate = ajv.compile(rule.jsonSchema);
    schemaDrift = !validate(result.parsedBody);
  }

  let keywordMiss = false;
  if (rule?.expectedKeywords && rule.expectedKeywords.length > 0) {
    const lower = answerText.toLowerCase();
    keywordMiss = !rule.expectedKeywords.some((k) => lower.includes(k.toLowerCase()));
  }

  const genericFailureDetected = genericFailurePatterns.some((p) => p.test(answerText));
  const suspiciousSignals = detectSuspiciousSignals(answerText);

  const modeAdjusted = enforceMode(rule?.mode, {
    parseFailure,
    emptyResponse,
    schemaDrift,
    keywordMiss,
    genericFailureDetected,
  });

  let suspiciousReason: string | undefined;
  if (modeAdjusted.parseFailure) suspiciousReason = 'Parse failure';
  else if (modeAdjusted.schemaDrift) suspiciousReason = 'Schema drift';
  else if (modeAdjusted.keywordMiss) suspiciousReason = 'Keyword mismatch';
  else if (modeAdjusted.genericFailureDetected) suspiciousReason = 'Generic refusal/failure';
  else if (modeAdjusted.emptyResponse) suspiciousReason = 'Empty response';
  else if (suspiciousSignals.length > 0) suspiciousReason = suspiciousSignals.join('; ');

  const knownFlakySemantic = !!rule?.flakySemantic;

  const partial: Omit<ValidationOutcome, 'score'> = {
    ...modeAdjusted,
    suspiciousSignals,
    answerText,
    suspiciousReason,
    knownFlakySemantic,
  };

  return {
    ...partial,
    score: scoreValidation(partial),
  };
}
