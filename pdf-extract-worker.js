// PDF 텍스트 추출 전용 자식 프로세스 (pdf-index.js 가 fork 로 실행)
// - 입력: 부모가 보낸 { file } (uploads 안의 PDF 절대경로)  → 읽기 전용으로만 엽니다.
// - 출력: { status, pages:[{n,text}], pageCount, error }
// - 이 프로세스는 파일을 쓰거나 지우지 않습니다. 결과 저장은 부모(pdf-index.js)만 합니다.
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
// 한글 CID 폰트(Adobe-Korea1 등) 해석에 필요한 cMap / 표준 폰트 데이터 경로
const CMAP_URL = pathToFileURL(path.join(pdfjsRoot, 'cmaps') + path.sep).href;
const FONT_URL = pathToFileURL(path.join(pdfjsRoot, 'standard_fonts') + path.sep).href;
const PDFJS_URL = pathToFileURL(path.join(pdfjsRoot, 'legacy', 'build', 'pdf.mjs')).href;

const MAX_PAGES = Number(process.env.PDF_MAX_PAGES || 1000);
const MAX_TEXT_CHARS = 2000000; // 파일당 저장 텍스트 상한

function pageText(items) {
  let out = '';
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    out += it.str;
    out += it.hasEOL ? '\n' : (it.str && !/\s$/.test(it.str) ? ' ' : '');
  }
  return out.normalize('NFC').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

async function extract(file) {
  const pdfjs = await import(PDFJS_URL);
  const data = new Uint8Array(fs.readFileSync(file)); // 읽기 전용
  const task = pdfjs.getDocument({
    data,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: FONT_URL,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') return { status: 'encrypted', pages: [], pageCount: 0 };
    return { status: 'error', pages: [], pageCount: 0, error: String((e && e.message) || e).slice(0, 200) };
  }
  const pageCount = doc.numPages;
  if (pageCount > MAX_PAGES) { await doc.destroy(); return { status: 'skipped', pages: [], pageCount, error: `페이지 수 ${pageCount} > ${MAX_PAGES}` }; }
  const pages = []; let total = 0, visible = 0, bad = 0;
  for (let n = 1; n <= pageCount; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    let text = pageText(tc.items);
    page.cleanup();
    if (total + text.length > MAX_TEXT_CHARS) text = text.slice(0, Math.max(0, MAX_TEXT_CHARS - total));
    total += text.length;
    for (const ch of text) {
      if (/\s/.test(ch)) continue;
      visible++;
      const c = ch.codePointAt(0);
      if (c === 0xfffd || (c >= 0xe000 && c <= 0xf8ff) || c < 0x20) bad++;
    }
    if (text) pages.push({ n, text });
  }
  await doc.destroy();
  // 글자가 거의 없으면 이미지(스캔) PDF로 판단 → OCR 없이는 본문 검색 불가
  if (visible < 20) return { status: 'no_text', pages: [], pageCount };
  // 폰트에 유니코드 정보가 없어 글자가 깨진 PDF
  if (bad / visible > 0.3) return { status: 'garbled', pages: [], pageCount };
  return { status: 'ok', pages, pageCount };
}

process.on('message', async (msg) => {
  let result;
  try { result = await extract(msg.file); }
  catch (e) { result = { status: 'error', pages: [], pageCount: 0, error: String((e && e.message) || e).slice(0, 200) }; }
  result.maxRssKb = process.resourceUsage().maxRSS; // 이 추출 프로세스의 최대 메모리(KB)
  process.send(result, () => process.exit(0));
});
