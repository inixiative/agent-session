// Native envelopes are JSON data. Take ownership once, before exposing them to
// observers, then share deeply frozen evidence across histories and snapshots.
// Do not traverse/copy the accumulated transcript when a new event arrives.
const owned = new WeakSet<object>();

export function retainEvidence<T>(value: T): T {
  if (value === null || typeof value !== "object" || owned.has(value)) return value;
  const copy = structuredClone(value);
  const pending: object[] = [copy];
  while (pending.length) {
    const item = pending.pop()!;
    if (owned.has(item)) continue;
    owned.add(item);
    for (const nested of Object.values(item)) {
      if (nested !== null && typeof nested === "object") pending.push(nested);
    }
    Object.freeze(item);
  }
  return copy;
}
