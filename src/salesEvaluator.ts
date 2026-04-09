import { SalesSignals } from './types';

const clarifyingPatterns = [/(misura|anno|modello|allestimento|chilometri|utilizzo|dimensione|larghezza)/i, /\?/];
const recommendationPatterns = /(ti consiglio|raccomando|scelta migliore|miglior pneumatico|prendi questo)/i;
const ctaPatterns = /(acquista|compra|aggiungi al carrello|clicca|prenota|procedi all'ordine|vai al checkout)/i;
const genericPatterns = /(non so|dipende|consulta un esperto|non posso aiutarti|come posso aiutarti oggi)/i;
const unsafeFitmentPatterns = /(va bene per qualsiasi auto|misura non importante|monta senza verifiche|non serve controllare)/i;

function containsAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

export function evaluateSalesSignals(userPrompt: string, answer: string): SalesSignals {
  const promptLower = userPrompt.toLowerCase();
  const answerLower = answer.toLowerCase();

  const needsFitmentClarification = /(auto|veicolo|misura|pneumatic|gomme|suv|berlina)/i.test(promptLower)
    && !/(\d{3}\/\d{2}\s?r\d{2}|misura\s+\d)/i.test(promptLower);

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
