import { z } from 'zod';
import {
  PROBLEM_CONSTANTS,
  PROBLEM_SET_CONSTANTS,
  VALIDATION_CONSTANTS,
  ANSWER_CONFIG_CONSTANTS,
  USER_ROLES,
  GENDER_OPTIONS,
  SUBJECT_CONSTANTS,
  ATTEMPT_CONSTANTS,
  SPACED_REPETITION_CONSTANTS,
  ERROR_CATEGORY_VALUES,
  DISCOVERY_SUBJECTS,
} from './constants';
import { HumanRatingSchema } from './fsrs/schemas';
import { sanitizeHtmlContent } from './html-sanitizer';
import { isValidTimezone } from './timezone-utils';

// Database enum values - these should match the PostgreSQL enum type
// (problem_part_type). Since the gaokao shell model these are PART types:
// the shell itself has no type, its 1..10 inner parts each carry one.
export const PROBLEM_TYPE_VALUES = [
  PROBLEM_CONSTANTS.TYPES.SINGLE_CHOICE,
  PROBLEM_CONSTANTS.TYPES.MULTI_CHOICE,
  PROBLEM_CONSTANTS.TYPES.FILL_BLANK,
  PROBLEM_CONSTANTS.TYPES.SHORT_ANSWER,
  PROBLEM_CONSTANTS.TYPES.ESSAY,
] as const;
export const PROBLEM_STATUS_VALUES = [
  PROBLEM_CONSTANTS.STATUS.WRONG,
  PROBLEM_CONSTANTS.STATUS.NEEDS_REVIEW,
  PROBLEM_CONSTANTS.STATUS.MASTERED,
] as const;

export const ProblemType = z.enum(PROBLEM_TYPE_VALUES);
export type ProblemType = z.infer<typeof ProblemType>;
// Alias with the shell-model name; ProblemType is kept for the many existing
// consumers (filters, tables) whose values are now part types.
export const PartType = ProblemType;
export type PartType = ProblemType;

export const ProblemStatus = z.enum(PROBLEM_STATUS_VALUES);
export type ProblemStatus = z.infer<typeof ProblemStatus>;

// Custom Zod transformer for HTML content that sanitizes and validates
const htmlContent = z
  .string()
  .max(VALIDATION_CONSTANTS.STRING_LIMITS.TEXT_BODY_MAX)
  .transform(html => sanitizeHtmlContent(html))
  .optional();

// Derivation fields (image_id/display_path/preview_path) are written by the
// server-side WQNI pipeline and round-tripped by clients on edit; they must
// survive parsing or every save would orphan the derived objects.
const Asset = z.object({
  path: z.string(),
  kind: z.enum(['image', 'pdf']).optional(),
  pipeline_version: z.string().max(64).optional(),
  image_id: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  display_path: z.string().optional(),
  preview_path: z.string().optional(),
  gray4_image_id: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  gray4_display_path: z.string().optional(),
  gray4_preview_path: z.string().optional(),
});

export type ProblemAsset = z.infer<typeof Asset>;

// =====================================================
// Answer Configuration Schemas
// =====================================================

const MCQChoiceSchema = z.object({
  id: z.string().min(1).max(10),
  text: z
    .string()
    .max(ANSWER_CONFIG_CONSTANTS.MCQ.MAX_CHOICE_TEXT_LENGTH)
    .default(''),
});

const MCQAnswerConfigSchema = z
  .object({
    type: z.literal('mcq'),
    choices: z
      .array(MCQChoiceSchema)
      .min(ANSWER_CONFIG_CONSTANTS.MCQ.MIN_CHOICES)
      .max(ANSWER_CONFIG_CONSTANTS.MCQ.MAX_CHOICES),
    correct_choice_id: z.string().min(1),
    randomize_choices: z.boolean().optional().default(true),
  })
  .refine(data => data.choices.some(c => c.id === data.correct_choice_id), {
    message: 'correct_choice_id must match one of the choice IDs',
  });

const ShortAnswerTextConfigSchema = z.object({
  type: z.literal('short'),
  mode: z.literal('text'),
  acceptable_answers: z
    .array(
      z
        .string()
        .min(1)
        .max(ANSWER_CONFIG_CONSTANTS.SHORT_ANSWER.MAX_ANSWER_LENGTH)
    )
    .min(1)
    .max(ANSWER_CONFIG_CONSTANTS.SHORT_ANSWER.MAX_ACCEPTABLE_ANSWERS),
});

const ShortAnswerNumericConfigSchema = z.object({
  type: z.literal('short'),
  mode: z.literal('numeric'),
  numeric_config: z.object({
    correct_value: z.number(),
    tolerance: z
      .number()
      .min(ANSWER_CONFIG_CONSTANTS.SHORT_ANSWER.NUMERIC.MIN_TOLERANCE),
    unit: z
      .string()
      .max(ANSWER_CONFIG_CONSTANTS.SHORT_ANSWER.NUMERIC.MAX_UNIT_LENGTH)
      .optional(),
  }),
});

// Gaokao multi-choice: several correct choices, marked with the standard
// partial-credit rule (exact match = full marks, non-empty strict subset =
// partial ratio, any wrong pick = zero).
const MultiMCQAnswerConfigSchema = z
  .object({
    type: z.literal('multi_mcq'),
    choices: z
      .array(MCQChoiceSchema)
      .min(ANSWER_CONFIG_CONSTANTS.MCQ.MIN_CHOICES)
      .max(ANSWER_CONFIG_CONSTANTS.MCQ.MAX_CHOICES),
    correct_choice_ids: z.array(z.string().min(1)).min(1),
    partial_credit_ratio: z.number().min(0).max(1).optional(),
    randomize_choices: z.boolean().optional().default(true),
  })
  .refine(
    data =>
      data.correct_choice_ids.every(id =>
        data.choices.some(c => c.id === id)
      ) &&
      new Set(data.correct_choice_ids).size === data.correct_choice_ids.length,
    { message: 'correct_choice_ids must be distinct choice IDs' }
  );

export const AnswerConfigSchema = z.union([
  MCQAnswerConfigSchema,
  MultiMCQAnswerConfigSchema,
  ShortAnswerTextConfigSchema,
  ShortAnswerNumericConfigSchema,
]);

// =====================================================
// Shell model: problem parts and exam source
// =====================================================

// One inner part of a problem shell. Auto-markability is derived, not
// declared: a part with an answer_config (or bare correct_answer) can be
// auto-marked; short_answer/essay parts usually carry neither and are
// self-assessed.
export const ProblemPartSchema = z.object({
  index: z.number().int().min(1).max(PROBLEM_CONSTANTS.PARTS.MAX_COUNT),
  type: ProblemType,
  label: z.string().max(PROBLEM_CONSTANTS.PARTS.MAX_LABEL_LENGTH).optional(),
  full_marks: z
    .number()
    .int()
    .min(0)
    .max(PROBLEM_CONSTANTS.PARTS.MAX_FULL_MARKS)
    .optional(),
  content: htmlContent,
  correct_answer: z
    .string()
    .max(VALIDATION_CONSTANTS.STRING_LIMITS.TEXT_BODY_MAX)
    .optional(),
  answer_config: AnswerConfigSchema.nullable().optional(),
});

// The shell holds 1..10 parts with contiguous 1-based indexes -- nesting is
// capped at exactly one level by construction.
export const ProblemPartsSchema = z
  .array(ProblemPartSchema)
  .min(1)
  .max(PROBLEM_CONSTANTS.PARTS.MAX_COUNT)
  .refine(parts => parts.every((part, i) => part.index === i + 1), {
    message: 'part indexes must be contiguous starting at 1',
  });

// Parts as READ back from storage: answer_config tolerates unknown shapes
// (e.g. the word_mistake projection metadata that rides in that slot). The
// marking engine treats unrecognized configs as non-markable and falls back
// to the part's correct_answer, so reads must not reject them.
export const StoredProblemPartsSchema = z
  .array(
    ProblemPartSchema.extend({
      answer_config: z.record(z.string(), z.unknown()).nullable().optional(),
    })
  )
  .min(1)
  .max(PROBLEM_CONSTANTS.PARTS.MAX_COUNT)
  .refine(parts => parts.every((part, i) => part.index === i + 1), {
    message: 'part indexes must be contiguous starting at 1',
  });

// Exam provenance, deliberately loose (jsonb at rest): promote fields to
// columns only when query patterns demand it.
export const ProblemSourceSchema = z.object({
  year: z
    .number()
    .int()
    .min(PROBLEM_CONSTANTS.SOURCE.MIN_YEAR)
    .max(PROBLEM_CONSTANTS.SOURCE.MAX_YEAR)
    .optional(),
  paper: z.string().max(PROBLEM_CONSTANTS.SOURCE.MAX_PAPER_LENGTH).optional(),
  exam_type: z.enum(PROBLEM_CONSTANTS.SOURCE.EXAM_TYPES).optional(),
  question_no: z
    .string()
    .max(PROBLEM_CONSTANTS.SOURCE.MAX_QUESTION_NO_LENGTH)
    .optional(),
});

// Per-part outcome recorded on an attempt. score is only meaningful when the
// part declared full_marks; correct=null marks a self-assessed part the user
// has not judged yet.
export const PartResultSchema = z.object({
  index: z.number().int().min(1).max(PROBLEM_CONSTANTS.PARTS.MAX_COUNT),
  correct: z.boolean().nullable(),
  score: z.number().min(0).optional(),
});

export const ProblemInitialIdeaSchema = z
  .string()
  .min(1)
  .max(4000)
  .refine(value => value.trim().length > 0, {
    message: 'Initial idea cannot be blank',
  })
  .refine(value => new TextEncoder().encode(value).byteLength <= 16000, {
    message: 'Initial idea must be at most 16000 UTF-8 bytes',
  });

const ProblemWriteFields = z.object({
  subject_id: z.uuid(),
  title: z
    .string()
    .min(VALIDATION_CONSTANTS.STRING_LIMITS.TITLE_MIN)
    .max(VALIDATION_CONSTANTS.STRING_LIMITS.TITLE_MAX),
  content: htmlContent,
  parts: ProblemPartsSchema,
  source: ProblemSourceSchema,
  is_optional: z.boolean(),
  status: ProblemStatus,
  assets: z.array(Asset),
  solution_text: htmlContent,
  solution_assets: z.array(Asset),
  last_reviewed_date: z.string().optional(),
  tag_ids: z
    .array(z.uuid())
    .max(100)
    .refine(ids => new Set(ids).size === ids.length, {
      message: 'Tag IDs must be unique',
    })
    .optional(),
});

export const CreateProblemDto = ProblemWriteFields.extend({
  id: z.uuid().optional(), // Allow client-provided UUID for direct upload approach
  initial_idea: ProblemInitialIdeaSchema.optional(),
  source: ProblemSourceSchema.default({}),
  is_optional: z.boolean().default(false),
  status: ProblemStatus.default(PROBLEM_CONSTANTS.STATUS.NEEDS_REVIEW),
  assets: z.array(Asset).default([]),
  solution_assets: z.array(Asset).default([]),
});

export const UpdateProblemDto = ProblemWriteFields.partial().extend({
  initial_idea: ProblemInitialIdeaSchema.nullable().optional(),
});

export const CreateTagDto = z.object({
  subject_id: z.uuid(),
  name: z
    .string()
    .min(VALIDATION_CONSTANTS.STRING_LIMITS.TAG_NAME_MIN)
    .max(VALIDATION_CONSTANTS.STRING_LIMITS.TAG_NAME_MAX),
});

export const UpdateTagDto = z.object({
  name: z
    .string()
    .min(VALIDATION_CONSTANTS.STRING_LIMITS.TAG_NAME_MIN)
    .max(VALIDATION_CONSTANTS.STRING_LIMITS.TAG_NAME_MAX)
    .optional(),
});

export const CreateAttemptDto = z.object({
  problem_id: z.uuid(),
  submitted_answer: z.union([
    z.string().max(ATTEMPT_CONSTANTS.MAX_RESPONSE_LENGTH),
    z.number(),
    z.boolean(),
    z.record(z.string(), z.unknown()),
  ]),
  is_correct: z.boolean().nullable().optional(), // optional for manual types
  cause: z.string().max(ATTEMPT_CONSTANTS.MAX_CAUSE_LENGTH).optional(),
  is_self_assessed: z.boolean().default(false),
  confidence: z.number().int().min(1).max(5).nullable().optional(),
  reflection_notes: z
    .string()
    .max(ATTEMPT_CONSTANTS.MAX_REFLECTION_NOTES_LENGTH)
    .optional(),
});

export const UpdateAttemptDto = z.object({
  confidence: z.number().int().min(1).max(5).nullable().optional(),
  cause: z
    .string()
    .max(ATTEMPT_CONSTANTS.MAX_CAUSE_LENGTH)
    .nullable()
    .optional(),
  reflection_notes: z
    .string()
    .max(ATTEMPT_CONSTANTS.MAX_REFLECTION_NOTES_LENGTH)
    .nullable()
    .optional(),
  submitted_answer: z
    .union([
      z.string().max(ATTEMPT_CONSTANTS.MAX_RESPONSE_LENGTH),
      z.number(),
      z.boolean(),
      z.record(z.string(), z.unknown()),
    ])
    .optional(),
});

export const ProblemReviewRatingDto = z
  .object({
    attempt_id: z.uuid(),
    rating: HumanRatingSchema,
    review_occurrence_id: z.uuid(),
    request_id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  })
  .strict();

export const ProblemReviewRatingCorrectionDto = z
  .object({
    rating: HumanRatingSchema,
    review_occurrence_id: z.uuid(),
    terminal_event_id: z.uuid(),
    request_id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  })
  .strict();

export const ProblemReviewIdeaDto = z
  .object({
    review_occurrence_id: z.uuid(),
    idea: ProblemInitialIdeaSchema.nullable(),
  })
  .strict();

export const ListAttemptsQuery = z.object({
  problem_id: z.uuid(),
});

// =====================================================
// User Management Types
// =====================================================

// User roles enum
export const UserRole = z.enum([
  USER_ROLES.USER,
  USER_ROLES.MODERATOR,
  USER_ROLES.ADMIN,
  USER_ROLES.SUPER_ADMIN,
]);
export type UserRoleType = z.infer<typeof UserRole>;

// Gender enum
export const Gender = z.enum([
  GENDER_OPTIONS.MALE,
  GENDER_OPTIONS.FEMALE,
  GENDER_OPTIONS.OTHER,
  GENDER_OPTIONS.PREFER_NOT_TO_SAY,
]);
export type GenderType = z.infer<typeof Gender>;

// User profile schema
export const UserProfile = z.object({
  id: z.uuid(),
  username: z.string().nullable(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  date_of_birth: z.string().date().nullable(),
  gender: Gender.nullable(),
  region: z.string().nullable(),
  timezone: z
    .string()
    .refine(isValidTimezone, { message: 'Invalid IANA timezone' })
    .default('UTC'),
  avatar_url: z.url().nullable(),
  bio: z.string().nullable(),
  user_role: UserRole.default('user'),
  is_active: z.boolean().default(true),
  last_login_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export type UserProfileType = z.infer<typeof UserProfile>;

// User activity log schema
export const UserActivityLog = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  action: z.string(),
  resource_type: z.string().nullable(),
  resource_id: z.uuid().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
  ip_address: z.string().nullable(),
  user_agent: z.string().nullable(),
  created_at: z.iso.datetime(),
});

export type UserActivityLogType = z.infer<typeof UserActivityLog>;

// Admin settings schema
export const AdminSettings = z.object({
  id: z.uuid(),
  key: z.string(),
  value: z.record(z.string(), z.unknown()),
  description: z.string().nullable(),
  updated_by: z.uuid().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export type AdminSettingsType = z.infer<typeof AdminSettings>;

// User statistics schema
export const UserStatistics = z.object({
  total_users: z.number(),
  active_users: z.number(),
  admin_users: z.number(),
  new_users_today: z.number(),
  new_users_this_week: z.number(),
});

export type UserStatisticsType = z.infer<typeof UserStatistics>;

// Create/Update DTOs for user profiles
export const CreateUserProfileDto = z.object({
  username: z
    .string()
    .min(VALIDATION_CONSTANTS.STRING_LIMITS.USERNAME_MIN)
    .max(VALIDATION_CONSTANTS.STRING_LIMITS.USERNAME_MAX)
    .optional(),
  first_name: z
    .string()
    .min(VALIDATION_CONSTANTS.STRING_LIMITS.FIRST_NAME_MIN)
    .max(VALIDATION_CONSTANTS.STRING_LIMITS.FIRST_NAME_MAX)
    .optional(),
  last_name: z
    .string()
    .min(VALIDATION_CONSTANTS.STRING_LIMITS.LAST_NAME_MIN)
    .max(VALIDATION_CONSTANTS.STRING_LIMITS.LAST_NAME_MAX)
    .optional(),
  date_of_birth: z.iso.date().optional(),
  gender: Gender.optional(),
  region: z
    .string()
    .max(VALIDATION_CONSTANTS.STRING_LIMITS.REGION_MAX)
    .optional(),
  timezone: z
    .string()
    .refine(isValidTimezone, { message: 'Invalid IANA timezone' })
    .optional(),
  avatar_url: z.url().optional(),
  bio: z.string().max(VALIDATION_CONSTANTS.STRING_LIMITS.BIO_MAX).optional(),
});

export const UpdateUserProfileDto = CreateUserProfileDto.partial().extend({
  user_role: UserRole.optional(),
  is_active: z.boolean().optional(),
});

export const CreateAdminSettingsDto = z.object({
  key: z
    .string()
    .min(VALIDATION_CONSTANTS.STRING_LIMITS.SETTING_KEY_MIN)
    .max(VALIDATION_CONSTANTS.STRING_LIMITS.SETTING_KEY_MAX),
  value: z.record(z.string(), z.unknown()),
  description: z.string().optional(),
});

export const UpdateAdminSettingsDto = z.object({
  value: z.record(z.string(), z.unknown()),
  description: z.string().optional(),
});

// Extended user type that includes auth data
export interface ExtendedUser {
  id: string;
  email: string;
  profile: UserProfileType | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

// Admin dashboard data type
export interface AdminDashboardData {
  statistics: UserStatisticsType;
  recentUsers: UserProfileType[];
  recentActivity: UserActivityLogType[];
  systemSettings: AdminSettingsType[];
}

// Subject DTOs
export const CreateSubjectDto = z.object({
  name: z
    .string()
    .min(VALIDATION_CONSTANTS.STRING_LIMITS.SUBJECT_NAME_MIN)
    .max(VALIDATION_CONSTANTS.STRING_LIMITS.SUBJECT_NAME_MAX),
  color: z.enum(SUBJECT_CONSTANTS.COLORS).optional(),
  icon: z.enum(SUBJECT_CONSTANTS.ICONS).optional(),
});

export const UpdateSubjectDto = CreateSubjectDto.partial();

// =====================================================
// Problem Set Schemas
// =====================================================

export const ProblemSetSharingLevel = z.enum([
  PROBLEM_SET_CONSTANTS.SHARING_LEVELS.PRIVATE,
  PROBLEM_SET_CONSTANTS.SHARING_LEVELS.LIMITED,
  PROBLEM_SET_CONSTANTS.SHARING_LEVELS.PUBLIC,
]);
export type ProblemSetSharingLevel = z.infer<typeof ProblemSetSharingLevel>;

export const FilterConfigSchema = z.object({
  tag_ids: z.array(z.uuid()).default([]),
  statuses: z.array(ProblemStatus).default([]),
  problem_types: z.array(ProblemType).default([]),
  days_since_review: z.number().min(0).nullable().optional(),
  include_never_reviewed: z.boolean().default(true),
});

export const SessionConfigSchema = z.object({
  randomize: z.boolean().default(true),
  session_size: z.number().min(1).max(100).nullable().optional(),
  auto_advance: z.boolean().default(false),
});

export const StartSpacedSessionDto = z.object({
  subject_id: z.uuid(),
  session_size: z
    .number()
    .int()
    .min(1)
    .max(SPACED_REPETITION_CONSTANTS.MAX_SESSION_SIZE)
    .optional(),
});

export const CreateProblemSetDto = z.object({
  subject_id: z.uuid(),
  name: z
    .string()
    .min(VALIDATION_CONSTANTS.STRING_LIMITS.TITLE_MIN)
    .max(VALIDATION_CONSTANTS.STRING_LIMITS.TITLE_MAX),
  description: htmlContent,
  sharing_level: ProblemSetSharingLevel.default(
    PROBLEM_SET_CONSTANTS.SHARING_LEVELS.PRIVATE
  ),
  shared_with_emails: z.array(z.email()).optional(),
  problem_ids: z.array(z.uuid()).optional(),
  is_smart: z.boolean().default(false),
  filter_config: FilterConfigSchema.nullable().optional(),
  session_config: SessionConfigSchema.nullable().optional(),
  allow_copying: z.boolean().default(true),
});

export const UpdateProblemSetDto = CreateProblemSetDto.extend({
  is_listed: z.boolean().optional(),
  discovery_subject: z
    .string()
    .nullable()
    .optional()
    .refine(
      val => !val || (DISCOVERY_SUBJECTS as readonly string[]).includes(val),
      { message: 'Invalid discovery subject' }
    )
    .transform(val => val || null),
})
  .partial()
  .omit({
    subject_id: true,
  });

export const AddProblemsToSetDto = z.object({
  problem_ids: z.array(z.uuid()),
});

export const RemoveProblemsFromSetDto = z.object({
  problem_ids: z.array(z.uuid()),
});

// =====================================================
// QR Upload Session Schemas
// =====================================================

// =====================================================
// Error Categorisation & Insights Schemas
// =====================================================

export const ErrorBroadCategorySchema = z.enum(ERROR_CATEGORY_VALUES);

export const AICategorisationResponseSchema = z.object({
  broad_category: ErrorBroadCategorySchema,
  granular_tag: z.string().min(1).max(200),
  topic_label: z.string().min(1).max(200),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(1000),
});

export const UpdateErrorCategorisationDto = z.object({
  broad_category: ErrorBroadCategorySchema.optional(),
  granular_tag: z.string().min(1).max(200).optional(),
});

export const StartInsightsReviewDto = z.object({
  subject_id: z.uuid(),
  problem_ids: z.array(z.uuid()).min(1).max(50),
});

export const QRSessionIdParam = z.uuid();
