# AGENTS.md

Guidance for coding agents working in this repository.

## Purpose and scope
This repository is an **internal chatbot stress-testing tool**.
- Treat it as an internal reliability/robustness harness.
- Do **not** evolve it into a general-purpose public SDK.

## Core engineering principles
1. **Preserve simplicity and readability**
   - Prefer straightforward code paths over clever abstractions.
   - Keep functions focused and files easy to scan.
2. **Prefer deterministic tests when possible**
   - Unit/validation logic should be deterministic.
   - Isolate nondeterministic network behavior behind explicit scenario/test boundaries.
3. **Separate transport failures from quality failures**
   - Transport failures: timeouts, DNS/network errors, non-200, malformed payload handling.
   - Quality failures: empty answers, schema drift, consistency violations, suspicious outputs.
   - Report both categories separately in metrics and summaries.
4. **Always save debugging artifacts on failure**
   - Persist failed request/response metadata and validation context.
   - Favor append-only artifacts (`.jsonl`) for postmortems.
5. **Never hide flaky behavior silently**
   - Flaky semantic cases may be marked, but must remain visible as warnings.
   - Hard failures must never be downgraded silently.
6. **Keep scenario fixtures easy to edit**
   - Use plain JSON fixtures with explicit fields.
   - Avoid opaque generator logic when static fixtures are sufficient.
7. **Avoid unnecessary frameworks**
   - Keep stack minimal (Node.js/TypeScript/Playwright + lightweight libs only).
8. **Document schema assumptions**
   - Any assumption about chatbot response schema must be documented in code comments and README.
9. **Prefer configuration over hardcoded values**
   - Use env vars/config for thresholds, profiles, endpoints, and limits.
10. **Keep reports human-readable**
    - Provide concise markdown/HTML summaries, not only raw JSON dumps.

## Repository conventions

### Folder structure
- `src/` core logic (client, runner, validator, metrics, scoring, helpers)
- `scenarios/` scenario builders and conversation scenarios
- `fixtures/` editable scenario/prompt datasets
- `tests/` Playwright tests and quality gates
- `reports/` generated outputs only (not source)
- `.github/workflows/` CI workflows

### Naming
- Use `kebab-case` for artifact filenames and workflow files.
- Use `camelCase` for variables/functions.
- Use descriptive scenario names (e.g., `trap-self-contradiction-scenario`).
- Prefer explicit metric names (`timeoutRate`, `schemaDriftCount`) over abbreviations.

### Test tags and scenario tags
- Keep scenario tags short, readable, and filter-friendly.
- Recommended tags: `smoke`, `load`, `conversation`, `safety`, `schema`, `adversarial`, `breakpoint`.
- If adding new tag families, document them in README.

### Artifact naming
- Core artifacts should remain stable:
  - `summary.json`
  - `scenario-metrics.json`
  - `scenario-metrics.csv`
  - `failures.jsonl`
  - `report.html`
  - `dashboard.html`
  - `conversation-metrics.json`
  - `conversation-summary.md`
  - `breakpoint-summary.json`
  - `breakpoint-steps.json`
  - `breakpoint-summary.md`
- Do not rename existing artifacts without updating tests, workflows, and README.

### Handling secrets
- Never hardcode secrets or tokens.
- Use env vars and GitHub Secrets (`CHATBOT_AUTH_TOKEN`, `CHATBOT_URL`, etc.).
- Never print sensitive values in logs/artifacts.
- If adding debug output, redact token-like fields by default.

## Change management expectations
- Keep changes pragmatic and incremental.
- Update tests and README when behavior or artifact contracts change.
- Preserve backward compatibility of artifact structure whenever feasible.
