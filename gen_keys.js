const { webcrypto } = require("crypto");
const subtle = webcrypto.subtle;

(async () => {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const payload = Buffer.from("test-payload-123", "utf8");
  const sigBuf = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, payload);
  console.log("sig type:", sigBuf.constructor.name, "len:", sigBuf.byteLength);
  const sig = Buffer.from(new Uint8Array(sigBuf)); // copy that KHONG chia san bo nho
  const bad = Buffer.from(sig);
  bad[10] = bad[10] ^ 0xff;
  const rejected = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, bad, payload);
  const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, sig, payload);
  console.log("verify sig that:", ok);
  console.log("reject bad sig:", rejected ? "PASS" : "FAIL");
})();
