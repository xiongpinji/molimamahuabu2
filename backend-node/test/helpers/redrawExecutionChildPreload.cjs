'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');
const localRequire = createRequire(path.join(__dirname, '../../package.json'));
const denied = (kind) => () => { throw new Error(`REDRAW_EXECUTION_TEST_FORBIDS_${kind}`); };

for (const [name, exports] of [
  ['./src/config/index.js', { loadConfig: denied('DEFAULT_CONFIG') }],
  ['./src/db/index.js', { getDb: denied('DEFAULT_DATABASE'), closeDb: denied('DEFAULT_DATABASE') }],
]) {
  const id = localRequire.resolve(name);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
global.fetch = denied('NETWORK');
for (const protocol of ['node:http', 'node:https']) {
  const api = require(protocol);
  api.request = denied('NETWORK'); api.get = denied('NETWORK');
}
for (const protocol of ['node:net', 'node:tls']) {
  const api = require(protocol);
  api.connect = denied('NETWORK');
  if (api.createConnection) api.createConnection = denied('NETWORK');
}
