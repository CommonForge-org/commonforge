-- apps/worker/migrations/0018_session_kinds.sql
-- Sessions you can see and end (2026-10-14): each session records how it was opened, so the Account
-- page can list "this browser", cforge logins and agent hand-off logins, and end any of them.
-- `client`: 'web' (browser cookie), 'cli' (cforge login with an emailed code), 'handoff' (cforge
-- login with the one-time code the hand-off prompt carries; shorter-lived). NULL: opened before 0018.
-- `magic_links.via`: 'handoff' for codes made by POST /api/auth/cli/code (no email), else NULL.
ALTER TABLE sessions ADD COLUMN client TEXT;
ALTER TABLE magic_links ADD COLUMN via TEXT;
