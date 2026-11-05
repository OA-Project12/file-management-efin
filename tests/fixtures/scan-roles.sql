-- Model the existing worker grants and policies on the disposable fixture DB.
do $$
begin
  if not exists (select 1 from pg_roles where rolname='filesvc_api') then
    create role filesvc_api nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname='filesvc_worker') then
    create role filesvc_worker nologin;
  end if;
end $$;

grant usage on schema filesvc to filesvc_api, filesvc_worker;
grant select,update (status,updated_at) on filesvc.files to filesvc_worker;
grant select,update (status,completed_at,checksum_sha256) on filesvc.file_versions to filesvc_worker;
grant select on filesvc.upload_intents,filesvc.version_upload_intents,filesvc.version_restore_intents to filesvc_worker;
grant select,update on filesvc.storage_allocations,filesvc.department_storage_quotas to filesvc_worker;
grant insert on filesvc.audit_log to filesvc_worker;

alter table filesvc.file_versions enable row level security;
create policy fixture_worker_version_read on filesvc.file_versions for select to filesvc_worker using (true);
create policy fixture_worker_version_update on filesvc.file_versions for update to filesvc_worker using (true);
alter table filesvc.upload_intents enable row level security;
create policy fixture_worker_upload_read on filesvc.upload_intents for select to filesvc_worker using (true);
alter table filesvc.version_upload_intents enable row level security;
create policy fixture_worker_version_upload_read on filesvc.version_upload_intents for select to filesvc_worker using (true);
alter table filesvc.version_restore_intents enable row level security;
create policy fixture_worker_restore_read on filesvc.version_restore_intents for select to filesvc_worker using (true);
alter table filesvc.application_keys enable row level security;
alter table filesvc.application_key_departments enable row level security;
alter table filesvc.departments enable row level security;
alter table filesvc.tenant_users enable row level security;
alter table filesvc.user_department_roles enable row level security;
alter table filesvc.folders enable row level security;
alter table filesvc.folder_user_access enable row level security;
