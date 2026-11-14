#!/usr/bin/env node
// 기존 PDF 본문 색인 배치 (관리자가 Render Shell 에서 직접 실행)
//
//   node reindex.js --status                       현재 색인 상태만 출력 (아무것도 만들지 않음)
//   node reindex.js --dry-run --limit 20           이번에 색인할 대상만 미리 보기
//   node reindex.js --limit 20                     최신 등록순 20개 색인
//   node reindex.js --limit 50 --category 세무회계  분류 지정
//   node reindex.js --limit 20 --since-days 30     최근 30일 등록분만
//   node reindex.js --limit 20 --retry-failed      error/skipped 였던 파일 다시 시도
//
// 안전 장치
//  - data.json 은 읽기만 합니다. uploads 의 PDF 는 읽기만 합니다.
//  - 결과는 DATA_DIR/search-index/ 에만 저장합니다.
//  - 동시에 두 번 실행되지 않도록 search-index/reindex.lock 을 사용합니다.
//  - Ctrl+C 를 누르면 지금 처리 중인 파일까지만 끝내고 멈춥니다. 다시 실행하면 남은 파일부터 이어서 합니다.
//  - 메모리 사용량이 --max-mem(MB, 기본 400)을 넘으면 배치를 멈춥니다.
//  - 실행 중에는 서버가 새 업로드 PDF 색인을 미루고, 서버가 추출 중이면 끝날 때까지 기다린 뒤 시작합니다.
//  - 종료 코드: 0 정상, 3 다른 배치 실행 중, 4 메모리 초과로 멈춤, 5 서버 색인 대기 시간 초과
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
if (flag('help')) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 19).join('\n')); process.exit(0); }

const DATA_ROOT = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_ROOT, 'data.json');
const limit = Math.min(500, Math.max(1, Number(opt('limit', 20)) || 20));
const category = opt('category', '');
const sinceDays = Number(opt('since-days', 0)) || 0;
const pauseMs = Math.max(0, Number(opt('pause', 1000)) || 0);
const maxMemMb = Number(opt('max-mem', 400)) || 400;
const dryRun = flag('dry-run'), statusOnly = flag('status'), retryFailed = flag('retry-failed');

const pdfIndex = require('./pdf-index').create({ uploadDir: path.join(DATA_ROOT, 'uploads'), indexDir: path.join(DATA_ROOT, 'search-index'), log: () => {} });

function readFiles() {
  let d; try { d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { console.error('data.json 을 읽지 못했습니다:', e.message); process.exit(2); }
  return (Array.isArray(d.files) ? d.files : []).filter((m) => m && pdfIndex.isPdf(m.path));
}
// 컨테이너 전체 메모리(익명 메모리) — Linux cgroup v2/v1, 없으면 이 프로세스 RSS
function containerMemMb() {
  for (const [file, key] of [['/sys/fs/cgroup/memory.stat', 'anon'], ['/sys/fs/cgroup/memory/memory.stat', 'total_rss']]) {
    try { const m = fs.readFileSync(file, 'utf8').match(new RegExp('^' + key + ' (\\d+)$', 'm')); if (m) return Math.round(Number(m[1]) / 1048576); } catch {}
  }
  return Math.round(process.memoryUsage().rss / 1048576);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const files = readFiles();
  const counts = {}; const targets = [];
  const cutoff = sinceDays ? Date.now() - sinceDays * 86400000 : 0;
  for (const m of files) {
    const st = pdfIndex.fileState(m.path).state; counts[st] = (counts[st] || 0) + 1;
    if (category && m.category !== category) continue;
    if (cutoff && !(Date.parse(m.date) >= cutoff)) continue;
    if (st === 'pending' || (retryFailed && (st === 'error' || st === 'skipped'))) targets.push(m);
  }
  targets.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  console.log(`등록된 PDF ${files.length}개  상태: ${JSON.stringify(counts)}`);
  console.log(`조건(분류=${category || '전체'}, 최근 ${sinceDays || '-'}일, 재시도=${retryFailed}) 대상 ${targets.length}개, 이번 실행 최대 ${limit}개`);
  if (statusOnly) { console.log(`배치 실행 중: ${pdfIndex.batchActive() ? '예' : '아니오'}  서버 업로드 색인 중: ${pdfIndex.serverBusy() ? '예' : '아니오'}`); process.exit(0); }
  const batch = targets.slice(0, limit);
  if (dryRun) { for (const m of batch) console.log(`  [미리보기] ${m.category}  ${m.name}`); process.exit(0); }
  if (!batch.length) { console.log('색인할 파일이 없습니다.'); process.exit(0); }
  if (!pdfIndex.acquireLock()) { console.error('다른 reindex.js 가 실행 중입니다. 끝난 뒤 다시 실행하세요.'); process.exit(3); }
  // 잠금을 잡은 뒤부터 서버는 새 업로드 PDF 색인을 미룹니다. 잠금 표식은 주기적으로 갱신합니다.
  const lockHeartbeat = pdfIndex.startLockHeartbeat();
  // 서버가 이미 추출 중인 파일이 있으면 끝날 때까지 기다림 (추출 프로세스 2개 동시 실행 방지)
  const waited = await pdfIndex.waitForServerIdle({ onWait: (i) => console.log(`서버가 업로드 PDF 를 색인 중입니다${i && i.pid ? ` (pid ${i.pid})` : ''}. 끝날 때까지 기다립니다…`) });
  if (waited < 0) { clearInterval(lockHeartbeat); pdfIndex.releaseLock(); console.error('서버 색인이 제한 시간 안에 끝나지 않아 배치를 시작하지 않았습니다. 잠시 뒤 다시 실행하세요.'); process.exit(5); }
  if (waited > 0) console.log(`서버 색인 종료 확인 (${(waited / 1000).toFixed(1)}초 대기). 배치를 시작합니다.`);

  let stop = '';
  const onSig = () => { if (!stop) { stop = '사용자 중단'; console.log('\n중단 요청: 지금 파일까지만 처리하고 멈춥니다…'); } };
  process.on('SIGINT', onSig); process.on('SIGTERM', onSig);
  const t0 = Date.now(); const result = {}; let peakMem = 0, done = 0;
  try {
    for (const m of batch) {
      if (stop) break;
      const mem = containerMemMb(); peakMem = Math.max(peakMem, mem);
      if (mem > maxMemMb) { stop = `메모리 ${mem}MB > ${maxMemMb}MB`; break; }
      const t = Date.now();
      let s; try { s = await pdfIndex.indexOne(m.path, { force: retryFailed }); } catch (e) { s = 'error'; console.error('  오류', m.name, e.message); }
      result[s] = (result[s] || 0) + 1; done++;
      console.log(`  [${done}/${batch.length}] ${s.padEnd(9)} ${((Date.now() - t) / 1000).toFixed(1)}s  ${m.category}  ${m.name}`);
      if (pauseMs && done < batch.length) await sleep(pauseMs);
    }
  } finally { clearInterval(lockHeartbeat); pdfIndex.releaseLock(); }
  console.log(`\n완료 ${done}개 / ${((Date.now() - t0) / 1000).toFixed(0)}초  결과: ${JSON.stringify(result)}`);
  console.log(`메모리: 측정 최대 ${peakMem}MB, 추출 프로세스 최대 ${pdfIndex.stats.workerPeakRssMb}MB, 이 배치 프로세스 최대 ${Math.round(process.resourceUsage().maxRSS / 1024)}MB`);
  if (stop) console.log(`멈춘 이유: ${stop}. 다시 실행하면 남은 파일부터 이어서 합니다.`);
  console.log(`남은 대상: ${Math.max(0, targets.length - done)}개`);
  process.exit(stop && stop.startsWith('메모리') ? 4 : 0);
})();
