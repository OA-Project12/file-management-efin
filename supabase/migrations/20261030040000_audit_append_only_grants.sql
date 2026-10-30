-- Routine API and worker roles may append, but only the retention function's
-- security-definer owner may remove expired audit records.
revoke delete on filesvc.audit_log from filesvc_worker;
revoke delete on filesvc.audit_security_events from filesvc_worker;
