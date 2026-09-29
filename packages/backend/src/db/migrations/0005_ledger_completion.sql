-- 0005: completes the Phase 0 posting rules P10–P12 (money transfers, balance
-- applications, opening balances). Additive only; existing rows are untouched.

-- The receiving account of a transfer between two money accounts (the source
-- stays in money_account_id). Only MONEY_TRANSFER documents may use it.
ALTER TABLE fin_document ADD COLUMN counter_money_account_id TEXT REFERENCES money_account(id);

CREATE TRIGGER trg_doc_counter_account_only_transfers
BEFORE INSERT ON fin_document
WHEN NEW.counter_money_account_id IS NOT NULL AND NEW.doc_type <> 'MONEY_TRANSFER'
BEGIN
  SELECT RAISE(ABORT, 'Only money transfers have a receiving account');
END;

CREATE TRIGGER trg_doc_transfer_accounts_differ
BEFORE INSERT ON fin_document
WHEN NEW.counter_money_account_id IS NOT NULL AND NEW.counter_money_account_id = NEW.money_account_id
BEGIN
  SELECT RAISE(ABORT, 'A transfer needs two different accounts');
END;

CREATE INDEX ix_doc_counter_account ON fin_document(counter_money_account_id) WHERE counter_money_account_id IS NOT NULL;
CREATE INDEX ix_doc_type_reason ON fin_document(doc_type, reason_code);
