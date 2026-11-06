import { z } from 'zod';
import { requestMetadataSchema } from './device-control-v3';
import { wordPackSnapshotSchema } from './word-study-v1';
import type { WordLongseqServiceClient } from './word-study-longseq-service';
import { WordStudyServiceError } from './word-study-service';

// A complete bitmap, not a page: one PostgreSQL statement supplies both the
// personal mastered set and revision. Bits follow UUID byte order. The digest
// prevents a changed word set with the same size from reassigning old bits.
export const wordEligibilityRequestSchema = requestMetadataSchema.extend({
  snapshot: z
    .array(wordPackSnapshotSchema)
    .min(1)
    .max(32)
    .refine(pins => new Set(pins.map(pin => pin.deck_id)).size === pins.length),
});
export const wordEligibilityDataSchema = z.strictObject({
  progress_revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  item_ids_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mastered_bitmap: z
    .string()
    .min(1)
    .max(10_000)
    .regex(/^[01]+$/),
});

export async function readWordEligibility(
  client: WordLongseqServiceClient,
  userId: string,
  deviceId: string,
  input: z.infer<typeof wordEligibilityRequestSchema>
) {
  const { data, error } = await client.rpc('read_word_study_eligibility_v1', {
    p_user_id: userId,
    p_device_id: deviceId,
    p_snapshot: input.snapshot,
  });
  if (error) {
    throw new WordStudyServiceError(
      'WORD_ELIGIBILITY_UNAVAILABLE',
      'Word learning state could not be refreshed',
      503,
      true
    );
  }
  return wordEligibilityDataSchema.parse(data);
}
