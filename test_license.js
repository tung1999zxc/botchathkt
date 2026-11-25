// Test harness: chay worker.js voi KV gia lap, kiem tra day du luong license.
const fs = require("fs");
const path = require("path");

const dir = __dirname;

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
};

// ---- Nap worker.js (la ESM) ----
const src = fs.readFileSync(path.join(dir, "worker.js"), "utf8");
const { pathToFileURL } = require("url");

async function loadWorker() {
  const tmp = path.join(dir, "_worker_test.mjs");
  fs.writeFileSync(tmp, src, "utf8");
  const mod = await import(pathToFileURL(tmp).href + "?t=" + Date.now());
  return mod.default;
}

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log("  PASS  " + label);
  } else {
    fail++;
    console.log("  FAIL  " + label + (extra ? " -> " + extra : ""));
  }
}

async function main() {
  const worker = await loadWorker();
  const fetchIt = (req) => worker.fetch(req, env, {});

  const BASE = "https://example.workers.dev";

  console.log("\n=== 1. PING ===");
  let r = await fetchIt(new Request(BASE + "/license/ping"));
  let j = await r.json();
  ok(j.ok === true && j.service === "license-server", "GET /license/ping tra ok", JSON.stringify(j));
  ok(j.hasKv === true, "Worker nhan biet LICENSE_KV");

  console.log("\n=== 2. TRANG ADMIN (chua dang nhap) ===");
  r = await fetchIt(new Request(BASE + "/admin"));
  let html = await r.text();
  ok(r.status === 200, "GET /admin tra 200");
  ok(html.includes("Dang nhap quan tri"), "Trang admin hien form dang nhap");
  ok(!html.includes("TAO KEY</button>") || html.includes("id=\"createBtn\""), "Nut tao key ton tai trong DOM");

  console.log("\n=== 3. DANG NHAP SAI / DUNG ===");
  r = await fetchIt(
    new Request(BASE + "/admin/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "sai-mat-khau" }),
    }),
  );
  j = await r.json();
  ok(r.status === 401 && j.ok === false, "Mat khau sai bi tu choi", "status=" + r.status);

  r = await fetchIt(
    new Request(BASE + "/admin/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-admin-pass" }),
    }),
  );
  j = await r.json();
  const setCookie = r.headers.get("Set-Cookie") || "";
  const cookie = setCookie.split(";")[0];
  ok(r.status === 200 && j.ok === true, "Dang nhap dung mat khau", "status=" + r.status);
  ok(cookie.startsWith("lic_admin="), "Phai tra cookie session", cookie);
  ok(setCookie.includes("HttpOnly"), "Cookie phai co HttpOnly");
  ok(setCookie.includes("SameSite=Strict"), "Cookie phai co SameSite=Strict");

  console.log("\n=== 4. API ADMIN can session ===");
  r = await fetchIt(new Request(BASE + "/admin/api/keys"));
  j = await r.json();
  ok(r.status === 401, "Khong cookie -> 401", "status=" + r.status);

  r = await fetchIt(new Request(BASE + "/admin/api/keys", { headers: { Cookie: cookie } }));
  j = await r.json();
  ok(r.status === 200 && j.ok === true, "Co cookie -> lay danh sach key duoc");

  console.log("\n=== 5. TAO KEY (4 goi) ===");
  const created = {};
  for (const plan of ["7d", "30d", "lifetime", "custom"]) {
    r = await fetchIt(
      new Request(BASE + "/admin/api/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ plan, customDays: 45, maxDevices: 1, note: "KH " + plan }),
      }),
    );
    j = await r.json();
    created[plan] = j;
    ok(j.ok === true && /^TL_[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(j.key),
      "Tao key goi " + plan + " -> dinh dang TL_XXXX-XXXX-XXXX-XXXX", j.key);
  }
  ok(created["lifetime"].record.expiresAt === 0, "Goi vo han -> expiresAt = 0");
  ok(created["custom"].record.expiresAt > Date.now() + 44 * 24 * 3600 * 1000, "Goi tuy chinh 45 ngay -> han dung");
  ok(created["7d"].record.expiresAt < Date.now() + 8 * 24 * 3600 * 1000, "Goi 7 ngay -> han dung");

  console.log("\n=== 6. KICH HOAT KEY KHONG TON TAI ===");
  r = await fetchIt(
    new Request(BASE + "/license/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "TL_AAAA-BBBB-CCCC-DDDD", deviceId: "DEVICE1" }),
    }),
  );
  j = await r.json();
  ok(r.status === 400 && j.ok === false && j.code === "invalid", "Key khong ton tai -> invalid", JSON.stringify(j));

  console.log("\n=== 7. KICH HOAT KEY HOP LE ===");
  const key30 = created["30d"].key;
  r = await fetchIt(
    new Request(BASE + "/license/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key30, deviceId: "DEVICE1" }),
    }),
  );
  j = await r.json();
  ok(j.ok === true, "Kich hoat key 30d thanh cong", JSON.stringify(j));
  ok(j.expiresAt > Date.now(), "Server tra expiresAt tuong lai");

  console.log("\n=== 8. XAC MINH ===");
  r = await fetchIt(
    new Request(BASE + "/license/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key30, deviceId: "DEVICE1" }),
    }),
  );
  j = await r.json();
  ok(j.ok === true, "Verify key da kich hoat -> ok");

  console.log("\n=== 9. GIOI HAN SO MAY ===");
  r = await fetchIt(
    new Request(BASE + "/license/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key30, deviceId: "DEVICE2" }),
    }),
  );
  j = await r.json();
  ok(r.status === 400 && j.code === "max_devices", "May thu 2 bi tu choi (max 1 may)", JSON.stringify(j));

  console.log("\n=== 10. GIA HAN ===");
  const hash30 = (await (async () => {
    r = await fetchIt(new Request(BASE + "/admin/api/keys", { headers: { Cookie: cookie } }));
    const kk = (await r.json()).keys.find((k) => k.plan === "30d");
    return kk ? kk.keyHash : null;
  })());
  ok(!!hash30, "Tim duoc keyHash de gia han");
  r = await fetchIt(
    new Request(BASE + "/admin/api/extend", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ keyHash: hash30, days: 30 }),
    }),
  );
  j = await r.json();
  const before = created["30d"].record.expiresAt;
  ok(j.ok === true && j.expiresAt > before, "Gia han 30 ngay -> han moi lon hon", "before=" + before + " after=" + j.expiresAt);

  console.log("\n=== 11. GO MAY (unbind) ===");
  r = await fetchIt(
    new Request(BASE + "/admin/api/unbind-device", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ keyHash: hash30, deviceId: "DEVICE1" }),
    }),
  );
  j = await r.json();
  ok(j.ok === true && j.deviceCount === 0, "Go may -> con 0 may");

  console.log("\n=== 12. KICH HOAT LAI TREN MAY MOI ===");
  r = await fetchIt(
    new Request(BASE + "/license/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key30, deviceId: "DEVICE3" }),
    }),
  );
  j = await r.json();
  ok(j.ok === true, "May moi kich hoat duoc sau khi go may cu", JSON.stringify(j));

  console.log("\n=== 13. THU HOI KEY ===");
  r = await fetchIt(
    new Request(BASE + "/admin/api/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ keyHash: hash30, status: "revoked" }),
    }),
  );
  j = await r.json();
  ok(j.ok === true && j.status === "revoked", "Thu hoi key thanh cong");

  r = await fetchIt(
    new Request(BASE + "/license/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key30, deviceId: "DEVICE3" }),
    }),
  );
  j = await r.json();
  ok(r.status === 400 && j.code === "revoked", "Verify key da thu hoi -> revoked (chan ngay)", JSON.stringify(j));

  r = await fetchIt(
    new Request(BASE + "/license/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key30, deviceId: "DEVICE4" }),
    }),
  );
  j = await r.json();
  ok(r.status === 400 && j.code === "revoked", "Activate key da thu hoi -> revoked", JSON.stringify(j));

  console.log("\n=== 14. KHOA KEY SAU NHIEU LAN THU SAI ===");
  // Dung mot key KHONG TON TAI de moi lan thu deu la "thu sai"
  const badKey = "TL_0000-0000-0000-0000";
  let lastCode = "";
  let sawLock = false;
  for (let i = 0; i < 7; i++) {
    r = await fetchIt(
      new Request(BASE + "/license/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: badKey, deviceId: "DEVX" }),
      }),
    );
    j = await r.json();
    lastCode = j.code;
    if (j.code === "locked") sawLock = true;
  }
  ok(sawLock, "Sau 5 lan thu sai -> key bi khoa tam thoi", "code cuoi=" + lastCode);

  console.log("\n=== 15. XOA KEY ===");
  r = await fetchIt(
    new Request(BASE + "/admin/api/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ keyHash: hash30 }),
    }),
  );
  j = await r.json();
  ok(j.ok === true, "Xoa key thanh cong");

  r = await fetchIt(new Request(BASE + "/admin/api/keys", { headers: { Cookie: cookie } }));
  j = await r.json();
  ok(j.stats.total === 3, "Con lai 3 key sau khi xoa 1", "total=" + j.stats.total);
  // Key 30d da bi xoa (cung chua may DEVICE3) -> tong may phai = 0
  ok(j.stats.devices === 0, "Thong ke may: 0 (key chua may da bi xoa)", "devices=" + j.stats.devices);

  console.log("\n=== 16. ROUTE FB CU VAN HOAT DONG ===");
  r = await fetchIt(new Request(BASE + "/info"));
  j = await r.json();
  ok(j.ok === true && Array.isArray(j.endpoints), "GET /info van tra JSON", JSON.stringify(j));

  r = await fetchIt(new Request(BASE + "/khong-ton-tai"));
  ok(r.status === 404, "Route la -> 404");

  console.log("\n=== 17. DANG XUAT ===");
  r = await fetchIt(
    new Request(BASE + "/admin/api/logout", { method: "POST", headers: { Cookie: cookie } }),
  );
  ok(r.status === 200, "Dang xuat thanh cong");
  r = await fetchIt(new Request(BASE + "/admin/api/keys", { headers: { Cookie: cookie } }));
  ok(r.status === 401, "Session cu bi xoa -> 401");

  console.log("\n=== 18. KV KHONG LUOI FULL KEY ===");
  let leaked = false;
  for (const [k, v] of kvStore.entries()) {
    if (k.startsWith("key:") && typeof v === "string" && v.includes(created["30d"].key)) leaked = true;
  }
  ok(!leaked, "Gia tri trong KHONG chua full key (chi luoi hash)");

  console.log("\n=== 19. DAU KEY TRONG DB ===");
  const hashKey = await (async () => {
    const enc = new TextEncoder().encode(created["7d"].key.trim().toUpperCase());
    const h = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
  })();
  const stored = await KV.get("key:" + hashKey, { type: "json" });
  ok(stored && stored.keyPrefix === "TL_" + created["7d"].key.slice(3, 7), "Co luu keyPrefix de quan tri",
    stored ? "prefix=" + stored.keyPrefix + " expected=TL_" + created["7d"].key.slice(3, 7) : "null");

  console.log("\n=== 20. CORS CHO EXTENSION ===");
  r = await fetchIt(
    new Request(BASE + "/license/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "chrome-extension://abcdefghijklmnop" },
      body: JSON.stringify({ key: key30, deviceId: "DEV1" }),
    }),
  );
  ok((r.headers.get("Access-Control-Allow-Origin") || "") === "chrome-extension://abcdefghijklmnop",
    "CORS echo dung origin extension", r.headers.get("Access-Control-Allow-Origin"));

  console.log("\n=========================================");
  console.log("KET QUA: " + pass + " PASS / " + fail + " FAIL");
  console.log("=========================================\n");

  try {
    fs.unlinkSync(path.join(dir, "_worker_test.mjs"));
  } catch (e) {}

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("LOI TEST:", e);
  process.exit(1);
});
