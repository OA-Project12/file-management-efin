drop function if exists filesvc.folder_visible(uuid, uuid, uuid, uuid, uuid);
drop table if exists filesvc.folder_user_access;
alter table filesvc.folders drop column if exists visibility;
