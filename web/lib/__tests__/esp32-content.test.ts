import {
  buildEsp32AssetManifest,
  htmlToEsp32Content,
  latexToEsp32Text,
} from '../esp32-content';

describe('latexToEsp32Text', () => {
  it('keeps simple expressions readable', () => {
    expect(latexToEsp32Text('x^2 + 2x + 1')).toBe('x^2 + 2x + 1');
  });

  it('converts common math commands to plain device text', () => {
    expect(latexToEsp32Text('\\frac{a+1}{\\sqrt{x}} \\le \\pi')).toBe(
      '(a+1)/(sqrt(x)) <= pi'
    );
  });
});

describe('htmlToEsp32Content', () => {
  it('extracts TipTap math placeholders into text fallback', () => {
    const result = htmlToEsp32Content(
      '<p>求 <span data-type="inline-math" data-latex="x^2 \\ge 4"></span> 的解。</p>'
    );

    expect(result.text).toBe('求 x^2 >= 4 的解。');
    expect(result.has_math).toBe(true);
    expect(result.blocks).toContainEqual({
      type: 'inline_math',
      latex: 'x^2 \\ge 4',
      fallback_text: 'x^2 >= 4',
    });
  });

  it('preserves paragraphs and list boundaries', () => {
    const result = htmlToEsp32Content('<p>第一行</p><ul><li>A</li><li>B</li></ul>');

    expect(result.text).toBe('第一行\n- A\n- B');
  });

  it('marks embedded images in text and blocks', () => {
    const result = htmlToEsp32Content(
      '<p>见图 <img src="/api/files/a.png" alt="函数图像" /></p>'
    );

    expect(result.text).toBe('见图 [图片: 函数图像]');
    expect(result.blocks).toContainEqual({
      type: 'image',
      alt: '函数图像',
      src: '/api/files/a.png',
    });
  });
});

describe('buildEsp32AssetManifest', () => {
  it('creates authenticated ESP32 asset URLs', () => {
    const manifest = buildEsp32AssetManifest(
      [{ path: 'user/abc/problems/p1/problem/scan.png' }],
      'problem',
      'https://wqn.example.com'
    );

    expect(manifest).toEqual([
      {
        role: 'problem',
        kind: 'image',
        mime_type: 'image/png',
        path: 'user/abc/problems/p1/problem/scan.png',
        url: 'https://wqn.example.com/api/esp32/assets?path=user%2Fabc%2Fproblems%2Fp1%2Fproblem%2Fscan.png',
        name: 'scan.png',
        width: 0,
        height: 0,
        bytes: 0,
        sha256: '',
      },
    ]);
  });
});
