-- Resume a bounded provider page window after a worker exhausts its page budget.
-- Existing rows remain valid with all continuation columns NULL.
ALTER TABLE "soc_ingestion_cursors"
  ADD COLUMN "continuation_from" TIMESTAMPTZ(3),
  ADD COLUMN "continuation_to" TIMESTAMPTZ(3),
  ADD COLUMN "continuation_cursor" TEXT;

ALTER TABLE "soc_ingestion_cursors"
  ADD CONSTRAINT "soc_ingestion_cursors_continuation_complete"
  CHECK (
    ("continuation_from" IS NULL AND "continuation_to" IS NULL AND "continuation_cursor" IS NULL)
    OR
    (
      "continuation_from" IS NOT NULL
      AND "continuation_to" IS NOT NULL
      AND "continuation_cursor" IS NOT NULL
      AND "continuation_from" < "continuation_to"
      AND length("continuation_cursor") > 0
    )
  );
