const { spawnSync } = require('node:child_process');

const ALLOWED_PROJECTS = new Set(['backend-node', 'frontweb']);
const NETWORK_FAILURE = /audit network timeout|audit endpoint returned an error|\b(?:ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|ECONNREFUSED)\b/i;
const AUDIT_FINDINGS = /# npm audit report|\b\d+\s+(?:low|moderate|high|critical)\s+severity vulnerabilit(?:y|ies)\b/i;

function runProductionAudit(project, options = {}) {
  if (!ALLOWED_PROJECTS.has(project)) {
    throw new Error(`Unsupported npm audit project: ${project}`);
  }

  const spawn = options.spawn || spawnSync;
  const write = options.write || ((chunk) => process.stdout.write(chunk));
  const auditArgs = [
    '--prefix',
    project,
    'audit',
    '--omit=dev',
    '--audit-level=high',
    '--registry=https://registry.npmjs.org',
  ];
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm', ...auditArgs]
    : auditArgs;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = spawn(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    });
    const output = [result.stdout, result.stderr, result.error?.message]
      .filter(Boolean)
      .join('');
    write(output);

    const status = Number.isInteger(result.status) ? result.status : 1;
    if (status === 0) return 0;
    if (attempt === 1 && NETWORK_FAILURE.test(output) && !AUDIT_FINDINGS.test(output)) {
      write('[dependency-security] network failure detected; retrying once\n');
      continue;
    }
    return status;
  }

  return 1;
}

if (require.main === module) {
  try {
    process.exitCode = runProductionAudit(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { runProductionAudit };
