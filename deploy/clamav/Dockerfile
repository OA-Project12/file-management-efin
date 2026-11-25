FROM clamav/clamav:1.4_base@sha256:04e5b7c0eac436c589073f5eb2924c322658e75498bf39906e89f9b08307081d
RUN apk add --no-cache socat
COPY scan-policy.conf /tmp/efin-scan-policy.conf
RUN sed -i -E '/^[[:space:]]*(LocalSocket|TCPSocket|TCPAddr|StreamMaxLength|MaxFileSize|MaxScanSize|MaxThreads|AlertExceedsMax|AlertEncryptedDoc|ScanPDF|ConcurrentDatabaseReload)[[:space:]]/d' /etc/clamav/clamd.conf \
    && tr -d '\r' < /tmp/efin-scan-policy.conf >> /etc/clamav/clamd.conf \
    && rm /tmp/efin-scan-policy.conf

COPY clamav-watchdog.sh /tmp/clamav-watchdog.sh
RUN tr -d '\r' < /tmp/clamav-watchdog.sh > /usr/local/bin/clamav-watchdog \
    && chmod 0755 /usr/local/bin/clamav-watchdog \
    && rm /tmp/clamav-watchdog.sh

ENTRYPOINT ["/sbin/tini", "-g", "--", "/usr/local/bin/clamav-watchdog"]
HEALTHCHECK --start-period=30m --interval=1m --timeout=3s CMD ["/usr/local/bin/clamav-watchdog", "--probe"]
