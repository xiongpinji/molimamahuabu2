'use strict';

const path = require('node:path');
const { runCli } = require('../src/services/canvasCreditReleaseContract');

runCli(process.argv.slice(2), path.resolve(__dirname, '..', '..'));
