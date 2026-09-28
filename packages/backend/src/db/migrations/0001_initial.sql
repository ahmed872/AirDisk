-- AirDesk migration 0001 — initial schema.
-- Source: docs/phase-0/schema-draft.sql (validated in Phase 0). Differences are
-- listed in docs/phase-1/README.md §Deviations:
--   * schema_migration is created by the migrator itself (bootstrap), not here;
--   * system data (accounts, currencies, permissions, roles, expense categories)
--     is seeded idempotently from the domain package, not by INSERTs here;
--   * + command_log (idempotent commands, Phase 0 §07-1.2);
--   * + tax_code (tax foundation, owner decision Q4).
-- Conventions: ULID TEXT keys, INTEGER minor units, TEXT rates, UTC *_at,
-- company-local *_date, STRICT tables. Posted financial rows are immutable.

-- 0. Meta ---------------------------------------------------------------------
CREATE TABLE installation (
  id                  TEXT PRIMARY KEY,
  created_at          TEXT NOT NULL,
  created_app_version TEXT NOT NULL
) STRICT;

-- 1. Identity & access -------------------------------------------------------
CREATE TABLE app_user (
  id                    TEXT PRIMARY KEY,
  username              TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name          TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  must_change_password  INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0,1)),
  is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  failed_login_count    INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until          TEXT,
  last_login_at         TEXT,
  password_changed_at   TEXT NOT NULL,
  preferred_locale      TEXT CHECK (preferred_locale IN ('ar','en')),
  created_at            TEXT NOT NULL,
  created_by            TEXT REFERENCES app_user(id),
  updated_at            TEXT NOT NULL,
  row_version           INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE role (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name_ar      TEXT NOT NULL,
  name_en      TEXT NOT NULL,
  description  TEXT,
  is_system    INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  created_at   TEXT NOT NULL,
  row_version  INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE permission (
  code           TEXT PRIMARY KEY,
  module         TEXT NOT NULL,
  is_sensitive   INTEGER NOT NULL DEFAULT 0 CHECK (is_sensitive IN (0,1)),
  description_ar TEXT NOT NULL,
  description_en TEXT NOT NULL
) STRICT;

CREATE TABLE role_permission (
  role_id          TEXT NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_code  TEXT NOT NULL REFERENCES permission(code),
  PRIMARY KEY (role_id, permission_code)
) STRICT;

CREATE TABLE user_role (
  user_id  TEXT NOT NULL REFERENCES app_user(id),
  role_id  TEXT NOT NULL REFERENCES role(id),
  PRIMARY KEY (user_id, role_id)
) STRICT;

CREATE TABLE user_session (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES app_user(id),
  workstation_name  TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  ended_at          TEXT,
  end_reason        TEXT CHECK (end_reason IN ('LOGOUT','IDLE_TIMEOUT','APP_EXIT','FORCED','CRASH_RECOVERY'))
) STRICT;

-- Idempotent commands: a retried/double-clicked command returns its first result.
CREATE TABLE command_log (
  command_id   TEXT PRIMARY KEY,
  command      TEXT NOT NULL,
  user_id      TEXT REFERENCES app_user(id),
  result_json  TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at   TEXT NOT NULL
) STRICT;

-- 2. Company settings (white label) & reference data ------------------------
CREATE TABLE currency (
  code        TEXT PRIMARY KEY CHECK (length(code) = 3 AND code = upper(code)),
  name_ar     TEXT NOT NULL,
  name_en     TEXT NOT NULL,
  symbol      TEXT,
  minor_unit  INTEGER NOT NULL CHECK (minor_unit BETWEEN 0 AND 4),
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
) STRICT;

CREATE TABLE company_profile (
  id                          INTEGER PRIMARY KEY CHECK (id = 1),
  legal_name_ar               TEXT NOT NULL,
  legal_name_en               TEXT,
  trade_name_ar               TEXT,
  trade_name_en               TEXT,
  logo                        BLOB,
  logo_mime                   TEXT CHECK (logo_mime IN ('image/png','image/jpeg','image/svg+xml')),
  address_ar                  TEXT,
  address_en                  TEXT,
  phone_primary               TEXT,
  phone_secondary             TEXT,
  email                       TEXT,
  website                     TEXT,
  tax_registration_no         TEXT,
  commercial_registration_no  TEXT,
  iata_agency_code            TEXT,
  base_currency_code          TEXT NOT NULL REFERENCES currency(code),
  default_country_code        TEXT NOT NULL,
  timezone                    TEXT NOT NULL,
  default_locale              TEXT NOT NULL DEFAULT 'ar' CHECK (default_locale IN ('ar','en')),
  financial_lock_date         TEXT,
  document_footer_ar          TEXT,
  document_footer_en          TEXT,
  updated_at                  TEXT NOT NULL,
  updated_by                  TEXT REFERENCES app_user(id),
  row_version                 INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE app_setting (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at  TEXT NOT NULL,
  updated_by  TEXT REFERENCES app_user(id)
) STRICT;

CREATE TABLE document_sequence (
  sequence_key  TEXT NOT NULL,
  period_key    TEXT NOT NULL,
  prefix        TEXT NOT NULL,
  next_value    INTEGER NOT NULL CHECK (next_value >= 1),
  PRIMARY KEY (sequence_key, period_key)
) STRICT;

CREATE TABLE exchange_rate (
  id             TEXT PRIMARY KEY,
  currency_code  TEXT NOT NULL REFERENCES currency(code),
  rate_date      TEXT NOT NULL,
  rate           TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'MANUAL',
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL REFERENCES app_user(id),
  UNIQUE (currency_code, rate_date, source)
) STRICT;

-- Tax foundation (Q4): market-neutral tax codes. Not applied by posting rules
-- until the tax phase; documents will reference them through additive columns.
CREATE TABLE tax_code (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name_ar      TEXT NOT NULL,
  name_en      TEXT NOT NULL,
  rate         TEXT NOT NULL,                  -- decimal string percentage, e.g. '14', '15'
  applies_to   TEXT NOT NULL DEFAULT 'SERVICE_FEE' CHECK (applies_to IN ('SERVICE_FEE','ALL_SALES','PURCHASES')),
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at   TEXT NOT NULL,
  row_version  INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE airport (
  iata_code     TEXT PRIMARY KEY CHECK (length(iata_code) = 3),
  icao_code     TEXT,
  name_en       TEXT NOT NULL,
  name_ar       TEXT,
  city_en       TEXT,
  city_ar       TEXT,
  country_code  TEXT NOT NULL,
  timezone      TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
) STRICT;

CREATE TABLE airline (
  id              TEXT PRIMARY KEY,
  iata_code       TEXT,
  icao_code       TEXT,
  ticket_prefix   TEXT,
  name_en         TEXT NOT NULL,
  name_ar         TEXT,
  phone           TEXT,
  email           TEXT,
  website         TEXT,
  notes           TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at      TEXT NOT NULL,
  created_by      TEXT REFERENCES app_user(id),
  updated_at      TEXT NOT NULL,
  row_version     INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE UNIQUE INDEX ux_airline_iata ON airline(iata_code) WHERE iata_code IS NOT NULL AND is_active = 1;

-- 3. Parties -----------------------------------------------------------------
CREATE TABLE customer (
  id                   TEXT PRIMARY KEY,
  customer_no          TEXT NOT NULL UNIQUE,
  customer_type        TEXT NOT NULL DEFAULT 'INDIVIDUAL' CHECK (customer_type IN ('INDIVIDUAL','CORPORATE')),
  full_name            TEXT NOT NULL,
  full_name_latin      TEXT,
  primary_mobile       TEXT NOT NULL,
  primary_mobile_raw   TEXT NOT NULL,
  secondary_mobile     TEXT,
  whatsapp_number      TEXT,
  email                TEXT,
  national_id          TEXT,
  passport_no          TEXT,
  passport_expiry      TEXT,
  nationality          TEXT,
  date_of_birth        TEXT,
  preferred_locale     TEXT CHECK (preferred_locale IN ('ar','en')),
  preferred_channel    TEXT CHECK (preferred_channel IN ('WHATSAPP','SMS','EMAIL','PHONE_CALL')),
  payment_terms_days   INTEGER NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
  credit_limit_minor   INTEGER CHECK (credit_limit_minor >= 0),
  notes                TEXT,
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at           TEXT NOT NULL,
  created_by           TEXT NOT NULL REFERENCES app_user(id),
  updated_at           TEXT NOT NULL,
  updated_by           TEXT REFERENCES app_user(id),
  row_version          INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX ix_customer_mobile ON customer(primary_mobile);

CREATE TABLE traveler (
  id               TEXT PRIMARY KEY,
  customer_id      TEXT REFERENCES customer(id),
  title            TEXT,
  given_name       TEXT NOT NULL,
  surname          TEXT NOT NULL,
  name_ar          TEXT,
  gender           TEXT CHECK (gender IN ('M','F','X')),
  date_of_birth    TEXT,
  passport_no      TEXT,
  passport_expiry  TEXT,
  nationality      TEXT,
  mobile           TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  row_version      INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE supplier (
  id                     TEXT PRIMARY KEY,
  supplier_no            TEXT NOT NULL UNIQUE,
  name                   TEXT NOT NULL,
  contact_person         TEXT,
  phone                  TEXT,
  email                  TEXT,
  address                TEXT,
  airline_id             TEXT REFERENCES airline(id),
  default_currency_code  TEXT NOT NULL REFERENCES currency(code),
  payment_terms_days     INTEGER NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
  notes                  TEXT,
  is_active              INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL REFERENCES app_user(id),
  updated_at             TEXT NOT NULL,
  updated_by             TEXT REFERENCES app_user(id),
  row_version            INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE money_account (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  account_type   TEXT NOT NULL CHECK (account_type IN ('CASH','BANK','WALLET','CARD_CLEARING')),
  currency_code  TEXT NOT NULL REFERENCES currency(code),
  bank_name      TEXT,
  account_ref    TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL REFERENCES app_user(id),
  row_version    INTEGER NOT NULL DEFAULT 1
) STRICT;

-- 4. Chart of accounts -------------------------------------------------------
CREATE TABLE ledger_account (
  code           TEXT PRIMARY KEY,
  name_ar        TEXT NOT NULL,
  name_en        TEXT NOT NULL,
  account_class  TEXT NOT NULL CHECK (account_class IN
                   ('ASSET','LIABILITY','EQUITY','REVENUE','CONTRA_REVENUE','COST','CONTRA_COST','EXPENSE','OTHER')),
  normal_side    TEXT NOT NULL CHECK (normal_side IN ('DEBIT','CREDIT')),
  dimension      TEXT NOT NULL DEFAULT 'NONE' CHECK (dimension IN ('NONE','CUSTOMER','SUPPLIER','MONEY_ACCOUNT')),
  is_system      INTEGER NOT NULL DEFAULT 1 CHECK (is_system IN (0,1)),
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
) STRICT;

CREATE TABLE expense_category (
  id                   TEXT PRIMARY KEY,
  code                 TEXT NOT NULL UNIQUE,
  name_ar              TEXT NOT NULL,
  name_en              TEXT NOT NULL,
  ledger_account_code  TEXT NOT NULL REFERENCES ledger_account(code),
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
) STRICT;

-- 5. Bookings ----------------------------------------------------------------
CREATE TABLE booking (
  id                     TEXT PRIMARY KEY,
  booking_no             TEXT NOT NULL UNIQUE,
  customer_id            TEXT NOT NULL REFERENCES customer(id),
  status                 TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                           ('DRAFT','RESERVED','ISSUED','PARTIALLY_CANCELLED','CANCELLED','VOIDED','DISCARDED')),
  booking_date           TEXT NOT NULL,
  issue_date             TEXT,
  due_date               TEXT,
  ticketing_deadline_at  TEXT,
  primary_pnr            TEXT,
  trip_type              TEXT CHECK (trip_type IN ('ONE_WAY','ROUND_TRIP','MULTI_CITY')),
  default_supplier_id    TEXT REFERENCES supplier(id),
  sale_currency_code     TEXT NOT NULL REFERENCES currency(code),
  contact_name           TEXT NOT NULL,
  contact_mobile         TEXT NOT NULL,
  contact_whatsapp       TEXT,
  contact_email          TEXT,
  sales_agent_id         TEXT NOT NULL REFERENCES app_user(id),
  notes                  TEXT,
  created_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL REFERENCES app_user(id),
  updated_at             TEXT NOT NULL,
  updated_by             TEXT REFERENCES app_user(id),
  row_version            INTEGER NOT NULL DEFAULT 1,
  CHECK (status NOT IN ('ISSUED','PARTIALLY_CANCELLED','CANCELLED','VOIDED') OR issue_date IS NOT NULL)
) STRICT;
CREATE INDEX ix_booking_customer ON booking(customer_id);
CREATE INDEX ix_booking_status_date ON booking(status, issue_date);
CREATE INDEX ix_booking_pnr ON booking(primary_pnr);

CREATE TABLE booking_status_history (
  id           TEXT PRIMARY KEY,
  booking_id   TEXT NOT NULL REFERENCES booking(id),
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  changed_at   TEXT NOT NULL,
  changed_by   TEXT NOT NULL REFERENCES app_user(id),
  reason       TEXT
) STRICT;
CREATE INDEX ix_booking_status_history ON booking_status_history(booking_id, changed_at);

CREATE TABLE booking_passenger (
  id               TEXT PRIMARY KEY,
  booking_id       TEXT NOT NULL REFERENCES booking(id),
  seq              INTEGER NOT NULL CHECK (seq >= 1),
  traveler_id      TEXT REFERENCES traveler(id),
  pax_type         TEXT NOT NULL DEFAULT 'ADT' CHECK (pax_type IN ('ADT','CHD','INF')),
  title            TEXT,
  given_name       TEXT NOT NULL,
  surname          TEXT NOT NULL,
  name_ar          TEXT,
  gender           TEXT CHECK (gender IN ('M','F','X')),
  date_of_birth    TEXT,
  passport_no      TEXT,
  passport_expiry  TEXT,
  nationality      TEXT,
  mobile           TEXT,
  status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED')),
  row_version      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (booking_id, seq)
) STRICT;

CREATE TABLE flight_segment (
  id                     TEXT PRIMARY KEY,
  booking_id             TEXT NOT NULL REFERENCES booking(id),
  seq                    INTEGER NOT NULL CHECK (seq >= 1),
  marketing_airline_id   TEXT NOT NULL REFERENCES airline(id),
  operating_airline_id   TEXT REFERENCES airline(id),
  flight_number          TEXT NOT NULL,
  origin_iata            TEXT NOT NULL REFERENCES airport(iata_code),
  destination_iata       TEXT NOT NULL REFERENCES airport(iata_code),
  departure_date         TEXT NOT NULL,
  departure_time         TEXT NOT NULL,
  arrival_date           TEXT NOT NULL,
  arrival_time           TEXT NOT NULL,
  departure_utc          TEXT,
  arrival_utc            TEXT,
  departure_terminal     TEXT,
  arrival_terminal       TEXT,
  cabin_class            TEXT NOT NULL CHECK (cabin_class IN ('ECONOMY','PREMIUM_ECONOMY','BUSINESS','FIRST')),
  booking_class          TEXT,
  airline_locator        TEXT,
  status                 TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED','WAITLISTED','CANCELLED')),
  version                INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  row_version            INTEGER NOT NULL DEFAULT 1,
  UNIQUE (booking_id, seq),
  CHECK (origin_iata <> destination_iata),
  CHECK (arrival_date >= departure_date)
) STRICT;
CREATE INDEX ix_segment_departure ON flight_segment(departure_date, departure_time);

CREATE TABLE ticket (
  id                        TEXT PRIMARY KEY,
  booking_id                TEXT NOT NULL REFERENCES booking(id),
  passenger_id              TEXT NOT NULL REFERENCES booking_passenger(id),
  ticket_number             TEXT,
  validating_airline_id     TEXT REFERENCES airline(id),
  supplier_id               TEXT NOT NULL REFERENCES supplier(id),
  status                    TEXT NOT NULL DEFAULT 'ISSUED' CHECK (status IN
                              ('ISSUED','VOIDED','EXCHANGED','REFUNDED','PARTIALLY_REFUNDED','USED')),
  issue_date                TEXT NOT NULL,
  exchanged_from_ticket_id  TEXT REFERENCES ticket(id),
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  row_version               INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE UNIQUE INDEX ux_ticket_number ON ticket(ticket_number) WHERE ticket_number IS NOT NULL;
CREATE INDEX ix_ticket_booking ON ticket(booking_id);
CREATE INDEX ix_ticket_supplier ON ticket(supplier_id);

CREATE TABLE ticket_segment (
  ticket_id   TEXT NOT NULL REFERENCES ticket(id),
  segment_id  TEXT NOT NULL REFERENCES flight_segment(id),
  PRIMARY KEY (ticket_id, segment_id)
) STRICT;

-- 6. Cancellation workflow ---------------------------------------------------
CREATE TABLE cancellation_request (
  id                              TEXT PRIMARY KEY,
  request_no                      TEXT NOT NULL UNIQUE,
  booking_id                      TEXT NOT NULL REFERENCES booking(id),
  cancel_type                     TEXT NOT NULL CHECK (cancel_type IN ('VOID','REFUND','NON_REFUNDABLE')),
  scope                           TEXT NOT NULL CHECK (scope IN ('FULL','PARTIAL')),
  overall_status                  TEXT NOT NULL DEFAULT 'OPEN' CHECK (overall_status IN ('OPEN','CLOSED','WITHDRAWN')),
  supplier_status                 TEXT NOT NULL DEFAULT 'PENDING' CHECK (supplier_status IN
                                    ('PENDING','SUBMITTED','CONFIRMED','REJECTED','NOT_APPLICABLE')),
  customer_status                 TEXT NOT NULL DEFAULT 'PENDING' CHECK (customer_status IN
                                    ('PENDING','CREDITED','NOT_APPLICABLE')),
  expected_supplier_refund_minor  INTEGER CHECK (expected_supplier_refund_minor >= 0),
  expected_currency_code          TEXT REFERENCES currency(code),
  reason                          TEXT NOT NULL,
  requested_at                    TEXT NOT NULL,
  requested_by                    TEXT NOT NULL REFERENCES app_user(id),
  closed_at                       TEXT,
  notes                           TEXT,
  row_version                     INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE cancellation_item (
  id                       TEXT PRIMARY KEY,
  cancellation_request_id  TEXT NOT NULL REFERENCES cancellation_request(id),
  passenger_id             TEXT REFERENCES booking_passenger(id),
  segment_id               TEXT REFERENCES flight_segment(id),
  ticket_id                TEXT REFERENCES ticket(id),
  CHECK (passenger_id IS NOT NULL OR segment_id IS NOT NULL OR ticket_id IS NOT NULL)
) STRICT;

-- 7. Financial documents and journal (immutable) -----------------------------
CREATE TABLE fin_document (
  id                       TEXT PRIMARY KEY,
  doc_type                 TEXT NOT NULL CHECK (doc_type IN (
                             'CUSTOMER_INVOICE','CUSTOMER_CREDIT_NOTE','CUSTOMER_RECEIPT','CUSTOMER_REFUND',
                             'SUPPLIER_BILL','SUPPLIER_CREDIT_NOTE','SUPPLIER_PAYMENT','SUPPLIER_REFUND',
                             'EXPENSE','MONEY_TRANSFER','BALANCE_APPLICATION','OPENING_BALANCE','FX_ADJUSTMENT')),
  doc_no                   TEXT NOT NULL UNIQUE,
  doc_date                 TEXT NOT NULL,
  is_reversal              INTEGER NOT NULL DEFAULT 0 CHECK (is_reversal IN (0,1)),
  reversal_of_id           TEXT UNIQUE REFERENCES fin_document(id),
  customer_id              TEXT REFERENCES customer(id),
  supplier_id              TEXT REFERENCES supplier(id),
  booking_id               TEXT REFERENCES booking(id),
  cancellation_request_id  TEXT REFERENCES cancellation_request(id),
  money_account_id         TEXT REFERENCES money_account(id),
  payment_method           TEXT CHECK (payment_method IN ('CASH','BANK_TRANSFER','CARD','CHEQUE','WALLET','OTHER')),
  payment_reference        TEXT,
  currency_code            TEXT NOT NULL REFERENCES currency(code),
  exchange_rate            TEXT NOT NULL,
  total_minor              INTEGER NOT NULL CHECK (total_minor > 0),
  total_base_minor         INTEGER NOT NULL CHECK (total_base_minor >= 0),
  reason_code              TEXT,
  description              TEXT,
  created_at               TEXT NOT NULL,
  created_by               TEXT NOT NULL REFERENCES app_user(id),
  CHECK ((is_reversal = 1) = (reversal_of_id IS NOT NULL)),
  CHECK (doc_type NOT LIKE 'CUSTOMER_%' OR customer_id IS NOT NULL),
  CHECK (doc_type NOT LIKE 'SUPPLIER_%' OR supplier_id IS NOT NULL),
  CHECK (doc_type NOT IN ('CUSTOMER_RECEIPT','CUSTOMER_REFUND','SUPPLIER_PAYMENT','SUPPLIER_REFUND','EXPENSE')
         OR (money_account_id IS NOT NULL AND payment_method IS NOT NULL))
) STRICT;
CREATE INDEX ix_doc_date_type ON fin_document(doc_date, doc_type);
CREATE INDEX ix_doc_customer ON fin_document(customer_id, doc_date);
CREATE INDEX ix_doc_supplier ON fin_document(supplier_id, doc_date);
CREATE INDEX ix_doc_booking ON fin_document(booking_id);

CREATE TABLE fin_document_line (
  id                   TEXT PRIMARY KEY,
  document_id          TEXT NOT NULL REFERENCES fin_document(id),
  line_no              INTEGER NOT NULL CHECK (line_no >= 1),
  line_type            TEXT NOT NULL CHECK (line_type IN (
                         'FARE','TAXES','SERVICE_FEE','CHANGE_FEE','CANCELLATION_FEE','DISCOUNT',
                         'SALE_RETURN','PURCHASE_COST','PURCHASE_RETURN','SUPPLIER_PENALTY',
                         'SETTLEMENT','EXPENSE','TRANSFER','APPLICATION','OPENING','FX')),
  booking_id           TEXT REFERENCES booking(id),
  passenger_id         TEXT REFERENCES booking_passenger(id),
  ticket_id            TEXT REFERENCES ticket(id),
  expense_category_id  TEXT REFERENCES expense_category(id),
  description          TEXT,
  amount_minor         INTEGER NOT NULL CHECK (amount_minor > 0),
  base_amount_minor    INTEGER NOT NULL CHECK (base_amount_minor >= 0),
  UNIQUE (document_id, line_no)
) STRICT;
CREATE INDEX ix_doc_line_booking ON fin_document_line(booking_id);
CREATE INDEX ix_doc_line_ticket ON fin_document_line(ticket_id);

CREATE TABLE journal_entry (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL UNIQUE REFERENCES fin_document(id),
  entry_date   TEXT NOT NULL,
  is_sealed    INTEGER NOT NULL DEFAULT 0 CHECK (is_sealed IN (0,1)),
  created_at   TEXT NOT NULL
) STRICT;
CREATE INDEX ix_journal_entry_date ON journal_entry(entry_date);

CREATE TABLE journal_line (
  id                   TEXT PRIMARY KEY,
  entry_id             TEXT NOT NULL REFERENCES journal_entry(id),
  line_no              INTEGER NOT NULL CHECK (line_no >= 1),
  account_code         TEXT NOT NULL REFERENCES ledger_account(code),
  customer_id          TEXT REFERENCES customer(id),
  supplier_id          TEXT REFERENCES supplier(id),
  money_account_id     TEXT REFERENCES money_account(id),
  booking_id           TEXT REFERENCES booking(id),
  ticket_id            TEXT REFERENCES ticket(id),
  expense_category_id  TEXT REFERENCES expense_category(id),
  currency_code        TEXT NOT NULL REFERENCES currency(code),
  debit_minor          INTEGER NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor         INTEGER NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  debit_base_minor     INTEGER NOT NULL DEFAULT 0 CHECK (debit_base_minor >= 0),
  credit_base_minor    INTEGER NOT NULL DEFAULT 0 CHECK (credit_base_minor >= 0),
  UNIQUE (entry_id, line_no),
  CHECK (debit_minor = 0 OR credit_minor = 0),
  CHECK (debit_base_minor = 0 OR credit_base_minor = 0),
  CHECK (debit_minor + credit_minor + debit_base_minor + credit_base_minor > 0)
) STRICT;
CREATE INDEX ix_jl_entry ON journal_line(entry_id);
CREATE INDEX ix_jl_account ON journal_line(account_code);
CREATE INDEX ix_jl_customer ON journal_line(customer_id, account_code) WHERE customer_id IS NOT NULL;
CREATE INDEX ix_jl_supplier ON journal_line(supplier_id, account_code) WHERE supplier_id IS NOT NULL;
CREATE INDEX ix_jl_booking ON journal_line(booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX ix_jl_money ON journal_line(money_account_id) WHERE money_account_id IS NOT NULL;

-- 8. Schedule changes & notifications ----------------------------------------
CREATE TABLE schedule_change (
  id                      TEXT PRIMARY KEY,
  booking_id              TEXT NOT NULL REFERENCES booking(id),
  segment_id              TEXT NOT NULL REFERENCES flight_segment(id),
  segment_version_before  INTEGER NOT NULL,
  segment_version_after   INTEGER NOT NULL CHECK (segment_version_after = segment_version_before + 1),
  source                  TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','AIRLINE_NOTICE','IMPORT')),
  severity                TEXT NOT NULL CHECK (severity IN ('MINOR','MAJOR')),
  before_json             TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json              TEXT NOT NULL CHECK (json_valid(after_json)),
  changed_at              TEXT NOT NULL,
  changed_by              TEXT NOT NULL REFERENCES app_user(id),
  notification_status     TEXT NOT NULL DEFAULT 'NOT_NOTIFIED' CHECK (notification_status IN
                            ('NOT_NOTIFIED','CUSTOMER_NOTIFIED','NOTIFICATION_FAILED','MANUALLY_CONFIRMED')),
  status_updated_at       TEXT,
  status_updated_by       TEXT REFERENCES app_user(id),
  confirmation_note       TEXT,
  customer_response       TEXT CHECK (customer_response IN ('ACCEPTED','REQUESTED_CHANGE','REQUESTED_REFUND')),
  superseded_by_id        TEXT REFERENCES schedule_change(id),
  row_version             INTEGER NOT NULL DEFAULT 1,
  UNIQUE (segment_id, segment_version_after)
) STRICT;
CREATE INDEX ix_schedule_change_attention ON schedule_change(notification_status, changed_at);

CREATE TABLE schedule_change_field (
  change_id   TEXT NOT NULL REFERENCES schedule_change(id),
  field_name  TEXT NOT NULL CHECK (field_name IN (
                'departure_date','departure_time','arrival_date','arrival_time','flight_number',
                'origin_iata','destination_iata','marketing_airline_id','operating_airline_id',
                'departure_terminal','arrival_terminal','cabin_class','status')),
  old_value   TEXT,
  new_value   TEXT,
  PRIMARY KEY (change_id, field_name)
) STRICT;

CREATE TABLE message_template (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  channel    TEXT NOT NULL CHECK (channel IN ('WHATSAPP','SMS','EMAIL')),
  locale     TEXT NOT NULL CHECK (locale IN ('ar','en')),
  subject    TEXT,
  body       TEXT NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  updated_at TEXT NOT NULL,
  UNIQUE (code, channel, locale)
) STRICT;

CREATE TABLE notification (
  id                   TEXT PRIMARY KEY,
  channel              TEXT NOT NULL CHECK (channel IN ('WHATSAPP','SMS','EMAIL','PHONE_CALL')),
  delivery_mode        TEXT NOT NULL CHECK (delivery_mode IN ('MANUAL','PROVIDER')),
  provider             TEXT,
  template_code        TEXT,
  recipient_address    TEXT NOT NULL,
  recipient_name       TEXT,
  customer_id          TEXT REFERENCES customer(id),
  booking_id           TEXT REFERENCES booking(id),
  schedule_change_id   TEXT REFERENCES schedule_change(id),
  subject              TEXT,
  body                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','DELIVERED','FAILED','CANCELLED')),
  provider_message_id  TEXT,
  error_message        TEXT,
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  created_by           TEXT NOT NULL REFERENCES app_user(id),
  sent_at              TEXT,
  sent_by              TEXT REFERENCES app_user(id),
  status_updated_at    TEXT
) STRICT;
CREATE INDEX ix_notification_booking ON notification(booking_id);
CREATE INDEX ix_notification_change ON notification(schedule_change_id);

-- 9. Audit, backups, search --------------------------------------------------
CREATE TABLE audit_log (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  occurred_at    TEXT NOT NULL,
  user_id        TEXT REFERENCES app_user(id),
  session_id     TEXT REFERENCES user_session(id),
  workstation    TEXT,
  action         TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT,
  before_json    TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json     TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  metadata_json  TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL
) STRICT;
CREATE INDEX ix_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX ix_audit_user_time ON audit_log(user_id, occurred_at);

CREATE TABLE backup_record (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('MANUAL','SCHEDULED','ON_EXIT','PRE_MIGRATION','PRE_RESTORE')),
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  status           TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  file_path        TEXT,
  file_size_bytes  INTEGER,
  sha256           TEXT,
  schema_version   INTEGER NOT NULL,
  app_version      TEXT NOT NULL,
  is_encrypted     INTEGER NOT NULL CHECK (is_encrypted IN (0,1)),
  verified_at      TEXT,
  error_message    TEXT,
  created_by       TEXT REFERENCES app_user(id)
) STRICT;

CREATE VIRTUAL TABLE search_index USING fts5(
  entity_type UNINDEXED,
  entity_id   UNINDEXED,
  content,
  tokenize = 'trigram remove_diacritics 1'
);

-- 10. Integrity triggers -----------------------------------------------------
CREATE TRIGGER trg_fin_document_no_update BEFORE UPDATE ON fin_document
BEGIN SELECT RAISE(ABORT, 'fin_document is immutable; post a reversal or adjustment'); END;
CREATE TRIGGER trg_fin_document_no_delete BEFORE DELETE ON fin_document
BEGIN SELECT RAISE(ABORT, 'fin_document cannot be deleted'); END;

CREATE TRIGGER trg_fin_document_line_no_update BEFORE UPDATE ON fin_document_line
BEGIN SELECT RAISE(ABORT, 'fin_document_line is immutable'); END;
CREATE TRIGGER trg_fin_document_line_no_delete BEFORE DELETE ON fin_document_line
BEGIN SELECT RAISE(ABORT, 'fin_document_line cannot be deleted'); END;

CREATE TRIGGER trg_fin_document_lock_date BEFORE INSERT ON fin_document
WHEN NEW.doc_date <= COALESCE((SELECT financial_lock_date FROM company_profile WHERE id = 1), '0000-00-00')
BEGIN SELECT RAISE(ABORT, 'document date falls in a locked financial period'); END;

CREATE TRIGGER trg_fin_document_reversal_shape BEFORE INSERT ON fin_document
WHEN NEW.is_reversal = 1 AND NOT EXISTS (
  SELECT 1 FROM fin_document o
  WHERE o.id = NEW.reversal_of_id AND o.is_reversal = 0
    AND o.doc_type = NEW.doc_type AND o.total_minor = NEW.total_minor
    AND o.currency_code = NEW.currency_code
    AND o.customer_id IS NEW.customer_id AND o.supplier_id IS NEW.supplier_id)
BEGIN SELECT RAISE(ABORT, 'reversal does not mirror its original document'); END;

CREATE TRIGGER trg_journal_line_no_update BEFORE UPDATE ON journal_line
BEGIN SELECT RAISE(ABORT, 'journal_line is immutable'); END;
CREATE TRIGGER trg_journal_line_no_delete BEFORE DELETE ON journal_line
BEGIN SELECT RAISE(ABORT, 'journal_line cannot be deleted'); END;
CREATE TRIGGER trg_journal_line_sealed BEFORE INSERT ON journal_line
WHEN (SELECT is_sealed FROM journal_entry WHERE id = NEW.entry_id) = 1
BEGIN SELECT RAISE(ABORT, 'journal_entry is sealed'); END;

CREATE TRIGGER trg_journal_entry_seal BEFORE UPDATE ON journal_entry
BEGIN
  SELECT RAISE(ABORT, 'journal_entry is immutable')
   WHERE NOT (OLD.is_sealed = 0 AND NEW.is_sealed = 1
              AND NEW.id = OLD.id AND NEW.document_id = OLD.document_id
              AND NEW.entry_date = OLD.entry_date AND NEW.created_at = OLD.created_at);
  SELECT RAISE(ABORT, 'journal_entry is unbalanced or has fewer than 2 lines')
   WHERE (SELECT COUNT(*) FROM journal_line WHERE entry_id = NEW.id) < 2
      OR (SELECT SUM(debit_base_minor) - SUM(credit_base_minor) FROM journal_line WHERE entry_id = NEW.id) <> 0;
END;
CREATE TRIGGER trg_journal_entry_no_delete BEFORE DELETE ON journal_entry
BEGIN SELECT RAISE(ABORT, 'journal_entry cannot be deleted'); END;

CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER trg_company_base_currency_frozen BEFORE UPDATE OF base_currency_code ON company_profile
WHEN NEW.base_currency_code <> OLD.base_currency_code AND EXISTS (SELECT 1 FROM journal_entry)
BEGIN SELECT RAISE(ABORT, 'base currency cannot change after financial postings exist'); END;

CREATE TRIGGER trg_company_lock_date_not_null BEFORE UPDATE OF financial_lock_date ON company_profile
WHEN OLD.financial_lock_date IS NOT NULL AND NEW.financial_lock_date IS NULL
BEGIN SELECT RAISE(ABORT, 'lock date cannot be cleared; move it explicitly'); END;

CREATE TRIGGER trg_booking_no_delete BEFORE DELETE ON booking
WHEN OLD.status NOT IN ('DRAFT','DISCARDED') OR EXISTS (SELECT 1 FROM fin_document WHERE booking_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'booking with financial history cannot be deleted'); END;
CREATE TRIGGER trg_customer_no_delete BEFORE DELETE ON customer
BEGIN SELECT RAISE(ABORT, 'customers are deactivated, never deleted'); END;
CREATE TRIGGER trg_supplier_no_delete BEFORE DELETE ON supplier
BEGIN SELECT RAISE(ABORT, 'suppliers are deactivated, never deleted'); END;
CREATE TRIGGER trg_user_no_delete BEFORE DELETE ON app_user
BEGIN SELECT RAISE(ABORT, 'users are disabled, never deleted'); END;
CREATE TRIGGER trg_money_account_no_delete BEFORE DELETE ON money_account
BEGIN SELECT RAISE(ABORT, 'money accounts are deactivated, never deleted'); END;
CREATE TRIGGER trg_ledger_account_no_delete BEFORE DELETE ON ledger_account
BEGIN SELECT RAISE(ABORT, 'ledger accounts cannot be deleted'); END;

-- 11. Read models (derived from the journal only) ----------------------------
CREATE VIEW v_journal AS
SELECT jl.*, je.entry_date, d.doc_type, d.is_reversal, d.doc_no, la.account_class
FROM journal_line jl
JOIN journal_entry je ON je.id = jl.entry_id
JOIN fin_document d   ON d.id = je.document_id
JOIN ledger_account la ON la.code = jl.account_code;

CREATE VIEW v_booking_financials AS
SELECT
  b.id AS booking_id,
  b.booking_no,
  b.customer_id,
  COALESCE(SUM(CASE WHEN j.account_class IN ('REVENUE','CONTRA_REVENUE')
                    THEN j.credit_base_minor - j.debit_base_minor END), 0)            AS net_sales_base_minor,
  COALESCE(SUM(CASE WHEN j.account_class IN ('COST','CONTRA_COST')
                    THEN j.debit_base_minor - j.credit_base_minor END), 0)            AS net_cost_base_minor,
  COALESCE(SUM(CASE WHEN j.account_class IN ('REVENUE','CONTRA_REVENUE','COST','CONTRA_COST')
                    THEN j.credit_base_minor - j.debit_base_minor END), 0)            AS gross_profit_base_minor,
  COALESCE(SUM(CASE WHEN j.account_code = '1200' AND j.doc_type IN
                      ('CUSTOMER_RECEIPT','CUSTOMER_REFUND','BALANCE_APPLICATION')
                    THEN j.credit_base_minor - j.debit_base_minor END), 0)            AS customer_paid_net_base_minor,
  COALESCE(SUM(CASE WHEN j.account_code = '1200'
                    THEN j.debit_base_minor - j.credit_base_minor END), 0)            AS customer_balance_base_minor,
  COALESCE(SUM(CASE WHEN j.account_code = '2100' AND j.doc_type IN
                      ('SUPPLIER_PAYMENT','SUPPLIER_REFUND','BALANCE_APPLICATION')
                    THEN j.debit_base_minor - j.credit_base_minor END), 0)            AS supplier_paid_net_base_minor,
  COALESCE(SUM(CASE WHEN j.account_code = '2100'
                    THEN j.credit_base_minor - j.debit_base_minor END), 0)            AS supplier_balance_base_minor
FROM booking b
LEFT JOIN v_journal j ON j.booking_id = b.id
GROUP BY b.id;

CREATE VIEW v_customer_balance AS
SELECT customer_id, currency_code,
       SUM(debit_minor - credit_minor)           AS balance_minor,
       SUM(debit_base_minor - credit_base_minor) AS balance_base_minor
FROM journal_line WHERE account_code = '1200'
GROUP BY customer_id, currency_code;

CREATE VIEW v_supplier_balance AS
SELECT supplier_id, currency_code,
       SUM(credit_minor - debit_minor)           AS balance_minor,
       SUM(credit_base_minor - debit_base_minor) AS balance_base_minor
FROM journal_line WHERE account_code = '2100'
GROUP BY supplier_id, currency_code;

CREATE VIEW v_money_account_balance AS
SELECT money_account_id, currency_code,
       SUM(debit_minor - credit_minor) AS balance_minor
FROM journal_line WHERE account_code = '1110'
GROUP BY money_account_id, currency_code;
