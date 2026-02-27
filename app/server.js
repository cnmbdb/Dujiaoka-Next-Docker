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
  res.type('application/javascript');
  res.send(`window.__APPSTORE_EXPAND__=${JSON.stringify({ title, statusText })};` + "\n" +
    require('fs').readFileSync(path.join(__dirname, 'public', 'inject.js'), 'utf8'));
});

app.get('/panel', (_req, res) => {
  res.type('html');
  res.send(`<!doctype html><html><head><meta charset=\"utf-8\"/><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/><title>${title}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;padding:18px} .card{background:#111827;border:1px solid #334155;border-radius:12px;padding:16px} .tag{display:inline-block;padding:4px 10px;border-radius:999px;background:#065f46;color:#d1fae5;font-size:12px}</style></head><body><div class=\"card\"><h2 style=\"margin:0 0 8px\">${title}</h2><span class=\"tag\">运行中</span><p style=\"opacity:.9;margin-top:12px\">${statusText}</p><p style=\"opacity:.7\">这里是独立扩展容器页面。后续可在此接入应用市场、扩展安装、授权管理等功能。</p></div></body></html>`);
});

app.listen(port, () => {
  console.log(`[appstore-expand] listening on :${port}`);
});
