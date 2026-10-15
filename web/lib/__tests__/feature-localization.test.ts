import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import ts from 'typescript';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import zh from '@/messages/zh-CN.json';
const namespaces = [
  'Notebooks',
  'Insights',
  'Notes',
  'Todos',
  'Words',
] as const;
describe('feature localization', () => {
  it.each(namespaces)(
    'formats the %s namespace in both languages',
    namespace => {
      for (const [locale, messages] of [
        ['en', en],
        ['zh-CN', zh],
      ] as const) {
        const translate = createTranslator({
          locale,
          messages: messages as any,
          namespace,
          onError: error => {
            throw error;
          },
        });
        const flatten = (
          object: Record<string, unknown>,
          prefix = ''
        ): Array<[string, string]> =>
          Object.entries(object).flatMap(([key, value]) =>
            typeof value === 'string'
              ? [[prefix + key, value]]
              : flatten(value as Record<string, unknown>, prefix + key + '.')
          );
        for (const [key, value] of flatten(messages[namespace])) {
          const values = Object.fromEntries(
            [...value.matchAll(/\{([\w]+)[,}]/g)].map(match => [match[1], 1])
          );
          expect(() => translate(key as any, values)).not.toThrow();
          if (locale === 'en') expect(value).not.toMatch(/[\p{Script=Han}]/u);
        }
      }
    }
  );
  it('requires translated UI copy across notebook, todo, vocabulary and shelf pages', () => {
    const files: string[] = [];
    const walk = (folder: string) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const file = join(folder, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (file.endsWith('.tsx')) files.push(file);
      }
    };
    for (const folder of ['notebooks', 'todos', 'words', 'insights'])
      walk(resolve('app/[locale]/(app)', folder));
    files.push(resolve('app/[locale]/(app)/subjects/subjects-page-client.tsx'));
    const violations: string[] = [];
    for (const file of files) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );
      const visit = (node: ts.Node) => {
        // Accepted input headers are data parsing aliases, not displayed copy.
        if (
          ts.isVariableDeclaration(node) &&
          node.name.getText(source) === 'COLUMN_ALIASES'
        )
          return;
        if (
          (ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isJsxText(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node)) &&
          /[\p{Script=Han}]/u.test(node.text)
        )
          violations.push(
            `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
          );
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(violations).toEqual([]);
  });
});
