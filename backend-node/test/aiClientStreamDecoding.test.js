'use strict';

// 流式文本输出按流解码：多字节字符（带重音的字母、中文）被拆在两个数据块里时不能变成乱码。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { postJSONStream } = require('../src/services/aiClient');

function splitServer(pieces) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const piece of pieces) {
        res.write(piece);
        // 分开发送，客户端才会收到独立的数据块。
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('a character split across two stream chunks is decoded intact', async () => {
  const event = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: '“Área de combate”，林江说：¿Qué pasó?' } }] })}\n\n`);
  const accent = event.indexOf(Buffer.from('Á'));
  const han = event.indexOf(Buffer.from('林'));
  // 把 "Á" 的两个字节、"林" 的三个字节都从中间切开。
  const pieces = [event.subarray(0, accent + 1), event.subarray(accent + 1, han + 2), event.subarray(han + 2), Buffer.from('data: [DONE]\n\n')];
  const server = await splitServer(pieces);
  try {
    const { port } = server.address();
    const result = await postJSONStream(`http://127.0.0.1:${port}/v1/chat/completions`, {}, { model: 'm', messages: [] }, 5000);
    assert.equal(result.body, '“Área de combate”，林江说：¿Qué pasó?');
    assert.doesNotMatch(result.body, /�/);
  } finally {
    server.close();
  }
});
