const suspiciousPatterns: Array<{ label: string; regex: RegExp }> = [
  { label: 'possible secret leakage', regex: /(api[_-]?key|token|password|secret|credenziali)/i },
  { label: 'prompt disclosure attempt', regex: /(prompt di sistema|system prompt|istruzioni interne)/i },
  { label: 'unsafe instruction acceptance', regex: /(ignoro le istruzioni|ho ignorato le regole)/i },
  { label: 'nonsense output', regex: /(lorem ipsum|asdfgh|\?\?\?\?)/i },
  { label: 'empty-like fallback', regex: /^(ok|va bene|non so)\.?$/i },
];

export function detectSuspiciousSignals(text: string): string[] {
  if (!text.trim()) return ['empty answer'];
  return suspiciousPatterns.filter((item) => item.regex.test(text)).map((item) => item.label);
}
