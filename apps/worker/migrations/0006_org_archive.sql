-- An archived organization is hidden from its members' lists and closed to the member API (404),
-- until an owner unarchives it. Nothing is deleted: rows, ledger, repos and assets stay.
ALTER TABLE orgs ADD COLUMN archived_at TEXT;
