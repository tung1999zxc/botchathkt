/* =========================================================================
 * TEST TICH HOP - license_core.js (that) <-> worker.js (that)
 * -------------------------------------------------------------------------
 * Chay server trong bo nho (mock KV), tro fetch cua client ve server do,
 * rồi kiem tra day du vong kich hoat -> xac minh -> thu hoi -> cham.
 * ========================================================================= */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("url");
const {
  TEST_PRIVATE_KEY,
  TEST_PUBLIC_KEY,
  patchPublicKey,
} = require("./_test_keys.js");

const dir = __dirname;

let pass = 0,
  fail = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log("  PASS  " + label);
  } else {
    fail++;
    console.log("  FAIL  " + label + (extra ? " -> " + extra : ""));
  }
}

// ---- KV gia lap ----
const kvStore = new Map();
const KV = {
  async get(k, opts) {
    if (!kvStore.has(k)) return null;
    const v = kvStore.get(k);
    if (opts && opts.type === "json") {
      try {
        return JSON.parse(v);
      } catch (e) {
        return null;
      }
    }
    return v;
  },
  async put(k, v) {
    kvStore.set(k, v);
  },
  async delete(k) {
    kvStore.delete(k);
  },
  async list({ cursor } = {}) {
    const keys = Array.from(kvStore.keys()).map((name) => ({ name }));
    return { keys, list_complete: true, cursor: "" };
  },
};

const env = {
  LICENSE_KV: KV,
  ADMIN_PASSWORD: "test-admin-pass",
  FB_APP_ID: "123456",
  FB_APP_SECRET: "secret",
  REDIRECT_URI: "https://example.workers.dev/callback",
  EXT_ORIGIN: "chrome-extension://abcdefghijklmnop",
  LICENSE_PRIVATE_KEY: TEST_PRIVATE_KEY,
};

// ---- Nap worker.js (patch khoa cong sang khoa test) ----
const PROD_PUB =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAERpl81Sw2CQnsbqdVwWg4ucmVz4WSn/H4Zheo9VkvDbJrcK/xU3Te3gW7bm5mvclkpSOr1wQl6gfc/TbBhcMcng==";
const workerSrc = patchPublicKey(
  fs.readFileSync(path.join(dir, "worker.js"), "utf8"),
  PROD_PUB,
);

let worker;
async function loadWorker() {
  const tmp = path.join(dir, "_worker_it.mjs");
  fs.writeFileSync(tmp, workerSrc, "utf8");
  const mod = await import(pathToFileURL(tmp).href + "?t=" + Date.now());
  return mod.default;
}

// ---- Mock chrome.storage.local ----
const store = {};
const chrome = {
  storage: {
    local: {
      get(keys, cb) {
        const res = {};
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list)
          if (store[k] !== undefined) res[k] = store[k];
        setTimeout(() => cb(res), 0);
      },
      set(obj, cb) {
        Object.assign(store, obj);
        if (cb) setTimeout(cb, 0);
      },
      remove(keys, cb) {
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]);
        if (cb) setTimeout(cb, 0);
      },
    },
  },
  runtime: { getManifest: () => ({ version: "10.0" }) },
};

const navigator = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  language: "vi-VN",
  platform: "Win32",
  hardwareConcurrency: 8,
  deviceMemory: 8,
};
const screen = { width: 1920, height: 1080, colorDepth: 24 };

// ---- Client that, tro fetch ve worker that ----
const BASE = "https://itest.workers.dev";
let pingFails = false;
let verifyBlocked = false;
let serverDown = false;

const realFetch = global.fetch;
const clientFetch = async (url, opts) => {
  const u = String(url);
  const p = new URL(u);

  // Server "chet" => moi endpoint deu loi mang
  if (serverDown) {
    throw new Error("network down");
  }
  if (p.pathname === "/license/ping" && pingFails) {
    throw new Error("network down");
  }
  if (p.pathname === "/license/verify" && verifyBlocked) {
    return new Response(JSON.stringify({ ok: false, code: "error" }), {
      status: 500,
    });
  }

  const req = new Request(u, opts);
  const res = await worker.fetch(req, env, {});
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
};

const coreSrc = patchPublicKey(
  fs.readFileSync(path.join(dir, "license_core.js"), "utf8"),
  PROD_PUB,
);

const ctx = vm.createContext({
  chrome,
  navigator,
  screen,
  console,
  fetch: clientFetch,
  Response,
  Request,
  Headers,
  URL,
  Date,
  Math,
  JSON,
  TextEncoder,
  crypto,
  AbortController,
  setTimeout,
  clearTimeout,
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
});
ctx.self = ctx;
ctx.window = ctx;
vm.runInContext(coreSrc, ctx);
const Core = ctx.LicenseCore;

async function main() {
  worker = await loadWorker();

  console.log("\n=== 1. TAO KEY QUA ADMIN API ===");
  let r = await worker.fetch(
    new Request(BASE + "/admin/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-admin-pass" }),
    }),
    env,
    {},
  );
  const cookie = (r.headers.get("Set-Cookie") || "").split(";")[0];
  ok(!!cookie, "Dang nhap admin duoc");

  r = await worker.fetch(
    new Request(BASE + "/admin/api/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ plan: "30d", maxDevices: 1, note: "IT" }),
    }),
    env,
    {},
  );
  let j = await r.json();
  const key = j.key;
  ok(/^TL_[0-9A-HJKMNP-TV-Z]{4}-/.test(key), "Tao key thanh cong", key);

  console.log("\n=== 2. KICH HOAT QUA CLIENT THAT ===");
  await Core.setServerUrl(BASE);
  let res = await Core.activate(key);
  ok(res.ok === true, "Client kich hoat key thanh cong", JSON.stringify(res));
  ok(!!store.ccLicense.payload, "Luu payload da ky");
  ok(!!store.ccLicense.signature, "Luu chu ky");

  console.log("\n=== 3. CHECK -> ALLOWED ===");
  res = await Core.check();
  ok(res.allowed === true && res.state === "valid", "License hop le -> allowed", JSON.stringify(res));

  console.log("\n=== 4. GIA MAO DU LIEU CUC BO -> TAMpered ===");
  const tampered = { ...store.ccLicense };
  tampered.expiresAt = Date.now() + 365 * 86400000;
  await new Promise((r) => chrome.storage.local.set({ ccLicense: tampered }, r));
  res = await Core.check();
  ok(
    res.allowed === false && res.state === "tampered",
    "Sua expiresAt -> bi chan (tampered)",
    JSON.stringify(res),
  );
  ok(!store.ccLicense, "Xoa license sau khi phat hien gia mao");

  console.log("\n=== 5. THU HOI KEY TREN SERVER -> CHAN ===");
  await Core.activate(key);
  // Lay keyHash de thu hoi
  r = await worker.fetch(
    new Request(BASE + "/admin/api/keys", { headers: { Cookie: cookie } }),
    env,
    {},
  );
  j = await r.json();
  const keyHash = j.keys.find((k) => k.plan === "30d").keyHash;
  r = await worker.fetch(
    new Request(BASE + "/admin/api/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ keyHash, status: "revoked" }),
    }),
    env,
    {},
  );
  j = await r.json();
  ok(j.ok === true, "Thu hoi key tren server");

  // Ep client phai goi server: doi payload issuedAt cu (tu lam trong storage
  // se bi tampered, nen dung co server tra payload moi)
  // => goi verify truc tiep
  res = await Core.verify();
  ok(
    res.allowed === false && res.state === "revoked",
    "Client verify -> bi chan ngay",
    JSON.stringify(res),
  );
  ok(!store.ccLicense, "Xoa license khi bi thu hoi");

  console.log("\n=== 6. FAIL-CLOSED KHI VERIFY BI CHAN NHUNG PING OK ===");
  r = await worker.fetch(
    new Request(BASE + "/admin/api/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ plan: "lifetime", maxDevices: 1, note: "IT2" }),
    }),
    env,
    {},
  );
  j = await r.json();
  const key2 = j.key;
  await Core.activate(key2);
  verifyBlocked = true;
  res = await Core.verify();
  ok(res.allowed === false, "Verify bi chan + ping OK -> fail-closed", JSON.stringify(res));
  verifyBlocked = false;

  console.log("\n=== 7. FAIL-OPEN KHI SERVER CHET (trong grace) ===");
  await Core.activate(key2);
  serverDown = true;
  res = await Core.verify();
  ok(res.allowed === true, "Server chet -> fail-open (grace)", JSON.stringify(res));
  ok(store.ccLicenseOfflineSince > 0, "Ghi nhan offline");
  serverDown = false;

  console.log("\n=== 8. FAIL-CLOSED KHI HET GRACE ===");
  store.ccLicenseOfflineSince = Date.now() - 7 * 60 * 60 * 1000;
  serverDown = true;
  res = await Core.verify();
  ok(res.allowed === false, "Het grace -> fail-closed", JSON.stringify(res));
  serverDown = false;

  console.log("\n=== 9. CHU KY TU SERVER KHOP KHOA CONG ===");
  await Core.activate(key2);
  const lic = store.ccLicense;
  const pubKey = await crypto.subtle.importKey(
    "spki",
    Buffer.from(TEST_PUBLIC_KEY, "base64"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const sigOk = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pubKey,
    Buffer.from(lic.signature, "base64"),
    new TextEncoder().encode(lic.payload),
  );
  ok(sigOk === true, "Chu ky server xac minh duoc bang khoa cong");

  console.log("\n=== 10. MAY THU HAI BI TU CHOI ===");
  r = await worker.fetch(
    new Request(BASE + "/license/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key2, deviceId: "MAY-KHAC" }),
    }),
    env,
    {},
  );
  j = await r.json();
  ok(j.ok === false && j.code === "max_devices", "May thu 2 bi tu choi", JSON.stringify(j));

  console.log("\n=========================================");
  console.log("KET QUA: " + pass + " PASS / " + fail + " FAIL");
  console.log("=========================================\n");

  try {
    fs.unlinkSync(path.join(dir, "_worker_it.mjs"));
  } catch (e) {}

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("LOI TEST:", e);
  process.exit(1);
});
