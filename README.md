# Pirelli Conversational Sales Chatbot Stress Harness

A pragmatic Node.js + TypeScript + Playwright project for stress-testing a Pirelli chatbot that should behave like an expert tyre dealer and drive users toward click-to-buy.

## Target endpoint
`POST http://agent-gateway-service-qlt.pcons-eks-dev.pirelli.internal/agent-gateway/v1/chat`

> Internal endpoint: GitHub-hosted runners may not reach it. Use self-hosted runners on internal network when needed.

## What this harness evaluates
- technical reliability under stress (throughput, latency, timeout, non-200, parse/schema issues)
- fitment-flow quality (asks missing critical questions before recommendations)
- commercial effectiveness (next-step CTA, purchase progression)
- dealer-like answer quality (not generic assistant behavior)
- robustness under confused, adversarial, emotional, and contradictory inputs

## Scenario groups
- purchase intent
- fitment discovery
- dealer-like conversation
- stress mixed traffic
- robustness

Dataset: `fixtures/scenario-dataset.it.json` (English prompts, 60+ entries).

## Run locally
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

## Investigation artifacts
Generated in `reports/`:
- `summary.json`
- `scenario-metrics.json`
- `sales-metrics.json`
- `conversation-metrics.json`
- `failures.jsonl`
- `report/index.html` (main executive investigation report)
- `conversations/*.json|*.md|*.html` (full transcripts)
- `screenshots/*.png` (failed/warn + sample pass rendered conversation pages)
- `top-10-worst-conversations.json`
- `top-10-suspicious-answers.json`
- `top-10-commercially-ineffective.json`
- `job-summary.md` (for GitHub Actions summary)
- `junit.xml`

## CI workflows
- `smoke-tests.yml`
- `stress-tests.yml`
- `nightly.yml`

All workflows upload artifacts and publish `reports/job-summary.md` to GitHub step summary when present.
