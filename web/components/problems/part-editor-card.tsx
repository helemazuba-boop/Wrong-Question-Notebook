'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MCQChoiceEditor } from '@/components/ui/mcq-choice-editor';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ShortAnswerConfig } from '@/components/ui/short-answer-config';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { getProblemTypeDisplayName } from '@/lib/common-utils';
import { VALIDATION_CONSTANTS } from '@/lib/constants';
import { multiIdsOf, type PartDraft } from '@/lib/problem-form/model';
import { PROBLEM_TYPE_VALUES, type ProblemType } from '@/lib/schemas';

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
export function PartEditorCard({
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
