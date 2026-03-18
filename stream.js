function initSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
}

function sendEvent(res, data) {
  try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) {}
}

function closeSSE(res) {
  try { res.write('data: {"type":"done"}\n\n'); res.end(); } catch (e) {}
}

async function parseNIMStream(response, onChunk) {
  let fullText = '';
  const reader = response.body;
  let buffer = '';
  for await (const chunk of reader) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') return fullText;
      try {
        const json = JSON.parse(raw);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) { fullText += delta; onChunk(delta); }
      } catch (e) {}
    }
  }
  return fullText;
}

module.exports = { initSSE, sendEvent, closeSSE, parseNIMStream };
