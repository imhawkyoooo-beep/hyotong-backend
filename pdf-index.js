// PDF 본문 검색 색인 모듈
//
// 안전 원칙
//  - uploads 폴더의 PDF는 "읽기"만 합니다. (이동·삭제·이름 변경 코드 없음)
//  - data.json / auth.json / users.json / audit.json 에는 쓰지 않습니다. (파일 목록은 호출하는 쪽이 넘겨줌)
//  - 이 모듈이 쓰는 곳은 indexDir(기본: DATA_DIR/search-index) 한 곳뿐이며, safeIndexPath()가 경로를 검사합니다.
//  - 추출은 별도 자식 프로세스(메모리 상한·시간 제한)에서 한 번에 한 파일씩 처리합니다.
//  - 서버는 "새로 업로드된 PDF"만 자동 색인합니다. 기존 PDF는 reindex.js(관리자 수동 배치)로만 색인합니다.
//  - 추출 프로세스가 동시에 2개 뜨지 않도록 서버와 reindex.js 가 서로 양보합니다(512MB 보호).
//      · reindex.js 실행 중(reindex.lock)에는 서버가 업로드 PDF 색인을 미루고 대기열에 보관합니다.
//      · 서버가 추출 중(server-indexing.json)이면 reindex.js 는 그 파일이 끝날 때까지 기다린 뒤 시작합니다.
//      · 두 표식 파일 모두 "먼저 쓰고, 그다음 상대 표식을 확인"하므로 어느 순서로 겹쳐도 한쪽은 반드시 양보합니다.
//      · 표식은 10초마다 갱신되며, 프로세스가 죽었거나 45초 넘게 갱신되지 않으면 무시합니다.
//
// 색인 키: 업로드 시 만들어지는 저장 파일명(예: 1730000000000_ab12cd34_계약서.pdf)의 sha1.
//          분류를 옮겨도(/api/files/move) 파일명은 그대로이므로 색인을 다시 만들 필요가 없습니다.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');

const INDEX_VERSION = 2;
const WORKER = path.join(__dirname, 'pdf-extract-worker.js');
const DONE_STATUSES = new Set(['ok', 'no_text', 'garbled', 'encrypted', 'skipped', 'error']);
const LOCK = 'reindex.lock';
const MARK = 'server-indexing.json';

// 프로세스가 살아 있는지 (권한 문제로 확인할 수 없으면 살아 있다고 봄)
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function create(opts) {
  const uploadDir = path.resolve(opts.uploadDir);
  const indexDir = path.resolve(opts.indexDir);
  const env = process.env;
  const maxBytes = Number(opts.maxBytes || env.PDF_INDEX_MAX_BYTES || 50 * 1024 * 1024);
  const timeoutMs = Number(opts.timeoutMs || env.PDF_INDEX_TIMEOUT_MS || 120000);
  const workerMemMb = Number(opts.workerMemMb || env.PDF_INDEX_WORKER_MB || 256);
  const cacheMaxBytes = Number(opts.cacheMaxBytes || env.PDF_INDEX_CACHE_MB || 48) * 1024 * 1024;
  const deferMs = Number(opts.deferMs || env.PDF_INDEX_DEFER_MS || 10000);         // 배치 중 재확인 간격
  const freshMs = Number(opts.freshMs || env.PDF_INDEX_LOCK_FRESH_MS || 45000);    // 표식 유효 시간
  const heartbeatMs = Math.max(1000, Math.min(10000, Math.floor(freshMs / 3)));   // 표식 갱신 간격
  const log = opts.log || ((...a) => console.log('[pdf-index]', ...a));
  if (indexDir === uploadDir || indexDir.startsWith(uploadDir + path.sep)) throw new Error('indexDir must be outside uploadDir');
  fs.mkdirSync(indexDir, { recursive: true });

  const queue = []; const queued = new Set(); let running = false; let current = null;
  let deferredSince = null; let retryTimer = null;
  const cache = new Map(); let cacheBytes = 0; // key -> { mtimeMs, bytes, data }
  const stats = { workerPeakRssMb: 0, extracted: 0 };

  const isPdf = (rel) => /\.pdf$/i.test(String(rel || ''));
  const storedName = (rel) => path.basename(String(rel || ''));
  const keyOf = (rel) => crypto.createHash('sha1').update(storedName(rel)).digest('hex');
  function resolveUpload(rel) { const f = path.resolve(uploadDir, String(rel || '')); return f.startsWith(uploadDir + path.sep) ? f : null; }

  // 쓰기 허용 경로: indexDir 바로 아래 <sha1>.json, reindex.lock, server-indexing.json 만
  function safeIndexPath(name) {
    if (!/^([0-9a-f]{40}\.json|reindex\.lock|server-indexing\.json)$/.test(name)) throw new Error('refusing to write: ' + name);
    const abs = path.join(indexDir, name);
    if (path.dirname(abs) !== indexDir) throw new Error('refusing to write outside search-index');
    return abs;
  }
  function writeIndexFile(key, obj) {
    const abs = safeIndexPath(key + '.json');
    const tmp = abs + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, abs);
    dropCache(key);
  }
  function dropCache(key) { const h = cache.get(key); if (h) { cacheBytes -= h.bytes; cache.delete(key); } }
  // 캐시된 색인에 쪽 사이 검색용 본문이 추가되면 그만큼 캐시 사용량에 더함 (상한 초과 시 오래된 것부터 정리)
  function growCache(key, data) {
    const h = cache.get(key); if (!h || h.data !== data || !data._coreBytes || data._coreCounted) return;
    data._coreCounted = true; h.bytes += data._coreBytes; cacheBytes += data._coreBytes;
    while (cacheBytes > cacheMaxBytes && cache.size > 1) { const k = cache.keys().next().value; if (k === key) break; dropCache(k); }
    if (cacheBytes > cacheMaxBytes) dropCache(key);
  }

  function readIndex(rel) {
    const key = keyOf(rel); const file = path.join(indexDir, key + '.json');
    let st; try { st = fs.statSync(file); } catch { dropCache(key); return null; }
    const hit = cache.get(key);
    if (hit && hit.mtimeMs === st.mtimeMs) { cache.delete(key); cache.set(key, hit); return hit.data; }
    let data; try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    // 공백 제거본은 저장하지 않고 읽을 때 계산 (색인 용량 절반)
    for (const p of data.pages || []) p.flat = p.text.replace(/\s+/g, '').toLowerCase();
    dropCache(key);
    const bytes = st.size * 2 + 512; // 메모리 사용량 근사치
    if (bytes <= cacheMaxBytes) {
      cache.set(key, { mtimeMs: st.mtimeMs, bytes, data }); cacheBytes += bytes;
      while (cacheBytes > cacheMaxBytes && cache.size) dropCache(cache.keys().next().value);
    }
    return data;
  }

  function fileState(rel) {
    const d = readIndex(rel);
    const f = resolveUpload(rel); let st = null;
    try { st = f ? fs.statSync(f) : null; } catch { st = null; }
    if (!st || !st.isFile()) return { state: 'missing', index: d };
    if (d && d.version === INDEX_VERSION && d.size === st.size && d.mtimeMs === Math.round(st.mtimeMs) && DONE_STATUSES.has(d.status)) return { state: d.status, index: d, stat: st };
    return { state: 'pending', index: d, stat: st };
  }

  function runWorker(file) {
    return new Promise((resolve) => {
      let done = false;
      const child = fork(WORKER, [], { execArgv: [`--max-old-space-size=${workerMemMb}`], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch {} resolve(r); };
      const timer = setTimeout(() => finish({ status: 'error', pages: [], error: '시간 초과' }), timeoutMs);
      child.on('message', (m) => finish(m));
      child.on('error', (e) => finish({ status: 'error', pages: [], error: e.message }));
      child.on('exit', (code) => finish({ status: 'error', pages: [], error: '추출 프로세스 종료(code ' + code + ', 메모리 초과 가능)' }));
      child.send({ file });
    });
  }

  // 파일 1개 색인. 반환: 최종 상태 문자열
  async function indexOne(rel, { force = false } = {}) {
    if (!isPdf(rel)) return 'not_pdf';
    const fsx = fileState(rel);
    if (fsx.state === 'missing') return 'missing'; // 디스크에 없음 → 색인 파일을 만들지 않음
    if (!force && fsx.state !== 'pending') return 'up_to_date';
    const st = fsx.stat; const file = resolveUpload(rel);
    let r;
    if (st.size > maxBytes) r = { status: 'skipped', pages: [], error: `파일 크기 ${(st.size / 1048576).toFixed(1)}MB > ${(maxBytes / 1048576).toFixed(0)}MB` };
    else r = await runWorker(file);
    if (r.maxRssKb) stats.workerPeakRssMb = Math.max(stats.workerPeakRssMb, Math.round(r.maxRssKb / 1024));
    stats.extracted++;
    const pages = (r.pages || []).map((p) => ({ n: p.n, text: p.text }));
    writeIndexFile(keyOf(rel), { version: INDEX_VERSION, storedName: storedName(rel), size: st.size, mtimeMs: Math.round(st.mtimeMs), indexedAt: new Date().toISOString(), status: r.status, pageCount: r.pageCount || 0, error: r.error || null, pages });
    return r.status;
  }

  // ---- 서버 ↔ reindex.js 양보용 표식 ----
  // 표식 파일 정보: { pid, ageMs } 또는 null(없음/읽기 실패)
  function markInfo(name) {
    const abs = path.join(indexDir, name);
    let st; try { st = fs.statSync(abs); } catch { return null; }
    let pid = 0; try { pid = Number(JSON.parse(fs.readFileSync(abs, 'utf8')).pid) || 0; } catch {}
    return { pid, ageMs: Date.now() - st.mtimeMs };
  }
  // 살아 있는 표식: 다른 프로세스가 썼고, (그 프로세스가 살아 있거나 최근에 갱신됨)
  function markActive(name) {
    const i = markInfo(name);
    if (!i || i.pid === process.pid) return false;
    return pidAlive(i.pid) || i.ageMs < freshMs;
  }
  function touchMark(name) { try { const now = new Date(); fs.utimesSync(safeIndexPath(name), now, now); } catch {} }
  function startHeartbeat(name) { const t = setInterval(() => touchMark(name), heartbeatMs); t.unref(); return t; }
  const batchActive = () => markActive(LOCK);   // reindex.js 가 실행 중인가
  const serverBusy = () => markActive(MARK);    // 서버가 업로드 PDF 를 추출 중인가

  // 서버용: 새 업로드 PDF 1건을 대기열에 넣음 (응답을 보낸 뒤 호출)
  function enqueue(rel) {
    try {
      if (!isPdf(rel)) return false;
      const name = storedName(rel);
      if (queued.has(name)) return false;
      queued.add(name); queue.push(String(rel));
      setImmediate(pump);
      return true;
    } catch (e) { log('enqueue 실패', e.message); return false; }
  }
  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; pump(); }, deferMs);
    retryTimer.unref();
  }
  async function pump() {
    if (running) return; running = true;
    try {
      while (queue.length) {
        const rel = queue[0];
        // 0) 배치가 이미 실행 중이면 표식도 쓰지 않고 바로 미룸
        // 1) 아니면 서버 표식을 먼저 쓰고 2) 배치 잠금을 다시 확인 → 그 사이 배치가 시작됐으면 표식을 지우고 미룸
        let marked = false;
        const busy = batchActive();
        if (!busy) {
          try { fs.writeFileSync(safeIndexPath(MARK), JSON.stringify({ pid: process.pid, file: storedName(rel), at: new Date().toISOString() })); marked = true; }
          catch (e) { log('서버 색인 표식 쓰기 실패', e.message); }
        }
        if (busy || batchActive()) {
          if (marked) fs.rmSync(safeIndexPath(MARK), { force: true });
          if (!deferredSince) { deferredSince = Date.now(); log(`reindex.js 실행 중 → 업로드 PDF ${queue.length}건 색인을 미룹니다 (${Math.round(deferMs / 1000)}초마다 재확인)`); }
          scheduleRetry();
          return;
        }
        if (deferredSince) { log(`배치 종료 확인 → 미뤘던 업로드 PDF 색인을 시작합니다 (대기 ${Math.round((Date.now() - deferredSince) / 1000)}초)`); deferredSince = null; }
        queue.shift(); current = rel;
        const hb = marked ? startHeartbeat(MARK) : null;
        try { const s = await indexOne(rel); log(`${s}  ${storedName(rel)}`); } catch (e) { log('색인 실패', storedName(rel), e.message); }
        finally { if (hb) clearInterval(hb); if (marked) { try { fs.rmSync(safeIndexPath(MARK), { force: true }); } catch {} } }
        queued.delete(storedName(rel)); current = null;
      }
    } finally { running = false; }
  }

  const norm = (s) => String(s || '').normalize('NFC').toLowerCase();
  function snippet(text, term) {
    const low = norm(text); const i = low.indexOf(term);
    if (i < 0) return '';
    const s = Math.max(0, i - 40), e = Math.min(text.length, i + term.length + 60);
    return (s > 0 ? '…' : '') + text.slice(s, e).replace(/\s+/g, ' ') + (e < text.length ? '…' : '');
  }

  // ---- 쪽 사이에 나뉜 문구 검색 (같은 쪽 검색에서 결과가 없던 문서에만 적용) ----
  // 쪽 경계 판단에는 각 쪽 "본문"(머리말·꼬리말·쪽 번호 줄 제외)의 처음/끝 EDGE 글자만 필요하므로 그것만 계산·보관합니다.
  // (색인 파일에는 저장하지 않음. 문맥 표시용 본문은 결과가 난 쪽만 그때 계산)
  const EDGE = 110; // 검색어 최대 100자 + 여유
  const PAGE_NO_LINE = /^(?:[-–—\s]*\d{1,4}[-–—\s]*|\d{1,4}\s*\/\s*\d{1,4}|page\s*\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?|[-–—\s]*\d{1,4}\s*쪽[-–—\s]*)$/i;
  const shape = (l) => (l || '').replace(/\d+/g, '#').toLowerCase();
  const pageLines = (p) => p.text.split('\n').map((l) => l.trim()).filter(Boolean);
  function coreLines(ls, hf) {
    let a = 0, b = ls.length;
    while (a < b && (PAGE_NO_LINE.test(ls[a]) || (a === 0 && hf.head && shape(ls[a]) === hf.head))) a++;
    while (b > a && (PAGE_NO_LINE.test(ls[b - 1]) || (b === ls.length && hf.foot && shape(ls[b - 1]) === hf.foot))) b--;
    return ls.slice(a, b);
  }
  function pageEdges(d) {
    if (d._edges) return d._edges;
    const lines = d.pages.map(pageLines);
    // 쪽의 60% 이상에서 같은 모양(숫자 무시)으로 반복되는 첫 줄/끝 줄 = 머리말/꼬리말 (3쪽 이상 문서만)
    const repeated = (pick) => {
      if (lines.length < 3) return null;
      const cnt = new Map(); for (const ls of lines) { const k = shape(pick(ls)); if (k) cnt.set(k, (cnt.get(k) || 0) + 1); }
      for (const [k, c] of cnt) if (c >= Math.ceil(lines.length * 0.6)) return k;
      return null;
    };
    const hf = { head: repeated((ls) => ls[0]), foot: repeated((ls) => ls[ls.length - 1]) };
    const edges = lines.map((ls) => { const f = norm(coreLines(ls, hf).join('')).replace(/\s+/g, ''); return { head: f.slice(0, EDGE), tail: f.slice(-EDGE) }; });
    d._edges = { hf, edges }; d._coreBytes = edges.length * EDGE * 4 + 64;
    return d._edges;
  }
  const coreText = (d, i) => coreLines(pageLines(d.pages[i]), pageEdges(d).hf).join('\n');
  const clip = (s) => s.replace(/\s+/g, ' ').trim();
  // 단어(공백 제거본) ft 가 i쪽 끝과 i+1쪽 처음에 걸쳐 있는지
  function spans(E, i, ft) { const k = ft.length - 1; return k > 0 && (E[i].tail.slice(-k) + E[i + 1].head.slice(0, k)).includes(ft); }
  function crossMatches(d, terms, flatTerms, max) {
    const n = d.pages ? d.pages.length : 0;
    if (n < 2 || max <= 0) return [];
    // 1) 검색어마다 어느 쪽에 있는지 확인(검색어에는 공백이 없으므로 공백 제거본 비교로 충분).
    //    어느 쪽에도 없으면 쪽 경계에 걸쳐 있는지 확인하고, 그것도 없으면 이 문서는 바로 제외
    let E = null; const spanAt = []; const inPage = [];
    for (let t = 0; t < terms.length; t++) {
      inPage[t] = d.pages.map((p) => p.flat.includes(flatTerms[t]));
      spanAt[t] = null;
      if (inPage[t].some(Boolean)) continue;
      E = E || pageEdges(d).edges;
      const at = []; for (let i = 0; i + 1 < n; i++) if (spans(E, i, flatTerms[t])) at.push(i);
      if (!at.length) return []; // 이 검색어는 문서 어디에도 없음 → 빠르게 종료
      spanAt[t] = at;
    }
    // 2) 2쪽 범위를 먼저, 없을 때만 3쪽 범위. 범위의 첫 쪽과 끝 쪽에 반드시 검색어(또는 걸친 부분)가 있어야 함
    const found = [];
    for (const w of [1, 2]) {
      for (let i = 0; i + w < n && found.length < max; i++) {
        const j = i + w; if (found.some((f) => i <= f.j && j >= f.i)) continue;
        const where = []; let ok = true;
        for (let t = 0; t < terms.length && ok; t++) {
          let hit = null;
          for (let p = i; p <= j && !hit; p++) if (inPage[t][p]) hit = { kind: 'page', p, t };
          if (!hit && spanAt[t]) for (const s of spanAt[t]) if (s >= i && s + 1 <= j) { hit = { kind: 'span', p: s, t }; break; }
          if (hit) where.push(hit); else ok = false;
        }
        if (!ok) continue;
        const ps = new Set(); for (const h of where) { ps.add(h.p); if (h.kind === 'span') ps.add(h.p + 1); }
        if (ps.size >= 2 && ps.has(i) && ps.has(j)) found.push({ i, j, where });
      }
      if (found.length) break;
    }
    return found.map((f) => ({ page: d.pages[f.i].n, pageEnd: d.pages[f.j].n, snippet: crossSnippet(d, f.where, terms) }));
  }
  function crossSnippet(d, where, terms) {
    const parts = []; const seen = new Set(); const txt = new Map();
    const core = (i) => { if (!txt.has(i)) txt.set(i, coreText(d, i)); return txt.get(i); };
    for (const w of where.slice().sort((a, b) => a.p - b.p)) {
      const key = w.kind + w.p; if (seen.has(key)) continue; seen.add(key);
      if (w.kind === 'span') parts.push('…' + clip(core(w.p)).slice(-45) + ' ⏐ ' + clip(core(w.p + 1)).slice(0, 45) + '…');
      else parts.push(snippet(core(w.p), terms[w.t]) || snippet(d.pages[w.p].text, terms[w.t]) || clip(core(w.p)).slice(0, 80));
    }
    return parts.join(' ⏐ ');
  }

  // files: 서버가 권한으로 걸러 준 data.json 의 files 목록 (읽기 전용으로 사용)
  //  1) 같은 쪽 검색(기존과 동일) → 2) 같은 쪽 결과가 없던 문서만 쪽 사이 검색. 쪽 사이 결과는 같은 쪽 결과 뒤에 붙음.
  function search(q, files, { limit = 50, perFile = 3, crossPage = true } = {}) {
    const terms = norm(q).split(/\s+/).filter(Boolean).slice(0, 8);
    const out = { results: [], scanned: 0, noText: 0, pending: 0, failed: 0, missing: 0 };
    if (!terms.length) return out;
    const flatTerms = terms.map((t) => t.replace(/\s+/g, ''));
    const cross = [];
    for (const m of files || []) {
      if (!m || !isPdf(m.path)) continue;
      const d = readIndex(m.path);
      if (!d || d.version !== INDEX_VERSION) { const f = resolveUpload(m.path); if (f && fs.existsSync(f)) out.pending++; else out.missing++; continue; }
      if (d.status === 'no_text') { out.noText++; continue; }
      if (d.status !== 'ok') { out.failed++; continue; }
      if (out.results.length >= limit) { out.scanned++; continue; }
      out.scanned++;
      let hitPages = 0;
      for (const p of d.pages) {
        const low = norm(p.text);
        // 한글 PDF는 글자 사이 공백이 끼거나 빠지는 경우가 있어 공백 제거본도 함께 비교
        if (!terms.every((t, i) => low.includes(t) || p.flat.includes(flatTerms[i]))) continue;
        const snip = terms.map((t) => snippet(p.text, t)).find(Boolean) || p.text.slice(0, 100);
        out.results.push({ id: m.id || null, name: m.name || storedName(m.path), category: m.category || '', folder: m.folder || '', path: m.path, page: p.n, snippet: snip });
        if (++hitPages >= perFile || out.results.length >= limit) break;
      }
      // 같은 쪽에서 못 찾은 문서만: 이웃한 2쪽(없으면 3쪽) 사이에 나뉜 문구·단어 검색
      if (crossPage && hitPages === 0 && out.results.length + cross.length < limit) {
        const xs = crossMatches(d, terms, flatTerms, Math.min(perFile, limit - out.results.length - cross.length));
        growCache(keyOf(m.path), d);
        for (const x of xs) cross.push({ id: m.id || null, name: m.name || storedName(m.path), category: m.category || '', folder: m.folder || '', path: m.path, page: x.page, pageEnd: x.pageEnd, cross: true, snippet: x.snippet });
      }
    }
    for (const c of cross) { if (out.results.length >= limit) break; out.results.push(c); }
    out.crossPage = out.results.filter((r) => r.cross).length;
    return out;
  }

  function status(files) {
    const s = { ok: 0, no_text: 0, garbled: 0, encrypted: 0, skipped: 0, error: 0, pending: 0, missing: 0, queue: queue.length, current: current ? storedName(current) : null, batchRunning: batchActive(), deferredSec: deferredSince ? Math.round((Date.now() - deferredSince) / 1000) : 0 };
    for (const m of files || []) { if (m && isPdf(m.path)) { const st = fileState(m.path).state; s[st] = (s[st] || 0) + 1; } }
    s.cacheMb = Math.round(cacheBytes / 1048576); s.serverRssMb = Math.round(process.memoryUsage().rss / 1048576);
    s.serverPeakRssMb = Math.round(process.resourceUsage().maxRSS / 1024); s.workerPeakRssMb = stats.workerPeakRssMb;
    return s;
  }

  // reindex.js 용: 동시 실행 방지 잠금 (search-index/reindex.lock)
  function acquireLock() {
    const abs = safeIndexPath('reindex.lock');
    try { fs.writeFileSync(abs, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' }); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0; try { pid = JSON.parse(fs.readFileSync(abs, 'utf8')).pid; } catch {}
      let alive = false; try { if (pid) { process.kill(pid, 0); alive = true; } } catch {}
      if (alive) return false;
      fs.rmSync(abs, { force: true }); // 이전 실행이 비정상 종료되어 남은 잠금
      return acquireLock();
    }
  }
  function releaseLock() { try { fs.rmSync(safeIndexPath('reindex.lock'), { force: true }); } catch {} }
  // reindex.js 용: 잠금을 잡은 뒤, 서버가 추출 중인 파일이 끝날 때까지 기다림. 반환: 기다린 ms, 시간 안에 안 끝나면 -1
  // 서버 추출은 timeoutMs 안에 끝나므로, 표식 만료 여유(freshMs×2)를 더한 시간까지만 기다림 (기본 120+90초)
  async function waitForServerIdle({ maxMs = timeoutMs + freshMs * 2, onWait } = {}) {
    const t0 = Date.now(); let told = false;
    while (serverBusy()) {
      if (Date.now() - t0 > maxMs) return -1;
      if (!told && onWait) { told = true; onWait(markInfo(MARK)); }
      await new Promise((r) => setTimeout(r, 500));
    }
    return Date.now() - t0;
  }

  return { enqueue, indexOne, fileState, search, status, acquireLock, releaseLock, startLockHeartbeat: () => startHeartbeat(LOCK), waitForServerIdle, batchActive, serverBusy, stats, isPdf, idle: () => !running && !queue.length, _keyOf: keyOf };
}

module.exports = { create, INDEX_VERSION };
