# Pirelli Conversational Sales Chatbot Stress Harness

Node.js + TypeScript + Playwright harness to stress-test an internal chatbot that must act like an expert tyre dealer and guide users toward click-to-buy.

## Internal endpoint
`POST http://agent-gateway-service-qlt.pcons-eks-dev.pirelli.internal/agent-gateway/v1/chat`

> Endpoint is internal: GitHub-hosted runners may not reach it. Prefer self-hosted runners on company network.

## What this evaluates
- technical reliability under load (latency, timeouts, errors, schema drift)
- fitment-flow behavior (asks missing critical questions)
- sales guidance quality (commercial next-step / CTA)
- dealer-like conversation quality
- robustness under confused/adversarial inputs

## Scenario groups
1. Purchase intent
2. Fitment discovery
3. Dealer-like conversation
4. Stress mixed traffic
5. Robustness/adversarial

Dataset: `fixtures/scenario-dataset.it.json` (Italian, 60+ prompts).

## Quick start
```bash
npm ci
npm test
```

Profiles:
```bash
npm run test:profile:light
npm run test:profile:medium
npm run test:profile:heavy
npm run test:profile:breakpoint
```

## Key artifacts
Generated in `reports/`:
- `summary.json`
- `failures.jsonl`
- `scenario-metrics.json`
- `scenario-metrics.csv`
- `sales-metrics.json`
- `conversation-metrics.json`
- `report.html`
- `dashboard.html`
- `executive-summary.md`
- `junit.xml`

## Executive summary output
`executive-summary.md` states clearly:
- where the bot is strong
- where fitment journey fails
- where commercial effectiveness drops
- where technical stress degrades conversations
- estimated safe operating range under concurrency

## Workflows
- `.github/workflows/smoke-tests.yml`
- `.github/workflows/stress-tests.yml`
- `.github/workflows/nightly.yml`
