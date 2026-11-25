/* =========================================================================
 * LICENSE GATE - Canh gac tren UI cho trang dashboard
 * -------------------------------------------------------------------------
 * NHIEM VU
 *   1. Kiem tra license ngay khi trang mo.
 *   2. Neu khong hop le -> hien overlay chan toan man hinh.
 *   3. Xu ly bam "KICH HOAT NGAY" -> goi server -> luu key -> bo overlay.
 *   4. Chan nguoi dung bo qua bang DevTools / Esc.
 *
 * LOAD ORDER: license_core.js phai duoc nap TRUOC file nay.
 * ========================================================================= */
(function () {
  "use strict";

  const Core = typeof window !== "undefined" ? window.LicenseCore : null;

  if (!Core) {
    console.error("[LicenseGate] Khong tim thay LicenseCore");
    return;
  }

  // ===== DOM =====
  const overlay = document.getElementById("licenseOverlay");
  const deviceEl = document.getElementById("displayDeviceId");
  const keyInput = document.getElementById("keyInput");
  const activateBtn = document.getElementById("activateBtn");
  const keyMsg = document.getElementById("keyMsg");
  const serverRow = document.getElementById("licServerRow");
  const serverInput = document.getElementById("licServerInput");
  const serverSave = document.getElementById("licServerSave");

  if (!overlay) {
    console.error("[LicenseGate] Khong tim thay #licenseOverlay");
    return;
  }

  // ===== Trang thai =====
  let unlocked = false;
  let checking = false;

  // ===== Hien / an overlay =====
  function showOverlay() {
    overlay.classList.add("license-locked");
    overlay.style.display = "flex";
    document.body.style.overflow = "hidden";
  }

  function hideOverlay() {
    unlocked = true;
    overlay.classList.remove("license-locked");
    overlay.style.display = "none";
    document.body.style.overflow = "";
  }

  // ===== Thong bao =====
  function showMsg(text, type) {
    if (!keyMsg) return;
    keyMsg.className = "lic-msg lic-msg-" + (type || "err");
    keyMsg.textContent = text;
  }

  function hideMsg() {
    if (!keyMsg) return;
    keyMsg.className = "lic-msg";
    keyMsg.textContent = "";
  }

  // ===== Chan nguoi dung bo qua overlay =====
  function installGuards() {
    // Chan click chuot phai vao overlay (khong chan cua overlay)
    document.addEventListener(
      "click",
      (e) => {
        if (!unlocked && overlay && !overlay.contains(e.target)) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );

    // Chan phim tat (Esc) va DevTools
    document.addEventListener(
      "keydown",
      (e) => {
        if (unlocked) return;
        if (
          e.key === "Escape" ||
          e.key === "F12" ||
          (e.ctrlKey && e.shiftKey && (e.key === "I" || e.key === "J")) ||
          (e.ctrlKey && e.key === "U")
        ) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );

    // Chan chuot phai
    document.addEventListener(
      "contextmenu",
      (e) => {
        if (!unlocked) e.preventDefault();
      },
      true,
    );
  }

  // ===== Hien ma may =====
  async function renderDeviceId() {
    try {
      const id = await Core.getDeviceId();
      if (deviceEl) deviceEl.textContent = id;
    } catch (e) {
      if (deviceEl) deviceEl.textContent = "Khong doc duoc";
    }
  }

  // ===== Luu dia chi server =====
  async function saveServerUrl() {
    const url = (serverInput && serverInput.value ? serverInput.value : "").trim();
    if (!url) {
      showMsg("Nhap dia chi license server", "err");
      return;
    }
    await Core.setServerUrl(url);
    if (serverInput) serverInput.value = url;
    showMsg("Da luu dia chi server. Thu kich hoat lai.", "info");
    setTimeout(() => checkLicense(), 300);
  }

  // ===== Bam KICH HOAT =====
  async function doActivate() {
    if (!activateBtn || !keyInput) return;
    const key = keyInput.value.trim();
    if (!key) {
      showMsg("Vui long nhap key ban quyen", "err");
      return;
    }

    activateBtn.disabled = true;
    activateBtn.textContent = "DANG KICH HOAT...";
    hideMsg();

    const result = await Core.activate(key);

    activateBtn.disabled = false;
    activateBtn.textContent = "KICH HOAT NGAY";

    if (result.ok) {
      showMsg("Kich hoat thanh cong! Dang mo tool...", "ok");
      setTimeout(() => {
        hideOverlay();
        window.location.reload();
      }, 900);
      return;
    }

    // Loi: neu la loi mang -> hien o nhap dia chi server
    if (result.code === "offline") {
      if (serverRow) serverRow.classList.add("show");
      showMsg(result.message || "Khong ket noi duoc server", "err");
      return;
    }

    showMsg(result.message || "Key khong hop le", "err");
  }

  // ===== Kiem tra license =====
  async function checkLicense() {
    if (checking) return;
    checking = true;
    try {
      const res = await Core.check();

      if (res.allowed) {
        hideOverlay();
        __licenseBadgeUpdate(res.state, res.license ? res.license.expiresAt : 0);
        return;
      }

      // Chua hop le -> hien overlay
      showOverlay();

      // Thong bao ly do
      if (res.state === "expired") {
        showMsg("Key da het han. Vui long nhap key moi.", "err");
      } else if (res.state === "revoked") {
        showMsg("Key da bi thu hoi. Vui long lien he admin.", "err");
      } else if (res.state === "tampered") {
        showMsg(
          "Du lieu license bi thay doi khong hop le. Vui long nhap lai key.",
          "err",
        );
      } else if (res.state === "none") {
        showMsg("Ban chua kich hoat extension. Nhap key de tiep tuc.", "info");
      } else {
        showMsg(res.message || "License khong hop le", "err");
      }

      // Neu chua co dia chi server -> hien o nhap
      const serverUrl = await Core.getServerUrl();
      if (!serverUrl) {
        if (serverRow) serverRow.classList.add("show");
      } else if (serverInput) {
        serverInput.value = serverUrl;
      }
    } catch (e) {
      console.error("[LicenseGate] Loi kiem tra license:", e);
      showOverlay();
      showMsg("Loi kiem tra license: " + (e && e.message), "err");
    } finally {
      checking = false;
    }
  }


  // ===== Badge trang thai license (goc tren phai) =====
  function __licenseBadge() {
    var el = document.getElementById("licenseBadge");
    if (!el) {
      el = document.createElement("div");
      el.id = "licenseBadge";
      el.style.cssText =
        "position:fixed;bottom:14px;right:14px;z-index:999998;display:none;" +
        "align-items:center;gap:8px;background:#fff;border:1px solid #dddfe2;" +
        "border-radius:20px;padding:6px 8px 6px 12px;box-shadow:0 2px 10px rgba(0,0,0,.15);" +
        "font-family:inherit;font-size:12px;color:#374151;";
      var dot = document.createElement("span");
      dot.style.cssText =
        "width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block;";
      var txt = document.createElement("span");
      txt.id = "licenseBadgeText";
      txt.style.cssText = "font-weight:600;";
      var btn = document.createElement("button");
      btn.id = "licenseBadgeBtn";
      btn.textContent = "Quan tri key";
      btn.style.cssText =
        "border:1px solid #ccd0d5;background:#f7f8fa;border-radius:14px;" +
        "padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;color:#374151;font-family:inherit;";
      btn.addEventListener("click", function () {
        openManageDialog();
      });
      el.appendChild(dot);
      el.appendChild(txt);
      el.appendChild(btn);
      document.body.appendChild(el);
    }
    return el;
  }

  function __licenseBadgeUpdate(state, expiresAt) {
    var el = __licenseBadge();
    var dot = el.querySelector("span");
    var txt = document.getElementById("licenseBadgeText");
    var colors = { valid: "#22c55e", expired: "#ef4444", revoked: "#ef4444", tampered: "#ef4444", none: "#a0aec0" };
    dot.style.background = colors[state] || "#a0aec0";
    if (state === "valid" && expiresAt) {
      var days = Math.ceil((expiresAt - Date.now()) / 86400000);
      txt.textContent = days > 0 ? "License: con " + days + " ngay" : "License: het han";
    } else if (state === "valid") {
      txt.textContent = "License: viet han";
    } else if (state === "expired") {
      txt.textContent = "License: het han";
    } else if (state === "revoked") {
      txt.textContent = "License: da thu hoi";
    } else if (state === "tampered") {
      txt.textContent = "License: khong hop le";
    } else {
      txt.textContent = "Chua kich hoat";
    }
    el.style.display = "flex";
  }

  // ===== Hop thoai quan tri key (doi key / xem han / xem ma may) =====
  function openManageDialog() {
    var old = document.getElementById("licenseManageBox");
    if (old) old.remove();

    var box = document.createElement("div");
    box.id = "licenseManageBox";
    box.style.cssText =
      "position:fixed;inset:0;z-index:999999;background:rgba(15,23,42,.6);" +
      "display:flex;align-items:center;justify-content:center;padding:20px;";

    var inner = document.createElement("div");
    inner.style.cssText =
      "background:#fff;border-radius:12px;padding:24px;width:440px;max-width:100%;" +
      "box-shadow:0 20px 60px rgba(0,0,0,.4);border:1px solid #dddfe2;";

    var html = "";
    html += '<h2 style="color:#059669;margin:0 0 4px;font-size:18px;text-align:center">Quan tri key ban quyen</h2>';
    html += '<div style="background:#f7f8fa;border:1px dashed #ccd0d5;border-radius:8px;padding:10px 12px;margin-bottom:14px">';
    html += '<span style="display:block;color:#606770;font-size:12px;margin-bottom:4px">Ma may cua ban:</span>';
    html += '<code id="licManageDevice" style="font-family:Consolas,monospace;color:#b7791f;font-weight:700;font-size:13px;word-break:break-all">-</code>';
    html += "</div>";
    html += '<label for="licManageKey" style="display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:5px">Nhap key moi de doi (de trong neu chi xem)</label>';
    html += '<input type="text" id="licManageKey" placeholder="TL_XXXX-XXXX-XXXX-XXXX" style="width:100%;padding:11px 12px;border:1px solid #ccd0d5;border-radius:8px;font-size:15px;font-family:Consolas,monospace;text-align:center;letter-spacing:1px;box-sizing:border-box" />';
    html += '<p id="licManageMsg" style="font-size:13px;margin-top:12px;display:none;text-align:center;font-weight:600;padding:9px 11px;border-radius:7px"></p>';
    html += '<button id="licManageActivate" style="width:100%;padding:12px;font-size:15px;font-weight:700;border:none;border-radius:8px;background:#059669;color:#fff;cursor:pointer;margin-top:14px;font-family:inherit">KICH HOAT KEY MOI</button>';
    html += '<button id="licManageClose" style="width:100%;padding:10px;margin-top:9px;font-size:13px;border:1px solid #ccd0d5;border-radius:8px;background:#fff;color:#606770;cursor:pointer;font-family:inherit">DONG</button>';
    inner.innerHTML = html;
    box.appendChild(inner);
    document.body.appendChild(box);

    Core.getDeviceId().then(function (id) {
      var d = document.getElementById("licManageDevice");
      if (d) d.textContent = id;
    });

    document.getElementById("licManageClose").addEventListener("click", function () {
      box.remove();
    });
    box.addEventListener("click", function (e) {
      if (e.target === box) box.remove();
    });

    document.getElementById("licManageActivate").addEventListener("click", async function () {
      var input = document.getElementById("licManageKey");
      var msg = document.getElementById("licManageMsg");
      var key = input.value.trim();
      if (!key) {
        msg.style.display = "block";
        msg.style.background = "#fef2f2";
        msg.style.color = "#991b1b";
        msg.textContent = "Nhap key moi truoc khi kich hoat";
        return;
      }
      var btn = document.getElementById("licManageActivate");
      btn.disabled = true;
      btn.textContent = "DANG KICH HOAT...";
      var r = await Core.activate(key);
      btn.disabled = false;
      btn.textContent = "KICH HOAT KEY MOI";
      if (r.ok) {
        msg.style.display = "block";
        msg.style.background = "#f0fdf4";
        msg.style.color = "#166534";
        msg.textContent = "Kich hoat thanh cong!";
        setTimeout(function () {
          box.remove();
          window.location.reload();
        }, 900);
      } else {
        msg.style.display = "block";
        msg.style.background = "#fef2f2";
        msg.style.color = "#991b1b";
        msg.textContent = r.message || "Key khong hop le";
      }
    });
  }

  // ===== Khoi tao =====
  function init() {
    installGuards();

    if (activateBtn) activateBtn.addEventListener("click", doActivate);
    if (serverSave) serverSave.addEventListener("click", saveServerUrl);
    if (keyInput) {
      keyInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doActivate();
      });
    }

    renderDeviceId();
    checkLicense();
    __licenseBadge();

    // Xuat API cho code khac dung
    window.LicenseGate = {
      check: checkLicense,
      recheck: checkLicense,
      isUnlocked: () => unlocked,
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
