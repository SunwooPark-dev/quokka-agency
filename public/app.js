/**
 * app.js — Quokka Agency 6-Agent Frontend
 */
function renderMarkdown(text) {
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/```(\w*)\n([\s\S]*?)```/g,(_,lang,code)=>`<pre><code class="lang-${lang}">${code.trim()}</code></pre>`)
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>')
    .replace(/^### (.+)$/gm,'<h3>$1</h3>').replace(/^## (.+)$/gm,'<h2>$1</h2>').replace(/^# (.+)$/gm,'<h1>$1</h1>')
    .replace(/^---$/gm,'<hr>').replace(/^- (.+)$/gm,'<li>$1</li>')
    .replace(/\n\n/g,'</p><p>');
}

const AGENTS = { nova:{color:'#7c3aed'}, kira:{color:'#0ea5e9'}, dex:{color:'#f59e0b'}, max:{color:'#10b981'}, mia:{color:'#ec4899'}, rex:{color:'#6366f1'} };
const streamBuffers = {};
let isRunning = false, currentES = null;

const $ = id => document.getElementById(id);
const setStatus = (id,t) => { if ($(`status-${id}`)) $(`status-${id}`).textContent = t; };
const setBubble = (id,t) => { if ($(`bubble-${id}`)) $(`bubble-${id}`).innerHTML = `<p>${t}</p>`; };
const setDot = (id,cls) => { const d = $(`badge-${id}`)?.querySelector('.dot'); if(d) d.className=`dot dot-${cls}`; };
const setCard = (id,cls) => {
  const c = $(`card-${id}`); if(!c) return;
  c.className = c.className.replace(/\s*(working|done|error)\s*/g,' ').trim();
  if(cls) c.classList.add(cls, `agent-${id}`);
};
const appendOutput = (id,chunk) => {
  const el = $(`output-${id}`); if(!el) return;
  if(!streamBuffers[id]) streamBuffers[id]='';
  streamBuffers[id]+=chunk;
  el.innerHTML=renderMarkdown(streamBuffers[id]);
  el.scrollTop=el.scrollHeight;
};

function resetAll() {
  Object.keys(AGENTS).forEach(id => { setDot(id,'idle'); setStatus(id,'\ub300\uae30 \uc911'); setCard(id,''); streamBuffers[id]=''; const o=$(`output-${id}`); if(o) o.innerHTML=''; });
  const rs=$('resultSection'); if(rs) rs.style.display='none';
  $('finalResult').innerHTML=''; streamBuffers['nova_final']='';
}

function handleEvent(data) {
  switch(data.type) {
    case 'status': {
      const {agent,status,message}=data;
      if(agent==='nova'&&status==='thinking') { setBubble('nova',message); setStatus('nova','\ubd84\uc11d \uc911...'); setDot('nova','working'); setCard('nova','active'); }
      else if(agent==='nova'&&status==='aggregating') { setBubble('nova',message); setStatus('nova','\ucde8\ud569 \uc911...'); setDot('nova','working'); }
      else if(status==='working') { setBubble(agent,message); setStatus(agent,'\uc791\uc5c5 \uc911...'); setDot(agent,'working'); setCard(agent,'working'); }
      break;
    }
    case 'orchestrate': {
      const {message,modelUsed}=data;
      setBubble('nova',message); setStatus('nova',`\u2713 ${modelUsed?.split('/').pop()}`);
      if($('model-nova')) $('model-nova').textContent=modelUsed?.split('/').pop()||'nova';
      break;
    }
    case 'stream': {
      const {agent,chunk}=data;
      appendOutput(agent==='nova_final'?'nova':agent,chunk);
      break;
    }
    case 'complete': {
      const {agent,modelUsed,fallback}=data;
      setDot(agent,'done'); setStatus(agent,`\u2713 ${fallback?'\ud3f4\ubc31 ':''}${modelUsed?.split('/').pop()}`);
      setCard(agent,'done');
      const b=$(`model-${agent}`); if(b&&modelUsed) b.textContent=modelUsed.split('/').pop();
      break;
    }
    case 'final': {
      setDot('nova','done'); setBubble('nova',data.message); setStatus('nova','\u2713 \uc644\ub8cc');
      const rs=$('resultSection'); if(rs) rs.style.display='block';
      if(streamBuffers['nova_final']) $('finalResult').innerHTML=renderMarkdown(streamBuffers['nova_final']);
      break;
    }
    case 'error': {
      Object.keys(AGENTS).forEach(id=>setDot(id,'idle'));
      setBubble('nova',`\u274c \uc624\ub958: ${data.message}`);
      addLog(`\uc624\ub958: ${data.message}`);
      break;
    }
  }
}

async function submitGoal() {
  const input=$('goalInput'); const goal=input.value.trim();
  if(!goal||isRunning) return;
  isRunning=true; $('goBtn').disabled=true; $('goBtn').textContent='\uc2e4\ud589 \uc911...';
  resetAll(); addLog(`\uc0c8 \uc791\uc5c5: ${goal.slice(0,60)}...`);
  if(currentES){currentES.abort();currentES=null;}
  const controller=new AbortController(); currentES=controller;
  try {
    const response=await fetch('/api/task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({goal}),signal:controller.signal});
    const reader=response.body.getReader(); const decoder=new TextDecoder(); let buffer='';
    while(true) {
      const {value,done}=await reader.read(); if(done) break;
      buffer+=decoder.decode(value,{stream:true});
      const lines=buffer.split('\n'); buffer=lines.pop();
      for(const line of lines) {
        if(line.startsWith('data: ')) { try{handleEvent(JSON.parse(line.slice(6)));}catch{} }
      }
    }
  } catch(e) { if(e.name!=='AbortError') setBubble('nova',`\uc5f0\uacb0 \uc624\ub958: ${e.message}`); }
  finally { isRunning=false; $('goBtn').disabled=false; $('goBtn').textContent='GO! \ud83d\ude80'; currentES=null; }
}

async function loadHealth() {
  try {
    const res=await fetch('/api/health'); const data=await res.json();
    const dots=$('healthDots'); if(!dots) return;
    dots.innerHTML='';
    for(const [role,models] of Object.entries(data.models)) {
      const primary=models.find(m=>m.badge==='primary');
      const div=document.createElement('div');
      div.className=`health-dot ${primary?.available?'green':'red'}`;
      div.title=`${role}: ${primary?.modelId||'none'}`;
      dots.appendChild(div);
    }
  } catch{}
}

function addLog(text) {
  const log=$('taskLog'); if(!log) return;
  const now=new Date().toLocaleTimeString('ko-KR',{hour12:false});
  const entry=document.createElement('div'); entry.className='log-entry';
  entry.innerHTML=`<span class="log-time">${now}</span><span class="log-text">${text}</span>`;
  log.prepend(entry);
  const entries=log.querySelectorAll('.log-entry');
  if(entries.length>50) entries[entries.length-1].remove();
}

function openCLIModal() { $('cliModal').style.display='flex'; }
function closeCLIModal(e) { if(e.target.id==='cliModal') $('cliModal').style.display='none'; }

function copyCmd(el) {
  navigator.clipboard.writeText(el.querySelector('code').textContent).then(()=>{
    const s=el.querySelector('span'); const orig=s.textContent;
    s.textContent='\u2713 \ubcf5\uc0ac\ub428!'; setTimeout(()=>s.textContent=orig,1500);
  });
}

function copyResult() {
  navigator.clipboard.writeText($('finalResult').innerText).then(()=>{
    const btn=document.querySelector('.btn-copy'); btn.textContent='\u2713 \ubcf5\uc0ac\ub428!';
    setTimeout(()=>btn.textContent='\ud83d\udccb \ubcf5\uc0ac',2000);
  });
}

document.addEventListener('DOMContentLoaded',()=>{
  loadHealth(); setInterval(loadHealth,60000);
  $('goalInput').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submitGoal();} });
});
