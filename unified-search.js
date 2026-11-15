// 독립형 통합검색: 회사 자료(사업·현장·직원 등) · 파일명 · 폴더명 · 추출 본문 · PDF 본문(색인) · 업무보고
//  - 항상 서버의 visibleDb(session) 결과(권한으로 걸러진 자료)만 검색합니다.
//  - PDF 본문은 기존 pdf-index.search() 를 그대로 사용(색인 파일 읽기 전용).
//  - 업무보고는 work-reports 모듈의 권한 검사를 거친 결과만 포함합니다.
'use strict';

const MODULES = {
  projects: { label: '사업관리', page: 'projects', title: (x) => x.name, fields: ['name', 'type', 'status', 'memo'] },
  sales: { label: '영업·분양 현장', page: 'sales', title: (x) => x.name, fields: ['name', 'status', 'memo'] },
  assets: { label: '부동산 자산', page: 'properties', title: (x) => x.name, fields: ['name', 'type', 'addr', 'status', 'memo'] },
  employees: { label: '직원(인사)', page: 'hr', title: (x) => x.name, fields: ['name', 'dept', 'position', 'status', 'memo'] },
  finance: { label: '재무·자금', page: 'finance', title: (x) => x.bank, fields: ['bank', 'kind', 'memo'] },
  tax: { label: '세무·회계', page: 'tax', title: (x) => x.name, fields: ['name', 'status', 'memo'] },
  cashflow: { label: '캐시플로우', page: 'cashflow', title: (x) => [x.project, x.item || x.category].filter(Boolean).join(' · '), fields: ['project', 'account', 'category', 'item', 'counterparty', 'memo'] },
};
const CAT_PAGE = { '사업관리': 'projects', '부동산자산': 'properties', '재무자금': 'finance', '세무회계': 'tax', '인사': 'hr', '영업분양': 'sales', '기타문서': 'docs' };
const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase();
const flat = (s) => norm(s).replace(/\s+/g, '');
function matches(hay, terms) { const h = norm(hay), f = flat(hay); return terms.every((t) => h.includes(t) || f.includes(t.replace(/\s+/g, ''))); }
function snip(text, term) {
  const t = String(text || ''); const i = norm(t).indexOf(term);
  if (i < 0) return '';
  const s = Math.max(0, i - 40), e = Math.min(t.length, i + term.length + 70);
  return (s > 0 ? '…' : '') + t.slice(s, e).replace(/\s+/g, ' ') + (e < t.length ? '…' : '');
}

function unifiedSearch({ q, session, visibleDb, pdfIndex, reports, limitPerGroup = 10 }) {
  const query = String(q || '').trim().slice(0, 100);
  const terms = norm(query).split(/\s+/).filter(Boolean).slice(0, 6);
  const groups = { records: [], folders: [], files: [], pdf: [], reports: [] };
  if (!terms.length) return { q: query, total: 0, groups };
  const db = visibleDb(session);

  // 1) 회사 자료 (권한 있는 메뉴만 visibleDb 에 들어 있음)
  for (const [key, m] of Object.entries(MODULES)) {
    for (const x of db[key] || []) {
      if (!x || typeof x !== 'object') continue;
      const hay = m.fields.map((k) => x[k] ?? '').join(' ');
      if (!matches(hay, terms)) continue;
      const memoHit = x.memo && snip(x.memo, terms[0]);
      groups.records.push({ kind: 'record', module: key, label: m.label, title: String(m.title(x) || '(이름 없음)'), snippet: memoHit || [x.status, x.type || x.kind || x.dept, x.addr].filter(Boolean).join(' · '), nav: { page: m.page, module: key, id: x.id } });
      if (groups.records.length >= limitPerGroup * 2) break;
    }
  }
  // 2) 폴더명 · 파일명 · 추출 본문
  const files = (db.files || []).filter((f) => f && typeof f === 'object');
  const folderSeen = new Map();
  for (const f of files) {
    const folder = String(f.folder || '');
    if (folder && matches(folder, terms)) {
      const k = folder + '|' + f.category; const v = folderSeen.get(k) || { kind: 'folder', label: '📁 폴더', title: folder, category: f.category, count: 0, nav: { page: 'docs', folder, category: f.category } };
      v.count++; folderSeen.set(k, v);
    }
    const hay = [f.name, folder, f.category, (f.reason || []).join(' '), f.text || ''].join(' ');
    if (!matches(hay, terms)) continue;
    if (groups.files.length >= limitPerGroup * 3) continue;
    const textHit = f.text && snip(f.text, terms[0]);
    groups.files.push({ kind: 'file', label: '📄 ' + (f.category || '문서'), title: String(f.name || ''), snippet: textHit || (folder ? '📁 ' + folder : ''), nav: { path: f.path || null, page: CAT_PAGE[f.category] || 'docs', id: f.id } });
  }
  groups.folders = [...folderSeen.values()].slice(0, limitPerGroup).map((v) => ({ ...v, snippet: `${v.category} · 파일 ${v.count}개` }));
  // 3) PDF 본문 (색인 26개 + 자동 색인분) — 권한 있는 파일만 전달
  if (pdfIndex) {
    const r = pdfIndex.search(query, files, { limit: limitPerGroup * 2, perFile: 2 });
    groups.pdf = r.results.map((x) => ({ kind: 'pdf', label: '🔎 PDF 본문', title: x.name, snippet: x.snippet, page: x.page, pageEnd: x.pageEnd || null, category: x.category, nav: { path: x.path, page: x.page } }));
    groups.pdfInfo = { noText: r.noText, pending: r.pending, failed: r.failed };
  }
  // 4) 업무보고 (작성자/담당자/대표 권한 검사 포함)
  if (reports) groups.reports = reports.search(session, terms, limitPerGroup).map((x) => ({ kind: 'report', label: '📝 ' + x.typeLabel, title: x.title, snippet: x.snippet, status: x.status, urgent: x.urgent, nav: { page: 'reports', reportId: x.id } }));

  groups.records = groups.records.slice(0, limitPerGroup * 2);
  groups.files = groups.files.slice(0, limitPerGroup * 2);
  const total = groups.records.length + groups.folders.length + groups.files.length + groups.pdf.length + groups.reports.length;
  return { q: query, total, groups };
}

module.exports = { unifiedSearch };
