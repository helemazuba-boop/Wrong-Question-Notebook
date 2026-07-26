'use client';

import { Button } from '@/components/ui/button';
import { RichTextDisplay } from '@/components/ui/rich-text-display';
import MathText from '@/components/ui/math-text';
import AssetPreview from './asset-preview';
import { useTranslations } from 'next-intl';
import { SolutionRevealProps } from '@/lib/types';
import type {
  AnswerConfig,
  MCQAnswerConfig,
  MultiMCQAnswerConfig,
  ProblemPart,
  ShortAnswerTextConfig,
  ShortAnswerNumericConfig,
} from '@/lib/types';

function StructuredAnswerDisplay({
  answerConfig,
}: {
  answerConfig: AnswerConfig;
}) {
  const t = useTranslations('Problems');
  if (answerConfig.type === 'mcq' || answerConfig.type === 'multi_mcq') {
    const correctIds =
      answerConfig.type === 'mcq'
        ? [(answerConfig as MCQAnswerConfig).correct_choice_id]
        : (answerConfig as MultiMCQAnswerConfig).correct_choice_ids;
    return (
      <div className="space-y-2">
        <p className="font-mono text-lg">{correctIds.join(', ')}</p>
        <div className="space-y-1">
          {answerConfig.choices.map(choice => (
            <div
              key={choice.id}
              className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm ${
                correctIds.includes(choice.id)
                  ? 'bg-green-100/60 font-medium text-green-800 dark:bg-green-900/20 dark:text-green-300'
                  : 'text-muted-foreground'
              }`}
            >
              <span className="font-semibold">{choice.id}.</span>
              <span>
                <MathText text={choice.text} />
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (answerConfig.type === 'short') {
    if ((answerConfig as ShortAnswerTextConfig).mode === 'text') {
      const config = answerConfig as ShortAnswerTextConfig;
      return (
        <div className="space-y-1">
          <p className="text-sm text-green-700 dark:text-green-300 mb-1">
            {t('acceptableAnswers')}:
          </p>
          <div className="flex flex-wrap gap-2">
            {config.acceptable_answers.map((answer, i) => (
              <span
                key={i}
                className="inline-flex rounded-full border border-green-200 bg-green-50 px-3 py-1 text-sm font-mono text-green-800 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300"
              >
                {answer}
              </span>
            ))}
          </div>
        </div>
      );
    }

    if ((answerConfig as ShortAnswerNumericConfig).mode === 'numeric') {
      const config = answerConfig as ShortAnswerNumericConfig;
      const { correct_value, tolerance, unit } = config.numeric_config;
      return (
        <p className="font-mono text-lg">
          {correct_value} &plusmn; {tolerance}
          {unit ? ` ${unit}` : ''}
        </p>
      );
    }
  }

  return null;
}

// True when the part carries anything worth revealing as an answer.
function partHasAnswer(part: ProblemPart): boolean {
  return !!part.answer_config || !!part.correct_answer;
}

function PartAnswerDisplay({ part }: { part: ProblemPart }) {
  if (part.answer_config) {
    return <StructuredAnswerDisplay answerConfig={part.answer_config} />;
  }
  if (part.type === 'essay') {
    return (
      <div className="prose max-w-none rich-text-content">
        <RichTextDisplay content={String(part.correct_answer ?? '')} />
      </div>
    );
  }
  return <p className="font-mono text-lg">{part.correct_answer}</p>;
}

export default function SolutionReveal({
  solutionText,
  solutionAssets,
  parts,
  isRevealed,
  onToggle,
  wrapperClassName,
}: SolutionRevealProps) {
  const t = useTranslations('Problems');
  const answeredParts = parts.filter(partHasAnswer);
  const hasCorrectAnswer = answeredParts.length > 0;

  // Consider it a "solution" if there's solution text, assets, OR a correct answer
  const hasSolution =
    solutionText || solutionAssets.length > 0 || hasCorrectAnswer;

  return (
    <div
      className={
        wrapperClassName || 'bg-card rounded-lg border border-border p-4'
      }
    >
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-green-900 dark:text-green-100">
          {t('solutionTitle')}
        </h2>
        {hasSolution && (
          <Button onClick={onToggle} variant="secondary">
            {isRevealed ? t('hideSolution') : t('revealSolution')}
          </Button>
        )}
      </div>

      {!hasSolution ? (
        <div className="text-center py-8 text-muted-foreground print-reveal-placeholder">
          <div className="w-16 h-16 mx-auto mb-4 bg-muted rounded-full flex items-center justify-center">
            <span className="text-2xl">📝</span>
          </div>
          <p className="text-sm">{t('noSolutionProvided')}</p>
        </div>
      ) : isRevealed ? (
        <div className="space-y-4 print-reveal-content">
          {/* Correct Answers, one block per part that declares one */}
          {hasCorrectAnswer && (
            <div className="bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 rounded-md p-4">
              <h3 className="font-medium text-green-800 dark:text-green-200 mb-2">
                {t('correctAnswer')}
              </h3>
              <div className="text-green-700 dark:text-green-300 space-y-3">
                {answeredParts.map(part => (
                  <div key={part.index}>
                    {parts.length > 1 && (
                      <p className="mb-1 text-sm font-semibold">
                        {part.label || `(${part.index})`}
                        {part.full_marks !== undefined
                          ? ` · ${part.full_marks}分`
                          : ''}
                      </p>
                    )}
                    <PartAnswerDisplay part={part} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Solution Text */}
          {solutionText && (
            <div className="space-y-2">
              <div className="prose max-w-none rich-text-content">
                <RichTextDisplay content={solutionText} />
              </div>
            </div>
          )}

          {/* Solution Assets */}
          {solutionAssets && solutionAssets.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {solutionAssets.map((asset, i) => (
                <AssetPreview key={i} asset={asset} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="text-center py-8 text-muted-foreground print-reveal-placeholder">
          <p className="text-sm">{t('clickToRevealSolution')}</p>
        </div>
      )}
    </div>
  );
}
