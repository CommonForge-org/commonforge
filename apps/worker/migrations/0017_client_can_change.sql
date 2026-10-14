-- apps/worker/migrations/0017_client_can_change.sql
-- Per-client "Can change" (2026-10-14): a client's agent may change a folder in its task copies only
-- where the owner gave that client write on it (canStageWrite now requires the client's resource
-- grant to include `write`; resourceOps still reads it as `read`, so clients never write canonical).
-- Until now a client could change every writable folder they could read in a staging-mode project.
-- Existing clients keep exactly that: their project grants become read+write ("Change"), and their
-- read grants on folders that some project they have access to attaches as writable become
-- read+write. Folders hidden from them (no grant) and folders only ever attached read-only stay as
-- they are.
UPDATE grants SET operations_json = '["read","write"]'
WHERE scope_kind = 'project'
  AND operations_json LIKE '%"read"%' AND operations_json NOT LIKE '%"write"%'
  AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = grants.org_id AND m.user_id = grants.user_id AND m.role = 'client');

UPDATE grants SET operations_json = '["read","write"]'
WHERE scope_kind = 'resource'
  AND operations_json LIKE '%"read"%' AND operations_json NOT LIKE '%"write"%'
  AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = grants.org_id AND m.user_id = grants.user_id AND m.role = 'client')
  AND EXISTS (
    SELECT 1 FROM mounts mt
    JOIN grants pg ON pg.org_id = mt.org_id AND pg.scope_kind = 'project' AND pg.scope_id = mt.project_id AND pg.user_id = grants.user_id
    WHERE mt.org_id = grants.org_id AND mt.resource_id = grants.scope_id AND mt.operations_json LIKE '%"write"%'
  );
