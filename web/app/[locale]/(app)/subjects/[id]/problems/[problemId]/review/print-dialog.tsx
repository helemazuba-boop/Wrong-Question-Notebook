'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Printer, X } from 'lucide-react';
import { Problem, Subject } from '@/lib/types';
import type { MCQAnswerConfig } from '@/lib/types';

type PrintMode = 'end' | 'below' | 'none';

interface PrintDialogProps {
  problem: Problem;
  subject: Subject;
  showSolution: boolean;
  setShowSolution: (v: boolean) => void;
}

export default function PrintDialog({
  problem,
  subject,
  showSolution,
  setShowSolution,
}: PrintDialogProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PrintMode>('end');

  const handlePrint = () => {
    import('katex').then(({ default: katex }) => {
      document
        .querySelectorAll('[data-type="inline-math"], [data-type="block-math"]')
        .forEach(el => {
          const latex = el.getAttribute('data-latex') || el.textContent || '';
          const displayMode = el.getAttribute('data-type') === 'block-math';
          if (!el.querySelector('.katex')) {
            el.innerHTML = katex.renderToString(latex, {
              displayMode,
              throwOnError: false,
            });
          }
        });
    });

    document.documentElement.dataset.printMode = mode;

    if (mode === 'end' && !showSolution) {
      setShowSolution(true);
    }

    const cleanup = () => {
      document.documentElement.dataset.printMode = '';
    };
    window.addEventListener('afterprint', cleanup, { once: true });

    window.print();
    setOpen(false);
  };

  const renderAnswerPreview = () => {
    if (!problem.answer_config) return null;
    const cfg = problem.answer_config;

    if (cfg.type === 'mcq') {
      const mcq = cfg as MCQAnswerConfig;
      return (
        <div className="space-y-1">
          {mcq.choices.map(c => (
            <div key={c.id} className="text-sm text-muted-foreground">
              <span className="font-medium">{c.id}.</span> {c.text}
            </div>
          ))}
        </div>
      );
    }

    return (
      <div className="border-b border-gray-400 w-40" />
    );
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        title="打印"
      >
        <Printer className="h-4 w-4" />
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={e => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="bg-background rounded-xl border shadow-xl w-80 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">打印选项</h3>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">
                答案位置
              </p>
              {([
                ['end', '末尾（统一揭晓）'],
                ['below', '题下（每题后）'],
                ['none', '不要（纯练习）'],
              ] as const).map(([value, label]) => (
                <label
                  key={value}
                  className="flex items-center gap-3 cursor-pointer p-2 rounded-lg hover:bg-muted"
                >
                  <input
                    type="radio"
                    name="print-mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                    className="accent-primary"
                  />
                  <span className="text-sm">{label}</span>
                </label>
              ))}
            </div>

            {mode !== 'none' && (
              <div className="rounded-lg border bg-muted/50 p-3 text-xs">
                <p className="text-muted-foreground mb-2">答案格式预览：</p>
                {renderAnswerPreview()}
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              <Button size="sm" onClick={handlePrint}>
                <Printer className="h-4 w-4 mr-1" />
                打印
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
