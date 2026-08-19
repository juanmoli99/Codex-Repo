FROM alpine:3.23.3

RUN apk add --no-cache ca-certificates curl
COPY watchdog.sh /usr/local/bin/aegis-watchdog
RUN addgroup -S watchdog && adduser -S -G watchdog watchdog && chmod 0555 /usr/local/bin/aegis-watchdog
USER watchdog
ENTRYPOINT ["/usr/local/bin/aegis-watchdog"]
