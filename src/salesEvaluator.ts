import { SalesSignals } from './types';

const clarifyingPatterns = [/(size|year|model|trim|mileage|usage|load index|speed rating|vehicle)/i, /\?/];
const recommendationPatterns = /(i recommend|best option|you should choose|go for|recommended tyre)/i;
const ctaPatterns = /(buy now|checkout|add to cart|book fitting|next step|proceed to purchase|click to buy)/i;
const genericPatterns = /(i am not sure|it depends only|consult an expert|cannot help|how can i help you today)/i;
const unsafeFitmentPatterns = /(fits any car|size does not matter|install without checks|no need to verify fitment)/i;

function containsAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

export function evaluateSalesSignals(userPrompt: string, answer: string): SalesSignals {
  const promptLower = userPrompt.toLowerCase();
  const answerLower = answer.toLowerCase();

  const needsFitmentClarification = /(car|vehicle|tyre|tire|size|suv|hatchback|sedan)/i.test(promptLower)
    && !/(\d{3}\/\d{2}\s?r\d{2}|\d{2,3}\s*\/\s*\d{2})/i.test(promptLower);

  const askedClarifyingQuestion = needsFitmentClarification && containsAny(answer, clarifyingPatterns);
  const hasCommercialCta = ctaPatterns.test(answerLower);
  const gaveRecommendation = recommendationPatterns.test(answerLower);
  const earlyRecommendation = needsFitmentClarification && gaveRecommendation && !askedClarifyingQuestion;

  return {
    askedClarifyingQuestion,
    earlyRecommendation,
    hasCommercialCta,
    tooGeneric: genericPatterns.test(answerLower),
    potentialUnsafeFitment: unsafeFitmentPatterns.test(answerLower),
  };
}
