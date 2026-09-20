ALTER TABLE integration.provider_mutation_journal
  ADD COLUMN IF NOT EXISTS source_grind_key_hash char(64) NULL
    CHECK (source_grind_key_hash IS NULL OR source_grind_key_hash ~ '^[a-f0-9]{64}$');
