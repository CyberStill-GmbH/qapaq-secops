-- Qapaqzito no longer stores model-internal thinking. Historical tool progress is already available
-- in the curated `steps` field, so remove the redundant `reasoning` payload from existing rows too.
UPDATE "assistant_conversations" AS conversation
SET "messages" = (
  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN jsonb_typeof(entry.value) = 'object' THEN entry.value - 'reasoning'
        ELSE entry.value
      END
      ORDER BY entry.ordinality
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(conversation."messages") WITH ORDINALITY AS entry(value, ordinality)
)
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(conversation."messages") AS entry(value)
  WHERE jsonb_typeof(entry.value) = 'object'
    AND entry.value ? 'reasoning'
);
