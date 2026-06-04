const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const os = require('node:os');

const repoRoot = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const sync = !args.has('--no-sync');
const noBrowser = args.has('--no-browser');
const shareMode = args.has('--share');
const PORT = Number(process.env.PORT || 8787);
const HOST = shareMode ? '0.0.0.0' : (process.env.HOST || '127.0.0.1');
const probeHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
const serverUrl = `http://${probeHost}:${PORT}`;
const apiProbe = `${serverUrl}/api/meta`;

function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}
const logDir = path.join(process.env.TEMP || process.env.TMPDIR || repoRoot, 'sat-generator');
const pidFile = path.join(logDir, 'server.pid');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeServer() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(apiProbe, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function readJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-Number(pid), 'SIGTERM');
  } catch {}
}

async function findListenerPid() {
  if (process.platform !== 'win32') {
    return null;
  }
  return new Promise((resolve) => {
    let output = '';
    const child = spawn('powershell', [
      '-NoProfile',
      '-Command',
      "(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)"
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('close', () => {
      const pid = Number(String(output).trim());
      resolve(Number.isFinite(pid) && pid > 0 ? pid : null);
    });
  });
}

async function stopExistingServer() {
  fs.mkdirSync(logDir, { recursive: true });
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (pid && isProcessAlive(pid)) {
      killPid(pid);
      await sleep(1500);
    }
    try {
      fs.unlinkSync(pidFile);
    } catch {}
  }
  const listenerPid = await findListenerPid();
  if (listenerPid && isProcessAlive(listenerPid)) {
    killPid(listenerPid);
    await sleep(1500);
  }
}

async function waitForSyncToFinish() {
  await readJson(`${serverUrl}/api/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resume: true, cookie: '' })
  });
  for (let i = 0; i < 720; i += 1) {
    await sleep(1000);
    const status = await readJson(`${serverUrl}/api/sync/status`);
    if (status.status === 'complete') {
      return status;
    }
    if (status.status === 'failed') {
      throw new Error(status.lastError || 'Sync failed.');
    }
  }
  throw new Error('Sync timed out.');
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  await stopExistingServer();
  fs.mkdirSync(logDir, { recursive: true });
  const stdoutLog = path.join(logDir, 'server.out.log');
  const stderrLog = path.join(logDir, 'server.err.log');
  const out = fs.openSync(stdoutLog, 'a');
  const err = fs.openSync(stderrLog, 'a');

  const child = spawn(process.execPath, [path.join(repoRoot, 'server', 'index.cjs')], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', out, err],
    env: {
      ...process.env,
      SAT_SERVE_DIST: '0',
      HOST,
      PORT: String(PORT)
    }
  });

  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  fs.closeSync(out);
  fs.closeSync(err);

  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    if (await probeServer()) {
      ready = true;
      break;
    }
    if (child.exitCode !== null) {
      break;
    }
  }

  if (!ready) {
    console.error('Server failed to start.');
    console.error(`Stdout: ${stdoutLog}`);
    console.error(`Stderr: ${stderrLog}`);
    process.exitCode = 1;
    return;
  }

  if (sync) {
    console.log('Syncing EQB before opening...');
    await waitForSyncToFinish();
  }

  console.log(`SAT Generator running at ${serverUrl}`);
  if (shareMode) {
    const localIp = getLocalIp();
    console.log(`Share with classmates on your network: http://${localIp}:${PORT}`);
  }
  console.log(`Logs: ${stdoutLog}`);
  if (!noBrowser) openBrowser(serverUrl);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
