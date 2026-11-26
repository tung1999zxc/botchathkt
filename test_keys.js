/* =========================================================================
 * TEST KEYS - Cap khoa ECDSA P-256 rieng cho bo test.
 * -------------------------------------------------------------------------
 * KHONG dung cap khoa nay o production. Cap khoa production duoc tao bang
 * `node _gen_keys.js` va luu trong Cloudflare Secret "LICENSE_PRIVATE_KEY".
 * ========================================================================= */
const TEST_PRIVATE_KEY =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg/oCrS6tIhwxX+LBlHRTfjVTh+TL2mZaiWf7942hJzc+hRANCAATnhKn5wEXRtNJ4mbx5bJae7nlbl+HnPZjmXQV+fN0/hqlWmf31eudyPCxq+LpKAIC2m+Wlmz1N7iJqAKep3HXe";

const TEST_PUBLIC_KEY =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE54Sp+cBF0bTSeJm8eWyWnu55W5fh5z2Y5l0FfnzdP4apVpn99Xrncjwsavi6SgCAtpvlpZs9Te4iagCnqdx13g==";

/**
 * Thay the khoa cong trong source bang khoa cong test.
 * @param {string} source - noi dung file
 * @param {string} currentPub - khoa cong hien tai trong file
 * @returns {string}
 */
function patchPublicKey(source, currentPub) {
  return source.split(currentPub).join(TEST_PUBLIC_KEY);
}

module.exports = { TEST_PRIVATE_KEY, TEST_PUBLIC_KEY, patchPublicKey };
