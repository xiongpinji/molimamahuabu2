'use strict';

// Repository-owned isolation for the multi-input HTTP product regression.
// This is installed before any product module is loaded. It permits only the
// fixture's own loopback server, one disposable SQLite file, and the narrowly
// reviewed ffmpeg/ffprobe command shapes below.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const children = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

let installed = false;

function install() {
  if (installed) return globalThis.__g3MultiInputHttpGuard;
  installed = true;

  const backendRoot = path.resolve(__dirname, '..', '..');
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-multi-input-http-'));
  const { getFfmpegPath, getFfprobePath } = require('../../src/utils/ffmpegPath');
  const ffmpeg = getFfmpegPath();
  const ffprobe = getFfprobePath();
  // Do not inherit a developer machine's authentication mode or secret. This
  // process owns only a synthetic local actor and must exercise the public
  // platform's real 401/owner boundaries.
  process.env.NODE_ENV = 'test';
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_JWT_SECRET = 'redraw-multi-input-local-only-never-production';
  process.env.PLATFORM_SECURE_COOKIES = 'false';
  process.env.FFMPEG_PATH = ffmpeg;
  process.env.FFPROBE_PATH = ffprobe;
  process.env.TEMP = run;
  process.env.TMP = run;
  const attempts = [];
  const commands = [];
  const activeChildren = new Set();
  const servers = new Set();
  const deny = (kind) => {
    attempts.push(kind);
    throw Object.assign(new Error(`REDRAW_MULTI_INPUT_HTTP_FORBIDS_${kind}`), {
      code: `REDRAW_MULTI_INPUT_HTTP_FORBIDS_${kind}`,
    });
  };

  const local = Module.createRequire(path.join(backendRoot, 'package.json'));
  for (const [request, exports] of [
    ['./src/config/index.js', { loadConfig: () => deny('DEFAULT_CONFIG') }],
    ['./src/db/index.js', {
      getDb: () => deny('DEFAULT_DATABASE'),
      closeDb: () => deny('DEFAULT_DATABASE'),
    }],
  ]) {
    const id = local.resolve(request);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }

  const nativeListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    if (!(this instanceof http.Server) || args[0] !== 0 || args[1] !== '127.0.0.1') deny('LISTENER');
    servers.add(this);
    this.once('close', () => servers.delete(this));
    try {
      return nativeListen.apply(this, args);
    } catch (error) {
      servers.delete(this);
      throw error;
    }
  };

  function assertLivePort(host, port) {
    const numericPort = Number(port);
    if (host !== '127.0.0.1' || !Number.isSafeInteger(numericPort) || numericPort <= 0) deny('NETWORK');
    if (![...servers].some((server) => server.listening
      && server.address()?.address === host && server.address().port === numericPort)) deny('NETWORK');
  }

  const nativeConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (first && typeof first === 'object') {
      if (first.path || first.socketPath) deny('NETWORK');
      assertLivePort(first.host, first.port);
    } else {
      assertLivePort(typeof args[1] === 'string' ? args[1] : undefined, first);
    }
    return nativeConnect.apply(this, args);
  };

  tls.connect = () => deny('TLS');
  https.request = https.get = () => deny('TLS');
  function assertHttpTarget(input, options) {
    if (typeof input === 'string' || input instanceof URL) {
      const url = new URL(input);
      if (url.protocol !== 'http:' || url.username || url.password) deny('NETWORK');
      if (options && typeof options === 'object'
        && ['host', 'hostname', 'port', 'protocol', 'socketPath'].some((key) => key in options)) deny('OVERRIDE');
      assertLivePort(url.hostname, url.port || 80);
      return;
    }
    if (!input || input.socketPath || input.path?.startsWith('http')
      || (input.protocol && input.protocol !== 'http:')) deny('NETWORK');
    assertLivePort(input.hostname || input.host, input.port || 80);
  }
  for (const method of ['request', 'get']) {
    const nativeMethod = http[method];
    http[method] = function (...args) {
      assertHttpTarget(args[0], args[1]);
      return nativeMethod.apply(this, args);
    };
  }
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assertHttpTarget(typeof input === 'string' || input instanceof URL ? input : input?.url);
    if (init?.dispatcher) deny('DISPATCHER');
    return nativeFetch(input, { ...init, redirect: 'error' });
  };

  require('node:http2').connect = () => deny('HTTP2');
  require('node:worker_threads').Worker = class ForbiddenWorker {
    constructor() { deny('WORKER'); }
  };
  for (const key of ['bind', 'connect', 'send']) {
    require('node:dgram').Socket.prototype[key] = () => deny('DGRAM');
  }
  const dns = require('node:dns');
  const dnsNames = ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny',
    'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr',
    'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse'];
  for (const api of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    for (const key of dnsNames) if (typeof api[key] === 'function') api[key] = () => deny('DNS');
  }
  dns.lookup = (host, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (host !== '127.0.0.1' || typeof callback !== 'function') deny('DNS');
    process.nextTick(() => options?.all
      ? callback(null, [{ address: host, family: 4 }])
      : callback(null, host, 4));
  };

  const nativeLoad = Module._load;
  Module._load = function (request, ...args) {
    if (/^(?:dotenv|dotenv-expand)(?:\/|$)/.test(request) || request === 'node:sqlite') deny('CONFIG_OR_DATABASE_MODULE');
    return nativeLoad.call(this, request, ...args);
  };

  const Database = local('better-sqlite3');
  let databaseOpened = false;
  require.cache[local.resolve('better-sqlite3')].exports = new Proxy(Database, {
    construct(target, args) {
      if (databaseOpened || args.length !== 1 || path.resolve(args[0]) !== path.join(run, 'fixture.sqlite')) {
        deny('FOREIGN_DATABASE');
      }
      databaseOpened = true;
      const db = new target(...args);
      db.loadExtension = () => deny('SQLITE_EXTENSION');
      for (const method of ['exec', 'prepare']) {
        const original = db[method].bind(db);
        db[method] = (sql, ...rest) => {
          if (/\b(?:ATTACH|DETACH|VACUUM)\b/i.test(String(sql))) deny('SQLITE_EXTERNAL_FILE');
          return original(sql, ...rest);
        };
      }
      return db;
    },
    apply() { return deny('DATABASE_FACTORY'); },
  });

  const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  function ownFile(file, exists) {
    const absolute = path.resolve(String(file));
    const relative = path.relative(run, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) deny('FOREIGN_MEDIA');
    const target = exists ? absolute : path.dirname(absolute);
    if (fs.realpathSync(target) !== target) deny('FOREIGN_MEDIA');
    return absolute;
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const synthesisArgs = (audio) => ['-hide_banner', '-nostdin', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i',
    audio ? 'testsrc=size=128x192:rate=4' : 'testsrc=size=192x128:rate=4',
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=16000'] : []),
    '-t', audio ? '14' : '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
    ...(audio ? ['-c:a', 'aac', '-b:a', '32k'] : ['-an']), '-threads', '1',
    path.join(run, audio ? '02-portrait-synthetic-audio.mov' : '01-landscape-silent.mp4')];
  const contactSheetFilter = /^(?:crop=iw:ih\/3:0:ih\*2\/3,)?fps=[0-9.]+:round=up,scale=240:-1,drawtext=(?:fontfile=(?:\/Windows\/Fonts\/arial\.ttf|[A-Za-z]:\\Windows\\Fonts\\arial\.ttf):)?text='source %\{pts\\:hms\\:[0-9.]+\}':x=4:y=4:fontsize=12:fontcolor=white:box=1:boxcolor=black@0\.75,tile=4x\d+:nb_frames=\d+:padding=4:margin=4:color=black$/;

  function mediaCommand(file, args) {
    if (!Array.isArray(args)) deny('CHILD_ARGUMENTS');
    let command;
    let kind;
    let source;
    let output;
    if ([ffprobe, 'ffprobe', 'ffprobe.exe'].includes(file) && args.length === 7
      && (same(args.slice(0, 6), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json'])
        || same(args.slice(0, 6), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams']))) {
      command = ffprobe; kind = 'probe'; source = ownFile(args[6], true);
    } else if ([ffmpeg, 'ffmpeg', 'ffmpeg.exe'].includes(file)) {
      command = ffmpeg;
      if (same(args, synthesisArgs(false)) || same(args, synthesisArgs(true))) {
        kind = 'synthetic-source'; output = ownFile(args.at(-1), false);
        if (fs.existsSync(output)) deny('SOURCE_OVERWRITE');
      } else if (args.length === 14 && same(args, ['-hide_banner', '-loglevel', 'error', '-y', '-i', args[5],
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', args[13]])) {
        kind = 'audio-extract'; source = ownFile(args[5], true); output = ownFile(args[13], true);
        if (!source.endsWith('.bin') || !output.endsWith('.wav')) deny('AUDIO_PATH');
      } else if (args.length === 15 && same(args, ['-hide_banner', '-loglevel', 'error', '-y',
        '-ss', args[5], '-t', args[7], '-i', args[9], '-vf', args[11], '-frames:v', '1', args[14]])
        && /^\d+\.\d{3}$/.test(args[5]) && /^\d+\.\d{3}$/.test(args[7])
        && contactSheetFilter.test(args[11])) {
        kind = 'contact-sheet'; source = ownFile(args[9], true); output = ownFile(args[14], false);
        if (!output.endsWith('.jpg')) deny('SHEET_PATH');
      }
    }
    if (!kind) deny('CHILD_COMMAND');
    const record = { index: commands.length + 1, kind, command, arguments: args,
      source: source || null, source_sha256: source ? digest(source) : null, output: output || null };
    commands.push(record);
    return { record, command, args: ['-protocol_whitelist', 'file', ...args], options: {
      cwd: run,
      env: { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '', WINDIR: process.env.WINDIR || '' },
      windowsHide: true, shell: false, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    } };
  }
  function saveCommand(record, error, stdout, stderr) {
    record.exit_code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
    record.error_code = error && typeof error.code === 'string' ? error.code : null;
    fs.writeFileSync(path.join(run, `media-${record.index}.stdout.log`), stdout || '', { flag: 'wx' });
    fs.writeFileSync(path.join(run, `media-${record.index}.stderr.log`), stderr || '', { flag: 'wx' });
  }
  const nativeExecFile = children.execFile;
  const nativeSpawnSync = children.spawnSync;
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'fork']) children[key] = () => deny('CHILD');
  children.execFileSync = function (file, args) {
    const checked = mediaCommand(file, args);
    const result = nativeSpawnSync(checked.command, checked.args, checked.options);
    const error = result.error || (result.status !== 0 ? Object.assign(new Error('REDRAW_REAL_MEDIA_COMMAND_FAILED'), {
      code: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
    }) : null);
    saveCommand(checked.record, error, result.stdout, result.stderr);
    if (error) throw error;
    return result.stdout;
  };
  children.execFile = function (file, args, options, callback) {
    if (typeof callback !== 'function') deny('CHILD_CALLBACK');
    const checked = mediaCommand(file, args);
    const child = nativeExecFile(checked.command, checked.args, checked.options, (error, stdout, stderr) => {
      saveCommand(checked.record, error, stdout, stderr);
      callback(error, stdout, stderr);
    });
    activeChildren.add(child);
    child.once('close', () => activeChildren.delete(child));
    return child;
  };
  children.execFile[require('node:util').promisify.custom] = (...args) => new Promise((resolve, reject) => {
    children.execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  });
  Module.syncBuiltinESMExports();

  globalThis.__g3MultiInputHttpGuard = { run, ffmpeg, ffprobe, commands };
  process.on('exit', () => {
    for (const child of activeChildren) child.kill();
    const receipt = { attempts, commands, active_children_at_exit: activeChildren.size,
      network: 'Only this process own ephemeral 127.0.0.1 HTTP listener/client; no external DNS or network.',
      configuration: 'Default config/db entrypoints denied; one fresh task-owned SQLite only.' };
    try {
      fs.writeFileSync(path.join(run, 'guard-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    } catch (_) {}
  });
  return globalThis.__g3MultiInputHttpGuard;
}

module.exports = { install };
