/**
 * server.js — Quokka Agency Main Server (6-Agent Edition)
 * Express app at port 3888. Orchestrates Nova + 5 specialist agents.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');

const { decompose, aggregate } = require('./agents/orchestrator');
const { research } = require('./agents/researcher');
const { reason } = require('./agents/dex');
const { code } = require('./agents/coder');
const { write } = require('./agents/mia');
const { review } = require('./agents/rex');
const { initSSE, sendEvent, closeSSE } = require('./stream');
const { getHealthSummary } = require('./model-router');
const { startDaemon } = require('./health');
const { startDiscovery } = require('./discovery');

const app = express();
const PORT = process.env.PORT || 3888;

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
  req.on('close', () => { try { res.end(); } catch(e) {} });

  try {
    // ── Step 1: Nova decomposes ─────────────────────────────────────────────
    sendEvent(res, { type: 'status', agent: 'nova', status: 'thinking',
      message: '팀원들에게 업무를 분배하고 있어요... 🤔' });

    const orchestration = await decompose(goal);

    sendEvent(res, {
      type: 'orchestrate',
      agent: 'nova',
      message: orchestration.greeting,
      analysis: orchestration.analysis,
      tasks: orchestration.tasks,
      modelUsed: orchestration.modelUsed,
      fallback: orchestration.fallback,
    });

    // ── Step 2: Announce workers ────────────────────────────────────────────
    const getTask = (agentId) =>
      orchestration.tasks.find(t => t.agent === agentId)?.task || goal;

    ['kira','dex','max','mia','rex'].forEach((id, i) => {
      const labels = ['리서치 시작! 🔬', '추론 시작! 🧠', '코딩 시작! 💻', '작성 시작! ✍️', '리뷰 시작! 🔍'];
      sendEvent(res, { type: 'status', agent: id, status: 'working',
        message: `"${getTask(id).slice(0, 50)}..." ${labels[i]}` });
    });

    // ── Step 3: Run all 5 agents in PARALLEL (fault-tolerant) ──────────────
    const results = { kira: '', dex: '', max: '', mia: '', rex: '' };

    const settled = await Promise.allSettled([
      research(getTask('kira'), (chunk) => { results.kira += chunk; sendEvent(res, { type: 'stream', agent: 'kira', chunk }); }),
      reason (getTask('dex'),  (chunk) => { results.dex  += chunk; sendEvent(res, { type: 'stream', agent: 'dex',  chunk }); }),
      code   (getTask('max'),  (chunk) => { results.max  += chunk; sendEvent(res, { type: 'stream', agent: 'max',  chunk }); }),
      write  (getTask('mia'),  (chunk) => { results.mia  += chunk; sendEvent(res, { type: 'stream', agent: 'mia',  chunk }); }),
      review (getTask('rex'),  (chunk) => { results.rex  += chunk; sendEvent(res, { type: 'stream', agent: 'rex',  chunk }); }),
    ]);

    const agentIds = ['kira', 'dex', 'max', 'mia', 'rex'];
    const agentData = settled.map((result, i) => {
      const id = agentIds[i];
      if (result.status === 'fulfilled') {
        return { id, data: result.value };
      } else {
        const errMsg = `⚠️ ${id.toUpperCase()} 에이전트 오류: ${result.reason?.message || '알 수 없는 오류'}`;
        sendEvent(res, { type: 'stream', agent: id, chunk: errMsg });
        console.error(`[server] Agent ${id} failed:`, result.reason?.message);
        return { id, data: { text: errMsg, modelUsed: 'N/A', fallback: true, error: true } };
      }
    });

    agentData.forEach(({ id, data }) => {
      sendEvent(res, {
        type: data.error ? 'error_partial' : 'complete',
        agent: id,
        modelUsed: data.modelUsed,
        fallback: data.fallback,
        error: data.error || false,
      });
    });

    const [kiraData, dexData, maxData, miaData, rexData] = agentData.map(a => a.data);

    // ── Step 4: Nova aggregates ─────────────────────────────────────────────
    sendEvent(res, { type: 'status', agent: 'nova', status: 'aggregating',
      message: '팀원 5명의 결과를 종합하고 있어요! ✨' });

    const combinedResults = [
      `## Kira (분석가)\n${kiraData.text || results.kira}`,
      `## Dex (딥 리즈너)\n${dexData.text || results.dex}`,
      `## Max (코더)\n${maxData.text || results.max}`,
      `## Mia (작가)\n${miaData.text || results.mia}`,
      `## Rex (리뷰어)\n${rexData.text || results.rex}`,
    ].join('\n\n---\n\n');

    const finalResult = await aggregate(
      goal,
      combinedResults,
      '',
      (chunk) => sendEvent(res, { type: 'stream', agent: 'nova_final', chunk }),
    );

    sendEvent(res, {
      type: 'final',
      agent: 'nova',
      message: '모든 팀원의 작업이 완료됐어요! 🎉 퀴카팀 최고!',
      modelUsed: finalResult.modelUsed,
      fallback: finalResult.fallback,
    });

  } catch (err) {
    console.error('[server] Task error:', err.message);
    sendEvent(res, { type: 'error', message: err.message });
  } finally {
    closeSSE(res);
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🐨 Quokka Agency [6-Agent] is running!`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`   API Key: ${process.env.NVIDIA_API_KEY ? '✅ loaded' : '❌ MISSING'}\n`);
  startDaemon();
  startDiscovery();
});
