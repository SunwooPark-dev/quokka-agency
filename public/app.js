/**
 * app.js — Quokka Agency 6-Agent Frontend
 * SSE client, real-time UI updates for Nova + 5 specialists.
 */

// ─── Markdown renderer ────────────────────────────────────────────────────────
function renderMarkdown(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^---$/gm, '<hr>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '</p><p>');
}

// ─── Agent config ─────────────────────────────────────────────────────────────
const AGENTS = {
  nova:  { color: '#7c3aed' },
  kira:  { color: '#0ea5e9' },
  dex:   { color: '#f59e0b' },
  max:   { color: '#10b981' },
  mia:   { color: '#ec4899' },
  rex:   { color: '#6366f1' },
};

const streamBuffers = {};
let isRunning = false;
let currentES = null;

// ─── DOM helpers ──────────────────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
const setStatus   = (id, text) => { if ($(`status-${id}`)) $(`status-${id}`).textContent = text; };
const setBubble   = (id, text) => { if ($(`bubble-${id}`)) $(`bubble-${id}`).innerHTML = `<p>${text}</p>`; };
const setDot      = (id, cls)  => {
  const dot = $(`badge-${id}`)?.querySelector('.dot');
  if (dot) dot.className = `dot dot-${cls}`;
};
const setCard     = (id, cls)  => {
  const card = $(`card-${id}`);
  if (!card) return;
  card.className = card.className.replace(/\s*(working|done|error)\s*/g, ' ').trim();
  if (cls) card.classList.add(cls, `agent-${id}`);
};
const appendOutput = (id, chunk) => {
  const el = $(`output-${id}`);
  if (!el) return;
  if (!streamBuffers[id]) streamBuffers[id] = '';
  streamBuffers[id] += chunk;
  el.innerHTML = renderMarkdown(streamBuffers[id]);
  el.scrollTop = el.scrollHeight;
};

function resetAll() {
  Object.keys(AGENTS).forEach(id => {
    setDot(id, 'idle');
    setStatus(id, '대기 중');
    setCard(id, '');
    streamBuffers[id] = '';
    const out = $(`output-${id}`);
    if (out) out.innerHTML = '';
  });
  const rs = $('resultSection');
  if (rs) rs.style.display = 'none';
  $('finalResult').innerHTML = '';
  streamBuffers['nova_final'] = '';
}

// ─── SSE Handler ──────────────────────────────────────────────────────────────
function handleEvent(data) {
  switch (data.type) {

    case 'status': {
      const { agent, status, message } = data;
      if (agent === 'nova' && status === 'thinking') {
        setBubble('nova', message);
        setStatus('nova', '분석 중...');
        setDot('nova', 'working');
        setCard('nova', 'active');
      } else if (agent === 'nova' && status === 'aggregating') {
        setBubble('nova', message);
        setStatus('nova', '취합 중...');
        setDot('nova', 'working');
      } else if (status === 'working') {
        setBubble(agent, message);
        setStatus(agent, '작업 중...');
        setDot(agent, 'working');
        setCard(agent, 'working');
      }
      break;
    }

    case 'orchestrate': {
      const { message, modelUsed } = data;
      setBubble('nova', message);
      setStatus('nova', `✓ ${modelUsed?.split('/').pop()}`);
      if ($('model-nova')) $('model-nova').textContent = modelUsed?.split('/').pop() || 'nova';
      break;
    }

    case 'stream': {
      const { agent, chunk } = data;
      appendOutput(agent === 'nova_final' ? 'nova' : agent, chunk);
      break;
    }

    case 'complete': {
      const { agent, modelUsed, fallback } = data;
      setDot(agent, 'done');
      setStatus(agent, `✓ ${fallback ? '폴백 ' : ''}${modelUsed?.split('/').pop()}`);
      setCard(agent, 'done');
      const badgeName = $(`model-${agent}`);
      if (badgeName && modelUsed) badgeName.textContent = modelUsed.split('/').pop();
      break;
    }

    case 'final': {
      setDot('nova', 'done');
      setBubble('nova', data.message);
      setStatus('nova', `✓ 완료`);
      const rs = $('resultSection');
      if (rs) rs.style.display = 'block';
      if (streamBuffers['nova_final']) {
        $('finalResult').innerHTML = renderMarkdown(streamBuffers['nova_final']);
      }
      break;
    }

    case 'error': {
      Object.keys(AGENTS).forEach(id => setDot(id, 'idle'));
      setBubble('nova', `❌ 오류: ${data.message}`);
      setStatus('nova', '오류');
      addLog(`오류: ${data.message}`);
      break;
    }

    case 'error_partial': {
      // 특정 에이전트만 실패, 나머지 계속 진행
      const { agent } = data;
      setDot(agent, 'error');
      setStatus(agent, '⚠️ 오류 (폴백 시도)');
      setCard(agent, 'done');
      addLog(`${agent.toUpperCase()} 에이전트 오류 - 폴백 모델로 재시도 중`);
      break;
    }
  }
}

// ─── Task Submission ──────────────────────────────────────────────────────────
async function submitGoal() {
  const input = $('goalInput');
  const goal = input.value.trim();
  if (!goal || isRunning) return;

  isRunning = true;
  $('goBtn').disabled = true;
  $('goBtn').textContent = '실행 중...';
  resetAll();
  addLog(`새 작업: ${goal.slice(0, 60)}...`);

  if (currentES) { currentES.abort(); currentES = null; }

  const controller = new AbortController();
  currentES = controller;

  try {
    const response = await fetch('/api/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal }),
      signal: controller.signal,
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            handleEvent(data);
          } catch {}
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      setBubble('nova', `연결 오류: ${e.message}`);
    }
  } finally {
    isRunning = false;
    $('goBtn').disabled = false;
    $('goBtn').textContent = 'GO! 🚀';
    currentES = null;
  }
}

// ─── Health check (3-tier: green/yellow/red) ──────────────────────────────────
async function loadHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    const dots = $('healthDots');
    if (!dots) return;
    dots.innerHTML = '';

    for (const [role, models] of Object.entries(data.models)) {
      const primary  = models.find(m => m.badge === 'primary');
      const fallback = models.find(m => m.badge === 'fallback' && m.available);
      const anyOk    = models.some(m => m.available);

      let statusClass = 'red';
      let title       = `${role}: 모든 모델 다운`;
      if (primary?.available) {
        statusClass = 'green';
        title = `${role}: ${primary.modelId?.split('/').pop()} (정상)`;
      } else if (fallback) {
        statusClass = 'yellow';
        title = `${role}: ${fallback.modelId?.split('/').pop()} (폴백 사용 중)`;
      } else if (anyOk) {
        statusClass = 'yellow';
        title = `${role}: 폴백 모델 작동 중`;
      }

      const div = document.createElement('div');
      div.className = `health-dot ${statusClass}`;
      div.title = title;
      dots.appendChild(div);
    }
  } catch (e) {
    const dots = $('healthDots');
    if (dots) dots.querySelectorAll('.health-dot').forEach(d => d.className = 'health-dot red');
  }
}

// ─── Log ──────────────────────────────────────────────────────────────────────
function addLog(text) {
  const log = $('taskLog');
  if (!log) return;
  const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-time">${now}</span><span class="log-text">${text}</span>`;
  log.prepend(entry);
  const entries = log.querySelectorAll('.log-entry');
  if (entries.length > 50) entries[entries.length - 1].remove();
}

// ─── CLI Modal ────────────────────────────────────────────────────────────────
function openCLIModal() {
  $('cliModal').style.display = 'flex';
}

function closeCLIModal(e) {
  if (e.target.id === 'cliModal') $('cliModal').style.display = 'none';
}

function copyCmd(el) {
  const cmd = el.querySelector('code').textContent;
  navigator.clipboard.writeText(cmd).then(() => {
    const orig = el.querySelector('span').textContent;
    el.querySelector('span').textContent = '✓ 복사됨!';
    setTimeout(() => { el.querySelector('span').textContent = orig; }, 1500);
  });
}

function copyResult() {
  const text = $('finalResult').innerText;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.querySelector('.btn-copy');
    btn.textContent = '✓ 복사됨!';
    setTimeout(() => { btn.textContent = '📋 복사'; }, 2000);
  });
}

// ─── Keyboard shortcut ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadHealth();
  setInterval(loadHealth, 60000);

  $('goalInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitGoal();
    }
  });
});
