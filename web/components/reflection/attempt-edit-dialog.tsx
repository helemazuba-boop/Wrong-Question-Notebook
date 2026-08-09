'use client';

import { useTranslations } from 'next-intl';
import { useState, useEffect } from 'react';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import CauseSelector from './cause-selector';
import { cn } from '@/lib/utils';
import { ATTEMPT_CONSTANTS } from '@/lib/constants';
import { Attempt } from '@/lib/types';
import { toast } from 'sonner';

interface AttemptEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  attempt: Attempt;
  onSaved: () => void;
}

export default function AttemptEditDialog({
  open,
  onOpenChange,
  attempt,
  onSaved,
}: AttemptEditDialogProps) {
  const t = useTranslations('Review');
  const tCommon = useTranslations('Common');
  const [cause, setCause] = useState<string | undefined>(undefined);
  const [notes, setNotes] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const NOTES_MAX = ATTEMPT_CONSTANTS.MAX_REFLECTION_NOTES_LENGTH;

  // Cause/reflection remain editable Attempt evidence. Human Rating corrections
  // use /api/problem-reviews and never pass through this dialog.
  const effectiveIsCorrect = attempt.is_correct ?? false;

  // Populate form when dialog opens
  useEffect(() => {
    if (open) {
      setCause(attempt.cause || undefined);
      setNotes(attempt.reflection_notes || '');
    }
  }, [open, attempt]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const res = await fetch(`/api/attempts/${attempt.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cause: cause || null,
          reflection_notes: notes || null,
        }),
      });
      if (!res.ok) throw new Error('Failed to save');
      onSaved();
      onOpenChange(false);
    } catch {
      toast.error(t('failedToSave'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('editAttempt')}</DialogTitle>
          <DialogDescription>{t('editAttemptEvidenceDesc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Result badge (read-only) */}
          {attempt.is_correct !== null && (
            <div
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium',
                attempt.is_correct
                  ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                  : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
              )}
            >
              <span>{attempt.is_correct ? '\u2713' : '\u2717'}</span>
              {attempt.is_correct ? t('correct') : t('incorrect')}
            </div>
          )}

          {/* Recorded response (read-only) */}
          {attempt.submitted_answer != null &&
            attempt.submitted_answer !==
              ATTEMPT_CONSTANTS.SELF_ASSESSED_PLACEHOLDER && (
              <div className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('yourResponse')}
                </span>
                <p className="text-sm text-gray-700 dark:text-gray-300 bg-muted/50 rounded-lg px-3 py-2">
                  {typeof attempt.submitted_answer === 'string'
                    ? attempt.submitted_answer
                    : JSON.stringify(attempt.submitted_answer)}
                </p>
              </div>
            )}

          {/* Cause selector */}
          <CauseSelector
            value={cause}
            onChange={setCause}
            isCorrect={effectiveIsCorrect}
            t={t}
          />

          {/* Reflection notes */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('notes')}{' '}
                <span className="text-muted-foreground font-normal">
                  ({t('optional')})
                </span>
              </label>
              <span
                className={cn(
                  'text-xs',
                  notes.length >= NOTES_MAX
                    ? 'text-amber-500'
                    : 'text-muted-foreground'
                )}
              >
                {notes.length}/{NOTES_MAX}
              </span>
            </div>
            <Textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              maxLength={NOTES_MAX}
              placeholder={t('notesPlaceholder')}
              className="h-20 resize-none"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            {tCommon('cancel')}
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? t('savingChanges') : t('saveChanges')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
