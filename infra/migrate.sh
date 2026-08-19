#!/bin/sh
set -eu

: "${DATABASE_URL_FILE:?DATABASE_URL_FILE is required}"
DATABASE_URL="$(tr -d '\r\n' < "${DATABASE_URL_FILE}")"
export DATABASE_URL
exec node backend/node_modules/prisma/build/index.js migrate deploy --schema backend/prisma/schema.prisma
