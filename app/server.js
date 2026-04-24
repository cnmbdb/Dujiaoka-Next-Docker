const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { exec } = require('child_process');

const app = express();
const port = Number(process.env.PORT || 3010);

const title = process.env.APPSTORE_TITLE || 'Dujiaoka AppStore Expand';
const buttonText = process.env.APPSTORE_BUTTON_TEXT || '扩展应用商店';
const statusText = process.env.APPSTORE_STATUS_TEXT || '应用商店扩展开启';
const frontendUrl = process.env.APPSTORE_FRONTEND_URL || 'https://ets.txsw.top';
const frontendLoginPath = process.env.APPSTORE_FRONTEND_LOGIN_PATH || '/login';
const workdir = process.env.APPSTORE_WORKDIR || path.join(__dirname, 'data');
const requestTimeoutMs = Number(process.env.APPSTORE_REQUEST_TIMEOUT_MS || 120000);

const ACTIONS = new Set(['download', 'check', 'install', 'inject', 'embed', 'update']);

app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function ensureDir(dirPath) {
  return fsp.mkdir(dirPath, { recursive: true });
}

function normalizeAction(rawAction) {
  const action = String(rawAction || '').trim().toLowerCase();
  return ACTIONS.has(action) ? action : null;
}

function slugify(value) {
  return String(value || 'extension')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'extension';
}

function extensionSlug(payload) {
  return slugify(payload.extensionName || payload.name || payload.extensionId || payload.id || 'extension');
}

function getHostOrigin(req) {
  const protoHeader = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = protoHeader || req.protocol || 'http';
  const host = hostHeader || 'localhost';
  return `${proto}://${host}`;
}

function readJsonIfExists(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_ignored) {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function downloadFile(sourceUrl, outputFile) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const resp = await fetch(sourceUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'dujiaoka-appstore-expand/1.0',
      },
    });

    if (!resp.ok || !resp.body) {
      throw new Error(`下载失败: ${resp.status} ${resp.statusText}`);
    }

    await ensureDir(path.dirname(outputFile));
    const bodyStream = Readable.fromWeb(resp.body);
    await pipeline(bodyStream, fs.createWriteStream(outputFile));

    return {
      outputFile,
      bytes: Number(resp.headers.get('content-length') || 0),
      contentType: resp.headers.get('content-type') || '',
      etag: resp.headers.get('etag') || '',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runCommand(command, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd,
        timeout: requestTimeoutMs,
        env: {
          ...process.env,
          ...env,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr || stdout || error.message;
          reject(new Error(String(message).trim() || '命令执行失败'));
          return;
        }
        resolve({ stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
      }
    );
  });
}

function buildShellPanelUrl(req) {
  const hostOrigin = getHostOrigin(req);
  const base = new URL(frontendUrl);
  const pathname = base.pathname.replace(/\/+$/, '') || '/';
  const loginPath = frontendLoginPath.startsWith('/') ? frontendLoginPath : `/${frontendLoginPath}`;
  const theme = String(req.query.theme || '').toLowerCase() === 'light' ? 'light' : 'dark';

  const url = new URL(pathname === '/' ? loginPath : `${pathname}${loginPath}`, base.origin);
  url.searchParams.set('dj_auto_login', '1');
  url.searchParams.set('dj_origin', hostOrigin);
  url.searchParams.set('dj_domain', new URL(hostOrigin).hostname);
  url.searchParams.set('theme', theme);

  return url;
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

async function checkExtensionState(payload) {
  const slug = extensionSlug(payload);
  const extensionDir = path.join(workdir, 'extensions', slug);
  const manifestFile = path.join(extensionDir, 'appstore-extension.json');
  const manifest = readJsonIfExists(manifestFile, null);

  return {
    slug,
    extensionDir,
    exists: fs.existsSync(extensionDir),
    manifest,
    installedVersion: manifest?.version || null,
    requestedVersion: payload.version || null,
    upToDate: !!manifest && !!payload.version && manifest.version === payload.version,
  };
}

async function executeAction(action, payload) {
  const slug = extensionSlug(payload);
  const extensionDir = path.join(workdir, 'extensions', slug);
  const downloadsDir = path.join(workdir, 'downloads', slug);
  const stateFile = path.join(extensionDir, 'appstore-extension.json');
  const now = new Date().toISOString();

  const state = readJsonIfExists(stateFile, {
    slug,
    name: payload.extensionName || payload.name || slug,
    createdAt: now,
    updatedAt: now,
    enabled: false,
    status: 'created',
    history: [],
  });

  const historyEntry = {
    action,
    at: now,
    version: payload.version || null,
    sourceUrl: payload.sourceUrl || null,
  };

  let actionOutput = {};

  if (action === 'check') {
    actionOutput = await checkExtensionState(payload);
  }

  if (action === 'download' || action === 'update') {
    if (!payload.sourceUrl) {
      throw new Error('缺少 sourceUrl，无法下载扩展包');
    }
    await ensureDir(downloadsDir);
    const guessedFileName = path.basename(new URL(payload.sourceUrl).pathname) || `${slug}.zip`;
    const fileName = payload.fileName ? path.basename(payload.fileName) : guessedFileName;
    const packageFile = path.join(downloadsDir, fileName);
    const downloadInfo = await downloadFile(payload.sourceUrl, packageFile);
    actionOutput.download = {
      ...downloadInfo,
      fileName,
      packageFile,
    };
    state.lastPackageFile = packageFile;
    state.lastDownloadAt = now;
    state.status = 'downloaded';
  }

  if (action === 'install' || action === 'update') {
    await ensureDir(extensionDir);

    const packageFile =
      payload.packageFile ||
      actionOutput.download?.packageFile ||
      state.lastPackageFile;

    if (packageFile && fs.existsSync(packageFile)) {
      if (/\.zip$/i.test(packageFile)) {
        await runCommand(`unzip -o "${packageFile}" -d "${extensionDir}"`, workdir);
      } else if (/\.(tgz|tar\.gz)$/i.test(packageFile)) {
        await runCommand(`tar -xzf "${packageFile}" -C "${extensionDir}"`, workdir);
      } else {
        const target = path.join(extensionDir, path.basename(packageFile));
        await fsp.copyFile(packageFile, target);
      }
    }

    if (payload.installCommand) {
      await runCommand(payload.installCommand, extensionDir);
    }

    state.status = 'installed';
    state.enabled = true;
    state.installedAt = now;
    state.updatedAt = now;
    state.version = payload.version || state.version || 'unknown';
    state.sourceUrl = payload.sourceUrl || state.sourceUrl || '';

    actionOutput.install = {
      extensionDir,
      version: state.version,
      enabled: true,
    };
  }

  if (action === 'inject') {
    const injectTarget = payload.injectTarget;
    const injectSnippet = String(payload.injectSnippet || '').trim();
    if (!injectTarget || !injectSnippet) {
      throw new Error('inject 需要 injectTarget 与 injectSnippet');
    }

    await ensureDir(path.dirname(injectTarget));
    const current = fs.existsSync(injectTarget) ? fs.readFileSync(injectTarget, 'utf8') : '';
    if (!current.includes(injectSnippet)) {
      const merged = `${current}${current.endsWith('\n') || current.length === 0 ? '' : '\n'}${injectSnippet}\n`;
      await fsp.writeFile(injectTarget, merged, 'utf8');
    }

    state.lastInjectAt = now;
    state.status = 'injected';
    actionOutput.inject = {
      injectTarget,
      injected: true,
    };
  }

  if (action === 'embed') {
    const embedTargetDir = payload.embedTargetDir || path.join(workdir, 'embed');
    await ensureDir(embedTargetDir);
    const embedFile = path.join(embedTargetDir, `${slug}.embed.json`);
    const embedPayload = {
      slug,
      name: state.name,
      version: payload.version || state.version || null,
      extensionDir,
      enabled: state.enabled,
      embeddedAt: now,
    };

    await writeJson(embedFile, embedPayload);
    state.lastEmbedAt = now;
    state.status = 'embedded';
    actionOutput.embed = {
      embedFile,
      embedPayload,
    };
  }

  if (payload.command) {
    const commandResult = await runCommand(payload.command, payload.commandCwd || workdir);
    actionOutput.command = commandResult;
  }

  historyEntry.result = 'ok';
  state.history = Array.isArray(state.history) ? state.history : [];
  state.history.unshift(historyEntry);
  state.history = state.history.slice(0, 100);
  state.updatedAt = now;

  await writeJson(stateFile, state);

  return {
    action,
    state,
    output: actionOutput,
  };
}

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'dujiaoka-appstore-expand',
    mode: 'api-container',
    frontendUrl,
    workdir,
  });
});

app.get('/inject/appstore-expand.js', (_req, res) => {
  noStore(res);
  res.type('application/javascript');

  const injectJsPath = path.join(__dirname, 'public', 'inject.js');
  let injectJsContent = '';
  try {
    injectJsContent = fs.readFileSync(injectJsPath, 'utf8');
  } catch (error) {
    console.error('Error reading inject.js:', error);
  }

  const runtimeConfig = {
    title,
    buttonText,
    statusText,
    panelUrl: '/appstore-expand/panel',
    healthUrl: '/appstore-expand/health',
  };

  res.send(`window.__APPSTORE_EXPAND__=${JSON.stringify(runtimeConfig)};\n${injectJsContent}`);
});

app.get('/panel', (req, res) => {
  noStore(res);
  res.type('html');

  const shellIframeUrl = buildShellPanelUrl(req).toString();

  res.send(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; width: 100%; background: #0b1220; }
    #appstore-shell-frame { border: 0; width: 100%; height: 100%; display: block; background: #0b1220; }
  </style>
</head>
<body>
  <iframe id="appstore-shell-frame" src="${shellIframeUrl.replace(/"/g, '&quot;')}" referrerpolicy="strict-origin-when-cross-origin" allow="clipboard-read; clipboard-write"></iframe>
</body>
</html>`);
});

app.get('/api/extensions', async (req, res) => {
  try {
    const url = new URL('/api/extensions', frontendUrl);
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'dujiaoka-appstore-expand/1.0',
      },
    });

    if (!upstream.ok) {
      throw new Error(`前端接口返回 ${upstream.status}`);
    }

    const payload = await upstream.json();
    res.json(payload);
  } catch (error) {
    console.error('Fetch frontend extensions failed:', error);
    res.json([]);
  }
});

app.post('/api/extensions/actions', async (req, res) => {
  try {
    const action = normalizeAction(req.body?.action);
    if (!action) {
      return res.status(400).json({ ok: false, error: '不支持的 action' });
    }

    const result = await executeAction(action, req.body || {});
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Execute extension action failed:', error);
    return res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

app.post('/api/extensions/:action', async (req, res) => {
  try {
    const action = normalizeAction(req.params.action);
    if (!action) {
      return res.status(400).json({ ok: false, error: '不支持的 action' });
    }

    const result = await executeAction(action, req.body || {});
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Execute extension action failed:', error);
    return res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

app.post('/api/extensions/:extensionId/:action', async (req, res) => {
  try {
    const action = normalizeAction(req.params.action);
    if (!action) {
      return res.status(400).json({ ok: false, error: '不支持的 action' });
    }

    const payload = {
      ...(req.body || {}),
      extensionId: req.params.extensionId,
    };

    const result = await executeAction(action, payload);
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Execute extension action failed:', error);
    return res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

app.use((error, _req, res, _next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ ok: false, error: 'Internal Server Error' });
});

app.listen(port, () => {
  console.log(`[appstore-expand] listening on :${port}`);
  console.log(`[appstore-expand] frontend shell -> ${frontendUrl}`);
  console.log(`[appstore-expand] workdir -> ${workdir}`);
});
