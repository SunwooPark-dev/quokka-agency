const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getModel } = require('../model-router');
const personas = require('./personas.json');

async function decompose(goal) {
  const { modelId, fallback } = await getModel('orchestrator');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'system', content: personas.nova.system_prompt }, { role: 'user', content: `Goal: ${goal}` }], max_tokens: 800, temperature: 0.3, stream: false }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Orchestrator API error: ${response.status}`);
    const data = await response.json();
    let content = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    try { return { ...JSON.parse(content), modelUsed: modelId, fallback }; }
    catch (e) { return { analysis: goal, greeting: '팀, 시작해봐요! 🚀', tasks: [{ id:'1', agent:'kira', type:'research', task: goal }, { id:'2', agent:'max', type:'code', task: goal }], modelUsed: modelId, fallback }; }
  } finally { clearTimeout(timer); }
}

async function aggregate(goal, kiraResult, maxResult, onChunk) {
  const { modelId, fallback } = await getModel('aggregator');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'system', content: personas.nova_aggregator.system_prompt }, { role: 'user', content: `Goal: ${goal}\n\n${kiraResult}` }], max_tokens: 2000, temperature: 0.5, stream: true }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Aggregator API error: ${response.status}`);
    const { parseNIMStream } = require('../stream');
    const fullText = await parseNIMStream(response, onChunk);
    return { text: fullText, modelUsed: modelId, fallback };
  } finally { clearTimeout(timer); }
}

module.exports = { decompose, aggregate };
