import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Serves the standalone ingestion prompt for the copy button in the paste
// tab. The files live in public/docs (kept in sync with
// contracts/problem-ingestion-v1 by a drift test) but public assets cannot be
// fetched directly: the auth middleware rewrites non-excluded paths to locale
// page routes, so the content is served through this route instead.
const PROMPT_FILES = {
  zh: 'problem-ingestion-prompt.zh-CN.md',
  en: 'problem-ingestion-prompt.en.md',
} as const;

export async function GET(req: Request) {
  const locale = new URL(req.url).searchParams.get('locale') ?? 'zh-CN';
  const file = locale.toLowerCase().startsWith('zh')
    ? PROMPT_FILES.zh
    : PROMPT_FILES.en;
  try {
    const content = await readFile(
      path.join(process.cwd(), 'public', 'docs', file),
      'utf8'
    );
    return new NextResponse(content, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json(
      { error: 'Import prompt is not available' },
      { status: 404 }
    );
  }
}
