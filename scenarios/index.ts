import dataset from '../fixtures/scenario-dataset.it.json';
import { HarnessConfig, ScenarioDefinition, ScenarioFixtureEntry, ValidationMode } from '../src/types';

function toValidationMode(mode: ValidationMode) {
  return mode;
}

function entryToRequest(entry: ScenarioFixtureEntry) {
  return {
    input: entry.prompt,
    context: entry.conversationHistory,
  };
}

function buildCategoryScenario(name: string, entries: ScenarioFixtureEntry[], concurrency: number): ScenarioDefinition {
  const first = entries[0];
  return {
    name,
    requests: entries.map(entryToRequest),
    concurrency,
    validation: {
      mode: toValidationMode(first.validationMode),
      expectedKeywords: first.expectedKeywords,
      flakySemantic: first.knownFlakySemantic,
      expectedMinimumBehavior: first.expectedMinimumBehavior,
    },
    tags: [first.category, ...first.tags],
  };
}

export function buildScenarios(config: HarnessConfig): ScenarioDefinition[] {
  const entries = dataset as ScenarioFixtureEntry[];
  const byCategory = new Map<string, ScenarioFixtureEntry[]>();

  for (const entry of entries) {
    const bucket = byCategory.get(entry.category) ?? [];
    bucket.push(entry);
    byCategory.set(entry.category, bucket);
  }

  const scenarios: ScenarioDefinition[] = [];

  for (const [category, categoryEntries] of byCategory.entries()) {
    const concurrency = category.includes('long')
      ? 1
      : category.includes('prompt_injection') || category.includes('jailbreak')
      ? 2
      : Math.min(config.maxConcurrency, 6);

    scenarios.push(buildCategoryScenario(category, categoryEntries, concurrency));
  }

  scenarios.push({
    name: 'concurrency-ramp-test',
    requests: Array.from({ length: config.totalRequests }, (_, i) => entryToRequest(entries[i % entries.length])),
    concurrency: config.maxConcurrency,
    validation: { mode: 'latency_only' },
    tags: ['load', 'ramp'],
  });

  scenarios.push({
    name: 'sustained-load-test',
    requests: Array.from({ length: config.totalRequests * 2 }, (_, i) => entryToRequest(entries[i % entries.length])),
    concurrency: Math.max(2, Math.floor(config.maxConcurrency * 0.75)),
    validation: { mode: 'latency_only' },
    tags: ['load', 'sustained'],
  });

  return scenarios;
}

export function profileOverrides(config: HarnessConfig): Partial<HarnessConfig> {
  switch (config.profile) {
    case 'light':
      return { totalRequests: 60, maxConcurrency: 4 };
    case 'medium':
      return { totalRequests: 180, maxConcurrency: 10 };
    case 'heavy':
      return { totalRequests: 400, maxConcurrency: 20, rampSteps: 8 };
    case 'breakpoint':
      return { totalRequests: 200, maxConcurrency: 24, rampSteps: 10 };
    default:
      return {};
  }
}
