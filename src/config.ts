import dotenv from 'dotenv';
import { HarnessConfig, Profile } from './types';

dotenv.config();

function toNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toProfile(value: string | undefined): Profile {
  if (value === 'light' || value === 'medium' || value === 'heavy' || value === 'breakpoint') {
    return value;
  }
  return 'light';
}

export function loadConfig(): HarnessConfig {
  const chatbotUrl = process.env.CHATBOT_URL ??
    'http://agent-gateway-service-qlt.pcons-eks-dev.pirelli.internal/agent-gateway/v1/chat';

  return {
    chatbotUrl,
    authToken: process.env.CHATBOT_AUTH_TOKEN,
    timeoutMs: toNumber(process.env.CHATBOT_TIMEOUT_MS, 15_000),
    maxConcurrency: toNumber(process.env.CHATBOT_MAX_CONCURRENCY, 8),
    rampSteps: toNumber(process.env.CHATBOT_RAMP_STEPS, 6),
    totalRequests: toNumber(process.env.CHATBOT_TOTAL_REQUESTS, 100),
    outputDir: process.env.CHATBOT_OUTPUT_DIR ?? 'reports',
    profile: toProfile(process.env.CHATBOT_PROFILE),
  };
}
