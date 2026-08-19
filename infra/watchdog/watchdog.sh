#!/bin/sh
set -eu

: "${WATCHDOG_URL:=http://backend:3000/health/live}"
: "${WATCHDOG_INTERVAL_SECONDS:=15}"
: "${WATCHDOG_FAILURE_THRESHOLD:=3}"
: "${WATCHDOG_REMINDER_SECONDS:=900}"
: "${TELEGRAM_BOT_TOKEN_FILE:?TELEGRAM_BOT_TOKEN_FILE is required}"
: "${TELEGRAM_CHAT_ID_FILE:?TELEGRAM_CHAT_ID_FILE is required}"

bot_token="$(tr -d '\r\n' < "${TELEGRAM_BOT_TOKEN_FILE}")"
chat_id="$(tr -d '\r\n' < "${TELEGRAM_CHAT_ID_FILE}")"
failures=0
state=UNKNOWN
last_alert=0

notify() {
  text=$1
  curl --fail --silent --show-error --max-time 10 \
    --request POST \
    --header 'content-type: application/json' \
    --data "{\"chat_id\":\"${chat_id}\",\"text\":\"${text}\",\"disable_web_page_preview\":true}" \
    "https://api.telegram.org/bot${bot_token}/sendMessage" >/dev/null
}

while true; do
  now="$(date +%s)"
  if curl --fail --silent --show-error --max-time 5 "${WATCHDOG_URL}" >/dev/null; then
    failures=0
    if [ "${state}" = DOWN ]; then
      notify '[AEGIS CRITICAL] External watchdog: backend readiness recovered.' || true
    fi
    state=UP
  else
    failures=$((failures + 1))
    if [ "${failures}" -ge "${WATCHDOG_FAILURE_THRESHOLD}" ]; then
      if [ "${state}" != DOWN ] || [ $((now - last_alert)) -ge "${WATCHDOG_REMINDER_SECONDS}" ]; then
        notify '[AEGIS EMERGENCY] External watchdog: backend readiness is DOWN (process or critical dependency).' || true
        last_alert="${now}"
      fi
      state=DOWN
    fi
  fi
  sleep "${WATCHDOG_INTERVAL_SECONDS}"
done
