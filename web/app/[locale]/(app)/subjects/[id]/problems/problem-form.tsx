'use client';

import { useRouter } from '@/i18n/navigation';
import {
  FormEvent,
  useEffect,
  useState,
  useMemo,
  useCallback,
  useRef,
} from 'react';
import { toast } from 'sonner';
import { useUnsavedChanges } from '@/lib/hooks/useUnsavedChanges';
import FileManager from '@/components/ui/file-manager';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { PROBLEM_TYPE_VALUES, type ProblemType } from '@/lib/schemas';
import { getProblemTypeDisplayName, isValidUuid } from '@/lib/common-utils';
import { RichTextEditor, type RichTextEditorHandle } from '@/components/editor';
import { MCQChoiceEditor } from '@/components/ui/mcq-choice-editor';
import {
  ShortAnswerConfig,
  type ShortAnswerConfigValue,
} from '@/components/ui/short-answer-config';
import {
  VALIDATION_CONSTANTS,
  ANSWER_CONFIG_CONSTANTS,
  PROBLEM_CONSTANTS,
} from '@/lib/constants';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  SimpleTag,
  ProblemFormProps,
  MCQChoice,
  AnswerConfig,
  ProblemPart,
  ExtractedProblemData,
} from '@/lib/types';
import {
  ImageScanUploader,
  type ExtractionQuota,
  type ImageAttachment,
} from '@/components/ui/image-scan-uploader';
import { convertMathTextToTipTapHtml } from '@/lib/math-to-tiptap';
import { uploadFiles } from '@/lib/storage/client';
import { apiUrl } from '@/lib/api-utils';
import { PenLine, Plus, ScanLine, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

// =====================================================
// Shell-model part drafts: one homogeneous card per part
// =====================================================

// Every part is edited through the SAME card (type + label + marks + answer
// area). Draft state for every editor kind coexists per part, so switching a
// part's type back and forth never loses input.
interface PartDraft {
  type: ProblemType;
  /** Display label, e.g. "(1)"; auto-renumbered until the user touches it. */
  label: string;
  labelTouched: boolean;
  fullMarks: string;
  /** Simple text answer (choice fallback / fill-blank / short simple mode). */
  answerText: string;
  // Choice builder state
  choices: MCQChoice[];
  correctChoiceId: string;
  multiCorrectText: string;
  randomizeChoices: boolean;
  useChoicePicker: boolean;
  // Short-answer advanced state
  shortConfig: ShortAnswerConfigValue;
  useAdvancedShort: boolean;
}

function defaultDraftChoices(): MCQChoice[] {
  return ANSWER_CONFIG_CONSTANTS.MCQ.DEFAULT_CHOICES.map(id => ({
    id,
    text: '',
  }));
}

function makePartDraft(
  position: number,
  type: ProblemType = 'short_answer'
): PartDraft {
  return {
    type,
    label: `(${position})`,
    labelTouched: false,
    fullMarks: '',
    answerText: '',
    choices: defaultDraftChoices(),
    correctChoiceId: '',
    multiCorrectText: '',
    randomizeChoices: true,
    useChoicePicker: true,
    shortConfig: { mode: 'text', acceptable_answers: [] },
    useAdvancedShort: false,
  };
}

function draftFromPart(part: ProblemPart, position: number): PartDraft {
  const draft = makePartDraft(position, part.type);
  draft.label = part.label || `(${position})`;
  draft.labelTouched = !!part.label && part.label !== `(${position})`;
  draft.fullMarks =
    part.full_marks !== undefined ? String(part.full_marks) : '';
  draft.answerText = part.correct_answer || '';
  const config = part.answer_config;
  if (config?.type === 'mcq') {
    draft.choices = config.choices;
    draft.correctChoiceId = config.correct_choice_id;
    draft.randomizeChoices = config.randomize_choices ?? true;
  } else if (config?.type === 'multi_mcq') {
    draft.choices = config.choices;
    draft.multiCorrectText = config.correct_choice_ids.join('');
    draft.randomizeChoices = config.randomize_choices ?? true;
  } else if (config?.type === 'short') {
    draft.useAdvancedShort = true;
    draft.shortConfig =
      config.mode === 'text'
        ? { mode: 'text', acceptable_answers: config.acceptable_answers }
        : {
            mode: 'numeric',
            numeric_config: {
              correct_value: config.numeric_config.correct_value,
              tolerance: config.numeric_config.tolerance,
              unit: config.numeric_config.unit,
            },
          };
  } else if (
    (part.type === 'single_choice' || part.type === 'multi_choice') &&
    part.correct_answer
  ) {
    // A choice part answered by plain text keeps the picker off on edit.
    draft.useChoicePicker = false;
  }
  return draft;
}

/** Correct choice ids parsed from compact letters, limited to existing ids. */
function multiIdsOf(draft: PartDraft): string[] {
  const available = new Set(draft.choices.map(choice => choice.id));
  return [
    ...new Set(
      draft.multiCorrectText
        .toUpperCase()
        .split('')
        .map(letter => letter.trim())
        .filter(letter => available.has(letter))
    ),
  ];
}

function buildDraftAnswerConfig(draft: PartDraft): AnswerConfig | null {
  if (draft.type === 'single_choice' && draft.useChoicePicker) {
    if (!draft.correctChoiceId) return null;
    return {
      type: 'mcq',
      choices: draft.choices,
      correct_choice_id: draft.correctChoiceId,
      randomize_choices: draft.randomizeChoices,
    };
  }
  if (draft.type === 'multi_choice' && draft.useChoicePicker) {
    const ids = multiIdsOf(draft);
    if (ids.length === 0) return null;
    return {
      type: 'multi_mcq',
      choices: draft.choices,
      correct_choice_ids: ids,
      randomize_choices: draft.randomizeChoices,
    };
  }
  if (
    (draft.type === 'fill_blank' || draft.type === 'short_answer') &&
    draft.useAdvancedShort
  ) {
    if (draft.shortConfig.mode === 'text') {
      if (draft.shortConfig.acceptable_answers.length === 0) return null;
      return {
        type: 'short',
        mode: 'text',
        acceptable_answers: draft.shortConfig.acceptable_answers,
      };
    }
    const nc = draft.shortConfig.numeric_config;
    if (nc.correct_value === '' || nc.tolerance === '') return null;
    return {
      type: 'short',
      mode: 'numeric',
      numeric_config: {
        correct_value: Number(nc.correct_value),
        tolerance: Number(nc.tolerance),
        unit: nc.unit || undefined,
      },
    };
  }
  return null;
}

function buildDraftAnswerText(draft: PartDraft): string {
  if (draft.type === 'single_choice') {
    return draft.useChoicePicker && draft.correctChoiceId
      ? draft.correctChoiceId
      : draft.answerText;
  }
  if (draft.type === 'multi_choice') {
    if (draft.useChoicePicker) return multiIdsOf(draft).join('');
    return draft.answerText;
  }
  if (draft.useAdvancedShort) {
    if (draft.shortConfig.mode === 'text') {
      return draft.shortConfig.acceptable_answers[0] || '';
    }
    if (draft.shortConfig.numeric_config.correct_value !== '') {
      return String(draft.shortConfig.numeric_config.correct_value);
    }
    return '';
  }
  return draft.answerText;
}

/** After insert/remove: renumber every label the user never touched. */
function renumberDrafts(drafts: PartDraft[]): PartDraft[] {
  return drafts.map((draft, i) =>
    draft.labelTouched ? draft : { ...draft, label: `(${i + 1})` }
  );
}

// Auto-growing answer textarea: expands downward with content instead of
// scrolling inside a fixed box (short-answer / essay reference answers).
function AutoGrowTextarea({
  value,
  placeholder,
  onValueChange,
  disabled,
}: {
  value: string;
  placeholder?: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
}) {
  const grow = (element: HTMLTextAreaElement | null) => {
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  };
  return (
    <Textarea
      ref={grow}
      rows={2}
      className="form-input min-h-[3.5rem] resize-none overflow-hidden"
      placeholder={placeholder}
      value={value}
      maxLength={VALIDATION_CONSTANTS.STRING_LIMITS.TEXT_BODY_MAX}
      onChange={e => {
        onValueChange(e.target.value);
        grow(e.currentTarget);
      }}
      disabled={disabled}
    />
  );
}

// One homogeneous editor card per part. showShellChrome hides the shell
// affordances (position badge, label, remove) while the problem is a plain
// single-part one, so simple problems keep the zero-ceremony flow.
function PartEditorCard({
  draft,
  position,
  showShellChrome,
  disabled,
  onPatch,
  onRemove,
}: {
  draft: PartDraft;
  position: number;
  showShellChrome: boolean;
  disabled: boolean;
  onPatch: (patch: Partial<PartDraft>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('Subjects');
  const tProblems = useTranslations('Problems');
  const isChoice =
    draft.type === 'single_choice' || draft.type === 'multi_choice';
  const isShortLike =
    draft.type === 'fill_blank' || draft.type === 'short_answer';

  return (
    <div className="rounded-xl border border-blue-200/50 dark:border-blue-800/40 bg-white/50 dark:bg-gray-900/30 p-3 space-y-3">
      {/* Header: position + label + type + marks + remove */}
      <div className="flex flex-wrap items-center gap-2">
        {showShellChrome && (
          <span className="flex h-7 w-9 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-xs font-semibold text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">
            ({position})
          </span>
        )}
        {showShellChrome && (
          <Input
            className="form-input w-20"
            placeholder={tProblems('partLabelField')}
            maxLength={16}
            value={draft.label}
            onChange={e =>
              onPatch({ label: e.target.value, labelTouched: true })
            }
            disabled={disabled}
          />
        )}
        <Select
          value={draft.type}
          onValueChange={value => onPatch({ type: value as ProblemType })}
        >
          <SelectTrigger className="w-36 rounded-xl">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROBLEM_TYPE_VALUES.map(type => (
              <SelectItem key={type} value={type}>
                {tProblems(getProblemTypeDisplayName(type))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="number"
          className="form-input w-24"
          placeholder={tProblems('fullMarksField')}
          min={0}
          max={150}
          value={draft.fullMarks}
          onChange={e => onPatch({ fullMarks: e.target.value })}
          disabled={disabled}
        />
        {showShellChrome && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={onRemove}
            disabled={disabled}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Answer area, per type */}
      {isChoice && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch
                id={`part-${position}-picker`}
                checked={draft.useChoicePicker}
                onCheckedChange={checked =>
                  onPatch({ useChoicePicker: checked })
                }
                disabled={disabled}
              />
              <Label
                htmlFor={`part-${position}-picker`}
                className="text-sm cursor-pointer"
              >
                {t('useChoicePicker')}
              </Label>
            </div>
            {draft.useChoicePicker && (
              <div className="flex items-center gap-2">
                <Switch
                  id={`part-${position}-randomize`}
                  checked={draft.randomizeChoices}
                  onCheckedChange={checked =>
                    onPatch({ randomizeChoices: checked })
                  }
                  disabled={disabled}
                />
                <Label
                  htmlFor={`part-${position}-randomize`}
                  className="text-sm cursor-pointer"
                >
                  {t('randomizeChoices')}
                </Label>
              </div>
            )}
          </div>

          {draft.useChoicePicker ? (
            <MCQChoiceEditor
              choices={draft.choices}
              correctChoiceId={
                draft.type === 'multi_choice' ? '' : draft.correctChoiceId
              }
              correctChoiceIds={
                draft.type === 'multi_choice' ? multiIdsOf(draft) : undefined
              }
              onChoicesChange={choices => onPatch({ choices })}
              onCorrectChoiceChange={
                draft.type === 'multi_choice'
                  ? choiceId => {
                      // Toggle membership in the correct set (gaokao
                      // multi-choice): click letters to mark them.
                      const ids = multiIdsOf(draft);
                      const next = ids.includes(choiceId)
                        ? ids.filter(id => id !== choiceId)
                        : [...ids, choiceId];
                      onPatch({ multiCorrectText: next.join('') });
                    }
                  : correctChoiceId => onPatch({ correctChoiceId })
              }
              disabled={disabled}
            />
          ) : (
            <div className="form-row">
              <label className="form-label">{t('correctChoice')}</label>
              <Input
                className="form-input w-32"
                placeholder={t('correctChoicePlaceholder')}
                value={draft.answerText}
                maxLength={VALIDATION_CONSTANTS.STRING_LIMITS.TEXT_BODY_MAX}
                onChange={e => onPatch({ answerText: e.target.value })}
                disabled={disabled}
              />
            </div>
          )}
        </div>
      )}

      {isShortLike && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Switch
              id={`part-${position}-advanced`}
              checked={draft.useAdvancedShort}
              onCheckedChange={checked =>
                onPatch({ useAdvancedShort: checked })
              }
              disabled={disabled}
            />
            <Label
              htmlFor={`part-${position}-advanced`}
              className="text-sm cursor-pointer"
            >
              {t('advancedMode')}
            </Label>
          </div>

          {draft.useAdvancedShort ? (
            <ShortAnswerConfig
              value={draft.shortConfig}
              onChange={shortConfig => onPatch({ shortConfig })}
              disabled={disabled}
            />
          ) : draft.type === 'fill_blank' ? (
            <div className="form-row">
              <label className="form-label">{t('correctText')}</label>
              <Input
                className="form-input"
                placeholder={t('correctTextPlaceholder')}
                value={draft.answerText}
                maxLength={VALIDATION_CONSTANTS.STRING_LIMITS.TEXT_BODY_MAX}
                onChange={e => onPatch({ answerText: e.target.value })}
                disabled={disabled}
              />
            </div>
          ) : (
            <div className="form-row-start">
              <label className="form-label pt-2">{t('correctText')}</label>
              <AutoGrowTextarea
                value={draft.answerText}
                placeholder={t('correctTextPlaceholder')}
                onValueChange={answerText => onPatch({ answerText })}
                disabled={disabled}
              />
            </div>
          )}
        </div>
      )}

      {/* Essay parts: a reference answer / worked solution, self-assessed at
          review time. */}
      {draft.type === 'essay' && (
        <div className="form-row-start">
          <label className="form-label pt-2">
            {tProblems('partAnswerField')}
          </label>
          <AutoGrowTextarea
            value={draft.answerText}
            placeholder={tProblems('essayAnswerPlaceholder')}
            onValueChange={answerText => onPatch({ answerText })}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}

export default function ProblemForm({
  subjectId,
  availableTags = [],
  problem = null,
  onCancel = null,
  onProblemCreated = null,
  onProblemUpdated = null,
  alwaysExpanded = false,
  initialShowImageScan = false,
}: ProblemFormProps) {
  const t = useTranslations('Subjects');
  const tCommon = useTranslations('Common');
  const tProblems = useTranslations('Problems');
  const router = useRouter();
  const isEditMode = !!problem;

  // Refs for the rich text editors
  const contentEditorRef = useRef<RichTextEditorHandle>(null);

  // Key for remounting editors on form reset
  const [editorKey, setEditorKey] = useState(0);

  // Use provided tags or fallback to client-side fetching
  const [tags, setTags] = useState<SimpleTag[]>(availableTags ?? []);
  useEffect(() => {
    if (availableTags && availableTags.length > 0) {
      setTags(availableTags);
    } else {
      // Fallback to client-side fetching if no tags provided
      fetch(apiUrl(`/api/tags?subject_id=${subjectId}`))
        .then(r => r.json())
        .then(j => setTags(j.data ?? []))
        .catch(() => {});
    }
  }, [availableTags, subjectId]);

  // Tag picker - initialize with problem's existing tags if available
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(() => {
    // If we have problem data with tags, use those; otherwise start empty
    if (problem && problem.tags) {
      return problem.tags.map((tag: any) => tag.id);
    }
    return [];
  });

  const [pendingNewTags, setPendingNewTags] = useState<string[]>([]);
  const [deselectedPendingTags, setDeselectedPendingTags] = useState<
    Set<string>
  >(new Set());
  const [newTagName, setNewTagName] = useState('');
  const [creatingTag, setCreatingTag] = useState(false);

  function toggleTag(id: string) {
    setSelectedTagIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }

  async function handleCreateTag() {
    const trimmed = newTagName.trim();
    if (!trimmed) return;
    if (tags.some(t => t.name.toLowerCase() === trimmed.toLowerCase())) {
      toast.error(t('tagExists'));
      return;
    }

    setCreatingTag(true);
    try {
      const res = await fetch(apiUrl('/api/tags'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject_id: subjectId, name: trimmed }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error ?? 'Failed to create tag');

      const created: SimpleTag = j.data;
      setTags(prev => [...prev, created]);
      setSelectedTagIds(prev => [...prev, created.id]);
      setNewTagName('');
      toast.success(t('tagCreated'));
    } catch (e: any) {
      toast.error(e.message || t('couldNotCreateTag'));
    } finally {
      setCreatingTag(false);
    }
  }

  // Image insertion callbacks
  const handleInsertProblemImage = useCallback(
    (path: string, name: string) => {
      if (!contentEditorRef.current?.editor) {
        toast.error(t('editorNotReady'));
        return;
      }

      const imageUrl = `/api/files/${encodeURIComponent(path)}`;
      contentEditorRef.current.editor
        .chain()
        .focus()
        .setResizableImage({
          src: imageUrl,
          alt: name,
        })
        .run();

      toast.success(t('imageInserted'));
    },
    [t]
  );

  // Form expansion state (only for create mode)
  const [isExpanded, setIsExpanded] = useState(isEditMode || alwaysExpanded);
  const [showImageScan, setShowImageScan] = useState(
    initialShowImageScan ?? false
  );

  // Extraction quota state — fetched once, updated from extraction responses
  const [extractionQuota, setExtractionQuota] =
    useState<ExtractionQuota | null>(null);
  useEffect(() => {
    if (isEditMode) return;
    fetch(apiUrl('/api/ai/extract-problem/quota'))
      .then(res => res.json())
      .then(json => {
        if (json.data) setExtractionQuota(json.data);
      })
      .catch(() => {});
  }, [isEditMode]);

  const [pendingImageAttachment, setPendingImageAttachment] = useState<{
    file: File;
    roles: ('problem' | 'solution')[];
  } | null>(null);

  const handleExtractionComplete = useCallback(
    (data: ExtractedProblemData, imageAttachment?: ImageAttachment) => {
      setTitle(data.title);
      // Normalize an extracted type: tolerate the legacy trio alongside the
      // shell part types.
      const legacyTypeMap: Record<string, ProblemType> = {
        mcq: 'single_choice',
        short: 'short_answer',
        extended: 'essay',
      };
      const normalizeType = (rawType: string): ProblemType =>
        (PROBLEM_TYPE_VALUES as readonly string[]).includes(rawType)
          ? (rawType as ProblemType)
          : (legacyTypeMap[rawType] ?? 'short_answer');

      // Build one draft card from one extracted part (type, choices, hints).
      const draftFromExtractedPart = (
        position: number,
        rawType: string,
        label: string | null | undefined,
        fullMarks: number | null | undefined,
        choices: { id: string; text: string }[] | undefined,
        hint: ExtractedProblemData['answer_hint']
      ): PartDraft => {
        const type = normalizeType(rawType);
        const isChoice = type === 'single_choice' || type === 'multi_choice';
        const isShortLike = type === 'fill_blank' || type === 'short_answer';
        const draft = makePartDraft(position, type);
        if (label && label.trim()) {
          draft.label = label.trim();
          draft.labelTouched = draft.label !== `(${position})`;
        }
        if (fullMarks !== null && fullMarks !== undefined) {
          draft.fullMarks = String(fullMarks);
        }
        if (isChoice && choices && choices.length > 0) {
          draft.choices = choices;
        }
        if (hint) {
          if (isChoice && hint.mcq_correct_choice_id) {
            if (type === 'multi_choice') {
              draft.multiCorrectText = hint.mcq_correct_choice_id;
            } else {
              draft.correctChoiceId = hint.mcq_correct_choice_id;
            }
          }
          if (isShortLike && hint.short_answer_value) {
            draft.useAdvancedShort = true;
            if (hint.short_answer_is_numeric) {
              const numVal = Number(hint.short_answer_value);
              if (!isNaN(numVal)) {
                draft.shortConfig = {
                  mode: 'numeric',
                  numeric_config: {
                    correct_value: numVal,
                    tolerance: 0,
                    unit: '',
                  },
                };
              } else {
                draft.shortConfig = {
                  mode: 'text',
                  acceptable_answers: [hint.short_answer_value],
                };
              }
            } else {
              draft.shortConfig = {
                mode: 'text',
                acceptable_answers: [hint.short_answer_value],
              };
            }
          }
          if (type === 'essay' && hint.extended_working) {
            // The transcribed working goes into the essay part's reference
            // answer (the standalone solution section is gone).
            draft.answerText = hint.extended_working;
          }
        }
        return draft;
      };

      // Shell-model extraction: shared stem + one card per part. Each
      // part's own text is appended to the stem under its label so the
      // full problem reads top-to-bottom in the content editor, while
      // type/choices/answers live on the matching part card. Legacy
      // single-part responses (no parts array) fall back to one card
      // built from the flat fields.
      const capped = (data.parts ?? []).slice(
        0,
        PROBLEM_CONSTANTS.PARTS.MAX_COUNT
      );
      const stemBlocks: string[] = [];
      if (data.content.trim()) stemBlocks.push(data.content.trim());
      if (capped.length > 1) {
        for (const part of capped) {
          const partLabel = part.label?.trim() || `(${part.index})`;
          const partText = part.content?.trim();
          if (partText) stemBlocks.push(`${partLabel} ${partText}`);
        }
      } else if (capped[0]?.content?.trim()) {
        stemBlocks.push(capped[0].content.trim());
      }
      const html = convertMathTextToTipTapHtml(stemBlocks.join('\n'));
      // Update editor imperatively — onChange callback will sync form state
      contentEditorRef.current?.setContent(html);
      // Also update form state directly in case editor isn't mounted yet
      setContent(html);

      if (capped.length > 0) {
        setParts(
          capped.map((part, i) =>
            draftFromExtractedPart(
              i + 1,
              part.type,
              capped.length > 1 ? part.label : null,
              part.full_marks,
              part.mcq_choices,
              part.answer_hint
            )
          )
        );
      } else {
        setParts([
          draftFromExtractedPart(
            1,
            (data.problem_type as string) ?? 'short_answer',
            null,
            null,
            data.mcq_choices,
            data.answer_hint
          ),
        ]);
      }

      if (imageAttachment) {
        const roles: ('problem' | 'solution')[] = [];
        if (imageAttachment.saveAsProblemAsset) roles.push('problem');
        if (imageAttachment.saveAsSolutionAsset) roles.push('solution');
        if (roles.length > 0) {
          setPendingImageAttachment({ file: imageAttachment.file, roles });
        }
      }

      // Pre-select suggested existing tags and store new tag suggestions
      if (data.suggested_tags) {
        const existingIds = data.suggested_tags.existing.map(t => t.id);
        setSelectedTagIds(prev => {
          const combined = new Set([...prev, ...existingIds]);
          return Array.from(combined);
        });

        const newNames = data.suggested_tags.new
          .map(t => t.name)
          .filter(
            name => !tags.some(t => t.name.toLowerCase() === name.toLowerCase())
          );
        setPendingNewTags(newNames);
        setDeselectedPendingTags(new Set());
      }

      setShowImageScan(false);
      setIsExpanded(true);
    },
    [tags]
  );

  const [title, setTitle] = useState(problem?.title || '');
  const [titleFocus, setTitleFocus] = useState(false);
  const [content, setContent] = useState(problem?.content || '');
  // Shell model: every part is one homogeneous draft card; a plain problem
  // is simply a one-card shell with the shell chrome hidden.
  const [parts, setParts] = useState<PartDraft[]>(() =>
    problem?.parts?.length
      ? problem.parts.map((part: ProblemPart, i: number) =>
          draftFromPart(part, i + 1)
        )
      : [makePartDraft(1)]
  );
  const patchPart = (index: number, patch: Partial<PartDraft>) =>
    setParts(prev =>
      prev.map((draft, i) => (i === index ? { ...draft, ...patch } : draft))
    );
  const removePart = (index: number) =>
    setParts(prev => renumberDrafts(prev.filter((_, i) => i !== index)));
  const addPart = () =>
    setParts(prev =>
      prev.length >= PROBLEM_CONSTANTS.PARTS.MAX_COUNT
        ? prev
        : [...prev, makePartDraft(prev.length + 1)]
    );
  // 合计分值 anchor: only shown when EVERY part declares marks.
  const totalMarks = useMemo(() => {
    let sum = 0;
    for (const draft of parts) {
      const value = draft.fullMarks.trim();
      if (value === '' || isNaN(Number(value))) return null;
      sum += Number(value);
    }
    return sum;
  }, [parts]);
  // Exam provenance (shell level)
  const [sourceYear, setSourceYear] = useState(
    problem?.source?.year !== undefined ? String(problem.source.year) : ''
  );
  const [sourcePaper, setSourcePaper] = useState(problem?.source?.paper || '');
  const [sourceExamType, setSourceExamType] = useState<string>(
    problem?.source?.exam_type || ''
  );
  const [sourceQuestionNo, setSourceQuestionNo] = useState(
    problem?.source?.question_no || ''
  );
  const [isOptionalShell, setIsOptionalShell] = useState(
    problem?.is_optional || false
  );
  const [status, setStatus] = useState<'wrong' | 'needs_review' | 'mastered'>(
    problem?.status || 'needs_review'
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Assets
  const [problemAssets, setProblemAssets] = useState<
    Array<{ path: string; name: string }>
  >(
    problem?.assets?.map((asset: any) => ({
      path: asset.path,
      name: asset.path.split('/').pop() || '',
    })) || []
  );
  const [solutionText, setSolutionText] = useState(
    problem?.solution_text || ''
  );
  const [solutionAssets, setSolutionAssets] = useState<
    Array<{ path: string; name: string }>
  >(
    problem?.solution_assets?.map((asset: any) => ({
      path: asset.path,
      name: asset.path.split('/').pop() || '',
    })) || []
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();

    if (!title.trim()) {
      toast.error(t('titleRequired'));
      return;
    }

    // Per-part validation; error messages carry the part label when the
    // shell has more than one part.
    for (let i = 0; i < parts.length; i++) {
      const draft = parts[i];
      const prefix =
        parts.length > 1 ? `${draft.label.trim() || `(${i + 1})`} ` : '';
      if (
        draft.type === 'single_choice' &&
        draft.useChoicePicker &&
        !draft.correctChoiceId
      ) {
        toast.error(prefix + t('correctChoiceRequired'));
        return;
      }
      if (
        draft.type === 'multi_choice' &&
        draft.useChoicePicker &&
        multiIdsOf(draft).length === 0
      ) {
        toast.error(prefix + t('correctChoiceRequired'));
        return;
      }
      if (
        (draft.type === 'fill_blank' || draft.type === 'short_answer') &&
        draft.useAdvancedShort
      ) {
        if (
          draft.shortConfig.mode === 'text' &&
          draft.shortConfig.acceptable_answers.length === 0
        ) {
          toast.error(prefix + t('addAtLeastOneAnswer'));
          return;
        }
        if (draft.shortConfig.mode === 'numeric') {
          const nc = draft.shortConfig.numeric_config;
          if (nc.correct_value === '' || nc.tolerance === '') {
            toast.error(prefix + t('fillCorrectValueAndTolerance'));
            return;
          }
        }
      }
    }

    setIsSubmitting(true);

    try {
      const assets = problemAssets.map(asset => ({ path: asset.path }));
      const solution_assets = solutionAssets.map(asset => ({
        path: asset.path,
      }));

      // Sanitize input data
      const sanitizedTitle = title
        .trim()
        .substring(0, VALIDATION_CONSTANTS.STRING_LIMITS.TITLE_MAX);
      const sanitizedContent = content
        ? content.substring(0, VALIDATION_CONSTANTS.STRING_LIMITS.TEXT_BODY_MAX)
        : '';
      const sanitizedSolutionText = solutionText
        ? solutionText.substring(
            0,
            VALIDATION_CONSTANTS.STRING_LIMITS.TEXT_BODY_MAX
          )
        : '';

      // Assemble the shell from the homogeneous part cards. Indexes are
      // contiguous from 1; labels only make sense on multi-part shells.
      const partsPayload: Record<string, unknown>[] = parts.map((draft, i) => {
        const answerText = buildDraftAnswerText(draft)
          .trim()
          .substring(0, VALIDATION_CONSTANTS.STRING_LIMITS.TEXT_BODY_MAX);
        const config = buildDraftAnswerConfig(draft);
        const marks = draft.fullMarks.trim();
        return {
          index: i + 1,
          type: draft.type,
          ...(parts.length > 1 && draft.label.trim()
            ? { label: draft.label.trim() }
            : {}),
          ...(marks !== '' && !isNaN(Number(marks))
            ? { full_marks: Number(marks) }
            : {}),
          ...(answerText ? { correct_answer: answerText } : {}),
          ...(config ? { answer_config: config } : {}),
        };
      });

      const source: Record<string, unknown> = {
        ...(sourceYear.trim() !== '' && !isNaN(Number(sourceYear.trim()))
          ? { year: Number(sourceYear.trim()) }
          : {}),
        ...(sourcePaper.trim() ? { paper: sourcePaper.trim() } : {}),
        ...(sourceExamType ? { exam_type: sourceExamType } : {}),
        ...(sourceQuestionNo.trim()
          ? { question_no: sourceQuestionNo.trim() }
          : {}),
      };

      // Create any pending new tags before submitting the problem
      const finalTagIds = [...selectedTagIds];
      const activePendingTags = pendingNewTags.filter(
        n => !deselectedPendingTags.has(n)
      );
      const createdTagNames: string[] = [];
      if (activePendingTags.length > 0) {
        for (const tagName of activePendingTags) {
          const existing = tags.find(
            t => t.name.toLowerCase() === tagName.toLowerCase()
          );
          if (existing) {
            if (!finalTagIds.includes(existing.id)) {
              finalTagIds.push(existing.id);
            }
            createdTagNames.push(tagName);
            continue;
          }
          try {
            const res = await fetch(apiUrl('/api/tags'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ subject_id: subjectId, name: tagName }),
            });
            const j = await res.json().catch(() => ({}));
            if (res.ok && j.data) {
              const created: SimpleTag = j.data;
              setTags(prev => [...prev, created]);
              finalTagIds.push(created.id);
              createdTagNames.push(tagName);
            } else if (res.status === 403) {
              toast.warning(
                `${t('couldNotCreateTag')} "${tagName}": ${t('tagLimitReached')}`
              );
            }
          } catch {
            toast.warning(`${t('couldNotCreateTag')} "${tagName}"`);
          }
        }
        // Sync selectedTagIds to include created/matched tags so the UI
        // reflects them even if the problem save fails and the user retries.
        setSelectedTagIds(finalTagIds);
        // Remove only the tags that were successfully created/matched,
        // keeping any that failed so they can be retried.
        setPendingNewTags(prev =>
          prev.filter(n => !createdTagNames.includes(n))
        );
        setDeselectedPendingTags(prev => {
          const next = new Set(prev);
          for (const n of createdTagNames) next.delete(n);
          return next;
        });
      }

      const payload: Record<string, any> = {
        title: sanitizedTitle,
        content: sanitizedContent,
        parts: partsPayload,
        source,
        is_optional: isOptionalShell,
        status,
        assets,
        solution_text: sanitizedSolutionText,
        solution_assets,
        tag_ids: finalTagIds,
      };

      // Add subject_id and problem_id for create operations
      if (!isEditMode) {
        (payload as any).subject_id = subjectId;
        // Only send client-generated UUID if it's a valid UUID (not the fallback rnd- timestamp)
        if (problemUuid && isValidUuid(problemUuid)) {
          (payload as any).id = problemUuid;
        }
      }

      const url = isEditMode ? `/api/problems/${problem.id}` : '/api/problems';
      const method = isEditMode ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          j?.error ?? `Failed to ${isEditMode ? 'update' : 'create'} problem`
        );
      }

      toast.success(isEditMode ? t('problemUpdated') : t('problemCreated'));

      if (isEditMode) {
        // In edit mode, notify parent component with updated problem data
        if (onProblemUpdated && j.data) {
          onProblemUpdated(j.data);
        }
        // Close the form
        if (onCancel) {
          onCancel();
        }
      } else {
        // For create mode, notify parent component with new problem data
        if (onProblemCreated && j.data) {
          onProblemCreated(j.data);
        }

        // Reset some fields for create mode
        setTitle('');
        setContent('');
        setSolutionText('');
        setEditorKey(k => k + 1); // Remount editors to clear content
        setProblemAssets([]);
        setSolutionAssets([]);
        setParts([makePartDraft(1)]);
        setSelectedTagIds([]);
        setPendingNewTags([]);
        setDeselectedPendingTags(new Set());
        setSourceYear('');
        setSourcePaper('');
        setSourceExamType('');
        setSourceQuestionNo('');
        setIsOptionalShell(false);
        setStatus('needs_review');
        setProblemUuid(null); // Reset UUID so a new one is generated next time
        setIsExpanded(false);
      }

      router.refresh();
    } catch (error: any) {
      toast.error(
        error.message || `Failed to ${isEditMode ? 'update' : 'create'} problem`
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  // Generate UUID for new problems when form is expanded
  const [problemUuid, setProblemUuid] = useState<string | null>(null);

  // Generate UUID when form is expanded for new problems
  useEffect(() => {
    if (!isEditMode && isExpanded && !problemUuid) {
      setProblemUuid(globalThis.crypto?.randomUUID?.() ?? `rnd-${Date.now()}`);
    }
  }, [isEditMode, isExpanded, problemUuid]);

  // Upload pending image attachment once problemUuid is available
  useEffect(() => {
    if (!problemUuid || !pendingImageAttachment) return;

    const { file, roles } = pendingImageAttachment;
    setPendingImageAttachment(null);

    (async () => {
      for (const role of roles) {
        try {
          const paths = await uploadFiles([file], role, problemUuid);
          const newAsset = {
            path: paths[0],
            name: file.name.replace(/\s+/g, '_'),
          };
          if (role === 'problem') {
            setProblemAssets(prev => [...prev, newAsset]);
          } else {
            setSolutionAssets(prev => [...prev, newAsset]);
          }
        } catch (err: any) {
          toast.error(
            tProblems('failedToSaveImageAsset', {
              role,
              error: err.message || '',
            })
          );
        }
      }
    })();
  }, [problemUuid, pendingImageAttachment, tProblems]);

  // Cleanup function for unsaved problem assets (can be called explicitly or via effect)
  const cleanupUnsavedProblem = useCallback(
    async (uuidToCleanup: string | null) => {
      // Only cleanup in create mode and if we have a problemUuid
      if (isEditMode || !uuidToCleanup) return;

      try {
        // Use sendBeacon for more reliable cleanup on page unload
        if (navigator.sendBeacon) {
          const formData = new FormData();
          formData.append('problemId', uuidToCleanup);
          navigator.sendBeacon(
            `/api/problems/${uuidToCleanup}/cleanup`,
            formData
          );
        } else {
          // Fallback to fetch with keepalive
          await fetch(apiUrl(`/api/problems/${uuidToCleanup}/cleanup`), {
            method: 'DELETE',
            keepalive: true,
          });
        }
      } catch (error) {
        console.warn('Failed to cleanup unsaved problem assets:', error);
      }
    },
    [isEditMode]
  );

  // Track whether the form has unsaved data
  const hasUnsavedData = useMemo(() => {
    if (!isExpanded && !isEditMode && !alwaysExpanded) return false;
    return (
      title.trim().length > 0 ||
      content.length > 0 ||
      problemAssets.length > 0 ||
      solutionText.length > 0 ||
      solutionAssets.length > 0 ||
      selectedTagIds.length > 0 ||
      pendingNewTags.some(n => !deselectedPendingTags.has(n))
    );
  }, [
    isExpanded,
    isEditMode,
    alwaysExpanded,
    title,
    content,
    problemAssets,
    solutionText,
    solutionAssets,
    selectedTagIds,
    pendingNewTags,
    deselectedPendingTags,
  ]);

  // Warn user before leaving page with unsaved form data
  useUnsavedChanges(hasUnsavedData);

  // Clean up unsaved problem assets when component unmounts or user leaves page
  useEffect(() => {
    const handleBeforeUnload = () => {
      cleanupUnsavedProblem(problemUuid);
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      cleanupUnsavedProblem(problemUuid);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [problemUuid, cleanupUnsavedProblem]);

  // If not expanded (create mode only), show the two entry buttons + optional scanner
  if (!isExpanded && !isEditMode && !alwaysExpanded) {
    return (
      <div className="space-y-3">
        {!showImageScan && (
          <div className="grid grid-cols-2 gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsExpanded(true)}
              className="border-dashed text-muted-foreground hover:border-amber-400/50 dark:hover:border-amber-500/50 hover:bg-amber-50/50 dark:hover:bg-amber-950/20 hover:text-amber-900 dark:hover:text-amber-100 justify-center transition-colors py-6"
            >
              <PenLine className="h-4 w-4 mr-2" />
              {t('writeManually')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowImageScan(true)}
              className="border-dashed text-muted-foreground hover:border-blue-400/50 dark:hover:border-blue-500/50 hover:bg-blue-50/50 dark:hover:bg-blue-950/20 hover:text-blue-900 dark:hover:text-blue-100 justify-center transition-colors py-6"
            >
              <div className="flex items-center">
                <ScanLine className="h-4 w-4 mr-2" />
                {t('scanFromImage')}
              </div>
            </Button>
          </div>
        )}
        {showImageScan && (
          <ImageScanUploader
            subjectId={subjectId}
            onExtracted={handleExtractionComplete}
            onCancel={() => setShowImageScan(false)}
            quota={extractionQuota}
            onQuotaChange={setExtractionQuota}
          />
        )}
      </div>
    );
  }

  // When alwaysExpanded + initialShowImageScan, show scanner instead of form
  if (alwaysExpanded && !isEditMode && showImageScan) {
    return (
      <div className="space-y-3">
        <ImageScanUploader
          subjectId={subjectId}
          onExtracted={handleExtractionComplete}
          onCancel={() => onCancel?.()}
          quota={extractionQuota}
          onQuotaChange={setExtractionQuota}
        />
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="form-container">
      {(isEditMode || (alwaysExpanded && !isEditMode)) && (
        <div className="flex items-center justify-between">
          <h3 className="heading-xs">
            {isEditMode ? t('editProblem') : t('addNewProblem')}
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onCancel?.()}
            className="text-muted-foreground hover:text-foreground"
          >
            {tCommon('cancel')}
          </Button>
        </div>
      )}

      {/* title */}
      <div className="form-row">
        <label className="form-label">{tProblems('problemTitle')}</label>
        <div className="flex-1 relative">
          <Input
            type="text"
            className="form-input w-full"
            placeholder={tProblems('titlePlaceholder')}
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={VALIDATION_CONSTANTS.STRING_LIMITS.TITLE_MAX}
            required
            onFocus={() => setTitleFocus(true)}
            onBlur={() => setTitleFocus(false)}
          />
          {titleFocus && (
            // title length inside input, bottom-right
            <span
              className="absolute bottom-1.5 right-3 text-xs text-muted-foreground pointer-events-none bg-background px-1"
              style={{ lineHeight: 1 }}
            >
              {title.length}/{VALIDATION_CONSTANTS.STRING_LIMITS.TITLE_MAX}
            </span>
          )}
        </div>
      </div>

      {/* All sections in a single accordion */}
      <Accordion
        type="multiple"
        defaultValue={['content', 'settings', 'parts']}
      >
        {/* Content + Problem Assets */}
        <AccordionItem
          value="content"
          className="rounded-2xl border border-gray-200/40 dark:border-gray-700/30 bg-gradient-to-br from-gray-50 to-gray-100/50 dark:from-gray-800/40 dark:to-gray-700/20 px-4"
        >
          <AccordionTrigger className="hover:no-underline py-3">
            <span className="text-sm font-semibold text-gray-800 dark:text-gray-300">
              {tProblems('content')} <span className="text-red-500">*</span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="space-y-4">
            <div className="form-row-start">
              <label className="form-label pt-2">{t('contentLabel')}</label>
              <div className="flex-1 relative">
                <RichTextEditor
                  key={`content-${editorKey}`}
                  ref={contentEditorRef}
                  initialContent={content}
                  onChange={setContent}
                  placeholder={tProblems('contentPlaceholder')}
                  height="200px"
                  maxHeight="500px"
                  disabled={isSubmitting}
                  maxLength={VALIDATION_CONSTANTS.STRING_LIMITS.TEXT_BODY_MAX}
                  showCharacterCount={true}
                />
              </div>
            </div>
            <div className="form-row-start">
              <label className="form-label pt-2">{t('problemAssets')}</label>
              <div className="flex-1">
                <FileManager
                  role="problem"
                  problemId={
                    isEditMode ? problem.id : problemUuid || 'disabled'
                  }
                  isEditMode={isEditMode}
                  initialFiles={problemAssets}
                  onFilesChange={setProblemAssets}
                  onInsertImage={handleInsertProblemImage}
                  disabled={!isEditMode && !problemUuid}
                />
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* Problem Settings */}
        <AccordionItem
          value="settings"
          className="rounded-2xl border border-amber-200/40 dark:border-amber-800/30 bg-gradient-to-br from-amber-50 to-amber-100/50 dark:from-amber-950/40 dark:to-amber-900/20 px-4 mt-4"
        >
          <AccordionTrigger className="hover:no-underline py-3">
            <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">
              {tProblems('problemSettings')}{' '}
              <span className="text-red-500">*</span>
            </span>
          </AccordionTrigger>
          <AccordionContent>
            <div className="form-section">
              <div className="form-row">
                <label className="form-label">{tProblems('status')}</label>
                <Select
                  value={status}
                  onValueChange={value => setStatus(value as any)}
                >
                  <SelectTrigger className="w-36 rounded-xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="needs_review">
                      <StatusBadge status="needs_review" t={tProblems} />
                    </SelectItem>
                    <SelectItem value="wrong">
                      <StatusBadge status="wrong" t={tProblems} />
                    </SelectItem>
                    <SelectItem value="mastered">
                      <StatusBadge status="mastered" t={tProblems} />
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="form-row">
                <label className="form-label">
                  {tProblems('sourceSection')}
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    type="number"
                    className="form-input w-24"
                    placeholder={tProblems('sourceYear')}
                    value={sourceYear}
                    onChange={e => setSourceYear(e.target.value)}
                    disabled={isSubmitting}
                  />
                  <Input
                    className="form-input w-40"
                    placeholder={tProblems('sourcePaper')}
                    maxLength={60}
                    value={sourcePaper}
                    onChange={e => setSourcePaper(e.target.value)}
                    disabled={isSubmitting}
                  />
                  <Select
                    value={sourceExamType || 'none'}
                    onValueChange={value =>
                      setSourceExamType(value === 'none' ? '' : value)
                    }
                  >
                    <SelectTrigger className="w-28 rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">—</SelectItem>
                      <SelectItem value="real">
                        {tProblems('examTypeReal')}
                      </SelectItem>
                      <SelectItem value="mock">
                        {tProblems('examTypeMock')}
                      </SelectItem>
                      <SelectItem value="homework">
                        {tProblems('examTypeHomework')}
                      </SelectItem>
                      <SelectItem value="other">
                        {tProblems('examTypeOther')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    className="form-input w-24"
                    placeholder={tProblems('sourceQuestionNo')}
                    maxLength={16}
                    value={sourceQuestionNo}
                    onChange={e => setSourceQuestionNo(e.target.value)}
                    disabled={isSubmitting}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="flex items-center gap-2">
                  <Switch
                    id="optional-problem-switch"
                    checked={isOptionalShell}
                    onCheckedChange={setIsOptionalShell}
                    disabled={isSubmitting}
                  />
                  <Label
                    htmlFor="optional-problem-switch"
                    className="text-sm cursor-pointer"
                  >
                    {tProblems('optionalProblem')}
                  </Label>
                </div>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* Shell parts: one homogeneous card per sub-question. A plain
            problem is a single card with the shell chrome hidden. */}
        <AccordionItem
          value="parts"
          className="rounded-2xl border border-blue-200/40 dark:border-blue-800/30 bg-gradient-to-br from-blue-50 to-blue-100/50 dark:from-blue-950/40 dark:to-blue-900/20 px-4 mt-4"
        >
          <AccordionTrigger className="hover:no-underline py-3">
            <span className="text-sm font-semibold text-blue-800 dark:text-blue-300">
              {tProblems('partsSection')}{' '}
              <span className="text-red-500">*</span>
              {parts.length > 1 && (
                <span className="ml-2 text-xs text-blue-600 dark:text-blue-400">
                  {tProblems('partsCount', { count: parts.length })}
                  {totalMarks !== null
                    ? ` · ${tProblems('totalMarksLabel', { total: totalMarks })}`
                    : ''}
                </span>
              )}
            </span>
          </AccordionTrigger>
          <AccordionContent>
            <div className="space-y-3">
              {parts.map((draft, i) => (
                <PartEditorCard
                  key={i}
                  draft={draft}
                  position={i + 1}
                  showShellChrome={parts.length > 1}
                  disabled={isSubmitting}
                  onPatch={patch => patchPart(i, patch)}
                  onRemove={() => removePart(i)}
                />
              ))}
              <div className="flex items-center justify-between">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addPart}
                  disabled={
                    isSubmitting ||
                    parts.length >= PROBLEM_CONSTANTS.PARTS.MAX_COUNT
                  }
                >
                  <Plus className="h-3.5 w-3.5" />
                  {tProblems('addPart')}
                </Button>
                {parts.length > 1 && (
                  <span className="text-xs text-muted-foreground">
                    {tProblems('partsCount', { count: parts.length })}
                    {totalMarks !== null
                      ? ` · ${tProblems('totalMarksLabel', { total: totalMarks })}`
                      : ''}
                  </span>
                )}
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* Solution text/assets are retired from the form: answers live on
            each part card and attachments go into the problem assets area
            (existing solution data is preserved and still submitted). */}

        {/* Tags */}
        <AccordionItem
          value="tags"
          className="rounded-2xl border border-gray-200/40 dark:border-gray-700/30 bg-gradient-to-br from-gray-50 to-gray-100/50 dark:from-gray-800/40 dark:to-gray-700/20 px-4 mt-4"
        >
          <AccordionTrigger className="hover:no-underline py-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-800 dark:text-gray-300">
                {tCommon('tags')}
              </span>
              {(() => {
                const selectedPendingCount = pendingNewTags.filter(
                  n => !deselectedPendingTags.has(n)
                ).length;
                const total = selectedTagIds.length + selectedPendingCount;
                return (
                  total > 0 && (
                    <span className="text-xs text-amber-600 dark:text-amber-400">
                      {t('selectedCount', { count: total })}
                      {selectedPendingCount > 0 &&
                        ` ${t('newCount', { count: selectedPendingCount })}`}
                    </span>
                  )
                );
              })()}
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {tags.length ? (
                  tags.map(t => {
                    const selected = selectedTagIds.includes(t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => toggleTag(t.id)}
                        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm transition-colors ${
                          selected
                            ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 border border-amber-300/60 dark:border-amber-700/50'
                            : 'bg-gray-100/80 dark:bg-gray-800/40 text-gray-600 dark:text-gray-400 border border-gray-200/50 dark:border-gray-700/40 hover:bg-gray-200/80 dark:hover:bg-gray-700/40'
                        }`}
                      >
                        {t.name}
                      </button>
                    );
                  })
                ) : (
                  <p className="text-body-sm text-muted-foreground">
                    {t('noTagsYet')}
                  </p>
                )}
              </div>
              {pendingNewTags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {pendingNewTags.map(name => {
                    const selected = !deselectedPendingTags.has(name);
                    return (
                      <button
                        key={`pending-${name}`}
                        type="button"
                        aria-pressed={selected}
                        onClick={() =>
                          setDeselectedPendingTags(prev => {
                            const next = new Set(prev);
                            if (next.has(name)) next.delete(name);
                            else next.add(name);
                            return next;
                          })
                        }
                        className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm border border-dashed transition-colors ${
                          selected
                            ? 'bg-blue-50/80 text-blue-700 border-blue-300/60 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-700/40 hover:bg-blue-100/80 dark:hover:bg-blue-900/40'
                            : 'bg-gray-100/80 text-gray-500 border-gray-300/50 dark:bg-gray-800/40 dark:text-gray-500 dark:border-gray-700/40 hover:bg-gray-200/80 dark:hover:bg-gray-700/40'
                        }`}
                      >
                        {name}
                        <span className="text-[10px] font-medium opacity-70 ml-0.5">
                          {t('newTag')}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="flex items-center gap-2 border-t border-gray-200/40 dark:border-gray-700/30 pt-3">
                <Input
                  placeholder={t('newTagPlaceholder')}
                  value={newTagName}
                  onChange={e => setNewTagName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleCreateTag();
                    }
                  }}
                  disabled={creatingTag}
                  className="h-8 flex-1 text-sm"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleCreateTag}
                  disabled={creatingTag || !newTagName.trim()}
                >
                  {creatingTag ? <Spinner /> : <Plus className="h-3.5 w-3.5" />}
                  {t('addTag')}
                </Button>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <div className="form-actions">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Spinner />}
          {isSubmitting
            ? isEditMode
              ? t('updating')
              : t('adding')
            : isEditMode
              ? t('editProblem')
              : t('addProblem')}
        </Button>
        {!isEditMode && (
          <Button
            type="button"
            variant="outline"
            onClick={async () => {
              // Clean up unsaved assets before resetting UUID
              if (problemUuid) {
                await cleanupUnsavedProblem(problemUuid);
              }
              setProblemUuid(null); // Reset UUID so a new one is generated next time
              if (alwaysExpanded && onCancel) {
                onCancel();
              } else {
                setIsExpanded(false);
              }
            }}
            disabled={isSubmitting}
          >
            {tCommon('cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}
