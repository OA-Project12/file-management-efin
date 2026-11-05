FROM clamav/clamav:1.4_base@sha256:04e5b7c0eac436c589073f5eb2924c322658e75498bf39906e89f9b08307081d
COPY scan-policy.conf /tmp/efin-scan-policy.conf
RUN sed -i -E '/^[[:space:]]*(TCPSocket|TCPAddr|StreamMaxLength|MaxFileSize|MaxScanSize|MaxThreads|AlertExceedsMax|AlertEncryptedDoc|ScanPDF)[[:space:]]/d' /etc/clamav/clamd.conf \
    && cat /tmp/efin-scan-policy.conf >> /etc/clamav/clamd.conf \
    && rm /tmp/efin-scan-policy.conf
