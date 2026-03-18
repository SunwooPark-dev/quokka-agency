/**
 * stream.js — Quokka Agency SSE Utilities (hardened)
 *
 * 핵심 수정:
 *  - res._sseEnded 플래그로 이중 write/end 방지 (ERR_STREAM_WRITE_AFTER_END 해결)
 *  - req.on('close') 핸들러와 finally 블록의 충돌 제거
 */

function initSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res._sseEnded = false; // 가드 플래그 초기화
}

function sendEvent(res, data) {
  if (res._sseEnded || res.writableEnded) return; // 이미 종료된 경우 무시
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (e) {
    res._sseEnded = true; // 클라이언트 끚김
  }
}

function closeSSE(res) {
  if (res._sseEnded || res.writableEnded) return; // 이중 호출 방지
  res._sseEnded = true;
  try {
    res.write('data: {"type":"done"}\n\n');
    res.end();
  } catch (e) {
    // 클라이언트가 이미 끚긴 경우 무시
  }
}

/**
 * Parse NVIDIA NIM streaming response (SSE from NVIDIA API).
 * Calls onChunk(text) for each streamed token.
 */
async function parseNIMStream(response, onChunk) {
  let fullText = '';
  const reader = response.body;
  let buffer = '';

  for await (const chunk of reader) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // last incomplete line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') return fullText;
      try {
        const json = JSON.parse(raw);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          onChunk(delta);
        }
      } catch (e) {
        // Skip malformed chunks
      }
    }
  }
  return fullText;
}

module.exports = { initSSE, sendEvent, closeSSE, parseNIMStream };
