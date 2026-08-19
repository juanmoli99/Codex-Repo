FROM postgres:18.4-alpine3.22

RUN apk add --no-cache aws-cli coreutils && \
    mkdir -p /backups && \
    chown postgres:postgres /backups
COPY backup.sh /usr/local/bin/aegis-backup
COPY restore-and-verify.sh /usr/local/bin/aegis-restore-and-verify
RUN chmod 0555 /usr/local/bin/aegis-backup /usr/local/bin/aegis-restore-and-verify

USER postgres
ENTRYPOINT ["/usr/local/bin/aegis-backup"]
