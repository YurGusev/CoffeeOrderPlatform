CREATE SCHEMA IF NOT EXISTS integration;

-- Integration-owned provider session state. Cookie material is an AES-GCM
-- envelope produced by the Gateway; credentials and provider bodies have no
-- representation in this table.
CREATE TABLE integration.provider_sessions (
  scope_hash char(64) PRIMARY KEY CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  encrypted_cookie_material bytea NOT NULL
    CHECK (octet_length(encrypted_cookie_material) BETWEEN 32 AND 65536),
  expires_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX provider_sessions_expiry_idx
  ON integration.provider_sessions (expires_at)
  WHERE expires_at IS NOT NULL;

GRANT USAGE ON SCHEMA integration TO coffee_aroma_gateway_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE integration.provider_sessions TO coffee_aroma_gateway_rw;
