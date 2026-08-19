# Phase 3 verification — single-operator application security

Status: **PASS**

- Exactly one active operator is enforced at startup.
- Passwords use Argon2id; session and CSRF tokens are random, opaque, hash-persisted, expiring, and
  revocable.
- Login is IP-rate-limited and identity failures trigger a persistent timed lock.
- Cookies are HttpOnly, SameSite Strict, path-bound, and Secure in production.
- Unsafe authenticated requests use a server-validated CSRF token.
- Production rejects non-HTTPS traffic and emits HSTS/security headers; CORS is allowlisted.
- Payload size, strict input validation, safe errors, backend-only secrets, and critical audit records
  are enforced.

Evidence: authentication lifecycle/brute-force tests and HTTP security integration tests.
