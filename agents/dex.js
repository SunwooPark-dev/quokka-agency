const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getModel } = require('../model-router');
const { parseNIMStream } = require('../stream');
const personas = require('./personas.json');

async function reason(task, onChunk) {
  const { modelId, fallback } = await getModel('reasoner');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'system', content: personas.dex.system_prompt }, { role: 'user', content: task }], max_tokens: 2048, temperature: 0.4, stream: true }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Dex API error: ${response.status}`);
    const fullText = await parseNIMStream(response, (chunk) => {
      const filtered = chunk.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (filtered) onChunk(filtered);
    });
    return { text: fullText.replace(/<think>[\s\S]*?<\/think>/g, '').trim(), modelUsed: modelId, fallback };
  } finally { clearTimeout(timer); }
}

module.exports = { reason };
