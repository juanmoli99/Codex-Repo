#!/bin/sh
set -eu

: "${BACKUP_S3_URI:?BACKUP_S3_URI is required}"
: "${BACKUP_INTERVAL_SECONDS:=86400}"
: "${BACKUP_RETENTION_DAYS:=14}"
: "${BACKUP_RECORD_RETENTION_DAYS:=2555}"
: "${BACKUP_PREFIX:=aegis}"
: "${BACKUP_SSE:=AES256}"
: "${PGPASSWORD_FILE:?PGPASSWORD_FILE is required}"
: "${AWS_ACCESS_KEY_ID_FILE:?AWS_ACCESS_KEY_ID_FILE is required}"
: "${AWS_SECRET_ACCESS_KEY_FILE:?AWS_SECRET_ACCESS_KEY_FILE is required}"

PGPASSWORD="$(tr -d '\r\n' < "${PGPASSWORD_FILE}")"
AWS_ACCESS_KEY_ID="$(tr -d '\r\n' < "${AWS_ACCESS_KEY_ID_FILE}")"
AWS_SECRET_ACCESS_KEY="$(tr -d '\r\n' < "${AWS_SECRET_ACCESS_KEY_FILE}")"
export PGPASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

upload_encrypted() {
  source_file="$1"
  target_uri="$2"
  case "${BACKUP_SSE}" in
    AES256)
      aws s3 cp "${source_file}" "${target_uri}" --sse AES256 --only-show-errors
      ;;
    aws:kms)
      : "${BACKUP_KMS_KEY_ID:?BACKUP_KMS_KEY_ID is required when BACKUP_SSE=aws:kms}"
      aws s3 cp "${source_file}" "${target_uri}" --sse aws:kms \
        --sse-kms-key-id "${BACKUP_KMS_KEY_ID}" --only-show-errors
      ;;
    *)
      echo "BACKUP_SSE must be AES256 or aws:kms" >&2
      exit 64
      ;;
  esac
}

backup_once() {
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  output="/backups/${BACKUP_PREFIX}-${PGDATABASE}-${timestamp}.dump"
  checksum="${output}.sha256"
  manifest="${output}.manifest.json"
  source_host="$(hostname)"
  object_key="${BACKUP_S3_URI}/$(basename "${output}")"

  pg_dump --format=custom --compress=9 --no-owner --no-acl --serializable-deferrable --file="${output}"
  pg_restore --list "${output}" >/dev/null
  (cd /backups && sha256sum "$(basename "${output}")") > "${checksum}"
  size_bytes="$(wc -c < "${output}" | tr -d ' ')"
  checksum_value="$(cut -d ' ' -f 1 "${checksum}")"
  printf '{"database":"%s","sourceHost":"%s","createdAt":"%s","format":"postgres-custom","sizeBytes":%s,"sha256":"%s","encryption":"%s"}\n' \
    "${PGDATABASE}" "${source_host}" "${timestamp}" "${size_bytes}" "${checksum_value}" \
    "${BACKUP_SSE}" > "${manifest}"
  upload_encrypted "${output}" "${object_key}"
  upload_encrypted "${checksum}" "${BACKUP_S3_URI}/$(basename "${checksum}")"
  upload_encrypted "${manifest}" "${BACKUP_S3_URI}/$(basename "${manifest}")"
  aws s3 cp "${BACKUP_S3_URI}/$(basename "${checksum}")" - --only-show-errors | cmp - "${checksum}"
  record_id="$(cat /proc/sys/kernel/random/uuid)"
  psql -v ON_ERROR_STOP=1 \
    -v record_id="${record_id}" \
    -v object_key="${object_key}" \
    -v checksum_value="${checksum_value}" \
    -v size_bytes="${size_bytes}" \
    -v source_host="${source_host}" \
    -v retention_days="${BACKUP_RECORD_RETENTION_DAYS}" <<'SQL'
INSERT INTO "backup_records" (
  "id", "state", "objectKey", "checksum", "sizeBytes", "sourceHost", "offsite",
  "retentionUntil", "startedAt", "completedAt", "createdAt", "updatedAt"
) VALUES (
  :'record_id'::uuid, 'COMPLETED', :'object_key', :'checksum_value', :'size_bytes'::bigint,
  :'source_host', true, now() + make_interval(days => :'retention_days'::int),
  now(), now(), now(), now()
) ON CONFLICT ("objectKey") DO NOTHING;
SQL
  find /backups -type f -mtime "+${BACKUP_RETENTION_DAYS}" -delete
}

while true; do
  backup_once
  sleep "${BACKUP_INTERVAL_SECONDS}"
done
