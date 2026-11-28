import { EventEmitter } from 'events';

export interface PortfolioScenario {
  id: string;
  name?: string;
  initialValue: number;
  expectedReturn: number;
  volatility: number;
  horizonYears: number;
}

export interface ScenarioResult {
  id: string;
  name?: string;
  finalValue: number;
  totalReturn: number;
  annualizedReturn: number;
  success: boolean;
  error?: string;
}

export interface BatchSimulationSummary {
  totalScenarios: number;
  succeeded: number;
  failed: number;
  aggregateFinalValue: number;
  aggregateReturn: number;
  averageAnnualizedReturn: number;
  results: ScenarioResult[];
}

export interface BatchSimulatorOptions {
  /** Number of scenarios simulated concurrently. Defaults to 1 (sequential). */
  concurrency?: number;
  /** Optional deterministic RNG hook for testing. Returns [0, 1). */
  random?: () => number;
}

export interface BatchSimulatorEvents {
  'batch:start': (payload: { totalScenarios: number }) => void;
  'scenario:start': (payload: { id: string; index: number }) => void;
  'scenario:complete': (payload: { id: string; index: number; result: ScenarioResult }) => void;
  'scenario:error': (payload: { id: string; index: number; error: Error }) => void;
  'batch:progress': (payload: { completed: number; total: number }) => void;
  'batch:complete': (payload: BatchSimulationSummary) => void;
  'batch:error': (payload: { error: Error }) => void;
}

/**
 * Simulates a single portfolio scenario using a geometric-Brownian-motion
 * style model. Deterministic when a `random` hook is supplied.
 */
export function simulateScenario(
  scenario: PortfolioScenario,
  random: () => number = Math.random,
): ScenarioResult {
  if (!Number.isFinite(scenario.initialValue) || scenario.initialValue < 0) {
    throw new Error(`Invalid initialValue for scenario "${scenario.id}"`);
  }
  if (!Number.isFinite(scenario.horizonYears) || scenario.horizonYears <= 0) {
    throw new Error(`Invalid horizonYears for scenario "${scenario.id}"`);
  }

  const steps = Math.max(1, Math.round(scenario.horizonYears * 12));
  const monthlyDrift = scenario.expectedReturn / 12;
  const monthlyVol = scenario.volatility / Math.sqrt(12);

  let value = scenario.initialValue;
  for (let i = 0; i < steps; i += 1) {
    // Box-Muller transform for a standard normal sample.
    const u1 = Math.max(random(), Number.EPSILON);
    const u2 = random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    value *= 1 + monthlyDrift + monthlyVol * z;
    if (value < 0) {
      value = 0;
    }
  }

  const finalValue = value;
  const totalReturn = scenario.initialValue === 0 ? 0 : finalValue / scenario.initialValue - 1;
  const annualizedReturn =
    scenario.initialValue === 0 || finalValue <= 0
      ? 0
      : Math.pow(finalValue / scenario.initialValue, 1 / scenario.horizonYears) - 1;

  return {
    id: scenario.id,
    name: scenario.name,
    finalValue,
    totalReturn,
    annualizedReturn,
    success: true,
  };
}

/**
 * Runs a batch of portfolio scenarios, emitting lifecycle events and
 * aggregating the results. Individual scenario failures are captured and
 * reported without aborting the whole batch.
 */
export class BatchSimulator extends EventEmitter {
  private readonly concurrency: number;
  private readonly random: () => number;

  constructor(options: BatchSimulatorOptions = {}) {
    super();
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
    this.random = options.random ?? Math.random;
  }

  public async run(scenarios: PortfolioScenario[]): Promise<BatchSimulationSummary> {
    const total = scenarios.length;
    this.emit('batch:start', { totalScenarios: total });

    const results: ScenarioResult[] = new Array(total);
    let completed = 0;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < total) {
        const index = cursor;
        cursor += 1;
        const scenario = scenarios[index]!;
        this.emit('scenario:start', { id: scenario.id, index });
        try {
          const result = simulateScenario(scenario, this.random);
          results[index] = result;
          this.emit('scenario:complete', { id: scenario.id, index, result });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          results[index] = {
            id: scenario.id,
            name: scenario.name,
            finalValue: 0,
            totalReturn: 0,
            annualizedReturn: 0,
            success: false,
            error: error.message,
          };
          this.emit('scenario:error', { id: scenario.id, index, error });
        } finally {
          completed += 1;
          this.emit('batch:progress', { completed, total });
        }
      }
    };

    try {
      const workers = Array.from(
        { length: Math.min(this.concurrency, Math.max(1, total)) },
        () => worker(),
      );
      await Promise.all(workers);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('batch:error', { error });
      throw error;
    }

    const summary = this.aggregate(results);
    this.emit('batch:complete', summary);
    return summary;
  }

  private aggregate(results: ScenarioResult[]): BatchSimulationSummary {
    const succeeded = results.filter((r) => r.success);
    const failed = results.length - succeeded.length;
    const aggregateFinalValue = succeeded.reduce((sum, r) => sum + r.finalValue, 0);
    const aggregateReturn =
      succeeded.length === 0
        ? 0
        : succeeded.reduce((sum, r) => sum + r.totalReturn, 0) / succeeded.length;
    const averageAnnualizedReturn =
      succeeded.length === 0
        ? 0
        : succeeded.reduce((sum, r) => sum + r.annualizedReturn, 0) / succeeded.length;

    return {
      totalScenarios: results.length,
      succeeded: succeeded.length,
      failed,
      aggregateFinalValue,
      aggregateReturn,
      averageAnnualizedReturn,
      results,
    };
  }
}

export default BatchSimulator;
