'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  FileUp,
  ListTodo,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
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
  progress?: {
    status: 'new' | 'learning' | 'review' | 'mastered';
    due_at: string | null;
    interval_days: number;
    correct_streak: number;
    lapses: number;
    reviewed_count: number;
    known_count: number;
    unknown_count: number;
    last_reviewed_at: string | null;
  };
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
const ENTRY_PAGE_SIZE = 50;

const COLUMN_ALIASES: Record<ImportColumn, string[]> = {
  word: [
    'word',
    'term',
    'vocabulary',
    'english',
    'en',
    '单词',
    '词语',
    '英文',
    '词条',
  ],
  phonetic: ['phonetic', 'phonetics', 'ipa', 'pronunciation', '音标', '读音'],
  meaning: [
    'meaning',
    'definition',
    'translation',
    'cn',
    'zh',
    '释义',
    '含义',
    '中文',
    '解释',
    '翻译',
  ],
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
      .reduce(
        (sum, line) => sum + splitDelimitedLine(line, delimiter).length,
        0
      );
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
  return (
    /^[A-Za-z][A-Za-z' -]*$/.test(trimmed) && trimmed.split(/\s+/).length <= 4
  );
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

function scoreColumn(
  rows: string[][],
  index: number,
  scorer: (value: string) => number
): number {
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

  const word = pickBestColumn(rows, used, value =>
    looksLikeWord(value) ? 5 : 0
  );
  if (word !== undefined) {
    columns.word = word;
    used.add(word);
  }

  const phonetic = pickBestColumn(rows, used, value =>
    looksLikePhonetic(value) ? 4 : 0
  );
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
    const hasLatinSentence =
      /[A-Za-z]/.test(text) && text.split(/\s+/).length >= 4;
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

function columnsFromHeader(
  header: string[]
): Partial<Record<ImportColumn, number>> {
  const columns: Partial<Record<ImportColumn, number>> = {};
  header.forEach((cell, index) => {
    const column = findColumnByHeader(cell);
    if (column && columns[column] === undefined) columns[column] = index;
  });
  return columns;
}

function hasUsefulHeader(
  columns: Partial<Record<ImportColumn, number>>
): boolean {
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

function valueFromAliases(
  row: Record<string, unknown>,
  column: ImportColumn
): unknown {
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

function normalizeJsonImportEntry(
  value: unknown,
  index: number
): ImportEntry | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const word = String(valueFromAliases(row, 'word') || '').trim();
  const meaning = String(valueFromAliases(row, 'meaning') || '').trim();
  if (!word || !meaning) return null;

  const rawTags = valueFromAliases(row, 'tags');
  const tags = Array.isArray(rawTags)
    ? rawTags
        .map(tag => String(tag).trim())
        .filter(Boolean)
        .slice(0, 16)
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
    return {
      entries: [],
      skipped: 0,
      hasHeader: false,
      delimiter: '\t',
      columns: {},
    };
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
  const [lastImportedCount, setLastImportedCount] = useState<number | null>(
    null
  );
  const canImport = !deck.is_system;
  const [addWord, setAddWord] = useState('');
  const [addMeaning, setAddMeaning] = useState('');
  const [addPhonetic, setAddPhonetic] = useState('');
  const [addPartOfSpeech, setAddPartOfSpeech] = useState('');
  const [addExample, setAddExample] = useState('');
  const [addExampleTranslation, setAddExampleTranslation] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [entries, setEntries] = useState(initialEntries);
  const [entryCount, setEntryCount] = useState(
    initialEntryCount ?? initialEntries.length
  );
  const [entryQuery, setEntryQuery] = useState('');
  const [appliedEntryQuery, setAppliedEntryQuery] = useState('');
  const [entryPage, setEntryPage] = useState(0);
  const [entryLoading, setEntryLoading] = useState(false);
  const [editingEntry, setEditingEntry] = useState<WordEntryView | null>(null);
  const [editWord, setEditWord] = useState('');
  const [editMeaning, setEditMeaning] = useState('');
  const [editPhonetic, setEditPhonetic] = useState('');
  const [editPartOfSpeech, setEditPartOfSpeech] = useState('');
  const [editExample, setEditExample] = useState('');
  const [editExampleTranslation, setEditExampleTranslation] = useState('');
  const [editBusy, setEditBusy] = useState(false);

  const visibleEntries = useMemo(() => entries, [entries]);
  const previewEntries = parseResult.entries.slice(0, PREVIEW_LIMIT);
  const pageCount = Math.max(1, Math.ceil(entryCount / ENTRY_PAGE_SIZE));

  async function loadEntryPage(page: number, query: string) {
    setEntryLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(ENTRY_PAGE_SIZE),
        offset: String(page * ENTRY_PAGE_SIZE),
      });
      if (query.trim()) params.set('q', query.trim());
      const response = await fetch(
        `/api/words/decks/${deck.id}/entries?${params.toString()}`,
        { cache: 'no-store' }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message || '加载词条失败');
      }
      setEntries(payload?.data?.entries || []);
      setEntryCount(Number(payload?.data?.count || 0));
      setEntryPage(page);
      setAppliedEntryQuery(query.trim());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载词条失败');
    } finally {
      setEntryLoading(false);
    }
  }

  function submitEntrySearch(event: FormEvent) {
    event.preventDefault();
    void loadEntryPage(0, entryQuery);
  }

  function openEntryEditor(entry: WordEntryView) {
    setEditingEntry(entry);
    setEditWord(entry.word);
    setEditMeaning(entry.meaning);
    setEditPhonetic(entry.phonetic || '');
    setEditPartOfSpeech(entry.part_of_speech || '');
    setEditExample(entry.example || '');
    setEditExampleTranslation(entry.example_translation || '');
  }

  async function saveEntry(event: FormEvent) {
    event.preventDefault();
    if (!editingEntry || !editWord.trim() || !editMeaning.trim()) return;
    setEditBusy(true);
    try {
      const response = await fetch(`/api/words/${editingEntry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          word: editWord.trim(),
          meaning: editMeaning.trim(),
          phonetic: editPhonetic.trim() || null,
          part_of_speech: editPartOfSpeech.trim() || null,
          example: editExample.trim() || null,
          example_translation: editExampleTranslation.trim() || null,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message || '保存词条失败');
      }
      const updated = payload?.data?.word as WordEntryView;
      setEntries(current =>
        current.map(entry =>
          entry.id === updated.id
            ? { ...updated, progress: entry.progress }
            : entry
        )
      );
      setEditingEntry(null);
      toast.success('词条已保存');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存词条失败');
    } finally {
      setEditBusy(false);
    }
  }

  async function deleteEntry() {
    if (!editingEntry) return;
    if (!window.confirm(`确认删除「${editingEntry.word}」？`)) return;
    setEditBusy(true);
    try {
      const response = await fetch(`/api/words/${editingEntry.id}`, {
        method: 'DELETE',
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message || '删除词条失败');
      }
      setEditingEntry(null);
      toast.success('词条已删除');
      await loadEntryPage(
        Math.min(entryPage, Math.max(0, pageCount - 2)),
        appliedEntryQuery
      );
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除词条失败');
    } finally {
      setEditBusy(false);
    }
  }

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
      await loadEntryPage(0, appliedEntryQuery);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入失败');
    } finally {
      setBusy(false);
    }
  }

  async function submitAddWord(event: FormEvent) {
    event.preventDefault();
    if (!canImport) {
      toast.error('系统词库不能直接添加');
      return;
    }
    const word = addWord.trim();
    const meaning = addMeaning.trim();
    if (!word || !meaning) {
      toast.error('请填写单词和释义');
      return;
    }
    setAddBusy(true);
    try {
      const body: Record<string, string> = { word, meaning };
      if (addPhonetic.trim()) body.phonetic = addPhonetic.trim();
      if (addPartOfSpeech.trim()) body.part_of_speech = addPartOfSpeech.trim();
      if (addExample.trim()) body.example = addExample.trim();
      if (addExampleTranslation.trim())
        body.example_translation = addExampleTranslation.trim();
      const response = await fetch(`/api/words/decks/${deck.id}/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message || '添加失败');
      }
      toast.success(`已添加「${word}」`);
      setAddWord('');
      setAddMeaning('');
      setAddPhonetic('');
      setAddPartOfSpeech('');
      setAddExample('');
      setAddExampleTranslation('');
      await loadEntryPage(0, appliedEntryQuery);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '添加失败');
    } finally {
      setAddBusy(false);
    }
  }

  async function createEntryTodo(entry: WordEntryView) {
    try {
      const response = await fetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `复习：${entry.word}`,
          description: entry.meaning,
          word_deck_id: deck.id,
          word_entry_id: entry.id,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || '创建 Todo 失败');
      }
      toast.success(`已把「${entry.word}」加入 Todo`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建 Todo 失败');
    }
  }

  return (
    <div className="section-container space-y-6">
      <PageHeader
        title={deck.title}
        description={
          deck.description ||
          '管理词库条目，并通过设备词库资源包同步到 WQN Note4。'
        }
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/words">
                <ArrowLeft className="mr-2 h-4 w-4" />
                返回 Word
              </Link>
            </Button>
            <Button asChild>
              <Link href={`/words/study/new?deck=${deck.id}`}>
                <Play className="mr-2 h-4 w-4" />
                开始学习
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              词条数
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {initialEntryCount ?? deck.word_count}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              类型
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant={deck.is_system ? 'default' : 'secondary'}>
              {deck.is_system ? '系统词库' : '用户词库'}
            </Badge>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              归档
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm font-medium">
            {deck.subject_name || '未分类'}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Revision
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm font-medium">
            {deck.revision} / {formatDate(deck.updated_at)}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <Card>
          <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>词条管理</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                共 {entryCount} 条
                {appliedEntryQuery ? `，正在搜索“${appliedEntryQuery}”` : ''}
              </p>
            </div>
            <form
              onSubmit={submitEntrySearch}
              className="flex w-full gap-2 sm:max-w-sm"
            >
              <div className="relative flex-1">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={entryQuery}
                  onChange={event => setEntryQuery(event.target.value)}
                  placeholder="搜索单词或释义"
                  className="pl-9"
                />
              </div>
              <Button type="submit" variant="outline" disabled={entryLoading}>
                搜索
              </Button>
            </form>
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
                    <TableHead>进度</TableHead>
                    <TableHead className="w-24">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleEntries.map(entry => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-medium">
                        {entry.word}
                      </TableCell>
                      <TableCell>{entry.phonetic || '--'}</TableCell>
                      <TableCell className="max-w-md truncate">
                        {entry.meaning}
                      </TableCell>
                      <TableCell>{entry.part_of_speech || '--'}</TableCell>
                      <TableCell
                        className="max-w-md truncate"
                        title={entry.example || ''}
                      >
                        {entry.example || '--'}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {entry.progress?.status === 'learning'
                            ? '学习中'
                            : entry.progress?.status === 'review'
                              ? '复习'
                              : entry.progress?.status === 'mastered'
                                ? '已掌握'
                                : '新词'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => void createEntryTodo(entry)}
                            aria-label={`为${entry.word}创建 Todo`}
                          >
                            <ListTodo className="h-4 w-4" />
                          </Button>
                          {!deck.is_system ? (
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => openEntryEditor(entry)}
                              aria-label={`编辑${entry.word}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <div className="mt-4 flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                第 {entryPage + 1} / {pageCount} 页
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void loadEntryPage(entryPage - 1, appliedEntryQuery)
                  }
                  disabled={entryLoading || entryPage === 0}
                >
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  上一页
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void loadEntryPage(entryPage + 1, appliedEntryQuery)
                  }
                  disabled={entryLoading || entryPage + 1 >= pageCount}
                >
                  下一页
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>添加单词</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {canImport ? (
              <form onSubmit={submitAddWord} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="add-word-word">
                      单词 <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="add-word-word"
                      value={addWord}
                      onChange={event => setAddWord(event.target.value)}
                      maxLength={80}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="add-word-phonetic">音标</Label>
                    <Input
                      id="add-word-phonetic"
                      value={addPhonetic}
                      onChange={event => setAddPhonetic(event.target.value)}
                      maxLength={120}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="add-word-meaning">
                    释义 <span className="text-destructive">*</span>
                  </Label>
                  <Textarea
                    id="add-word-meaning"
                    value={addMeaning}
                    onChange={event => setAddMeaning(event.target.value)}
                    maxLength={1000}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="add-word-pos">词性</Label>
                  <Input
                    id="add-word-pos"
                    value={addPartOfSpeech}
                    onChange={event => setAddPartOfSpeech(event.target.value)}
                    maxLength={80}
                    placeholder="可选，如 n. / v."
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="add-word-example">例句</Label>
                  <Textarea
                    id="add-word-example"
                    value={addExample}
                    onChange={event => setAddExample(event.target.value)}
                    maxLength={1000}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="add-word-example-tr">例句翻译</Label>
                  <Textarea
                    id="add-word-example-tr"
                    value={addExampleTranslation}
                    onChange={event =>
                      setAddExampleTranslation(event.target.value)
                    }
                    maxLength={1000}
                  />
                </div>
                <Button type="submit" disabled={addBusy}>
                  {addBusy ? '添加中...' : '添加单词'}
                </Button>
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">
                系统词库由 WQN 云端维护，不能在这里直接添加。
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
                  <Label htmlFor="word-import-file">
                    Excel / CSV / TSV / JSON 文件
                  </Label>
                  <Input
                    id="word-import-file"
                    type="file"
                    accept=".csv,.tsv,.txt,.json,.xlsx,.xls,application/json,text/csv,text/plain"
                    onChange={event =>
                      handleFile(event.target.files?.[0] || null)
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="word-import-text">粘贴导入内容</Label>
                  <Textarea
                    id="word-import-text"
                    value={text}
                    onChange={event => previewImport(event.target.value)}
                    rows={12}
                    placeholder={
                      '单词\t释义\t音标\t例句\t例句翻译\nconsistent\t一致的；持续的\t/kənˈsɪstənt/\tShe is consistent in her work.\t她工作一直很稳定。'
                    }
                  />
                </div>
                <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                  单次最多 {MAX_IMPORT_ENTRIES} 条。当前识别：
                  {parseResult.entries.length} 条可导入，
                  {parseResult.skipped} 行跳过，分隔符{' '}
                  {delimiterLabel(parseResult.delimiter)}
                  {parseResult.hasHeader
                    ? '，已识别表头。'
                    : '，按内容自动推断列。'}
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
                          <div
                            key={`${entry.word}-${index}`}
                            className="truncate"
                          >
                            {entry.word} / {entry.meaning}
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                ) : null}
                <Button
                  className="w-full"
                  onClick={submitImport}
                  disabled={busy}
                >
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

      <Dialog
        open={Boolean(editingEntry)}
        onOpenChange={open => !open && setEditingEntry(null)}
      >
        <DialogContent className="max-w-2xl">
          <form onSubmit={saveEntry}>
            <DialogHeader>
              <DialogTitle>编辑词条</DialogTitle>
              <DialogDescription>
                修改会更新词库 revision；已有个人学习进度会保留。
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-5 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="edit-word">单词</Label>
                <Input
                  id="edit-word"
                  value={editWord}
                  onChange={event => setEditWord(event.target.value)}
                  maxLength={80}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-phonetic">音标</Label>
                <Input
                  id="edit-phonetic"
                  value={editPhonetic}
                  onChange={event => setEditPhonetic(event.target.value)}
                  maxLength={120}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="edit-meaning">释义</Label>
                <Textarea
                  id="edit-meaning"
                  value={editMeaning}
                  onChange={event => setEditMeaning(event.target.value)}
                  maxLength={1000}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-pos">词性</Label>
                <Input
                  id="edit-pos"
                  value={editPartOfSpeech}
                  onChange={event => setEditPartOfSpeech(event.target.value)}
                  maxLength={80}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-example">例句</Label>
                <Input
                  id="edit-example"
                  value={editExample}
                  onChange={event => setEditExample(event.target.value)}
                  maxLength={1000}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="edit-example-translation">例句翻译</Label>
                <Input
                  id="edit-example-translation"
                  value={editExampleTranslation}
                  onChange={event =>
                    setEditExampleTranslation(event.target.value)
                  }
                  maxLength={1000}
                />
              </div>
            </div>
            <DialogFooter className="sm:justify-between">
              <Button
                type="button"
                variant="destructive"
                onClick={deleteEntry}
                disabled={editBusy}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                删除
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditingEntry(null)}
                >
                  取消
                </Button>
                <Button type="submit" disabled={editBusy}>
                  {editBusy ? '保存中…' : '保存'}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
