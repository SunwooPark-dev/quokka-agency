require('dotenv').config();
const KNOWN = new Set();

async function discoverModels() {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10000);
    const res = await fetch('https://integrate.api.nvidia.com/v1/models', {
      headers: { 'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}` }, signal: controller.signal,
    });
    if (!res.ok) return [];
    const { data = [] } = await res.json();
    const newModels = data.filter(m => !KNOWN.has(m.id));
    newModels.forEach(m => KNOWN.add(m.id));
    if (newModels.length > 0) {
      console.log(`\n[discovery] 🆕 ${newModels.length} new models detected on NVIDIA NIM!`);
      newModels.forEach(m => console.log(`  → ${m.id}`));
      console.log('[discovery] Consider updating models.config.json with new alternatives.\n');
    }
    return data;
  } catch (e) { console.warn(`[discovery] Error: ${e.message}`); return []; }
}

async function startDiscovery(intervalMs = 60 * 60 * 1000) {
  await discoverModels();
  setInterval(discoverModels, intervalMs);
  console.log('[discovery] Auto-discovery started (1hr interval).');
}

module.exports = { discoverModels, startDiscovery };
if (require.main === module) discoverModels().then(m => { console.log(`\nTotal: ${m.length}`); process.exit(0); });
