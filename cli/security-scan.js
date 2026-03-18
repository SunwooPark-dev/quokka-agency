#!/usr/bin/env node
/**
 * cli/security-scan.js — Quokka Agency GitHub Pre-Push Security Scanner
 *
 * 용도: GitHub push 전 민감 정보(API 키, 토큰, 비밀번호 등) 유출 여부 자동 검사
 * 사용: node cli/security-scan.js [--path <dir>] [--strict]
 *
 * 종료코드:
 *   0 = 안전 (push 가능)
 *   1 = 위험 발견 (push 중단 권고)
 */

const fs  = require('fs');
const path = require('path');

const C = {
  reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
  green:'\x1b[32m', yellow:'\x1b[33m', red:'\x1b[31m',
  cyan:'\x1b[36m', magenta:'\x1b[35m', blue:'\x1b[34m',
};
const color = (t,...cs) => cs.map(c=>C[c]).join('') + t + C.reset;

// ─── 탐지 패턴 ─────────────────────────────────────────────────────────────────
const PATTERNS = [
  { name: 'NVIDIA API Key',    regex: /nvapi-[A-Za-z0-9_-]{20,}/g,             severity: 'HIGH' },
  { name: 'OpenAI API Key',    regex: /sk-[A-Za-z0-9]{20,}/g,                  severity: 'HIGH' },
  { name: 'Anthropic API Key', regex: /sk-ant-[A-Za-z0-9_-]{20,}/g,            severity: 'HIGH' },
  { name: 'Generic Bearer',    regex: /Bearer\s+[A-Za-z0-9_.\-]{20,}/g,        severity: 'HIGH' },
  { name: 'AWS Access Key',    regex: /AKIA[0-9A-Z]{16}/g,                      severity: 'HIGH' },
  { name: 'AWS Secret',        regex: /aws[_\-]?secret[_\-]?[a-z]*\s*=\s*['"][^'"]{20,}['"]/gi, severity: 'HIGH' },
  { name: 'GitHub Token',      regex: /gh[ps]_[A-Za-z0-9]{36,}/g,              severity: 'HIGH' },
  { name: 'GitLab Token',      regex: /glpat-[A-Za-z0-9_-]{20,}/g,             severity: 'HIGH' },
  { name: 'Hardcoded Password',regex: /password\s*[:=]\s*['"][^'"]{6,}['"]/gi,  severity: 'MEDIUM' },
  { name: 'Hardcoded Secret',  regex: /secret\s*[:=]\s*['"][^'"]{6,}['"]/gi,    severity: 'MEDIUM' },
  { name: 'Private Key Block', regex: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g, severity: 'HIGH' },
  { name: 'API Key Var',       regex: /api[_\-]?key\s*[:=]\s*['"][A-Za-z0-9_.\-]{16,}['"]/gi, severity: 'MEDIUM' },
  { name: 'Token Var',         regex: /token\s*[:=]\s*['"][A-Za-z0-9_.\-]{16,}['"]/gi,        severity: 'MEDIUM' },
  { name: 'Discord Token',     regex: /[MN][A-Za-z0-9_-]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}/g, severity: 'HIGH' },
  { name: 'Slack Token',       regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g,         severity: 'HIGH' },
  { name: 'DB Connection URL', regex: /(mongodb|postgres|mysql|redis):\/\/[^:]+:[^@]+@/gi, severity: 'MEDIUM' },
];

const EXCLUDE_DIRS  = new Set(['node_modules', '.git', 'backups', 'logs', 'dist', '.next', 'coverage']);
const EXCLUDE_FILES = new Set(['.env', '.env.local', '.env.production', 'package-lock.json', 'yarn.lock']);
const EXCLUDE_EXTS  = new Set(['.png','.jpg','.jpeg','.gif','.ico','.pdf','.zip','.tar','.gz','.mp4','.mp3','.woff','.woff2','.ttf','.eot']);

function loadGitignore(rootDir) {
  const fp = path.join(rootDir, '.gitignore');
  if (!fs.existsSync(fp)) return new Set();
  return new Set(
    fs.readFileSync(fp,'utf8').split('\n').map(l=>l.trim()).filter(l=>l && !l.startsWith('#'))
  );
}

function isGitignored(relPath, gitignored) {
  const parts = relPath.split(path.sep);
  for (const pattern of gitignored) {
    const clean = pattern.replace(/\/$/, '');
    if (parts.includes(clean) || relPath.startsWith(clean)) return true;
  }
  return false;
}

function collectFiles(dir, rootDir, gitignored, files=[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel  = path.relative(rootDir, full);
    const ext  = path.extname(entry.name).toLowerCase();
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name) || isGitignored(rel, gitignored)) continue;
      collectFiles(full, rootDir, gitignored, files);
    } else {
      if (EXCLUDE_EXTS.has(ext)) continue;
      if (isGitignored(rel, gitignored)) continue;
      files.push({ full, rel });
    }
  }
  return files;
}

function scanFile(filePath, relPath, strict) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return []; }

  const findings = [];
  const isEnvFile = EXCLUDE_FILES.has(path.basename(filePath));

  if (isEnvFile) {
    findings.push({ file: relPath, line: 0, pattern: '.env File Detected', match: relPath, severity: 'WARN', note: '.gitignore에 포함되어 있는지 확인하세요' });
    return findings;
  }

  for (const pat of PATTERNS) {
    const regex = new RegExp(pat.regex.source, pat.regex.flags);
    let m;
    while ((m = regex.exec(content)) !== null) {
      const lineNum = content.slice(0, m.index).split('\n').length;
      const line    = content.split('\n')[lineNum - 1]?.trim().slice(0, 100);
      if (/process\.env\.|require\('dotenv'\)|\.env'|\.env"/.test(line)) continue;
      if (/example|placeholder|your[-_]?key|<your|YOUR[_-]?KEY|xxx+/i.test(m[0])) continue;
      findings.push({ file: relPath, line: lineNum, pattern: pat.name, match: m[0].slice(0, 60) + (m[0].length > 60 ? '...' : ''), severity: pat.severity });
    }
  }
  return findings;
}

function main() {
  const args   = process.argv.slice(2);
  const strict = args.includes('--strict');
  const pathIdx = args.indexOf('--path');
  const rootDir = pathIdx !== -1 ? path.resolve(args[pathIdx + 1]) : path.join(__dirname, '..');

  console.log(color('\n\ud83d\udd10 Quokka Agency \u2014 Security Scanner', 'bold','cyan'));
  console.log(color('\u2501'.repeat(55), 'dim'));
  console.log(color(`  \ub300\uc0c1 \ub514\ub809\ud130\ub9ac: ${rootDir}`, 'dim'));
  console.log(color(`  \ubaa8\ub4dc: ${strict ? 'STRICT' : 'STANDARD'}`, 'dim'));
  console.log();

  const gitignored = loadGitignore(rootDir);
  const files      = collectFiles(rootDir, rootDir, gitignored);
  console.log(color(`  ${files.length}\uac1c \ud30c\uc77c \uc2a4\uce90 \uc911...\n`, 'dim'));

  let allFindings = [];
  for (const { full, rel } of files) {
    allFindings = allFindings.concat(scanFile(full, rel, strict));
  }

  const high   = allFindings.filter(f => f.severity === 'HIGH');
  const medium = allFindings.filter(f => f.severity === 'MEDIUM');
  const warn   = allFindings.filter(f => f.severity === 'WARN');
  const low    = allFindings.filter(f => f.severity === 'LOW');

  if (allFindings.length === 0) {
    console.log(color('  \u2705 \ubcf4\uc548 \ubb38\uc81c \uc5c6\uc74c \u2014 GitHub push \uc548\uc804!', 'bold','green'));
    console.log(color(`  \uc2a4\uce94 \ud30c\uc77c: ${files.length}\uac1c\n`, 'dim'));
    process.exit(0);
  }

  const severityIcon = { HIGH:'\ud83d\udea8', MEDIUM:'\u26a0\ufe0f ', WARN:'\ud83d\udccb', LOW:'\u2139\ufe0f ' };
  const grouped = {};
  allFindings.forEach(f => { (grouped[f.file] = grouped[f.file] || []).push(f); });

  for (const [file, findings] of Object.entries(grouped)) {
    console.log(color(`  \ud83d\udcc4 ${file}`, 'bold'));
    findings.forEach(f => {
      const icon = severityIcon[f.severity];
      const sev  = color(`[${f.severity}]`, f.severity === 'HIGH' ? 'red' : 'yellow', 'bold');
      const loc  = f.line > 0 ? color(`L${f.line}`, 'dim') : '';
      console.log(`     ${icon} ${sev} ${color(f.pattern,'bold')} ${loc}`);
      console.log(`        ${color(f.match, 'dim')}`);
      if (f.note) console.log(`        \u2192 ${color(f.note, 'yellow')}`);
    });
    console.log();
  }

  console.log(color('\u2501'.repeat(55), 'dim'));
  console.log(color('  \ud83d\udcca \uc2a4\uce94 \uacb0\uacfc \uc694\uc57d', 'bold'));
  console.log(`     \ud83d\udea8 HIGH  : ${color(String(high.length),   'red',    'bold')}`);
  console.log(`     \u26a0\ufe0f  MEDIUM: ${color(String(medium.length),'yellow', 'bold')}`);
  console.log(`     \ud83d\udccb WARN  : ${color(String(warn.length),   'yellow')}`);
  console.log();

  if (high.length > 0) {
    console.log(color('  \ud83d\udeab [BLOCKED] HIGH \uc704\ud5d8 \ubc1c\uacac \u2014 push \uc911\ub2e8\uc744 \uac15\ub825 \uad8c\uace0\ud569\ub2c8\ub2e4!', 'red','bold'));
    console.log(color('  \uc870\uce58: .gitignore\uc5d0 \ud574\ub2f9 \ud30c\uc77c\uc744 \ucd94\uac00\ud558\uac70\ub098, \ubcc0\uc218\ub97c .env\ub85c \ubd84\ub9ac\ud558\uc138\uc694.', 'dim'));
    process.exit(1);
  } else if (medium.length > 0) {
    console.log(color('  \u26a0\ufe0f  MEDIUM \uc704\ud5d8 \ubc1c\uacac \u2014 \uac80\ud1a0 \ud6c4 push\ud558\uc138\uc694.', 'yellow','bold'));
    process.exit(0);
  } else {
    console.log(color('  \u2705 push \uac00\ub2a5 (WARN/LOW\ub9cc \uc874\uc7ac)', 'green','bold'));
    process.exit(0);
  }
}

main();
