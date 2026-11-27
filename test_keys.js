/* =========================================================================
 * TEST KEYS - Cap khoa ECDSA P-256 cho bo test.
 * -------------------------------------------------------------------------
 * Cap khoa DUOC SINH DONG moi moi khi chay test -> KHONG can luu trong git,
 * KHONG bao gio commit khoa rieng nao vao repo.
 *
 * Chi can cap khop giua private/public trong CUNG mot lan chay:
 *   - test_license.js / test_integration.js: nap worker.js voi
 *     LICENSE_PRIVATE_KEY = TEST_PRIVATE_KEY, worker ky payload bang key rieng
 *     -> client xac minh bang TEST_PUBLIC_KEY.
 *   - test_core.js: patch khoa cong trong license_core.js sang TEST_PUBLIC_KEY.
 *
 * Doi khoa rieng o production: `node gen_keys.js` (KHONG phai file nay).
 * ========================================================================= */
const crypto = require("crypto");

function bytesToB64(buf) {
  return Buffer.from(buf).toString("base64");
}

/**
 * Sinh cap khoa test moi (dong bo).
 * @returns {{privateKey:string, publicKey:string}}
 */
function generateTestKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  return {
    privateKey: bytesToB64(privateKey.export({ format: "der", type: "pkcs8" })),
    publicKey: bytesToB64(publicKey.export({ format: "der", type: "spki" })),
  };
}

// Sinh 1 lan duy nhat, dung chung cho ca file
const KEYS = generateTestKeys();
const TEST_PRIVATE_KEY = KEYS.privateKey;
const TEST_PUBLIC_KEY = KEYS.publicKey;

/**
 * Thay the khoa cong trong source bang khoa cong test.
 * @param {string} source - noi dung file
 * @param {string} currentPub - khoa cong hien tai trong file
 * @param {string} [testPub] - khoa cong test can thay vao (mac dinh khoa hien tai)
 * @returns {string}
 */
function patchPublicKey(source, currentPub, testPub) {
  return source.split(currentPub).join(testPub || TEST_PUBLIC_KEY);
}

module.exports = {
  TEST_PRIVATE_KEY,
  TEST_PUBLIC_KEY,
  generateTestKeys,
  patchPublicKey,
};
