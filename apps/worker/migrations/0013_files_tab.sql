-- apps/worker/migrations/0013_files_tab.sql
-- Folders and uploads, phase 3. The git blob id of an object's LFS pointer text, so the Files tab
-- recognises pointers from tree entries without reading them (plan P3-2).
ALTER TABLE lfs_objects ADD COLUMN pointer_oid TEXT;
CREATE INDEX lfs_objects_by_pointer ON lfs_objects (org_id, resource_id, pointer_oid);
-- GET …/projects/:pid/file-changes (newest first per project)
CREATE INDEX file_changes_by_project ON file_changes (org_id, project_id, created_at);
-- POST …/folders/:mount/changes with an idempotency key: a repeat by the same user answers the
-- change it made (a retried request whose reply was lost makes no second change)
ALTER TABLE file_changes ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX file_changes_by_idempotency_key ON file_changes (org_id, user_id, idempotency_key);
