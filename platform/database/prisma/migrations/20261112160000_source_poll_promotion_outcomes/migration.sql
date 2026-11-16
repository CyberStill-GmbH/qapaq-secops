-- Break down the final processing stage for each poll. NULL preserves the meaning of
-- observations written before these counters existed; it must not be read as zero.
ALTER TABLE "source_poll_observations"
  ADD COLUMN "normalized" INTEGER,
  ADD COLUMN "duplicates" INTEGER,
  ADD COLUMN "not_promoted" INTEGER;

ALTER TABLE "source_poll_observations"
  ADD CONSTRAINT "source_poll_observations_promotion_counts_non_negative"
  CHECK (
    ("normalized" IS NULL OR "normalized" >= 0)
    AND
    ("duplicates" IS NULL OR "duplicates" >= 0)
    AND ("not_promoted" IS NULL OR "not_promoted" >= 0)
  );
