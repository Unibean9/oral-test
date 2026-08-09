/**
 * Indirection that lets a test substitute an exported function. Necessary because a module
 * namespace object is immutable under ESM - `ns.fn = stub` and `mock.method(ns, 'fn', stub)`
 * both throw under `tsx`, since the namespace's property descriptor is `configurable: false`. An
 * exported `const` bound to this wrapper is the only substitution point that works without
 * spawning a real `claude` binary. Deliberately indirection ONLY: the replacement lives in a
 * closure reachable exclusively through `setForTests`, so nothing at runtime can switch it.
 */
export type Seam<F extends (...args: never[]) => unknown> = F & {
  /** Substitute the implementation; pass `null` to restore the original. Tests only. */
  setForTests(fn: F | null): void;
};

export function seam<F extends (...args: never[]) => unknown>(impl: F): Seam<F> {
  let current = impl;
  const wrapper = ((...args: Parameters<F>) => current(...(args as never[]))) as Seam<F>;
  wrapper.setForTests = (fn: F | null) => { current = fn ?? impl; };
  return wrapper;
}
