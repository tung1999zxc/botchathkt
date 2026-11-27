/* =========================================================================
 * Cloudflare Worker - FB Token Swap + License Server + Trang quan tri Key
 * -------------------------------------------------------------------------
 * Worker nay gop 3 chuc nang vao mot domain duy nhat:
 *
 *   [FB TOKEN]  GET  /login, GET /callback, GET /refresh, GET /info
 *   [LICENSE]   POST /license/activate, POST /license/verify, GET /license/ping
 *   [ADMIN]     GET  /admin, POST /admin/api/*
 *
 * BIEN MOI TRUONG (Cloudflare Dashboard > Settings > Variables / Secrets):
 *   FB_APP_ID       (Variable) App ID Facebook
 *   FB_APP_SECRET   (Secret)   App Secret Facebook
 *   REDIRECT_URI    (Variable) https://<worker>.workers.dev/callback
 *   EXT_ORIGIN      (Variable) chrome-extension://<EXTENSION_ID>
 *   ADMIN_PASSWORD  (Secret)   Mat khau trang quan tri key
 *   LICENSE_KV      (Binding)  KV Namespace ten "LICENSE_KV"
 *
 * BAO MAT
 *   - Key duoc luoi bang SHA-256, DB lo -> khong khoi phuc duoc key.
 *   - ADMIN_PASSWORD luu o dang Secret (KHONG dat trong code).
 *   - Rate limit theo IP chong brute-force key.
 * ========================================================================= */

const FB_GRAPH = "https://graph.facebook.com/v25.0";

/* =========================================================================
 * KHOA CONG XAC MINH CHU KY (ECDSA P-256)
 * -------------------------------------------------------------------------
 * Khoa RIENG nam trong Worker Secret "LICENSE_PRIVATE_KEY" (KHONG bao gio
 * dua vao code hay repo). Khoa CONG ben duoi duoc nhung san vao extension
 * de xac minh chu ky - khong the bi gia mao.
 *
 * Sinh cap khoa moi: node _gen_keys.js
 * ========================================================================= */
const LICENSE_PUBLIC_KEY_B64 =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE7TZCBHimLGN6dtQ6tv45UR4IPknmI5GyfE5o4mnTV1B0xk8HF+Ke/Ae4aqooT4jPwGTD+Fw8nZ17PU2E55u/RQ==";

const HTML_ESC = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

function jsonResponse(data, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function handleOptions(request) {
  const origin = request.headers.get("Origin") || "*";
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

async function exchangeCodeForLongLivedToken(code, appId, appSecret, redirectUri) {
  // Bước 1: code → short-lived token
  const s1 = await fetch(
    `${FB_GRAPH}/oauth/access_token?` +
      new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      }),
  );
  const d1 = await s1.json();
  if (d1.error) throw new Error(d1.error.message);
  const shortToken = d1.access_token;

  // Bước 2: short-lived → long-lived (60 ngày)
  const s2 = await fetch(
    `${FB_GRAPH}/oauth/access_token?` +
      new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortToken,
      }),
  );
  const d2 = await s2.json();
  if (d2.error) throw new Error(d2.error.message);

  return {
    access_token: d2.access_token,
    token_type: d2.token_type || "bearer",
    expires_in: d2.expires_in || 5184000,
  };
}

async function refreshLongLivedToken(token, appId, appSecret) {
  const s = await fetch(
    `${FB_GRAPH}/oauth/access_token?` +
      new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: token,
      }),
  );
  const d = await s.json();
  if (d.error) throw new Error(d.error.message);
  return {
    access_token: d.access_token,
    token_type: d.token_type || "bearer",
    expires_in: d.expires_in || 5184000,
  };
}

async function debugToken(token, appId, appSecret) {
  const s = await fetch(
    `${FB_GRAPH}/debug_token?` +
      new URLSearchParams({
        input_token: token,
        access_token: `${appId}|${appSecret}`,
      }),
  );
  const d = await s.json();
  return d.data || {};
}

function buildLoginUrl(appId, redirectUri, state) {
  const scope = [
    "pages_show_list",
    "pages_manage_metadata",
    "pages_manage_roles",
    "business_management",
    "pages_messaging",
    "ads_read",
    "ads_management",
  ].join(",");

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    state,
  });
  return `https://www.facebook.com/v25.0/dialog/oauth?${params}`;
}

function successHtml(tokenData, extOrigin) {
  const safeOrigin = HTML_ESC(extOrigin || "");
  const tokenJson = JSON.stringify({
    ok: true,
    access_token: tokenData.access_token,
    expires_in: tokenData.expires_in,
    token_type: tokenData.token_type,
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Đang chuyển về Extension...</title>
<style>body{font-family:system-ui;background:#f4f6fa;margin:0;padding:40px;text-align:center}
.box{max-width:480px;margin:auto;background:#fff;padding:32px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.08)}
h1{color:#1877f2;margin:0 0 16px}
p{color:#555;line-height:1.6}
.btn{display:inline-block;background:#1877f2;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;margin-top:16px;font-weight:600}
.err{color:#c0392b;background:#fdecea;padding:12px;border-radius:8px;margin-top:16px;word-break:break-all}</style>
</head><body><div class="box">
<h1>✅ Lấy token thành công</h1>
<p>Token 60 ngày đã sẵn sàng. Extension sẽ tự đóng tab này trong giây lát.</p>
<p>Nếu không tự đóng, bấm nút bên dưới:</p>
<a class="btn" id="cbBtn">📥 MỞ EXTENSION</a>
</div>
<script>
(function(){
  var data = ${tokenJson};
  var origin = ${JSON.stringify(safeOrigin)};
  function fallback(){
    document.body.innerHTML = '<div class="box"><h1>❌ Không tự chuyển được</h1><p>Tab không tự đóng được. Hãy copy token bên dưới và dán vào extension:</p><div class="err"><code>' + data.access_token + '</code></div></div>';
  }
  if (window.opener && !window.opener.closed) {
    try { window.opener.postMessage({type:'FB_LONG_TOKEN', payload:data}, origin || '*'); setTimeout(function(){window.close()}, 800); return; } catch(e){}
  }
  if (origin && origin.startsWith('chrome-extension://')) {
    try { chrome.runtime.sendMessage ? chrome.runtime.sendMessage(origin, data) : null; } catch(e){}
    var u = origin + '/dashboard.html?fb_token=' + encodeURIComponent(data.access_token) + '&fb_expires_in=' + data.expires_in;
    document.getElementById('cbBtn').href = u;
    setTimeout(function(){ try { window.location.href = u; } catch(e){} }, 1200);
  } else {
    fallback();
  }
})();
</script>
</body></html>`;
}


/* =========================================================================
 * LICENSE WORKER - Phan 1: Logic license (dung chung helper voi worker.js)
 * ========================================================================= */

// ============================================================
// TIEN ICH LICENSE
// ============================================================

async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", enc);
  const bytes = new Uint8Array(hash);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/* =========================================================================
 * CHU KY SO (ECDSA P-256) - Uu tien 1
 * -------------------------------------------------------------------------
 * Y EU:
 *   Server KY payload license bang khoa RIENG (Secret).
 *   Extension XAC MINH bang khoa CONG (public key) nhung san trong code.
 *
 * YEU CAU: Client KHONG THE tu gia mao du lieu license trong storage,
 *           vi du lieu do bat buoc phai co chu ky hop le cua server.
 *
 * SECRET:  LICENSE_PRIVATE_KEY  (PKCS8, base64)  -> Worker Secret
 * PUBLIC:  LICENSE_PUBLIC_KEY   (SPKI,  base64)  -> nhung vao license_core.js
 * ========================================================================= */

// Cache khoa private da import (tranh import lai moi lan)
let _privKeyCache = null;

function b64ToBytes(b64) {
  const bin = atob(String(b64 || "").trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

async function getPrivateKey(env) {
  if (_privKeyCache) return _privKeyCache;
  const b64 = env.LICENSE_PRIVATE_KEY;
  if (!b64) return null;
  try {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      b64ToBytes(b64),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    _privKeyCache = key;
    return key;
  } catch (e) {
    return null;
  }
}

/**
 * Tao payload chuan hoa de ky.
 * Thu tu truong PHAI co dinh (client dung cung thu tu).
 */
function buildSignedPayload(data) {
  return JSON.stringify({
    key: data.key,
    deviceId: data.deviceId,
    plan: data.plan,
    expiresAt: data.expiresAt,
    status: data.status,
    maxDevices: data.maxDevices,
    issuedAt: data.issuedAt,
    nonce: data.nonce,
  });
}

/**
 * Ky payload. Tra null neu khong co khoa private (server chua cau hinh).
 * @returns {Promise<string|null>} chu ky base64
 */
async function signLicensePayload(env, data) {
  const key = await getPrivateKey(env);
  if (!key) return null;
  try {
    const payload = buildSignedPayload(data);
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(payload),
    );
    return bytesToB64(sig);
  } catch (e) {
    return null;
  }
}

// Crockford Base32 (bo I, L, O, U de tranh nham 1/0)
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function randomKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let body = "";
  for (let i = 0; i < 16; i++) body += B32[bytes[i] % 32];
  return (
    "TL_" +
    body.slice(0, 4) +
    "-" +
    body.slice(4, 8) +
    "-" +
    body.slice(8, 12) +
    "-" +
    body.slice(12, 16)
  );
}

function keyPrefix(key) {
  return String(key || "").slice(0, 7);
}

function normKey(key) {
  return String(key || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function normalizeDevice(deviceId) {
  return String(deviceId || "")
    .trim()
    .toUpperCase()
    .slice(0, 64);
}

// ---- Plans ----
function planDuration(plan, customDays) {
  switch (plan) {
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return 30 * 24 * 60 * 60 * 1000;
    case "lifetime":
      return 0; // 0 = khong het han
    case "custom":
      return Math.max(1, parseInt(customDays, 10) || 30) * 24 * 60 * 60 * 1000;
    default:
      return 30 * 24 * 60 * 60 * 1000;
  }
}

function planLabel(plan) {
  switch (plan) {
    case "7d":
      return "7 ngay";
    case "30d":
      return "30 ngay";
    case "lifetime":
      return "Vo han";
    case "custom":
      return "Tuy chinh";
    default:
      return plan || "-";
  }
}

// ============================================================
// RATE LIMIT
// ============================================================
const rateBuckets = new Map();

function checkRateLimit(id, maxCount, windowMs) {
  const now = Date.now();
  let bucket = rateBuckets.get(id);
  if (!bucket || now - bucket.start > windowMs) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(id, bucket);
  }
  bucket.count++;
  if (rateBuckets.size > 10000) {
    for (const [k, v] of rateBuckets) {
      if (now - v.start > windowMs) rateBuckets.delete(k);
    }
  }
  return bucket.count <= maxCount;
}

function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "unknown"
  );
}

// ============================================================
// KV HELPERS
// ============================================================
async function kvGet(env, key) {
  try {
    return await env.LICENSE_KV.get(key, { type: "json" });
  } catch (e) {
    return null;
  }
}

async function kvPut(env, key, value) {
  await env.LICENSE_KV.put(key, JSON.stringify(value));
}

async function kvDelete(env, key) {
  await env.LICENSE_KV.delete(key);
}

async function kvListAll(env) {
  const out = [];
  try {
    let cursor;
    do {
      const res = await env.LICENSE_KV.list({ cursor });
      for (const k of res.keys) {
        const val = await kvGet(env, k.name);
        if (val) out.push(val);
      }
      cursor = res.list_complete ? undefined : res.cursor;
    } while (cursor);
  } catch (e) {
    // ignore
  }
  return out;
}

// ============================================================
// SESSION DANG NHAP ADMIN
// ============================================================
const SESSION_TTL = 8 * 60 * 60 * 1000;

function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  const parts = raw.split(";");
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx < 0) continue;
    if (p.slice(0, idx).trim() === name) {
      return decodeURIComponent(p.slice(idx + 1).trim());
    }
  }
  return "";
}

async function createSession(env) {
  const token =
    crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  const exp = Date.now() + SESSION_TTL;
  await kvPut(env, "session:" + token, { exp: exp, createdAt: Date.now() });
  return { token: token, exp: exp };
}

async function validateSession(env, request) {
  const token = getCookie(request, "lic_admin");
  if (!token) return false;
  const sess = await kvGet(env, "session:" + token);
  if (!sess || !sess.exp || sess.exp < Date.now()) {
    await kvDelete(env, "session:" + token);
    return false;
  }
  return true;
}

function safeEqual(a, b) {
  const sa = String(a || "");
  const sb = String(b || "");
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}

// ============================================================
// KIEM TRA KEY
// ============================================================
async function validateKey(env, key, deviceId) {
  const hash = await sha256Hex(normKey(key));
  const record = await kvGet(env, "key:" + hash);

  if (!record) {
    return { ok: false, code: "invalid", message: "Key khong ton tai" };
  }

  if (record.status === "revoked") {
    return {
      ok: false,
      code: "revoked",
      message: "Key da bi thu hoi. Lien he admin de cap lai.",
    };
  }

  if (record.status === "disabled") {
    return {
      ok: false,
      code: "revoked",
      message: "Key da bi vo hieu hoa. Lien he admin de cap lai.",
    };
  }

  const now = Date.now();

  if (record.expiresAt && record.expiresAt > 0 && record.expiresAt < now) {
    if (record.status !== "expired") {
      record.status = "expired";
      await kvPut(env, "key:" + hash, record);
    }
    return {
      ok: false,
      code: "expired",
      message: "Key da het han (" + planLabel(record.plan) + ")",
    };
  }

  const devices = Array.isArray(record.devices) ? record.devices : [];
  const dev = normalizeDevice(deviceId);
  const maxDevices = record.maxDevices || 1;

  const found = devices.find((d) => d.deviceId === dev);
  if (!found && devices.length >= maxDevices) {
    return {
      ok: false,
      code: "max_devices",
      message:
        "Key nay da kich hoat du " +
        maxDevices +
        " may. Hay go may cu khac hoac lien he admin.",
    };
  }

  return { ok: true, code: "ok", message: "Hop le", record: record, hash: hash };
}

// ============================================================
// API KICH HOAT / XAC MINH
// ============================================================
async function handleLicenseActivate(request, env, origin) {
  const ip = clientIp(request);

  if (!checkRateLimit(ip, 20, 10 * 60 * 1000)) {
    return jsonResponse(
      {
        ok: false,
        code: "rate_limit",
        message: "Qua nhieu lan thu. Thu lai sau.",
      },
      429,
      origin,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse(
      { ok: false, code: "bad_request", message: "Du lieu khong hop le" },
      400,
      origin,
    );
  }

  const key = normKey(body.key);
  const deviceId = normalizeDevice(body.deviceId);

  if (!key) {
    return jsonResponse(
      { ok: false, code: "missing_key", message: "Thieu key" },
      400,
      origin,
    );
  }
  if (!deviceId) {
    return jsonResponse(
      { ok: false, code: "missing_device", message: "Thieu ma may" },
      400,
      origin,
    );
  }

  const check = await validateKey(env, key, deviceId);

  if (!check.ok) {
    const hash = await sha256Hex(key);
    const failKey = "fail:" + hash;
    const fail = (await kvGet(env, failKey)) || { count: 0, until: 0 };
    const now = Date.now();

    if (fail.until && fail.until > now) {
      const mins = Math.ceil((fail.until - now) / 60000);
      return jsonResponse(
        {
          ok: false,
          code: "locked",
          message:
            "Key dang bi khoa tam thoi. Thu lai sau " + mins + " phut.",
        },
        429,
        origin,
      );
    }

    fail.count = (fail.count || 0) + 1;
    if (fail.count >= MAX_FAILED) {
      fail.count = 0;
      fail.until = now + KEY_LOCK_MS;
    }
    await kvPut(env, failKey, fail);

    return jsonResponse(
      { ok: false, code: check.code, message: check.message },
      400,
      origin,
    );
  }

  // === THANH CONG: ghi nhan may ===
  const record = check.record;
  record.devices = Array.isArray(record.devices) ? record.devices : [];

  const existing = record.devices.find((d) => d.deviceId === deviceId);
  if (existing) {
    existing.lastSeen = Date.now();
  } else {
    record.devices.push({
      deviceId: deviceId,
      activatedAt: Date.now(),
      lastSeen: Date.now(),
    });
  }

  record.status = "active";
  record.activatedCount = (record.activatedCount || 0) + (existing ? 0 : 1);
  record.lastSeen = Date.now();

  await kvPut(env, "key:" + check.hash, record);

  // === CHU KY SO (Uu tien 1) ===
  const signed = await buildSignedData(env, key, deviceId, record);

  return jsonResponse(
    {
      ok: true,
      message: "Kich hoat thanh cong",
      expiresAt: record.expiresAt || 0,
      plan: record.plan,
      maxDevices: record.maxDevices || 1,
      serverTime: Date.now(),
      // Du lieu co chu ky
      payload: signed.payload,
      signature: signed.signature,
      keyId: signed.keyId,
    },
    200,
    origin,
  );
}

async function handleLicenseVerify(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse(
      { ok: false, code: "bad_request", message: "Du lieu khong hop le" },
      400,
      origin,
    );
  }

  const key = normKey(body.key);
  const deviceId = normalizeDevice(body.deviceId);

  if (!key || !deviceId) {
    return jsonResponse(
      { ok: false, code: "bad_request", message: "Thieu thong tin" },
      400,
      origin,
    );
  }

  const check = await validateKey(env, key, deviceId);

  if (!check.ok) {
    return jsonResponse(
      {
        ok: false,
        code: check.code,
        message: check.message,
        serverTime: Date.now(),
      },
      400,
      origin,
    );
  }

  const record = check.record;
  record.devices = Array.isArray(record.devices) ? record.devices : [];
  const dev = record.devices.find((d) => d.deviceId === deviceId);
  if (dev) dev.lastSeen = Date.now();
  record.lastSeen = Date.now();
  await kvPut(env, "key:" + check.hash, record);

  // === CHU KY SO (Uu tien 1) ===
  const signed = await buildSignedData(env, key, deviceId, record);

  return jsonResponse(
    {
      ok: true,
      message: "Hop le",
      expiresAt: record.expiresAt || 0,
      plan: record.plan,
      maxDevices: record.maxDevices || 1,
      serverTime: Date.now(),
      payload: signed.payload,
      signature: signed.signature,
      keyId: signed.keyId,
    },
    200,
    origin,
  );
}

/* =========================================================================
 * BUILD + KY DU LIEU LICENSE
 * ========================================================================= */

/**
 * Tao payload (chuoi JSON) + chu ky cho mot license.
 * @returns {Promise<{payload:string, signature:string|null, keyId:string|null}>}
 */
async function buildSignedData(env, key, deviceId, record) {
  const data = {
    key: key,
    deviceId: deviceId,
    plan: record.plan,
    expiresAt: record.expiresAt || 0,
    status: "active",
    maxDevices: record.maxDevices || 1,
    issuedAt: Date.now(),
    nonce: crypto.randomUUID(),
  };

  const payload = buildSignedPayload(data);
  const signature = await signLicensePayload(env, data);
  const keyId = signature ? await licenseKeyId() : null;

  return { payload: payload, signature: signature, keyId: keyId };
}

/**
 * Kiem tra server da duoc cau hinh khoa chu ky chua.
 * @returns {Promise<boolean>}
 */
async function hasSigningKey(env) {
  return !!(await getPrivateKey(env));
}

/**
 * Fingerprint cua khoa public (dung de client nhan biet key nao).
 * @returns {Promise<string>}
 */
async function licenseKeyId() {
  const pub = typeof LICENSE_PUBLIC_KEY_B64 !== "undefined" ? LICENSE_PUBLIC_KEY_B64 : "";
  if (!pub) return "";
  const h = await sha256Hex(pub);
  return h.slice(0, 16);
}

/* =========================================================================
 * LICENSE WORKER - Phan 4: Config + Router
 * ========================================================================= */

// Thoi gian khoa key sau N lan thu sai
const MAX_FAILED = 5;
const KEY_LOCK_MS = 15 * 60 * 1000;

/**
 * Route cac endpoint license.
 * @returns {Promise<Response|null>} null = khong phai route license
 */
async function routeLicense(request, env, url, origin) {
  const path = url.pathname.replace(/\/+$/, "") || "/";

  // ===== GET /license/ping =====
  // Dung de phan biet:
  //   - Server SONG (ping OK) nhung /verify bi chan  => fail-CLOSED
  //   - Server CHET (ping fail)                     => fail-OPEN (offline grace)
  if (path === "/license/ping") {
    return jsonResponse(
      {
        ok: true,
        service: "license-server",
        time: Date.now(),
        hasKv: !!env.LICENSE_KV,
        hasAdmin: !!env.ADMIN_PASSWORD,
        hasSigning: !!(await getPrivateKey(env)),
        // Fingerprint khoa cong dang chay tren server.
        // So voi SHA256(khoa cong trong license_core.js) de kiem chung
        // khoa cong client va khoa rieng tren Worker co khop hay khong.
        keyId: await licenseKeyId(),
      },
      200,
      origin,
    );
  }

  // ===== POST /license/activate =====
  if (path === "/license/activate" && request.method === "POST") {
    return handleLicenseActivate(request, env, origin);
  }

  // ===== POST /license/verify =====
  if (path === "/license/verify" && request.method === "POST") {
    return handleLicenseVerify(request, env, origin);
  }

  return null;
}

/* =========================================================================
 * LICENSE WORKER - Phan 2: Admin API + trang quan tri
 * (noi dung nay noi vao license_worker_part1.js khi build)
 * ========================================================================= */

// ============================================================
// ADMIN API
// ============================================================
async function handleAdminApi(request, env, path) {
  const ip = clientIp(request);
  const authed = await validateSession(env, request);

  // --- POST /admin/api/login ---
  if (path === "/admin/api/login" && request.method === "POST") {
    if (!checkRateLimit("login:" + ip, 10, 15 * 60 * 1000)) {
      return jsonResponse({ ok: false, message: "Qua nhieu lan thu dang nhap" }, 429);
    }
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ ok: false, message: "Du lieu khong hop le" }, 400);
    }
    const expected = env.ADMIN_PASSWORD || "";
    if (!expected) {
      return jsonResponse(
        { ok: false, message: "Chua cau hinh ADMIN_PASSWORD tren Worker" },
        500,
      );
    }
    if (!safeEqual(body.password || "", expected)) {
      return jsonResponse({ ok: false, message: "Mat khau khong dung" }, 401);
    }
    const sess = await createSession(env);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie":
          "lic_admin=" +
          sess.token +
          "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" +
          Math.floor(SESSION_TTL / 1000),
        "Cache-Control": "no-store",
      },
    });
  }

  // --- POST /admin/api/logout ---
  if (path === "/admin/api/logout" && request.method === "POST") {
    const token = getCookie(request, "lic_admin");
    if (token) await kvDelete(env, "session:" + token);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": "lic_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
      },
    });
  }

  // Tu day tro di yeu cau dang nhap
  if (!authed) {
    return jsonResponse({ ok: false, message: "Chua dang nhap" }, 401);
  }

  // --- GET /admin/api/keys ---
  if (path === "/admin/api/keys" && request.method === "GET") {
    const all = await kvListAll(env);
    const now = Date.now();
    const keys = all
      .filter((r) => r && r.keyHash)
      .map((r) => {
        const devices = Array.isArray(r.devices) ? r.devices : [];
        const expired = r.expiresAt && r.expiresAt > 0 && r.expiresAt < now;
        let status = r.status || "active";
        if (status === "active" && expired) status = "expired";
        return {
          keyHash: r.keyHash,
          keyPrefix: r.keyPrefix || "",
          status: status,
          plan: r.plan || "custom",
          planLabel: planLabel(r.plan),
          expiresAt: r.expiresAt || 0,
          maxDevices: r.maxDevices || 1,
          deviceCount: devices.length,
          devices: devices.map((d) => ({
            deviceId: d.deviceId,
            activatedAt: d.activatedAt || 0,
            lastSeen: d.lastSeen || 0,
          })),
          note: r.note || "",
          createdAt: r.createdAt || 0,
          lastSeen: r.lastSeen || 0,
          activatedCount: r.activatedCount || 0,
        };
      })
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const stats = {
      total: keys.length,
      active: keys.filter((k) => k.status === "active").length,
      expired: keys.filter((k) => k.status === "expired").length,
      revoked: keys.filter((k) => k.status === "revoked").length,
      devices: keys.reduce((s, k) => s + k.deviceCount, 0),
    };

    return jsonResponse({ ok: true, keys: keys, stats: stats });
  }

  // --- POST /admin/api/create ---
  if (path === "/admin/api/create" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ ok: false, message: "Du lieu khong hop le" }, 400);
    }
    const plan = body.plan || "30d";
    const customDays = body.customDays || 30;
    const maxDevices = Math.max(1, Math.min(10, parseInt(body.maxDevices, 10) || 1));
    const note = String(body.note || "").slice(0, 200);

    const rawKey = randomKey();
    const hash = await sha256Hex(rawKey);
    const duration = planDuration(plan, customDays);
    const now = Date.now();

    const record = {
      keyHash: hash,
      keyPrefix: keyPrefix(rawKey),
      status: "active",
      plan: plan,
      expiresAt: duration === 0 ? 0 : now + duration,
      maxDevices: maxDevices,
      devices: [],
      note: note,
      createdAt: now,
      lastSeen: 0,
      activatedCount: 0,
    };

    await kvPut(env, "key:" + hash, record);

    return jsonResponse({
      ok: true,
      key: rawKey,
      record: {
        keyPrefix: record.keyPrefix,
        plan: record.plan,
        planLabel: planLabel(plan),
        expiresAt: record.expiresAt,
        maxDevices: maxDevices,
      },
    });
  }

  // --- POST /admin/api/revoke ---
  if (path === "/admin/api/revoke" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ ok: false, message: "Du lieu khong hop le" }, 400);
    }
    const hash = String(body.keyHash || "");
    const record = await kvGet(env, "key:" + hash);
    if (!record) {
      return jsonResponse({ ok: false, message: "Khong tim thay key" }, 404);
    }
    record.status = body.status === "active" ? "active" : "revoked";
    await kvPut(env, "key:" + hash, record);
    return jsonResponse({ ok: true, status: record.status });
  }

  // --- POST /admin/api/extend ---
  if (path === "/admin/api/extend" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ ok: false, message: "Du lieu khong hop le" }, 400);
    }
    const hash = String(body.keyHash || "");
    const record = await kvGet(env, "key:" + hash);
    if (!record) {
      return jsonResponse({ ok: false, message: "Khong tim thay key" }, 404);
    }
    const days = Math.max(1, Math.min(3650, parseInt(body.days, 10) || 30));
    const add = days * 24 * 60 * 60 * 1000;

    if (record.expiresAt === 0) {
      // Vo han -> gia han khong doi
      record.expiresAt = 0;
    } else {
      const base = Math.max(record.expiresAt, Date.now());
      record.expiresAt = base + add;
    }
    record.status = "active";
    await kvPut(env, "key:" + hash, record);
    return jsonResponse({ ok: true, expiresAt: record.expiresAt });
  }

  // --- POST /admin/api/unbind-device ---
  if (path === "/admin/api/unbind-device" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ ok: false, message: "Du lieu khong hop le" }, 400);
    }
    const hash = String(body.keyHash || "");
    const deviceId = normalizeDevice(body.deviceId);
    const record = await kvGet(env, "key:" + hash);
    if (!record) {
      return jsonResponse({ ok: false, message: "Khong tim thay key" }, 404);
    }
    record.devices = (record.devices || []).filter((d) => d.deviceId !== deviceId);
    await kvPut(env, "key:" + hash, record);
    return jsonResponse({ ok: true, deviceCount: record.devices.length });
  }

  // --- POST /admin/api/note ---
  if (path === "/admin/api/note" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ ok: false, message: "Du lieu khong hop le" }, 400);
    }
    const hash = String(body.keyHash || "");
    const record = await kvGet(env, "key:" + hash);
    if (!record) {
      return jsonResponse({ ok: false, message: "Khong tim thay key" }, 404);
    }
    record.note = String(body.note || "").slice(0, 200);
    await kvPut(env, "key:" + hash, record);
    return jsonResponse({ ok: true, note: record.note });
  }

  // --- POST /admin/api/delete ---
  if (path === "/admin/api/delete" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ ok: false, message: "Du lieu khong hop le" }, 400);
    }
    const hash = String(body.keyHash || "");
    await kvDelete(env, "key:" + hash);
    await kvDelete(env, "fail:" + hash);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, message: "Endpoint khong ton tai" }, 404);
}

/* =========================================================================
 * LICENSE WORKER - Phan 3: Trang quan tri (HTML)
 * ========================================================================= */

function adminPageHtml(authed) {
  const esc = HTML_ESC;

  return `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quan tri Key - Ads Manager Pro</title>
<style>
*{box-sizing:border-box}
body{font-family:"Segoe UI",system-ui,sans-serif;background:#f0f2f5;margin:0;padding:24px;color:#1c1e21}
.wrap{max-width:1200px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
.sub{color:#606770;font-size:13px;margin-bottom:20px}
.card{background:#fff;border:1px solid #dddfe2;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:18px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:18px}
.stat{background:#fff;border:1px solid #dddfe2;border-radius:10px;padding:14px;text-align:center}
.stat b{display:block;font-size:26px;color:#1877f2}
.stat span{font-size:12px;color:#606770}
label{display:block;font-size:13px;font-weight:600;margin-bottom:5px;color:#374151}
input,select,textarea{width:100%;padding:9px 11px;border:1px solid #ccd0d5;border-radius:7px;font-size:14px;font-family:inherit;box-sizing:border-box}
textarea{min-height:62px;resize:vertical}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
.row>div{flex:1;min-width:150px}
button{cursor:pointer;border:none;border-radius:7px;padding:10px 18px;font-size:14px;font-weight:600;font-family:inherit}
.btn-blue{background:#1877f2;color:#fff}
.btn-green{background:#22c55e;color:#fff}
.btn-red{background:#ef4444;color:#fff}
.btn-gray{background:#e4e6eb;color:#1c1e21}
.btn-sm{padding:5px 10px;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:9px 8px;text-align:left;border-bottom:1px solid #e4e6eb}
th{background:#f7f8fa;font-weight:600;color:#374151;font-size:12px;white-space:nowrap}
code{font-family:Consolas,monospace;background:#f0f2f5;padding:2px 6px;border-radius:4px;font-size:12px}
.tag{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600}
.tag-active{background:#dcfce7;color:#166534}
.tag-expired{background:#fee2e2;color:#991b1b}
.tag-revoked{background:#e5e7eb;color:#374151}
.msg{padding:11px 14px;border-radius:8px;margin-bottom:14px;font-size:14px;display:none}
.msg-ok{background:#dcfce7;color:#166534;border:1px solid #86efac}
.msg-err{background:#fee2e2;color:#991b1b;border:1px solid #fca5a5}
.msg-info{background:#dbeafe;color:#1e40af;border:1px solid #93c5fd}
.keybox{background:#0f172a;color:#4ade80;font-family:Consolas,monospace;font-size:19px;padding:15px;border-radius:9px;text-align:center;letter-spacing:1px;word-break:break-all;margin:12px 0}
.hidden{display:none!important}
.devbox{background:#f7f8fa;border:1px solid #e4e6eb;border-radius:7px;padding:9px;margin-top:5px;font-size:12px}
.login{max-width:400px;margin:70px auto}
table.scroll{overflow-x:auto}
.muted{color:#8c939d;font-size:12px}
</style></head>
<body>
<div class="wrap">

<h1>Quan tri Key Ban Quyen</h1>
<div class="sub">Ads Manager Pro TL_ - Tao, gia han, thu hoi va theo doi key</div>

<!-- DANG NHAP -->
<div id="loginBox" class="card login ${authed ? "hidden" : ""}">
  <h2 style="margin-top:0;font-size:18px">Dang nhap quan tri</h2>
  <div id="loginMsg" class="msg"></div>
  <label for="pwInput">Mat khau</label>
  <input type="password" id="pwInput" placeholder="Nhap mat khau quan tri" autocomplete="current-password">
  <button class="btn-blue" id="loginBtn" style="width:100%;margin-top:14px">DANG NHAP</button>
</div>

<!-- NOI DUNG -->
<div id="mainBox" class="${authed ? "" : "hidden"}">

  <div class="stats" id="statsBox"></div>

  <div class="card">
    <h2 style="margin-top:0;font-size:17px">Tao key moi</h2>
    <div id="createMsg" class="msg"></div>
    <div class="row">
      <div>
        <label for="planSel">Goi thoi han</label>
        <select id="planSel">
          <option value="7d">7 ngay</option>
          <option value="30d" selected>30 ngay</option>
          <option value="lifetime">Vo han</option>
          <option value="custom">Tuy chinh (so ngay)</option>
        </select>
      </div>
      <div id="customDaysWrap" class="hidden">
        <label for="customDays">So ngay</label>
        <input type="number" id="customDays" value="30" min="1" max="3650">
      </div>
      <div>
        <label for="maxDev">So may toi da</label>
        <input type="number" id="maxDev" value="1" min="1" max="10">
      </div>
      <div>
        <label for="noteInput">Ghi chu</label>
        <input type="text" id="noteInput" placeholder="Ten khach hang / don hang">
      </div>
      <div style="flex:0 0 auto">
        <button class="btn-green" id="createBtn">TAO KEY</button>
      </div>
    </div>
    <div id="newKeyBox" class="hidden">
      <div class="keybox" id="newKeyText"></div>
      <button class="btn-gray btn-sm" id="copyKeyBtn">SAO CHEP KEY</button>
      <button class="btn-gray btn-sm" id="hideKeyBtn">AN</button>
      <div class="muted" style="margin-top:8px">Chi hien thi key nay 1 lan. Hay luu lai ngay.</div>
    </div>
  </div>

  <div class="card">
    <h2 style="margin-top:0;font-size:17px">Danh sach key</h2>
    <div id="listMsg" class="msg"></div>
    <div style="margin-bottom:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn-gray btn-sm" id="refreshBtn">LAM MOI</button>
      <span class="muted" id="lastUpdate"></span>
      <div style="flex:1"></div>
      <button class="btn-gray btn-sm" id="logoutBtn">DANG XUAT</button>
    </div>
    <div class="scroll">
    <table>
      <thead><tr>
        <th>KEY</th><th>GOI</th><th>TRANG THAI</th><th>HET HAN</th><th>MAY</th><th>GHI CHU</th><th>THAO TAC</th>
      </tr></thead>
      <tbody id="keysBody">
        <tr><td colspan="7" style="text-align:center;color:#8c939d;padding:20px">Dang tai...</td></tr>
      </tbody>
    </table>
    </div>
  </div>

</div>
</div>

<script>
var AUTHED = ${authed ? "true" : "false"};

function showMsg(el, text, type) {
  if (!el) return;
  el.className = "msg msg-" + (type || "ok");
  el.textContent = text;
  el.style.display = "block";
  if (type !== "err") {
    setTimeout(function () { el.style.display = "none"; }, 5000);
  }
}
function hideMsg(el) { if (el) el.style.display = "none"; }

function fmtDate(ts) {
  if (!ts) return "Vo han";
  var d = new Date(ts);
  var p = function (n) { return n < 10 ? "0" + n : "" + n; };
  return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}
function fmtAgo(ts) {
  if (!ts) return "-";
  var s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s truoc";
  if (s < 3600) return Math.floor(s / 60) + "p truoc";
  if (s < 86400) return Math.floor(s / 3600) + " gio truoc";
  return Math.floor(s / 86400) + " ngay truoc";
}

async function api(path, opts) {
  var res = await fetch(path, Object.assign({
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
  }, opts || {}));
  var data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data: data || {} };
}

// ===== DANG NHAP =====
var loginBtn = document.getElementById("loginBtn");
if (loginBtn) {
  loginBtn.addEventListener("click", async function () {
    var pw = document.getElementById("pwInput").value;
    var r = await api("/admin/api/login", { method: "POST", body: JSON.stringify({ password: pw }) });
    if (r.data.ok) {
      document.getElementById("loginBox").classList.add("hidden");
      document.getElementById("mainBox").classList.remove("hidden");
      showMsg(document.getElementById("listMsg"), "Dang nhap thanh cong", "ok");
      loadKeys();
    } else {
      showMsg(document.getElementById("loginMsg"), r.data.message || "Dang nhap that bai", "err");
    }
  });
  document.getElementById("pwInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") loginBtn.click();
  });
}

// ===== TAO KEY =====
var planSel = document.getElementById("planSel");
if (planSel) {
  planSel.addEventListener("change", function () {
    document.getElementById("customDaysWrap").classList.toggle("hidden", planSel.value !== "custom");
  });
}

var createBtn = document.getElementById("createBtn");
if (createBtn) {
  createBtn.addEventListener("click", async function () {
    var plan = planSel.value;
    var payload = {
      plan: plan,
      customDays: document.getElementById("customDays").value,
      maxDevices: document.getElementById("maxDev").value,
      note: document.getElementById("noteInput").value,
    };
    createBtn.disabled = true;
    createBtn.textContent = "DANG TAO...";
    var r = await api("/admin/api/create", { method: "POST", body: JSON.stringify(payload) });
    createBtn.disabled = false;
    createBtn.textContent = "TAO KEY";
    if (r.data.ok) {
      document.getElementById("newKeyText").textContent = r.data.key;
      document.getElementById("newKeyBox").classList.remove("hidden");
      document.getElementById("noteInput").value = "";
      showMsg(document.getElementById("createMsg"), "Da tao key moi: " + r.data.record.planLabel, "ok");
      loadKeys();
    } else {
      showMsg(document.getElementById("createMsg"), r.data.message || "Tao key that bai", "err");
    }
  });
}

var copyKeyBtn = document.getElementById("copyKeyBtn");
if (copyKeyBtn) {
  copyKeyBtn.addEventListener("click", function () {
    var t = document.getElementById("newKeyText").textContent;
    navigator.clipboard.writeText(t).then(function () {
      showMsg(document.getElementById("createMsg"), "Da sao chep key vao clipboard", "ok");
    });
  });
}
var hideKeyBtn = document.getElementById("hideKeyBtn");
if (hideKeyBtn) {
  hideKeyBtn.addEventListener("click", function () {
    document.getElementById("newKeyBox").classList.add("hidden");
  });
}

// ===== DANH SACH KEY =====
var refreshBtn = document.getElementById("refreshBtn");
if (refreshBtn) refreshBtn.addEventListener("click", loadKeys);

var logoutBtn = document.getElementById("logoutBtn");
if (logoutBtn) {
  logoutBtn.addEventListener("click", async function () {
    await api("/admin/api/logout", { method: "POST" });
    location.reload();
  });
}

async function loadKeys() {
  var r = await api("/admin/api/keys");
  if (r.status === 401) {
    document.getElementById("mainBox").classList.add("hidden");
    document.getElementById("loginBox").classList.remove("hidden");
    showMsg(document.getElementById("loginMsg"), "Phien dang nhap het han, vui long dang nhap lai", "err");
    return;
  }
  if (!r.data.ok) {
    showMsg(document.getElementById("listMsg"), r.data.message || "Tai danh sach that bai", "err");
    return;
  }
  var keys = r.data.keys || [];
  var st = r.data.stats || {};
  renderStats(st);
  var body = document.getElementById("keysBody");
  if (!keys.length) {
    body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#8c939d;padding:20px">Chua co key nao. Tao key dau tien o tren.</td></tr>';
  } else {
    body.innerHTML = keys.map(function (k) { return renderRow(k); }).join("");
    bindRowButtons();
  }
  document.getElementById("lastUpdate").textContent = "Cap nhat luc " + fmtDate(Date.now());
}

function renderStats(st) {
  document.getElementById("statsBox").innerHTML =
    '<div class="stat"><b>' + (st.total || 0) + '</b><span>Tong key</span></div>' +
    '<div class="stat"><b style="color:#16a34a">' + (st.active || 0) + '</b><span>Dang hoat dong</span></div>' +
    '<div class="stat"><b style="color:#dc2626">' + (st.expired || 0) + '</b><span>Het han</span></div>' +
    '<div class="stat"><b style="color:#6b7280">' + (st.revoked || 0) + '</b><span>Da thu hoi</span></div>' +
    '<div class="stat"><b style="color:#7c3aed">' + (st.devices || 0) + '</b><span>Mai da kich hoat</span></div>';
}

function renderRow(k) {
  var tagClass = "tag tag-" + (k.status || "active");
  var tagText = { active: "Hoat dong", expired: "Het han", revoked: "Da thu hoi", disabled: "Vo hieu hoa" }[k.status] || k.status;
  var expText = k.expiresAt === 0 ? "Vo han" : fmtDate(k.expiresAt);
  var devHtml = "";
  if (k.devices && k.devices.length) {
    devHtml = k.devices.map(function (d) {
      return '<div class="devbox"><code>' + d.deviceId + '</code> ' +
        '<div style="color:#6b7280;margin-top:3px">Kich hoat: ' + fmtDate(d.activatedAt) + ' | Lan cuoi: ' + fmtAgo(d.lastSeen) + '</div>' +
        '<button class="btn-gray btn-sm unbind" data-hash="' + k.keyHash + '" data-dev="' + d.deviceId + '" style="margin-top:5px">GO MAY</button>' +
        '</div>';
    }).join("");
  }
  var devCell = '<td><b>' + k.deviceCount + '/' + k.maxDevices + '</b>' + devHtml + '</td>';
  var actBtn = k.status === "revoked"
    ? '<button class="btn-green btn-sm act" data-hash="' + k.keyHash + '" data-status="active">KICH HOAT LAI</button>'
    : '<button class="btn-red btn-sm act" data-hash="' + k.keyHash + '" data-status="revoked">THU HOI</button>';

  return '<tr>' +
    '<td><code>' + k.keyPrefix + '...</code></td>' +
    '<td>' + k.planLabel + '</td>' +
    '<td><span class="' + tagClass + '">' + tagText + '</span></td>' +
    '<td>' + expText + '</td>' +
    devCell +
    '<td>' + (k.note ? escapeHtml(k.note) : '<span class="muted">-</span>') + '</td>' +
    '<td style="white-space:nowrap">' + actBtn +
    ' <button class="btn-gray btn-sm ext" data-hash="' + k.keyHash + '">GIA HAN</button>' +
    ' <button class="btn-gray btn-sm del" data-hash="' + k.keyHash + '">XOA</button></td>' +
    '</tr>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function bindRowButtons() {
  document.querySelectorAll("button.act").forEach(function (b) {
    b.addEventListener("click", async function () {
      var r = await api("/admin/api/revoke", {
        method: "POST",
        body: JSON.stringify({ keyHash: b.dataset.hash, status: b.dataset.status }),
      });
      if (r.data.ok) {
        showMsg(document.getElementById("listMsg"), "Da cap nhat trang thai key", "ok");
        loadKeys();
      } else {
        showMsg(document.getElementById("listMsg"), r.data.message || "Loi", "err");
      }
    });
  });
  document.querySelectorAll("button.ext").forEach(function (b) {
    b.addEventListener("click", async function () {
      var days = prompt("So ngay gia han (vuot qua so da dung):", "30");
      if (!days) return;
      var r = await api("/admin/api/extend", {
        method: "POST",
        body: JSON.stringify({ keyHash: b.dataset.hash, days: days }),
      });
      if (r.data.ok) {
        showMsg(document.getElementById("listMsg"), "Da gia han. Han moi: " + fmtDate(r.data.expiresAt), "ok");
        loadKeys();
      } else {
        showMsg(document.getElementById("listMsg"), r.data.message || "Loi", "err");
      }
    });
  });
  document.querySelectorAll("button.unbind").forEach(function (b) {
    b.addEventListener("click", async function () {
      if (!confirm("Go may nay khoi key?")) return;
      var r = await api("/admin/api/unbind-device", {
        method: "POST",
        body: JSON.stringify({ keyHash: b.dataset.hash, deviceId: b.dataset.dev }),
      });
      if (r.data.ok) {
        showMsg(document.getElementById("listMsg"), "Da go may. Con " + r.data.deviceCount + " may.", "ok");
        loadKeys();
      } else {
        showMsg(document.getElementById("listMsg"), r.data.message || "Loi", "err");
      }
    });
  });
  document.querySelectorAll("button.del").forEach(function (b) {
    b.addEventListener("click", async function () {
      if (!confirm("XOA VINH VIEN key nay? Khong the khoi phuc.")) return;
      var r = await api("/admin/api/delete", {
        method: "POST",
        body: JSON.stringify({ keyHash: b.dataset.hash }),
      });
      if (r.data.ok) {
        showMsg(document.getElementById("listMsg"), "Da xoa key", "ok");
        loadKeys();
      } else {
        showMsg(document.getElementById("listMsg"), r.data.message || "Loi", "err");
      }
    });
  });
}

if (AUTHED) loadKeys();
</script>
</body></html>`;
}


async function handle(request, env) {
  const appId = env.FB_APP_ID;
  const appSecret = env.FB_APP_SECRET;
  const redirectUri = env.REDIRECT_URI;
  const extOrigin = env.EXT_ORIGIN || "";

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const origin = request.headers.get("Origin") || "*";

  if (request.method === "OPTIONS") return handleOptions(request);

  // ===== TRANG QUAN TRI KEY =====
  if (path === "/admin" || path === "/admin/") {
    const authed = await validateSession(env, request);
    return htmlResponse(adminPageHtml(authed));
  }
  if (path.startsWith("/admin/api/")) {
    return handleAdminApi(request, env, path);
  }

  // ===== LICENSE SERVER =====
  const licRes = await routeLicense(request, env, url, origin);
  if (licRes) return licRes;

  // ===== /login =====
  if (path === "/login" || path === "/") {
    if (!appId) {
      return new Response("Server chưa cấu hình FB_APP_ID", { status: 500 });
    }
    const state = crypto.randomUUID();
    const loginUrl = buildLoginUrl(appId, redirectUri, state);
    return Response.redirect(loginUrl, 302);
  }

  // ===== /callback =====
  if (path === "/callback") {
    const code = url.searchParams.get("code");
    const errParam = url.searchParams.get("error_description") || url.searchParams.get("error");
    if (errParam) {
      return htmlResponse(
        `<!doctype html><html><body style="font-family:system-ui;padding:40px;text-align:center">
        <h1 style="color:#c0392b">❌ Facebook báo lỗi</h1>
        <p>${HTML_ESC(errParam)}</p>
        <p>Vui lòng kiểm tra App đã Live chưa và Redirect URI đúng chưa.</p>
        </body></html>`,
        400,
      );
    }
    if (!code) {
      return new Response("Missing code", { status: 400 });
    }
    try {
      const tokenData = await exchangeCodeForLongLivedToken(
        code,
        appId,
        appSecret,
        redirectUri,
      );
      const debug = await debugToken(tokenData.access_token, appId, appSecret).catch(() => ({}));
      const scopes = debug.scopes || [];
      const html = successHtml(
        { ...tokenData, scopes },
        extOrigin,
      );
      return htmlResponse(html);
    } catch (e) {
      return htmlResponse(
        `<!doctype html><html><body style="font-family:system-ui;padding:40px;text-align:center">
        <h1 style="color:#c0392b">❌ Lỗi đổi token</h1>
        <p>${HTML_ESC(e.message)}</p>
        </body></html>`,
        500,
      );
    }
  }

  // ===== /refresh =====
  if (path === "/refresh") {
    const token = url.searchParams.get("token");
    if (!token) {
      return jsonResponse({ ok: false, error: "missing token" }, 400, origin);
    }
    try {
      const tokenData = await refreshLongLivedToken(token, appId, appSecret);
      return jsonResponse({ ok: true, ...tokenData }, 200, origin);
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, 500, origin);
    }
  }

  // ===== /info =====
  if (path === "/info") {
    return jsonResponse(
      {
        ok: true,
        fb_app_id: appId,
        redirect_uri: redirectUri,
        ext_origin: extOrigin,
        endpoints: ["/login", "/callback", "/refresh"],
      },
      200,
      origin,
    );
  }

  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    return handle(request, env);
  },
};
