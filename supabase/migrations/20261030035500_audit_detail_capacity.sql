-- Access changes may contain up to 100 user or department grants on each side.
alter table filesvc.audit_log drop constraint if exists audit_log_details_check;
alter table filesvc.audit_log
  add constraint audit_log_details_check check (octet_length(details::text) <= 16384);
