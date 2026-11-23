import { BudgetTracker } from '../budgetTracker';

describe('BudgetTracker', () => {
  it('tracks cumulative spend and remaining budget', () => {
    const tracker = new BudgetTracker({ limit: 100 });
    tracker.track(30);
    tracker.track(20);
    expect(tracker.getSpent()).toBe(50);
    expect(tracker.getRemaining()).toBe(50);
    expect(tracker.isLimitReached()).toBe(false);
  });

  it('emits a warning when spend approaches the limit', () => {
    const tracker = new BudgetTracker({ limit: 100, warnThreshold: 0.8 });
    const listener = jest.fn();
    tracker.on('warning', listener);

    tracker.track(79);
    expect(listener).not.toHaveBeenCalled();

    tracker.track(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      event: 'warning',
      spent: 80,
      limit: 100,
      remaining: 20,
    });
  });

  it('emits the warning only once', () => {
    const tracker = new BudgetTracker({ limit: 100 });
    const listener = jest.fn();
    tracker.on('warning', listener);

    tracker.track(85);
    tracker.track(5);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('emits limit-reached when spend meets or exceeds the limit', () => {
    const tracker = new BudgetTracker({ limit: 100 });
    const listener = jest.fn();
    tracker.on('limit-reached', listener);

    tracker.track(100);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      event: 'limit-reached',
      spent: 100,
      limit: 100,
      remaining: 0,
    });
    expect(tracker.isLimitReached()).toBe(true);
  });

  it('emits limit-reached only once and clamps remaining at zero', () => {
    const tracker = new BudgetTracker({ limit: 100 });
    const listener = jest.fn();
    tracker.on('limit-reached', listener);

    tracker.track(120);
    tracker.track(10);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(tracker.getRemaining()).toBe(0);
  });

  it('supports unsubscribing from events', () => {
    const tracker = new BudgetTracker({ limit: 100 });
    const listener = jest.fn();
    const unsubscribe = tracker.on('warning', listener);

    unsubscribe();
    tracker.track(90);
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects invalid configuration and amounts', () => {
    expect(() => new BudgetTracker({ limit: 0 })).toThrow();
    expect(() => new BudgetTracker({ limit: 100, warnThreshold: 1 })).toThrow();

    const tracker = new BudgetTracker({ limit: 100 });
    expect(() => tracker.track(-1)).toThrow();
  });

  it('rejects non-finite amounts', () => {
    const tracker = new BudgetTracker({ limit: 100 });
    expect(() => tracker.track(NaN)).toThrow();
    expect(() => tracker.track(Infinity)).toThrow();
  });
});
