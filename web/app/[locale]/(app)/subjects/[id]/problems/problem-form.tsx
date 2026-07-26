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
  ShortAnswerTextConfig,
  ShortAnswerNumericConfig,
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
  const solutionEditorRef = useRef<RichTextEditorHandle>(null);

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

  const handleInsertSolutionImage = useCallback(
    (path: string, name: string) => {
      if (!solutionEditorRef.current?.editor) {
        toast.error(t('editorNotReady'));
        return;
      }

      const imageUrl = `/api/files/${encodeURIComponent(path)}`;
      solutionEditorRef.current.editor
        .chain()
        .focus()
        .setResizableImage({
          src: imageUrl,
          alt: name,
        })
        .run();

      toast.success(t('solutionImageInserted'));
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
      // Normalize the extracted type: the AI route emits shell part types,
      // but stay tolerant of the legacy trio.
      const rawType = data.problem_type as string;
      const legacyTypeMap: Record<string, ProblemType> = {
        mcq: 'single_choice',
        short: 'short_answer',
        extended: 'essay',
      };
      const extractedType: ProblemType = (
        PROBLEM_TYPE_VALUES as readonly string[]
      ).includes(rawType)
        ? (rawType as ProblemType)
        : (legacyTypeMap[rawType] ?? 'short_answer');
      const extractedIsChoice =
        extractedType === 'single_choice' || extractedType === 'multi_choice';
      const extractedIsShortLike =
        extractedType === 'fill_blank' || extractedType === 'short_answer';
      setProblemType(extractedType);
      const html = convertMathTextToTipTapHtml(data.content);
      // Update editor imperatively — onChange callback will sync form state
      contentEditorRef.current?.setContent(html);
      // Also update form state directly in case editor isn't mounted yet
      setContent(html);
      if (
        extractedIsChoice &&
        data.mcq_choices &&
        data.mcq_choices.length > 0
      ) {
        setUseEnhancedMcq(true);
        setMcqChoices(data.mcq_choices);
        setMcqCorrectChoiceId('');
        setMultiCorrectText('');
      }

      // Apply answer hint suggestions
      if (data.answer_hint) {
        const hint = data.answer_hint;

        if (extractedIsChoice && hint.mcq_correct_choice_id) {
          if (extractedType === 'multi_choice') {
            setMultiCorrectText(hint.mcq_correct_choice_id);
          } else {
            setMcqCorrectChoiceId(hint.mcq_correct_choice_id);
          }
        }

        if (extractedIsShortLike && hint.short_answer_value) {
          setUseEnhancedShort(true);
          if (hint.short_answer_is_numeric) {
            const numVal = Number(hint.short_answer_value);
            if (!isNaN(numVal)) {
              setShortAnswerConfig({
                mode: 'numeric',
                numeric_config: {
                  correct_value: numVal,
                  tolerance: 0,
                  unit: '',
                },
              });
            } else {
              setShortAnswerConfig({
                mode: 'text',
                acceptable_answers: [hint.short_answer_value],
              });
            }
          } else {
            setShortAnswerConfig({
              mode: 'text',
              acceptable_answers: [hint.short_answer_value],
            });
          }
        }

        if (extractedType === 'essay' && hint.extended_working) {
          const solutionHtml = convertMathTextToTipTapHtml(
            hint.extended_working
          );
          solutionEditorRef.current?.setContent(solutionHtml);
          setSolutionText(solutionHtml);
        }
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
  // Shell model: the form's rich editors drive the PRIMARY part (parts[0]);
  // additional parts are lightweight rows (type/label/marks/answer text).
  const primaryPart = problem?.parts?.[0];
  const [problemType, setProblemType] = useState<ProblemType>(
    primaryPart?.type || 'short_answer'
  );
  const [partLabel, setPartLabel] = useState(primaryPart?.label || '');
  const [partFullMarks, setPartFullMarks] = useState(
    primaryPart?.full_marks !== undefined ? String(primaryPart.full_marks) : ''
  );
  interface ExtraPartDraft {
    type: ProblemType;
    label: string;
    full_marks: string;
    correct_answer: string;
  }
  const [extraParts, setExtraParts] = useState<ExtraPartDraft[]>(
    (problem?.parts || []).slice(1).map(part => ({
      type: part.type,
      label: part.label || '',
      full_marks: part.full_marks !== undefined ? String(part.full_marks) : '',
      correct_answer: part.correct_answer || '',
    }))
  );
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

  // Editor-kind buckets: the choice builder serves both choice types, the
  // short-answer config serves fill-blank and short-answer parts.
  const isChoiceType =
    problemType === 'single_choice' || problemType === 'multi_choice';
  const isShortLike =
    problemType === 'fill_blank' || problemType === 'short_answer';

  // Correct answer inputs (legacy)
  const [mcqChoice, setMcqChoice] = useState(primaryPart?.correct_answer || '');
  const [shortText, setShortText] = useState(primaryPart?.correct_answer || '');

  // Enhanced answer config state
  const [mcqChoices, setMcqChoices] = useState<MCQChoice[]>(() => {
    const config = primaryPart?.answer_config;
    if (config && (config.type === 'mcq' || config.type === 'multi_mcq')) {
      return config.choices;
    }
    return ANSWER_CONFIG_CONSTANTS.MCQ.DEFAULT_CHOICES.map(id => ({
      id,
      text: '',
    }));
  });
  const [mcqCorrectChoiceId, setMcqCorrectChoiceId] = useState(() => {
    const config = primaryPart?.answer_config;
    if (config && config.type === 'mcq') {
      return config.correct_choice_id;
    }
    return '';
  });
  // Multi-choice correct set, edited as compact letters (e.g. "ABD").
  const [multiCorrectText, setMultiCorrectText] = useState(() => {
    const config = primaryPart?.answer_config;
    if (config && config.type === 'multi_mcq') {
      return config.correct_choice_ids.join('');
    }
    return '';
  });
  const [mcqRandomizeChoices, setMcqRandomizeChoices] = useState(() => {
    const config = primaryPart?.answer_config;
    if (config && (config.type === 'mcq' || config.type === 'multi_mcq')) {
      return config.randomize_choices ?? true;
    }
    return true;
  });
  const [shortAnswerConfig, setShortAnswerConfig] =
    useState<ShortAnswerConfigValue>(() => {
      const config = primaryPart?.answer_config;
      if (config && config.type === 'short') {
        if ((config as ShortAnswerTextConfig).mode === 'text') {
          return {
            mode: 'text' as const,
            acceptable_answers: (config as ShortAnswerTextConfig)
              .acceptable_answers,
          };
        }
        if ((config as ShortAnswerNumericConfig).mode === 'numeric') {
          const nc = (config as ShortAnswerNumericConfig).numeric_config;
          return {
            mode: 'numeric' as const,
            numeric_config: {
              correct_value: nc.correct_value,
              tolerance: nc.tolerance,
              unit: nc.unit,
            },
          };
        }
      }
      return { mode: 'text' as const, acceptable_answers: [] };
    });
  // Track whether user is using enhanced mode
  const [useEnhancedMcq, setUseEnhancedMcq] = useState(() => {
    // For existing problems with a choice config, use it
    const config = primaryPart?.answer_config;
    if (config?.type === 'mcq' || config?.type === 'multi_mcq') return true;
    // For new problems, default to true
    if (!isEditMode) return true;
    return false;
  });
  const [useEnhancedShort, setUseEnhancedShort] = useState(
    !!(primaryPart?.answer_config?.type === 'short')
  );

  // Auto-enable enhanced mode when problem type changes (only for new problems)
  useEffect(() => {
    if (!isEditMode) {
      if (isChoiceType) {
        setUseEnhancedMcq(true);
      }
    }
  }, [isChoiceType, isEditMode]);

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

  const correctAnswer = useMemo(() => {
    if (problemType === 'single_choice') {
      if (useEnhancedMcq && mcqCorrectChoiceId) {
        return mcqCorrectChoiceId;
      }
      return mcqChoice;
    }
    if (problemType === 'multi_choice') {
      if (useEnhancedMcq && multiCorrectText.trim()) {
        return multiCorrectText.trim().toUpperCase();
      }
      return mcqChoice;
    }
    if (isShortLike) {
      if (useEnhancedShort && shortAnswerConfig.mode === 'text') {
        return shortAnswerConfig.acceptable_answers[0] || '';
      }
      if (
        useEnhancedShort &&
        shortAnswerConfig.mode === 'numeric' &&
        shortAnswerConfig.numeric_config.correct_value !== ''
      ) {
        return String(shortAnswerConfig.numeric_config.correct_value);
      }
      return shortText;
    }
    return undefined; // essay
  }, [
    problemType,
    isShortLike,
    mcqChoice,
    shortText,
    useEnhancedMcq,
    useEnhancedShort,
    mcqCorrectChoiceId,
    multiCorrectText,
    shortAnswerConfig,
  ]);

  // Multi-choice correct ids parsed from the compact letters input, kept to
  // the ids that actually exist among the choices.
  const multiCorrectChoiceIds = useMemo(() => {
    const available = new Set(mcqChoices.map(choice => choice.id));
    return [
      ...new Set(
        multiCorrectText
          .toUpperCase()
          .split('')
          .map(letter => letter.trim())
          .filter(letter => available.has(letter))
      ),
    ];
  }, [multiCorrectText, mcqChoices]);

  // Build answer_config for submission
  const answerConfig = useMemo((): AnswerConfig | null => {
    if (problemType === 'single_choice' && useEnhancedMcq) {
      if (!mcqCorrectChoiceId) return null;
      return {
        type: 'mcq',
        choices: mcqChoices,
        correct_choice_id: mcqCorrectChoiceId,
        randomize_choices: mcqRandomizeChoices,
      };
    }
    if (problemType === 'multi_choice' && useEnhancedMcq) {
      if (multiCorrectChoiceIds.length === 0) return null;
      return {
        type: 'multi_mcq',
        choices: mcqChoices,
        correct_choice_ids: multiCorrectChoiceIds,
        randomize_choices: mcqRandomizeChoices,
      };
    }
    if (isShortLike && useEnhancedShort) {
      if (shortAnswerConfig.mode === 'text') {
        if (shortAnswerConfig.acceptable_answers.length === 0) return null;
        return {
          type: 'short',
          mode: 'text',
          acceptable_answers: shortAnswerConfig.acceptable_answers,
        };
      }
      if (shortAnswerConfig.mode === 'numeric') {
        const nc = shortAnswerConfig.numeric_config;
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
    }
    return null;
  }, [
    problemType,
    isShortLike,
    useEnhancedMcq,
    useEnhancedShort,
    mcqChoices,
    mcqCorrectChoiceId,
    multiCorrectChoiceIds,
    mcqRandomizeChoices,
    shortAnswerConfig,
  ]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();

    if (!title.trim()) {
      toast.error(t('titleRequired'));
      return;
    }

    // Validate enhanced answer config
    if (
      problemType === 'single_choice' &&
      useEnhancedMcq &&
      !mcqCorrectChoiceId
    ) {
      toast.error(t('correctChoiceRequired'));
      return;
    }
    if (
      problemType === 'multi_choice' &&
      useEnhancedMcq &&
      multiCorrectChoiceIds.length === 0
    ) {
      toast.error(t('correctChoiceRequired'));
      return;
    }
    if (isShortLike && useEnhancedShort) {
      if (
        shortAnswerConfig.mode === 'text' &&
        shortAnswerConfig.acceptable_answers.length === 0
      ) {
        toast.error(t('addAtLeastOneAnswer'));
        return;
      }
      if (shortAnswerConfig.mode === 'numeric') {
        const nc = shortAnswerConfig.numeric_config;
        if (nc.correct_value === '' || nc.tolerance === '') {
          toast.error(t('fillCorrectValueAndTolerance'));
          return;
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
      const sanitizedCorrectAnswer = correctAnswer
        ? correctAnswer.substring(
            0,
            VALIDATION_CONSTANTS.STRING_LIMITS.TEXT_BODY_MAX
          )
        : '';

      // Assemble the shell: primary part from the rich editors, additional
      // parts from the lightweight rows. Indexes are contiguous from 1.
      const parts: Record<string, unknown>[] = [
        {
          index: 1,
          type: problemType,
          ...(partLabel.trim() ? { label: partLabel.trim() } : {}),
          ...(partFullMarks.trim() !== '' &&
          !isNaN(Number(partFullMarks.trim()))
            ? { full_marks: Number(partFullMarks.trim()) }
            : {}),
          ...(problemType !== 'essay' && sanitizedCorrectAnswer
            ? { correct_answer: sanitizedCorrectAnswer }
            : {}),
          ...(answerConfig ? { answer_config: answerConfig } : {}),
        },
      ];
      for (const draft of extraParts) {
        parts.push({
          index: parts.length + 1,
          type: draft.type,
          ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
          ...(draft.full_marks.trim() !== '' &&
          !isNaN(Number(draft.full_marks.trim()))
            ? { full_marks: Number(draft.full_marks.trim()) }
            : {}),
          ...(draft.correct_answer.trim() && draft.type !== 'essay'
            ? { correct_answer: draft.correct_answer.trim() }
            : {}),
        });
      }

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
        parts,
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
        setShortText('');
        setMcqChoice('');
        setMcqChoices(
          ANSWER_CONFIG_CONSTANTS.MCQ.DEFAULT_CHOICES.map(id => ({
            id,
            text: '',
          }))
        );
        setMcqCorrectChoiceId('');
        setMultiCorrectText('');
        setMcqRandomizeChoices(true);
        setShortAnswerConfig({
          mode: 'text',
          acceptable_answers: [],
        });
        setUseEnhancedMcq(false);
        setUseEnhancedShort(false);
        setSelectedTagIds([]);
        setPendingNewTags([]);
        setDeselectedPendingTags(new Set());
        setProblemType('short_answer');
        setPartLabel('');
        setPartFullMarks('');
        setExtraParts([]);
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
        defaultValue={['content', 'settings', 'answer']}
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
                <label className="form-label">{tProblems('type')}</label>
                <Select
                  value={problemType}
                  onValueChange={value => setProblemType(value as ProblemType)}
                >
                  <SelectTrigger className="w-48 rounded-xl">
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
              </div>

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
                  {tProblems('fullMarksField')}
                </label>
                <Input
                  type="number"
                  className="form-input w-24"
                  min={0}
                  max={150}
                  value={partFullMarks}
                  onChange={e => setPartFullMarks(e.target.value)}
                  disabled={isSubmitting}
                />
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

        {/* Answer Configuration - choice parts */}
        {isChoiceType && (
          <AccordionItem
            value="answer"
            className="rounded-2xl border border-blue-200/40 dark:border-blue-800/30 bg-gradient-to-br from-blue-50 to-blue-100/50 dark:from-blue-950/40 dark:to-blue-900/20 px-4 mt-4"
          >
            <AccordionTrigger className="hover:no-underline py-3">
              <span className="text-sm font-semibold text-blue-800 dark:text-blue-300">
                {tProblems('answerConfig')}
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <div className="form-section">
                <div className="form-row">
                  <span className="form-label">{tProblems('answerMode')}</span>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="enhanced-mcq-switch"
                      checked={useEnhancedMcq}
                      onCheckedChange={setUseEnhancedMcq}
                    />
                    <Label
                      htmlFor="enhanced-mcq-switch"
                      className="text-sm cursor-pointer"
                    >
                      {t('useChoicePicker')}
                    </Label>
                  </div>
                </div>

                {useEnhancedMcq && (
                  <div className="form-row">
                    <span className="form-label" />
                    <div className="flex items-center gap-2">
                      <Switch
                        id="randomize-choices-switch"
                        checked={mcqRandomizeChoices}
                        onCheckedChange={setMcqRandomizeChoices}
                        disabled={isSubmitting}
                      />
                      <Label
                        htmlFor="randomize-choices-switch"
                        className="text-sm cursor-pointer"
                      >
                        {t('randomizeChoices')}
                      </Label>
                    </div>
                  </div>
                )}

                {useEnhancedMcq && problemType === 'multi_choice' && (
                  <div className="form-row">
                    <label className="form-label">
                      {tProblems('multiCorrectLabel')}
                    </label>
                    <Input
                      className="form-input w-40"
                      placeholder={tProblems('multiCorrectPlaceholder')}
                      value={multiCorrectText}
                      maxLength={10}
                      onChange={e => setMultiCorrectText(e.target.value)}
                      disabled={isSubmitting}
                    />
                  </div>
                )}

                {useEnhancedMcq ? (
                  <MCQChoiceEditor
                    choices={mcqChoices}
                    correctChoiceId={
                      problemType === 'multi_choice' ? '' : mcqCorrectChoiceId
                    }
                    onChoicesChange={setMcqChoices}
                    onCorrectChoiceChange={
                      problemType === 'multi_choice'
                        ? () => undefined
                        : setMcqCorrectChoiceId
                    }
                    disabled={isSubmitting}
                  />
                ) : (
                  <div className="form-row">
                    <label className="form-label">{t('correctChoice')}</label>
                    <Input
                      className="form-input w-32"
                      placeholder={t('correctChoicePlaceholder')}
                      value={mcqChoice}
                      maxLength={
                        VALIDATION_CONSTANTS.STRING_LIMITS.TEXT_BODY_MAX
                      }
                      onChange={e => setMcqChoice(e.target.value)}
                    />
                  </div>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {/* Answer Configuration - fill-blank / short-answer parts */}
        {isShortLike && (
          <AccordionItem
            value="answer"
            className="rounded-2xl border border-rose-200/40 dark:border-rose-800/30 bg-gradient-to-br from-rose-50 to-rose-100/50 dark:from-rose-950/40 dark:to-rose-900/20 px-4 mt-4"
          >
            <AccordionTrigger className="hover:no-underline py-3">
              <span className="text-sm font-semibold text-rose-800 dark:text-rose-300">
                {tProblems('answerConfig')}
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <div className="form-section">
                <div className="form-row">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="enhanced-short-switch"
                      checked={useEnhancedShort}
                      onCheckedChange={setUseEnhancedShort}
                    />
                    <Label
                      htmlFor="enhanced-short-switch"
                      className="text-sm cursor-pointer"
                    >
                      {t('advancedMode')}
                    </Label>
                  </div>
                </div>

                {useEnhancedShort ? (
                  <ShortAnswerConfig
                    value={shortAnswerConfig}
                    onChange={setShortAnswerConfig}
                    disabled={isSubmitting}
                  />
                ) : (
                  <div className="form-row">
                    <label className="form-label">{t('correctText')}</label>
                    <Input
                      className="form-input"
                      placeholder={t('correctTextPlaceholder')}
                      value={shortText}
                      maxLength={
                        VALIDATION_CONSTANTS.STRING_LIMITS.TEXT_BODY_MAX
                      }
                      onChange={e => setShortText(e.target.value)}
                    />
                  </div>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}
        {/* Additional parts: lightweight rows turning this problem into a
            shell of nested sub-questions (壳{题目+题目...}). */}
        <AccordionItem
          value="parts"
          className="rounded-2xl border border-purple-200/40 dark:border-purple-800/30 bg-gradient-to-br from-purple-50 to-purple-100/50 dark:from-purple-950/40 dark:to-purple-900/20 px-4 mt-4"
        >
          <AccordionTrigger className="hover:no-underline py-3">
            <span className="text-sm font-semibold text-purple-800 dark:text-purple-300">
              {tProblems('moreParts')}
              {extraParts.length > 0 && (
                <span className="ml-2 text-xs text-purple-600 dark:text-purple-400">
                  {tProblems('partsCount', { count: extraParts.length + 1 })}
                </span>
              )}
            </span>
          </AccordionTrigger>
          <AccordionContent>
            <div className="space-y-3">
              {extraParts.length > 0 && (
                <div className="form-row">
                  <label className="form-label">
                    {tProblems('partLabelField')} (1)
                  </label>
                  <Input
                    className="form-input w-24"
                    placeholder="(1)"
                    maxLength={16}
                    value={partLabel}
                    onChange={e => setPartLabel(e.target.value)}
                    disabled={isSubmitting}
                  />
                </div>
              )}
              {extraParts.map((draft, i) => (
                <div
                  key={i}
                  className="flex flex-wrap items-center gap-2 rounded-xl border border-purple-200/50 dark:border-purple-800/40 p-3"
                >
                  <span className="text-xs font-semibold text-purple-700 dark:text-purple-300 w-8">
                    ({i + 2})
                  </span>
                  <Select
                    value={draft.type}
                    onValueChange={value =>
                      setExtraParts(prev =>
                        prev.map((p, j) =>
                          j === i ? { ...p, type: value as ProblemType } : p
                        )
                      )
                    }
                  >
                    <SelectTrigger className="w-32 rounded-xl">
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
                    className="form-input w-20"
                    placeholder={tProblems('partLabelField')}
                    maxLength={16}
                    value={draft.label}
                    onChange={e =>
                      setExtraParts(prev =>
                        prev.map((p, j) =>
                          j === i ? { ...p, label: e.target.value } : p
                        )
                      )
                    }
                    disabled={isSubmitting}
                  />
                  <Input
                    type="number"
                    className="form-input w-20"
                    placeholder={tProblems('fullMarksField')}
                    min={0}
                    max={150}
                    value={draft.full_marks}
                    onChange={e =>
                      setExtraParts(prev =>
                        prev.map((p, j) =>
                          j === i ? { ...p, full_marks: e.target.value } : p
                        )
                      )
                    }
                    disabled={isSubmitting}
                  />
                  {draft.type !== 'essay' && (
                    <Input
                      className="form-input flex-1 min-w-32"
                      placeholder={tProblems('partAnswerField')}
                      value={draft.correct_answer}
                      onChange={e =>
                        setExtraParts(prev =>
                          prev.map((p, j) =>
                            j === i
                              ? { ...p, correct_answer: e.target.value }
                              : p
                          )
                        )
                      }
                      disabled={isSubmitting}
                    />
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setExtraParts(prev => prev.filter((_, j) => j !== i))
                    }
                    disabled={isSubmitting}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setExtraParts(prev =>
                    prev.length + 1 < PROBLEM_CONSTANTS.PARTS.MAX_COUNT
                      ? [
                          ...prev,
                          {
                            type: 'short_answer',
                            label: `(${prev.length + 2})`,
                            full_marks: '',
                            correct_answer: '',
                          },
                        ]
                      : prev
                  )
                }
                disabled={
                  isSubmitting ||
                  extraParts.length + 1 >= PROBLEM_CONSTANTS.PARTS.MAX_COUNT
                }
              >
                <Plus className="h-3.5 w-3.5" />
                {tProblems('addPart')}
              </Button>
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* Solution */}
        <AccordionItem
          value="solution"
          className="rounded-2xl border border-green-200/40 dark:border-green-800/30 bg-gradient-to-br from-green-50 to-green-100/50 dark:from-green-950/40 dark:to-green-900/20 px-4 mt-4"
        >
          <AccordionTrigger className="hover:no-underline py-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-green-800 dark:text-green-300">
                {tProblems('solution')}
              </span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="space-y-4">
            <div className="form-row-start">
              <label className="form-label pt-2">
                {tProblems('solutionText')}
              </label>
              <div className="flex-1 relative">
                <RichTextEditor
                  key={`solution-${editorKey}`}
                  ref={solutionEditorRef}
                  initialContent={solutionText}
                  onChange={setSolutionText}
                  placeholder={tProblems('solutionPlaceholder')}
                  height="200px"
                  maxHeight="500px"
                  disabled={isSubmitting}
                  maxLength={VALIDATION_CONSTANTS.STRING_LIMITS.TEXT_BODY_MAX}
                  showCharacterCount={true}
                />
              </div>
            </div>
            <div className="form-row-start">
              <label className="form-label pt-2">{t('solutionAssets')}</label>
              <div className="flex-1">
                <FileManager
                  role="solution"
                  problemId={
                    isEditMode ? problem.id : problemUuid || 'disabled'
                  }
                  isEditMode={isEditMode}
                  initialFiles={solutionAssets}
                  onFilesChange={setSolutionAssets}
                  onInsertImage={handleInsertSolutionImage}
                  disabled={!isEditMode && !problemUuid}
                />
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>

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
