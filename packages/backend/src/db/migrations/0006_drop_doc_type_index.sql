-- 0006: removes ix_doc_type_reason (added in 0005). With it, SQLite chose the
-- low-selectivity (doc_type) index over ix_doc_supplier for per-supplier
-- queries: the supplier volume report took 2.9 s instead of 0.15 s on the
-- representative dataset (packages/backend/test/perf.test.ts). Transfer and
-- opening-balance lists are served by ix_doc_date_type.
DROP INDEX IF EXISTS ix_doc_type_reason;
