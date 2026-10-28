-- Use only after deploying the pre-department API version and stopping writes.
-- This restores the former application-wide folder-name uniqueness rules.
begin;

do $$
begin
  if exists (
    select 1
    from filesvc.folders
    group by tenant_id, application_id, parent_folder_id, lower(name)
    having count(*) > 1
  ) then
    raise exception 'Rollback blocked: duplicate folder names exist across departments. Resolve them before rollback.';
  end if;
end
$$;

alter table filesvc.files drop constraint files_folder_department_fkey;
alter table filesvc.folders drop constraint folders_parent_department_fkey;
alter table filesvc.files
  add constraint files_folder_fkey
  foreign key (tenant_id, application_id, folder_id)
  references filesvc.folders (tenant_id, application_id, id);
alter table filesvc.folders
  add constraint folders_parent_fkey
  foreign key (tenant_id, application_id, parent_folder_id)
  references filesvc.folders (tenant_id, application_id, id);

drop index filesvc.folders_child_name_department_unique;
drop index filesvc.folders_root_name_department_unique;
create unique index folders_child_name_unique
  on filesvc.folders (tenant_id, application_id, parent_folder_id, lower(name))
  where parent_folder_id is not null;
create unique index folders_root_name_unique
  on filesvc.folders (tenant_id, application_id, lower(name))
  where parent_folder_id is null;

drop index filesvc.files_department_listing_idx;
drop index filesvc.folders_department_parent_idx;
alter table filesvc.files drop constraint files_department_fkey;
alter table filesvc.folders drop constraint folders_department_fkey;
alter table filesvc.folders drop constraint folders_tenant_app_department_id_key;
alter table filesvc.files drop column department_id;
alter table filesvc.folders drop column department_id;
drop table filesvc.application_key_departments;
drop table filesvc.departments;

commit;
