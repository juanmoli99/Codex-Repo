# Production deployment

Production runs only from immutable containers. `pnpm dev`, a developer PowerShell session, a local
`.env`, floating image tags, and direct public exposure of PostgreSQL or the backend are prohibited.

## Isolation

PAPER and LIVE use different hosts or namespaces, Docker project names, PostgreSQL volumes/databases,
Alpaca credentials, signing keys, TOTP secrets, Telegram credentials, TLS keys, backup prefixes, and
deployment IDs. Never change `TRADING_MODE` in place. Build and validate a second isolated deployment.

## One-time host controls

1. Install a supported Docker Engine/Compose release, enable automatic security updates, and configure
   `chrony`/NTP using `infra/time-sync.md`.
2. Permit inbound traffic only from the operator VPN/bastion to the selected HTTPS port. Deny public
   access to Docker, PostgreSQL and port 3000. Restrict outbound traffic to DNS/NTP, Alpaca HTTPS/WSS,
   Telegram HTTPS, the image registry and the backup object store.
3. Install a trusted TLS certificate/key. The bundled unprivileged proxy serves TLS 1.2/1.3 and binds
   to loopback by default; publish it only through the VPN or a hardened host reverse proxy.
4. Create the named Docker secrets listed in `infra/.env.example`. Secret values must come from the
   organization password/secret manager, not shell history or repository files. The database URL must
   use host `postgres`, port `5432`, the matching password, and `sslmode=disable` only because it travels
   exclusively on the internal Docker network.
5. Configure log shipping and retention on the container host. Application JSON logs are duplicated to
   stdout; the deployment uses an ephemeral local log directory and expects the container runtime to
   rotate/forward stdout.

## Release and start

1. Protect `main` as described in `docs/engineering/repository-controls.md` and require green CI.
2. Create a signed `v*` tag. Record the resulting backend, frontend, watchdog and backup SHA-256 image
   digests plus the exact Git SHA. Never substitute a mutable tag.
3. Copy `infra/.env.example` to a deployment-only non-secret environment file and fill image digests,
   release SHA, origins and Docker-secret names. It contains no secret values.
4. Validate configuration with `docker compose --env-file deployment.env -f infra/compose.yaml config`.
5. Run `docker compose --env-file deployment.env -f infra/compose.yaml up -d`. The one-shot migration
   service must finish successfully before the trading runtime starts. Startup always disables entries,
   recovers interrupted work and reconciles with the broker.
6. Verify the TLS UI, `/health/live`, `/health/ready`, watchdog delivery and offsite backup profile.
   Inspect container resource use and clock skew.

Only one backend replica is allowed for the initial release. PostgreSQL advisory locks and fencing
tokens protect scheduler/execution paths, but a blue/green cutover still stops or disables entries on
the old leader before starting the new one. Every new LIVE process revokes prior activation and returns
to `ONLY_CLOSE`; a fresh readiness assessment, password reauthentication, TOTP and one-use activation
challenge are required.

## Rollback

Disable entries and stop the scheduler, reconcile, then replace all four image digests with the
previous known-good release set. Database migrations are forward-only: rollback uses an application
version compatible with the current schema. If compatibility is not documented, restore the verified
backup into a new database/host and follow `docs/operations/backups.md`; never run destructive
down-migrations in place.
