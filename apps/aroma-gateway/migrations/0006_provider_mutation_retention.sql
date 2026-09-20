ALTER TABLE integration.provider_mutation_journal
  ADD COLUMN retention_until timestamptz;

UPDATE integration.provider_mutation_journal
SET retention_until = COALESCE(completed_at, created_at) + INTERVAL '90 days';

ALTER TABLE integration.provider_mutation_journal
  ALTER COLUMN retention_until SET DEFAULT (CURRENT_TIMESTAMP + INTERVAL '90 days'),
  ALTER COLUMN retention_until SET NOT NULL;

CREATE INDEX provider_mutation_journal_retention_idx
  ON integration.provider_mutation_journal (retention_until, operation_ref)
  WHERE state IN ('Acknowledged', 'Rejected', 'UnknownOutcome');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE integration.provider_mutation_journal
  TO coffee_aroma_gateway_rw;
