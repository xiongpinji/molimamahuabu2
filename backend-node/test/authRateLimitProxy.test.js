const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const { configureTrustedProxy } = require('../src/app');

function requestIp(app, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const request = http.get({ port, path: '/ip', headers }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          server.close(() => {
            try {
              resolve(JSON.parse(body).ip);
            } catch (error) {
              reject(error);
            }
          });
        });
      });
      request.on('error', (error) => server.close(() => reject(error)));
    });
    server.on('error', reject);
  });
}

test('仅信任本机反代并解析 X-Forwarded-For 的真实客户端 IP', async () => {
  const app = express();
  configureTrustedProxy(app);
  app.get('/ip', (req, res) => res.json({ ip: req.ip }));

  assert.equal(await requestIp(app, { 'X-Forwarded-For': '203.0.113.9' }), '203.0.113.9');
});

