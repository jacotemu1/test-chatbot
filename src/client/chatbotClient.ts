import { randomUUID } from 'node:crypto';
import { ChatPayload, ChatResult, HarnessConfig } from '../types';

export class ChatbotClient {
  constructor(private readonly config: HarnessConfig) {}

  async send(payload: ChatPayload, scenario: string, timeoutMs?: number): Promise<ChatResult> {
    const requestId = randomUUID();
    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    const effectiveTimeout = timeoutMs ?? this.config.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), effectiveTimeout);
    const start = performance.now();

    try {
      const res = await fetch(this.config.chatbotUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.authToken ? { authorization: `Bearer ${this.config.authToken}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const rawBody = await res.text();
      let parsedBody: unknown;
      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
      } catch {
        parsedBody = undefined;
      }

      return {
        scenario,
        requestId,
        startedAt,
        latencyMs: Math.round(performance.now() - start),
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        rawBody,
        parsedBody,
        timedOut: false,
      };
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      return {
        scenario,
        requestId,
        startedAt,
        latencyMs: Math.round(performance.now() - start),
        error: error instanceof Error ? error.message : String(error),
        timedOut: isTimeout,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
