/* =========================================================================
 * TEST E2E LEGACY - Kiem chung tinh huong THAT cua nguoi dung:
 *   License da kich hoat TRUOC khi trien khai chu ky so (khong co
 *   payload/signature trong chrome.storage.local) -> extension tu dong
 *   hoi server cap lai chu ky va cho qua, KHONG can nhap lai key.
 *
 * Dung:
 *   node test_e2e_legacy.js <KEY> [deviceId]
 *
 * Chay voi SERVER THAT (mac dinh). Khong dung khoa rieng nao.
 * ========================================================================= */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const dir = __dirname;
const SERVER =
  process.env.LICENSE_SERVER_URL ||
  "https://botchathkt.tung1999zxc.workers.dev";

const key = (process.argv[2] || "").trim().toUpperCase();
const deviceId = (process.argv[3] || "LEGACYE2EDEVICE001").trim().toUpperCase();

if (!key) {
  console.error("Dung: node test_e2e_legacy.js <KEY> [deviceId]");
  process.exit(1);
}

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

// ---- Storage gia lap (mo phong chrome.storage.local) ----
const store = {};
const chrome = {
  storage: {
    local: {
      get(keys, cb) {
        const out = {};
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) {
          if (k in store) out[k] = store[k];
        }
        cb(out);
      },
      set(obj, cb) {
        Object.assign(store, obj);
        cb && cb();
      },
      remove(keys, cb) {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) delete store[k];
        cb && cb();
      },
    },
  },
  runtime: { getManifest: () => ({ version: "1.0.0" }) },
};

const src = fs.readFileSync(path.join(dir, "license_core.js"), "utf8");
const ctx = vm.createContext({
  chrome,
  console,
  fetch: (...a) => fetch(...a),
  Response,
  Request,
  Headers,
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
vm.runInContext(src, ctx);
const Core = ctx.LicenseCore;

async function main() {
  console.log("\n=== 1. CHUAN BI LICENSE CU (TRUOC KHI TRIEN KHAI CHU KY SO) ===");
  // Giong het du lieu license_core.js ghi khi kich hoat xa
  store.ccLicense = {
    key: key,
    deviceId: deviceId,
    activatedAt: Date.now() - 86400000,
    expiresAt: Date.now() + 30 * 86400000,
    lastVerify: Date.now(),
    status: "active",
    plan: "30d",
    maxDevices: 1,
    pendingRecheck: false,
    // KHONG co payload, KHONG co signature  <-- dau hieu legacy
  };
  store.ccLicenseOfflineSince = 0;
  await Core.setServerUrl(SERVER);
  console.log("  License legacy: co key + deviceId, THIEU payload/signature");
  ok(!store.ccLicense.payload && !store.ccLicense.signature, "Storage that su la legacy");

  console.log("\n=== 2. CHECK() -> TU HOI SERVER CAP LAI CHU KY ===");
  const res = await Core.check();
  console.log("  allowed=" + res.allowed + " state=" + res.state);
  console.log("  message=" + res.message);

  ok(res.allowed === true, "License legacy duoc cho qua (khong bi chan)", res.message);
  ok(res.state === "valid", "Trang thai = valid", res.state);

  console.log("\n=== 3. LICENSE DA DUOC CAP NHAT CHU KY? ===");
  ok(!!store.ccLicense.payload, "Da co payload moi trong storage");
  ok(!!store.ccLicense.signature, "Da co chu ky moi trong storage");
  ok(store.ccLicense.key === key, "Key giu nguyen");

  console.log("\n=== 4. LAN CHECK() SAU (KHONG CAN MANG) ===");
  const res2 = await Core.check();
  ok(res2.allowed === true, "Check lan 2 van hop le (dung chu ky cuc bo)", res2.message);
  ok(res2.needsNetwork === false, "Khong can goi lai server (duoi 24h)");

  console.log("\n=== 5. CHU KY CUOC BO XAC MINH DUOC ===");
  const local = await Core.verifyLocalLicense(store.ccLicense);
  ok(local.ok === true, "verifyLocalLicense OK", local.reason);

  console.log("\n=== 6. GIA MAO VAN BI CHAN ===");
  const saved = JSON.parse(JSON.stringify(store.ccLicense));
  saved.expiresAt = Date.now() + 365 * 86400000;
  store.ccLicense = saved;
  const res3 = await Core.check();
  ok(
    res3.allowed === false && res3.state === "tampered",
    "Sua expiresAt -> bi chan tampered",
    JSON.stringify(res3),
  );

  console.log("\n=========================================");
  console.log("KET QUA: " + pass + " PASS / " + fail + " FAIL");
  console.log("=========================================\n");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("LOI:", e && e.stack);
  process.exit(1);
});
