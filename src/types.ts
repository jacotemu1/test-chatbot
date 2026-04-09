export type Profile = 'light' | 'medium' | 'heavy' | 'breakpoint';

export type ValidationMode =
  | 'non_empty'
  | 'keyword_match'
  | 'schema_only'
  | 'latency_only'
  | 'safety_check'
  | 'consistency_check';

export type ScoreLabel = 'pass' | 'warn' | 'fail';

export interface BreakpointThresholds {
  maxP95LatencyMs: number;
  maxTimeoutRate: number;
  maxErrorRate: number;
  maxEmptyResponseRate: number;
  maxSchemaDriftRate: number;
}

export interface HarnessConfig {
  chatbotUrl: string;
  authToken?: string;
  timeoutMs: number;
  maxConcurrency: number;
  rampSteps: number;
  totalRequests: number;
  outputDir: string;
  profile: Profile;
  breakpointThresholds: BreakpointThresholds;
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
  mode?: ValidationMode;
  flakySemantic?: boolean;
  expectedMinimumBehavior?: string;
}

export interface ValidationOutcome {
  parseFailure: boolean;
  emptyResponse: boolean;
  schemaDrift: boolean;
  keywordMiss: boolean;
  genericFailureDetected: boolean;
  suspiciousSignals: string[];
  answerText?: string;
  suspiciousReason?: string;
  score: ScoreLabel;
  knownFlakySemantic: boolean;
}

export interface ScenarioFixtureEntry {
  id: string;
  category: string;
  prompt: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  expectedMinimumBehavior: string;
  validationMode: ValidationMode;
  severity: 'low' | 'medium' | 'high' | 'critical';
  tags: string[];
  expectedKeywords?: string[];
  knownFlakySemantic?: boolean;
}

export interface ScenarioDefinition {
  name: string;
  requests: ChatPayload[];
  concurrency: number;
  timeoutMs?: number;
  validation?: ValidationRule;
  tags?: string[];
}

export interface ConversationTurn {
  id: string;
  userPrompt: string;
  expectKeywords?: string[];
  contradictionWithTurnId?: string;
  memoryCheckForTurnId?: string;
  rephraseGroup?: string;
}

export interface ConversationScenario {
  name: string;
  description: string;
  turns: ConversationTurn[];
}

export interface ConversationRunMetrics {
  scenario: string;
  totalTurns: number;
  completedTurns: number;
  completionRate: number;
  turnLatenciesMs: number[];
  avgTurnLatencyMs: number;
  lateTurnLatencyGrowthRatio: number;
  consistencyViolations: number;
  memoryFailures: number;
  unstableRephraseCount: number;
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
  warns: number;
}

export interface BreakpointStepMetrics {
  concurrency: number;
  total: number;
  p95LatencyMs: number;
  timeoutRate: number;
  errorRate: number;
  emptyResponseRate: number;
  schemaDriftRate: number;
  healthy: boolean;
  violations: string[];
}
