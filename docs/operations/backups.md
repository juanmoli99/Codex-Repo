# Backup and disaster-recovery runbook

## Policy

Production creates a transactionally consistent PostgreSQL custom-format backup every 24 hours. Each
backup is catalog-validated, hashed with SHA-256, accompanied by a JSON manifest, uploaded over TLS to
private S3-compatible storage outside the application host, and verified by reading its remote checksum
back. Every uploaded object requests server-side AES-256 encryption by default; production may select
`aws:kms` and a dedicated KMS key. Local staging files are retained for 14 days. Upload completion is
stored as `COMPLETED`; only a successful isolated restore may promote the record to `VERIFIED`.

The offsite bucket must enforce encryption at rest, versioning, object lock where available, access
logging, and backup-writer credentials that can create/read objects only under the AEGIS prefix. The
credential must not be allowed to delete objects or alter lifecycle/object-lock policy.

Definitive retention is:

- 35 daily restore points;
- 12 end-of-month restore points;
- 7 end-of-year restore points.

Bucket lifecycle rules implement offsite retention. Local retention is only a staging/rapid-recovery
cache and is not a substitute for offsite copies.

## Operation

1. Copy `infra/.env.example` to a secret deployment environment and replace every placeholder.
2. Configure `BACKUP_S3_URI` outside the primary host and verify the write-only backup identity.
3. Start `docker compose --profile backup up -d` from `infra/`.
4. Monitor the backup container, object-store access logs, and `backup_records`; a missing daily object
   is a critical alert.
5. Never mark a backup verified merely because upload succeeded. Verification requires a restore drill.

## Restore drill

Run at least monthly and after any PostgreSQL major-version or schema change. The target database name
must contain `restore_drill`; both supplied drill scripts reject broader targets.

On Windows/local PostgreSQL:

```powershell
./scripts/backup-drill.ps1 -SourceDatabaseUrl $env:DATABASE_URL
```

In the backup container or Linux recovery host:

```sh
BACKUP_FILE=/backups/aegis.dump \
BACKUP_CHECKSUM_FILE=/backups/aegis.dump.sha256 \
BACKUP_OBJECT_KEY=s3://private-offsite-bucket/aegis/aegis.dump \
BACKUP_SOURCE_HOST=production-db-host \
CONTROL_DATABASE_URL=postgresql://aegis@control-host/aegis \
RESTORE_DATABASE_URL=postgresql://aegis@restore-host/aegis_restore_drill \
  /usr/local/bin/aegis-restore-and-verify
```

The drill checks the checksum, backup catalog, complete restore, migration ledger, and critical safety
and order tables. Only after all checks pass does the Linux verifier persist `VERIFIED` evidence in the
deployment database. `BACKUP_OBJECT_KEY` must be an offsite `s3://` object and the control database is
explicitly rejected if its URL contains `restore_drill`. The Windows drill removes only its exact
isolated drill database in `finally`; it is a local diagnostic and does not satisfy the LIVE evidence
gate by itself.

## Production restore

1. Declare an incident, activate kill switch, stop scheduler/workers, and record the last broker contact.
2. Provision a new isolated PostgreSQL host; never restore over the only surviving database.
3. Select the newest object whose checksum and manifest exist. Download all three and verify SHA-256.
4. Restore into a database ending in `restore_drill` and run the full verification procedure first.
5. Provision the definitive recovery database and restore the same verified artifact.
6. Run Prisma migration status without applying unreviewed migrations. Confirm expected migration count.
7. Start one backend instance in `BLOCKED` / only-close mode with scheduler stopped.
8. Restore safety, scheduler, risk configuration, strategy-position bindings, orders, fills, tax lots, and
   protection groups. Expire stale signals and release only stale leases.
9. Reconcile orders, fills, positions, cash, equity, and buying power against Alpaca. Never resend an old
   or `UNKNOWN` order.
10. Resolve every blocking discrepancy, verify alert delivery, then perform controlled recovery. PAPER
    operation precedes any separately approved LIVE recovery.

## Disaster recovery

If the primary application host is lost, deploy the pinned release artifact to the standby host, restore
the verified offsite backup as above, rotate host credentials, preserve the original deployment ID, and
complete startup reconciliation before enabling entries. DNS/proxy cutover occurs only after liveness,
database health, clock skew, and authenticated operator access pass.

Recovery objectives for the initial single-operator deployment are RPO ≤ 24 hours and RTO ≤ 4 hours.
Any tighter capital/risk requirement must increase backup cadence and maintain a continuously replicated
standby. A real drill is required quarterly and its artifact hash, duration, migration/table counts, and
operator sign-off must be retained in the audit journal.

## Release evidence

A historical drill from 2026-08-18 restored the earlier seven-migration schema. Subsequent schema
migrations invalidate that evidence for the current release. A new isolated restore must be completed
and recorded by the verifier above before LIVE activation; the application intentionally treats its
absence as a blocking readiness failure.
