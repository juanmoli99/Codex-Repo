#!/bin/sh
set -eu

: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}"
: "${BACKUP_FILE:?BACKUP_FILE is required}"
: "${BACKUP_CHECKSUM_FILE:?BACKUP_CHECKSUM_FILE is required}"
: "${CONTROL_DATABASE_URL:?CONTROL_DATABASE_URL is required to persist verified evidence}"
: "${BACKUP_OBJECT_KEY:?BACKUP_OBJECT_KEY is required}"
: "${BACKUP_SOURCE_HOST:?BACKUP_SOURCE_HOST is required}"
: "${BACKUP_RECORD_RETENTION_DAYS:=2555}"

case "${BACKUP_OBJECT_KEY}" in
  s3://*) ;;
  *)
    echo "BACKUP_OBJECT_KEY must identify the offsite s3:// object that was restored" >&2
    exit 64
    ;;
esac

case "${CONTROL_DATABASE_URL}" in
  *restore_drill*)
    echo "CONTROL_DATABASE_URL must be the deployment database, not the isolated drill" >&2
    exit 64
    ;;
esac

case "${RESTORE_DATABASE_URL}" in
  *restore_drill*) ;;
  *)
    echo "RESTORE_DATABASE_URL must target an isolated database containing restore_drill" >&2
    exit 64
    ;;
esac

(cd "$(dirname "${BACKUP_FILE}")" && sha256sum -c "$(basename "${BACKUP_CHECKSUM_FILE}")")
pg_restore --list "${BACKUP_FILE}" >/dev/null
pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error \
  --dbname="${RESTORE_DATABASE_URL}" "${BACKUP_FILE}"

psql "${RESTORE_DATABASE_URL}" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
  ) THEN
    RAISE EXCEPTION 'migration ledger is missing';
  END IF;
  IF (SELECT count(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL) = 0 THEN
    RAISE EXCEPTION 'no completed migrations were restored';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'safety_state'
  ) THEN
    RAISE EXCEPTION 'critical safety table is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'orders'
  ) THEN
    RAISE EXCEPTION 'critical order table is missing';
  END IF;
END $$;
SELECT 'AEGIS_RESTORE_VERIFIED' AS result,
       (SELECT count(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL) AS migrations,
       (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public') AS tables;
SQL

checksum_value="$(cut -d ' ' -f 1 "${BACKUP_CHECKSUM_FILE}")"
size_bytes="$(wc -c < "${BACKUP_FILE}" | tr -d ' ')"
record_id="$(cat /proc/sys/kernel/random/uuid)"
psql "${CONTROL_DATABASE_URL}" -v ON_ERROR_STOP=1 \
  -v record_id="${record_id}" \
  -v object_key="${BACKUP_OBJECT_KEY}" \
  -v checksum_value="${checksum_value}" \
  -v size_bytes="${size_bytes}" \
  -v source_host="${BACKUP_SOURCE_HOST}" \
  -v retention_days="${BACKUP_RECORD_RETENTION_DAYS}" <<'SQL'
INSERT INTO "backup_records" (
  "id", "state", "objectKey", "checksum", "sizeBytes", "sourceHost", "offsite",
  "retentionUntil", "startedAt", "completedAt", "verifiedAt", "createdAt", "updatedAt"
) VALUES (
  :'record_id'::uuid, 'VERIFIED', :'object_key', :'checksum_value', :'size_bytes'::bigint,
  :'source_host', true, now() + make_interval(days => :'retention_days'::int),
  now(), now(), now(), now(), now()
) ON CONFLICT ("objectKey") DO UPDATE SET
  "state" = 'VERIFIED',
  "checksum" = EXCLUDED."checksum",
  "sizeBytes" = EXCLUDED."sizeBytes",
  "sourceHost" = EXCLUDED."sourceHost",
  "offsite" = true,
  "retentionUntil" = EXCLUDED."retentionUntil",
  "completedAt" = now(),
  "verifiedAt" = now(),
  "error" = NULL,
  "updatedAt" = now();
SQL

echo "AEGIS_VERIFIED_EVIDENCE_PERSISTED ${BACKUP_OBJECT_KEY}"
