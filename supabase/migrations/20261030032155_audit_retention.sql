create table filesvc.audit_maintenance_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  deleted_events bigint not null,
  deleted_security_events bigint not null,
  dropped_partitions text[] not null default '{}'
);
alter table filesvc.audit_maintenance_runs enable row level security;
create policy audit_maintenance_worker_select on filesvc.audit_maintenance_runs for select to filesvc_worker using (true);
grant select on filesvc.audit_maintenance_runs to filesvc_worker;

create function filesvc.maintain_audit_retention() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_start date;
  v_end date;
  v_name text;
  v_partition record;
  v_cutoff timestamptz := now() - interval '365 days';
  v_deleted_events bigint := 0;
  v_deleted_security bigint := 0;
  v_dropped text[] := '{}';
begin
  for v_start in select (date_trunc('month', now())::date + (n || ' months')::interval)::date from generate_series(0, 3) n loop
    v_end := (v_start + interval '1 month')::date;
    v_name := 'audit_log_' || to_char(v_start, 'YYYYMM');
    execute format('create table if not exists filesvc.%I partition of filesvc.audit_log for values from (%L) to (%L)', v_name, v_start, v_end);
  end loop;

  delete from filesvc.audit_log where occurred_at < v_cutoff;
  get diagnostics v_deleted_events = row_count;
  delete from filesvc.audit_security_events where occurred_at < v_cutoff;
  get diagnostics v_deleted_security = row_count;

  for v_partition in
    select c.relname as name from pg_catalog.pg_inherits i
    join pg_catalog.pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'filesvc.audit_log'::regclass
      and c.relname ~ '^audit_log_[0-9]{6}$'
  loop
    v_start := to_date(right(v_partition.name, 6), 'YYYYMM');
    if (v_start + interval '1 month')::timestamptz <= v_cutoff then
      execute format('drop table filesvc.%I', v_partition.name);
      v_dropped := array_append(v_dropped, v_partition.name);
    end if;
  end loop;
  insert into filesvc.audit_maintenance_runs (deleted_events, deleted_security_events, dropped_partitions)
  values (v_deleted_events, v_deleted_security, v_dropped);
  return jsonb_build_object('deletedEvents', v_deleted_events, 'deletedSecurityEvents', v_deleted_security, 'droppedPartitions', v_dropped);
end $$;
revoke all on function filesvc.maintain_audit_retention() from public;
grant execute on function filesvc.maintain_audit_retention() to filesvc_worker;
