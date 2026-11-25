import { describe, it, expect, vi } from 'vitest';
import { lazy, type Lazy } from '../lazy';

describe('lazy evaluation', () => {
  it('defers computation until forced', () => {
    const compute = vi.fn(() => 42);
    const value = lazy(compute);

    expect(compute).not.toHaveBeenCalled();
    expect(value.force()).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('memoizes the evaluated result', () => {
    const compute = vi.fn(() => 7);
    const value = lazy(compute);

    expect(value.force()).toBe(7);
    expect(value.force()).toBe(7);
    expect(value.force()).toBe(7);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('reports whether it has been evaluated', () => {
    const value = lazy(() => 'x');

    expect(value.isEvaluated()).toBe(false);
    value.force();
    expect(value.isEvaluated()).toBe(true);
  });

  it('composes with map', () => {
    const compute = vi.fn(() => 2);
    const mapped = lazy(compute).map((n) => n * 10);

    expect(compute).not.toHaveBeenCalled();
    expect(mapped.force()).toBe(20);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('composes with chain', () => {
    const inner = vi.fn(() => 5);
    const chained = lazy(() => 3).chain((n) => lazy(inner).map((m) => n + m));

    expect(inner).not.toHaveBeenCalled();
    expect(chained.force()).toBe(8);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('caches composed results', () => {
    const compute = vi.fn(() => 4);
    const mapped = lazy(compute).map((n) => n + 1);

    expect(mapped.force()).toBe(5);
    expect(mapped.force()).toBe(5);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('tracks lazy operations', () => {
    const value: Lazy<number> = lazy(() => 1).map((n) => n + 1).chain((n) => lazy(() => n * 2));

    expect(value.operations()).toEqual(['map', 'chain']);
  });
});
