const express = require('express');
const path = require('path');

const app = express();
const port = Number(process.env.PORT || 3010);
const title = process.env.APPSTORE_TITLE || 'Dujiaoka AppStore Expand';
const statusText = process.env.APPSTORE_STATUS_TEXT || '应用商店扩展开启';

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'dujiaoka-appstore-expand' });
});

app.get('/inject/appstore-expand.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.type('application/javascript');
  res.send(`window.__APPSTORE_EXPAND__=${JSON.stringify({ title, statusText })};` + "\n" +
    require('fs').readFileSync(path.join(__dirname, 'public', 'inject.js'), 'utf8'));
});

app.get('/panel', (_req, res) => {
  res.type('html');
  res.send(`<!doctype html><html><head><meta charset=\"utf-8\"/><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/><title>${title}</title><style>
  :root{--bg:#0f1115;--panel:#151820;--border:#2b303b;--text:#e5e7eb;--muted:#9ca3af;--ok:#22c55e}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);padding:16px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px}
  .title{margin:0 0 10px;font-size:18px}
  .tag{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;background:#10251a;border:1px solid #1f5131;color:#baf3cf;font-size:12px}
  .dot{width:8px;height:8px;border-radius:999px;background:var(--ok);display:inline-block}
  .desc{margin:12px 0 0;color:var(--muted);line-height:1.6}
  </style></head><body><div class=\"card\"><h2 class=\"title\">${title}</h2><span class=\"tag\"><i class=\"dot\"></i>运行中</span><p class=\"desc\">${statusText}</p><p class=\"desc\">这里是独立扩展容器页面。后续可在此接入应用市场、扩展安装、授权管理等功能。</p></div></body></html>`);
});

app.listen(port, () => {
  console.log(`[appstore-expand] listening on :${port}`);
});
