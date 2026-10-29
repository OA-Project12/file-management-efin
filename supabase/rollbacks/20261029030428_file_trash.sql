drop index if exists filesvc.files_trash_listing_idx;
alter table filesvc.files drop column if exists trashed_at;
