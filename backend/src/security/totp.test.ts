import { describe, expect, it } from 'vitest';

import { verifyTotp } from './totp.js';

describe('verifyTotp', () => {
  it('accepts the RFC 6238 SHA-1 vector after truncating it to six digits', () => {
    expect(verifyTotp('287082', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', new Date(59_000), 0)).toBe(
      true,
    );
  });

  it('rejects malformed and distant codes', () => {
    expect(verifyTotp('abc', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')).toBe(false);
    expect(verifyTotp('287082', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', new Date(590_000), 0)).toBe(
      false,
    );
  });
});
