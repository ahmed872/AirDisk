-- 0004: indexes found missing by the representative-office performance test
-- (packages/backend/test/perf.test.ts). Additive only; no data changes.

-- Dashboard "tickets recorded" counts filter tickets by issue date.
CREATE INDEX ix_ticket_issue_date ON ticket(issue_date);

-- Removing a draft passenger checks whether any financial line references it.
CREATE INDEX ix_doc_line_passenger ON fin_document_line(passenger_id) WHERE passenger_id IS NOT NULL;

-- Cancellation lists and the dashboard filter requests by date.
CREATE INDEX ix_cancellation_requested ON cancellation_request(requested_at);
