-- Synthetic schema for disposable CI/local PostgreSQL only. Never apply to Supabase.
create schema filesvc;
create table filesvc.tenants (id uuid primary key default gen_random_uuid(), name text not null, status text not null default 'active', created_at timestamptz default now());
create table filesvc.applications (id uuid primary key default gen_random_uuid(),tenant_id uuid not null references filesvc.tenants(id),name text not null,status text not null default 'active',created_at timestamptz default now(),unique(tenant_id,id));
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
create table filesvc.tenant_users(tenant_id uuid not null,user_id uuid not null,is_admin boolean not null default false,status text not null default 'active',invited_by uuid,created_at timestamptz default now(),primary key(tenant_id,user_id));
create table filesvc.user_department_roles(tenant_id uuid,application_id uuid,department_id uuid,user_id uuid,role text,primary key(tenant_id,application_id,department_id,user_id));
create table filesvc.folders(id uuid primary key default gen_random_uuid(),tenant_id uuid not null,application_id uuid not null,department_id uuid not null,parent_folder_id uuid,name text not null,visibility text not null default 'department',created_at timestamptz not null default now(),unique(tenant_id,application_id,department_id,id));
create table filesvc.folder_user_access(tenant_id uuid,application_id uuid,department_id uuid,folder_id uuid,user_id uuid,created_at timestamptz default now(),primary key(tenant_id,application_id,folder_id,user_id));
create table filesvc.files(id uuid primary key default gen_random_uuid(),tenant_id uuid not null,application_id uuid not null,department_id uuid not null,owner_subject text not null,bucket_id text not null,object_key text not null,original_name text not null,display_name text,content_type text not null,size_bytes bigint not null,checksum_sha256 text,status text not null default 'pending_upload',folder_id uuid,tags text[] not null default '{}',department text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),deleted_at timestamptz,trashed_at timestamptz,current_version_id uuid,unique(tenant_id,application_id,id));
create index fixture_files_scope on filesvc.files(tenant_id,application_id,created_at desc,id desc);
create table filesvc.upload_intents(file_id uuid primary key references filesvc.files(id),token_fingerprint bytea not null,expires_at timestamptz not null,completed_at timestamptz,created_at timestamptz default now());
create table filesvc.outbox(id uuid primary key default gen_random_uuid(),event_type text,aggregate_id uuid,payload jsonb,attempts int default 0,available_at timestamptz default now(),processed_at timestamptz,created_at timestamptz default now());
create table filesvc.application_keys(id uuid primary key default gen_random_uuid(),tenant_id uuid,application_id uuid,key_prefix text unique,secret_hash bytea,scopes text[],created_at timestamptz default now(),expires_at timestamptz,revoked_at timestamptz,last_used_at timestamptz);
create table filesvc.application_key_departments(application_key_id uuid,department_id uuid,role text);
create table filesvc.file_versions (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references filesvc.files (id) on delete restrict,
  version_number integer not null check (version_number > 0),
  bucket_id text not null check (length(bucket_id) > 0),
  object_key text not null check (length(object_key) > 0),
  original_name text not null check (length(original_name) between 1 and 1024),
  content_type text not null check (length(content_type) between 1 and 255),
  size_bytes bigint not null check (size_bytes >= 0),
  checksum_sha256 text check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-fA-F]{64}$'),
  status text not null default 'pending_upload'
    check (status in ('pending_upload', 'available', 'quarantined', 'failed')),
  created_by_kind text not null check (created_by_kind in ('user', 'api_key', 'migration')),
  created_by_id uuid,
  restored_from_version_id uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint file_versions_file_number_key unique (file_id, version_number),
  constraint file_versions_file_id_id_key unique (file_id, id),
  constraint file_versions_storage_object_key unique (bucket_id, object_key),
  constraint file_versions_restored_from_fkey foreign key (file_id, restored_from_version_id)
    references filesvc.file_versions (file_id, id),
  constraint file_versions_author_check check (
    (created_by_kind = 'migration' and created_by_id is null)
    or (created_by_kind in ('user', 'api_key') and created_by_id is not null)
  )
);
alter table filesvc.files add foreign key(id,current_version_id) references filesvc.file_versions(file_id,id);
create table filesvc.version_upload_intents (
  version_id uuid primary key,
  file_id uuid not null,
  base_version_id uuid not null,
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (file_id, version_id) references filesvc.file_versions (file_id, id),
  foreign key (file_id, base_version_id) references filesvc.file_versions (file_id, id)
);
create table filesvc.version_restore_intents (
  version_id uuid primary key,
  file_id uuid not null,
  base_version_id uuid not null,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (file_id, version_id) references filesvc.file_versions (file_id, id),
  foreign key (file_id, base_version_id) references filesvc.file_versions (file_id, id)
);
create table filesvc.object_cleanup_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  application_id uuid not null,
  file_id uuid not null references filesvc.files(id),
  version_id uuid,
  kind text not null check (kind in ('initial_upload','version_upload','version_restore')),
  bucket_id text not null,
  object_key text not null,
  status text not null default 'pending' check (status in ('pending','completed','skipped')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  lease_token uuid,
  last_error_code text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (bucket_id,object_key),
  foreign key (file_id,version_id) references filesvc.file_versions(file_id,id),
  check ((kind='initial_upload' and version_id is null) or (kind<>'initial_upload' and version_id is not null))
);
create table filesvc.department_storage_quotas (
  tenant_id uuid not null,
  application_id uuid not null,
  department_id uuid not null,
  limit_bytes bigint check (limit_bytes >= 0),
  used_bytes bigint not null default 0 check (used_bytes >= 0),
  reserved_bytes bigint not null default 0 check (reserved_bytes >= 0),
  revision bigint not null default 0 check (revision >= 0),
  initialized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id,application_id,department_id),
  foreign key (tenant_id,application_id,department_id)
    references filesvc.departments(tenant_id,application_id,id)
);
create table filesvc.storage_allocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  application_id uuid not null,
  department_id uuid not null,
  file_id uuid not null,
  version_id uuid,
  kind text not null check (kind in ('initial_upload','version_upload','version_restore','legacy')),
  bucket_id text not null check (length(bucket_id)>0),
  object_key text not null check (length(object_key)>0),
  state text not null default 'reserved' check (state in ('reserved','stored','release_pending','released')),
  reserved_bytes bigint not null default 0 check (reserved_bytes>=0),
  charged_bytes bigint not null default 0 check (charged_bytes>=0),
  object_size_bytes bigint check (object_size_bytes>=0),
  expires_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bucket_id,object_key),
  foreign key (tenant_id,application_id,department_id)
    references filesvc.department_storage_quotas(tenant_id,application_id,department_id),
  foreign key (tenant_id,application_id,file_id)
    references filesvc.files(tenant_id,application_id,id),
  foreign key (file_id,version_id) references filesvc.file_versions(file_id,id),
  constraint storage_allocations_charge_check check (
    charged_bytes=0 or (object_size_bytes is not null and charged_bytes=object_size_bytes)
  ),
  constraint storage_allocations_balances_check check (
    (state='reserved' and reserved_bytes>0 and charged_bytes=0)
    or (state='stored' and reserved_bytes=0 and object_size_bytes is not null and charged_bytes=object_size_bytes)
    or state='release_pending'
    or (state='released' and reserved_bytes=0 and charged_bytes=0)
  ),
  constraint storage_allocations_release_check check ((state='released')=(released_at is not null))
);
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
  check (octet_length(details::text) <= 16384)
) partition by range (occurred_at);
create table filesvc.audit_log_default partition of filesvc.audit_log default;
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
