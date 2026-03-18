const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getModel } = require('../model-router');
const { parseNIMStream } = require('../stream');
const personas = require('./personas.json');

async function research(task, onChunk) {
  const { modelId, fallback } = await getModel('researcher');
  const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId, messages: [{ role: 'system', content: personas.kira.system_prompt }, { role: 'user', content: task }], max_tokens: 2048, temperature: 0.6, stream: true }),
  });
  if (!response.ok) throw new Error(`Researcher API error: ${response.status}`);
  const fullText = await parseNIMStream(response, onChunk);
  return { text: fullText, modelUsed: modelId, fallback };
}

module.exports = { research };
