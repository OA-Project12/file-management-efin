-- Earlier deployed retention function references this compatibility name.
-- The view is automatically updatable, so DELETE applies to the underlying table.
create view filesvc.audit_security_log as select * from filesvc.audit_security_events;
revoke all on filesvc.audit_security_log from public;
