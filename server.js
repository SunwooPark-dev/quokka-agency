/**
 * server.js — Quokka Agency Main Server (6-Agent Edition)
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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', models: getHealthSummary(), timestamp: new Date().toISOString() });
});

app.post('/api/task', async (req, res) => {
  const { goal } = req.body;
  if (!goal || !goal.trim()) return res.status(400).json({ error: 'goal is required' });

  initSSE(res);
  req.on('close', () => { try { res.end(); } catch(e) {} });

  try {
    sendEvent(res, { type: 'status', agent: 'nova', status: 'thinking', message: '팀원들에게 업무를 분배하고 있어요... 🤔' });
    const orchestration = await decompose(goal);
    sendEvent(res, { type: 'orchestrate', agent: 'nova', message: orchestration.greeting, analysis: orchestration.analysis, tasks: orchestration.tasks, modelUsed: orchestration.modelUsed, fallback: orchestration.fallback });

    const getTask = (agentId) => orchestration.tasks.find(t => t.agent === agentId)?.task || goal;
    ['kira','dex','max','mia','rex'].forEach(id => {
      sendEvent(res, { type: 'status', agent: id, status: 'working', message: `"${getTask(id).slice(0,50)}..."` });
    });

    const results = { kira: '', dex: '', max: '', mia: '', rex: '' };
    const [kiraData, dexData, maxData, miaData, rexData] = await Promise.all([
      research(getTask('kira'), chunk => { results.kira += chunk; sendEvent(res, { type: 'stream', agent: 'kira', chunk }); }),
      reason(getTask('dex'),    chunk => { results.dex  += chunk; sendEvent(res, { type: 'stream', agent: 'dex',  chunk }); }),
      code(getTask('max'),      chunk => { results.max  += chunk; sendEvent(res, { type: 'stream', agent: 'max',  chunk }); }),
      write(getTask('mia'),     chunk => { results.mia  += chunk; sendEvent(res, { type: 'stream', agent: 'mia',  chunk }); }),
      review(getTask('rex'),    chunk => { results.rex  += chunk; sendEvent(res, { type: 'stream', agent: 'rex',  chunk }); }),
    ]);

    [['kira',kiraData],['dex',dexData],['max',maxData],['mia',miaData],['rex',rexData]].forEach(([id,data]) => {
      sendEvent(res, { type: 'complete', agent: id, modelUsed: data.modelUsed, fallback: data.fallback });
    });

    sendEvent(res, { type: 'status', agent: 'nova', status: 'aggregating', message: '팀원 5명의 결과를 종합하고 있어요! ✨' });
    const combined = [
      `## Kira\n${kiraData.text||results.kira}`,
      `## Dex\n${dexData.text||results.dex}`,
      `## Max\n${maxData.text||results.max}`,
      `## Mia\n${miaData.text||results.mia}`,
      `## Rex\n${rexData.text||results.rex}`,
    ].join('\n\n---\n\n');

    const final = await aggregate(goal, combined, '', chunk => sendEvent(res, { type: 'stream', agent: 'nova_final', chunk }));
    sendEvent(res, { type: 'final', agent: 'nova', message: '모든 팀원의 작업이 완료됐어요! 🎉', modelUsed: final.modelUsed, fallback: final.fallback });

  } catch (err) {
    sendEvent(res, { type: 'error', message: err.message });
  } finally {
    closeSSE(res);
  }
});

app.listen(PORT, () => {
  console.log(`\n🐨 Quokka Agency [6-Agent] is running!`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`   API Key: ${process.env.NVIDIA_API_KEY ? '✅ loaded' : '❌ MISSING'}\n`);
  startDaemon();
  startDiscovery();
});
