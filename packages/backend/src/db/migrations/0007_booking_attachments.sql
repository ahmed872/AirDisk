-- Files attached to a ticket record (the e-ticket / itinerary as received from
-- the airline, GDS or supplier: PDF, Word or an image). Stored INSIDE the
-- database, so they are encrypted at rest and travel with every backup.
-- Attachments are never deleted: a wrong file is marked removed (who, when,
-- why) and hidden, and every add/remove/download is in the audit trail.
CREATE TABLE booking_attachment (
  id              TEXT PRIMARY KEY,
  booking_id      TEXT NOT NULL REFERENCES booking(id),
  file_name       TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  mime_type       TEXT NOT NULL CHECK (mime_type IN (
                    'application/pdf',
                    'application/msword',
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    'image/jpeg',
                    'image/png')),
  size_bytes      INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 15728640),
  sha256          TEXT NOT NULL CHECK (length(sha256) = 64),
  content         BLOB NOT NULL,
  note            TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_at      TEXT NOT NULL,
  created_by      TEXT REFERENCES app_user(id),
  removed_at      TEXT,
  removed_by      TEXT REFERENCES app_user(id),
  removed_reason  TEXT CHECK (removed_reason IS NULL OR length(removed_reason) <= 500)
) STRICT;
CREATE INDEX ix_booking_attachment_booking ON booking_attachment(booking_id, removed_at);

CREATE TRIGGER trg_booking_attachment_no_delete BEFORE DELETE ON booking_attachment
BEGIN SELECT RAISE(ABORT, 'attachments are never deleted; mark them removed'); END;

CREATE TRIGGER trg_booking_attachment_immutable BEFORE UPDATE OF booking_id, file_name, mime_type, size_bytes, sha256, content, created_at, created_by ON booking_attachment
BEGIN SELECT RAISE(ABORT, 'attachment content is immutable'); END;

CREATE TRIGGER trg_booking_attachment_remove_once BEFORE UPDATE OF removed_at ON booking_attachment
WHEN OLD.removed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'attachment already removed'); END;
