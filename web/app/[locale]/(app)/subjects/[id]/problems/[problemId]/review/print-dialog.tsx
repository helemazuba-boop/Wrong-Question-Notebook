'use client';

import { useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Separator } from '@/components/ui/separator';
import { waitForSheetReady } from '@/lib/print-sheet-ready';
import type { PrintAnswerPlacement } from '@/lib/print-sheet-model';
import type { Problem, Subject } from '@/lib/types';

/** Above this many problems, say so before the user commits to printing. */
const LARGE_SHEET_THRESHOLD = 20;

type PrintScope = 'current' | 'all';

interface PrintDialogProps {
  problem: Problem;
  subject: Subject;
  /**
   * Full problem rows the viewer may print alongside the current one. Absent
   * on the routes whose list only carries navigation data — there the dialog
   * offers the current problem alone rather than a half-working picker.
   */
  printableProblems?: Problem[];
  /** Last-chosen answer placement, so a bare Ctrl+P matches it. */
  placement: PrintAnswerPlacement;
  onPlacementChange: (placement: PrintAnswerPlacement) => void;
  /**
   * Commits the sheet. Called inside `flushSync` so the printed document is
   * the selected one by the time anything captures it.
   */
  onPrint: (problems: Problem[], placement: PrintAnswerPlacement) => void;
}

export default function PrintDialog({
  problem,
  subject,
  printableProblems,
  placement,
  onPlacementChange,
  onPrint,
}: PrintDialogProps) {
  const t = useTranslations('PrintDialog');
  const tCommon = useTranslations('Common');
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<PrintScope>('current');
  // Everything starts selected: printing a whole set is the common case, and
  // unticking a few problems is cheaper than ticking twenty.
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    (printableProblems ?? []).map(item => item.id)
  );

  const choices = printableProblems ?? [];
  const canChooseScope = choices.length > 1;
  const selectedCount = choices.filter(item =>
    selectedIds.includes(item.id)
  ).length;
  const allSelected = canChooseScope && selectedCount === choices.length;
  const someSelected = selectedCount > 0 && !allSelected;
  const selected =
    scope === 'current'
      ? [problem]
      : choices.filter(item => selectedIds.includes(item.id));

  const placements: Array<[PrintAnswerPlacement, string]> = [
    ['end', t('modeEnd')],
    ['below', t('modeBelow')],
    ['none', t('modeNone')],
  ];

  const handlePrint = async () => {
    if (selected.length === 0) {
      toast.error(t('emptySelection'));
      return;
    }

    // Commit the sheet before anything can capture it. `flushSync` because the
    // print call below is synchronous and would otherwise snapshot the
    // previously committed problems.
    flushSync(() => onPrint(selected, placement));

    // The sheet renders its math in an effect, so the document is not ready in
    // the same tick it was committed. Bounded: printing must never hang.
    await waitForSheetReady();

    setOpen(false);
    triggerPrint(selected);
  };

  const triggerPrint = (problems: Problem[]) => {
    const jobTitle = `${t('worksheetTitle')} · ${subject.name}（${problems.length}）`;
    // The bridge reports back whether it took over. When it could not start
    // printing it returns false and raises the failure through its own
    // onClientError channel, and we fall through to the browser's print.
    if (window.WQNAndroid?.print?.(jobTitle)) return;
    window.print();
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        title={t('title')}
      >
        <Printer className="h-4 w-4" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
          </DialogHeader>

          {canChooseScope && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">
                {t('scopeLabel')}
              </p>
              <RadioGroup
                value={scope}
                onValueChange={value => setScope(value as PrintScope)}
              >
                <div className="flex items-center gap-3">
                  <RadioGroupItem value="current" id="print-scope-current" />
                  <Label htmlFor="print-scope-current">
                    {t('scopeCurrent')}
                  </Label>
                </div>
                <div className="flex items-center gap-3">
                  <RadioGroupItem value="all" id="print-scope-all" />
                  <Label htmlFor="print-scope-all">
                    {t('scopeAll', { count: choices.length })}
                  </Label>
                </div>
              </RadioGroup>
            </div>
          )}

          {canChooseScope && scope === 'all' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Checkbox
                    id="print-select-all"
                    checked={
                      allSelected
                        ? true
                        : someSelected
                          ? 'indeterminate'
                          : false
                    }
                    onCheckedChange={checked =>
                      setSelectedIds(
                        checked === true ? choices.map(i => i.id) : []
                      )
                    }
                  />
                  <Label htmlFor="print-select-all">{t('selectAll')}</Label>
                </div>
                <span className="text-xs text-muted-foreground">
                  {t('selectedCount', {
                    selected: selectedCount,
                    total: choices.length,
                  })}
                </span>
              </div>
              <div className="max-h-[38vh] space-y-2 overflow-y-auto rounded-lg border p-2">
                {choices.map((item, index) => (
                  <div key={item.id} className="flex items-start gap-3">
                    <Checkbox
                      id={`print-problem-${item.id}`}
                      checked={selectedIds.includes(item.id)}
                      onCheckedChange={checked =>
                        setSelectedIds(previous =>
                          checked === true
                            ? [...previous, item.id]
                            : previous.filter(id => id !== item.id)
                        )
                      }
                    />
                    <Label
                      htmlFor={`print-problem-${item.id}`}
                      className="text-sm font-normal"
                    >
                      <span className="text-muted-foreground">
                        {index + 1}.
                      </span>{' '}
                      {item.title}
                    </Label>
                  </div>
                ))}
              </div>
            </div>
          )}

          <Separator />

          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">
              {t('placementLabel')}
            </p>
            <RadioGroup
              value={placement}
              onValueChange={value =>
                onPlacementChange(value as PrintAnswerPlacement)
              }
            >
              {placements.map(([value, label]) => (
                <div key={value} className="flex items-center gap-3">
                  <RadioGroupItem value={value} id={`print-mode-${value}`} />
                  <Label htmlFor={`print-mode-${value}`}>{label}</Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          <DialogFooter className="sm:justify-between">
            <p className="text-xs text-muted-foreground">
              {selected.length >= LARGE_SHEET_THRESHOLD
                ? t('largeSheet', { count: selected.length })
                : ''}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOpen(false)}
              >
                {tCommon('cancel')}
              </Button>
              <Button size="sm" onClick={handlePrint}>
                <Printer className="mr-1 h-4 w-4" />
                {t('printCount', { count: selected.length })}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
