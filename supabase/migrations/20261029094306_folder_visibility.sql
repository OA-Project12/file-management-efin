alter table filesvc.folders
  add column visibility text not null default 'department'
  check (visibility in ('department', 'restricted'));

create table filesvc.folder_user_access (
  tenant_id uuid not null,
  application_id uuid not null,
  department_id uuid not null,
  folder_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, application_id, folder_id, user_id),
  foreign key (tenant_id, application_id, department_id, folder_id)
    references filesvc.folders (tenant_id, application_id, department_id, id) on delete cascade,
  foreign key (tenant_id, user_id)
    references filesvc.tenant_users (tenant_id, user_id) on delete cascade
);

create index folder_user_access_user_idx
  on filesvc.folder_user_access (tenant_id, application_id, user_id, folder_id);

alter table filesvc.folder_user_access enable row level security;
create policy filesvc_api_folder_user_access on filesvc.folder_user_access
  for all to filesvc_api using (true) with check (true);
grant select, insert, delete on filesvc.folder_user_access to filesvc_api;
grant select, update (visibility) on filesvc.folders to filesvc_api;

-- Every restricted ancestor must grant access. Root files remain visible to department members.
create function filesvc.folder_visible(
  p_tenant uuid, p_application uuid, p_department uuid, p_folder uuid, p_user uuid
) returns boolean language sql stable set search_path = '' as $$
  with recursive ancestors as (
    select f.id, f.parent_folder_id, f.visibility
    from filesvc.folders f
    where f.id = p_folder and f.tenant_id = p_tenant
      and f.application_id = p_application and f.department_id = p_department
    union all
    select parent.id, parent.parent_folder_id, parent.visibility
    from filesvc.folders parent
    join ancestors child on child.parent_folder_id = parent.id
    where parent.tenant_id = p_tenant and parent.application_id = p_application
      and parent.department_id = p_department
  )
  select p_folder is null or (
    exists (select 1 from ancestors where id = p_folder)
    and not exists (
      select 1 from ancestors a
      where a.visibility = 'restricted'
        and not exists (
          select 1 from filesvc.folder_user_access access
          where access.tenant_id = p_tenant and access.application_id = p_application
            and access.folder_id = a.id and access.user_id = p_user
        )
    )
  );
$$;
grant execute on function filesvc.folder_visible(uuid, uuid, uuid, uuid, uuid) to filesvc_api;
