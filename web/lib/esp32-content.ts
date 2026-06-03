type AssetRole = 'problem' | 'solution';

export interface Esp32ContentBlock {
  type: 'paragraph' | 'inline_math' | 'block_math' | 'image';
  text?: string;
  latex?: string;
  fallback_text?: string;
  alt?: string;
  src?: string;
}

export interface Esp32AssetManifestItem {
  role: AssetRole;
  kind: 'image' | 'pdf' | 'unknown';
  mime_type: string;
  path: string;
  url: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

interface Esp32ContentResult {
  text: string;
  blocks: Esp32ContentBlock[];
  has_math: boolean;
}

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'div',
  'figure',
  'figcaption',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'li',
  'ol',
  'p',
  'section',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
]);

function decodeHtmlEntities(input: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };

  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const value = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    if (entity.startsWith('#')) {
      const value = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return named[entity] ?? match;
  });
}

function parseTag(raw: string): {
  closing: boolean;
  name: string;
  attrs: Record<string, string>;
} | null {
  const match = raw.match(/^<\s*(\/)?\s*([a-zA-Z0-9-]+)/);
  if (!match) return null;

  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrRegex.exec(raw)) !== null) {
    const key = attrMatch[1].toLowerCase();
    if (key === match[2].toLowerCase()) continue;
    attrs[key] = decodeHtmlEntities(attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '');
  }

  return {
    closing: Boolean(match[1]),
    name: match[2].toLowerCase(),
    attrs,
  };
}

function readBraced(input: string, start: number): { value: string; end: number } | null {
  if (input[start] !== '{') return null;

  let depth = 0;
  for (let i = start; i < input.length; i += 1) {
    const char = input[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return { value: input.slice(start + 1, i), end: i + 1 };
      }
    }
  }
  return null;
}

function replaceCommandWithArgs(
  input: string,
  command: string,
  argCount: 1 | 2,
  format: (...args: string[]) => string
): string {
  const needle = `\\${command}`;
  let output = '';
  let cursor = 0;

  while (cursor < input.length) {
    const found = input.indexOf(needle, cursor);
    if (found < 0) {
      output += input.slice(cursor);
      break;
    }

    output += input.slice(cursor, found);
    let argCursor = found + needle.length;
    while (input[argCursor] === ' ') argCursor += 1;

    if (command === 'sqrt' && input[argCursor] === '[') {
      const close = input.indexOf(']', argCursor + 1);
      if (close > argCursor) argCursor = close + 1;
      while (input[argCursor] === ' ') argCursor += 1;
    }

    const args: string[] = [];
    let ok = true;
    for (let i = 0; i < argCount; i += 1) {
      const braced = readBraced(input, argCursor);
      if (!braced) {
        ok = false;
        break;
      }
      args.push(braced.value);
      argCursor = braced.end;
      if (i < argCount - 1) {
        while (input[argCursor] === ' ') argCursor += 1;
      }
    }

    if (!ok) {
      output += needle;
      cursor = found + needle.length;
      continue;
    }

    output += format(...args.map(latexToEsp32Text));
    cursor = argCursor;
  }

  return output;
}

export function latexToEsp32Text(latex: string): string {
  let text = decodeHtmlEntities(latex).trim();

  for (let i = 0; i < 6; i += 1) {
    const before = text;
    text = replaceCommandWithArgs(text, 'frac', 2, (a, b) => `(${a})/(${b})`);
    text = replaceCommandWithArgs(text, 'dfrac', 2, (a, b) => `(${a})/(${b})`);
    text = replaceCommandWithArgs(text, 'tfrac', 2, (a, b) => `(${a})/(${b})`);
    text = replaceCommandWithArgs(text, 'sqrt', 1, a => `sqrt(${a})`);
    text = replaceCommandWithArgs(text, 'text', 1, a => a);
    text = replaceCommandWithArgs(text, 'mathrm', 1, a => a);
    if (text === before) break;
  }

  const commandMap: Record<string, string> = {
    '\\\\': '; ',
    '\\approx': '~',
    '\\cdot': '*',
    '\\cos': 'cos',
    '\\div': '/',
    '\\ge': '>=',
    '\\geq': '>=',
    '\\infty': 'infty',
    '\\le': '<=',
    '\\leq': '<=',
    '\\left': '',
    '\\ln': 'ln',
    '\\log': 'log',
    '\\ne': '!=',
    '\\neq': '!=',
    '\\pi': 'pi',
    '\\pm': '+/-',
    '\\right': '',
    '\\sin': 'sin',
    '\\tan': 'tan',
    '\\theta': 'theta',
    '\\times': '*',
  };

  text = text.replace(/\\begin\{[^}]+\}/g, ' ');
  text = text.replace(/\\end\{[^}]+\}/g, ' ');
  text = text.replace(/\^\{([^{}]+)\}/g, '^$1');
  text = text.replace(/_\{([^{}]+)\}/g, '_$1');

  for (const [command, replacement] of Object.entries(commandMap)) {
    text = text.split(command).join(replacement);
  }

  text = text.replace(/\\([a-zA-Z]+)/g, '$1');
  text = text.replace(/\\([{}_^])/g, '$1');
  for (let i = 0; i < 4; i += 1) {
    const before = text;
    text = text.replace(/\{([^{}]*)\}/g, '$1');
    if (text === before) break;
  }

  return text.replace(/[ \t\r\n]+/g, ' ').trim();
}

function normalizePlainText(input: string): string {
  return input
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function addTextBlock(blocks: Esp32ContentBlock[], text: string) {
  const normalized = normalizePlainText(text);
  if (!normalized) return;
  blocks.push({ type: 'paragraph', text: normalized });
}

export function htmlToEsp32Content(html: string | null | undefined): Esp32ContentResult {
  if (!html) {
    return { text: '', blocks: [], has_math: false };
  }

  let output = '';
  let paragraphBuffer = '';
  let hasMath = false;
  const blocks: Esp32ContentBlock[] = [];
  const tagRegex = /<[^>]*>/g;
  let cursor = 0;

  const appendText = (value: string) => {
    const decoded = decodeHtmlEntities(value).replace(/\s+/g, ' ');
    if (!decoded.trim()) return;
    output += decoded;
    paragraphBuffer += decoded;
  };

  const appendBreak = () => {
    addTextBlock(blocks, paragraphBuffer);
    paragraphBuffer = '';
    if (!output.endsWith('\n')) output += '\n';
  };

  const appendInline = (value: string) => {
    if (!value) return;
    output += value;
    paragraphBuffer += value;
  };

  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(html)) !== null) {
    appendText(html.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    const tag = parseTag(match[0]);
    if (!tag) continue;

    const isMath =
      !tag.closing &&
      (tag.attrs['data-type'] === 'inline-math' || tag.attrs['data-type'] === 'block-math') &&
      Boolean(tag.attrs['data-latex']);
    if (isMath) {
      const latex = tag.attrs['data-latex'];
      const fallback = latexToEsp32Text(latex);
      hasMath = true;
      if (tag.attrs['data-type'] === 'block-math') {
        appendBreak();
        appendInline(fallback);
        blocks.push({ type: 'block_math', latex, fallback_text: fallback });
        appendBreak();
      } else {
        appendInline(fallback);
        blocks.push({ type: 'inline_math', latex, fallback_text: fallback });
      }
      continue;
    }

    if (!tag.closing && tag.name === 'img') {
      const alt = tag.attrs.alt || '';
      const marker = alt ? `[图片: ${alt}]` : '[图片]';
      appendInline(marker);
      blocks.push({ type: 'image', alt, src: tag.attrs.src || '' });
      continue;
    }

    if (tag.name === 'br') {
      appendBreak();
      continue;
    }

    if (tag.name === 'li' && !tag.closing) {
      appendBreak();
      appendInline('- ');
      continue;
    }

    if (BLOCK_TAGS.has(tag.name)) {
      appendBreak();
    }
  }

  appendText(html.slice(cursor));
  addTextBlock(blocks, paragraphBuffer);

  return {
    text: normalizePlainText(output),
    blocks,
    has_math: hasMath,
  };
}

function getPathFromAsset(asset: unknown): string {
  if (!asset || typeof asset !== 'object') return '';
  const path = (asset as { path?: unknown }).path;
  return typeof path === 'string' ? path : '';
}

function getStringFromAsset(asset: unknown, key: string): string {
  if (!asset || typeof asset !== 'object') return '';
  const value = (asset as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function getNumberFromAsset(asset: unknown, key: string): number {
  if (!asset || typeof asset !== 'object') return 0;
  const value = (asset as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function extensionOf(path: string): string {
  const clean = path.split('?')[0].split('#')[0];
  const dot = clean.lastIndexOf('.');
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : '';
}

function inferKind(path: string, explicitKind: string): 'image' | 'pdf' | 'unknown' {
  if (explicitKind === 'image' || explicitKind === 'pdf') return explicitKind;
  const ext = extensionOf(path);
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  return 'unknown';
}

function inferMimeType(path: string, explicitMime: string): string {
  if (explicitMime) return explicitMime;
  switch (extensionOf(path)) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

function basename(path: string): string {
  const clean = path.split('?')[0].split('#')[0];
  return decodeURIComponent(clean.slice(clean.lastIndexOf('/') + 1));
}

export function getEsp32RequestOrigin(req: Request): string {
  if (process.env.SITE_URL) {
    return process.env.SITE_URL.replace(/\/+$/, '');
  }

  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || req.headers.get('host');
  if (host) {
    return `${forwardedProto || new URL(req.url).protocol.replace(':', '')}://${host}`;
  }
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

export function buildEsp32AssetManifest(
  assets: unknown,
  role: AssetRole,
  origin: string
): Esp32AssetManifestItem[] {
  if (!Array.isArray(assets)) return [];

  return assets
    .map(asset => {
      const path = getPathFromAsset(asset);
      if (!path) return null;
      const kind = inferKind(path, getStringFromAsset(asset, 'kind'));
      return {
        role,
        kind,
        mime_type: inferMimeType(path, getStringFromAsset(asset, 'mime_type')),
        path,
        url: `${origin}/api/esp32/assets?path=${encodeURIComponent(path)}`,
        name: getStringFromAsset(asset, 'name') || basename(path),
        width: getNumberFromAsset(asset, 'width'),
        height: getNumberFromAsset(asset, 'height'),
        bytes: getNumberFromAsset(asset, 'bytes'),
        sha256: getStringFromAsset(asset, 'sha256'),
      };
    })
    .filter((asset): asset is Esp32AssetManifestItem => asset !== null);
}

export function serializeEsp32ProblemContent(
  content: string | null | undefined,
  solutionText: string | null | undefined,
  assets: unknown,
  solutionAssets: unknown,
  origin: string
) {
  const contentResult = htmlToEsp32Content(content);
  const solutionResult = htmlToEsp32Content(solutionText);
  return {
    content_format: 'esp32_text_v1',
    content_text: contentResult.text,
    content_blocks: contentResult.blocks,
    solution_text: solutionResult.text,
    solution_blocks: solutionResult.blocks,
    has_math: contentResult.has_math || solutionResult.has_math,
    assets: buildEsp32AssetManifest(assets, 'problem', origin),
    solution_assets: buildEsp32AssetManifest(solutionAssets, 'solution', origin),
  };
}
