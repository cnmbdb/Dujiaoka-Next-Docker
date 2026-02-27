const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const port = Number(process.env.PORT || 3010);
const title = process.env.APPSTORE_TITLE || 'Dujiaoka AppStore Expand';
const buttonText = process.env.APPSTORE_BUTTON_TEXT || '扩展应用商店';
const statusText = process.env.APPSTORE_STATUS_TEXT || '应用商店扩展开启';

const demoExtensions = [
  {
    name: 'epusdt',
    subtitle: 'USDT 收款扩展',
    description: '面向链上收款场景，支持到账监听与订单回调演示。',
    icon: 'EP',
    toneA: '#10b981',
    toneB: '#0ea5e9'
  },
  {
    name: 'TokenPay',
    subtitle: '聚合支付扩展',
    description: '提供多支付通道聚合路由的演示界面。',
    icon: 'TP',
    toneA: '#3b82f6',
    toneB: '#6366f1'
  },
  {
    name: '谷歌ADS',
    subtitle: '广告投放扩展',
    description: '用于广告位管理、转化埋点和投放参数管理。',
    icon: 'GA',
    toneA: '#2563eb',
    toneB: '#38bdf8'
  },
  {
    name: '百度seo',
    subtitle: 'SEO 优化扩展',
    description: '站点索引提交、关键词策略和结构化优化展示。',
    icon: 'BD',
    toneA: '#0ea5e9',
    toneB: '#14b8a6'
  },
  {
    name: '鲍鱼WAF',
    subtitle: '安全防护扩展',
    description: 'Web 攻击拦截策略与黑白名单规则演示。',
    icon: 'WF',
    toneA: '#f59e0b',
    toneB: '#ef4444'
  },
  {
    name: '鲍鱼CDN',
    subtitle: '加速分发扩展',
    description: '静态资源缓存、边缘加速和回源策略配置。',
    icon: 'CD',
    toneA: '#06b6d4',
    toneB: '#22c55e'
  },
  {
    name: '鲍鱼发卡机器人',
    subtitle: '自动发货扩展',
    description: '对接机器人消息推送，支持自动发卡流程演示。',
    icon: 'BR',
    toneA: '#8b5cf6',
    toneB: '#6366f1'
  },
  {
    name: '鲍鱼主题',
    subtitle: '主题皮肤扩展',
    description: '提供前台主题风格切换与模板管理能力。',
    icon: 'TH',
    toneA: '#ec4899',
    toneB: '#a855f7'
  },
  {
    name: '晴宝3U召唤插件',
    subtitle: '业务召唤扩展',
    description: '用于 3U 场景的自动召唤与联动流程演示。',
    icon: '3U',
    toneA: '#22c55e',
    toneB: '#0ea5e9'
  },
  {
    name: 'AI解决99%插件',
    subtitle: '智能辅助扩展',
    description: '接入 AI 助手处理常见运营问题与工单。',
    icon: 'AI',
    toneA: '#14b8a6',
    toneB: '#3b82f6'
  },
  {
    name: '7777-100U在线接单扩展',
    subtitle: '在线接单扩展',
    description: '面向在线接单业务，支持演示版队列与状态管理。',
    icon: '7U',
    toneA: '#f97316',
    toneB: '#f43f5e'
  }
];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return h >>> 0;
}

function seededRandom(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randomIconDataUri(seedText, labelText) {
  const rand = seededRandom(hashSeed(seedText));
  const palette = [
    '#3b82f6', '#14b8a6', '#10b981', '#6366f1', '#8b5cf6', '#0ea5e9',
    '#f97316', '#ef4444', '#ec4899', '#22c55e', '#f59e0b', '#06b6d4'
  ];
  const pick = () => palette[Math.floor(rand() * palette.length)];
  const c1 = pick();
  const c2 = pick();
  const c3 = pick();
  const c4 = pick();
  const rotate = Math.floor(rand() * 360);
  const circleX = 28 + Math.floor(rand() * 64);
  const circleY = 28 + Math.floor(rand() * 64);
  const circleR = 18 + Math.floor(rand() * 22);
  const rectX = 12 + Math.floor(rand() * 34);
  const rectY = 12 + Math.floor(rand() * 34);
  const rectW = 48 + Math.floor(rand() * 42);
  const rectH = 48 + Math.floor(rand() * 42);
  const glyph = String(labelText || '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .slice(0, 2)
    .toUpperCase() || 'AP';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="100%" stop-color="${c2}"/>
    </linearGradient>
    <linearGradient id="g2" x1="100%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${c3}"/>
      <stop offset="100%" stop-color="${c4}"/>
    </linearGradient>
  </defs>
  <g transform="rotate(${rotate} 60 60)">
    <rect x="${rectX}" y="${rectY}" width="${rectW}" height="${rectH}" rx="18" fill="url(#g)" opacity="0.92"/>
    <circle cx="${circleX}" cy="${circleY}" r="${circleR}" fill="url(#g2)" opacity="0.88"/>
    <path d="M16 78 C28 60, 52 104, 86 70 C94 62, 100 56, 106 44" stroke="rgba(255,255,255,.52)" stroke-width="6" fill="none" stroke-linecap="round"/>
  </g>
  <rect x="4.5" y="4.5" width="111" height="111" rx="28" fill="none" stroke="rgba(255,255,255,.34)" stroke-width="1"/>
  <text x="60" y="72" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif" font-size="28" font-weight="800" fill="white" letter-spacing=".8">${glyph}</text>
</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function truncateText(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

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
  res.send(`window.__APPSTORE_EXPAND__=${JSON.stringify({ title, buttonText, statusText })};` + '\n' +
    fs.readFileSync(path.join(__dirname, 'public', 'inject.js'), 'utf8'));
});

app.get('/panel', (_req, res) => {
  const extensionCards = demoExtensions.map((item, idx) => ({
    ...item,
    iconUri: randomIconDataUri(`${item.name}-${idx}`, item.icon)
  }));

  const featured = extensionCards.slice(0, 3);
  const heroPalettes = [
    { from: '#141b2e', mid: '#1f2a44', to: '#2f3e62', glow: 'rgba(148,163,184,.26)' },
    { from: '#0f192b', mid: '#1e3659', to: '#25527d', glow: 'rgba(56,189,248,.28)' },
    { from: '#1a162f', mid: '#2a2349', to: '#3b3163', glow: 'rgba(167,139,250,.30)' },
    { from: '#172335', mid: '#1a3d56', to: '#1f566f', glow: 'rgba(45,212,191,.28)' },
    { from: '#231822', mid: '#3a2432', to: '#573244', glow: 'rgba(244,114,182,.28)' }
  ];
  const heroSlides = extensionCards.slice(0, 5).map((item, idx) => ({
    ...item,
    badge: idx === 0 ? '编辑最爱' : idx === 1 ? '热门推荐' : '本周精选',
    shortDesc: truncateText(item.description, 34),
    palette: heroPalettes[idx % heroPalettes.length]
  }));

  const heroSlidesHtml = heroSlides.map((item, idx) => {
    return `<article class="hero-slide${idx === 0 ? ' is-active' : ''}" data-index="${idx}" style="--hero-from:${escapeHtml(item.palette.from)};--hero-mid:${escapeHtml(item.palette.mid)};--hero-to:${escapeHtml(item.palette.to)};--hero-glow:${escapeHtml(item.palette.glow)};" aria-hidden="${idx === 0 ? 'false' : 'true'}">
      <div class="hero-content">
        <span class="hero-kicker">${escapeHtml(item.badge)}</span>
        <h2>${escapeHtml(item.name)}</h2>
        <p>${escapeHtml(item.shortDesc)}</p>
        <div class="hero-app">
          <div class="hero-app-icon"><img src="${escapeHtml(item.iconUri)}" alt="${escapeHtml(item.name)} 图标"/></div>
          <div class="hero-app-copy">
            <strong>${escapeHtml(item.name)}</strong>
            <span>${escapeHtml(item.subtitle)}</span>
          </div>
          <button type="button" class="hero-btn">检视</button>
        </div>
      </div>
    </article>`;
  }).join('');

  const heroDotsHtml = heroSlides.map((item, idx) => {
    return `<button type="button" class="hero-dot${idx === 0 ? ' is-active' : ''}" data-index="${idx}" aria-label="切换到 ${escapeHtml(item.name)}" aria-current="${idx === 0 ? 'true' : 'false'}"></button>`;
  }).join('');

  const featuredHtml = featured.map((item, idx) => {
    return `<article class="today-card" style="--tone-a:${escapeHtml(item.toneA)};--tone-b:${escapeHtml(item.toneB)};">
      <span class="today-tag">${idx === 0 ? 'TODAY 主推' : '编辑精选'}</span>
      <h3>${escapeHtml(item.name)}</h3>
      <p class="today-summary">${escapeHtml(item.description)}</p>
      <div class="today-foot">
        <div class="mini-icon"><img src="${escapeHtml(item.iconUri)}" alt="${escapeHtml(item.name)} 图标"/></div>
        <div class="mini-copy">
          <strong>${escapeHtml(item.name)}</strong>
          <span>${escapeHtml(item.subtitle)}</span>
        </div>
        <button type="button" class="get-btn">获取</button>
      </div>
    </article>`;
  }).join('');

  const listHtml = extensionCards.map((item, idx) => {
    return `<article class="app-row">
      <div class="app-icon"><img src="${escapeHtml(item.iconUri)}" alt="${escapeHtml(item.name)} 图标"/></div>
      <div class="app-copy">
        <h4>${escapeHtml(item.name)}</h4>
        <p>${escapeHtml(item.subtitle)}</p>
        <small>${escapeHtml(item.description)}</small>
      </div>
      <div class="app-side">
        <button type="button" class="get-btn">获取</button>
        <span>第 ${idx + 1} 位推荐</span>
      </div>
    </article>`;
  }).join('');

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.type('html');
  res.send(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(title)}</title><style>
  :root{color-scheme:dark}
  :root[data-theme="dark"]{
    color-scheme:dark;
    --bg:#070b12;
    --bg-soft:#0b111c;
    --surface:#111927;
    --surface-soft:#131d2d;
    --surface-hover:#1a2638;
    --border:#2c384c;
    --text:#e7edf7;
    --text-sub:#ccd7e6;
    --muted:#91a0b7;
    --accent:#65a3ff;
    --ok:#22c55e;
    --grad-a:rgba(59,130,246,.18);
    --grad-b:rgba(16,185,129,.14);
    --hero-shadow:rgba(0,0,0,.38);
    --btn-bg:rgba(16,24,36,.78);
    --btn-border:rgba(148,163,184,.42);
    --btn-hover-bg:rgba(37,99,235,.44);
    --btn-hover-border:rgba(96,165,250,.72);
    --btn-hover-color:#f8fbff;
    --tag-bg:rgba(30,64,175,.25);
    --tag-border:rgba(96,165,250,.45);
    --tag-color:#bfdbfe;
    --icon-border:rgba(255,255,255,.28);
    --icon-shell:rgba(255,255,255,.02);
    --hero-nav-bg:rgba(11,17,30,.42);
    --hero-nav-border:rgba(255,255,255,.35);
    --hero-dot:rgba(241,245,249,.45);
    --hero-dot-active:#ffffff;
    --hero-card-bg:rgba(7,12,22,.54);
    --hero-card-border:rgba(255,255,255,.22);
  }
  :root[data-theme="light"]{
    color-scheme:light;
    --bg:#eef3fb;
    --bg-soft:#f7faff;
    --surface:#ffffff;
    --surface-soft:#f8fbff;
    --surface-hover:#f1f6ff;
    --border:#d7e1ef;
    --text:#0f1a2a;
    --text-sub:#2f3f56;
    --muted:#5d6d84;
    --accent:#1d4ed8;
    --ok:#16a34a;
    --grad-a:rgba(59,130,246,.15);
    --grad-b:rgba(16,185,129,.11);
    --hero-shadow:rgba(15,23,42,.12);
    --btn-bg:rgba(255,255,255,.94);
    --btn-border:rgba(100,116,139,.38);
    --btn-hover-bg:rgba(219,234,254,.95);
    --btn-hover-border:rgba(37,99,235,.6);
    --btn-hover-color:#0f172a;
    --tag-bg:rgba(37,99,235,.1);
    --tag-border:rgba(37,99,235,.3);
    --tag-color:#1e40af;
    --icon-border:rgba(15,23,42,.18);
    --icon-shell:rgba(15,23,42,.03);
    --hero-nav-bg:rgba(255,255,255,.74);
    --hero-nav-border:rgba(148,163,184,.44);
    --hero-dot:rgba(100,116,139,.45);
    --hero-dot-active:#1e293b;
    --hero-card-bg:rgba(255,255,255,.68);
    --hero-card-border:rgba(148,163,184,.35);
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0;
    font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','SF Pro Display','Segoe UI',sans-serif;
    color:var(--text);
    background:transparent;
    overflow:auto;
    transition:background .22s ease,color .22s ease;
  }
  .store-shell{max-width:1180px;margin:0 auto;padding:18px 18px 22px;}
  .hero-carousel{position:relative;margin:0 0 18px;}
  .hero-frame{
    position:relative;
    border:1px solid var(--border);
    border-radius:24px;
    min-height:clamp(300px,35vw,430px);
    overflow:hidden;
    box-shadow:0 14px 40px var(--hero-shadow);
  }
  .hero-slide{
    position:absolute;
    inset:0;
    padding:clamp(14px,1.3vw + 8px,24px);
    display:flex;
    align-items:flex-end;
    background:
      radial-gradient(120% 96% at 0% -10%,rgba(255,255,255,.15),transparent 56%),
      radial-gradient(72% 80% at 100% 0%,var(--hero-glow),transparent 68%),
      linear-gradient(132deg,var(--hero-from),var(--hero-mid) 55%,var(--hero-to));
    opacity:0;
    transform:translateX(6%);
    transition:opacity .42s ease,transform .42s ease;
    pointer-events:none;
  }
  .hero-slide::after{
    content:"";
    position:absolute;
    inset:0;
    background:
      radial-gradient(circle at 0 100%,rgba(7,12,22,.42),transparent 56%),
      linear-gradient(180deg,rgba(255,255,255,.05),rgba(7,12,22,.18));
  }
  .hero-slide.is-active{
    opacity:1;
    transform:translateX(0);
    pointer-events:auto;
    z-index:2;
  }
  .hero-content{
    position:relative;
    z-index:3;
    width:calc(100% - 120px);
    max-width:calc(100% - 120px);
    margin:0 60px;
    border:1px solid var(--hero-card-border);
    background:var(--hero-card-bg);
    backdrop-filter:blur(6px);
    border-radius:clamp(14px,1vw + 10px,22px);
    padding:clamp(12px,1vw + 8px,20px);
  }
  .hero-kicker{
    display:inline-flex;
    align-items:center;
    height:clamp(24px,1vw + 16px,30px);
    padding:0 clamp(10px,1vw + 6px,13px);
    border-radius:999px;
    border:1px solid rgba(255,255,255,.4);
    color:#fff;
    font-size:clamp(11px,.35vw + 10px,13px);
    font-weight:700;
    letter-spacing:.2px;
    text-shadow:0 1px 1px rgba(0,0,0,.2);
  }
  .hero-content h2{
    margin:clamp(8px,.5vw + 6px,14px) 0 0;
    color:#fff;
    font-size:clamp(30px,2.5vw + 8px,52px);
    line-height:1.04;
    letter-spacing:-.45px;
    text-shadow:0 2px 10px rgba(0,0,0,.22);
  }
  .hero-content p{
    margin:clamp(6px,.5vw + 4px,10px) 0 0;
    color:rgba(255,255,255,.92);
    font-size:clamp(13px,.65vw + 10px,18px);
    line-height:1.4;
    max-width:46ch;
  }
  .hero-app{
    margin-top:clamp(10px,.8vw + 6px,16px);
    border-radius:clamp(12px,.7vw + 8px,16px);
    padding:clamp(7px,.5vw + 5px,10px) clamp(8px,.7vw + 6px,12px);
    border:1px solid rgba(255,255,255,.24);
    background:rgba(9,14,26,.42);
    display:grid;
    grid-template-columns:clamp(40px,3.5vw + 8px,56px) 1fr auto;
    align-items:center;
    gap:clamp(8px,.6vw + 6px,12px);
  }
  .hero-app-icon{
    width:clamp(40px,3.5vw + 8px,56px);
    height:clamp(40px,3.5vw + 8px,56px);
    border-radius:clamp(10px,.6vw + 6px,14px);
    overflow:hidden;
    border:1px solid rgba(255,255,255,.28);
    background:rgba(255,255,255,.06);
  }
  .hero-app-icon img{display:block;width:100%;height:100%;object-fit:cover;}
  .hero-app-copy{min-width:0;display:flex;flex-direction:column;gap:1px;}
  .hero-app-copy strong{font-size:clamp(13px,.6vw + 10px,16px);color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .hero-app-copy span{font-size:clamp(11px,.45vw + 9px,13px);color:rgba(255,255,255,.9);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .hero-btn{
    appearance:none;
    border:1px solid rgba(255,255,255,.35);
    border-radius:999px;
    height:clamp(28px,.9vw + 22px,34px);
    min-width:clamp(62px,3vw + 38px,86px);
    padding:0 clamp(12px,.8vw + 6px,16px);
    font-size:clamp(11px,.45vw + 9px,13px);
    font-weight:700;
    color:#fff;
    background:rgba(255,255,255,.12);
    cursor:pointer;
    transition:all .15s ease;
  }
  .hero-btn:hover{background:rgba(255,255,255,.2);border-color:rgba(255,255,255,.56);}
  .hero-arrow{
    position:absolute;
    top:50%;
    transform:translateY(-50%);
    width:38px;
    height:56px;
    border-radius:12px;
    border:1px solid var(--hero-nav-border);
    background:var(--hero-nav-bg);
    color:#fff;
    font-size:34px;
    line-height:1;
    display:flex;
    align-items:center;
    justify-content:center;
    cursor:pointer;
    z-index:4;
    transition:all .15s ease;
    user-select:none;
  }
  .hero-arrow:hover{transform:translateY(-50%) scale(1.02);}
  .hero-arrow.is-prev{left:10px;}
  .hero-arrow.is-next{right:10px;}
  .hero-dots{
    position:absolute;
    left:50%;
    transform:translateX(-50%);
    bottom:12px;
    z-index:4;
    display:flex;
    align-items:center;
    gap:8px;
  }
  .hero-dot{
    width:8px;
    height:8px;
    border-radius:999px;
    border:0;
    background:var(--hero-dot);
    padding:0;
    cursor:pointer;
    transition:all .18s ease;
  }
  .hero-dot.is-active{
    width:18px;
    background:var(--hero-dot-active);
  }
  .section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:8px;margin:14px 0 10px;}
  .section-head h2{margin:0;font-size:22px;letter-spacing:-.2px;}
  .section-head span{font-size:12px;color:var(--muted);}
  .today-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;}
  .today-card{
    min-height:248px;
    display:flex;
    flex-direction:column;
    justify-content:space-between;
    border-radius:22px;
    border:1px solid var(--border);
    padding:15px;
    background:
      radial-gradient(circle at 18% 0,rgba(255,255,255,.2),transparent 36%),
      linear-gradient(145deg,var(--tone-a),var(--tone-b));
    box-shadow:0 14px 40px var(--hero-shadow);
  }
  .today-tag{
    display:inline-flex;
    align-items:center;
    width:max-content;
    border-radius:999px;
    border:1px solid var(--tag-border);
    background:var(--tag-bg);
    color:var(--tag-color);
    font-size:11px;
    font-weight:700;
    letter-spacing:.25px;
    height:25px;
    padding:0 10px;
  }
  .today-card h3{margin:12px 0 0;font-size:25px;line-height:1.15;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.26);}
  .today-summary{margin:7px 0 0;color:rgba(255,255,255,.9);font-size:13px;line-height:1.45;max-width:34ch;}
  .today-foot{margin-top:14px;display:grid;grid-template-columns:44px 1fr auto;align-items:center;gap:10px;background:rgba(8,13,25,.52);border:1px solid rgba(255,255,255,.18);border-radius:14px;padding:8px 9px;}
  .mini-icon,.app-icon{display:flex;align-items:center;justify-content:center;background:var(--icon-shell);border:1px solid var(--icon-border);box-shadow:inset 0 1px 0 rgba(255,255,255,.16),0 8px 18px rgba(0,0,0,.2);overflow:hidden;}
  .mini-icon{width:44px;height:44px;border-radius:12px;}
  .mini-icon img,.app-icon img{display:block;width:100%;height:100%;object-fit:cover;}
  .mini-copy{min-width:0;display:flex;flex-direction:column;gap:1px;}
  .mini-copy strong{color:#fff;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .mini-copy span{color:rgba(255,255,255,.9);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .apps-wrap{margin-top:16px;border:1px solid var(--border);background:linear-gradient(160deg,var(--surface),var(--surface-soft));border-radius:20px;padding:14px;}
  .apps-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}
  .app-row{display:grid;grid-template-columns:64px 1fr auto;gap:12px;align-items:center;border:1px solid var(--border);background:linear-gradient(155deg,var(--surface),var(--surface-soft));border-radius:16px;padding:10px 11px;transition:all .16s ease;}
  .app-row:hover{background:var(--surface-hover);border-color:var(--accent);transform:translateY(-1px);}
  .app-icon{width:64px;height:64px;border-radius:16px;}
  .app-copy{min-width:0}
  .app-copy h4{margin:0;font-size:16px;line-height:1.25;}
  .app-copy p{margin:3px 0 0;color:var(--text-sub);font-size:12px;}
  .app-copy small{display:block;margin-top:7px;color:var(--muted);font-size:12px;line-height:1.35;}
  .app-side{display:flex;flex-direction:column;align-items:flex-end;gap:5px;}
  .app-side span{font-size:11px;color:var(--muted);}
  .get-btn{appearance:none;border:1px solid var(--btn-border);background:var(--btn-bg);color:var(--text);height:30px;min-width:58px;padding:0 13px;border-radius:999px;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s ease;}
  .get-btn:hover{border-color:var(--btn-hover-border);background:var(--btn-hover-bg);color:var(--btn-hover-color);}
  @media (max-width:1100px){
    .hero-content{width:calc(100% - 100px);max-width:calc(100% - 100px);margin:0 50px;}
    .hero-content h2{font-size:clamp(28px,3.2vw + 6px,42px);}
    .today-grid{grid-template-columns:1fr 1fr;}
    .apps-grid{grid-template-columns:1fr;}
  }
  @media (max-width:720px){
    .store-shell{padding:13px 12px 16px;}
    .hero-frame{min-height:278px;border-radius:18px;}
    .hero-slide{padding:12px;}
    .hero-content{width:calc(100% - 72px);max-width:calc(100% - 72px);margin:0 36px;border-radius:14px;padding:11px 11px 10px;}
    .hero-content h2{font-size:30px;}
    .hero-content p{font-size:13px;}
    .hero-app{grid-template-columns:40px 1fr auto;gap:8px;}
    .hero-app-icon{width:40px;height:40px;border-radius:10px;}
    .hero-app-copy strong{font-size:13px;}
    .hero-app-copy span{font-size:11px;}
    .hero-btn{min-width:58px;height:28px;padding:0 12px;font-size:11px;}
    .hero-arrow{width:32px;height:48px;font-size:28px;border-radius:10px;}
    .hero-arrow.is-prev{left:6px;}
    .hero-arrow.is-next{right:6px;}
    .hero-dots{bottom:8px;gap:7px;}
    .section-head h2{font-size:20px;}
    .today-grid{grid-template-columns:1fr;}
    .today-card{min-height:228px;}
    .today-foot{grid-template-columns:40px 1fr auto;}
    .mini-icon{width:40px;height:40px;border-radius:11px;}
    .app-row{grid-template-columns:56px 1fr;}
    .app-icon{width:56px;height:56px;border-radius:14px;}
    .app-icon span{font-size:16px;}
    .app-side{grid-column:2 / 3;align-items:flex-start;flex-direction:row;gap:8px;padding-top:2px;}
  }
  @media (max-width:520px){
    .hero-arrow{display:none;}
    .hero-content{width:calc(100% - 8px);max-width:calc(100% - 8px);margin:0 4px;}
  }
  </style></head><body>
  <main class="store-shell">
    <section class="hero-carousel" data-hero-carousel>
      <div class="hero-frame">
        ${heroSlidesHtml}
      </div>
      <button type="button" class="hero-arrow is-prev" data-role="prev" aria-label="上一张">‹</button>
      <button type="button" class="hero-arrow is-next" data-role="next" aria-label="下一张">›</button>
      <div class="hero-dots">
        ${heroDotsHtml}
      </div>
    </section>

    <section>
      <div class="section-head">
        <h2>Today 推荐</h2>
        <span>灵感来自 App Store 首页布局</span>
      </div>
      <div class="today-grid">${featuredHtml}</div>
    </section>

    <section class="apps-wrap">
      <div class="section-head">
        <h2>热门扩展</h2>
        <span>${demoExtensions.length} 款演示插件</span>
      </div>
      <div class="apps-grid">${listHtml}</div>
    </section>
  </main>
  <script>
  (function () {
    var root = document.documentElement;

    function parseThemeFromDocument(doc) {
      if (!doc) return null;
      var de = doc.documentElement;
      var body = doc.body;

      var attr = '';
      if (de) attr += ' ' + (de.getAttribute('data-theme') || '');
      if (body) attr += ' ' + (body.getAttribute('data-theme') || '');
      if (/dark/i.test(attr)) return 'dark';
      if (/light/i.test(attr)) return 'light';

      var cls = '';
      if (de) cls += ' ' + (de.className || '');
      if (body) cls += ' ' + (body.className || '');
      if (/\bdark\b/i.test(cls)) return 'dark';
      if (/\blight\b/i.test(cls)) return 'light';

      try {
        var ref = body || de;
        if (!ref) return null;
        var hostWindow = window.parent && window.parent !== window ? window.parent : window;
        var bg = hostWindow.getComputedStyle(ref).backgroundColor || '';
        var nums = bg.match(/\d+/g);
        if (!nums || nums.length < 3) return null;
        var r = Number(nums[0]);
        var g = Number(nums[1]);
        var b = Number(nums[2]);
        var luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return luma < 0.55 ? 'dark' : 'light';
      } catch (_ignored) {
        return null;
      }
    }

    function detectTheme() {
      try {
        if (window.parent && window.parent !== window) {
          var t = parseThemeFromDocument(window.parent.document);
          if (t) return t;
        }
      } catch (_ignored) {}

      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
      }
      return 'light';
    }

    function initHeroCarousel() {
      var carousel = document.querySelector('[data-hero-carousel]');
      if (!carousel) return null;

      var slides = Array.prototype.slice.call(carousel.querySelectorAll('.hero-slide'));
      var dots = Array.prototype.slice.call(carousel.querySelectorAll('.hero-dot'));
      var prev = carousel.querySelector('[data-role="prev"]');
      var next = carousel.querySelector('[data-role="next"]');
      if (!slides.length) return null;

      if (slides.length === 1) {
        if (prev) prev.style.display = 'none';
        if (next) next.style.display = 'none';
        if (dots[0]) dots[0].style.display = 'none';
        return null;
      }

      var index = 0;
      var timer = null;
      var hover = false;

      function setActive(nextIndex) {
        index = (nextIndex + slides.length) % slides.length;
        slides.forEach(function (slide, i) {
          var active = i === index;
          slide.classList.toggle('is-active', active);
          slide.setAttribute('aria-hidden', active ? 'false' : 'true');
        });
        dots.forEach(function (dot, i) {
          var active = i === index;
          dot.classList.toggle('is-active', active);
          dot.setAttribute('aria-current', active ? 'true' : 'false');
        });
      }

      function start() {
        if (timer) clearInterval(timer);
        timer = setInterval(function () {
          if (hover) return;
          setActive(index + 1);
        }, 4600);
      }

      function stop() {
        if (!timer) return;
        clearInterval(timer);
        timer = null;
      }

      if (prev) {
        prev.addEventListener('click', function (evt) {
          evt.preventDefault();
          setActive(index - 1);
          start();
        });
      }
      if (next) {
        next.addEventListener('click', function (evt) {
          evt.preventDefault();
          setActive(index + 1);
          start();
        });
      }
      dots.forEach(function (dot) {
        dot.addEventListener('click', function (evt) {
          evt.preventDefault();
          var to = Number(dot.getAttribute('data-index') || 0);
          setActive(to);
          start();
        });
      });

      carousel.addEventListener('mouseenter', function () {
        hover = true;
      });
      carousel.addEventListener('mouseleave', function () {
        hover = false;
      });
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) stop();
        else start();
      });

      setActive(0);
      start();
      return stop;
    }

    function syncTheme() {
      root.setAttribute('data-theme', detectTheme());
    }

    syncTheme();
    var stopCarousel = initHeroCarousel();
    var ticker = setInterval(syncTheme, 700);

    try {
      if (window.parent && window.parent !== window && window.parent.document) {
        var pdoc = window.parent.document;
        var mo = new MutationObserver(syncTheme);
        mo.observe(pdoc.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
        if (pdoc.body) {
          mo.observe(pdoc.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
        }
      }
    } catch (_ignored) {}

    window.addEventListener('beforeunload', function () {
      clearInterval(ticker);
      if (typeof stopCarousel === 'function') stopCarousel();
    });
  })();
  </script>
  </body></html>`);
});

app.listen(port, () => {
  console.log(`[appstore-expand] listening on :${port}`);
});
