const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
// Render persistent disk mount path is supplied as DATA_DIR=/var/data.
// Local development falls back to the application folder.
const DATA_ROOT = process.env.DATA_DIR || ROOT;
fs.mkdirSync(DATA_ROOT, {recursive:true});
const DB_FILE = path.join(DATA_ROOT, 'data.json');
const AUTH_FILE = path.join(DATA_ROOT, 'auth.json');
const USERS_FILE = path.join(DATA_ROOT, 'users.json');
const AUDIT_FILE = path.join(DATA_ROOT, 'audit.json');
const UPLOAD_DIR = path.join(DATA_ROOT, 'uploads');
const BACKUP_DIR = path.join(DATA_ROOT, 'backups');
const PORT = Number(process.env.PORT || 10000);
const USER = process.env.HS_USER || 'admin';
const DEFAULT_DB = {projects:[],assets:[],finance:[],tax:[],employees:[],sales:[],cashflow:[],files:[]};
fs.mkdirSync(UPLOAD_DIR, {recursive:true});
fs.mkdirSync(BACKUP_DIR, {recursive:true});
// [PDF 본문 검색] 색인은 DATA_ROOT/search-index 에만 저장 (uploads·data.json 은 읽기만 함)
// 서버는 새로 업로드된 PDF만 자동 색인. 기존 PDF는 관리자가 Render Shell 에서 `node reindex.js` 로 직접 배치 실행
const pdfIndex = require('./pdf-index').create({uploadDir:UPLOAD_DIR, indexDir:path.join(DATA_ROOT,'search-index')});
// [업무보고·뉴스] 기존 data.json 과 분리된 별도 폴더에 저장 (DATA_ROOT/work-reports, DATA_ROOT/news)
const REPORTS_DIR = path.join(DATA_ROOT, 'work-reports');
const NEWS_DIR = path.join(DATA_ROOT, 'news');
const { unifiedSearch } = require('./unified-search');
const REQUIRED_DB_KEYS = Object.keys(DEFAULT_DB);
const PERMISSION_KEYS = ['dashboard','projects','assets','finance','tax','employees','sales','docs','workReports','workReportsManage'];
const CATEGORY_PERMISSION = {'사업관리':'projects','부동산자산':'assets','재무자금':'finance','세무회계':'tax','인사':'employees','영업분양':'sales','업무보고':'docs','기타문서':'docs'};
function permissionsFor(session){ if(session.role==='admin') return [...PERMISSION_KEYS]; const u=findStaff(session.username); return u&&Array.isArray(u.permissions)?u.permissions.filter(k=>PERMISSION_KEYS.includes(k)):[]; }
function canCategory(session,cat){ if(!session) return false; if(session.role==='admin') return true; const p=permissionsFor(session); if(cat==='업무보고') return p.includes('workReports')||p.includes('workReportsManage'); return p.includes(CATEGORY_PERMISSION[cat]||'docs'); }
function visibleDb(session){ const d=readDb(); if(session.role==='admin') return d; const allowed=permissionsFor(session); const out={...DEFAULT_DB}; for(const k of REQUIRED_DB_KEYS){ if(allowed.includes(k)) out[k]=d[k]; } out.files=(d.files||[]).filter(f=>canCategory(session,f.category)); return out; }
// 파일 자동분류 카테고리 = uploads 아래 폴더 이름
const CATEGORIES = ['사업관리','부동산자산','재무자금','세무회계','인사','영업분양','업무보고','기타문서'];
const MAX_UPLOAD = 100 * 1024 * 1024;

/* ---------- 비밀번호: 처음 한 번 설정하면 auth.json에 암호화(scrypt)해서 저장 ---------- */
function hashPassword(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
if (process.argv.includes('--set-password')) {
  const pw = process.env.HS_NEWPASS || '';
  if (pw.length < 12) { console.error('비밀번호는 12자 이상이어야 합니다.'); process.exit(1); }
  const salt = crypto.randomBytes(16).toString('hex');
  let user = USER; // 비밀번호만 바꾸고 기존 아이디는 유지
  try { user = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')).user || USER; } catch {}
  fs.writeFileSync(AUTH_FILE, JSON.stringify({user, salt, hash: hashPassword(pw, salt)}, null, 2), 'utf8');
  console.log('비밀번호를 저장했습니다.');
  process.exit(0);
}
// 이전 버전의 login.json(아이디·비밀번호 평문)이 있으면 같은 아이디/비밀번호로 암호화 저장 후 평문 파일 삭제
const LEGACY_LOGIN = path.join(ROOT, 'login.json');
if (!fs.existsSync(AUTH_FILE) && fs.existsSync(LEGACY_LOGIN)) {
  try {
    const old = JSON.parse(fs.readFileSync(LEGACY_LOGIN, 'utf8'));
    if (String(old.password || '').length >= 12) {
      const salt = crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(AUTH_FILE, JSON.stringify({user: String(old.username || USER), salt, hash: hashPassword(String(old.password), salt)}, null, 2), 'utf8');
      fs.rmSync(LEGACY_LOGIN, {force: true});
      console.log('기존 login.json의 아이디/비밀번호를 그대로 옮겨 암호화 저장했습니다.');
    } else console.error('login.json의 비밀번호가 12자 미만이라 옮기지 않았습니다. 한번에시작.bat에서 새로 설정하세요.');
  } catch (err) { console.error('login.json을 읽지 못했습니다:', err.message); }
}
let authConfig = null;
try { authConfig = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch {}
const ENV_PASS = process.env.HS_PASS || '';
if (ENV_PASS.length < 12 && !(authConfig && authConfig.salt && authConfig.hash)) {
  console.error('보안 오류: 비밀번호가 설정되지 않았습니다. 한번에시작.bat을 실행해 12자 이상의 비밀번호를 설정하세요.');
  process.exit(1);
}
function checkPassword(u, p) {
  if (ENV_PASS.length >= 12) {
    const pb = Buffer.from(p, 'utf8'), eb = Buffer.from(ENV_PASS, 'utf8');
    return u === USER && pb.length === eb.length && crypto.timingSafeEqual(pb, eb);
  }
  const got = Buffer.from(hashPassword(p, authConfig.salt), 'hex'), want = Buffer.from(authConfig.hash, 'hex');
  return u === (authConfig.user || USER) && got.length === want.length && crypto.timingSafeEqual(got, want);
}


/* ---------- 직원 계정: users.json은 Render 영구 디스크(DATA_ROOT)에 별도 보관 ---------- */
function readJsonFile(file, fallback) {
  try { const v=JSON.parse(fs.readFileSync(file,'utf8')); return v; } catch { return fallback; }
}
function writeJsonAtomic(file, value) {
  const tmp=file+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(value,null,2),'utf8'); fs.renameSync(tmp,file);
}
let staffUsers = readJsonFile(USERS_FILE, []);
if (!Array.isArray(staffUsers)) staffUsers=[];
let auditLog = readJsonFile(AUDIT_FILE, []);
if (!Array.isArray(auditLog)) auditLog=[];
function saveUsers(){ writeJsonAtomic(USERS_FILE,staffUsers); }
function addAudit(actor,action,target,detail='') {
  auditLog.unshift({at:new Date().toISOString(),actor,action,target,detail});
  auditLog=auditLog.slice(0,1000); writeJsonAtomic(AUDIT_FILE,auditLog);
}
function adminUsername(){ return (ENV_PASS.length>=12 ? USER : ((authConfig&&authConfig.user)||USER)); }
function isAdminName(username){ return String(username||'')===adminUsername(); }
function publicUser(u){ return {username:u.username,status:u.status,role:'staff',permissions:Array.isArray(u.permissions)?u.permissions:[],createdAt:u.createdAt,approvedAt:u.approvedAt||null,suspendedAt:u.suspendedAt||null}; }
function findStaff(username){ return staffUsers.find(u=>u.username.toLowerCase()===String(username||'').toLowerCase()); }
function passwordMatches(record,password){
  if(!record||!record.salt||!record.hash) return false;
  const got=Buffer.from(hashPassword(password,record.salt),'hex'), want=Buffer.from(record.hash,'hex');
  return got.length===want.length && crypto.timingSafeEqual(got,want);
}
function getSessionInfo(req){
  const token=(req.headers.cookie||'').match(/(?:^|; )hs_session=([A-Za-z0-9_-]+)/)?.[1];
  if(!token) return null;
  const session=sessions.get(token);
  if(!session||session.expires<Date.now()){sessions.delete(token);return null;}
  session.expires=Date.now()+8*60*60*1000;
  return {token,username:session.username,role:session.role};
}
function requireAdmin(req,res){ const s=getSessionInfo(req); if(!s){sendJson(res,401,{ok:false,error:'login_required'});return null;} if(s.role!=='admin'){sendJson(res,403,{ok:false,error:'관리자 권한이 필요합니다.'});return null;} return s; }
function validUsername(v){ return /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,19}$/.test(String(v||'')); }
function validPassword(v){ return typeof v==='string' && v.length>=12 && v.length<=128; }
function staffCount(){ return staffUsers.filter(u=>u.status==='pending'||u.status==='approved'||u.status==='suspended').length; }

const sessions = new Map();
const loginAttempts = new Map();
let lastSafetySnapshotAt = 0;
const JSON_TYPE = 'application/json; charset=utf-8';
function send(res,status,body,type='text/plain; charset=utf-8',headers={}) { res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), microphone=(), geolocation=()',...headers}); res.end(body); }
const sendJson = (res,status,obj,headers) => send(res,status,JSON.stringify(obj),JSON_TYPE,headers);

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const allowed = new Set([
      'https://hyoshin-erp.com',
      'https://www.hyoshin-erp.com'
    ]);
    const extra = (process.env.ALLOWED_ORIGINS || '')
      .split(',').map(v => v.trim()).filter(Boolean);
    return allowed.has(u.origin) || extra.includes(u.origin) || u.host === req.headers.host;
  } catch {
    return false;
  }
}
function requireSameOrigin(req,res) { if (!originAllowed(req)) { sendJson(res,403,{ok:false,error:'요청 출처가 올바르지 않습니다.'}); return false; } return true; }
function getSession(req) { const s=getSessionInfo(req); return s ? s.token : null; }
function requireAuth(req,res) { if(getSessionInfo(req)) return true; sendJson(res,401,{ok:false,error:'login_required'}); return false; }
function readDb(){try { const d=JSON.parse(fs.readFileSync(DB_FILE,'utf8')); if(!d || typeof d!=='object' || Array.isArray(d)) throw new Error('invalid database'); for(const k of REQUIRED_DB_KEYS) if(!Array.isArray(d[k])) d[k]=[]; return d; } catch(err) { if(fs.existsSync(DB_FILE)) console.error('데이터 파일을 읽지 못했습니다. 빈 데이터로 덮어쓰지 않도록 저장 요청을 확인하세요:',err.message); return {...DEFAULT_DB}; }}
function validDb(d){return !!d && typeof d==='object' && !Array.isArray(d) && REQUIRED_DB_KEYS.every(k=>Array.isArray(d[k]));}
function readBody(req,limit,cb){
  let body='', tooLarge=false;
  req.on('data',c=>{ if(tooLarge) return; body+=c; if(body.length>limit){ tooLarge=true; body=''; } });
  req.on('end',()=>cb(tooLarge?null:body, tooLarge));
}
function writeDb(d){ const tmp=DB_FILE+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(d,null,2),'utf8'); fs.renameSync(tmp,DB_FILE); }
// 잦은 저장 중 실수나 오류에 대비해 최대 5분에 한 번 저장 직전 DB 사본을 보관합니다.
function makeSafetySnapshot(){
  try {
    if(!fs.existsSync(DB_FILE)) return;
    const now=Date.now(); if(now-lastSafetySnapshotAt<5*60*1000) return;
    fs.mkdirSync(BACKUP_DIR,{recursive:true});
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    fs.copyFileSync(DB_FILE,path.join(BACKUP_DIR,`save-before-${stamp}.json`));
    lastSafetySnapshotAt=now;
    const list=fs.readdirSync(BACKUP_DIR).filter(n=>n.startsWith('save-before-')&&n.endsWith('.json')).map(name=>({name,time:fs.statSync(path.join(BACKUP_DIR,name)).mtimeMs})).sort((a,b)=>b.time-a.time);
    for(const old of list.slice(30)) fs.rmSync(path.join(BACKUP_DIR,old.name),{force:true});
  } catch(err) { console.error('저장 전 안전 사본 생성 실패:',err.message); }
}
function safeName(s){return path.basename(String(s||'file').replace(/[\\/\0]/g,'_')).replace(/[^\p{L}\p{N}._() -]/gu,'_').replace(/^[.\s]+/,'_').slice(0,150)||'file';}
function decodeParam(v){ try { return decodeURIComponent(v||''); } catch { return ''; } }
// "카테고리/파일명" 경로가 uploads 폴더 밖으로 나가지 않는지 확인
function resolveUpload(rel){ const f=path.resolve(UPLOAD_DIR,String(rel||'')); return f.startsWith(UPLOAD_DIR+path.sep)?f:null; }
// 자동 백업: 데이터 JSON과 첨부파일을 같은 시점의 폴더로 보관합니다.
function makeAutomaticBackup(reason='scheduled') {
  try {
    if (!fs.existsSync(DB_FILE) && !fs.existsSync(UPLOAD_DIR)) return;
    fs.mkdirSync(BACKUP_DIR,{recursive:true});
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const dir=path.join(BACKUP_DIR,`auto-${stamp}-${reason}`);
    fs.mkdirSync(dir,{recursive:false});
    if(fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE,path.join(dir,'data.json'));
    if(fs.existsSync(UPLOAD_DIR)) fs.cpSync(UPLOAD_DIR,path.join(dir,'uploads'),{recursive:true,errorOnExist:false});
    // [업무보고] 보고서와 첨부도 같은 시점으로 함께 백업 (임시 파일 제외)
    if(fs.existsSync(REPORTS_DIR)) fs.cpSync(REPORTS_DIR,path.join(dir,'work-reports'),{recursive:true,errorOnExist:false,filter:s=>!s.endsWith('.tmp')});
    fs.writeFileSync(path.join(dir,'BACKUP_INFO.txt'),`효신통합관리 자동 백업\n생성시각: ${new Date().toISOString()}\n유형: ${reason}\n포함: data.json, uploads 폴더, work-reports 폴더(업무보고, 존재하는 경우)\n이 폴더를 삭제하거나 수정하기 전에 별도 복사본을 보관하세요.\n`,'utf8');
    const backups=fs.readdirSync(BACKUP_DIR,{withFileTypes:true})
      .filter(e=>e.isDirectory()&&e.name.startsWith('auto-'))
      .map(e=>({name:e.name,time:fs.statSync(path.join(BACKUP_DIR,e.name)).mtimeMs}))
      .sort((a,b)=>b.time-a.time);
    for(const old of backups.slice(14)) fs.rmSync(path.join(BACKUP_DIR,old.name),{recursive:true,force:true});
    console.log('자동 백업 완료:',dir);
  } catch(err) { console.error('자동 백업 실패:',err.message); }
}
const FILE_TYPES={'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.txt':'text/plain; charset=utf-8'};

function handleUpload(req,res,url){
  const name=safeName(decodeParam(url.searchParams.get('name')));
  const reqCat=decodeParam(url.searchParams.get('category'));
  const cat=CATEGORIES.includes(reqCat)?reqCat:'기타문서';
  const session=getSessionInfo(req); if(!session||!canCategory(session,cat)) return sendJson(res,403,{ok:false,error:'이 문서 분류에 대한 접근 권한이 없습니다.'});
  const dir=path.join(UPLOAD_DIR,cat);
  fs.mkdirSync(dir,{recursive:true});
  const stored=Date.now()+'_'+crypto.randomBytes(4).toString('hex')+'_'+name;
  const dest=path.join(dir,stored);
  const stream=fs.createWriteStream(dest,{flags:'wx'}); let size=0, failed=false;
  const fail=(code,error)=>{ if(failed) return; failed=true; stream.destroy(); fs.rm(dest,{force:true},()=>{}); if(!res.headersSent) sendJson(res,code,{ok:false,error}); };
  req.on('data',c=>{ size+=c.length; if(size>MAX_UPLOAD){ fail(413,'파일은 100MB 이하만 업로드할 수 있습니다.'); req.unpipe(stream); req.resume(); } });
  req.on('aborted',()=>fail(400,'업로드가 중단되었습니다.'));
  stream.on('error',()=>fail(500,'파일 저장에 실패했습니다.'));
  stream.on('finish',()=>{ if(!failed){ sendJson(res,201,{ok:true,path:cat+'/'+stored,size}); pdfIndex.enqueue(cat+'/'+stored); } });
  req.pipe(stream);
}

// [업무보고] 권한 검사는 모듈 안에서 세션 기준으로 수행 / [뉴스] 하루 한 번 자동 수집
const workReports = require('./work-reports').create({dataRoot:DATA_ROOT, ctx:{getSessionInfo, visibleDb, sendJson, readBody, requireSameOrigin, decodeParam, addAudit, adminUsername, staffUsers:()=>staffUsers, hasWorkReportsAccess:(session)=>session?.role==='admin'||permissionsFor(session).some(k=>k==='workReports'||k==='workReportsManage'), hasWorkReportsManageAccess:(session)=>session?.role==='admin'||permissionsFor(session).includes('workReportsManage')}});
const news = require('./news').create({dataRoot:DATA_ROOT});
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(url.pathname==='/api/signup' && req.method==='POST'){
    if(!requireSameOrigin(req,res)) return;
    return readBody(req,10000,body=>{
      let d={}; try{d=JSON.parse(body||'{}')}catch{}
      const username=String(d.username||'').trim(); const password=String(d.password||'');
      if(!validUsername(username)) return sendJson(res,400,{ok:false,error:'아이디는 영문·숫자·._- 조합 3~20자로 입력하세요.'});
      if(!validPassword(password)) return sendJson(res,400,{ok:false,error:'비밀번호는 12~128자로 입력하세요.'});
      if(isAdminName(username)||findStaff(username)) return sendJson(res,409,{ok:false,error:'이미 사용 중인 아이디입니다.'});
      if(staffCount()>=30) return sendJson(res,403,{ok:false,error:'직원 계정은 대표자 외 최대 30명까지 신청할 수 있습니다.'});
      const salt=crypto.randomBytes(16).toString('hex');
      const user={username,salt,hash:hashPassword(password,salt),status:'pending',role:'staff',permissions:[],createdAt:new Date().toISOString()};
      staffUsers.push(user); saveUsers(); addAudit('system','signup_pending',username,'직원 가입 신청');
      return sendJson(res,201,{ok:true,message:'가입 신청이 접수되었습니다. 대표자 승인 후 로그인할 수 있습니다.'});
    });
  }
  if(url.pathname==='/api/login' && req.method==='POST'){
    if(!requireSameOrigin(req,res)) return;
    return readBody(req,10000,body=>{
      let d={}; try{d=JSON.parse(body||'{}')}catch{}
      const username=String(d.username||'').trim(), password=String(d.password||'');
      const ip=req.socket.remoteAddress||'unknown'; const a=loginAttempts.get(ip)||{count:0,until:0};
      if(a.until>Date.now()) return sendJson(res,429,{ok:false,error:'잠시 후 다시 시도하세요.'});
      let role=null, valid=false;
      if(isAdminName(username)){ valid=checkPassword(username,password); if(valid) role='admin'; }
      else {
        const u=findStaff(username);
        if(u && u.status==='approved' && passwordMatches(u,password)){valid=true;role='staff';}
        else if(u && u.status==='pending' && passwordMatches(u,password)) return sendJson(res,403,{ok:false,error:'가입 신청 승인 대기 중입니다. 대표자 승인 후 로그인할 수 있습니다.'});
        else if(u && u.status==='suspended' && passwordMatches(u,password)) return sendJson(res,403,{ok:false,error:'계정이 정지되었습니다. 대표자에게 문의하세요.'});
      }
      if(!valid){a.count++;if(a.count>=5){a.count=0;a.until=Date.now()+30000;}loginAttempts.set(ip,a);return sendJson(res,401,{ok:false,error:'아이디 또는 비밀번호를 확인하세요.'});}
      loginAttempts.delete(ip); const token=crypto.randomBytes(32).toString('base64url'); sessions.set(token,{username,role,expires:Date.now()+8*60*60*1000});
      const secure=(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https';
      return sendJson(res,200,{ok:true,role},{'Set-Cookie':`hs_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${secure?'; Secure':''}`});
    });
  }
  if(url.pathname==='/api/me' && req.method==='GET'){
    const s=getSessionInfo(req); if(!s)return sendJson(res,401,{ok:false,error:'login_required'});
    return sendJson(res,200,{ok:true,username:s.username,role:s.role,permissions:permissionsFor(s)});
  }
  if(url.pathname==='/api/admin/users' && req.method==='GET'){
    const admin=requireAdmin(req,res); if(!admin)return;
    return sendJson(res,200,{ok:true,users:staffUsers.map(publicUser),limit:30,used:staffCount()});
  }
  if(url.pathname==='/api/admin/audit' && req.method==='GET'){
    const admin=requireAdmin(req,res); if(!admin)return;
    return sendJson(res,200,{ok:true,logs:auditLog.slice(0,200)});
  }
  if(url.pathname==='/api/admin/permissions' && req.method==='POST'){
    const admin=requireAdmin(req,res); if(!admin)return;
    if(!requireSameOrigin(req,res))return;
    return readBody(req,10000,body=>{
      let d={};try{d=JSON.parse(body||'{}')}catch{}
      const target=String(d.username||''); const u=findStaff(target);
      if(!u)return sendJson(res,404,{ok:false,error:'직원 계정을 찾을 수 없습니다.'});
      if(u.status!=='approved')return sendJson(res,400,{ok:false,error:'승인된 직원에게만 권한을 부여할 수 있습니다.'});
      if(!Array.isArray(d.permissions))return sendJson(res,400,{ok:false,error:'권한 목록 형식이 올바르지 않습니다.'});
      const next=[...new Set(d.permissions.filter(k=>PERMISSION_KEYS.includes(k)))];
      u.permissions=next; saveUsers(); addAudit(admin.username,'permissions',target,next.join(','));
      return sendJson(res,200,{ok:true,permissions:next});
    });
  }
  if(url.pathname.startsWith('/api/admin/') && req.method==='POST'){
    const admin=requireAdmin(req,res); if(!admin)return;
    if(!requireSameOrigin(req,res))return;
    return readBody(req,10000,body=>{
      let d={};try{d=JSON.parse(body||'{}')}catch{}
      const target=String(d.username||''); const u=findStaff(target);
      if(!u)return sendJson(res,404,{ok:false,error:'직원 계정을 찾을 수 없습니다.'});
      const action=url.pathname.slice('/api/admin/'.length);
      if(action==='approve'){
        if(u.status!=='pending')return sendJson(res,400,{ok:false,error:'승인 대기 중인 계정이 아닙니다.'});
        u.status='approved';u.approvedAt=new Date().toISOString();
      } else if(action==='reject'||action==='delete'){
        staffUsers=staffUsers.filter(x=>x!==u); saveUsers(); addAudit(admin.username,action,target,'직원 계정 삭제/가입 거절');
        return sendJson(res,200,{ok:true});
      } else if(action==='suspend'){
        if(u.status!=='approved')return sendJson(res,400,{ok:false,error:'승인된 계정만 정지할 수 있습니다.'});
        u.status='suspended';u.suspendedAt=new Date().toISOString();
        for(const [token,session] of sessions)if(session.username===u.username)sessions.delete(token);
      } else if(action==='restore'){
        if(u.status!=='suspended')return sendJson(res,400,{ok:false,error:'정지된 계정이 아닙니다.'});
        u.status='approved';delete u.suspendedAt;
      } else return sendJson(res,404,{ok:false,error:'지원하지 않는 관리자 작업입니다.'});
      saveUsers();addAudit(admin.username,action,target);return sendJson(res,200,{ok:true});
    });
  }
  if(url.pathname==='/api/logout' && req.method==='POST'){
    if(!requireSameOrigin(req,res)) return;const t=getSession(req);if(t)sessions.delete(t);const secure=(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https';return sendJson(res,200,{ok:true},{'Set-Cookie':`hs_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure?'; Secure':''}`});}
  if(url.pathname==='/login.html' && (req.method==='GET'||req.method==='HEAD')) { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return fs.createReadStream(path.join(ROOT,'login.html')).pipe(res); }
  if(url.pathname==='/signup.html' && (req.method==='GET'||req.method==='HEAD')) { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return fs.createReadStream(path.join(ROOT,'signup.html')).pipe(res); }
  if(url.pathname==='/api/health' && req.method==='GET') return sendJson(res,200,{ok:true,app:'효신통합관리'});
  // 공개 홈페이지용 뉴스 읽기 전용 API: 업무 데이터나 관리자 기능은 노출하지 않습니다.
  if(url.pathname==='/api/public/news' && req.method==='GET') return sendJson(res,200,{ok:true,...news.view(false)});
  if(url.pathname.startsWith('/api/')){
    if(!requireAuth(req,res)) return;
    if(url.pathname==='/api/db'&&req.method==='GET') { const session=getSessionInfo(req); return sendJson(res,200,visibleDb(session)); }
    // [PDF 본문 검색] 읽기 전용. visibleDb()가 권한 있는 분류의 파일만 돌려주므로 권한 밖 문서는 검색되지 않음
    if(url.pathname==='/api/search'&&req.method==='GET') {
      const q=String(url.searchParams.get('q')||'').trim().slice(0,100);
      if(!q) return sendJson(res,200,{ok:true,results:[]});
      return sendJson(res,200,{ok:true,...pdfIndex.search(q,visibleDb(getSessionInfo(req)).files)});
    }
    if(url.pathname==='/api/search/status'&&req.method==='GET') {
      if(getSessionInfo(req).role!=='admin') return sendJson(res,403,{ok:false,error:'관리자 권한이 필요합니다.'});
      return sendJson(res,200,{ok:true,...pdfIndex.status(readDb().files)});
    }
    // [통합검색] 회사 자료·파일·폴더·PDF 본문·업무보고를 권한 범위 안에서 한 번에 검색 (읽기 전용)
    if(url.pathname==='/api/unified-search'&&req.method==='GET') {
      return sendJson(res,200,{ok:true,...unifiedSearch({q:url.searchParams.get('q'),session:getSessionInfo(req),visibleDb,pdfIndex,reports:workReports})});
    }
    // [뉴스] 조회는 로그인 사용자, 수동 갱신은 대표만
    if(url.pathname==='/api/news'&&req.method==='GET') return sendJson(res,200,{ok:true,...news.view(getSessionInfo(req).role==='admin')});
    if(url.pathname==='/api/news/refresh'&&req.method==='POST') {
      if(getSessionInfo(req).role!=='admin') return sendJson(res,403,{ok:false,error:'대표자만 갱신할 수 있습니다.'});
      if(!requireSameOrigin(req,res)) return;
      return news.refresh({force:true}).then(()=>sendJson(res,200,{ok:true,...news.view(true)})).catch(e=>sendJson(res,500,{ok:false,error:e.message}));
    }
    // [업무보고] 현장별·직원별·주간·승인·통계
    if(url.pathname==='/api/reports'||url.pathname.startsWith('/api/reports/')) return workReports.handle(req,res,url);
    if(url.pathname==='/api/db'&&req.method==='POST'){
      if(!requireSameOrigin(req,res)) return;
      return readBody(req,20_000_000,(body,tooLarge)=>{
        if(tooLarge) return sendJson(res,413,{ok:false,error:'too_large'});
        let d; try{d=JSON.parse(body)}catch{return sendJson(res,400,{ok:false,error:'invalid_json'});}
        if(!validDb(d)) return sendJson(res,400,{ok:false,error:'데이터 형식이 올바르지 않아 저장을 중단했습니다. 기존 자료는 유지됩니다.'});
        const session=getSessionInfo(req);
        if(session.role==='admin'){ makeSafetySnapshot(); writeDb(d); return sendJson(res,200,{ok:true}); }
        const allowed=permissionsFor(session); const current=readDb();
        for(const k of REQUIRED_DB_KEYS){ if(k==='files') continue; if(allowed.includes(k)||(k==='cashflow'&&allowed.includes('finance'))) current[k]=d[k]; }
        const allowedFiles=(d.files||[]).filter(f=>f&&canCategory(session,f.category));
        const existingFiles=current.files||[];
        current.files=[...existingFiles.filter(f=>!canCategory(session,f.category)),...allowedFiles];
        makeSafetySnapshot(); writeDb(current); sendJson(res,200,{ok:true});
      });
    }
    if(url.pathname==='/api/backup'&&req.method==='GET') {
      if(getSessionInfo(req).role!=='admin') return sendJson(res,403,{ok:false,error:'대표자만 백업할 수 있습니다.'});
      const payload=JSON.stringify({exportedAt:new Date().toISOString(),database:readDb()},null,2);
      return send(res,200,payload,JSON_TYPE,{'Content-Disposition':`attachment; filename*=UTF-8''hyoshin-backup-${new Date().toISOString().slice(0,10)}.json`});
    }
    if(url.pathname==='/api/restore'&&req.method==='POST'){
      if(getSessionInfo(req).role!=='admin') return sendJson(res,403,{ok:false,error:'대표자만 백업을 복원할 수 있습니다.'});
      if(!requireSameOrigin(req,res)) return;
      return readBody(req,20_000_000,(body,tooLarge)=>{
        if(tooLarge) return sendJson(res,413,{ok:false,error:'백업 파일은 20MB 이하만 복원할 수 있습니다.'});
        try {
          const payload=JSON.parse(body); const d=payload && payload.database ? payload.database : payload;
          if(!d || typeof d!=='object' || Array.isArray(d)) throw new Error('invalid');
          const clean={}; for(const k of REQUIRED_DB_KEYS){ if(d[k]!==undefined && !Array.isArray(d[k])) throw new Error('invalid'); clean[k]=Array.isArray(d[k])?d[k]:[]; }
          makeAutomaticBackup('before-restore');
          writeDb(clean);
          sendJson(res,200,{ok:true,message:'복원 완료. 복원 전 데이터는 backups 폴더에 보관했습니다.'});
        } catch { sendJson(res,400,{ok:false,error:'백업 JSON 형식이 올바르지 않습니다. 데이터는 변경되지 않았습니다.'}); }
      });
    }
    if(url.pathname==='/api/upload'&&req.method==='POST'){
      if(!requireSameOrigin(req,res)) return;
      return handleUpload(req,res,url);
    }
    if(url.pathname==='/api/file'&&req.method==='GET'){
      const rel=String(url.searchParams.get('path')||''); const cat=rel.split('/')[0];
      if(!canCategory(getSessionInfo(req),cat)) return sendJson(res,403,{ok:false,error:'이 문서 분류에 대한 접근 권한이 없습니다.'});
      const f=resolveUpload(rel);
      if(!f||!fs.existsSync(f)||!fs.statSync(f).isFile()) return send(res,404,'Not Found');
      const ext=path.extname(f).toLowerCase();
      const original=path.basename(f).replace(/^\d+_[0-9a-f]{8}_/,'');
      const inline=FILE_TYPES[ext] && url.searchParams.get('dl')!=='1';
      res.writeHead(200,{'Content-Type':inline?FILE_TYPES[ext]:'application/octet-stream','Content-Disposition':`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(original)}`,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});
      return fs.createReadStream(f).pipe(res);
    }
    if(url.pathname==='/api/files/move'&&req.method==='POST'){
      if(!requireSameOrigin(req,res)) return;
      return readBody(req,10000,body=>{
        let d={}; try{d=JSON.parse(body||'{}')}catch{}
        const from=resolveUpload(d.path); const session=getSessionInfo(req); const sourceCat=String(d.path||'').split('/')[0];
        if(!canCategory(session,sourceCat)||!canCategory(session,d.category)) return sendJson(res,403,{ok:false,error:'파일 이동 권한이 없습니다.'});
        if(!from||!CATEGORIES.includes(d.category)||!fs.existsSync(from)) return sendJson(res,400,{ok:false,error:'파일을 찾을 수 없습니다.'});
        const dir=path.join(UPLOAD_DIR,d.category); fs.mkdirSync(dir,{recursive:true});
        const base=path.basename(from);
        try { fs.renameSync(from,path.join(dir,base)); } catch { return sendJson(res,500,{ok:false,error:'파일 이동에 실패했습니다.'}); }
        sendJson(res,200,{ok:true,path:d.category+'/'+base});
      });
    }
    if(url.pathname==='/api/files/delete'&&req.method==='POST'){
      if(!requireSameOrigin(req,res)) return;
      return readBody(req,10000,body=>{
        let d={}; try{d=JSON.parse(body||'{}')}catch{}
        const session=getSessionInfo(req); const cat=String(d.path||'').split('/')[0];
        if(!canCategory(session,cat)) return sendJson(res,403,{ok:false,error:'파일 삭제 권한이 없습니다.'});
        const f=resolveUpload(d.path);
        if(!f) return sendJson(res,400,{ok:false,error:'잘못된 요청입니다.'});
        fs.rm(f,{force:true},()=>sendJson(res,200,{ok:true}));
      });
    }
    return send(res,404,'Not Found');
  }
  // 회사 홈페이지 첫 화면은 비로그인 방문객에게 공개합니다.
  if((url.pathname==='/' || url.pathname==='/index.html') && (req.method==='GET'||req.method==='HEAD')) {
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), microphone=(), geolocation=()'});
    if(req.method==='HEAD') return res.end();
    return fs.createReadStream(path.join(ROOT,'public-home.html')).pipe(res);
  }
  const currentSession=getSessionInfo(req);
  if(!currentSession){ if(req.method==='GET'||req.method==='HEAD') {res.writeHead(302,{Location:'/login.html','Cache-Control':'no-store'});return res.end();} return send(res,401,'로그인이 필요합니다.'); }
  if(url.pathname==='/admin.html' && currentSession.role!=='admin') return send(res,403,'관리자 권한이 필요합니다.');
  if(req.method!=='GET'&&req.method!=='HEAD') return send(res,405,'Method Not Allowed');
  // 화면 파일만 제공 (데이터·비밀번호·백업·첨부 폴더는 직접 접근 불가)
  const requested=(url.pathname==='/erp' || url.pathname==='/erp/')?'index.html':url.pathname==='/'?'index.html':decodeParam(url.pathname.slice(1));
  const file=path.resolve(ROOT,requested);
  const blocked=[DB_FILE,AUTH_FILE].includes(file)||[UPLOAD_DIR,BACKUP_DIR,REPORTS_DIR,NEWS_DIR].some(d=>file.startsWith(d+path.sep))||/\.(js|ps1|bat|json|tmp)$/i.test(file);
  if(!file.startsWith(ROOT+path.sep)||blocked||!fs.existsSync(file)||!fs.statSync(file).isFile())return send(res,404,'Not Found');
  const ext=path.extname(file).toLowerCase();const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp','.ico':'image/x-icon'};
  res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-store'});if(req.method==='HEAD')return res.end();fs.createReadStream(file).pipe(res);
});
server.on('error',err=>{
  if(err.code==='EADDRINUSE') console.error(`[오류] ${PORT}번 포트를 이미 다른 프로그램이 사용 중입니다. 이전 서버 창을 닫고 다시 실행하세요.`);
  else console.error('[오류] 서버 시작 실패:',err.message);
  process.exit(1);
});
server.listen(PORT,'0.0.0.0',()=>{console.log('효신통합관리 서버 실행: http://localhost:'+PORT);console.log('로그인 아이디: '+((authConfig&&authConfig.user)||USER));console.log('서버를 종료하려면 이 창에서 Ctrl+C를 누르세요.');news.start();});

// 서버가 켜져 있는 동안 6시간마다 자동 백업. 기존 자료가 없으면 빈 백업은 만들지 않습니다.
const backupTimer=setInterval(()=>makeAutomaticBackup('scheduled'),6*60*60*1000);
backupTimer.unref();
server.on('close',()=>clearInterval(backupTimer));
process.on('SIGINT',()=>{makeAutomaticBackup('shutdown');server.close(()=>process.exit(0));});
process.on('SIGTERM',()=>{makeAutomaticBackup('shutdown');server.close(()=>process.exit(0));});
