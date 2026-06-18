'use client';

import { useMemo, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ArrowLeft, FileSpreadsheet, FileUp, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';

export interface WordDeckView {
  id: string;
  title: string;
  description: string | null;
  source: string;
  subject_id: string | null;
  subject_name: string | null;
  language: string;
  target_language: string;
  lexicon_type: string | null;
  is_system: boolean;
  is_active: boolean;
  revision: number;
  word_count: number;
  updated_at: string;
  ai_access?: {
    can_read: boolean;
    can_create: boolean;
    can_update: boolean;
  };
}

export interface WordEntryView {
  id: string;
  deck_id: string;
  word: string;
  normalized_word: string;
  phonetic: string | null;
  meaning: string;
  example: string | null;
  example_translation: string | null;
  part_of_speech: string | null;
  tags: string[];
  sort_index: number;
  revision: number;
  updated_at: string;
}

type ImportEntry = {
  word: string;
  phonetic?: string | null;
  meaning: string;
  example?: string | null;
  example_translation?: string | null;
  part_of_speech?: string | null;
  tags?: string[];
  sort_index?: number;
};

type ImportColumn =
  | 'word'
  | 'phonetic'
  | 'meaning'
  | 'example'
  | 'example_translation'
  | 'part_of_speech'
  | 'tags';

type ParseResult = {
  entries: ImportEntry[];
  skipped: number;
  hasHeader: boolean;
  delimiter: string;
  columns: Partial<Record<ImportColumn, number>>;
};

const MAX_IMPORT_ENTRIES = 4000;
const PREVIEW_LIMIT = 10;

const COLUMN_ALIASES: Record<ImportColumn, string[]> = {
  word: ['word', 'term', 'vocabulary', 'english', 'en', '单词', '词语', '英文', '词条'],
  phonetic: ['phonetic', 'phonetics', 'ipa', 'pronunciation', '音标', '读音'],
  meaning: ['meaning', 'definition', 'translation', 'cn', 'zh', '释义', '含义', '中文', '解释', '翻译'],
  example: ['example', 'sentence', 'usage', '例句', '英文例句', '用法'],
  example_translation: [
    'example_translation',
    'exampletranslation',
    'sentence_translation',
    'sentence translation',
    '例句翻译',
    '例句中文',
    '中文例句',
  ],
  part_of_speech: ['part_of_speech', 'partofspeech', 'pos', '词性'],
  tags: ['tags', 'tag', 'labels', 'label', '标签', '分类'],
};

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_\-./()[\]{}:：]/g, '');
}

function findColumnByHeader(header: string): ImportColumn | null {
  const normalized = normalizeHeader(header);
  for (const [column, aliases] of Object.entries(COLUMN_ALIASES) as [
    ImportColumn,
    string[],
  ][]) {
    if (aliases.some(alias => normalizeHeader(alias) === normalized)) {
      return column;
    }
  }
  return null;
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function detectDelimiter(lines: string[]): string {
  const candidates = ['\t', ',', ';', '|'];
  let best = '\t';
  let bestScore = -1;
  for (const delimiter of candidates) {
    const score = lines
      .slice(0, 8)
      .reduce((sum, line) => sum + splitDelimitedLine(line, delimiter).length, 0);
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

function looksLikeWord(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) return false;
  return /^[A-Za-z][A-Za-z' -]*$/.test(trimmed) && trimmed.split(/\s+/).length <= 4;
}

function looksLikePhonetic(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^\/.+\/$/.test(trimmed) ||
    /^\[.+]$/.test(trimmed) ||
    /[ˈˌəɪɔæʊɛθðʃʒŋɑɒː]/.test(trimmed)
  );
}

function chineseScore(value: string): number {
  const matches = value.match(/[\u3400-\u9fff]/g);
  return matches ? matches.length : 0;
}

function looksLikePartOfSpeech(value: string): boolean {
  return /^(n|v|vi|vt|adj|adv|prep|conj|pron|num|art|det|int|phr|abbr)\.?(\s|$)/i.test(
    value.trim()
  );
}

function scoreColumn(rows: string[][], index: number, scorer: (value: string) => number): number {
  return rows
    .slice(0, 30)
    .reduce((sum, row) => sum + scorer(row[index] || ''), 0);
}

function pickBestColumn(
  rows: string[][],
  used: Set<number>,
  scorer: (value: string) => number,
  minScore = 1
): number | undefined {
  const maxColumns = Math.max(...rows.map(row => row.length), 0);
  let bestIndex: number | undefined;
  let bestScore = minScore - 1;
  for (let index = 0; index < maxColumns; index += 1) {
    if (used.has(index)) continue;
    const score = scoreColumn(rows, index, scorer);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  return bestIndex;
}

function inferColumns(rows: string[][]): Partial<Record<ImportColumn, number>> {
  const columns: Partial<Record<ImportColumn, number>> = {};
  const used = new Set<number>();

  const word = pickBestColumn(rows, used, value => (looksLikeWord(value) ? 5 : 0));
  if (word !== undefined) {
    columns.word = word;
    used.add(word);
  }

  const phonetic = pickBestColumn(rows, used, value => (looksLikePhonetic(value) ? 4 : 0));
  if (phonetic !== undefined) {
    columns.phonetic = phonetic;
    used.add(phonetic);
  }

  const partOfSpeech = pickBestColumn(rows, used, value =>
    looksLikePartOfSpeech(value) ? 3 : 0
  );
  if (partOfSpeech !== undefined) {
    columns.part_of_speech = partOfSpeech;
    used.add(partOfSpeech);
  }

  const meaning = pickBestColumn(rows, used, value => {
    const text = value.trim();
    if (!text) return 0;
    return chineseScore(text) * 3 + Math.min(text.length, 80) / 8;
  });
  if (meaning !== undefined) {
    columns.meaning = meaning;
    used.add(meaning);
  }

  const example = pickBestColumn(rows, used, value => {
    const text = value.trim();
    if (!text) return 0;
    const hasLatinSentence = /[A-Za-z]/.test(text) && text.split(/\s+/).length >= 4;
    return hasLatinSentence ? Math.min(text.length, 120) / 4 : 0;
  });
  if (example !== undefined) {
    columns.example = example;
    used.add(example);
  }

  const exampleTranslation = pickBestColumn(rows, used, value => {
    const text = value.trim();
    if (!text) return 0;
    return chineseScore(text) * 2 + Math.min(text.length, 120) / 10;
  });
  if (exampleTranslation !== undefined) {
    columns.example_translation = exampleTranslation;
    used.add(exampleTranslation);
  }

  const tags = pickBestColumn(rows, used, value =>
    /[;|、，,]/.test(value) && value.length < 120 ? 2 : 0
  );
  if (tags !== undefined) columns.tags = tags;

  return columns;
}

function columnsFromHeader(header: string[]): Partial<Record<ImportColumn, number>> {
  const columns: Partial<Record<ImportColumn, number>> = {};
  header.forEach((cell, index) => {
    const column = findColumnByHeader(cell);
    if (column && columns[column] === undefined) columns[column] = index;
  });
  return columns;
}

function hasUsefulHeader(columns: Partial<Record<ImportColumn, number>>): boolean {
  return columns.word !== undefined && columns.meaning !== undefined;
}

function getCell(row: string[], index?: number): string {
  if (index === undefined) return '';
  return (row[index] || '').trim();
}

function parseTags(value: string): string[] | undefined {
  const tags = value
    .split(/[;|、，,]/)
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 16);
  return tags.length > 0 ? tags : undefined;
}

function rowToImportEntry(
  row: string[],
  columns: Partial<Record<ImportColumn, number>>,
  index: number
): ImportEntry | null {
  const word = getCell(row, columns.word);
  const meaning = getCell(row, columns.meaning);
  if (!word || !meaning) return null;
  return {
    word,
    meaning,
    phonetic: getCell(row, columns.phonetic) || null,
    example: getCell(row, columns.example) || null,
    example_translation: getCell(row, columns.example_translation) || null,
    part_of_speech: getCell(row, columns.part_of_speech) || null,
    tags: parseTags(getCell(row, columns.tags)),
    sort_index: index,
  };
}

function valueFromAliases(row: Record<string, unknown>, column: ImportColumn): unknown {
  for (const alias of COLUMN_ALIASES[column]) {
    const exact = row[alias];
    if (exact !== undefined) return exact;
    const normalizedAlias = normalizeHeader(alias);
    const found = Object.entries(row).find(
      ([key]) => normalizeHeader(key) === normalizedAlias
    );
    if (found) return found[1];
  }
  return undefined;
}

function normalizeJsonImportEntry(value: unknown, index: number): ImportEntry | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const word = String(valueFromAliases(row, 'word') || '').trim();
  const meaning = String(valueFromAliases(row, 'meaning') || '').trim();
  if (!word || !meaning) return null;

  const rawTags = valueFromAliases(row, 'tags');
  const tags = Array.isArray(rawTags)
    ? rawTags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 16)
    : typeof rawTags === 'string'
      ? parseTags(rawTags)
      : undefined;

  return {
    word,
    meaning,
    phonetic: String(valueFromAliases(row, 'phonetic') || '').trim() || null,
    example: String(valueFromAliases(row, 'example') || '').trim() || null,
    example_translation:
      String(valueFromAliases(row, 'example_translation') || '').trim() || null,
    part_of_speech:
      String(valueFromAliases(row, 'part_of_speech') || '').trim() || null,
    tags,
    sort_index:
      typeof row.sort_index === 'number' && Number.isFinite(row.sort_index)
        ? row.sort_index
        : index,
  };
}

function parseImportText(text: string): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { entries: [], skipped: 0, hasHeader: false, delimiter: '\t', columns: {} };
  }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const entries = rows
      .map((row, index) => normalizeJsonImportEntry(row, index))
      .filter(Boolean) as ImportEntry[];
    return {
      entries,
      skipped: rows.length - entries.length,
      hasHeader: true,
      delimiter: 'json',
      columns: {},
    };
  }

  const lines = trimmed.split(/\r?\n/).filter(line => line.trim().length > 0);
  const delimiter = detectDelimiter(lines);
  const table = lines.map(line => splitDelimitedLine(line, delimiter));
  const headerColumns = columnsFromHeader(table[0] || []);
  const hasHeader = hasUsefulHeader(headerColumns);
  const dataRows = hasHeader ? table.slice(1) : table;
  const columns = hasHeader ? headerColumns : inferColumns(dataRows);
  const entries = dataRows
    .map((row, index) => rowToImportEntry(row, columns, index))
    .filter(Boolean) as ImportEntry[];

  return {
    entries,
    skipped: dataRows.length - entries.length,
    hasHeader,
    delimiter,
    columns,
  };
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function delimiterLabel(delimiter: string) {
  if (delimiter === '\t') return '制表符';
  if (delimiter === ',') return '逗号';
  if (delimiter === ';') return '分号';
  if (delimiter === '|') return '竖线';
  if (delimiter === 'json') return 'JSON';
  return delimiter;
}

export default function WordDeckPageClient({
  deck,
  initialEntries,
  initialEntryCount,
}: {
  deck: WordDeckView;
  initialEntries: WordEntryView[];
  initialEntryCount: number | null;
}) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [parseResult, setParseResult] = useState<ParseResult>({
    entries: [],
    skipped: 0,
    hasHeader: false,
    delimiter: '\t',
    columns: {},
  });
  const [lastImportedCount, setLastImportedCount] = useState<number | null>(null);
  const canImport = !deck.is_system;

  const visibleEntries = useMemo(() => initialEntries, [initialEntries]);
  const previewEntries = parseResult.entries.slice(0, PREVIEW_LIMIT);

  function previewImport(value: string) {
    setText(value);
    try {
      setParseResult(parseImportText(value));
    } catch {
      setParseResult({
        entries: [],
        skipped: 0,
        hasHeader: false,
        delimiter: '\t',
        columns: {},
      });
    }
  }

  async function handleFile(file: File | null) {
    if (!file) return;
    const name = file.name.toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const firstSheet = workbook.SheetNames[0];
      const worksheet = firstSheet ? workbook.Sheets[firstSheet] : null;
      if (!worksheet) {
        toast.error('Excel 文件中没有可读取的工作表');
        return;
      }
      const tableText = XLSX.utils.sheet_to_csv(worksheet, { FS: '\t' });
      previewImport(tableText);
      return;
    }
    previewImport(await file.text());
  }

  async function submitImport() {
    if (!canImport) {
      toast.error('系统词库不能直接导入');
      return;
    }

    let result: ParseResult;
    try {
      result = parseImportText(text);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入内容格式错误');
      return;
    }

    if (result.entries.length === 0) {
      toast.error('没有可导入的词条。请确认表格中至少有“单词”和“释义”两列。');
      return;
    }
    if (result.entries.length > MAX_IMPORT_ENTRIES) {
      toast.error(`单次最多导入 ${MAX_IMPORT_ENTRIES} 条`);
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`/api/words/decks/${deck.id}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: result.entries }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message || '导入失败');
      }
      const importedCount = Number(payload?.data?.imported_count || 0);
      setLastImportedCount(importedCount);
      toast.success(`已导入 ${importedCount} 条词条`);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section-container space-y-6">
      <PageHeader
        title={deck.title}
        description={deck.description || '管理词库条目，并通过设备词库资源包同步到 WQN Note4。'}
        actions={
          <Button variant="outline" asChild>
            <Link href="/subjects">
              <ArrowLeft className="mr-2 h-4 w-4" />
              返回笔记本架
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">词条数</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {initialEntryCount ?? deck.word_count}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">类型</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant={deck.is_system ? 'default' : 'secondary'}>
              {deck.is_system ? '系统词库' : '用户词库'}
            </Badge>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">归档</CardTitle>
          </CardHeader>
          <CardContent className="text-sm font-medium">
            {deck.subject_name || '未分类'}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Revision</CardTitle>
          </CardHeader>
          <CardContent className="text-sm font-medium">
            {deck.revision} / {formatDate(deck.updated_at)}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <Card>
          <CardHeader>
            <CardTitle>词条预览</CardTitle>
          </CardHeader>
          <CardContent>
            {visibleEntries.length === 0 ? (
              <div className="rounded-md border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
                当前词库还没有词条。
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>单词</TableHead>
                    <TableHead>音标</TableHead>
                    <TableHead>释义</TableHead>
                    <TableHead>词性</TableHead>
                    <TableHead>例句</TableHead>
                    <TableHead>例句翻译</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleEntries.map(entry => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-medium">{entry.word}</TableCell>
                      <TableCell>{entry.phonetic || '--'}</TableCell>
                      <TableCell className="max-w-md truncate">{entry.meaning}</TableCell>
                      <TableCell>{entry.part_of_speech || '--'}</TableCell>
                      <TableCell className="max-w-md truncate" title={entry.example || ''}>{entry.example || '--'}</TableCell>
                      <TableCell className="max-w-md truncate" title={entry.example_translation || ''}>{entry.example_translation || '--'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {initialEntryCount && initialEntryCount > initialEntries.length && (
              <p className="text-sm text-muted-foreground text-center py-2">
                显示前 {initialEntries.length} 条 / 共 {initialEntryCount} 条
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>导入词条</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {canImport ? (
              <>
                <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
                  <div className="mb-2 flex items-center font-medium text-foreground">
                    <FileSpreadsheet className="mr-2 h-4 w-4" />
                    Excel 表格导入
                  </div>
                  从 Excel 复制整张表格后粘贴，或上传 CSV/TSV/JSON。表头可写
                  “单词、释义、音标、例句、例句翻译、词性、标签”，没有表头时会自动识别。
                </div>
                <div className="space-y-2">
                  <Label htmlFor="word-import-file">Excel / CSV / TSV / JSON 文件</Label>
                  <Input
                    id="word-import-file"
                    type="file"
                    accept=".csv,.tsv,.txt,.json,.xlsx,.xls,application/json,text/csv,text/plain"
                    onChange={event => handleFile(event.target.files?.[0] || null)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="word-import-text">粘贴导入内容</Label>
                  <Textarea
                    id="word-import-text"
                    value={text}
                    onChange={event => previewImport(event.target.value)}
                    rows={12}
                    placeholder={'单词\t释义\t音标\t例句\t例句翻译\nconsistent\t一致的；持续的\t/kənˈsɪstənt/\tShe is consistent in her work.\t她工作一直很稳定。'}
                  />
                </div>
                <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                  单次最多 {MAX_IMPORT_ENTRIES} 条。当前识别：
                  {parseResult.entries.length} 条可导入，
                  {parseResult.skipped} 行跳过，分隔符 {delimiterLabel(parseResult.delimiter)}
                  {parseResult.hasHeader ? '，已识别表头。' : '，按内容自动推断列。'}
                </div>
                {previewEntries.length > 0 ? (
                  <>
                    <Separator />
                    <div className="space-y-2">
                      <p className="text-sm font-medium">
                        预览前 {previewEntries.length} 条
                      </p>
                      <div className="space-y-1 text-xs text-muted-foreground">
                        {previewEntries.map((entry, index) => (
                          <div key={`${entry.word}-${index}`} className="truncate">
                            {entry.word} / {entry.meaning}
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                ) : null}
                <Button className="w-full" onClick={submitImport} disabled={busy}>
                  {busy ? (
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <FileUp className="mr-2 h-4 w-4" />
                  )}
                  {busy ? '导入中...' : '导入到词库'}
                </Button>
                {lastImportedCount !== null ? (
                  <p className="text-sm text-muted-foreground">
                    上次成功导入 {lastImportedCount} 条。
                  </p>
                ) : null}
              </>
            ) : (
              <div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                系统词库由 WQN 云端维护，不能在这里直接导入。
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
