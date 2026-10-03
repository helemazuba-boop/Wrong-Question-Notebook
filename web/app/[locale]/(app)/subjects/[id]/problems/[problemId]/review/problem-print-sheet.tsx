'use client';

import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { RichTextDisplay } from '@/components/ui/rich-text-display';
import MathText from '@/components/ui/math-text';
import AssetPreview from './asset-preview';
import type {
  PrintAnswer,
  PrintPartBlock,
  PrintSheet,
  PrintSheetProblem,
} from '@/lib/print-sheet-model';
import './print-sheet.css';

/**
 * The worksheet itself: a document rendered beside the app, never inside it.
 *
 * It is portalled to <body> so that `body > .print-sheet` can be the only
 * visible node in print media — the app shell, the nav, the sidebar and any
 * open dialog are all siblings and all get hidden by that one rule.
 *
 * Nothing here is interactive. In particular this does NOT reuse
 * `AnswerInput`: that component names its radios `part-${index}-answer`, and a
 * second copy of the same radio group in the same document would silently
 * steer the on-screen answers. Choices are static markup instead, which is
 * also what lets the option letters stay visible while the screen hides them.
 */
/**
 * True once the client has mounted, false during the server render. The portal
 * target only exists in the browser, and this is what keeps the server and
 * client's first render identical.
 */
const emptySubscribe = () => () => {};
const selectMounted = () => true;
const selectServerMounted = () => false;

export default function ProblemPrintSheet({
  sheet,
}: {
  sheet: PrintSheet | null;
}) {
  const t = useTranslations('PrintDialog');
  const mounted = useSyncExternalStore(
    emptySubscribe,
    selectMounted,
    selectServerMounted
  );

  if (!mounted || !sheet || sheet.problems.length === 0) return null;

  return createPortal(
    <div className="print-sheet" aria-hidden="true">
      <header className="print-sheet-header">
        <span className="print-sheet-title">{t('worksheetTitle')}</span>
        <span className="print-sheet-blanks">
          {t('nameLabel')}&nbsp;&nbsp;&nbsp;{t('classLabel')}
          &nbsp;&nbsp;&nbsp;{t('dateLabel')}
        </span>
      </header>
      <p className="print-sheet-subject">{sheet.subjectName}</p>

      {sheet.problems.map(problem => (
        <ProblemBlock
          key={problem.id}
          problem={problem}
          placement={sheet.placement}
        />
      ))}

      {sheet.placement === 'end' && sheet.keyProblemCount > 0 && (
        <section className="print-sheet-key">
          <h2 className="print-sheet-key-title">{t('answerKeyTitle')}</h2>
          {sheet.problems
            .filter(problem => problem.hasKeyAnswers)
            .map(problem => (
              <div key={problem.id} className="print-sheet-key-problem">
                <strong className="print-sheet-number">
                  {problem.number}.
                </strong>{' '}
                <span className="print-sheet-key-parts">
                  <PartKeyAnswers parts={problem.parts} />
                </span>
                {problem.solutionHtml && <SolutionBlock problem={problem} />}
              </div>
            ))}
        </section>
      )}
    </div>,
    document.body
  );
}

function ProblemBlock({
  problem,
  placement,
}: {
  problem: PrintSheetProblem;
  placement: PrintSheet['placement'];
}) {
  const t = useTranslations('PrintDialog');

  return (
    <section className="print-sheet-problem">
      <h2 className="print-sheet-problem-title">
        <span className="print-sheet-number">{problem.number}.</span>{' '}
        {problem.title}
      </h2>

      {problem.contentHtml && (
        <RichTextDisplay
          className="print-sheet-stem"
          content={problem.contentHtml}
        />
      )}

      {problem.parts.map(part => (
        <div key={part.index} className="print-sheet-part">
          {part.label && (
            <h3 className="print-sheet-part-label">
              {part.label}
              {part.fullMarks !== null && (
                <span className="print-sheet-marks">
                  （{part.fullMarks} 分）
                </span>
              )}
            </h3>
          )}

          {part.contentHtml && (
            <RichTextDisplay
              className="print-sheet-part-stem"
              content={part.contentHtml}
            />
          )}

          {part.choices && (
            <ul className="print-sheet-choices">
              {part.choices.map(choice => (
                <li key={choice.id} className="print-sheet-choice">
                  <span className="print-sheet-choice-id">{choice.id}.</span>
                  <span className="print-sheet-choice-text">
                    {choice.text ? <MathText text={choice.text} /> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {part.writingLines > 0 &&
            Array.from({ length: part.writingLines }, (_, line) => (
              <div key={line} className="print-sheet-write-line" />
            ))}

          {part.inlineAnswer && (
            <div className="print-sheet-inline-answer">
              <span className="print-sheet-answer-label">
                {t('answerLabel')}
              </span>
              <AnswerText answer={part.inlineAnswer} />
            </div>
          )}
        </div>
      ))}

      {/* Under "below" the solution sits with its problem; under "end" it goes
          to the key page; under "none" the model carries none at all. */}
      {placement === 'below' &&
        (problem.solutionHtml || problem.solutionAssets.length > 0) && (
          <SolutionBlock problem={problem} />
        )}
    </section>
  );
}

function PartKeyAnswers({ parts }: { parts: PrintPartBlock[] }) {
  return (
    <>
      {parts.map(part =>
        part.keyAnswer ? (
          <span key={part.index} className="print-sheet-key-part">
            {part.label && (
              <em className="print-sheet-key-label">{part.label} </em>
            )}
            <AnswerText answer={part.keyAnswer} />
          </span>
        ) : null
      )}
    </>
  );
}

function SolutionBlock({ problem }: { problem: PrintSheetProblem }) {
  const t = useTranslations('PrintDialog');

  return (
    <div className="print-sheet-solution">
      <h3 className="print-sheet-solution-title">{t('solutionTitle')}</h3>
      {problem.solutionHtml && (
        <RichTextDisplay
          className="print-sheet-solution-text"
          content={problem.solutionHtml}
        />
      )}
      {problem.solutionAssets.length > 0 && (
        <div className="print-sheet-assets">
          {problem.solutionAssets.map((asset, index) => (
            <div key={`${asset.path}-${index}`} className="print-sheet-asset">
              <AssetPreview asset={asset} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One part's answer as it should read on paper. Choice answers stay as the
 * option letters the student circles; written answers go through the same
 * math-aware renderer the on-screen reveal uses, so a `$...$` acceptable
 * answer prints as a formula rather than as its source.
 */
function AnswerText({ answer }: { answer: PrintAnswer }) {
  switch (answer.kind) {
    case 'choice':
      return <span>{answer.optionIds.join(', ')}</span>;
    case 'numeric':
      return (
        <span>
          {answer.value} ± {answer.tolerance}
          {answer.unit ? ` ${answer.unit}` : ''}
        </span>
      );
    case 'text':
      return (
        <span className="print-sheet-answer-values">
          {answer.values.map((value, index) => (
            <span key={index}>
              <MathText text={value} />
            </span>
          ))}
        </span>
      );
  }
}
