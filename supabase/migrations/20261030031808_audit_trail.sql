create table filesvc.audit_log (
  id uuid not null default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  tenant_id uuid not null,
  application_id uuid not null,
  actor_kind text not null check (actor_kind in ('user', 'api_key', 'worker')),
  actor_id uuid,
  action text not null,
  outcome text not null check (outcome in ('success', 'denied', 'failure')),
  resource_type text,
  resource_id uuid,
  request_id uuid not null,
  details jsonb not null default '{}'::jsonb,
  primary key (occurred_at, id),
  check (octet_length(details::text) <= 8192)
) partition by range (occurred_at);

create table filesvc.audit_log_default partition of filesvc.audit_log default;
create index audit_log_tenant_time_idx on filesvc.audit_log (tenant_id, occurred_at desc, id desc);
create index audit_log_resource_idx on filesvc.audit_log (tenant_id, resource_id, occurred_at desc);

create table filesvc.audit_security_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  action text not null,
  outcome text not null check (outcome in ('denied', 'failure')),
  request_id uuid not null,
  route text not null,
  status integer not null,
  details jsonb not null default '{}'::jsonb,
  check (octet_length(details::text) <= 2048)
);
create index audit_security_events_time_idx on filesvc.audit_security_events (occurred_at desc);

alter table filesvc.audit_log enable row level security;
alter table filesvc.audit_security_events enable row level security;
create policy audit_log_api_insert on filesvc.audit_log for insert to filesvc_api with check (true);
create policy audit_log_api_select on filesvc.audit_log for select to filesvc_api using (true);
create policy audit_log_worker_insert on filesvc.audit_log for insert to filesvc_worker with check (true);
create policy audit_log_worker_delete on filesvc.audit_log for delete to filesvc_worker using (true);
create policy audit_log_worker_select on filesvc.audit_log for select to filesvc_worker using (true);
create policy audit_security_api_insert on filesvc.audit_security_events for insert to filesvc_api with check (true);
create policy audit_security_worker_select on filesvc.audit_security_events for select to filesvc_worker using (true);
create policy audit_security_worker_delete on filesvc.audit_security_events for delete to filesvc_worker using (true);

grant select, insert on filesvc.audit_log to filesvc_api;
grant select, insert, delete on filesvc.audit_log to filesvc_worker;
grant insert on filesvc.audit_security_events to filesvc_api;
grant select, delete on filesvc.audit_security_events to filesvc_worker;
