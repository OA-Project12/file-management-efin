-- Preserve the current global-admin behavior of existing management keys,
-- while reserving keys:manage alone for department-scoped key administration.
update filesvc.application_keys
set scopes = array_append(scopes, 'departments:manage')
where 'keys:manage' = any(scopes)
  and not ('departments:manage' = any(scopes));
