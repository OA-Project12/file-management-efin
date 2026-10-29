alter table filesvc.files add column trashed_at timestamptz;

create index files_trash_listing_idx
  on filesvc.files (tenant_id, application_id, department_id, owner_subject, trashed_at desc, id desc)
  where status = 'deleted' and trashed_at is not null;
