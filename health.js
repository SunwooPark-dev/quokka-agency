require('dotenv').config();
const { pingModel, getHealthSummary } = require('./model-router');
const config = require('./models.config.json');
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

async function checkAll() {
  const allModels = [...new Set(Object.values(config).flat())];
  console.log(`\n[health] Checking ${allModels.length} models...\n`);
  await Promise.allSettled(allModels.map(async (modelId) => {
    const ok = await pingModel(modelId);
    console.log(`  ${ok ? '✅' : '❌'} ${modelId.padEnd(50)} → ${ok ? 'available' : 'UNAVAILABLE'}`);
  }));
  const summary = getHealthSummary();
  console.log('\n[health] Role summary:');
  for (const [role, models] of Object.entries(summary)) {
    const active = models.find(m => m.badge === 'primary' || m.badge === 'fallback');
    const icon = active?.badge === 'primary' ? '🟢' : active?.badge === 'fallback' ? '🟡' : '🔴';
    console.log(`  ${icon} ${role.padEnd(15)} → ${active?.modelId || 'NONE'} [${active?.badge||'degraded'}]`);
  }
  console.log(`\n[health] Next check in 30 minutes.\n`);
}

function startDaemon() {
  checkAll().catch(console.error);
  setInterval(() => checkAll().catch(console.error), CHECK_INTERVAL_MS);
  console.log('[health] Health daemon started (30min interval).');
}

module.exports = { checkAll, startDaemon };
if (require.main === module) checkAll().then(() => process.exit(0));
