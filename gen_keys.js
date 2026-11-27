/* =========================================================================
 * GEN KEYS - Sinh cap khoa ECDSA P-256 cho he thong license.
 * -------------------------------------------------------------------------
 * Dung:
 *   node gen_keys.js
 *
 * In ra 2 gia tri:
 *
 *   LICENSE_PRIVATE_KEY  -> Worker Secret "LICENSE_PRIVATE_KEY"
 *                           (Settings > Variables and Secrets > Add > Secret)
 *
 *   LICENSE_PUBLIC_KEY   -> nhung vao LICENSE_PUBLIC_KEY_B64 trong
 *                           license_core.js VA worker.js
 *
 * KHONG commit khoa rieng vao git.
 * Doi khoa => phai deploy lai Worker VA tai lai extension.
 * Key da kich hoat tren may cu se bi bao "tampered" va phai nhap lai.
 * ========================================================================= */
const { webcrypto } = require("crypto");
const subtle = webcrypto.subtle;

function bytesToB64(bytes) {
  return Buffer.from(new Uint8Array(bytes)).toString("base64");
}

(async () => {
  try {
    const pair = await subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true, // extractable - de export ra
      ["sign", "verify"],
    );

    const priv = await subtle.exportKey("pkcs8", pair.privateKey);
    const pub = await subtle.exportKey("spki", pair.publicKey);

    // --- Tu kiem tra 1: ky + xac minh bang chinh khoa vua sinh -------------
    const probe = Buffer.from("self-test", "utf8");
    const sig = await subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      probe,
    );
    const ok = await subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      sig,
      probe,
    );

    // --- Tu kiem tra 2: bao dam chu ky sua doi bi tu choi -----------------
    // Copy signature ra buffer rieng (KHONG chia san bo nho) roi lam sai 1 byte.
    const sigBuf = Buffer.from(new Uint8Array(sig));
    const bad = Buffer.from(sigBuf);
    bad[10] = bad[10] ^ 0xff;
    const rejected = await subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      bad,
      probe,
    );

    console.log("=== KHOA RIENG (Worker Secret) ===");
    console.log("LICENSE_PRIVATE_KEY=" + bytesToB64(priv));
    console.log("");
    console.log("=== KHOA CONG (license_core.js + worker.js) ===");
    console.log("LICENSE_PUBLIC_KEY=" + bytesToB64(pub));
    console.log("");
    console.log("=== KHOA CONG (base64 SPKI, de copy thang vao code) ===");
    console.log(bytesToB64(pub));
    console.log("");
    console.log("Self-test ky + xac minh: " + (ok ? "PASS" : "FAIL"));
    console.log("Tu choi chu ky bi sua doi: " + (rejected ? "FAIL" : "PASS"));

    if (!ok || rejected) process.exitCode = 1;
  } catch (e) {
    console.error("LOI:", e && e.message);
    process.exitCode = 1;
  }
})();
