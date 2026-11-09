begin;

alter table
  filesvc.tenant_users
add
  column if not exists session_not_before timestamptz;

create
or replace function filesvc.require_new_session_after_status_change() returns trigger language plpgsql
set
  search_path = '' as $status_change$
begin
  new.session_not_before := clock_timestamp();

return new;

end;

$status_change$;

revoke all on function filesvc.require_new_session_after_status_change()
from
  public,
  anon,
  authenticated;

drop trigger if exists tenant_user_session_after_status_change on filesvc.tenant_users;

create trigger tenant_user_session_after_status_change before
update
  of status on filesvc.tenant_users for each row
  when (
    old.status is distinct
    from
      new.status
  ) execute function filesvc.require_new_session_after_status_change();

create table if not exists filesvc.dms_session_activity (
  session_id uuid not null references auth.sessions(id) on delete cascade,
  application_id uuid not null references filesvc.applications(id) on delete cascade,
  last_activity_at timestamptz not null,
  primary key (session_id, application_id)
);

alter table
  filesvc.dms_session_activity enable row level security;

revoke all on table filesvc.dms_session_activity
from
  public,
  anon,
  authenticated,
  filesvc_api;

create
or replace function filesvc.check_dms_session(
  p_session_id uuid,
  p_user_id uuid,
  p_application_id uuid,
  p_not_before timestamptz,
  p_touch boolean
) returns boolean language plpgsql security definer
set
  search_path = '' as $session_check$
declare
  v_now timestamptz := statement_timestamp();

v_last_activity timestamptz;

begin
select
  coalesce(
    activity.last_activity_at,
    auth_session.created_at
  ) into v_last_activity
from
  auth.sessions auth_session
  left join filesvc.dms_session_activity activity on activity.session_id = auth_session.id
  and activity.application_id = p_application_id
where
  auth_session.id = p_session_id
  and auth_session.user_id = p_user_id
  and auth_session.created_at > v_now - interval '8 hours'
  and (
    p_not_before is null
    or auth_session.created_at > p_not_before
  );

if not found
or v_last_activity <= v_now - interval '30 minutes' then return false;

end if;

-- A frequent caller need not update the row on every request.
if p_touch
and v_last_activity < v_now - interval '15 seconds' then begin
insert into
  filesvc.dms_session_activity as activity (session_id, application_id, last_activity_at)
values
  (p_session_id, p_application_id, v_now) on conflict (session_id, application_id) do
update
set
  last_activity_at = excluded.last_activity_at
where
  activity.last_activity_at < excluded.last_activity_at - interval '15 seconds';

exception
when foreign_key_violation then -- The Auth session may have been revoked since the read above.
return false;

end;

end if;

return true;

end;

$session_check$;

revoke all on function filesvc.check_dms_session(uuid, uuid, uuid, timestamptz, boolean)
from
  public,
  anon,
  authenticated;

grant execute on function filesvc.check_dms_session(uuid, uuid, uuid, timestamptz, boolean) to filesvc_api;

grant
select
  (session_not_before) on filesvc.tenant_users to filesvc_api;

commit;
