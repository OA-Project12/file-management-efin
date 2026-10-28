-- Apply only after deploying the matching pre-scope-separation API version.
-- This restores the previous behavior where keys:manage was application-wide.
update filesvc.application_keys
set scopes = array_remove(scopes, 'departments:manage')
where 'keys:manage' = any(scopes)
  and 'departments:manage' = any(scopes);
