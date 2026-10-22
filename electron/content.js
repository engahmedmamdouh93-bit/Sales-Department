// Atlas-style interface updates: the app loads app/index.html from GitHub when it is newer than the built-in copy.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function cmp(a, b) {
  const x = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const y = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) > (y[i] || 0)) return 1; if ((x[i] || 0) < (y[i] || 0)) return -1; }
  return 0;
}
function uiVersionOf(html) {
  const m = /UI_VERSION\s*=\s*"([0-9.]+)"/.exec(html || '');
  return m ? m[1] : '0.0.0';
}
function validHtml(h) {
  return typeof h === 'string' && h.length > 100000 && h.includes('id="V"') && h.includes('</html>') && /UI_VERSION\s*=\s*"[0-9.]+"/.test(h);
}
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

function createContent({ dataDir, bundledPath, fetchText, log }) {
  const dir = path.join(dataDir, 'app-cache');
  const cacheFile = path.join(dir, 'index.html');
  const prevFile = path.join(dir, 'index.prev.html');
  const metaFile = path.join(dir, 'meta.json');
  const say = typeof log === 'function' ? log : () => {};
  const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } };
  const meta = () => { try { return JSON.parse(read(metaFile)) || {}; } catch (e) { return {}; } };
  const setMeta = m => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(metaFile, JSON.stringify({ ...meta(), ...m })); } catch (e) { say('meta write failed ' + e.message); } };

  function currentPath() {
    const c = read(cacheFile);
    if (c && validHtml(c)) {
      const b = read(bundledPath);
      if (cmp(uiVersionOf(c), uiVersionOf(b)) >= 0) return cacheFile;
    }
    return bundledPath;
  }
  function info() {
    const p = currentPath(), m = meta();
    return { ui: uiVersionOf(read(p)), source: p === bundledPath ? 'built-in' : 'downloaded from GitHub', lastCheck: m.lastCheck || 0, pending: !!m.pending, pendingVersion: m.pendingVersion || '' };
  }
  async function check() {
    const remote = await fetchText();
    if (!validHtml(remote)) return { ok: false, error: 'The file on GitHub does not look like the app, so it was ignored.' };
    const bundled = read(bundledPath), cur = read(currentPath());
    const rv = uiVersionOf(remote);
    if (cmp(rv, uiVersionOf(bundled)) < 0) { setMeta({ lastCheck: Date.now() }); return { ok: true, updated: false, version: rv, reason: 'older than the built-in interface' }; }
    if (sha(remote) === sha(cur)) { setMeta({ lastCheck: Date.now(), pending: false }); return { ok: true, updated: false, version: rv }; }
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(cacheFile)) { try { fs.copyFileSync(cacheFile, prevFile); } catch (e) { /* ignore */ } }
    fs.writeFileSync(cacheFile, remote);
    setMeta({ lastCheck: Date.now(), pending: true, pendingVersion: rv });
    say('interface downloaded v' + rv);
    return { ok: true, updated: true, version: rv };
  }
  const applied = () => setMeta({ pending: false, pendingVersion: '' });
  const revert = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { say('revert failed ' + e.message); } };
  return { currentPath, info, check, applied, revert };
}
module.exports = { createContent, cmp, uiVersionOf, validHtml };
