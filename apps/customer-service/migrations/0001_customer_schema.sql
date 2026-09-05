CREATE SCHEMA IF NOT EXISTS customer;

CREATE TABLE customer.customers (
  customer_ref varchar(30) PRIMARY KEY
    CHECK (customer_ref ~ '^cus_[0-9A-HJKMNP-TV-Z]{26}$'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  display_name varchar(200) NOT NULL,
  display_name_search varchar(200) NOT NULL,
  phone_e164 varchar(16),
  email_normalized varchar(254),
  status varchar(16) NOT NULL DEFAULT 'Active'
    CHECK (status IN ('Active', 'Inactive')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by_actor_ref varchar(128) NOT NULL,
  updated_by_actor_ref varchar(128) NOT NULL,
  CHECK (phone_e164 IS NOT NULL OR email_normalized IS NOT NULL),
  CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CHECK (display_name_search = lower(display_name)),
  CHECK (created_by_actor_ref <> '' AND updated_by_actor_ref <> '')
);

CREATE TABLE customer.addresses (
  address_ref varchar(30) PRIMARY KEY
    CHECK (address_ref ~ '^adr_[0-9A-HJKMNP-TV-Z]{26}$'),
  customer_ref varchar(30) NOT NULL
    REFERENCES customer.customers(customer_ref) ON DELETE RESTRICT,
  kind varchar(16) NOT NULL CHECK (kind = 'Delivery'),
  line1 varchar(200) NOT NULL CHECK (line1 <> ''),
  line2 varchar(200),
  city varchar(120) NOT NULL CHECK (city <> ''),
  postal_code varchar(20),
  country_code char(2) NOT NULL DEFAULT 'RU'
    CHECK (country_code ~ '^[A-Z]{2}$'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by_actor_ref varchar(128) NOT NULL,
  updated_by_actor_ref varchar(128) NOT NULL,
  CHECK (created_by_actor_ref <> '' AND updated_by_actor_ref <> '')
);

CREATE TABLE customer.channel_links (
  channel_link_ref varchar(30) PRIMARY KEY
    CHECK (channel_link_ref ~ '^chl_[0-9A-HJKMNP-TV-Z]{26}$'),
  customer_ref varchar(30) NOT NULL
    REFERENCES customer.customers(customer_ref) ON DELETE RESTRICT,
  provider varchar(16) NOT NULL CHECK (provider IN ('Web', 'VK')),
  external_subject_hash char(64) NOT NULL
    CHECK (external_subject_hash ~ '^[0-9a-f]{64}$'),
  status varchar(16) NOT NULL CHECK (status IN ('Active', 'Revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by_actor_ref varchar(128) NOT NULL,
  updated_by_actor_ref varchar(128) NOT NULL,
  CHECK (created_by_actor_ref <> '' AND updated_by_actor_ref <> '')
);

CREATE TABLE customer.idempotency_records (
  actor_ref varchar(64) NOT NULL,
  scope varchar(64) NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state varchar(16) NOT NULL CHECK (state IN ('Acquired', 'Completed')),
  lease_owner uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  response_status smallint,
  response_body jsonb,
  resource_ref varchar(30),
  PRIMARY KEY (actor_ref, scope, idempotency_key),
  CHECK (actor_ref <> '' AND scope <> ''),
  CHECK (expires_at >= lease_until AND lease_until > created_at),
  CHECK (
    (state = 'Acquired' AND response_status IS NULL AND response_body IS NULL AND completed_at IS NULL)
    OR
    (state = 'Completed' AND response_status BETWEEN 100 AND 599
      AND response_body IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE TABLE customer.audit_log (
  audit_ref varchar(30) PRIMARY KEY
    CHECK (audit_ref ~ '^aud_[0-9A-HJKMNP-TV-Z]{26}$'),
  customer_ref varchar(30) NOT NULL
    REFERENCES customer.customers(customer_ref) ON DELETE RESTRICT,
  operation varchar(32) NOT NULL CHECK (operation = 'CustomerCreated'),
  actor_ref varchar(128) NOT NULL CHECK (actor_ref <> ''),
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  before_hash char(64),
  after_hash char(64) NOT NULL CHECK (after_hash ~ '^[0-9a-f]{64}$'),
  CHECK (before_hash IS NULL OR before_hash ~ '^[0-9a-f]{64}$')
);

GRANT USAGE ON SCHEMA customer TO coffee_customer_rw;
REVOKE ALL ON TABLE customer.customers, customer.addresses, customer.channel_links,
  customer.idempotency_records, customer.audit_log FROM coffee_customer_rw;
GRANT SELECT, INSERT, UPDATE ON TABLE customer.customers, customer.addresses,
  customer.channel_links, customer.idempotency_records TO coffee_customer_rw;
GRANT SELECT, INSERT ON TABLE customer.audit_log TO coffee_customer_rw;
