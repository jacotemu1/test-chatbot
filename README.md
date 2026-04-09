# Chatbot Stress Harness (TypeScript + Playwright)

A pragmatic, GitHub-ready stress and robustness testing robot for internal chatbot APIs.

> **Target endpoint (default):**
> `POST http://agent-gateway-service-qlt.pcons-eks-dev.pirelli.internal/agent-gateway/v1/chat`

## Why this project
This harness is focused on **breaking points**, not only correctness. It helps you measure:
- max sustainable throughput
- latency degradation under load
- timeout behavior
- malformed / partial / empty responses
- schema instability
- adversarial prompt robustness (jailbreak/injection)
- long-context / repeated prompt behavior
- error distribution by scenario

## Stack
- Node.js + TypeScript
- Playwright Test for orchestration + assertions + JUnit/HTML/JSON test reports
- Modular stress runner with controlled concurrency

## Project structure

```text
src/
  client/chatbotClient.ts
  config.ts
  metrics.ts
  runner.ts
  types.ts
  validator.ts
  utils/fs.ts
scenarios/
  index.ts
fixtures/
  prompts.it.json
tests/
  chatbot.spec.ts
reports/                 # generated artifacts
.github/workflows/
  chatbot-stress.yml
```

## Environment variables
- `CHATBOT_URL`
- `CHATBOT_AUTH_TOKEN` (optional)
- `CHATBOT_TIMEOUT_MS`
- `CHATBOT_MAX_CONCURRENCY`
- `CHATBOT_RAMP_STEPS`
- `CHATBOT_TOTAL_REQUESTS`
- `CHATBOT_OUTPUT_DIR`
- `CHATBOT_PROFILE` (`light|medium|heavy|breakpoint`)

Copy `.env.example` to `.env` and customize.

## Quick start

```bash
npm ci
npm test
```

## Available scenario coverage
- smoke
- baseline functional prompts
- concurrency ramp test
- sustained load test
- spike test
- long-input / token-heavy test
- multi-turn conversation test
- repeated prompt stability test
- adversarial jailbreak/prompt-injection test
- invalid payload / edge-case payload test

## Stress profiles
- `light` – quick signal
- `medium` – balanced
- `heavy` – aggressive
- `breakpoint` – progressive concurrency search until SLA break conditions

Run profiles:

```bash
npm run test:profile:light
npm run test:profile:medium
npm run test:profile:heavy
npm run test:profile:breakpoint
```

Breakpoint search increases concurrency stepwise and records where success rate drops below 95% or p95 exceeds 2500ms.

## Output artifacts
Generated in `CHATBOT_OUTPUT_DIR` (default `reports/`):
- `summary.json`
- `failures.jsonl`
- `scenario-metrics.json`
- `scenario-metrics.csv`
- `junit.xml`
- `playwright-report.json`
- `playwright-html/`
- `report.html` (human-readable scenario table)

## Validation and suspicious-output detection
For each response, the harness captures:
- HTTP status, headers, raw body, parsed body, latency, timeout/errors
- parse failures and empty answer detection
- configurable schema validation (AJV)
- optional keyword expectations
- generic refusal/failure phrase detection
- failed and suspicious request/response artifacts in `failures.jsonl`

## CI notes (internal endpoint)
This endpoint is internal and usually unreachable from GitHub-hosted runners. Use:
- a **self-hosted runner** on corporate network, or
- a VPN/private network route from CI.

The included GitHub Action is `workflow_dispatch`-only and uploads artifacts even on failures.

## Design choices (brief)
- Playwright provides mature assertions + JUnit/HTML/JSON reporters out-of-the-box.
- Custom runner provides fine-grained concurrency control and scenario extensibility.
- Scenario definitions and fixtures are separated for easy dataset growth (including Italian starter prompts).
- Failure artifacts are append-only JSONL for postmortem-friendly debugging.
