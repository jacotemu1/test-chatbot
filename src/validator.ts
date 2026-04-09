import Ajv from 'ajv';
import { ChatResult, ValidationOutcome, ValidationRule } from './types';

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
    keywordMiss = !rule.expectedKeywords.every((k) => lower.includes(k.toLowerCase()));
  }

  const genericFailureDetected = genericFailurePatterns.some((p) => p.test(answerText));

  let suspiciousReason: string | undefined;
  if (parseFailure) suspiciousReason = 'Parse failure';
  else if (schemaDrift) suspiciousReason = 'Schema drift';
  else if (keywordMiss) suspiciousReason = 'Keyword mismatch';
  else if (genericFailureDetected) suspiciousReason = 'Generic refusal/failure';
  else if (emptyResponse) suspiciousReason = 'Empty response';

  return {
    parseFailure,
    emptyResponse,
    schemaDrift,
    keywordMiss,
    genericFailureDetected,
    answerText,
    suspiciousReason,
  };
}
