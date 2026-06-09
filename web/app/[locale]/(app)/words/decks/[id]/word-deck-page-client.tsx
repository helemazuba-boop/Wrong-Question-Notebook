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
import { ArrowLeft, FileUp, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

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

const MAX_IMPORT_ENTRIES = 4000;

function parseCsvLine(line: string): string[] {
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
    if (char === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function normalizeImportEntry(value: unknown, index: number): ImportEntry | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const word = String(row.word || '').trim();
  const meaning = String(row.meaning || '').trim();
  if (!word || !meaning) return null;
  const tagsValue = row.tags;
  const tags = Array.isArray(tagsValue)
    ? tagsValue.map(tag => String(tag).trim()).filter(Boolean)
    : typeof tagsValue === 'string'
      ? tagsValue.split(/[;|]/).map(tag => tag.trim()).filter(Boolean)
      : undefined;
  return {
    word,
    meaning,
    phonetic: typeof row.phonetic === 'string' ? row.phonetic.trim() || null : null,
    example: typeof row.example === 'string' ? row.example.trim() || null : null,
    example_translation:
      typeof row.example_translation === 'string'
        ? row.example_translation.trim() || null
        : null,
    part_of_speech:
      typeof row.part_of_speech === 'string'
        ? row.part_of_speech.trim() || null
        : null,
    tags,
    sort_index: typeof row.sort_index === 'number' ? row.sort_index : index,
  };
}

function parseImportText(text: string): ImportEntry[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((row, index) => normalizeImportEntry(row, index))
      .filter(Boolean) as ImportEntry[];
  }

  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]).map(cell => cell.trim());
  const hasHeader = header.includes('word') && header.includes('meaning');
  const columns = hasHeader
    ? header
    : ['word', 'phonetic', 'meaning', 'example', 'example_translation', 'part_of_speech', 'tags'];
  const dataLines = hasHeader ? lines.slice(1) : lines;
  return dataLines
    .map((line, index) => {
      const cells = parseCsvLine(line);
      const row = Object.fromEntries(
        columns.map((column, columnIndex) => [column, cells[columnIndex] || ''])
      );
      return normalizeImportEntry(row, index);
    })
    .filter(Boolean) as ImportEntry[];
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
  const [previewEntries, setPreviewEntries] = useState<ImportEntry[]>([]);
  const [lastImportedCount, setLastImportedCount] = useState<number | null>(null);
  const canImport = !deck.is_system;

  const visibleEntries = useMemo(() => initialEntries.slice(0, 200), [initialEntries]);

  function previewImport(value: string) {
    setText(value);
    try {
      const parsed = parseImportText(value);
      setPreviewEntries(parsed.slice(0, 8));
    } catch {
      setPreviewEntries([]);
    }
  }

  async function handleFile(file: File | null) {
    if (!file) return;
    previewImport(await file.text());
  }

  async function submitImport() {
    if (!canImport) {
      toast.error('系统词库不能直接导入');
      return;
    }
    let entries: ImportEntry[];
    try {
      entries = parseImportText(text);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入内容格式错误');
      return;
    }
    if (entries.length === 0) {
      toast.error('没有可导入的词条');
      return;
    }
    if (entries.length > MAX_IMPORT_ENTRIES) {
      toast.error(`单次最多导入 ${MAX_IMPORT_ENTRIES} 条`);
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`/api/words/decks/${deck.id}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
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
            {deck.revision} · {formatDate(deck.updated_at)}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleEntries.map(entry => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-medium">{entry.word}</TableCell>
                      <TableCell>{entry.phonetic || '--'}</TableCell>
                      <TableCell className="max-w-md truncate">{entry.meaning}</TableCell>
                      <TableCell>{entry.part_of_speech || '--'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
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
                <div className="space-y-2">
                  <Label htmlFor="word-import-file">CSV / JSON 文件</Label>
                  <Input
                    id="word-import-file"
                    type="file"
                    accept=".csv,.json,.txt,application/json,text/csv,text/plain"
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
                    placeholder="word,phonetic,meaning,example,example_translation,part_of_speech,tags"
                  />
                </div>
                <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                  单次最多 {MAX_IMPORT_ENTRIES} 条。JSON 支持对象数组；CSV 首行可写字段名。
                </div>
                {previewEntries.length > 0 ? (
                  <>
                    <Separator />
                    <div className="space-y-2">
                      <p className="text-sm font-medium">预览 {previewEntries.length} 条</p>
                      <div className="space-y-1 text-xs text-muted-foreground">
                        {previewEntries.map((entry, index) => (
                          <div key={`${entry.word}-${index}`} className="truncate">
                            {entry.word} · {entry.meaning}
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
