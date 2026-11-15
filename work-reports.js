// 업무보고 (현장별 · 직원별 · 주간 · 대표이사 확인/승인 · 통계)
//
// 저장 위치: DATA_DIR/work-reports/reports.json (보고서), DATA_DIR/work-reports/files/<보고서ID>/ (첨부)
//  - 기존 data.json · users.json · uploads 는 읽기만 하고 절대 쓰지 않습니다.
//  - 저장할 때마다 직전 내용을 reports.prev.json 으로 1세대 보관하고, tmp → rename 으로 원자적 저장합니다.
//  - 삭제는 "숨김(삭제 표시)"만 하며 실제 기록은 남깁니다.
//
// 권한 (모두 서버에서 검사)
//  - 대표(admin): 모든 보고서 조회 · 승인/반려/보완요청 · 댓글 · 긴급 표시 · 삭제 표시 · 미제출자 · 전체 통계
//  - 직원: 본인이 작성한 보고서 + 본인이 "담당자"로 지정된 현장 보고서만 조회
//          본인 보고서만 수정(승인 전까지) · 첨부 · 긴급 표시, 볼 수 있는 보고서에 댓글, 본인 통계만
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPE_LABEL = { site: '현장별 업무보고', staff: '직원별 업무보고', weekly: '주간 업무보고' };
const STATUS_LABEL = { submitted: '제출', approved: '승인', rejected: '반려', revision: '보완요청' };
const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
const MAX_ATTACH_PER_REPORT = 10;
const ATTACH_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.hwp': 'application/octet-stream', '.hwpx': 'application/octet-stream', '.doc': 'application/octet-stream', '.docx': 'application/octet-stream', '.xls': 'application/octet-stream', '.xlsx': 'application/octet-stream', '.ppt': 'application/octet-stream', '.pptx': 'application/octet-stream', '.zip': 'application/octet-stream' };
const INLINE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf']);

// ---------- 입력 검사 ----------
const str = (max, req = false) => ({ kind: 'str', max, req });
const num = (min, max) => ({ kind: 'num', min, max });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FIELDS = {
  site: {
    siteId: str(80), siteName: str(100, true), date: { kind: 'date', req: true }, assignee: str(40),
    content: str(5000, true), consult: str(3000), consultCount: num(0, 1e6), contractCount: num(0, 1e6),
    progress: num(0, 100), issues: str(3000), nextPlan: str(3000), urgent: { kind: 'bool' },
  },
  staff: {
    date: { kind: 'date', req: true }, staffName: str(40), dept: str(60), duty: str(500),
    sites: { kind: 'list', max: 10, item: 100 }, projects: { kind: 'list', max: 10, item: 100 },
    results: str(5000, true), inProgress: str(3000), issues: str(3000), plan: str(3000),
    content: str(5000), progress: num(0, 100), urgent: { kind: 'bool' },
  },
  weekly: {
    weekStart: { kind: 'date', req: true }, target: num(0, 1e12), actual: num(0, 1e12), goalText: str(3000),
    resultText: str(5000, true), siteStatus: str(5000), nextPlan: str(5000), urgent: { kind: 'bool' },
  },
};
function clean(type, input, { partial = false } = {}) {
  const spec = FIELDS[type]; const out = {}; const errors = [];
  for (const [k, f] of Object.entries(spec)) {
    if (partial && !(k in input)) continue;
    let v = input[k];
    if (f.kind === 'str') { v = String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, f.max); if (f.req && !v) errors.push(k); }
    else if (f.kind === 'num') { if (v === '' || v == null) v = null; else { v = Number(v); if (!Number.isFinite(v)) v = null; else v = Math.min(f.max, Math.max(f.min, v)); } }
    else if (f.kind === 'date') { v = String(v ?? '').trim(); if (!DATE_RE.test(v) || Number.isNaN(Date.parse(v))) { if (f.req || v) errors.push(k); v = ''; } }
    else if (f.kind === 'bool') v = v === true || v === 'true' || v === 1;
    else if (f.kind === 'list') { v = (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x ?? '').trim().slice(0, f.item)).filter(Boolean); v = [...new Set(v)].slice(0, f.max); }
    out[k] = v;
  }
  return { data: out, errors };
}
const kstToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const newId = (p) => p + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const ID_RE = /^r_[a-z0-9]{6,20}$/;
const ATT_RE = /^a_[a-z0-9]{6,20}$/;
function safeFileName(s) { return path.basename(String(s || 'file').replace(/[\\/\0]/g, '_')).replace(/[^\p{L}\p{N}._() -]/gu, '_').replace(/^[.\s]+/, '_').slice(0, 120) || 'file'; }

function create({ dataRoot, ctx }) {
  const dir = path.join(dataRoot, 'work-reports');
  const filesDir = path.join(dir, 'files');
  const file = path.join(dir, 'reports.json');
  const prevFile = path.join(dir, 'reports.prev.json');
  fs.mkdirSync(filesDir, { recursive: true });

  let store = { version: 1, reports: [] };
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (v && Array.isArray(v.reports)) store = v;
  } catch (e) {
    if (fs.existsSync(file)) {
      // 읽기 실패 시 빈 데이터로 덮어쓰지 않도록 쓰기를 막습니다.
      console.error('[업무보고] reports.json 을 읽지 못했습니다. 저장을 중지합니다:', e.message);
      store.readOnly = true;
    }
  }
  function persist() {
    if (store.readOnly) throw new Error('보고서 파일을 읽지 못해 저장을 중지했습니다. 관리자에게 문의하세요.');
    if (fs.existsSync(file)) fs.copyFileSync(file, prevFile);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, reports: store.reports }, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  }

  // ---------- 권한 ----------
  const isAdmin = (s) => s && s.role === 'admin';
  const canView = (s, r) => !r.deleted && (isAdmin(s) || r.author === s.username || (r.type === 'site' && r.assignee && r.assignee === s.username));
  const canEdit = (s, r) => !r.deleted && (isAdmin(s) || (r.author === s.username && r.status !== 'approved'));
  const visible = (s) => store.reports.filter((r) => canView(s, r));

  function summary(r) {
    const t = r.type;
    const title = t === 'site' ? `${r.siteName} · ${r.date}` : t === 'staff' ? `${r.staffName || r.authorName || r.author}${r.dept ? ' (' + r.dept + ')' : ''} · ${r.date}` : `${r.staffName || r.authorName || r.author} · ${r.weekStart} 주간`;
    const achievement = t === 'weekly' && r.target > 0 ? Math.round((Number(r.actual || 0) / r.target) * 1000) / 10 : null;
    return { ...r, title, typeLabel: TYPE_LABEL[t], statusLabel: STATUS_LABEL[r.status] || r.status, achievement, attachments: (r.attachments || []).map(({ stored, ...a }) => a) };
  }
  function links(s, r) {
    // 현장별 ↔ 직원별 연결: 같은 날짜이면서 (현장명이 직원 보고의 담당 현장에 있거나, 같은 작성자/담당자)
    const out = [];
    for (const x of visible(s)) {
      if (x.id === r.id) continue;
      if (r.type === 'site' && x.type === 'staff' && x.date === r.date && ((x.sites || []).includes(r.siteName) || x.author === r.author || (r.assignee && x.author === r.assignee))) out.push(x);
      if (r.type === 'staff' && x.type === 'site' && x.date === r.date && ((r.sites || []).includes(x.siteName) || x.author === r.author || x.assignee === r.author)) out.push(x);
      if (r.type === 'weekly' && x.type !== 'weekly' && x.author === r.author && x.date >= r.weekStart && x.date <= addDays(r.weekStart, 6)) out.push(x);
    }
    return out.map((x) => ({ id: x.id, type: x.type, typeLabel: TYPE_LABEL[x.type], title: summary(x).title, status: x.status }));
  }
  const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  function diffKeys(a, b) { return Object.keys(b).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])); }

  // ---------- 요청 처리 도우미 ----------
  const json = (res, code, obj) => ctx.sendJson(res, code, obj);
  const readJson = (req, limit = 200000) => new Promise((ok) => ctx.readBody(req, limit, (body, tooLarge) => { if (tooLarge) return ok({ __tooLarge: true }); try { ok(JSON.parse(body || '{}')); } catch { ok({ __bad: true }); } }));
  function staffAccounts() { return (ctx.staffUsers() || []).filter((u) => u.status === 'approved').map((u) => u.username); }
  function authorName(s) { return s.username; }

  function meta(s) {
    const db = ctx.visibleDb(s);
    const sites = [];
    for (const x of db.sales || []) if (x && x.name) sites.push({ id: 'sales:' + x.id, name: String(x.name), kind: '영업·분양 현장', status: x.status || '' });
    for (const x of db.projects || []) if (x && x.name) sites.push({ id: 'projects:' + x.id, name: String(x.name), kind: '사업', status: x.status || '' });
    // 직원이 담당자로 지정된 현장(다른 메뉴 권한이 없어도 선택 가능)
    for (const r of visible(s)) if (r.type === 'site' && !sites.some((x) => x.name === r.siteName)) sites.push({ id: r.siteId || '', name: r.siteName, kind: '보고된 현장', status: '' });
    const users = isAdmin(s) ? [ctx.adminUsername(), ...staffAccounts()] : [s.username];
    return { me: { username: s.username, role: s.role }, sites, users, types: TYPE_LABEL, statuses: STATUS_LABEL, today: kstToday() };
  }

  function list(s, q) {
    let rs = visible(s);
    const f = (k) => String(q.get(k) || '').trim();
    if (f('type')) rs = rs.filter((r) => r.type === f('type'));
    if (f('status')) rs = rs.filter((r) => r.status === f('status'));
    if (f('author')) rs = rs.filter((r) => r.author === f('author'));
    if (f('staff')) { const v = f('staff').toLowerCase(); rs = rs.filter((r) => String(r.author).toLowerCase() === v || String(r.staffName || '').toLowerCase().includes(v)); }
    if (f('site')) rs = rs.filter((r) => r.siteName === f('site') || (r.sites || []).includes(f('site')));
    if (f('urgent') === '1') rs = rs.filter((r) => r.urgent);
    const day = (r) => r.date || r.weekStart || '';
    if (DATE_RE.test(f('from'))) rs = rs.filter((r) => day(r) >= f('from'));
    if (DATE_RE.test(f('to'))) rs = rs.filter((r) => day(r) <= f('to'));
    if (f('q')) { const terms = f('q').toLowerCase().split(/\s+/).filter(Boolean); rs = rs.filter((r) => terms.every((t) => haystack(r).includes(t))); }
    rs = rs.slice().sort((a, b) => (b.urgent - a.urgent) || String(day(b)).localeCompare(day(a)) || String(b.createdAt).localeCompare(a.createdAt));
    const limit = Math.min(500, Math.max(1, Number(f('limit')) || 200));
    return { total: rs.length, reports: rs.slice(0, limit).map((r) => { const x = summary(r); delete x.history; return x; }) };
  }
  const haystack = (r) => [r.siteName, r.assignee, r.author, r.staffName, r.dept, r.duty, r.inProgress, r.content, r.consult, r.issues, r.results, r.plan, r.goalText, r.resultText, r.siteStatus, r.nextPlan, (r.sites || []).join(' '), (r.projects || []).join(' '), TYPE_LABEL[r.type], ...(r.comments || []).map((c) => c.text)].filter(Boolean).join(' ').toLowerCase();

  // 통합검색용 (권한 검사 포함)
  function search(s, terms, limit = 15) {
    const out = [];
    for (const r of visible(s)) {
      const h = haystack(r); if (!terms.every((t) => h.includes(t) || h.replace(/\s+/g, '').includes(t.replace(/\s+/g, '')))) continue;
      const body = [r.content, r.results, r.resultText, r.inProgress, r.issues, r.plan, r.nextPlan].find((x) => x && x.toLowerCase().includes(terms[0])) || [r.content, r.results, r.resultText].find(Boolean) || '';
      const i = body.toLowerCase().indexOf(terms[0]);
      out.push({ id: r.id, type: r.type, typeLabel: TYPE_LABEL[r.type], title: summary(r).title, status: STATUS_LABEL[r.status], urgent: !!r.urgent, snippet: (i > 40 ? '…' : '') + body.slice(Math.max(0, i - 40), Math.max(0, i) + 80).replace(/\s+/g, ' ') });
      if (out.length >= limit) break;
    }
    return out;
  }

  function missing(s, date) {
    const d = DATE_RE.test(date) ? date : kstToday();
    const accounts = staffAccounts();
    const daily = store.reports.filter((r) => !r.deleted && r.type === 'staff' && r.date === d);
    const submitted = [...new Set(daily.map((r) => r.author))];
    return { date: d, staffCount: accounts.length, submitted: accounts.filter((u) => submitted.includes(u)), missing: accounts.filter((u) => !submitted.includes(u)) };
  }

  function stats(s, month) {
    const m = /^\d{4}-\d{2}$/.test(month) ? month : kstToday().slice(0, 7);
    const rs = isAdmin(s) ? store.reports.filter((r) => !r.deleted) : store.reports.filter((r) => !r.deleted && r.author === s.username);
    const inMonth = rs.filter((r) => String(r.date || r.weekStart || '').startsWith(m));
    const byStaff = {};
    for (const r of inMonth) {
      const b = (byStaff[r.author] ||= { author: r.author, total: 0, site: 0, staff: 0, weekly: 0, approved: 0, rejected: 0, revision: 0, urgent: 0, consults: 0, contracts: 0, progressSum: 0, progressN: 0 });
      b.total++; b[r.type]++; if (r.status in b) b[r.status]++; if (r.urgent) b.urgent++;
      b.consults += Number(r.consultCount || 0); b.contracts += Number(r.contractCount || 0);
      if (r.progress != null) { b.progressSum += Number(r.progress); b.progressN++; }
    }
    const staffOf = () => Object.values(byStaff).map(({ progressSum, progressN, _sites, ...b }) => ({ ...b, avgProgress: progressN ? Math.round(progressSum / progressN) : null, siteNames: [...(_sites || [])] })).sort((a, b) => b.total - a.total);
    // 현장별 진행률: 해당 월 마지막 보고 기준
    const siteMap = {};
    for (const r of inMonth.filter((x) => x.type === 'site').sort((a, b) => String(a.date).localeCompare(b.date))) {
      const x = (siteMap[r.siteName] ||= { site: r.siteName, reports: 0, staffReports: 0, people: new Set(), progress: null, lastDate: '', consults: 0, contracts: 0, openIssues: 0 });
      x.reports++; x.people.add(r.author); if (r.date > x.lastDate) x.lastDate = r.date; if (r.progress != null) x.progress = r.progress;
      x.consults += Number(r.consultCount || 0); x.contracts += Number(r.contractCount || 0); if (r.issues) x.openIssues++;
    }
    // 같은 업무를 양쪽에 집계: 직원별 보고에서 선택한 현장은 그 현장의 "연결된 직원 보고"로도 집계
    for (const r of inMonth.filter((x) => x.type === 'staff')) {
      for (const name of r.sites || []) {
        const x = (siteMap[name] ||= { site: name, reports: 0, staffReports: 0, people: new Set(), progress: null, lastDate: '', consults: 0, contracts: 0, openIssues: 0 });
        x.staffReports++; x.people.add(r.author); if (r.date > x.lastDate) x.lastDate = r.date;
      }
      const b = byStaff[r.author]; if (b) for (const name of r.sites || []) (b._sites ||= new Set()).add(name);
    }
    for (const r of inMonth.filter((x) => x.type === 'site')) { const b = byStaff[r.author]; if (b) (b._sites ||= new Set()).add(r.siteName); }
    // 월별 보고 현황 (최근 6개월)
    const months = []; const [y, mo] = m.split('-').map(Number);
    for (let i = 5; i >= 0; i--) { const d = new Date(Date.UTC(y, mo - 1 - i, 1)); months.push(d.toISOString().slice(0, 7)); }
    const monthly = months.map((mm) => { const xs = rs.filter((r) => String(r.date || r.weekStart || '').startsWith(mm)); return { month: mm, total: xs.length, site: xs.filter((r) => r.type === 'site').length, staff: xs.filter((r) => r.type === 'staff').length, weekly: xs.filter((r) => r.type === 'weekly').length, approved: xs.filter((r) => r.status === 'approved').length, pending: xs.filter((r) => r.status === 'submitted').length }; });
    return { month: m, scope: isAdmin(s) ? 'all' : 'mine', staff: staffOf(), sites: Object.values(siteMap).map(({ people, ...x }) => ({ ...x, people: people.size })).sort((a, b) => String(b.lastDate).localeCompare(a.lastDate)), monthly, totals: { reports: inMonth.length, pending: inMonth.filter((r) => r.status === 'submitted').length, urgent: inMonth.filter((r) => r.urgent).length } };
  }

  // ---------- 라우터 ----------
  async function handle(req, res, url) {
    const s = ctx.getSessionInfo(req);
    if (!s) return json(res, 401, { ok: false, error: 'login_required' });
    const p = url.pathname.replace(/\/+$/, '');
    const m = p.match(/^\/api\/reports\/(r_[a-z0-9]+)(?:\/([a-z]+))?$/);
    const isPost = req.method === 'POST';
    if (isPost && !ctx.requireSameOrigin(req, res)) return;
    try {
      if (p === '/api/reports' && req.method === 'GET') return json(res, 200, { ok: true, ...list(s, url.searchParams) });
      if (p === '/api/reports/meta' && req.method === 'GET') return json(res, 200, { ok: true, ...meta(s) });
      if (p === '/api/reports/stats' && req.method === 'GET') return json(res, 200, { ok: true, ...stats(s, url.searchParams.get('month') || '') });
      if (p === '/api/reports/missing' && req.method === 'GET') {
        if (!isAdmin(s)) return json(res, 403, { ok: false, error: '대표자만 확인할 수 있습니다.' });
        return json(res, 200, { ok: true, ...missing(s, url.searchParams.get('date') || '') });
      }
      if (p === '/api/reports' && isPost) {
        const body = await readJson(req);
        if (body.__tooLarge) return json(res, 413, { ok: false, error: '내용이 너무 깁니다.' });
        if (body.__bad || !TYPE_LABEL[body.type]) return json(res, 400, { ok: false, error: '보고서 종류가 올바르지 않습니다.' });
        const { data, errors } = clean(body.type, body);
        if (errors.length) return json(res, 400, { ok: false, error: '필수 항목을 확인하세요.', fields: errors });
        if (body.type === 'site' && data.assignee && !isAdmin(s) && data.assignee !== s.username && !staffAccounts().includes(data.assignee)) data.assignee = s.username;
        const now = new Date().toISOString();
        const r = { id: newId('r_'), type: body.type, ...data, status: 'submitted', author: s.username, authorName: authorName(s), authorRole: s.role, createdAt: now, updatedAt: now, attachments: [], comments: [], history: [{ at: now, by: s.username, action: 'create', fields: Object.keys(data).filter((k) => data[k] !== '' && data[k] != null && !(Array.isArray(data[k]) && !data[k].length)) }] };
        store.reports.push(r); persist();
        return json(res, 201, { ok: true, report: summary(r) });
      }
      if (!m) return json(res, 404, { ok: false, error: 'not_found' });
      const r = store.reports.find((x) => x.id === m[1]);
      if (!r || !canView(s, r)) return json(res, 404, { ok: false, error: '보고서를 찾을 수 없거나 볼 권한이 없습니다.' });
      const action = m[2] || '';
      if (!action && req.method === 'GET') return json(res, 200, { ok: true, report: summary(r), links: links(s, r), canEdit: canEdit(s, r), canReview: isAdmin(s) });
      if (action === 'file' && req.method === 'GET') {
        const a = (r.attachments || []).find((x) => x.id === url.searchParams.get('att'));
        if (!a || !ATT_RE.test(a.id)) return json(res, 404, { ok: false, error: '첨부파일을 찾을 수 없습니다.' });
        const f = path.join(filesDir, r.id, a.stored);
        if (path.dirname(f) !== path.join(filesDir, r.id) || !fs.existsSync(f)) return json(res, 404, { ok: false, error: '첨부파일이 없습니다.' });
        const ext = path.extname(a.name).toLowerCase(); const inline = INLINE_EXT.has(ext) && url.searchParams.get('dl') !== '1';
        res.writeHead(200, { 'Content-Type': inline ? ATTACH_TYPES[ext] : 'application/octet-stream', 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" });
        return fs.createReadStream(f).pipe(res);
      }
      if (!isPost) return json(res, 405, { ok: false, error: 'method_not_allowed' });
      const now = new Date().toISOString();
      if (action === 'update') {
        if (!canEdit(s, r)) return json(res, 403, { ok: false, error: r.status === 'approved' ? '승인된 보고서는 수정할 수 없습니다.' : '수정 권한이 없습니다.' });
        const body = await readJson(req);
        if (body.__bad || body.__tooLarge) return json(res, 400, { ok: false, error: '요청 형식이 올바르지 않습니다.' });
        const { data, errors } = clean(r.type, body, { partial: true });
        if (errors.length) return json(res, 400, { ok: false, error: '필수 항목을 확인하세요.', fields: errors });
        if (r.type === 'site' && 'assignee' in data && data.assignee && !isAdmin(s) && data.assignee !== s.username && !staffAccounts().includes(data.assignee)) delete data.assignee;
        const changed = diffKeys(r, data);
        if (!changed.length) return json(res, 200, { ok: true, report: summary(r), unchanged: true });
        const before = Object.fromEntries(changed.map((k) => [k, r[k]]));
        Object.assign(r, data); r.updatedAt = now;
        const resubmit = !isAdmin(s) && (r.status === 'rejected' || r.status === 'revision');
        if (resubmit) r.status = 'submitted';
        r.history.push({ at: now, by: s.username, action: resubmit ? 'resubmit' : 'update', fields: changed, before });
        persist();
        return json(res, 200, { ok: true, report: summary(r) });
      }
      if (action === 'review') {
        if (!isAdmin(s)) return json(res, 403, { ok: false, error: '대표자만 승인·반려할 수 있습니다.' });
        const body = await readJson(req, 20000);
        const decision = { approve: 'approved', reject: 'rejected', revision: 'revision' }[body.action];
        if (!decision) return json(res, 400, { ok: false, error: '처리 종류가 올바르지 않습니다.' });
        const text = String(body.comment || '').trim().slice(0, 2000);
        if (decision !== 'approved' && !text) return json(res, 400, { ok: false, error: '반려·보완요청 사유를 입력하세요.' });
        const prev = r.status; r.status = decision; r.reviewedAt = now; r.reviewedBy = s.username; r.updatedAt = now;
        if (text) r.comments.push({ id: newId('c_'), at: now, by: s.username, role: s.role, kind: decision, text });
        r.history.push({ at: now, by: s.username, action: 'review:' + decision, before: { status: prev } });
        persist(); ctx.addAudit(s.username, 'report-' + decision, r.id, TYPE_LABEL[r.type]);
        return json(res, 200, { ok: true, report: summary(r) });
      }
      if (action === 'comment') {
        const body = await readJson(req, 20000);
        const text = String(body.text || '').trim().slice(0, 2000);
        if (!text) return json(res, 400, { ok: false, error: '댓글 내용을 입력하세요.' });
        r.comments.push({ id: newId('c_'), at: now, by: s.username, role: s.role, kind: 'comment', text });
        r.history.push({ at: now, by: s.username, action: 'comment' }); r.updatedAt = now;
        persist();
        return json(res, 200, { ok: true, report: summary(r) });
      }
      if (action === 'urgent') {
        if (!(isAdmin(s) || r.author === s.username)) return json(res, 403, { ok: false, error: '긴급 표시 권한이 없습니다.' });
        const body = await readJson(req, 2000);
        const v = body.urgent === true; if (r.urgent === v) return json(res, 200, { ok: true, report: summary(r) });
        r.history.push({ at: now, by: s.username, action: 'urgent', before: { urgent: !!r.urgent } }); r.urgent = v; r.updatedAt = now;
        persist();
        return json(res, 200, { ok: true, report: summary(r) });
      }
      if (action === 'delete') {
        if (!isAdmin(s)) return json(res, 403, { ok: false, error: '대표자만 삭제할 수 있습니다.' });
        r.deleted = true; r.deletedAt = now; r.deletedBy = s.username; r.history.push({ at: now, by: s.username, action: 'delete' });
        persist(); ctx.addAudit(s.username, 'report-delete', r.id, '삭제 표시(기록 보존)');
        return json(res, 200, { ok: true });
      }
      if (action === 'attach') {
        if (!canEdit(s, r)) return json(res, 403, { ok: false, error: '첨부 권한이 없습니다.' });
        if ((r.attachments || []).length >= MAX_ATTACH_PER_REPORT) return json(res, 400, { ok: false, error: `첨부는 보고서당 ${MAX_ATTACH_PER_REPORT}개까지입니다.` });
        const name = safeFileName(ctx.decodeParam(url.searchParams.get('name')));
        const ext = path.extname(name).toLowerCase();
        if (!ATTACH_TYPES[ext]) return json(res, 400, { ok: false, error: '사진·PDF·문서 파일만 첨부할 수 있습니다.' });
        const id = newId('a_'); const stored = id + ext; const d = path.join(filesDir, r.id); fs.mkdirSync(d, { recursive: true });
        const dest = path.join(d, stored);
        return await new Promise((ok) => {
          const out = fs.createWriteStream(dest, { flags: 'wx' }); let size = 0, failed = false;
          const fail = (code, error) => { if (failed) return; failed = true; out.destroy(); fs.rm(dest, { force: true }, () => {}); if (!res.headersSent) json(res, code, { ok: false, error }); ok(); };
          req.on('data', (c) => { size += c.length; if (size > MAX_ATTACH_BYTES) { fail(413, '첨부파일은 20MB 이하만 가능합니다.'); req.unpipe(out); req.resume(); } });
          req.on('aborted', () => fail(400, '업로드가 중단되었습니다.'));
          out.on('error', () => fail(500, '첨부 저장 실패'));
          out.on('finish', () => {
            if (failed) return;
            if (!size) { fs.rm(dest, { force: true }, () => {}); json(res, 400, { ok: false, error: '빈 파일입니다.' }); return ok(); }
            const at = new Date().toISOString();
            r.attachments.push({ id, name, size, stored, at, by: s.username });
            r.history.push({ at, by: s.username, action: 'attach', fields: [name] }); r.updatedAt = at;
            try { persist(); json(res, 201, { ok: true, report: summary(r) }); } catch (e) { json(res, 500, { ok: false, error: e.message }); }
            ok();
          });
          req.pipe(out);
        });
      }
      return json(res, 404, { ok: false, error: 'not_found' });
    } catch (e) {
      console.error('[업무보고] 처리 오류:', e.message);
      if (!res.headersSent) json(res, 500, { ok: false, error: '업무보고 처리 중 오류가 발생했습니다.' });
    }
  }

  return { handle, search, dir, _store: () => store };
}

module.exports = { create, TYPE_LABEL, STATUS_LABEL };
