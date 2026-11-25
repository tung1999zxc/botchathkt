// Test license_core.js: fingerprint, storage, activate, verify, chu ky so, ping fail-open.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
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

// ---- Cap khoa that cho TEST (cung cap cap voi server) ----
const PRIV_B64 = TEST_PRIVATE_KEY;
const PUB_B64 = TEST_PUBLIC_KEY;

async function importPriv() {
  const bin = Buffer.from(PRIV_B64, "base64");
  return crypto.subtle.importKey(
    "pkcs8",
    bin,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}
async function importPub() {
  const bin = Buffer.from(PUB_B64, "base64");
  return crypto.subtle.importKey(
    "spki",
    bin,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

// Payload phai dung THU TU field giong het server
function buildPayload(d) {
  return JSON.stringify({
    key: d.key,
    deviceId: d.deviceId,
    plan: d.plan,
    expiresAt: d.expiresAt,
    status: d.status,
    maxDevices: d.maxDevices,
    issuedAt: d.issuedAt,
    nonce: d.nonce,
  });
}

let privKey = null;
async function signPayload(payload) {
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privKey,
    new TextEncoder().encode(payload),
  );
  return Buffer.from(new Uint8Array(sig)).toString("base64");
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

// ---- Mock fetch: mo phong server ----
let serverMode = "ok"; // ok | revoked | expired | offline | invalid | badsig | blocked
let lastBody = null;
let fetchLog = [];
// Cho phep test gia thoi diem phat hanh payload (de ép check() phai goi server)
let issuedAtOverride = null;
global.fetch = async (url, opts) => {
  const u = String(url);
  fetchLog.push(u);
  lastBody = opts && opts.body ? JSON.parse(opts.body) : null;

  // PING: luon OK tru khi che do "server chet"
  if (u.endsWith("/license/ping")) {
    if (serverMode === "serverdown") {
      throw new Error("network down");
    }
    return new Response(
      JSON.stringify({
        ok: true,
        service: "license-server",
        time: Date.now(),
        hasSigning: true,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  if (serverMode === "offline") throw new Error("network down");
  if (serverMode === "serverdown") throw new Error("network down");

  if (serverMode === "revoked") {
    return new Response(
      JSON.stringify({ ok: false, code: "revoked", message: "Key da bi thu hoi" }),
      { status: 400 },
    );
  }
  if (serverMode === "expired") {
    return new Response(
      JSON.stringify({ ok: false, code: "expired", message: "Key da het han" }),
      { status: 400 },
    );
  }
  if (serverMode === "invalid") {
    return new Response(
      JSON.stringify({ ok: false, code: "invalid", message: "Key khong ton tai" }),
      { status: 400 },
    );
  }
  // "blocked" = /verify bi chan (500) nhung /ping van OK
  if (serverMode === "blocked") {
    return new Response(JSON.stringify({ ok: false, code: "error" }), {
      status: 500,
    });
  }

  const key = (lastBody && lastBody.key) || "";
  const deviceId = (lastBody && lastBody.deviceId) || "";
  const payload = buildPayload({
    key: key,
    deviceId: deviceId,
    plan: "30d",
    expiresAt: Date.now() + 30 * 86400000,
    status: "active",
    maxDevices: 1,
    issuedAt: issuedAtOverride === null ? Date.now() : issuedAtOverride,
    nonce: "n-" + Date.now(),
  });
  let signature = await signPayload(payload);
  if (serverMode === "badsig") {
    // Chu ky gia -> client phai tu choi
    const bad = Buffer.from(signature, "base64");
    bad[5] ^= 0xff;
    signature = bad.toString("base64");
  }

  return new Response(
    JSON.stringify({
      ok: true,
      message: "OK",
      expiresAt: Date.now() + 30 * 86400000,
      plan: "30d",
      maxDevices: 1,
      serverTime: Date.now(),
      payload: payload,
      signature: signature,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};

// ---- Mock navigator/screen ----
const navigator = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  language: "vi-VN",
  platform: "Win32",
  hardwareConcurrency: 8,
  deviceMemory: 8,
};
const screen = { width: 1920, height: 1080, colorDepth: 24 };

// ---- Nap module trong sandbox ----
// Patch khoa cong trong license_core.js sang khoa cong TEST.
const coreSrcRaw = fs.readFileSync(path.join(dir, "license_core.js"), "utf8");
const PROD_PUB =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAERpl81Sw2CQnsbqdVwWg4ucmVz4WSn/H4Zheo9VkvDbJrcK/xU3Te3gW7bm5mvclkpSOr1wQl6gfc/TbBhcMcng==";
const src = patchPublicKey(coreSrcRaw, PROD_PUB);
function makeCtx(extra) {
  const ctx = vm.createContext({
    chrome,
    navigator,
    screen,
    console,
    fetch: global.fetch,
    Response,
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
    ...(extra || {}),
  });
  ctx.self = ctx;
  ctx.window = ctx;
  vm.runInContext(src, ctx);
  return ctx;
}
const ctx = makeCtx();
const Core = ctx.LicenseCore;

/**
 * Kich hoat mot license CO payload da cu (issuedAt cu hon 25 gio)
 * => check() se buoc phai goi server (nhu heartbeat het han).
 */
async function activateStale(key) {
  const prev = issuedAtOverride;
  issuedAtOverride = Date.now() - 25 * 60 * 60 * 1000;
  const r = await Core.activate(key);
  issuedAtOverride = prev;
  return r;
}

async function main() {
  privKey = await importPriv();

  console.log("\n=== 1. MODULE API ===");
  ok(!!Core, "LicenseCore duoc export");
  ok(typeof Core.getDeviceId === "function", "co getDeviceId()");
  ok(typeof Core.activate === "function", "co activate()");
  ok(typeof Core.verify === "function", "co verify()");
  ok(typeof Core.check === "function", "co check()");
  ok(typeof Core.getServerUrl === "function", "co getServerUrl()");
  ok(typeof Core.verifySignature === "function", "co verifySignature()");
  ok(typeof Core.pingServer === "function", "co pingServer()");

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
  ok(
    res.allowed === false && res.state === "none",
    "Chua kich hoat -> allowed=false state=none",
    JSON.stringify(res),
  );

  console.log("\n=== 5. KICH HOAT THAT BAI (KEY SAI) ===");
  serverMode = "invalid";
  res = await Core.activate("TL_XXXX-XXXX-XXXX-XXXX");
  ok(res.ok === false && res.code === "invalid", "Key sai -> bao loi", JSON.stringify(res));
  ok(
    store.ccLicenseFailedAttempts === 1,
    "Dem so lan thu sai = 1",
    String(store.ccLicenseFailedAttempts),
  );

  console.log("\n=== 6. KHOA TAM THOI SAU 5 LAN ===");
  for (let i = 0; i < 4; i++)
    await Core.activate("TL_XXXX-XXXX-XXXX-XXXX");
  ok(
    store.ccLicenseLockedUntil > Date.now(),
    "Key bi khoa tam thoi (15 phut)",
    String(store.ccLicenseLockedUntil),
  );
  res = await Core.activate("TL_XXXX-XXXX-XXXX-XXXX");
  ok(res.ok === false && res.code === "locked", "Lan sau tra ve locked", JSON.stringify(res));

  console.log("\n=== 7. KICH HOAT THANH CONG (CO CHU KY) ===");
  store.ccLicenseLockedUntil = 0;
  store.ccLicenseFailedAttempts = 0;
  serverMode = "ok";
  res = await Core.activate("tl_abcd-efgh-ijkl-mnop");
  ok(res.ok === true, "Kich hoat thanh cong", JSON.stringify(res));
  ok(
    store.ccLicense && store.ccLicense.key === "TL_ABCD-EFGH-IJKL-MNOP",
    "Key luu da chuan hoa chu hoa",
    store.ccLicense && store.ccLicense.key,
  );
  ok(store.ccLicense.deviceId === d1, "Luu kem deviceId");
  ok(store.ccLicense.expiresAt > Date.now(), "Luu expiresAt");
  ok(store.ccLicense.lastVerify > 0, "Luu lastVerify (khong can goi lai ngay)");
  ok(!!store.ccLicense.payload, "Luu payload co chu ky");
  ok(!!store.ccLicense.signature, "Luu chu ky");

  console.log("\n=== 8. CHECK KHI DA KICH HOAT ===");
  res = await Core.check();
  ok(res.allowed === true && res.state === "valid", "License hop le -> allowed=true");

  console.log("\n=== 9. FAIL-OPEN KHI MAT MANG (SERVER CHET) ===");
  await activateStale("TL_ABCD-EFGH-IJKL-MNOP");
  serverMode = "serverdown";
  res = await Core.check();
  ok(
    res.allowed === true,
    "Server chet -> VAN CHO DUNG (fail-open trong grace)",
    JSON.stringify(res),
  );
  ok(store.ccLicense.pendingRecheck === true, "Danh dau pendingRecheck");
  ok(store.ccLicenseOfflineSince > 0, "Ghi nhan thoi diem bat dau offline");

  console.log("\n=== 10. HET CUA SO OFFLINE GRACE -> CHAN ===");
  // Gia loi: offline bat dau 7 gio truoc (grace = 6 gio)
  store.ccLicenseOfflineSince = Date.now() - 7 * 60 * 60 * 1000;
  res = await Core.check();
  ok(
    res.allowed === false,
    "Offline > 6 gio -> FAIL-CLOSED (chan)",
    JSON.stringify(res),
  );
  ok(!store.ccLicense, "Xoa license khi het grace");

  console.log("\n=== 11. SERVER TRA 'REVOKED' -> CHAN NGAY ===");
  store.ccLicenseFailedAttempts = 0;
  store.ccLicenseLockedUntil = 0;
  serverMode = "ok";
  await activateStale("TL_ABCD-EFGH-IJKL-MNOP");
  serverMode = "revoked";
  res = await Core.check();
  ok(
    res.allowed === false && res.state === "revoked",
    "Key bi thu hoi -> chan ngay",
    JSON.stringify(res),
  );
  ok(!store.ccLicense, "Xoa license khi bi thu hoi");

  console.log("\n=== 12. SERVER TRA 'EXPIRED' -> CHAN ===");
  store.ccLicenseFailedAttempts = 0;
  store.ccLicenseLockedUntil = 0;
  serverMode = "ok";
  await activateStale("TL_ABCD-EFGH-IJKL-MNOP");
  serverMode = "expired";
  res = await Core.check();
  ok(
    res.allowed === false && res.state === "expired",
    "Key het han -> chan",
    JSON.stringify(res),
  );

  console.log("\n=== 13. ACTIVATE FAIL KHI OFFLINE ===");
  serverMode = "offline";
  res = await Core.activate("TL_ABCD-EFGH-IJKL-MNOP");
  ok(
    res.ok === false && res.code === "offline",
    "Khong ket noi -> bao loi ro rang",
    JSON.stringify(res),
  );

  console.log("\n=== 14. DEACTIVATE ===");
  serverMode = "ok";
  await Core.activate("TL_ABCD-EFGH-IJKL-MNOP");
  await Core.deactivate();
  ok(!store.ccLicense, "Xoa het license khi deactivate");
  res = await Core.check();
  ok(res.allowed === false, "Sau deactivate -> khong duoc dung");

  console.log("\n=== 15. CHU KY SAI -> TU CHOI (uu tien 1) ===");
  serverMode = "ok";
  await activateStale("TL_ABCD-EFGH-IJKL-MNOP");
  // Sua du lieu trong storage (mo phong attacker)
  const tampered = { ...store.ccLicense };
  tampered.expiresAt = Date.now() + 365 * 86400000; // keo dai han
  tampered.plan = "lifetime";
  await new Promise((r) => chrome.storage.local.set({ ccLicense: tampered }, r));
  res = await Core.check();
  ok(
    res.allowed === false && res.state === "tampered",
    "Sua expiresAt trong storage -> bi chan (tampered)",
    JSON.stringify(res),
  );
  ok(!store.ccLicense, "Xoa license khi phat hien gia mao");

  console.log("\n=== 15b. SUA `lastVerify` DE BO QUA CHECK ONLINE -> KHONG ANH DUNG ===");
  serverMode = "ok";
  await activateStale("TL_ABCD-EFGH-IJKL-MNOP");
  const forged = { ...store.ccLicense };
  forged.lastVerify = Date.now(); // "day" moc thoi gian
  await new Promise((r) => chrome.storage.local.set({ ccLicense: forged }, r));
  serverMode = "revoked";
  res = await Core.check();
  ok(
    res.allowed === false && res.state === "revoked",
    "Day lastVerify khong lam an duoc check online",
    JSON.stringify(res),
  );

  console.log("\n=== 15c. XOA CHU KY KHOI STORAGE -> BI CHAN ===");
  serverMode = "ok";
  await activateStale("TL_ABCD-EFGH-IJKL-MNOP");
  const nosig = { ...store.ccLicense };
  delete nosig.signature;
  await new Promise((r) => chrome.storage.local.set({ ccLicense: nosig }, r));
  res = await Core.check();
  ok(
    res.allowed === false && res.state === "tampered",
    "Xoa chu ky -> bi chan (tampered)",
    JSON.stringify(res),
  );

  console.log("\n=== 16. CHU KY SAI TU SERVER -> TU CHOI ===");
  serverMode = "badsig";
  res = await Core.activate("TL_ABCD-EFGH-IJKL-MNOP");
  ok(
    res.ok === false && res.code === "bad_signature",
    "Server tra chu ky sai -> activate that bai",
    JSON.stringify(res),
  );

  console.log("\n=== 17. VERIFY BI CHAN NHUNG PING OK -> FAIL-CLOSED (uu tien 2) ===");
  store.ccLicenseFailedAttempts = 0;
  store.ccLicenseLockedUntil = 0;
  serverMode = "ok";
  await activateStale("TL_ABCD-EFGH-IJKL-MNOP");
  serverMode = "blocked";
  res = await Core.check();
  ok(
    res.allowed === false,
    "Verify bi chan + ping OK -> FAIL-CLOSED (chan)",
    JSON.stringify(res),
  );
  ok(
    fetchLog.some((x) => x.endsWith("/license/ping")),
    "Da goi /license/ping de phan biet",
  );

  console.log("\n=== 18. SERVER THAT BAI NHUNG PING OK -> FAIL-CLOSED ===");
  store.ccLicenseFailedAttempts = 0;
  store.ccLicenseLockedUntil = 0;
  serverMode = "ok";
  await activateStale("TL_ABCD-EFGH-IJKL-MNOP");
  serverMode = "blocked";
  res = await Core.check();
  ok(res.allowed === false, "Server that bai nhung song -> chan", JSON.stringify(res));

  console.log("\n=== 19. FINGERPRINT DOI KHI UA DOI ===");
  // Xoa storage de module moi khong lay deviceId cu trong cache
  delete store.ccLicense;
  delete store.ccLicenseOfflineSince;
  navigator.userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
  const ctx2 = makeCtx();
  const d3 = await ctx2.LicenseCore.getDeviceId();
  ok(d3 !== d1, "Doi UA -> device ID khac (may khac)", d3 + " vs " + d1);

  console.log("\n=== 20. FINGERPRINT ON DINH KHI UA CO DOI PHIEN BAN ===");
  const ctx3 = makeCtx({
    navigator: {
      ...navigator,
      userAgent: navigator.userAgent.replace("Chrome/121.0.0.0", "Chrome/130.0.6723.140"),
    },
  });
  const d4 = await ctx3.LicenseCore.getDeviceId();
  ok(d4 === d3, "Chrome update phien ban -> device ID KHONG doi (chuan hoa UA)", d4 + " vs " + d3);

  console.log("\n=== 21. XOA VAI FILE VAO REPO (khong nen commit) ===");
  ok(
    fs.existsSync(path.join(dir, ".gitignore")),
    "Co .gitignore",
  );

  console.log("\n=========================================");
  console.log("KET QUA: " + pass + " PASS / " + fail + " FAIL");
  console.log("=========================================\n");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("LOI TEST:", e);
  process.exit(1);
});
