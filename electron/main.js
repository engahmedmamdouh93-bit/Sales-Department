const { app, BrowserWindow, ipcMain, safeStorage, shell, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');
const pkg = require('../package.json');
const { createContent } = require('./content');

const PLACEHOLDER = 'your-account/sales-agents-department';
const DEFAULTS = { cm: 'cli', model: 'claude-sonnet-5-5', repo: '', channel: 'stable', autoContent: true };
const BUNDLED = path.join(__dirname, '..', 'app', 'index.html');
let win;
let content;

const dataDir = () => app.getPath('userData');
const cfgFile = () => path.join(dataDir(), 'config.json');
const keyFile = () => path.join(dataDir(), 'key.bin');
const logFile = () => path.join(dataDir(), 'app.log');
function log(msg) { try { fs.mkdirSync(dataDir(), { recursive: true }); fs.appendFileSync(logFile(), new Date().toISOString() + ' ' + msg + '\n'); } catch (e) { /* ignore */ } }
function readCfg() { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; } catch (e) { return { ...DEFAULTS }; } }
function writeCfg(c) { fs.mkdirSync(dataDir(), { recursive: true }); fs.writeFileSync(cfgFile(), JSON.stringify(c)); }
function readKey() { try { return safeStorage.decryptString(fs.readFileSync(keyFile())); } catch (e) { return ''; } }
function bakedRepo() {
  const p = (pkg.build && pkg.build.publish && pkg.build.publish[0]) || {};
  return p.owner && p.repo && p.owner !== 'YOUR-GITHUB-USER' ? p.owner + '/' + p.repo : '';
}

async function fetchRemote() {
  const repo = readCfg().repo || bakedRepo();
  if (!repo || repo === PLACEHOLDER) throw new Error('No GitHub repository is set. Set it in Settings, Updates.');
  const r = await fetch('https://api.github.com/repos/' + repo + '/contents/app/index.html?ref=main', {
    headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'SalesDepartment' },
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) throw new Error('GitHub answered ' + r.status + (r.status === 403 ? ' (too many checks, try again later)' : ''));
  return await r.text();
}
async function runCheck() {
  try {
    const r = await content.check();
    log('content check ' + JSON.stringify(r));
    if (r.updated && win && !win.isDestroyed()) win.webContents.send('content:ready', { version: r.version });
    return r;
  } catch (e) { log('content check failed ' + e.message); return { ok: false, error: e.message }; }
}

/* ---------- find Claude Code on Windows (a desktop app does not always see your terminal PATH) ---------- */
function whereClaude() {
  return new Promise(resolve => {
    execFile(process.platform === 'win32' ? 'where' : 'which', ['claude'], { windowsHide: true, timeout: 8000 }, (err, out) => {
      resolve(err ? [] : String(out).split(/\r?\n/).map(s => s.trim()).filter(Boolean));
    });
  });
}
async function findClaude() {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const cands = [
    process.env.CLAUDE_CODE_PATH,
    ...(await whereClaude()),
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(appdata, 'npm', 'claude.cmd'),
    path.join(appdata, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(local, 'Programs', 'claude', 'claude.exe')
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) { /* next */ } }
  return null;
}
function friendly(msg) {
  const m = String(msg || '');
  if (/not logged in|please run \/login|invalid api key|authentication|oauth|credit balance|sign in/i.test(m)) return 'Claude Code is not signed in or has no access. Open a terminal, run: claude  and sign in, then press Reconnect. (' + m.slice(0, 160) + ')';
  return m.slice(0, 400);
}
function runClaude(prompt, args, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    const exe = await findClaude();
    if (!exe) return reject(new Error('Claude Code was not found on this computer. Install Claude Code, open a terminal, run: claude  and sign in. Then press Reconnect.'));
    const isCmd = /\.(cmd|bat)$/i.test(exe);
    const env = { ...process.env, PATH: [process.env.PATH, path.join(os.homedir(), '.local', 'bin'), path.join(process.env.APPDATA || '', 'npm')].filter(Boolean).join(path.delimiter) };
    log('claude: ' + exe + ' ' + args.join(' '));
    const p = spawn(isCmd ? '"' + exe + '"' : exe, args, { shell: isCmd, windowsHide: true, env });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => { if (!done) { done = true; try { p.kill(); } catch (e) { /* ignore */ } reject(new Error('Claude Code did not answer in time. The first start can be slow: try again.')); } }, timeoutMs || 240000);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { if (done) return; done = true; clearTimeout(timer); log('spawn error ' + e.message); reject(new Error('Could not start Claude Code (' + e.message + ').')); });
    p.on('close', code => {
      if (done) return; done = true; clearTimeout(timer);
      if (code === 0) return resolve(out.trim());
      log('claude exit ' + code + ' ' + (err || out).slice(0, 400));
      reject(new Error(friendly(err.trim() || out.trim() || 'Claude Code stopped with code ' + code)));
    });
    if (prompt != null) { try { p.stdin.write(prompt); } catch (e) { /* ignore */ } }
    try { p.stdin.end(); } catch (e) { /* ignore */ }
  });
}
async function runApi(prompt, cfg) {
  const key = readKey();
  if (!key) throw new Error('No API key saved. Add it in Settings, Connections.');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: cfg.model, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('API error ' + r.status));
  return (j.content || []).map(x => x.text || '').join('');
}

ipcMain.handle('version', () => app.getVersion());
ipcMain.handle('info', () => ({ repo: bakedRepo(), packaged: app.isPackaged, log: logFile() }));
ipcMain.handle('status', async () => {
  const c = readCfg();
  if (c.cm === 'key') return readKey() ? { ok: true, detail: 'API key saved (stored encrypted). Press Test to check it.' } : { ok: false, detail: 'No API key saved yet.' };
  try {
    const exe = await findClaude();
    if (!exe) return { ok: false, detail: 'Claude Code was not found. Install it, run  claude  in a terminal, sign in, then press Reconnect.' };
    const v = await runClaude(null, ['--version'], 20000);
    return { ok: true, detail: 'Claude Code ' + v + ' found at ' + exe + '. It uses your own Claude sign-in. Press Test to check it.' };
  } catch (e) { return { ok: false, detail: e.message }; }
});
ipcMain.handle('brain', async (e, prompt) => { const c = readCfg(); return c.cm === 'key' ? runApi(prompt, c) : runClaude(prompt, ['-p', '--output-format', 'text']); });
ipcMain.handle('contentInfo', () => ({ ...content.info(), repo: readCfg().repo || bakedRepo() }));
ipcMain.handle('contentCheck', () => runCheck());
ipcMain.handle('contentReload', () => { if (win) win.loadFile(content.currentPath()); return true; });
ipcMain.handle('contentRevert', () => { content.revert(); if (win) win.loadFile(BUNDLED); return true; });
ipcMain.handle('setConfig', (e, c) => { const cur = readCfg(); if (c && typeof c.autoContent === 'boolean') cur.autoContent = c.autoContent; if (c && (c.cm === 'cli' || c.cm === 'key')) cur.cm = c.cm; if (c && c.model) cur.model = String(c.model).slice(0, 80); writeCfg(cur); return true; });
ipcMain.handle('setKey', (e, k) => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this computer.');
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(keyFile(), safeStorage.encryptString(String(k).trim()));
  return true;
});

function setFeed(repo, channel) {
  if (repo && repo.includes('/') && repo !== PLACEHOLDER) {
    const [owner, name] = repo.split('/');
    autoUpdater.setFeedURL({ provider: 'github', owner, repo: name });
  }
  autoUpdater.allowPrerelease = channel === 'beta';
}
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
ipcMain.handle('setRepo', (e, repo, channel) => { const c = readCfg(); c.repo = repo; c.channel = channel; writeCfg(c); setFeed(repo, channel); return true; });
function newer(a, b) { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) > (y[i] || 0)) return true; if ((x[i] || 0) < (y[i] || 0)) return false; } return false; }
ipcMain.handle('checkUpdate', async () => {
  if (!app.isPackaged) throw new Error('Update checks work in the installed app, not when running from source.');
  const r = await autoUpdater.checkForUpdates();
  const info = (r && r.updateInfo) || {};
  const notes = typeof info.releaseNotes === 'string' ? info.releaseNotes.replace(/<[^>]+>/g, '') : '';
  return { available: !!info.version && newer(info.version, app.getVersion()), version: info.version || app.getVersion(), notes };
});
ipcMain.handle('installUpdate', async () => { await autoUpdater.downloadUpdate(); autoUpdater.quitAndInstall(); });

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 990, minWidth: 1100, minHeight: 700,
    backgroundColor: '#070D10', title: 'Sales Agents Department',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(content.currentPath());
  win.webContents.on('did-finish-load', () => content.applied());
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain && content.currentPath() !== BUNDLED) { log('downloaded interface failed to load, going back to the built-in one'); content.revert(); win.loadFile(BUNDLED); }
  });
  win.webContents.on('render-process-gone', () => {
    if (content.currentPath() !== BUNDLED) { log('downloaded interface crashed, going back to the built-in one'); content.revert(); win.loadFile(BUNDLED); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'notifications'].includes(perm)));
  const c = readCfg(); setFeed(c.repo || bakedRepo(), c.channel);
  log('started v' + app.getVersion());
  content = createContent({ dataDir: dataDir(), bundledPath: BUNDLED, fetchText: fetchRemote, log });
  createWindow();
  if (readCfg().autoContent !== false) setTimeout(() => runCheck(), 6000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
