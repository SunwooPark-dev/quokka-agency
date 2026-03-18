const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const config = require('./models.config.json');
const modelStatus = {};

async function pingModel(modelId) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const available = res.status < 500;
    modelStatus[modelId] = { available, lastChecked: Date.now(), latencyMs: Date.now()-start, httpStatus: res.status };
    return available;
  } catch (e) {
    clearTimeout(timer);
    modelStatus[modelId] = { available: false, lastChecked: Date.now(), latencyMs: null, error: e.message };
    return false;
  }
}

async function getModel(role) {
  const candidates = config[role] || config.orchestrator;
  for (const modelId of candidates) {
    const status = modelStatus[modelId];
    if (status && (Date.now() - status.lastChecked) < 30 * 60 * 1000) {
      if (status.available) return { modelId, isPrimary: modelId === candidates[0], fallback: modelId !== candidates[0] };
      continue;
    }
    if (await pingModel(modelId)) return { modelId, isPrimary: modelId === candidates[0], fallback: modelId !== candidates[0] };
  }
  return { modelId: candidates[0], isPrimary: false, fallback: true, degraded: true };
}

function getHealthSummary() {
  const summary = {};
  for (const [role, models] of Object.entries(config)) {
    summary[role] = models.map(modelId => ({
      modelId, ...modelStatus[modelId],
      badge: !modelStatus[modelId] ? 'unknown' : modelStatus[modelId].available ? (modelId === models[0] ? 'primary' : 'fallback') : 'degraded',
    }));
  }
  return summary;
}

module.exports = { getModel, pingModel, getHealthSummary, modelStatus };
