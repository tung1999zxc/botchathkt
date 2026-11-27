/* =========================================================================
 * LICENSE CORE - Lop toi cho he thong kich hoat key ban quyen
 * -------------------------------------------------------------------------
 * CHUC NANG
 *   1. Sinh "ma may" (deviceId) on dinh tu fingerprint may tinh.
 *   2. Luu/truy xuat license trong chrome.storage.local.
 *   3. Goi server kich hoat (/license/activate) va xac minh (/license/verify).
 *   4. Tinh trang: valid | expired | revoked | none | invalid | tampered
 *
 * BAO MAT (Uu tien 1 + 2)
 *   [1] CHU KY SO ECDSA P-256:
 *       Server ky payload license bang khoa RIENG (Worker Secret).
 *       Client xac minh bang khoa CONG nhung san trong file nay.
 *       => Khong the gia mao du lieu license trong chrome.storage.local
 *          (chi co server moi tao duoc chu ky hop le).
 *
 *   [2] PING KIEM TRA FAIL-OPEN:
 *       Khi /license/verify that bai, client ping /license/ping:
 *         - Ping OK   (server song, verify bi chan)  => FAIL-CLOSED (chan)
 *         - Ping fail (server khong doi)              => FAIL-OPEN (cho qua)
 *       => Chan duoc bo qua bang DevTools / AdBlock / sua host_permissions.
 *
 *   [3] OFFLINE GRACE (cua so cho phep mat mang):
 *       Chi cho qua khi mat mang trong mot khoang thoi gian gioi han.
 *       Het cua so => chan (fail-closed) cho toi da.
 *
 * MODULE DUNG CHUNG - nap o ca 2 noi:
 *   dashboard.html : <script src="license_core.js"></script>
 *   background.js  : importScripts("license_core.js");
 * ========================================================================= */
(function (global) {
  "use strict";

  // ---- Key trong chrome.storage.local ----
  const KEY_LICENSE = "ccLicense";
  const KEY_SERVER_URL = "ccLicenseServerUrl";
  const KEY_OFFLINE = "ccLicenseOfflineSince";

  // ---- Chu ky xac minh lai (heartbeat): 24 gio ----
  const VERIFY_INTERVAL = 24 * 60 * 60 * 1000;

  // ---- Thoi gian cho toi da toi da server (ms) ----
  const REQUEST_TIMEOUT = 15000;

  // ---- So lan thu sai truoc khi khoa key tam thoi ----
  const MAX_FAILED_ATTEMPTS = 5;
  const LOCK_DURATION = 15 * 60 * 1000;

  // ---- Ten key trong storage ----
  const KEY_FAILED = "ccLicenseFailedAttempts";
  const KEY_LOCKED = "ccLicenseLockedUntil";

  // ---- Server mac dinh (duoc ghi de bang UI quan tri) ----
  const DEFAULT_SERVER_URL = "https://botchathkt.tung1999zxc.workers.dev";

  /* ---------------------------------------------------------
   * KHOA CONG XAC MINH CHU KY (ECDSA P-256)
   * -------------------------------------------------------
   * Khoa RIENG nam trong Worker Secret "LICENSE_PRIVATE_KEY".
   * Khoa CONG ben duoi KHONG THE bien thanh khoa rieng.
   * Sinh cap khoa moi: node _gen_keys.js
   * ------------------------------------------------------- */
  const LICENSE_PUBLIC_KEY_B64 =
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE7TZCBHimLGN6dtQ6tv45UR4IPknmI5GyfE5o4mnTV1B0xk8HF+Ke/Ae4aqooT4jPwGTD+Fw8nZ17PU2E55u/RQ==";

  // ---- Cua so offline grace: cho phep mat mang toi da 6 gio ----
  const OFFLINE_GRACE = 6 * 60 * 60 * 1000;

  /* ---------------------------------------------------------
   * TIEN ICH
   * ------------------------------------------------------- */

  function getStorage(keys) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === "undefined" || !chrome.storage) {
          resolve({});
          return;
        }
        chrome.storage.local.get(keys, (res) => resolve(res || {}));
      } catch (e) {
        resolve({});
      }
    });
  }

  function setStorage(obj) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === "undefined" || !chrome.storage) {
          resolve();
          return;
        }
        chrome.storage.local.set(obj, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  function removeStorage(keys) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === "undefined" || !chrome.storage) {
          resolve();
          return;
        }
        chrome.storage.local.remove(keys, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  /* ---------------------------------------------------------
   * FINGERPRINT -> DEVICE ID
   * -------------------------------------------------------
   * Chon cac thanh phan ONH DINH:
   *   - userAgent: co chua phien ban Chrome/OS -> thay doi khi update
   *   -> se duoc chuan hoa (bo phien ban Chrome)
   *   - language, platform, screen, colorDepth, timezone, cpu, ram
   *   -> rat on dinh, it trung giua cac may
   *
   * KHONG dung: Math.random(), timestamp, thoi gian thuc.
   * Doi may => doi fingerprint => phai kich hoat lai (dung y de).
   * ------------------------------------------------------- */

  function collectFingerprintParts() {
    const nav = typeof navigator !== "undefined" ? navigator : {};
    const scr = typeof screen !== "undefined" ? screen : {};
    const ua = nav.userAgent || "";
    // Chuan hoa UA: bo phien ban Chrome/Edge, giu lai nen tang he
    const uaBase = ua
      .replace(/Chrome\/[\d.]+/g, "Chrome/0")
      .replace(/Edg\/[\d.]+/g, "Edg/0")
      .replace(/Safari\/[\d.]+/g, "Safari/0")
      .replace(/Version\/[\d.]+/g, "Version/0");

    return [
      uaBase,
      nav.language || "",
      nav.platform || "",
      (scr.width || 0) + "x" + (scr.height || 0),
      String(scr.colorDepth || 0),
      String(nav.hardwareConcurrency || 0),
      String(nav.deviceMemory || 0),
      String(new Date().getTimezoneOffset()),
    ].join("||");
  }

  function bufToHex(buf) {
    const bytes = new Uint8Array(buf);
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, "0");
    }
    return out;
  }

  async function sha256Hex(text) {
    try {
      if (
        typeof crypto !== "undefined" &&
        crypto.subtle &&
        typeof TextEncoder !== "undefined"
      ) {
        const enc = new TextEncoder().encode(text);
        const hash = await crypto.subtle.digest("SHA-256", enc);
        return bufToHex(hash);
      }
    } catch (e) {
      // fallback ben duoi
    }
    // Fallback: FNV-1a 64-bit (khong phai SHA-256 nhung du cho dinh danh)
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = Math.imul(h2 + c + i, 2246822519) >>> 0;
    }
    return (
      h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")
    );
  }

  // Cache deviceId trong memory + storage de khong tinh lai nhieu lan
  let _deviceIdCache = "";

  async function getDeviceId() {
    if (_deviceIdCache) return _deviceIdCache;
    const res = await getStorage([KEY_LICENSE]);
    const saved = res[KEY_LICENSE];
    if (saved && saved.deviceId) {
      _deviceIdCache = saved.deviceId;
      return _deviceIdCache;
    }
    const fp = collectFingerprintParts();
    const hash = await sha256Hex(fp);
    const id = hash.slice(0, 32).toUpperCase();
    _deviceIdCache = id;
    return id;
  }

  /* ---------------------------------------------------------
   * SERVER URL
   * ------------------------------------------------------- */

  async function getServerUrl() {
    const res = await getStorage([KEY_SERVER_URL, "workerUrl"]);
    let url = (res[KEY_SERVER_URL] || "").trim();
    if (!url) url = (res.workerUrl || DEFAULT_SERVER_URL).trim();
    return url.replace(/\/+$/, "");
  }

  async function setServerUrl(url) {
    const clean = (url || "").trim().replace(/\/+$/, "");
    await setStorage({ [KEY_SERVER_URL]: clean });
    return clean;
  }

  /* ---------------------------------------------------------
   * GOC API SERVER
   * ------------------------------------------------------- */

  async function apiFetch(path, options) {
    const base = await getServerUrl();
    if (!base) {
      return {
        ok: false,
        offline: true,
        error: "Chua cau hinh dia chi license server",
      };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
    try {
      const res = await fetch(base + path, {
        ...(options || {}),
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          ...((options && options.headers) || {}),
        },
      });
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }
      return { ok: res.ok, status: res.status, data: data || {} };
    } catch (e) {
      // Loi mang / timeout -> coi nhu offline
      return {
        ok: false,
        offline: true,
        error:
          e && e.name === "AbortError" ? "Timeout" : "Khong ket noi duoc server",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------------------------------------------------
   * XAC MINH CHU KY SO (Uu tien 1)
   * -------------------------------------------------------
   * Payload server ky co dang JSON:
   *   { key, deviceId, plan, expiresAt, status, maxDevices, issuedAt, nonce }
   *
   * Client phai:
   *   1. Xac minh chu ky bang khoa cong (ECDSA P-256 + SHA-256)
   *   2. Doi chieu payload voi du lieu license trong storage
   *   3. Tu choi neu bat ky buoc nao that bai
   * ------------------------------------------------------- */

  function b64ToBytes(b64) {
    const bin = atob(String(b64 || "").trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  let _pubKeyCache = null;

  async function getPublicKey() {
    if (_pubKeyCache) return _pubKeyCache;
    try {
      if (typeof crypto === "undefined" || !crypto.subtle) return null;
      const key = await crypto.subtle.importKey(
        "spki",
        b64ToBytes(LICENSE_PUBLIC_KEY_B64),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      _pubKeyCache = key;
      return key;
    } catch (e) {
      return null;
    }
  }

  /**
   * Xac minh chu ky cua payload license.
   * @param {string} payload - chuoi JSON da ky
   * @param {string} signature - chu ky base64
   * @returns {Promise<{ok:boolean, data:object|null, reason:string}>}
   */
  async function verifySignature(payload, signature) {
    if (!payload || !signature) {
      return { ok: false, data: null, reason: "Thieu payload hoac chu ky" };
    }
    const key = await getPublicKey();
    if (!key) {
      return { ok: false, data: null, reason: "Khong nap duoc khoa cong" };
    }
    try {
      const sigBytes = b64ToBytes(signature);
      const dataBytes = new TextEncoder().encode(payload);
      const valid = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        sigBytes,
        dataBytes,
      );
      if (!valid) {
        return { ok: false, data: null, reason: "Chu ky khong hop le" };
      }
      let data = null;
      try {
        data = JSON.parse(payload);
      } catch (e) {
        return { ok: false, data: null, reason: "Payload khong phai JSON hop le" };
      }
      return { ok: true, data: data, reason: "" };
    } catch (e) {
      return { ok: false, data: null, reason: "Loi xac minh chu ky" };
    }
  }

  /**
   * Xac minh chu ky VA doi chieu voi license trong storage.
   * Day la "hang rao" chong gia mao du lieu cuc bo.
   *
   * @param {object} lic - license doc tu chrome.storage.local
   * @returns {Promise<{ok:boolean, reason:string, data:object|null, legacy:boolean}>}
   */
  async function verifyLocalLicense(lic) {
    if (!lic) {
      return { ok: false, reason: "Chua kich hoat", data: null, legacy: false };
    }

    // === LEGACY: license kich hoat TRUOC khi trien khai chu ky so ===
    // Ca payload VA signature deu vang (du lieu license thoi phong ky so).
    // Day KHONG phai gia mao -> cho phep hoi server cap lai chu ky.
    if (!lic.payload && !lic.signature) {
      return {
        ok: false,
        reason: "License cu chua co chu ky so",
        data: null,
        legacy: true,
      };
    }

    const r = await verifySignature(lic.payload, lic.signature);
    if (!r.ok) {
      return { ok: false, reason: r.reason, data: null, legacy: false };
    }
    const d = r.data || {};

    // Payload phai khop key
    if (String(d.key || "") !== String(lic.key || "")) {
      return { ok: false, reason: "Payload key khong khop", data: null, legacy: false };
    }
    // Payload phai khop device
    if (
      String(d.deviceId || "").toUpperCase() !==
      String(lic.deviceId || "").toUpperCase()
    ) {
      return { ok: false, reason: "Payload deviceId khong khop", data: null, legacy: false };
    }
    // Payload phai khop han su dung
    if (Number(d.expiresAt || 0) !== Number(lic.expiresAt || 0)) {
      return { ok: false, reason: "Payload expiresAt khong khop", data: null, legacy: false };
    }
    // Payload phai khop trang thai
    if (String(d.status || "") !== String(lic.status || "")) {
      return { ok: false, reason: "Payload status khong khop", data: null, legacy: false };
    }
    // Payload phai con han
    if (d.expiresAt && d.expiresAt > 0 && d.expiresAt < Date.now()) {
      return { ok: false, reason: "Payload da het han", data: null, legacy: false };
    }
    // issuedAt phai khong tuong lai (chong gia mao thoi gian)
    if (d.issuedAt && d.issuedAt > Date.now() + 60 * 60 * 1000) {
      return { ok: false, reason: "issuedAt khong hop le", data: null, legacy: false };
    }

    return { ok: true, reason: "", data: d, legacy: false };
  }

  /* ---------------------------------------------------------
   * DOC / GHI LICENSE
   * ------------------------------------------------------- */

  async function getLicense() {
    const res = await getStorage([KEY_LICENSE]);
    return res[KEY_LICENSE] || null;
  }

  async function saveLicense(obj) {
    await setStorage({ [KEY_LICENSE]: obj });
    return obj;
  }

  async function clearLicense() {
    await removeStorage([KEY_LICENSE, KEY_FAILED, KEY_LOCKED]);
    _deviceIdCache = "";
  }

  /* ---------------------------------------------------------
   * OFFLINE GRACE (Uu tien 2 - phu)
   * -------------------------------------------------------
   * Chi cho qua khi mat mang trong mot khoang gioi han.
   * Server co the cap nhat revoke -> client van chay toi da 6 gio.
   * ------------------------------------------------------- */

  async function getOfflineSince() {
    const res = await getStorage([KEY_OFFLINE]);
    return res[KEY_OFFLINE] || 0;
  }

  async function markOffline() {
    const since = await getOfflineSince();
    if (!since) {
      await setStorage({ [KEY_OFFLINE]: Date.now() });
    }
  }

  async function clearOffline() {
    await removeStorage([KEY_OFFLINE]);
  }

  /** So ms con lai trong cua so offline grace (0 = het). */
  async function graceRemaining() {
    const since = await getOfflineSince();
    if (!since) return 0;
    const left = OFFLINE_GRACE - (Date.now() - since);
    return left > 0 ? left : 0;
  }

  /* ---------------------------------------------------------
   * KIEM TRA TRANG THAI (khong can mang)
   * ------------------------------------------------------- */

  function evaluateLocal(lic, now) {
    if (!lic || !lic.key) {
      return { state: "none", message: "Chua kich hoat" };
    }
    if (lic.status === "revoked") {
      return { state: "revoked", message: "Key da bi thu hoi" };
    }
    if (lic.expiresAt && lic.expiresAt > 0 && lic.expiresAt < now) {
      return { state: "expired", message: "Key da het han" };
    }
    return { state: "valid", message: "License hop le" };
  }

  /**
   * Kiem tra quyen su dung.
   * @returns {Promise<{allowed:boolean, state:string, message:string, license:object|null, needsNetwork:boolean}>}
   */
  async function check() {
    const lic = await getLicense();
    const local = evaluateLocal(lic, Date.now());

    if (local.state !== "valid") {
      return {
        allowed: false,
        state: local.state,
        message: local.message,
        license: lic,
        needsNetwork: false,
      };
    }

    // === Uu tien 1: chu ky so phai hop le TRUOC khi tin ===
    const sig = await verifyLocalLicense(lic);
    if (!sig.ok) {
      // === LEGACY: license kich hoat TRUOC khi trien khai chu ky so ===
      // Khong co payload/signature -> khong phai gia mao.
      // Hoi server cap lai chu ky (verify() se luu payload+signature moi).
      if (sig.legacy) {
        return await verify();
      }

      // Du lieu cuc bi sua/gia mao -> xoa va chan
      await clearLicense();
      return {
        allowed: false,
        state: "tampered",
        message:
          "Du lieu license bi thay doi khong hop le (" + sig.reason + ").",
        license: null,
        needsNetwork: false,
      };
    }

    // Da xac minh gan day -> cho qua, khong can mang
    //
    // QUAN TRONG: chi dung moc thoi gian LAY TRONG PAYLOAD DA KY (issuedAt).
    // Truong `lastVerify` trong storage khong duoc tin vi attacker co the
    // sua no. Payload da ky thi khong sua duoc (mat chu ky -> tampered).
    const lastVerify = Number(sig.data.issuedAt || 0);
    if (lastVerify > 0 && Date.now() - lastVerify < VERIFY_INTERVAL) {
      return {
        allowed: true,
        state: "valid",
        message: "License hop le",
        license: lic,
        needsNetwork: false,
      };
    }

    // Da het chu ky xac minh -> can goi server
    return await verify();
  }

  /* ---------------------------------------------------------
   * PING SERVER (Uu tien 2)
   * -------------------------------------------------------
   * Dung de phan biet:
   *   - Server SONG (ping OK)  => verify that bai la do chan/gia => FAIL-CLOSED
   *   - Server CHET (ping fail)=> mat mang that su            => FAIL-OPEN
   * ------------------------------------------------------- */

  async function pingServer() {
    const res = await apiFetch("/license/ping", { method: "GET" });
    if (res.offline) return { ok: false, reason: res.error || "offline" };
    if (!res.ok || !res.data || res.data.ok !== true) {
      return { ok: false, reason: "ping khong hop le" };
    }
    return { ok: true, reason: "", data: res.data };
  }

  /* ---------------------------------------------------------
   * XAC MINH (heartbeat)
   * ------------------------------------------------------- */

  /**
   * Fail-open CHI duoc phep khi license da co chu ky hop le cuc bo.
   * License legacy (chua co payload/signature) KHONG duoc fail-open:
   * neu khong, nguoi dung tu gia mao du lieu trong storage roi offline
   * => lan qua het hang rao.
   */
  async function canFailOpen(lic) {
    const local = await verifyLocalLicense(lic);
    return local.ok === true;
  }

  async function verify() {
    const lic = await getLicense();
    if (!lic || !lic.key) {
      return {
        allowed: false,
        state: "none",
        message: "Chua kich hoat",
        license: null,
        needsNetwork: false,
      };
    }

    const deviceId = await getDeviceId();
    const res = await apiFetch("/license/verify", {
      method: "POST",
      body: JSON.stringify({
        key: lic.key,
        deviceId: deviceId,
        version: getVersion(),
      }),
    });

    // === NHANH FAIL-OPEN: loi mang hoac timeout ===
    if (res.offline) {
      // Ping de phan biet "mat mang thu su" vs "verify bi chan"
      const ping = await pingServer();

      if (!ping.ok) {
        // Server thuc su khong doi -> fail-OPEN voi cua so grace
        // CHI khi license da co chu ky hop le (legacy thi khong duoc).
        if (await canFailOpen(lic)) {
          await markOffline();
          const grace = await graceRemaining();
          if (grace > 0) {
            const updated = {
              ...lic,
              lastVerify: Date.now(),
              pendingRecheck: true,
            };
            await saveLicense(updated);
            return {
              allowed: true,
              state: "valid",
              message: "Khong ket noi server, dung ban cache",
              license: updated,
              needsNetwork: true,
            };
          }
        }
        // Het cua so grace (hoac license chua co chu ky) -> chan (fail-closed)
        await clearLicense();
        await clearOffline();
        return {
          allowed: false,
          state: "invalid",
          message:
            "Mat ket noi license server qua lau. Vui long kiem tra mang va kich hoat lai.",
          license: null,
          needsNetwork: false,
        };
      }

      // Ping OK nhung verify that bai => server dang song, verify bi chan/gia
      // => FAIL-CLOSED (chan ngay, khong cho qua)
      await clearLicense();
      await clearOffline();
      return {
        allowed: false,
        state: "invalid",
        message:
          "Xac minh license that bai (server dang hoat dong). Key co the da bi thu hoi.",
        license: null,
        needsNetwork: false,
      };
    }

    const data = res.data || {};

    // === SERVER TRA CODE TUONG MINH ===
    if (!res.ok || data.ok !== true) {
      const code = data.code || "invalid";
      if (code === "revoked" || code === "expired" || code === "invalid") {
        // Server tra loi DUNG khop -> chan ngay
        await clearLicense();
        await clearOffline();
        return {
          allowed: false,
          state: code,
          message: data.message || "License khong hop le",
          license: null,
          needsNetwork: false,
        };
      }
      // Loi tam thoi (vd rate_limit) -> ping de quyet dinh
      const ping = await pingServer();
      if (!ping.ok) {
        // CHI fail-open khi license da co chu ky hop le (legacy thi khong duoc).
        if (await canFailOpen(lic)) {
          await markOffline();
          const grace = await graceRemaining();
          if (grace > 0) {
            const updated = {
              ...lic,
              lastVerify: Date.now(),
              pendingRecheck: true,
            };
            await saveLicense(updated);
            return {
              allowed: true,
              state: "valid",
              message: data.message || "Khong xac minh duoc, dung ban cache",
              license: updated,
              needsNetwork: true,
            };
          }
        }
        await clearLicense();
        await clearOffline();
        return {
          allowed: false,
          state: "invalid",
          message: "Khong xac minh duoc license server qua lau.",
          license: null,
          needsNetwork: false,
        };
      }
      // Server song => that bai that su -> fail-closed
      await clearLicense();
      await clearOffline();
      return {
        allowed: false,
        state: "invalid",
        message: data.message || "Xac minh license that bai.",
        license: null,
        needsNetwork: false,
      };
    }

    // === SERVER OK ===
    // Uu tien 1: chi chap nhan duoi co chu ky hop le
    const signed = await verifySignature(data.payload, data.signature);
    if (!signed.ok) {
      // === THIEU CHU KY (server chua duoc cau hinh khoa rieng) ===
      // `signature` rong/null => Worker thieu Secret LICENSE_PRIVATE_KEY.
      // Day la LOI CAU HINH cua admin, KHONG phai key bi gia mao.
      // KHONG xoa license (nguoi dung van dung duoc sau khi admin fix server).
      if (!data.payload || !data.signature) {
        return {
          allowed: false,
          state: "invalid",
          message:
            "License server chua duoc cau hinh khoa chu ky so (secret LICENSE_PRIVATE_KEY). " +
            "Vui long lien he admin.",
          license: lic,
          needsNetwork: false,
        };
      }

      // Chu ky co nhung SAI -> gia mao that su -> xoa va chan
      await clearLicense();
      return {
        allowed: false,
        state: "tampered",
        message:
          "Chu ky license khong hop le (" + signed.reason + "). Key co the bi gia mao.",
        license: null,
        needsNetwork: false,
      };
    }
    const p = signed.data || {};
    if (
      String(p.key || "") !== String(lic.key || "") ||
      String(p.deviceId || "").toUpperCase() !== String(deviceId || "").toUpperCase()
    ) {
      await clearLicense();
      return {
        allowed: false,
        state: "tampered",
        message: "Du lieu license tra ve khong khop voi thiet bi.",
        license: null,
        needsNetwork: false,
      };
    }

    const updated = {
      ...lic,
      expiresAt: Number(p.expiresAt || lic.expiresAt || 0),
      status: "active",
      lastVerify: Date.now(),
      pendingRecheck: false,
      plan: p.plan || lic.plan,
      maxDevices: p.maxDevices || lic.maxDevices || 1,
      payload: data.payload,
      signature: data.signature,
    };
    await saveLicense(updated);
    await clearOffline();

    return {
      allowed: true,
      state: "valid",
      message: "License hop le",
      license: updated,
      needsNetwork: false,
    };
  }

  /* ---------------------------------------------------------
   * KICH HOAT
   * ------------------------------------------------------- */

  async function getFailedAttempts() {
    const res = await getStorage([KEY_FAILED, KEY_LOCKED]);
    const lockedUntil = res[KEY_LOCKED] || 0;
    if (lockedUntil && Date.now() < lockedUntil) {
      return { count: res[KEY_FAILED] || 0, locked: true, until: lockedUntil };
    }
    return { count: res[KEY_FAILED] || 0, locked: false, until: 0 };
  }

  /**
   * Kich hoat key.
   * @param {string} key
   * @returns {Promise<{ok:boolean, message:string, license?:object, code?:string}>}
   */
  async function activate(key) {
    const cleanKey = (key || "").trim().toUpperCase();
    if (!cleanKey) {
      return { ok: false, message: "Vui long nhap key" };
    }

    // Kiem tra khoa tam thoi sau N lan thu sai
    const fail = await getFailedAttempts();
    if (fail.locked) {
      const mins = Math.ceil((fail.until - Date.now()) / 60000);
      return {
        ok: false,
        message: "Key dang bi khoa tam thoi. Thu lai sau " + mins + " phut.",
        code: "locked",
      };
    }

    const deviceId = await getDeviceId();
    const res = await apiFetch("/license/activate", {
      method: "POST",
      body: JSON.stringify({
        key: cleanKey,
        deviceId: deviceId,
        version: getVersion(),
      }),
    });

    if (res.offline) {
      return {
        ok: false,
        message:
          "Khong ket noi duoc license server (" +
          (res.error || "") +
          "). Kiem tra mang hoac dia chi server.",
        code: "offline",
      };
    }

    const data = res.data || {};

    if (!res.ok || data.ok !== true) {
      // Tang so lan thu sai
      const count = fail.count + 1;
      const obj = { [KEY_FAILED]: count };
      if (count >= MAX_FAILED_ATTEMPTS) {
        obj[KEY_LOCKED] = Date.now() + LOCK_DURATION;
        obj[KEY_FAILED] = 0;
      }
      await setStorage(obj);
      return {
        ok: false,
        message: data.message || "Key khong hop le",
        code: data.code || "invalid",
      };
    }

    // === Uu tien 1: bat buoc phai co chu ky hop le moi luu ===
    const signed = await verifySignature(data.payload, data.signature);
    if (!signed.ok) {
      // Server chua duoc cau hinh khoa rieng -> LOI CAU HINH, khong phai gia mao.
      if (!data.payload || !data.signature) {
        return {
          ok: false,
          message:
            "License server chua duoc cau hinh khoa chu ky so (secret LICENSE_PRIVATE_KEY). " +
            "Vui long lien he admin.",
          code: "server_not_signed",
        };
      }

      return {
        ok: false,
        message:
          "Chu ky license khong hop le (" +
          signed.reason +
          "). Key co the bi gia mao.",
        code: "bad_signature",
      };
    }
    const p = signed.data || {};
    if (
      String(p.key || "") !== cleanKey ||
      String(p.deviceId || "").toUpperCase() !== String(deviceId || "").toUpperCase()
    ) {
      return {
        ok: false,
        message: "Du lieu kich hoat khong khop voi key/thiet bi.",
        code: "bad_signature",
      };
    }

    // Thanh cong -> luu (kem chu ky)
    const license = {
      key: cleanKey,
      deviceId: deviceId,
      activatedAt: Date.now(),
      expiresAt: Number(p.expiresAt || 0),
      lastVerify: Date.now(),
      status: "active",
      plan: p.plan || "custom",
      maxDevices: p.maxDevices || 1,
      pendingRecheck: false,
      payload: data.payload,
      signature: data.signature,
    };
    await saveLicense(license);
    await setStorage({ [KEY_FAILED]: 0, [KEY_LOCKED]: 0 });
    await clearOffline();

    return { ok: true, message: "Kich hoat thanh cong", license: license };
  }

  /* ---------------------------------------------------------
   * PHIEN BAN
   * ------------------------------------------------------- */

  function getVersion() {
    try {
      if (
        typeof chrome !== "undefined" &&
        chrome.runtime &&
        chrome.runtime.getManifest
      ) {
        return chrome.runtime.getManifest().version || "0";
      }
    } catch (e) {
      // ignore
    }
    return "0";
  }

  /* ---------------------------------------------------------
   * XOA LICENSE (nut "Quan tri key" / goi lai)
   * ------------------------------------------------------- */

  async function deactivate() {
    await clearLicense();
    await clearOffline();
    return { ok: true };
  }

  /* ---------------------------------------------------------
   * XUAT API
   * ------------------------------------------------------- */

  const api = {
    KEY_LICENSE,
    KEY_SERVER_URL,
    VERIFY_INTERVAL,
    OFFLINE_GRACE,
    DEFAULT_SERVER_URL,
    LICENSE_PUBLIC_KEY_B64,
    getDeviceId,
    getServerUrl,
    setServerUrl,
    getLicense,
    saveLicense,
    clearLicense,
    check,
    verify,
    activate,
    deactivate,
    getVersion,
    evaluateLocal,
    verifySignature,
    verifyLocalLicense,
    pingServer,
    graceRemaining,
  };

  global.LicenseCore = api;
})(typeof window !== "undefined" ? window : self);
