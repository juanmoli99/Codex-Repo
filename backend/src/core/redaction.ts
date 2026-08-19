const SECRET_KEY_PATTERN = /authorization|cookie|password|secret|token|api[-_]?key/i;

export function redactSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactSecrets(item, seen),
    ]),
  );
}
