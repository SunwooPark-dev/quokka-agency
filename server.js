/**
 * server.js — Quokka Agency Main Server (6-Agent, hardened v2)
 *
 * 핵심 수정:
 *  1. ERR_STREAM_WRITE_AFTER_END 완전 수정
 *     - req.on('close')에서 res.end() 직접 호출 제거 → _sseEnded 플래그로 감지
 *     - finally 블록에서 closeSSE 1회만 호출, 이중 호출 시 무시
 *  2. 다운 에이전트 자동 제외 + 살아있는 에이전트에만 업무 재분배
 *     - preflight의 recommendedAgents를 사용해 decompose() 호출
 *  3. aggregate()에 5명 결과 전체 전달
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');

const { decompose, aggregate } = require('./agents/orchestrator');
const { research } = require('./agents/researcher');
const { reason }   = require('./agents/dex');
const { code }     = require('./agents/coder');
const { write }    = require('./agents/mia');
const { review }   = require('./agents/rex');
const { initSSE, sendEvent, closeSSE } = require('./stream');
const { getHealthSummary } = require('./model-router');
const { startDaemon } = require('./health');
const { startDiscovery } = require('./discovery');
const { runPreflight, initPreflight } = require('./preflight');

const app     = express();
const PORT    = process.env.PORT || 3888;
const ROOT_DIR = __dirname;

const AGENT_FNS = { kira: research, dex: reason, max: code, mia: write, rex: review };
const AGENT_LABELS = {
  kira: '리서치 시작! 🔬',
  dex:  '추론 시작! 🧠',
  max:  '코딩 시작! 💻',
  mia:  '작성 시작! ✍️',
  rex:  '리뷰 시작! 🔍',
};

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Health API ────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', models: getHealthSummary(), timestamp: new Date().toISOString() });
});

// ─── Task Execution (SSE Stream) ──────────────────────────────────────────────
app.post('/api/task', async (req, res) => {
  const { goal } = req.body;
  if (!goal || !goal.trim()) {
    return res.status(400).json({ error: 'goal is required' });
  }

  initSSE(res);
  // 가드 플래그만 설정 (직접 res.end() 호출 안 함 → finally의 closeSSE가 담당)
  req.on('close', () => { res._sseEnded = true; });

  try {
    // ── Pre-flight ──────────────────────────────────────────────────────
    sendEvent(res, { type: 'preflight', phase: 'start', message: '🔍 선행 검사 중...' });
    const pf = runPreflight(goal, ROOT_DIR);
    sendEvent(res, { type: 'preflight', phase: 'result', ...pf });

    if (pf.blocked) {
      sendEvent(res, { type: 'error', message: `🚨 보안 차단: HIGH ${pf.security.highCount}건. node cli/security-scan.js 쪽인.` });
      return;
    }

    // ── 사용 가능한 에이전트 결정 ───────────────────────────────────────────
    const ALL_AGENTS = ['kira', 'dex', 'max', 'mia', 'rex'];
    const ROLE_AGENT = { researcher: 'kira', reasoner: 'dex', coder: 'max', writer: 'mia', reviewer: 'rex' };
    const downRoles = new Set(pf.health.down.map(d => d.role));
    const availableAgents = ALL_AGENTS.filter(id => {
      const role = Object.entries(ROLE_AGENT).find(([, a]) => a === id)?.[0];
      return !downRoles.has(role);
    });

    if (availableAgents.length === 0) {
      sendEvent(res, { type: 'error', message: '❌ 모든 에이전트 다운 — 잠시 후 다시 시도해주세요.' });
      return;
    }

    ALL_AGENTS.filter(id => !availableAgents.includes(id)).forEach(id => {
      sendEvent(res, { type: 'status', agent: id, status: 'skipped', message: '⚫ 모델 다운 — 건너뜁기' });
    });

    // ── Nova 업무 분배 ─────────────────────────────────────────────────────
    sendEvent(res, { type: 'status', agent: 'nova', status: 'thinking',
      message: `팀원 ${availableAgents.length}명에게 업무를 분배하고 있어요... 🤔` });

    const orchestration = await decompose(goal, availableAgents);

    sendEvent(res, {
      type: 'orchestrate', agent: 'nova',
      message: orchestration.greeting,
      analysis: orchestration.analysis,
      tasks: orchestration.tasks,
      modelUsed: orchestration.modelUsed,
      fallback: orchestration.fallback,
    });

    const taskMap = {};
    orchestration.tasks.forEach(t => { taskMap[t.agent] = t.task; });

    availableAgents.forEach(id => {
      sendEvent(res, {
        type: 'status', agent: id, status: 'working',
        message: `"${(taskMap[id] || goal).slice(0, 60)}..." ${AGENT_LABELS[id]}`,
      });
    });

    // ── 살아있는 에이전트만 병렬 실행 (fault-tolerant) ─────────────────
    const results = {};
    availableAgents.forEach(id => { results[id] = ''; });

    const agentPromises = availableAgents.map(id => {
      const fn   = AGENT_FNS[id];
      const task = taskMap[id] || goal;
      return fn(task, (chunk) => {
        results[id] += chunk;
        sendEvent(res, { type: 'stream', agent: id, chunk });
      }).then(data => ({ id, data, status: 'fulfilled' }))
        .catch(err => {
          const errMsg = `⚠️ ${id.toUpperCase()} 오류: ${err?.message || '알 수 없는 오류'}`;
          sendEvent(res, { type: 'stream', agent: id, chunk: errMsg });
          console.error(`[server] Agent ${id} failed:`, err?.message);
          return { id, data: { text: errMsg, modelUsed: 'N/A', fallback: true, error: true }, status: 'rejected' };
        });
    });

    const agentData = await Promise.all(agentPromises);

    agentData.forEach(({ id, data }) => {
      sendEvent(res, {
        type: data.error ? 'error_partial' : 'complete',
        agent: id, modelUsed: data.modelUsed, fallback: data.fallback, error: data.error || false,
      });
    });

    // ── Nova 최종 취합 ─────────────────────────────────────────────────────
    sendEvent(res, { type: 'status', agent: 'nova', status: 'aggregating',
      message: `팀원 ${agentData.length}명의 결과를 종합하고 있어요! ✨` });

    const agentResults = agentData.map(({ id, data }) => ({
      agent: id,
      text: data.text || results[id] || '(출력 없음)',
    }));

    const finalResult = await aggregate(
      goal, agentResults, '',
      (chunk) => sendEvent(res, { type: 'stream', agent: 'nova_final', chunk }),
    );

    sendEvent(res, {
      type: 'final', agent: 'nova',
      message: '모든 팀원의 작업이 완료덴어요! 🎉 퀴카팀 최고!',
      modelUsed: finalResult.modelUsed, fallback: finalResult.fallback,
    });

  } catch (err) {
    console.error('[server] Task error:', err.message);
    sendEvent(res, { type: 'error', message: `⚠️ 처리 중 오류: ${err.message}` });
  } finally {
    closeSSE(res); // _sseEnded 가드로 이중 호출 안전
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🐨 Quokka Agency [6-Agent Hardened] running!`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`   API Key: ${process.env.NVIDIA_API_KEY ? '✅ loaded' : '❌ MISSING'}\n`);
  startDaemon();
  startDiscovery();
  initPreflight(ROOT_DIR);
});
