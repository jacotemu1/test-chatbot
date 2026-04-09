export type Profile = 'light' | 'medium' | 'heavy' | 'breakpoint';

export interface HarnessConfig {
  chatbotUrl: string;
  authToken?: string;
  timeoutMs: number;
  maxConcurrency: number;
  rampSteps: number;
  totalRequests: number;
  outputDir: string;
  profile: Profile;
}

export interface ChatPayload {
  input: string;
  conversationId?: string;
  context?: Array<{ role: string; content: string }>;
  [key: string]: unknown;
}

export interface ChatResult {
  scenario: string;
  requestId: string;
  startedAt: string;
  latencyMs: number;
  status?: number;
  headers?: Record<string, string>;
  rawBody?: string;
  parsedBody?: unknown;
  error?: string;
  timedOut: boolean;
}

export interface ValidationRule {
  expectedKeywords?: string[];
  jsonSchema?: object;
  answerPath?: string;
}

export interface ValidationOutcome {
  parseFailure: boolean;
  emptyResponse: boolean;
  schemaDrift: boolean;
  keywordMiss: boolean;
  genericFailureDetected: boolean;
  answerText?: string;
  suspiciousReason?: string;
}

export interface ScenarioDefinition {
  name: string;
  requests: ChatPayload[];
  concurrency: number;
  timeoutMs?: number;
  validation?: ValidationRule;
  tags?: string[];
}

export interface ScenarioMetrics {
  name: string;
  total: number;
  successRate: number;
  p50: number;
  p95: number;
  p99: number;
  timeoutCount: number;
  non200Count: number;
  parseFailureCount: number;
  emptyResponseCount: number;
  schemaDriftCount: number;
  duplicateResponseRatio: number;
  answerLengthAvg: number;
  failures: number;
}
