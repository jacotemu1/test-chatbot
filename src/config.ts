import dotenv from 'dotenv';
import { HarnessConfig, Profile } from './types';

dotenv.config();

function toNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toRatio(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
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
    breakpointThresholds: {
      maxP95LatencyMs: toNumber(process.env.CHATBOT_BREAKPOINT_MAX_P95_MS, 2500),
      maxTimeoutRate: toRatio(process.env.CHATBOT_BREAKPOINT_MAX_TIMEOUT_RATE, 0.03),
      maxErrorRate: toRatio(process.env.CHATBOT_BREAKPOINT_MAX_ERROR_RATE, 0.05),
      maxEmptyResponseRate: toRatio(process.env.CHATBOT_BREAKPOINT_MAX_EMPTY_RATE, 0.05),
      maxSchemaDriftRate: toRatio(process.env.CHATBOT_BREAKPOINT_MAX_SCHEMA_DRIFT_RATE, 0.05),
    },
    ui: {
      url: process.env.CHATBOT_UI_URL,
      agentSelector: process.env.CHATBOT_AGENT_SELECTOR,
      agentOptionText: process.env.CHATBOT_AGENT_OPTION_TEXT,
      localeSelector: process.env.CHATBOT_LOCALE_SELECTOR,
      localeOptionText: process.env.CHATBOT_LOCALE_OPTION_TEXT,
      newSessionSelector: process.env.CHATBOT_NEW_SESSION_SELECTOR,
      inputSelector: process.env.CHATBOT_INPUT_SELECTOR,
      sendButtonSelector: process.env.CHATBOT_SEND_BUTTON_SELECTOR,
      responseSelector: process.env.CHATBOT_RESPONSE_SELECTOR,
      conversationPanelSelector: process.env.CHATBOT_CONVERSATION_PANEL_SELECTOR,
    },
  };
}
