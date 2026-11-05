import { z } from 'zod';
import { requestMetadataSchema } from './device-control-v3';
import {
  wordObservationActionSchema,
  wordStudyModeSchema,
  wordPackSnapshotSchema,
  wordStudyOrderingSchema,
  wordStudyPurposeSchema,
  wordCandidatePolicyVersionSchema,
  wordStudyScopeSchema,
  wordStudySessionItemSchema,
} from './word-study-v1';

export const WORD_LOCAL_SESSION_MAX_BYTES = 128 * 1024;
export const WORD_OBSERVATION_BATCH_MAX_BYTES = 64 * 1024;
export const WORD_LOCAL_SESSION_MAX_ITEMS = 500;
export const WORD_OBSERVATION_BATCH_MAX_ITEMS = 64;
export const WORD_LOCAL_SESSION_MAX_START_INDEX = 10_000;
export const WORD_LOCAL_SESSION_MAX_DECKS = 32;
export const WORD_LOCAL_SESSION_MAX_SNAPSHOTS = 32;

// The local-session request deliberately omits domain, mode, purpose,
// ordering and candidate_policy_version. The server owns those fixed
// sequential semantics; firmware cannot vary or accidentally drift them.
export const WORD_LOCAL_SESSION_SEMANTICS = {
  domain: 'word',
  mode: 'sequential',
  purpose: 'study',
  ordering: 'sequential',
  candidate_policy_version: 'sequential_v1',
} as const;

const localScopeSchema = wordStudyScopeSchema
  .extend({
    deck_ids: z.array(z.uuid()).min(1).max(WORD_LOCAL_SESSION_MAX_DECKS),
    include_mastered: z.literal(true),
  })
  .refine(scope => new Set(scope.deck_ids).size === scope.deck_ids.length, {
    message: 'Deck IDs must be unique',
  });

const localItemSchema = wordStudySessionItemSchema;

export const registerLocalWordStudySessionRequestSchema =
  requestMetadataSchema.extend({
    session_id: z.uuid(),
    scope: localScopeSchema,
    seed: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
    start_index: z
      .number()
      .int()
      .min(0)
      .max(WORD_LOCAL_SESSION_MAX_START_INDEX),
    snapshot: z
      .array(wordPackSnapshotSchema)
      .min(1)
      .max(WORD_LOCAL_SESSION_MAX_SNAPSHOTS)
      .superRefine((snapshot, ctx) => {
        const ids = snapshot.map(pack => pack.deck_id);
        if (new Set(ids).size !== ids.length) {
          ctx.addIssue({
            code: 'custom',
            message: 'Snapshot deck IDs must be unique',
          });
        }
      }),
    items: z
      .array(localItemSchema)
      .min(1)
      .max(WORD_LOCAL_SESSION_MAX_ITEMS)
      .superRefine((items, ctx) => {
        const itemIds = items.map(item => item.item_id);
        if (new Set(itemIds).size !== itemIds.length) {
          ctx.addIssue({
            code: 'custom',
            message: 'Candidate item IDs must be unique',
          });
        }
        if (items.some((item, index) => item.ordinal !== index)) {
          ctx.addIssue({
            code: 'custom',
            message: 'Candidate ordinals must be exactly 0..n-1',
          });
        }
      }),
  });

export const registerLocalWordStudySessionDataSchema = z.strictObject({
  session_id: z.uuid(),
  registered: z.literal(true),
  replayed: z.boolean(),
});

const batchObservationSchema = z.strictObject({
  request_id: z
    .string()
    .min(16)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  item_id: z.uuid(),
  action: wordObservationActionSchema,
  mode: wordStudyModeSchema,
  occurred_at: z.string().datetime(),
});

export const wordObservationBatchRequestSchema = requestMetadataSchema
  .extend({
    session_id: z.uuid(),
    observations: z
      .array(batchObservationSchema)
      .min(1)
      .max(WORD_OBSERVATION_BATCH_MAX_ITEMS),
  })
  .superRefine((body, ctx) => {
    const ids = body.observations.map(observation => observation.request_id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Observation request IDs must be unique',
      });
    }
    for (let index = 1; index < body.observations.length; index += 1) {
      if (
        body.observations[index].sequence !==
        body.observations[index - 1].sequence + 1
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Observation sequences must be consecutive',
        });
        break;
      }
    }
  });

const batchRequestIdSchema = z
  .string()
  .min(16)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const wordObservationBatchAcceptedSchema = z.strictObject({
  request_id: batchRequestIdSchema,
  observation_id: z.uuid(),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  replayed: z.boolean(),
});

export const wordObservationBatchFailureSchema = z.strictObject({
  request_id: batchRequestIdSchema,
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Z0-9_]+$/),
  retryable: z.boolean(),
});

export const wordObservationBatchDataSchema = z
  .strictObject({
    session_id: z.uuid(),
    accepted: z
      .array(wordObservationBatchAcceptedSchema)
      .max(WORD_OBSERVATION_BATCH_MAX_ITEMS),
    failure: wordObservationBatchFailureSchema.nullable(),
  })
  .superRefine((data, ctx) => {
    // A receipt is only valid when accepted is an exact prefix of the input
    // and failure, if present, describes the immediately following input.
    // An empty accepted + null failure is never a successful empty batch.
    if (data.accepted.length === 0 && data.failure === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'Empty accepted prefix requires a failure',
      });
    }
    for (let index = 1; index < data.accepted.length; index += 1) {
      if (
        data.accepted[index].sequence !==
        data.accepted[index - 1].sequence + 1
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Accepted sequences must be consecutive',
        });
        break;
      }
    }
    if (data.failure && data.accepted.length > 0) {
      const previous = data.accepted[data.accepted.length - 1];
      if (data.failure.sequence !== previous.sequence + 1) {
        ctx.addIssue({
          code: 'custom',
          message: 'Failure must follow the accepted prefix',
        });
      }
    }
  });

export type RegisterLocalWordStudySessionRequest = z.infer<
  typeof registerLocalWordStudySessionRequestSchema
>;
export type RegisterLocalWordStudySessionData = z.infer<
  typeof registerLocalWordStudySessionDataSchema
>;
export type WordObservationBatchRequest = z.infer<
  typeof wordObservationBatchRequestSchema
>;
export type WordObservationBatchData = z.infer<
  typeof wordObservationBatchDataSchema
>;

// Fixed sequential semantics exist for contract/documentation consumers.
export const wordLocalSessionSemanticsSchema = z.strictObject({
  domain: z.literal('word'),
  mode: wordStudyModeSchema,
  purpose: wordStudyPurposeSchema,
  ordering: wordStudyOrderingSchema,
  candidate_policy_version: wordCandidatePolicyVersionSchema,
});

wordLocalSessionSemanticsSchema.parse(WORD_LOCAL_SESSION_SEMANTICS);
