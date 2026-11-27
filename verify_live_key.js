/* =========================================================================
 * VERIFY LIVE KEY - Kiem chung key that tren server that voi cap khoa
 * production trong license_core.js.
 * -------------------------------------------------------------------------
 * Dung:
 *   node verify_live_key.js TL_XXXX-XXXX-XXXX-XXXX [deviceId]
 *
 * - goi POST /license/verify tren server that
 * - xac minh chu ky tra ve bang khoa cong production (doc tu license_core.js)
 * - doi chieu payload.key / payload.deviceId
 * ========================================================================= */
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const SERVER =
  process.env.LICENSE_SERVER_URL ||
  "https://botchathkt.tung1999zxc.workers.dev";

const key = (process.argv[2] || "").trim().toUpperCase();
const deviceId = (process.argv[3] || "VERIFYLIVEDEVICE01").trim().toUpperCase();

if (!key) {
  console.error("Dung: node verify_live_key.js <KEY> [deviceId]");
  process.exit(1);
}

function readPub(src) {
  const m = src.match(
    /LICENSE_PUBLIC_KEY_B64\s*=\s*\n?\s*"([A-Za-z0-9+/=]+)"/,
  );
  if (!m) throw new Error("Khong tim thay LICENSE_PUBLIC_KEY_B64");
  return m[1];
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

async function main() {
  const corePub = readPub(
    fs.readFileSync(path.join(dir, "license_core.js"), "utf8"),
  );
  const keyId = require("crypto")
    .createHash("sha256")
    .update(corePub, "utf8")
    .digest("hex")
    .slice(0, 16);

  console.log("\n=== 1. PING SERVER ===");
  const ping = await (await fetch(SERVER + "/license/ping")).json();
  console.log("  " + JSON.stringify(ping));
  ok(ping.ok === true, "Server phan hoi");
  ok(ping.hasSigning === true, "Server da co khoa chu ky");
  ok(
    ping.keyId === keyId,
    "keyId server == keyId khoa cong trong license_core.js",
    "server=" + ping.keyId + " client=" + keyId,
  );

  console.log("\n=== 2. VERIFY KEY ===");
  const res = await fetch(SERVER + "/license/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, deviceId, version: "1.0" }),
  });
  const j = await res.json();
  console.log("  HTTP " + res.status + " -> " + JSON.stringify(j).slice(0, 300));

  if (!j.ok) {
    ok(false, "Server nhan key", j.message || j.code);
    console.log("\nKET QUA: " + pass + " PASS / " + fail + " FAIL");
    process.exit(1);
  }
  ok(j.ok === true, "Server nhan key");
  ok(typeof j.payload === "string" && j.payload.length > 0, "Server tra payload");
  ok(
    typeof j.signature === "string" && j.signature.length > 0,
    "Server tra chu ky (KHONG null)",
  );

  console.log("\n=== 3. XAC MINH CHU KY BANG KHOA CONG PRODUCTION ===");
  const pubKey = await crypto.subtle.importKey(
    "spki",
    Buffer.from(corePub, "base64"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const sigOk = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pubKey,
    Buffer.from(j.signature, "base64"),
    Buffer.from(j.payload, "utf8"),
  );
  ok(sigOk === true, "Chu ky server xac minh duoc bang khoa cong production");

  console.log("\n=== 4. CHU KY BI SUA DOI BI TU CHOI ===");
  const bad = Buffer.from(j.signature, "base64");
  bad[10] ^= 0xff;
  const rej = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pubKey,
    bad,
    Buffer.from(j.payload, "utf8"),
  );
  ok(rej === false, "Chu ky sua doi bi tu choi");

  console.log("\n=== 5. NOI DUNG PAYLOAD ===");
  const p = JSON.parse(j.payload);
  ok(p.key === key, "Payload chua dung key", p.key);
  ok(
    String(p.deviceId).toUpperCase() === deviceId,
    "Payload chua dung deviceId",
    p.deviceId,
  );
  ok(p.status === "active", "Payload co status=active", p.status);
  ok(p.issuedAt > 0, "Payload co issuedAt");
  ok(!!p.nonce, "Payload co nonce (chong replay)");
  if (p.expiresAt > 0) {
    const days = Math.ceil((p.expiresAt - Date.now()) / 86400000);
    ok(p.expiresAt > Date.now(), "License con han (" + days + " ngay)");
  } else {
    ok(true, "License vo han");
  }

  console.log("\n=========================================");
  console.log("KET QUA: " + pass + " PASS / " + fail + " FAIL");
  console.log("=========================================\n");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("LOI:", e && e.message);
  process.exit(1);
});
