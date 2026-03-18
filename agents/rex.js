const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getModel } = require('../model-router');
const { parseNIMStream } = require('../stream');
const personas = require('./personas.json');

async function review(task, onChunk) {
  const { modelId, fallback } = await getModel('reviewer');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'system', content: personas.rex.system_prompt }, { role: 'user', content: task }], max_tokens: 1500, temperature: 0.3, stream: true }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Rex API error: ${response.status}`);
    const fullText = await parseNIMStream(response, onChunk);
    return { text: fullText, modelUsed: modelId, fallback };
  } finally { clearTimeout(timer); }
}

module.exports = { review };
