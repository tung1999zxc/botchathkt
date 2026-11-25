// Test license_core.js: fingerprint, storage, activate, verify, fail-open.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const dir = __dirname;

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS  " + label); }
  else { fail++; console.log("  FAIL  " + label + (extra ? " -> " + extra : "")); }
}

// ---- Mock chrome.storage.local ----
const store = {};
const chrome = {
  storage: {
    local: {
      get(keys, cb) {
        const res = {};
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) if (store[k] !== undefined) res[k] = store[k];
        setTimeout(() => cb(res), 0);
      },
      set(obj, cb) { Object.assign(store, obj); if (cb) setTimeout(cb, 0); },
      remove(keys, cb) {
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]);
        if (cb) setTimeout(cb, 0);
      },
    },
  },
  runtime: { getManifest: () => ({ version: "10.0" }) },
};

// ---- Mock fetch: mo phong server ----
let serverMode = "ok";   // ok | revoked | expired | offline | invalid
let lastBody = null;
global.fetch = async (url, opts) => {
  lastBody = JSON.parse(opts.body);
  if (serverMode === "offline") throw new Error("network down");
  if (serverMode === "revoked") {
    return new Response(JSON.stringify({ ok: false, code: "revoked", message: "Key da bi thu hoi" }), { status: 400 });
  }
  if (serverMode === "expired") {
    return new Response(JSON.stringify({ ok: false, code: "expired", message: "Key da het han" }), { status: 400 });
  }
  if (serverMode === "invalid") {
    return new Response(JSON.stringify({ ok: false, code: "invalid", message: "Key khong ton tai" }), { status: 400 });
  }
  return new Response(JSON.stringify({
    ok: true, message: "OK", expiresAt: Date.now() + 30 * 86400000,
    plan: "30d", maxDevices: 1, serverTime: Date.now(),
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

// ---- Mock navigator/screen ----
const navigator = {
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  language: "vi-VN", platform: "Win32", hardwareConcurrency: 8, deviceMemory: 8,
};
const screen = { width: 1920, height: 1080, colorDepth: 24 };

// ---- Nap module trong sandbox ----
const src = fs.readFileSync(path.join(dir, "license_core.js"), "utf8");
const ctx = vm.createContext({
  chrome, navigator, screen, console, fetch: global.fetch, Response, Date, Math, JSON,
  TextEncoder, crypto, AbortController, setTimeout, clearTimeout,
});
ctx.self = ctx;
ctx.window = ctx;
vm.runInContext(src, ctx);
const Core = ctx.LicenseCore;

async function main() {
  console.log("\n=== 1. MODULE API ===");
  ok(!!Core, "LicenseCore duoc export");
  ok(typeof Core.getDeviceId === "function", "co getDeviceId()");
  ok(typeof Core.activate === "function", "co activate()");
  ok(typeof Core.verify === "function", "co verify()");
  ok(typeof Core.check === "function", "co check()");
  ok(typeof Core.getServerUrl === "function", "co getServerUrl()");

  console.log("\n=== 2. DEVICE ID ===");
  const d1 = await Core.getDeviceId();
  ok(/^[0-9A-F]{32}$/.test(d1), "Device ID 32 ky tu hex in hoa", d1);
  const d2 = await Core.getDeviceId();
  ok(d1 === d2, "Device ID on dinh giua cac lan goi");

  console.log("\n=== 3. SERVER URL ===");
  await Core.setServerUrl("https://example.workers.dev/");
  const u = await Core.getServerUrl();
  ok(u === "https://example.workers.dev", "Chuan hoa bo dau / cuoi", u);

  console.log("\n=== 4. CHUA KICH HOAT ===");
  let res = await Core.check();
  ok(res.allowed === false && res.state === "none", "Chua kich hoat -> allowed=false state=none", JSON.stringify(res));

  console.log("\n=== 5. KICH HOAT THAT BAI (KEY SAI) ===");
  serverMode = "invalid";
  res = await Core.activate("TL_XXXX-XXXX-XXXX-XXXX");
  ok(res.ok === false && res.code === "invalid", "Key sai -> bao loi", JSON.stringify(res));
  ok(store.ccLicenseFailedAttempts === 1, "Dem so lan thu sai = 1", String(store.ccLicenseFailedAttempts));

  console.log("\n=== 6. KHOA TAM THOI SAU 5 LAN ===");
  for (let i = 0; i < 4; i++) await Core.activate("TL_XXXX-XXXX-XXXX-XXXX");
  ok(store.ccLicenseLockedUntil > Date.now(), "Key bi khoa tam thoi (15 phut)", String(store.ccLicenseLockedUntil));
  res = await Core.activate("TL_XXXX-XXXX-XXXX-XXXX");
  ok(res.ok === false && res.code === "locked", "Lan sau tra ve locked", JSON.stringify(res));

  console.log("\n=== 7. KICH HOAT THANH CONG ===");
  store.ccLicenseLockedUntil = 0;
  store.ccLicenseFailedAttempts = 0;
  serverMode = "ok";
  res = await Core.activate("tl_abcd-efgh-ijkl-mnop");
  ok(res.ok === true, "Kich hoat thanh cong", JSON.stringify(res));
  ok(store.ccLicense && store.ccLicense.key === "TL_ABCD-EFGH-IJKL-MNOP", "Key luu da chuan hoa chu hoa", store.ccLicense && store.ccLicense.key);
  ok(store.ccLicense.deviceId === d1, "Luu kem deviceId");
  ok(store.ccLicense.expiresAt > Date.now(), "Luu expiresAt");
  ok(store.ccLicense.lastVerify > 0, "Luu lastVerify (khong can goi lai ngay)");

  console.log("\n=== 8. CHECK KHI DA KICH HOAT ===");
  res = await Core.check();
  ok(res.allowed === true && res.state === "valid", "License hop le -> allowed=true");

  console.log("\n=== 9. FAIL-OPEN KHI MAT MANG ===");
  // Ep lastVerify cu -> phai goi server, server loi mang
  store.ccLicense.lastVerify = 0;
  serverMode = "offline";
  res = await Core.check();
  ok(res.allowed === true, "Mat mang -> VAN CHO DUNG (fail-open)", JSON.stringify(res));
  ok(store.ccLicense.pendingRecheck === true, "Danh dau pendingRecheck");

  console.log("\n=== 10. SERVER TRA 'REVOKED' -> CHAN NGAY ===");
  store.ccLicense.lastVerify = 0;
  serverMode = "revoked";
  res = await Core.check();
  ok(res.allowed === false && res.state === "revoked", "Key bi thu hoi -> chan ngay", JSON.stringify(res));
  ok(!store.ccLicense, "Xoa license khi bi thu hoi");

  console.log("\n=== 11. SERVER TRA 'EXPIRED' -> CHAN ===");
  store.ccLicenseFailedAttempts = 0;
  store.ccLicenseLockedUntil = 0;
  serverMode = "ok";
  await Core.activate("TL_ABCD-EFGH-IJKL-MNOP");
  store.ccLicense.lastVerify = 0;
  serverMode = "expired";
  res = await Core.check();
  ok(res.allowed === false && res.state === "expired", "Key het han -> chan", JSON.stringify(res));

  console.log("\n=== 12. ACTIVATE FAIL KHI OFFLINE ===");
  serverMode = "offline";
  res = await Core.activate("TL_ABCD-EFGH-IJKL-MNOP");
  ok(res.ok === false && res.code === "offline", "Khong ket noi -> bao loi ro rang", JSON.stringify(res));

  console.log("\n=== 13. DEACTIVATE ===");
  serverMode = "ok";
  await Core.activate("TL_ABCD-EFGH-IJKL-MNOP");
  await Core.deactivate();
  ok(!store.ccLicense, "Xoa het license khi deactivate");
  res = await Core.check();
  ok(res.allowed === false, "Sau deactivate -> khong duoc dung");

  console.log("\n=== 14. FINGERPRINT DOI KHI UA DOI ===");
  // Doi UA -> phai ra device ID khac
  navigator.userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
  const ctx2 = vm.createContext({
    chrome: { storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb(), remove: (k, cb) => cb && cb() } } },
    navigator, screen, console, fetch: global.fetch, Response, Date, Math, JSON,
    TextEncoder, crypto, AbortController, setTimeout, clearTimeout,
  });
  ctx2.self = ctx2; ctx2.window = ctx2;
  vm.runInContext(src, ctx2);
  const d3 = await ctx2.LicenseCore.getDeviceId();
  ok(d3 !== d1, "Doi UA -> device ID khac (may khac)", d3 + " vs " + d1);

  console.log("\n=== 15. FINGERPRINT ON DINH KHI UA CO DOI PHIEN BAN ===");
  const ctx3 = vm.createContext({
    chrome: { storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb(), remove: (k, cb) => cb && cb() } } },
    navigator: { ...navigator, userAgent: navigator.userAgent.replace("Chrome/121.0.0.0", "Chrome/130.0.6723.140") },
    screen, console, fetch: global.fetch, Response, Date, Math, JSON,
    TextEncoder, crypto, AbortController, setTimeout, clearTimeout,
  });
  ctx3.self = ctx3; ctx3.window = ctx3;
  vm.runInContext(src, ctx3);
  const d4 = await ctx3.LicenseCore.getDeviceId();
  ok(d4 === d3, "Chrome update phien ban -> device ID KHONG doi (chuan hoa UA)", d4 + " vs " + d3);

  console.log("\n=========================================");
  console.log("KET QUA: " + pass + " PASS / " + fail + " FAIL");
  console.log("=========================================\n");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("LOI TEST:", e); process.exit(1); });
