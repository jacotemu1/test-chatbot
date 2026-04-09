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
  scoring.ts
  suspiciousDetector.ts
  types.ts
  validator.ts
  utils/fs.ts
scenarios/
  index.ts
fixtures/
  prompts.it.json
  scenario-dataset.it.json
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

## Dataset design (Italian, breaking-point focused)
`fixtures/scenario-dataset.it.json` includes 62 categorized prompts and each entry has:
- `id`
- `category`
- `prompt`
- optional `conversationHistory`
- `expectedMinimumBehavior`
- `validationMode`
- `severity`
- `tags`
- optional `expectedKeywords`
- optional `knownFlakySemantic`

### Covered categories
- simple factual requests
- ambiguous prompts
- long and verbose prompts
- repeated prompts
- contradictory instructions
- prompt injection attempts
- jailbreak-style prompts
- malformed input
- emotionally charged prompts
- domain-specific requests
- memory/context consistency checks
- multi-turn follow-ups
- nonsense/gibberish inputs
- adversarial edge cases

### Validation modes
- `non_empty`
- `keyword_match`
- `schema_only`
- `latency_only`
- `safety_check`
- `consistency_check`

## Scoring and suspicious-output logic
Every evaluated response is labeled with:
- `pass`
- `warn`
- `fail`

Hard failures (`fail`) are never suppressed. `knownFlakySemantic: true` can downgrade semantic-only uncertainty into `warn`, but parse/schema/empty/non-200/timeout failures still remain hard failures.

A rule-based suspicious detector flags outputs containing signs of:
- possible secret leakage
- prompt/system-instruction disclosure
- unsafe instruction acceptance
- nonsense/fallback patterns

## Quick start

```bash
npm ci
npm test
```


### Breakpoint discovery mode (automated)
When `CHATBOT_PROFILE=breakpoint`, the runner automatically:
1. starts from low concurrency
2. increases concurrency step-by-step
3. executes enough requests per step (>=50)
4. checks SLA thresholds per step
5. stops at first unstable step
6. estimates safe operating range

Configurable SLA thresholds (env):
- `CHATBOT_BREAKPOINT_MAX_P95_MS`
- `CHATBOT_BREAKPOINT_MAX_TIMEOUT_RATE`
- `CHATBOT_BREAKPOINT_MAX_ERROR_RATE`
- `CHATBOT_BREAKPOINT_MAX_EMPTY_RATE`
- `CHATBOT_BREAKPOINT_MAX_SCHEMA_DRIFT_RATE`

Generated breakpoint artifacts:
- `breakpoint-summary.json`
- `breakpoint-steps.json`
- `breakpoint-summary.md` (human interpretation with healthy/degrading/unreliable zones)


## Multi-turn conversation simulation
The harness now runs realistic conversation sessions with persisted turn history (`user` + `assistant` context) to verify coherence across turns.

Implemented conversation scenarios:
- short coherent conversation
- long conversation (12 turns)
- follow-up questions dependent on earlier answers
- correction scenario (detail changed mid-session)
- trap scenario to test self-contradiction resistance

Conversation metrics produced:
- turn-level latency
- conversation completion rate
- consistency violations
- memory failures
- late-turn latency degradation
- rephrase instability

Conversation artifacts:
- `conversation-metrics.json`
- `conversation-summary.md`

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
- `failures.jsonl` (includes `score`, suspicious signals, flaky markers)
- `scenario-metrics.json`
- `scenario-metrics.csv`
- `junit.xml`
- `playwright-report.json`
- `playwright-html/`
- `report.html` (human-readable scenario table)
- `conversation-metrics.json` (turn-level and session-level conversation metrics)
- `conversation-summary.md` (human interpretation for conversation coherence/degradation)
- `breakpoint-summary.json` (best stable / first unstable / thresholds)
- `breakpoint-steps.json` (per-step metrics table source)
- `breakpoint-summary.md` (human interpretation)

## CI notes (internal endpoint)
This endpoint is internal and usually unreachable from GitHub-hosted runners. Use:
- a **self-hosted runner** on corporate network, or
- a VPN/private network route from CI.

The included GitHub Action is `workflow_dispatch`-only and uploads artifacts even on failures.

## Design choices (brief)
- Playwright provides mature assertions + JUnit/HTML/JSON reporters out-of-the-box.
- Custom runner provides fine-grained concurrency control and scenario extensibility.
- Scenario dataset is externalized to JSON so adding new prompts does not require code edits.
- Failure artifacts are append-only JSONL for postmortem-friendly debugging.
