-- AirDesk migration 0002 — Phase 2: company configuration, user profile,
-- master-data fields and duplicate-detection indexes.
-- Additive only: no financial table is touched (Phase 0 model preserved).
-- Party balances stay DERIVED from the journal (views from 0001); no balance
-- columns are introduced.

-- Company configuration (owner requirement §2) ------------------------------
ALTER TABLE company_profile ADD COLUMN date_format TEXT NOT NULL DEFAULT 'DD/MM/YYYY'
  CHECK (date_format IN ('DD/MM/YYYY','MM/DD/YYYY','YYYY-MM-DD'));
ALTER TABLE company_profile ADD COLUMN number_format TEXT NOT NULL DEFAULT 'LATIN'
  CHECK (number_format IN ('LATIN','ARABIC_INDIC'));
ALTER TABLE company_profile ADD COLUMN text_direction TEXT NOT NULL DEFAULT 'AUTO'
  CHECK (text_direction IN ('AUTO','RTL','LTR'));
ALTER TABLE company_profile ADD COLUMN invoice_title_ar TEXT;
ALTER TABLE company_profile ADD COLUMN invoice_title_en TEXT;
ALTER TABLE company_profile ADD COLUMN invoice_terms_ar TEXT;
ALTER TABLE company_profile ADD COLUMN invoice_terms_en TEXT;

-- Users ----------------------------------------------------------------------
ALTER TABLE app_user ADD COLUMN email TEXT;
ALTER TABLE app_user ADD COLUMN mobile TEXT;
ALTER TABLE app_user ADD COLUMN notes TEXT;

-- Customers ------------------------------------------------------------------
ALTER TABLE customer ADD COLUMN address TEXT;
CREATE INDEX ix_customer_secondary_mobile ON customer(secondary_mobile) WHERE secondary_mobile IS NOT NULL;
CREATE INDEX ix_customer_whatsapp ON customer(whatsapp_number) WHERE whatsapp_number IS NOT NULL;
CREATE INDEX ix_customer_email ON customer(email) WHERE email IS NOT NULL;
CREATE INDEX ix_customer_active_name ON customer(is_active, full_name);

-- Suppliers ------------------------------------------------------------------
ALTER TABLE supplier ADD COLUMN phone_secondary TEXT;
ALTER TABLE supplier ADD COLUMN country_code TEXT;
CREATE INDEX ix_supplier_phone ON supplier(phone) WHERE phone IS NOT NULL;
CREATE INDEX ix_supplier_email ON supplier(email) WHERE email IS NOT NULL;
CREATE INDEX ix_supplier_active_name ON supplier(is_active, name);

-- Airlines -------------------------------------------------------------------
ALTER TABLE airline ADD COLUMN country_code TEXT;
CREATE UNIQUE INDEX ux_airline_icao ON airline(icao_code) WHERE icao_code IS NOT NULL AND is_active = 1;
CREATE INDEX ix_airline_active_name ON airline(is_active, name_en);

-- Referenced airlines are never deleted (history must keep showing them).
CREATE TRIGGER trg_airline_no_delete BEFORE DELETE ON airline
BEGIN SELECT RAISE(ABORT, 'airlines are archived, never deleted'); END;
CREATE TRIGGER trg_role_no_delete_system BEFORE DELETE ON role
WHEN OLD.is_system = 1
BEGIN SELECT RAISE(ABORT, 'system roles cannot be deleted'); END;
