#!/usr/bin/env node
/**
 * cli/manage-models.js — Quokka Agency Model Management CLI
 * Usage: node cli/manage-models.js <command> [args]
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const CONFIG_PATH = path.join(__dirname, '..', 'models.config.json');
const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';
const C = { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m', green:'\x1b[32m', yellow:'\x1b[33m', red:'\x1b[31m', cyan:'\x1b[36m' };
const color = (text, ...cs) => cs.map(c=>C[c]).join('') + text + C.reset;
const logo = () => { console.log(color('\n🐨 Quokka Agency — Model Manager', 'bold','cyan')); console.log(color('━'.repeat(50), 'dim')); };
const loadConfig = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const saveConfig = c => fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));

function cmdList() {
  logo(); const cfg = loadConfig();
  console.log(color('\n📋 현재 Model 설정:\n', 'bold'));
  for (const [role, models] of Object.entries(cfg)) {
    console.log(color(`  ${role}`, 'bold','yellow'));
    models.forEach((m,i) => console.log(`    ${i+1}. ${m.padEnd(55)} ${i===0 ? color('[primary]','green') : color(`[fallback-${i}]`,'dim')}`));
    console.log();
  }
}

async function cmdHealth() {
  logo(); const cfg = loadConfig();
  const all = [...new Set(Object.values(cfg).flat())];
  console.log(color(`\n🏥 모델 상태 확인 (${all.length}개)...\n`, 'bold'));
  const results = await Promise.all(all.map(async modelId => {
    const start = Date.now();
    try {
      const ctl = new AbortController(); setTimeout(() => ctl.abort(), 10000);
      const res = await fetch(`${NIM_API_BASE}/chat/completions`, { method:'POST', headers:{'Authorization':`Bearer ${process.env.NVIDIA_API_KEY}`,'Content-Type':'application/json'}, body: JSON.stringify({model:modelId,messages:[{role:'user',content:'ping'}],max_tokens:1,stream:false}), signal:ctl.signal });
      const ok = res.status < 500;
      return { modelId, ok, latency: Date.now()-start, status: res.status };
    } catch(e) { return { modelId, ok:false, latency:null, error:e.message }; }
  }));
  results.forEach(({modelId,ok,latency,status,error}) => {
    const lat = latency ? `${latency}ms` : 'timeout';
    const info = error ? error.slice(0,40) : `HTTP ${status}`;
    console.log(`  ${ok?color('✅','green'):color('❌','red')} ${modelId.padEnd(50)} ${lat.padEnd(10)} ${info}`);
  });
  const passed = results.filter(r=>r.ok).length;
  console.log(color(`\n  Result: ${passed}/${results.length} 모델 정상\n`, passed===results.length?'green':'yellow','bold'));
}

function cmdSet(role, modelId) {
  if (!role||!modelId) { console.error(color('Usage: set <role> <modelId>','red')); process.exit(1); }
  const cfg = loadConfig();
  if (!cfg[role]) { console.error(color(`Role "${role}" not found. Available: ${Object.keys(cfg).join(', ')}`,'red')); process.exit(1); }
  cfg[role] = [modelId, ...cfg[role].filter(m=>m!==modelId)];
  saveConfig(cfg);
  console.log(color(`\n✅ [${role}] primary → ${modelId}\n`,'green','bold'));
}

function cmdAdd(role, modelId) {
  if (!role||!modelId) { console.error(color('Usage: add <role> <modelId>','red')); process.exit(1); }
  const cfg = loadConfig();
  if (!cfg[role]) cfg[role] = [];
  if (cfg[role].includes(modelId)) { console.log(color('⚠️  Already exists','yellow')); return; }
  cfg[role].push(modelId); saveConfig(cfg);
  console.log(color(`\n✅ Added ${modelId} to [${role}]\n`,'green','bold'));
}

function cmdRemove(role, modelId) {
  if (!role||!modelId) { console.error(color('Usage: remove <role> <modelId>','red')); process.exit(1); }
  const cfg = loadConfig();
  cfg[role] = (cfg[role]||[]).filter(m=>m!==modelId); saveConfig(cfg);
  console.log(color(`\n✅ Removed ${modelId} from [${role}]\n`,'green','bold'));
}

async function cmdDiscover() {
  logo(); const cfg = loadConfig();
  const known = new Set(Object.values(cfg).flat());
  console.log(color('\n🔍 NVIDIA NIM 모델 탐색 중...\n','bold'));
  try {
    const ctl = new AbortController(); setTimeout(()=>ctl.abort(),15000);
    const res = await fetch(`${NIM_API_BASE}/models`,{headers:{'Authorization':`Bearer ${process.env.NVIDIA_API_KEY}`},signal:ctl.signal});
    const {data=[]} = await res.json();
    const models = data.map(m=>m.id), newModels = models.filter(m=>!known.has(m));
    console.log(color(`총 ${models.length}개 모델, ${newModels.length}개 신규\n`,'cyan'));
    if (newModels.length > 0) { console.log(color('🆕 신규:','bold','green')); newModels.slice(0,30).forEach(m=>console.log(`   → ${m}`)); }
    console.log(color('\n💡 node cli/manage-models.js add <role> <modelId>\n','dim'));
  } catch(e) { console.error(color(`❌ ${e.message}`,'red')); }
}

function cmdBackup() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR,{recursive:true});
  const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const dest = path.join(BACKUP_DIR,`models.config.${ts}.json`);
  fs.copyFileSync(CONFIG_PATH,dest);
  console.log(color(`\n✅ 백업: backups/models.config.${ts}.json\n`,'green','bold'));
}

function cmdRestore(file) {
  let src;
  if (file) { src = path.isAbsolute(file)?file:path.join(BACKUP_DIR,file); }
  else {
    const files = fs.readdirSync(BACKUP_DIR).filter(f=>f.endsWith('.json')).sort();
    if (!files.length) { console.error(color('❌ No backups found','red')); process.exit(1); }
    src = path.join(BACKUP_DIR,files[files.length-1]);
  }
  cmdBackup(); fs.copyFileSync(src,CONFIG_PATH);
  console.log(color('✅ 복원 완료! 서버를 재시작하세요.\n','green','bold'));
}

async function cmdStatus() {
  logo();
  try {
    const res = await fetch('http://localhost:3888/api/health');
    const data = await res.json();
    console.log(color('\n🏥 서버 상태:\n','bold'));
    for (const [role,models] of Object.entries(data.models)) {
      const p = models.find(m=>m.badge==='primary');
      console.log(`  ${p?.available?color('🟢','green'):color('🔴','red')} ${role.padEnd(14)} → ${p?.modelId||'none'}`);
    }
    console.log(color(`\n  ${data.timestamp}\n`,'dim'));
  } catch(e) { console.error(color('❌ 서버 연결 실패 (localhost:3888)','red')); }
}

const [,,cmd,...args] = process.argv;
(async()=>{
  switch(cmd) {
    case 'list':     cmdList(); break;
    case 'health':   await cmdHealth(); break;
    case 'set':      cmdSet(args[0],args[1]); break;
    case 'add':      cmdAdd(args[0],args[1]); break;
    case 'remove':   cmdRemove(args[0],args[1]); break;
    case 'discover': await cmdDiscover(); break;
    case 'backup':   cmdBackup(); break;
    case 'restore':  cmdRestore(args[0]); break;
    case 'status':   await cmdStatus(); break;
    default: console.log('Usage: node cli/manage-models.js <list|health|set|add|remove|discover|backup|restore|status>');
  }
})().catch(e=>console.error(color(`Fatal: ${e.message}`,'red')));
