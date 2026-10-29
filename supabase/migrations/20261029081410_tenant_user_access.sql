-- User identities stay in auth.users; this private schema stores service authorization.
create table filesvc.tenant_users (
  tenant_id uuid not null references filesvc.tenants(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'suspended')),
  is_admin boolean not null default false,
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index tenant_users_user_idx on filesvc.tenant_users(user_id) where status = 'active';

create table filesvc.user_department_roles (
  tenant_id uuid not null,
  application_id uuid not null,
  department_id uuid not null,
  user_id uuid not null,
  role text not null check (role in ('admin', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, application_id, department_id, user_id),
  foreign key (tenant_id, user_id) references filesvc.tenant_users(tenant_id, user_id) on delete cascade,
  foreign key (tenant_id, application_id, department_id)
    references filesvc.departments(tenant_id, application_id, id) on delete cascade
);

create index user_department_roles_user_idx
  on filesvc.user_department_roles(user_id, application_id, tenant_id);

alter table filesvc.tenant_users enable row level security;
alter table filesvc.user_department_roles enable row level security;

create policy filesvc_api_tenant_users_select on filesvc.tenant_users
  for select to filesvc_api using (true);
create policy filesvc_api_tenant_users_insert on filesvc.tenant_users
  for insert to filesvc_api with check (true);
create policy filesvc_api_tenant_users_update on filesvc.tenant_users
  for update to filesvc_api using (true) with check (true);
create policy filesvc_api_user_department_roles_select on filesvc.user_department_roles
  for select to filesvc_api using (true);
create policy filesvc_api_user_department_roles_insert on filesvc.user_department_roles
  for insert to filesvc_api with check (true);
create policy filesvc_api_user_department_roles_update on filesvc.user_department_roles
  for update to filesvc_api using (true) with check (true);
create policy filesvc_api_user_department_roles_delete on filesvc.user_department_roles
  for delete to filesvc_api using (true);

grant select, insert, update on filesvc.tenant_users to filesvc_api;
grant select, insert, update, delete on filesvc.user_department_roles to filesvc_api;
