/**
 * orchestrator.js — Nova's brain (v2 hardened)
 *
 * 수정 내역:
 *  - decompose(): 5명 에이전트 전체에게 업무 할당하는 구체적 프롬프트
 *  - aggregate(): 2-agent → 5-agent 결과 취합으로 확장
 *  - availableAgents 파라닸터: 다운 에이전트 리스트 받아 살아있는 에이전트에만 재분배
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getModel } = require('../model-router');

const personas = require('./personas.json');

// ─── 에이전트 역할 정의 ─────────────────────────────────────────────────────
const AGENT_ROLES = {
  kira: { name: 'Kira', role: 'researcher',  desc: '조사, 분석, 리서치' },
  dex:  { name: 'Dex',  role: 'reasoner',    desc: '논리적 추론, 문제 분해' },
  max:  { name: 'Max',  role: 'coder',       desc: '코드 작성, 구현' },
  mia:  { name: 'Mia',  role: 'writer',      desc: '문서화, 글쓰기, 요약' },
  rex:  { name: 'Rex',  role: 'reviewer',    desc: '검토, QA, 개선 제안' },
};

/**
 * decompose(goal, availableAgents?)
 *
 * goal: 사용자 목표
 * availableAgents: 사용 가능한 에이전트 ID 배열 (없으면 전원 사용)
 *   → 다운된 에이전트를 제외하고 살아있는 에이전트에만 업무 분배
 */
async function decompose(goal, availableAgents = ['kira', 'dex', 'max', 'mia', 'rex']) {
  const { modelId, fallback } = await getModel('orchestrator');

  const agentList = availableAgents.map(id => {
    const a = AGENT_ROLES[id];
    return a ? `- ${a.name} (agent_id: "${id}"): ${a.desc}` : null;
  }).filter(Boolean).join('\n');

  const systemPrompt = `당신은 Quokka Agency의 리더 Nova입니다.
사용자의 목표를 분석하고, 현재 사용 가능한 팀원들에게 **반드시 구체적인 업무를 할당**해야 합니다.

사용 가능한 팀원:
${agentList}

**중요 규칙:**
1. 모든 사용 가능한 팀원에게 반드시 업무를 할당해야 합니다.
2. 각 업무는 구체적이고 실행 가능해야 합니다. "분석해줘" 관신 아니라 "X에 대해 Y 관점에서 Z를 조사해줘"쳌럼 명확히.
3. 응답은 반드시 아래 JSON 형식이어야 합니다. 다른 텍스트 없이 JSON만.

응답 형식:
{
  "analysis": "목표에 대한 한 줄 요약",
  "greeting": "팀원들에게 보내는 활기찬 한국어 메시지",
  "tasks": [
    { "id": "1", "agent": "에이전트ID", "type": "작업유형", "task": "구체적인 작업 지시 (2-3문장)" }
  ]
}`;

  const controller = new AbortController();
  let timer;

  try {
    timer = setTimeout(() => controller.abort(), 90000);

    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `목표: ${goal}` },
        ],
        max_tokens: 1200,
        temperature: 0.3,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Orchestrator API error: ${response.status} — ${err}`);
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content || '';

    content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    content = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) content = jsonMatch[0];

    try {
      const parsed = JSON.parse(content);
      if (!parsed.tasks || parsed.tasks.length === 0) {
        parsed.tasks = _defaultTasks(goal, availableAgents);
      }
      return { ...parsed, modelUsed: modelId, fallback };
    } catch (e) {
      console.error('[orchestrator] JSON parse failed, using default tasks');
      return _buildDefault(goal, availableAgents, modelId, fallback);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function _defaultTasks(goal, agents) {
  const taskTemplates = {
    kira: `다음 주제에 대한 구체적인 배경, 현황, 트렌드를 조사하세요: "${goal}"`,
    dex:  `다음 문제의 핵심 요인을 논리적으로 분해하고 해결 방향을 추론하세요: "${goal}"`,
    max:  `다음 목표를 달성하는 코드 또는 기술적 구현 방안을 작성하세요: "${goal}"`,
    mia:  `다음 내용을 명확하고 구조적인 문서로 작성하세요: "${goal}"`,
    rex:  `다음 작업의 결과물을 검토하고 개선점과 리스크를 제시하세요: "${goal}"`,
  };
  return agents.map((id, i) => ({
    id: String(i + 1),
    agent: id,
    type: AGENT_ROLES[id]?.role || 'task',
    task: taskTemplates[id] || `"${goal}"에 관한 업무를 처리하세요.`,
  }));
}

function _buildDefault(goal, agents, modelId, fallback) {
  return {
    analysis: goal,
    greeting: `팀원들, 시작합시다! 각자 할당된 업무를 처리해주세요 💪`,
    tasks: _defaultTasks(goal, agents),
    modelUsed: modelId,
    fallback,
  };
}

/**
 * aggregate(goal, agentResults, onChunk)
 * agentResults: [{agent, text}] 배열 — 5명 모두의 결과
 */
async function aggregate(goal, agentResults, _unused, onChunk) {
  const { modelId, fallback } = await getModel('aggregator');

  const resultsText = typeof agentResults === 'string'
    ? agentResults
    : agentResults.map(r => `## ${(AGENT_ROLES[r.agent]?.name || r.agent)} 결과\n${r.text || '(출력 없음)'}`).join('\n\n---\n\n');

  const persona = personas.nova_aggregator || personas.nova;
  const userMsg = `원래 목표: ${goal}\n\n${resultsText}`;

  const controller = new AbortController();
  let timer;

  try {
    timer = setTimeout(() => controller.abort(), 90000);

    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: persona.system_prompt },
          { role: 'user', content: userMsg },
        ],
        max_tokens: 2000,
        temperature: 0.5,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Aggregator API error: ${response.status} — ${err}`);
    }

    const { parseNIMStream } = require('../stream');
    const fullText = await parseNIMStream(response, onChunk);
    return { text: fullText, modelUsed: modelId, fallback };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { decompose, aggregate, AGENT_ROLES };
