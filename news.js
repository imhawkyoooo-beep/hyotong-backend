// 오늘의 부동산 뉴스 (하루 한 번 자동 수집)
//
//  - 공개 RSS(언론사 부동산·경제 섹션, 구글 뉴스 검색 RSS)와 선택적으로 네이버 뉴스 검색 API 를 사용합니다.
//  - 원문을 복제하지 않습니다: 제목 · RSS 가 제공하는 짧은 설명(최대 150자) · 언론사 · 게시일 · 원문 링크만 저장합니다.
//  - 저장 위치: DATA_DIR/news/news-cache.json  (기존 업무 데이터와 분리)
//  - 수집 실패 또는 결과가 5건 미만이면 이전에 정상 수집한 뉴스를 그대로 유지합니다.
//
// 서버 환경변수 (모두 선택)
//  NEWS_DISABLED=1                  자동 수집 끄기
//  NEWS_REFRESH_HOUR_KST=7          하루 중 수집을 시작할 시각(기본 7시, 이후 첫 확인 때 1회)
//  NEWS_EXTRA_FEEDS=이름|URL,...      공식 기관 RSS 등 추가 피드(우선 표시)
//  NAVER_CLIENT_ID / NAVER_CLIENT_SECRET   네이버 뉴스 검색 API (키는 서버에만 보관, 브라우저로 보내지 않음)
'use strict';
const fs = require('fs');
const path = require('path');

const CATEGORIES = {
  '세법': ['취득세', '양도세', '양도소득세', '종부세', '종합부동산세', '보유세', '재산세', '임대사업자', '공시가격', '세제', '세율', '중과', '비과세'],
  '정책·금융': ['국토교통부', '국토부', '대출', 'dsr', 'ltv', '금리', '주담대', '주택담보', '규제', '토지거래허가', '토허제', '정책', '금융위', '한국은행', '기준금리', '가계부채', '스트레스'],
  '개발': ['재개발', '재건축', '도시개발', '정비사업', '정비구역', '분양', '청약', '인허가', '착공', '신도시', '공급', '리모델링', '모아타운', '택지', '시행사', 'pf'],
  '주택시장': ['아파트', '매매', '전세', '월세', '미분양', '입주', '집값', '매매가', '거래량', '시세', '주택', '부동산', '빌라', '오피스텔', '전셋값', '호가'],
};
const ORDER = ['주택시장', '개발', '세법', '정책·금융'];
// 부동산과 관련 없는 기사를 거르기 위한 필수 단어(하나 이상)
const MUST = ['부동산', '아파트', '주택', '전세', '월세', '분양', '청약', '재개발', '재건축', '미분양', '입주', '집값', '취득세', '양도세', '양도소득세', '종부세', '종합부동산세', '보유세', '임대사업자', '국토부', '국토교통부', '주담대', '주택담보', '토지거래허가', '토허제', '정비사업', '도시개발', '전셋값', '공시가격', '빌라', '오피스텔', '신도시', 'ltv', 'dsr'];

const DEFAULT_FEEDS = [
  { name: '매일경제', url: 'https://www.mk.co.kr/rss/50300009/', weight: 2 },
  { name: '헤럴드경제', url: 'https://biz.heraldcorp.com/rss/google/realestate', weight: 2 },
  { name: '연합뉴스', url: 'https://www.yna.co.kr/rss/economy.xml', weight: 2 },
  { name: '한국경제', url: 'https://www.hankyung.com/feed/realestate', weight: 2 },
  { name: '서울경제', url: 'https://www.sedaily.com/rss/realestate', weight: 2 },
];
const GOOGLE_QUERIES = {
  '주택시장': '아파트 매매 OR 전세 OR 미분양 OR 입주',
  '개발': '재개발 OR 재건축 OR 도시개발 OR 분양 인허가',
  '세법': '취득세 OR 양도소득세 OR 종합부동산세 OR 임대사업자 세금',
  '정책·금융': '국토교통부 부동산 OR 주택담보대출 규제 OR 부동산 금리',
};
const UA = 'Mozilla/5.0 (compatible; HyoshinERP-NewsReader/1.0)';

const kstDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const kstHour = (d = new Date()) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false }).format(d)) % 24;
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
const decode = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e.toLowerCase()] ?? m));
const text = (s) => decode(decode(s)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (x, t) => { const m = x.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, 'i')); return m ? m[1] : ''; };
const keyOf = (t) => text(t).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function bigrams(s) { const k = keyOf(s); const b = new Set(); for (let i = 0; i < k.length - 1; i++) b.add(k.slice(i, i + 2)); return b; }
function similar(a, b) { const A = bigrams(a), B = bigrams(b); if (!A.size || !B.size) return false; let n = 0; for (const x of A) if (B.has(x)) n++; return n / Math.min(A.size, B.size) >= 0.7; }
function summarize(desc, title) {
  let s = text(desc);
  if (!s) return '';
  const t = keyOf(title);
  if (keyOf(s).startsWith(t.slice(0, Math.min(20, t.length))) && keyOf(s).length <= t.length + 30) return ''; // 제목 반복뿐이면 생략
  if (s.length > 150) { const cut = s.slice(0, 150); const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('다.'), cut.lastIndexOf('요.')); s = (end > 60 ? cut.slice(0, end + (cut[end] === '다' || cut[end] === '요' ? 2 : 1)) : cut.replace(/\s+\S*$/, '')) + '…'; }
  return s;
}
function classify(title, summary) {
  const h = (title + ' ' + summary).toLowerCase(), tl = title.toLowerCase(), sl = String(summary || '').toLowerCase();
  // 제목에 부동산 핵심어가 있거나, 요약에 핵심어가 2개 이상 있어야 부동산 뉴스로 인정
  if (!MUST.some((w) => tl.includes(w)) && MUST.filter((w) => sl.includes(w)).length < 2) return null;
  let best = null, score = 0;
  for (const c of ORDER) { let n = 0; for (const w of CATEGORIES[c]) if (h.includes(w)) n += title.toLowerCase().includes(w) ? 2 : 1; if (n > score) { score = n; best = c; } }
  return best;
}
const safeLink = (u) => { try { const x = new URL(String(u).trim()); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };

function create({ dataRoot, log = (...a) => console.log('[뉴스]', ...a), fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const dir = path.join(dataRoot, 'news');
  const file = path.join(dir, 'news-cache.json');
  fs.mkdirSync(dir, { recursive: true });
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let running = null, lastAttempt = 0, timer = null;
  const env = process.env;

  function feeds() {
    const extra = String(env.NEWS_EXTRA_FEEDS || '').split(',').map((x) => x.split('|')).filter((x) => x.length === 2 && safeLink(x[1])).map(([name, url]) => ({ name: name.trim().slice(0, 40), url: safeLink(url), weight: 3, official: true }));
    const google = Object.entries(GOOGLE_QUERIES).map(([cat, q]) => ({ name: '구글 뉴스', url: `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:2d')}&hl=ko&gl=KR&ceid=KR:ko`, weight: 1, google: true, hint: cat }));
    return [...extra, ...DEFAULT_FEEDS, ...google];
  }
  async function get(url, headers = {}) {
    const r = await fetchImpl(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(15000), redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const t = await r.text(); return t.length > 3e6 ? t.slice(0, 3e6) : t;
  }
  function parseRss(xml, feed) {
    const out = [];
    for (const raw of xml.split(/<item[\s>]/i).slice(1, 80)) {
      const x = raw.split(/<\/item>/i)[0];
      let title = text(tag(x, 'title')); const link = safeLink(text(tag(x, 'link')) || (x.match(/<link[^>]*href="([^"]+)"/i) || [])[1]);
      if (!title || !link) continue;
      let source = feed.name;
      if (feed.google) { const src = text(tag(x, 'source')); if (src) { source = src; title = title.replace(new RegExp('\\s*-\\s*' + src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$'), ''); } }
      title = title.replace(/[\s|\-–—·:]+$/, '').trim();
      const pub = Date.parse(text(tag(x, 'pubDate')) || text(tag(x, 'dc:date')) || text(tag(x, 'published')) || '');
      const summary = feed.google ? '' : summarize(tag(x, 'description'), title);
      out.push({ title: title.slice(0, 200), summary, source: source.slice(0, 40), link, publishedAt: Number.isNaN(pub) ? null : new Date(pub).toISOString(), weight: feed.weight, official: !!feed.official, via: feed.google ? 'google' : 'rss' });
    }
    return out;
  }
  async function naver() {
    if (!env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET) return { items: [], status: null };
    const items = [];
    for (const [cat, q] of Object.entries({ '주택시장': '아파트 전세 미분양', '개발': '재개발 재건축 분양', '세법': '양도세 종부세 취득세', '정책·금융': '국토교통부 대출규제' })) {
      const j = JSON.parse(await get(`https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(q)}&display=15&sort=date`, { 'X-Naver-Client-Id': env.NAVER_CLIENT_ID, 'X-Naver-Client-Secret': env.NAVER_CLIENT_SECRET }));
      for (const it of j.items || []) {
        const link = safeLink(it.originallink || it.link); if (!link) continue;
        let host = ''; try { host = new URL(link).hostname.replace(/^www\./, ''); } catch {}
        items.push({ title: text(it.title).slice(0, 200), summary: summarize(it.description, text(it.title)), source: host || '네이버 뉴스', link, publishedAt: Number.isNaN(Date.parse(it.pubDate)) ? null : new Date(Date.parse(it.pubDate)).toISOString(), weight: 2, via: 'naver', hint: cat });
      }
    }
    return { items, status: 'ok' };
  }

  function select(all) {
    const nowMs = now().getTime();
    const fresh = all.filter((n) => n.publishedAt && nowMs - Date.parse(n.publishedAt) < 3 * 864e5 && Date.parse(n.publishedAt) - nowMs < 36e5);
    for (const n of fresh) n.category = classify(n.title, n.summary) || null;
    const rel = fresh.filter((n) => n.category);
    // 중복 제거: 같은(비슷한) 제목은 공식기관 > 요약 있음 > 가중치 > 최신 순으로 하나만
    rel.sort((a, b) => (b.official - a.official) || (!!b.summary - !!a.summary) || (b.weight - a.weight) || String(b.publishedAt).localeCompare(a.publishedAt));
    const uniq = [];
    for (const n of rel) if (!uniq.some((u) => u.link === n.link || keyOf(u.title) === keyOf(n.title) || similar(u.title, n.title))) uniq.push(n);
    // 분야별로 번갈아 선택(최대 10건), 각 분야 안에서는 공식기관·요약 있는 최신 기사 우선
    const buckets = Object.fromEntries(ORDER.map((c) => [c, uniq.filter((n) => n.category === c).sort((a, b) => (b.official - a.official) || (!!b.summary - !!a.summary) || String(b.publishedAt).localeCompare(a.publishedAt))]));
    const picked = [];
    while (picked.length < 10 && ORDER.some((c) => buckets[c].length)) for (const c of ORDER) { if (picked.length >= 10) break; const n = buckets[c].shift(); if (n) picked.push(n); }
    picked.sort((a, b) => String(b.publishedAt).localeCompare(a.publishedAt));
    return picked.map(({ weight, hint, ...n }, i) => ({ id: i + 1, ...n }));
  }

  async function refresh({ force = false } = {}) {
    if (running) return running;
    running = (async () => {
      lastAttempt = Date.now();
      const sources = {}; const all = [];
      const fs_ = feeds();
      const results = await Promise.allSettled(fs_.map((f) => get(f.url).then((x) => parseRss(x, f))));
      results.forEach((r, i) => { const n = fs_[i].google ? `구글 뉴스(${fs_[i].hint})` : fs_[i].name; if (r.status === 'fulfilled') { all.push(...r.value); sources[n] = { ok: true, count: r.value.length }; } else sources[n] = { ok: false, error: String(r.reason && r.reason.message || r.reason).slice(0, 120) }; });
      try { const nv = await naver(); if (nv.status) { all.push(...nv.items); sources['네이버 뉴스 API'] = { ok: true, count: nv.items.length }; } } catch (e) { sources['네이버 뉴스 API'] = { ok: false, error: String(e.message).slice(0, 120) }; }
      const items = select(all);
      const at = now().toISOString();
      if (items.length >= 5) {
        cache = { date: kstDate(now()), fetchedAt: at, items, sources, lastAttemptAt: at, lastError: null };
        const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cache, null, 1), 'utf8'); fs.renameSync(tmp, file);
        log(`수집 완료 ${items.length}건 (후보 ${all.length}건)`);
      } else {
        const err = `수집 결과 부족(${items.length}건) — 이전 뉴스를 유지합니다.`;
        cache = cache ? { ...cache, lastAttemptAt: at, lastError: err, sources } : { date: null, fetchedAt: null, items, sources, lastAttemptAt: at, lastError: err };
        try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cache, null, 1), 'utf8'); fs.renameSync(tmp, file); } catch {}
        log(err);
      }
      return cache;
    })().finally(() => { running = null; });
    return running;
  }

  function due() {
    if (env.NEWS_DISABLED === '1') return false;
    const today = kstDate(now());
    if (cache && cache.date === today) return false;
    if (kstHour(now()) < Number(env.NEWS_REFRESH_HOUR_KST || 7) && cache && cache.items && cache.items.length) return false;
    return Date.now() - lastAttempt > 2 * 3600 * 1000; // 실패 시 2시간 뒤 재시도
  }
  function start() {
    if (timer || env.NEWS_DISABLED === '1') return;
    const tick = () => { if (due()) refresh().catch((e) => log('수집 오류', e.message)); };
    setTimeout(tick, 20000).unref();
    timer = setInterval(tick, 30 * 60 * 1000); timer.unref();
  }
  function view(isAdmin) {
    const c = cache || { date: null, fetchedAt: null, items: [] };
    const out = { date: c.date, fetchedAt: c.fetchedAt, stale: c.date !== kstDate(now()), items: (c.items || []).map(({ via, ...n }) => n) };
    if (isAdmin) Object.assign(out, { lastAttemptAt: c.lastAttemptAt || null, lastError: c.lastError || null, sources: c.sources || {}, naverConfigured: !!(env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET), disabled: env.NEWS_DISABLED === '1' });
    return out;
  }
  return { start, refresh, view, due, dir, _select: select, _parse: parseRss };
}

module.exports = { create, classify, summarize, CATEGORIES };
