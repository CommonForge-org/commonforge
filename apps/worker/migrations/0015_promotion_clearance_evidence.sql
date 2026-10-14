-- apps/worker/migrations/0015_promotion_clearance_evidence.sql
-- Staging phase 3 (ruling P3-11, review of Task 3): a `classifier` clearance keeps the classifier
-- evidence it was written on, so a clearance carried to a rebuilt promotion still shows why it was
-- cleared (gate_json is rebuilt on every gating) and the gate can re-check it against the policy.
-- Set and voided with the clearance columns; NULL for `self` and `developer` clearances. Developers
-- and owners only (like gate_json).
ALTER TABLE promotions ADD COLUMN clearance_evidence_json TEXT;
