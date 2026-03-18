/**
 * preflight.js — Quokka Agency Pre-flight Check System
 *
 * Task 실행 전에 자동으로 수행되는 선행 검사 파이프라인.
 * 스마트 캐시 전략:
 *   - 보안 스캔: 서버 시작 시 1회 + 파일 변경 감지 시에만 재실행
 *   - 헬스 체크: model-router 기존 캐시만 읽음 (API 추가 호출 없음)
 *   - 모델 준비: getHealthSummary() 캐시 조회만으로 판단
 *
 * 이 방식으로 task당 추가 대기 시간은 ~5ms 이하 (순수 메모리 읽기)
 */
const fs   = require('fs');
const path = require('path');

const { getHealthSummary } = require('./model-router');

// ─── 스캔 결과 캐시 ────────────────────────────────────────────────────────────
let _securityCache = null;          // { ok, issues, scannedAt, fileCount }
let _lastMtimeMap  = {};            // 파일명 → mtime (변경 감지용)

const SECURITY_SCAN_DEBOUNCE_MS = 5 * 60 * 1000; // 5분

// ─── 경량 보안 스캐너 ──────────────────────────────────────────────────────────
const SECURITY_PATTERNS = [
  { name: 'NVIDIA API Key',  regex: /nvapi-[A-Za-z0-9_-]{20,}/g,    severity: 'HIGH' },
  { name: 'OpenAI API Key',  regex: /sk-[A-Za-z0-9]{20,}/g,          severity: 'HIGH' },
  { name: 'AWS Access Key',  regex: /AKIA[0-9A-Z]{16}/g,              severity: 'HIGH' },
  { name: 'GitHub Token',    regex: /gh[ps]_[A-Za-z0-9]{36,}/g,      severity: 'HIGH' },
  { name: 'Private Key',     regex: /-----BEGIN .+PRIVATE KEY-----/g,  severity: 'HIGH' },
  { name: 'Bearer Token',    regex: /Bearer\s+[A-Za-z0-9_.=-]{30,}/g, severity: 'HIGH' },
  { name: 'Hardcoded Pw',    regex: /password\s*[:=]\s*['"][^'"]{8,}['"]/gi, severity: 'MEDIUM' },
  { name: 'Hardcoded Secret',regex: /secret\s*[:=]\s*['"][^'"]{8,}['"]/gi,  severity: 'MEDIUM' },
];

const SCAN_EXCLUDE_DIRS  = new Set(['node_modules', '.git', 'backups', 'logs', 'dist', '.next']);
const SCAN_EXCLUDE_FILES = new Set(['.env', '.env.local', 'package-lock.json', 'yarn.lock']);
const SCAN_EXCLUDE_EXTS  = new Set(['.png','.jpg','.gif','.ico','.pdf','.woff','.ttf','.mp4']);

function collectScanFiles(dir, rootDir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }

  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel  = path.relative(rootDir, full);
    const ext  = path.extname(e.name).toLowerCase();
    if (e.isDirectory()) {
      if (!SCAN_EXCLUDE_DIRS.has(e.name)) collectScanFiles(full, rootDir, out);
    } else {
      if (!SCAN_EXCLUDE_FILES.has(e.name) && !SCAN_EXCLUDE_EXTS.has(ext)) {
        out.push({ full, rel });
      }
    }
  }
  return out;
}

function _runSecurityScan(rootDir) {
  const files = collectScanFiles(rootDir, rootDir);
  const issues = [];

  for (const { full, rel } of files) {
    let content;
    try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }

    for (const pat of SECURITY_PATTERNS) {
      const regex = new RegExp(pat.regex.source, pat.regex.flags);
      let m;
      while ((m = regex.exec(content)) !== null) {
        const lineNum = content.slice(0, m.index).split('\n').length;
        const line    = content.split('\n')[lineNum - 1]?.trim() || '';
        if (/process\.env\.|require\('dotenv'\)/.test(line)) continue;
        if (/example|placeholder|your.key|YOUR.KEY|<your/i.test(m[0])) continue;
        issues.push({ file: rel, line: lineNum, pattern: pat.name, severity: pat.severity });
      }
    }
  }

  _lastMtimeMap = {};
  for (const { full } of files) {
    try { _lastMtimeMap[full] = fs.statSync(full).mtimeMs; } catch {}
  }

  const highCount = issues.filter(i => i.severity === 'HIGH').length;
  return {
    ok:         highCount === 0,
    issues,
    highCount,
    mediumCount: issues.filter(i => i.severity === 'MEDIUM').length,
    scannedAt:  Date.now(),
    fileCount:  files.length,
  };
}

function _hasFileChanges(rootDir) {
  if (Object.keys(_lastMtimeMap).length === 0) return true;
  for (const [full, prevMtime] of Object.entries(_lastMtimeMap)) {
    try {
      const curr = fs.statSync(full).mtimeMs;
      if (curr !== prevMtime) return true;
    } catch { return true; }
  }
  return false;
}

function getSecurityStatus(rootDir) {
  const now = Date.now();
  const cacheAge = _securityCache ? now - _securityCache.scannedAt : Infinity;
  const changed  = _hasFileChanges(rootDir);

  if (_securityCache && cacheAge < SECURITY_SCAN_DEBOUNCE_MS && !changed) {
    return { ..._securityCache, fromCache: true };
  }

  console.log(`[preflight] Security scan${changed ? ' (file change)' : ' (cache expired)'}...`);
  _securityCache = _runSecurityScan(rootDir);
  return { ..._securityCache, fromCache: false };
}

function getHealthStatus() {
  const summary = getHealthSummary();
  const roles   = Object.keys(summary);
  const ready   = [], degraded = [], down = [];

  for (const role of roles) {
    const models  = summary[role] || [];
    const primary = models.find(m => m.badge === 'primary');
    const anyOk   = models.some(m => m.available);

    if (primary?.available) {
      ready.push({ role, model: primary.modelId?.split('/').pop(), status: 'primary' });
    } else if (anyOk) {
      const fb = models.find(m => m.available);
      degraded.push({ role, model: fb?.modelId?.split('/').pop(), status: 'fallback' });
    } else {
      down.push({ role, status: 'down' });
    }
  }

  return { ok: down.length === 0, ready, degraded, down, totalRoles: roles.length, readyCount: ready.length + degraded.length };
}

/**
 * runPreflight(goal, rootDir) — Task 실행 전 선행 검사
 */
function runPreflight(goal, rootDir) {
  const t0 = Date.now();

  const security = getSecurityStatus(rootDir);
  const health   = getHealthStatus();

  const warnings = [];
  let blocked = false;

  if (security.highCount > 0) {
    blocked = true;
    warnings.push(`🚨 보안 위험(HIGH) ${security.highCount}건 — push 전 반드시 검토 필요`);
  }
  if (security.mediumCount > 0) {
    warnings.push(`⚠️ 보안 경고(MEDIUM) ${security.mediumCount}건 발견됨`);
  }
  if (health.down.length > 0) {
    warnings.push(`❗ ${health.down.map(d => d.role).join(', ')} 모델 완전 다운`);
  }
  if (health.degraded.length > 0) {
    warnings.push(`🟡 ${health.degraded.map(d => d.role).join(', ')} 폴백 모델로 작동 중`);
  }

  const ROLE_AGENT_MAP = { researcher:'kira', reasoner:'dex', coder:'max', writer:'mia', reviewer:'rex' };
  const recommendedAgents = [
    ...health.ready.map(r => ({ agent: ROLE_AGENT_MAP[r.role]||r.role, model: r.model, status: 'primary' })),
    ...health.degraded.map(r => ({ agent: ROLE_AGENT_MAP[r.role]||r.role, model: r.model, status: 'fallback' })),
  ].filter(a => a.agent);

  return {
    passed: !blocked,
    blocked,
    security: { ok: security.ok, highCount: security.highCount, mediumCount: security.mediumCount, fileCount: security.fileCount, fromCache: security.fromCache },
    health:   { ok: health.ok, ready: health.ready, degraded: health.degraded, down: health.down, readyCount: health.readyCount, totalRoles: health.totalRoles },
    recommendedAgents,
    warnings,
    durationMs: Date.now() - t0,
  };
}

/**
 * initPreflight(rootDir) — 서버 시작 시 비동기 워밍업
 */
function initPreflight(rootDir) {
  setImmediate(() => {
    try {
      const result = _runSecurityScan(rootDir);
      _securityCache = result;
      console.log(`[preflight] 초기 스캔 완료 — ${result.fileCount}개 파일, ${result.ok ? '✅ 안전' : `🚨 HIGH ${result.highCount}건`}`);
    } catch (e) {
      console.error('[preflight] 초기 스캔 오류:', e.message);
    }
  });
}

module.exports = { runPreflight, initPreflight };
