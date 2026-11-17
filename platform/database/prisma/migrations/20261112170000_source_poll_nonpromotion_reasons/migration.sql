-- Keep aggregate reasons for non-promoted events so operators can distinguish score threshold
-- decisions from explicit policy suppressions. NULL retains the meaning of historical rows.
ALTER TABLE "source_poll_observations"
  ADD COLUMN "below_threshold" INTEGER,
  ADD COLUMN "suppressed" INTEGER;

ALTER TABLE "source_poll_observations"
  ADD CONSTRAINT "source_poll_observations_nonpromotion_reasons_non_negative"
  CHECK (
    ("below_threshold" IS NULL OR "below_threshold" >= 0)
    AND ("suppressed" IS NULL OR "suppressed" >= 0)
    AND (
      "not_promoted" IS NULL
      OR "below_threshold" IS NULL
      OR "suppressed" IS NULL
      OR "not_promoted" >= "below_threshold" + "suppressed"
    )
  );
