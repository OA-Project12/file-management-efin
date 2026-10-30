-- Create the active UTC month and three upcoming months before the API can
-- write to the default partition. This keeps the first retention run safe.
do $$
declare
  month_start timestamp;
  month_end timestamp;
  partition_name text;
begin
  for offset_month in 0..3 loop
    month_start := date_trunc('month', now() at time zone 'UTC') + make_interval(months => offset_month);
    month_end := month_start + interval '1 month';
    partition_name := 'audit_log_' || to_char(month_start, 'YYYYMM');
    execute format(
      'create table if not exists filesvc.%I partition of filesvc.audit_log for values from (%L) to (%L)',
      partition_name,
      to_char(month_start, 'YYYY-MM-DD HH24:MI:SS') || '+00',
      to_char(month_end, 'YYYY-MM-DD HH24:MI:SS') || '+00'
    );
  end loop;
end $$;
