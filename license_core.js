/* =========================================================================
 * LICENSE CORE - Lop toi cho he thong kich hoat key ban quyen
 * -------------------------------------------------------------------------
 * CHUC NANG
 *   1. Sinh "ma may" (deviceId) on dinh tu fingerprint may tinh.
 *   2. Luu/truy xuat license trong chrome.storage.local.
 *   3. Goi server kich hoat (/license/activate) va xac minh (/license/verify).
 *   4. Tinh trang: valid | expired | revoked | none | invalid
 *
 * MODULE DUNG CHUNG - nap o ca 2 noi:
 *   dashboard.html : <script src="license_core.js"></script>
 *   background.js  : importScripts("license_core.js");
 *
 * LUUU Y QUAN TRONG
 *   - "fail-open": loi mang KHONG duoc khoa nguoi dung. Chi khi server
 *     tra loi "dung khop" thi moi chan.
 *   - Server la nguon su that. Client chi la bo phat.
 * ========================================================================= */
(function (global) {
  "use strict";

  // ---- Key trong chrome.storage.local ----
  const KEY_LICENSE = "ccLicense";
  const KEY_SERVER_URL = "ccLicenseServerUrl";

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
  // De trong => dung workerUrl da luu san trong chrome.storage.local
  const DEFAULT_SERVER_URL = "https://botchathkt.tung1999zxc.workers.dev";

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
   *   -> se duoc chuan hoa o server (bo phien ban Chrome)
   *   - language, platform, screen, colorDepth, timezone, cpu, ram
   *   -> rat on dinh, it trung giua cac may
   *
   * KHONG dung: Math.random(), timestamp, thoi gian thuc.
   * Doi may => doi fingerprint => phai kich hoat lai ( dung y de).
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
      // Loi mang / timeout -> coi nhu offline (fail-open)
      return {
        ok: false,
        offline: true,
        error: e && e.name === "AbortError" ? "Timeout" : "Khong ket noi duoc server",
      };
    } finally {
      clearTimeout(timer);
    }
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

    // Da xac minh gan day -> cho qua, khong can mang
    const lastVerify = lic.lastVerify || 0;
    if (Date.now() - lastVerify < VERIFY_INTERVAL) {
      return {
        allowed: true,
        state: "valid",
        message: "License hop le",
        license: lic,
        needsNetwork: false,
      };
    }

    // Da het chu ky xac minh -> can goi server
    const result = await verify();
    return result;
  }

  /* ---------------------------------------------------------
   * XAC MINH (heartbeat)
   * ------------------------------------------------------- */

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

    // FAIL-OPEN: loi mang -> van cho dung, chi danh dau can kiem tra lai
    if (res.offline) {
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

    const data = res.data || {};

    if (!res.ok || data.ok !== true) {
      const code = data.code || "invalid";
      if (code === "revoked" || code === "expired" || code === "invalid") {
        // Server tra loi DUNG khop -> chan ngay
        await clearLicense();
        return {
          allowed: false,
          state: code,
          message: data.message || "License khong hop le",
          license: null,
          needsNetwork: false,
        };
      }
      // Loi tam thoi -> fail-open
      const updated = { ...lic, lastVerify: Date.now(), pendingRecheck: true };
      await saveLicense(updated);
      return {
        allowed: true,
        state: "valid",
        message: data.message || "Khong xac minh duoc, dung ban cache",
        license: updated,
        needsNetwork: true,
      };
    }

    // Server OK -> cap nhat thong tin moi nhat
    const updated = {
      ...lic,
      expiresAt: data.expiresAt || lic.expiresAt,
      status: "active",
      lastVerify: Date.now(),
      pendingRecheck: false,
      plan: data.plan || lic.plan,
    };
    await saveLicense(updated);

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

    // Thanh cong -> luu
    const license = {
      key: cleanKey,
      deviceId: deviceId,
      activatedAt: Date.now(),
      expiresAt: data.expiresAt || 0,
      lastVerify: Date.now(),
      status: "active",
      plan: data.plan || "custom",
      maxDevices: data.maxDevices || 1,
      pendingRecheck: false,
    };
    await saveLicense(license);
    await setStorage({ [KEY_FAILED]: 0, [KEY_LOCKED]: 0 });

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
    return { ok: true };
  }

  /* ---------------------------------------------------------
   * XUAT API
   * ------------------------------------------------------- */

  const api = {
    KEY_LICENSE,
    KEY_SERVER_URL,
    VERIFY_INTERVAL,
    DEFAULT_SERVER_URL,
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
  };

  global.LicenseCore = api;
})(typeof window !== "undefined" ? window : self);
