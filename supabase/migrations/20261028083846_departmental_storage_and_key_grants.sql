-- Create real department boundaries for the private file service.
-- Existing department labels are preserved and mapped to department IDs.

create table filesvc.departments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  application_id uuid not null,
  code text not null check (length(btrim(code)) between 1 and 64),
  name text not null check (length(btrim(name)) between 1 and 160),
  status text not null default 'active' check (status in ('active', 'suspended', 'archived')),
  created_at timestamptz not null default now(),
  constraint departments_application_fkey
    foreign key (tenant_id, application_id)
    references filesvc.applications (tenant_id, id),
  constraint departments_tenant_application_id_key unique (tenant_id, application_id, id),
  constraint departments_code_key unique (tenant_id, application_id, code)
);

create unique index departments_name_lower_unique
  on filesvc.departments (tenant_id, application_id, lower(name));

-- Seed one workspace per existing app and every distinct legacy department label.
insert into filesvc.departments (tenant_id, application_id, code, name)
select grouped.tenant_id,
       grouped.application_id,
       'dept-' || substr(md5(lower(grouped.name)), 1, 16),
       grouped.name
from (
  select a.tenant_id, a.id as application_id, 'General'::text as name
  from filesvc.applications a
  union
  select f.tenant_id, f.application_id,
         coalesce(nullif(btrim(f.department), ''), 'General') as name
  from filesvc.files f
) grouped
on conflict do nothing;

alter table filesvc.files add column department_id uuid;
alter table filesvc.folders add column department_id uuid;

update filesvc.files f
set department_id = d.id
from filesvc.departments d
where d.tenant_id = f.tenant_id
  and d.application_id = f.application_id
  and lower(d.name) = lower(coalesce(nullif(btrim(f.department), ''), 'General'));

do $$
begin
  if exists (
    select 1
    from filesvc.files f
    where f.folder_id is not null
    group by f.tenant_id, f.application_id, f.folder_id
    having count(distinct f.department_id) > 1
  ) then
    raise exception 'A folder contains files from multiple departments; move files into department-specific folders before applying this migration.';
  end if;
end
$$;

update filesvc.folders folder
set department_id = coalesce(
  (select min(f.department_id::text)::uuid
   from filesvc.files f
   where f.tenant_id = folder.tenant_id
     and f.application_id = folder.application_id
     and f.folder_id = folder.id),
  (select d.id from filesvc.departments d
   where d.tenant_id = folder.tenant_id
     and d.application_id = folder.application_id
     and lower(d.name) = 'general')
);

alter table filesvc.files alter column department_id set not null;
alter table filesvc.folders alter column department_id set not null;

alter table filesvc.files
  add constraint files_department_fkey
  foreign key (tenant_id, application_id, department_id)
  references filesvc.departments (tenant_id, application_id, id);

alter table filesvc.folders
  add constraint folders_department_fkey
  foreign key (tenant_id, application_id, department_id)
  references filesvc.departments (tenant_id, application_id, id);

alter table filesvc.folders
  add constraint folders_tenant_app_department_id_key
  unique (tenant_id, application_id, department_id, id);

alter table filesvc.files drop constraint files_folder_fkey;
alter table filesvc.files
  add constraint files_folder_department_fkey
  foreign key (tenant_id, application_id, department_id, folder_id)
  references filesvc.folders (tenant_id, application_id, department_id, id);

alter table filesvc.folders drop constraint folders_parent_fkey;
alter table filesvc.folders
  add constraint folders_parent_department_fkey
  foreign key (tenant_id, application_id, department_id, parent_folder_id)
  references filesvc.folders (tenant_id, application_id, department_id, id);

drop index filesvc.folders_child_name_unique;
drop index filesvc.folders_root_name_unique;
create unique index folders_child_name_department_unique
  on filesvc.folders (tenant_id, application_id, department_id, parent_folder_id, lower(name))
  where parent_folder_id is not null;
create unique index folders_root_name_department_unique
  on filesvc.folders (tenant_id, application_id, department_id, lower(name))
  where parent_folder_id is null;

create index files_department_listing_idx
  on filesvc.files (tenant_id, application_id, department_id, owner_subject, created_at desc, id desc)
  where status = 'available' and deleted_at is null;
create index folders_department_parent_idx
  on filesvc.folders (tenant_id, application_id, department_id, parent_folder_id);

create table filesvc.application_key_departments (
  application_key_id uuid not null references filesvc.application_keys (id) on delete cascade,
  department_id uuid not null references filesvc.departments (id) on delete cascade,
  role text not null check (role in ('admin', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (application_key_id, department_id)
);

-- Deliberately do not grant existing file keys access to every department.
-- Keys with keys:manage are treated as application administrators by the API;
-- other keys must receive explicit department grants before using file APIs.

create index application_key_departments_department_idx
  on filesvc.application_key_departments (department_id, application_key_id);

alter table filesvc.departments enable row level security;
alter table filesvc.application_key_departments enable row level security;

create policy filesvc_api_departments_select
  on filesvc.departments for select to filesvc_api using (true);
create policy filesvc_api_departments_insert
  on filesvc.departments for insert to filesvc_api with check (true);
create policy filesvc_api_departments_update
  on filesvc.departments for update to filesvc_api using (true) with check (true);
create policy filesvc_api_key_departments_select
  on filesvc.application_key_departments for select to filesvc_api using (true);
create policy filesvc_api_key_departments_insert
  on filesvc.application_key_departments for insert to filesvc_api with check (true);
create policy filesvc_api_key_departments_delete
  on filesvc.application_key_departments for delete to filesvc_api using (true);

grant select, insert, update on filesvc.departments to filesvc_api;
grant select, insert, delete on filesvc.application_key_departments to filesvc_api;
