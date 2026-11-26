// ==========================================
// KHỐI BẢO MẬT LỚP 2: KHÓA ID & CHỐNG F12 (DEVTOOLS)
// ==========================================

// 1. KHÓA CHẾT ID EXTENSION (Lấy từ manifest.json đã đóng gói)
// const MY_EXTENSION_ID = "iabhpambdbhllaipnadmepceiagjlehk";

// if (
//   typeof chrome !== "undefined" &&
//   chrome.runtime &&
//   chrome.runtime.id !== MY_EXTENSION_ID
// ) {
//   window.fetch = function () {
//     return Promise.reject("Bản quyền không hợp lệ!");
//   };
//   alert("🚨 PHÁT HIỆN SAO CHÉP CODE 🚨\nSai ID Extension! Tool sẽ tự hủy.");
//   window.onload = function () {
//     document.body.innerHTML =
//       "<div style='display:flex; height:100vh; width:100vw; background:#f0f2f5; color:#c92a2a; justify-content:center; align-items:center; font-family:monospace; font-size:25px; font-weight:bold; text-align:center;'>🚨 PHÁT HIỆN SAO CHÉP CODE 🚨<br><br>VUI LÒNG MUA BẢN QUYỀN ĐỂ SỬ DỤNG TOOL!</div>";
//   };
//   throw new Error("Unauthorized execution environment.");
// }

// 2. VÒNG LẶP TỬ THẦN (CHỐNG SOI CODE BẰNG F12)
// (function() {
//     var antiDebug = function() {
//         var time = new Date();
//         debugger;
//         if (new Date() - time > 10) { window.location.reload(); }
//     };
//     setInterval(antiDebug, 50);
// })();

// ==========================================
// KẾT THÚC KHỐI BẢO MẬT - BÊN DƯỚI LÀ CODE CHÍNH CỦA TOOL
// ==========================================

var SERVER_URL =
  "https://script.google.com/macros/s/AKfycbyQiV9OcREesbPYs0n97vVG2ur6mQD43LHzeoCaUobuWGIz_UbY6ifxjeRkkvE5mmuP/exec";
var GEMINI_API_KEY = "AIzaSyDQ6MFJRS0Z8W2aa_NsY4AftY1Qd2qE9kY";

// ================================================================
// 🎨 UI HELPERS - Panel cấu hình tài khoản (thiết kế mới)
// ================================================================
window.setBtnLabel = function (btn, text, emo) {
  if (!btn) return;
  btn.innerHTML = emo
    ? `<span class="emo">${emo}</span> ${text}`
    : `<span class="emo">${text}</span>`;
};

window.updateTokenChip = function (state, text) {
  const chip = document.getElementById("ccTokenChip");
  if (!chip) return;
  chip.classList.remove("ok", "warn");
  if (state === "ok") chip.classList.add("ok");
  else if (state === "warn") chip.classList.add("warn");
  chip.innerHTML = `<span class="dot"></span> ${text}`;
};

window.getHieuQuaCount = function (insights, optimization_goal) {
  if (!insights || !insights.actions) return 0;

  // 1. Ưu tiên tìm tin nhắn
  const messAction = insights.actions.find((a) =>
    a.action_type.includes("messaging_conversation_started"),
  );
  if (messAction) return parseInt(messAction.value);

  // 2. Nếu không có tin nhắn và mục tiêu là Click thì lấy click
  if (optimization_goal === "LINK_CLICKS") {
    const linkAction = insights.actions.find(
      (a) => a.action_type === "link_click",
    );
    return linkAction ? parseInt(linkAction.value) : 0;
  }

  return 0;
};

// ================================================================
// 🎯 Hàm đếm cuộc hội thoại từ inbox theo tag [N1], [N2]...
// NGUỒN ĐẾM DUY NHẤT: nội dung tin nhắn + tên quảng cáo đính kèm
// (ad_title trong referral của messages)
// Tag được đặt trong tên nhóm QC & nội dung bài viết QC VD: [N1]
// ================================================================
window.countInboxConversationsByTag = async function (adsetName) {
  try {
    if (!adsetName || typeof adsetName !== "string") return null;

    // Trích xuất tag từ tên nhóm QC VD: "[N1]" -> "N1"
    const tagMatch = adsetName.match(/\[([A-Za-z0-9_\-]+)\]/i);
    if (!tagMatch) return null; // Không có tag, trả về null để dùng CPR mặc định
    const tag = tagMatch[1].trim().toUpperCase();
    const tagBracket = `[${tag}]`;
    console.log(`🔍 Đang tìm tag [${tag}] trong inbox cho nhóm: ${adsetName}`);

    // Lấy dữ liệu cache inbox từ background.js (poll mỗi 1 phút)
    const cached = await new Promise((resolve) => {
      chrome.storage.local.get(["inboxBgCache"], (result) =>
        resolve(result || {}),
      );
    });

    const inboxList = Array.isArray(cached.inboxBgCache)
      ? cached.inboxBgCache
      : [];

    if (inboxList.length === 0) {
      console.log("⚠️ Chưa có cache inbox");
      return null;
    }

    // Đếm cuộc hội thoại có chứa tag
    let count = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Đầu ngày hôm nay
    const countedConvIds = new Set();

    // 1. Duyệt qua danh sách inbox conversations
    for (const conv of inboxList) {
      if (!conv || !conv.id) continue;
      const convId = String(conv.id);

      // Chỉ tính hội thoại có TIN NHẮN CHỨA TAG được gửi HÔM NAY
      // (không tính hội thoại hôm qua được khách nhắn lại hôm nay)
      let hasTag = false;
      const messages = conv.messages?.data || [];
      for (const msg of messages) {
        const msgText = (msg.message || "").toUpperCase();
        const adTitle = (
          msg.referral?.ads_context_data?.ad_title || ""
        ).toUpperCase();
        if (
          msgText.includes(tagBracket.toUpperCase()) ||
          adTitle.includes(tagBracket.toUpperCase())
        ) {
          // Điều kiện: tin nhắn mang tag phải nằm trong ngày hôm nay
          const msgTime = msg.created_time ? new Date(msg.created_time) : null;
          if (msgTime && msgTime >= today) {
            hasTag = true;
            break;
          }
        }
      }

      if (hasTag && !countedConvIds.has(convId)) {
        countedConvIds.add(convId);
        count++;
        console.log(`  ✅ Hội thoại ${convId} khớp tag [${tag}]`);
      }
    }

    console.log(`📊 Đếm CPL: Tag [${tag}] = ${count} hội thoại hôm nay`);
    return count;
  } catch (e) {
    console.warn("Lỗi đếm inbox conversations:", e);
    return null;
  }
};

// 🎯 Lắng nghe đồng bộ Tag từ Content Script Meta Suite theo thời gian thực
if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.type === "SYNC_CONV_ADSET_TAG") {
      console.log(
        `⚡ [Dashboard] Nhận tag [${request.tag}] từ Meta Suite cho hội thoại ${request.conversationId}`,
      );
      if (window.inboxState?.conversations) {
        const conv = window.inboxState.conversations.find(
          (c) =>
            String(c.id) === String(request.conversationId) ||
            String(c.id).replace(/^t_/, "") === String(request.conversationId),
        );
        if (conv) {
          conv.__adsetTag = request.tag;
          if (typeof window.inboxRenderConversationList === "function") {
            window.inboxRenderConversationList();
          }
        }
      }

      // 🚀 Kích hoạt nâng ngưỡng & cập nhật CPL tức thì cho nhóm quảng cáo khớp Tag [N1], [N2]...
      if (typeof window.checkAndRaiseThresholdForTag === "function") {
        window.checkAndRaiseThresholdForTag(request.tag);
      }
    }
  });
}

// 🎯 Hàm kiểm tra và nâng ngưỡng chi tiêu ngay lập tức khi phát hiện cuộc hội thoại khớp Tag
window.checkAndRaiseThresholdForTag = async function (tag) {
  try {
    if (!tag) return;
    const tagUpper = tag.trim().toUpperCase();
    const tagBracket = `[${tagUpper}]`;
    const useCpl =
      document.getElementById("apUseCpl")?.checked ||
      window.autoPauseConfig?.useCpl ||
      false;
    const useCpc =
      document.getElementById("apUseCpc")?.checked ||
      window.autoPauseConfig?.useCpc ||
      false;
    const useCpcCombo =
      document.getElementById("apUseCpcCombo")?.checked ||
      window.autoPauseConfig?.useCpcCombo ||
      false;

    console.log(
      `⚡ [Realtime CPL] Kiểm tra nâng ngưỡng cho Tag ${tagBracket}...`,
    );

    // 1. Cập nhật các ô hiển thị CPL trên bảng giao diện
    const allCplCells = document.querySelectorAll("[data-cpl], [data-cpl-row]");
    for (const cell of allCplCells) {
      const row = cell.closest("tr");
      if (!row) continue;
      const adsetName = row.querySelector("td:nth-child(4)")?.innerText || "";
      if (adsetName.toUpperCase().includes(tagBracket)) {
        const adsetId =
          cell.getAttribute("data-cpl") || cell.getAttribute("data-cpl-row");
        const count = await window.countInboxConversationsByTag(adsetName);
        if (count !== null) {
          const spendText =
            row.querySelector("td:nth-child(5), td:nth-child(8)")?.innerText ||
            "0";
          const spendVal = parseFloat(spendText.replace(/[^\d]/g, "")) || 0;
          const cpl =
            count > 0 && spendVal > 0 ? Math.round(spendVal / count) : 0;
          cell.innerHTML = `<span style="font-weight:bold; font-family:monospace; color:#31a24c;">${cpl.toLocaleString("vi-VN")} đ</span><br><small style="color:#31a24c;">(${count} HT)</small>`;
        }
      }
    }

    // 2. Nếu đang bật CPL (hoặc chế độ Kết hợp CPC), tự động kiểm tra nâng ngưỡng MaxSpend
    if (!useCpl && !useCpcCombo) return;

    // (G) Đồng bộ mốc đếm KQ & ngưỡng từ nguồn duy nhất (CampCore/storage)
    if (window.CampCore) {
      try {
        const prevMap = await window.CampCore.getPrevMap();
        window.prevHieuQua = { ...(window.prevHieuQua || {}), ...prevMap };
        window.localConfigs = await window.CampCore.getConfigs();
      } catch (e) {
        /* bỏ qua */
      }
    }
    if (!window.prevHieuQua) window.prevHieuQua = {};
    if (!window.localConfigs) {
      window.localConfigs = JSON.parse(
        localStorage.getItem("fb_local_configs") || "{}",
      );
    }

    const globalMaxSpend =
      parseFloat(document.getElementById("apMaxSpend")?.value) || 15000;
    const globalMaxPrice =
      parseFloat(document.getElementById("apMaxPrice")?.value) || 12000;
    const globalMaxCpm =
      parseFloat(document.getElementById("apMaxCpm")?.value) || 40000;

    // Tìm tất cả các dòng nhóm QC trên bảng đang có tag này
    const rows = document.querySelectorAll(
      "#resultTableBody tr, #apTableBody tr",
    );
    for (const row of rows) {
      const nameEl = row.querySelector("td:nth-child(4)");
      if (!nameEl) continue;
      const adsetName = nameEl.innerText || "";
      if (!adsetName.toUpperCase().includes(tagBracket)) continue;

      const saveBtn = row.querySelector(".btn-save-local");
      const adsetId = saveBtn ? saveBtn.getAttribute("data-id") : null;
      if (!adsetId) continue;

      const inboxCount = await window.countInboxConversationsByTag(adsetName);
      if (inboxCount === null) continue;

      // Dùng hàm nâng ngưỡng dùng chung (nguồn: localStorage["fb_local_configs"])
      const raiseRes = await window.raiseThresholdForAdset(
        adsetId,
        inboxCount,
        {
          maxSpend: globalMaxSpend,
          maxPrice: globalMaxPrice,
          maxCpm: globalMaxCpm,
          maxCpc: window.getGlobalMaxCpc ? window.getGlobalMaxCpc() : 800,
        },
      );

      if (raiseRes.raised) {
        const diff = raiseRes.diff;
        const newMaxSpend = raiseRes.newMaxSpend;

        // Cập nhật giá trị ô input
        const spendInp = row.querySelector(".local-spend");
        if (spendInp) spendInp.value = newMaxSpend;

        // Đồng bộ bảng "Tắt Camp Tự Động" (dùng chung localConfigs)
        if (typeof window.careCampRefreshThresholds === "function") {
          window.careCampRefreshThresholds();
        }

        console.log(
          `🚀 [REALTIME CPL] Nâng ngưỡng nhóm ${adsetName}: ${raiseRes.currentMaxSpend}đ -> ${newMaxSpend}đ (+${diff} HT)`,
        );

        if (typeof sendTelegramAlert === "function") {
          sendTelegramAlert(
            `🚀 <b>NÂNG NGƯỠNG TỰ ĐỘNG (CPL - INBOX)</b> 🚀\n- Nhóm: ${adsetName}\n- Hội thoại mới: ${inboxCount} (+${diff})\n- Ngưỡng tiêu cũ: ${raiseRes.currentMaxSpend.toLocaleString("vi-VN")}đ\n- Ngưỡng tiêu MỚI: <b>${newMaxSpend.toLocaleString("vi-VN")}đ</b>`,
          );
        }
      }
    }
  } catch (e) {
    console.warn("Lỗi checkAndRaiseThresholdForTag:", e);
  }
};

function formatMoney(value, isCents = true) {
  if (value === undefined || value === null || isNaN(value)) return "0";
  let num = parseFloat(value);
  if (isCents) num = num / 100;
  return new Intl.NumberFormat("vi-VN").format(Math.round(num));
}

window.fetchAccountCampaigns = async function (accountId, accountName) {
  const token = document.getElementById("tokenInput").value;
  if (!token) return alert("⚠️ Vui lòng Lấy Token ở Trang Bảng Chỉ Số trước!");

  const datePreset = document.getElementById("campaignDatePreset").value;
  document.getElementById("campaignModal").style.display = "flex";
  document.getElementById("campaignModalTitle").innerText =
    `CHIẾN DỊCH: ${accountName} (Đang tải...)`;
  document.getElementById("campaignTableBody").innerHTML =
    `<tr><td colspan="13" style="text-align:center; padding:20px; color:#1877f2; font-weight:bold;">Đang lấy dữ liệu chiến dịch...</td></tr>`;

  const fields = `id,name,status,daily_budget,lifetime_budget,insights.date_preset(${datePreset}){reach,frequency,spend,impressions,cpm,inline_link_clicks,clicks,cpc,ctr,actions,cost_per_action_type}`;
  const url = `https://graph.facebook.com/v20.0/act_${accountId}/campaigns?fields=${fields}&limit=100&access_token=${token}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      document.getElementById("campaignTableBody").innerHTML =
        `<tr><td colspan="13" style="color:#c92a2a; text-align:center; font-weight:bold;">Lỗi: ${data.error.message}</td></tr>`;
      return;
    }
    window.renderCampaignTable(data.data, accountName);
  } catch (error) {
    document.getElementById("campaignTableBody").innerHTML =
      `<tr><td colspan="13" style="color:#c92a2a; text-align:center; font-weight:bold;">Lỗi kết nối mạng!</td></tr>`;
  }
};
window.localConfigs = JSON.parse(
  localStorage.getItem("fb_local_configs") || "{}",
);
// (G) Nếu localStorage rỗng → lấy ngưỡng do background nâng từ storage
try {
  if (
    !Object.keys(window.localConfigs || {}).length &&
    typeof chrome !== "undefined" &&
    chrome.storage?.local
  ) {
    chrome.storage.local.get("fb_local_configs", (res) => {
      const stored = res?.fb_local_configs;
      if (stored && typeof stored === "object" && Object.keys(stored).length) {
        window.localConfigs = { ...window.localConfigs, ...stored };
        try {
          localStorage.setItem(
            "fb_local_configs",
            JSON.stringify(window.localConfigs),
          );
        } catch (e) {
          /* bỏ qua */
        }
      }
    });
  }
} catch (e) {
  /* bỏ qua */
}

/* =========================================================================
 * 🧩 HELPER DÙNG CHUNG — trạng thái 3 chế độ chỉ số + ngưỡng CPC riêng
 * -------------------------------------------------------------------------
 * - useCpl      : dùng CPL (hội thoại inbox) làm chỉ số giá chính
 * - useCpc      : dùng CPC (click link) làm chỉ số giá chính (loại trừ với combo)
 * - useCpcCombo : "Kết hợp CPC" — CPC là điều kiện RIÊNG (ngưỡng maxCpc),
 *                 cần đủ 4 điều kiện mới tắt camp.
 * ========================================================================= */
window.getModeFlags = function () {
  const read = (id) => document.getElementById(id)?.checked === true;
  const useCpl =
    read("apUseCpl") || window.autoPauseConfig?.useCpl === true;
  const useCpc =
    read("apUseCpc") || window.autoPauseConfig?.useCpc === true;
  const useCpcCombo =
    read("apUseCpcCombo") || window.autoPauseConfig?.useCpcCombo === true;
  return { useCpl, useCpc, useCpcCombo };
};

/** Đọc ngưỡng CPC toàn cục (ô apMaxCpc / ccMaxCpc) */
window.getGlobalMaxCpc = function (fallback = 800) {
  const ap = parseFloat(document.getElementById("apMaxCpc")?.value);
  if (Number.isFinite(ap)) return ap;
  const cc = parseFloat(document.getElementById("ccMaxCpc")?.value);
  if (Number.isFinite(cc)) return cc;
  try {
    const saved = localStorage.getItem("fb_apMaxCpcLimit");
    const v = parseFloat(saved);
    if (Number.isFinite(v)) return v;
  } catch (e) {
    /* bỏ qua */
  }
  return fallback;
};

/* =========================================================================
 * 🚀 HÀM NÂNG NGƯỠNG DÙNG CHUNG — nguồn cấu hình duy nhất
 * -------------------------------------------------------------------------
 * localStorage["fb_local_configs"] là nguồn sự thật duy nhất cho ngưỡng
 * tiền / giá / CPM của từng nhóm QC. Cả 3 bảng dùng chung:
 *   1. Bảng Chỉ Số          (#resultTableBody)
 *   2. Bảng Auto-Pause      (#apTableBody)
 *   3. Bảng Tắt Camp        (#ccTableBody)  ← care_camp.js
 *
 * window.prevHieuQua là cache đếm KQ dùng chung → mỗi lần KQ tăng chỉ bị
 * nâng ngưỡng ĐÚNG 1 LẦN, không nhân đôi khi cả 2 bảng cùng quét.
 * ========================================================================= */

/* =========================================================================
 * 💾 ĐỒNG BỘ NGƯỠNG — localStorage (UI) + chrome.storage.local (background)
 * -------------------------------------------------------------------------
 * localStorage: để các bảng trong dashboard/care_camp đọc nhanh.
 * chrome.storage.local["fb_local_configs"]: nguồn chuẩn để Service Worker
 *   (camp_core.js) áp ngưỡng khi quét nền — SW KHÔNG có localStorage.
 * ========================================================================= */
window.persistLocalConfigs = function persistLocalConfigs() {
  const cfg = window.localConfigs || {};
  try {
    localStorage.setItem("fb_local_configs", JSON.stringify(cfg));
  } catch (e) {
    console.warn("[camp] không lưu được localStorage:", e);
  }
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({ fb_local_configs: cfg });
    }
  } catch (e) {
    console.warn("[camp] không lưu được chrome.storage.local:", e);
  }
};

window.raiseThresholdForAdset = async function (
  adsetId,
  effectiveCount,
  opts = {},
) {
  const id = String(adsetId);
  if (!window.prevHieuQua) window.prevHieuQua = {};

  const globalMaxSpend = Number(opts.maxSpend) || 10000;
  const globalMaxPrice = Number(opts.maxPrice) || 12000;
  const globalMaxCpm = Number(opts.maxCpm) || 40000;
  const globalMaxCpc = Number(opts.maxCpc) || 800;

  const cur = Number(effectiveCount) || 0;

  // ⚠️ (G) ƯU TIÊN CampCore — NGUỒN NÂNG NGƯỠNG DUY NHẤT.
  //    Mốc so sánh (prev) nằm trong chrome.storage.local["camp_core_prev"]
  //    do background (camp_core.js) quản lý → mỗi lần KQ tăng chỉ nâng ngưỡng
  //    ĐÚNG 1 LẦN, không nhân đôi khi cả bảng 📊 và ✂️ cùng chạy.
  if (window.CampCore?.raiseThresholdForAdset) {
    // (G) NGUỒN NÂNG NGƯỠNG DUY NHẤT: CampCore (dùng chung cả background
    //     và UI). Mốc so sánh nằm trong chrome.storage.local["camp_core_prev"]
    //     → mỗi lần KQ tăng chỉ nâng ngưỡng ĐÚNG 1 LẦN.
    const res = await window.CampCore.raiseThresholdForAdset(id, cur, opts);
    if (res?.raised) {
      window.localConfigs = await window.CampCore.getConfigs();
      window.lastRaiseResult = res;
      if (typeof window.careCampRefreshThresholds === "function") {
        window.careCampRefreshThresholds();
      }
    }
    // Ghi mốc cục bộ (để lần gọi kế tiếp không nâng trùng)
    window.prevHieuQua[id] = cur;
    return {
      raised: !!res?.raised,
      diff: res?.diff || 0,
      currentMaxSpend: res?.currentMaxSpend || 0,
      newMaxSpend: res?.newMaxSpend || 0,
      currentMaxPrice: res?.currentMaxPrice ?? globalMaxPrice,
      currentMaxCpm: res?.currentMaxCpm ?? globalMaxCpm,
      currentMaxCpc: res?.currentMaxCpc ?? globalMaxCpc,
    };
  }

  // ---- Fallback (không có CampCore) — logic cũ, mốc nằm trong memory ----
  const prev = window.prevHieuQua[id];

  // (G) Chưa có mốc so sánh → coi mốc cũ = 0 (khớp với camp_core.js)
  //     Nhóm đã có KQ ngay từ lần quét đầu tiên vẫn được nâng ngưỡng.
  const hasPrev = prev !== undefined;
  const prevCount = hasPrev ? Number(prev) || 0 : 0;

  // KQ không tăng (và đã có mốc) → không nâng
  if (hasPrev && cur <= prevCount) {
    window.prevHieuQua[id] = cur;
    return { raised: false, diff: 0, currentMaxSpend: 0, newMaxSpend: 0 };
  }

  const diff = cur - prevCount;

  // diff <= 0 → không có gì để nâng (VD nhóm mới, chưa có KQ nào)
  if (diff <= 0) {
    window.prevHieuQua[id] = cur;
    return { raised: false, diff: 0, currentMaxSpend: 0, newMaxSpend: 0 };
  }

  if (!window.localConfigs) window.localConfigs = {};
  const local = window.localConfigs[id] || {};

  const currentMaxSpend = parseFloat(local.maxSpend) || globalMaxSpend;
  const currentMaxPrice =
    parseFloat(local.maxPrice ?? local.maxCpr) || globalMaxPrice;
  const currentMaxCpm = parseFloat(local.maxCpm) || globalMaxCpm;
  const currentMaxCpc = parseFloat(local.maxCpc) || globalMaxCpc;

  // maxSpend mới = ngưỡng cũ + (ngưỡng giá × số KQ tăng thêm)
  const newMaxSpend = currentMaxSpend + currentMaxPrice * diff;

  window.localConfigs[id] = {
    ...local,
    maxSpend: newMaxSpend,
    maxPrice: currentMaxPrice,
    maxCpm: currentMaxCpm,
    maxCpc: currentMaxCpc,
    originalMaxSpend: local.originalMaxSpend || globalMaxSpend,
    originalMaxPrice: local.originalMaxPrice || globalMaxPrice,
    originalMaxCpm: local.originalMaxCpm || globalMaxCpm,
    originalMaxCpc: local.originalMaxCpc || globalMaxCpc,
  };

  // Lưu xuống localStorage để không mất khi F5
  try {
    window.persistLocalConfigs();
  } catch (e) {
    console.warn("Không lưu được fb_local_configs:", e);
  }

  // Cập nhật mốc so sánh
  window.prevHieuQua[id] = cur;

  return {
    raised: true,
    diff,
    currentMaxSpend,
    newMaxSpend,
    currentMaxPrice,
    currentMaxCpm,
    currentMaxCpc,
  };
};

window.saveLocalConfig = function (adsetId, btn) {
  const row = btn.closest("tr");

  const maxSpend = parseFloat(row.querySelector(".local-spend").value) || 0;
  const maxPrice = parseFloat(row.querySelector(".local-price").value) || 0;
  const maxCpm = parseFloat(row.querySelector(".local-cpm").value) || 0;
  // Ô CPC (chế độ "Kết hợp CPC") — có thể không tồn tại nếu đang ẩn.
  // Nếu không có ô → giữ ngưỡng CPC đã lưu, nếu chưa có thì lấy ngưỡng chung
  // (tránh ghi 0 → sau này bật combo sẽ luôn coi là vượt ngưỡng).
  const cpcInput = row.querySelector(".local-cpc");
  const globalCpc =
    typeof window.getGlobalMaxCpc === "function"
      ? window.getGlobalMaxCpc()
      : 800;
  const maxCpc = cpcInput
    ? parseFloat(cpcInput.value) || 0
    : parseFloat(window.localConfigs[adsetId]?.maxCpc) || globalCpc;

  // Nếu chưa có config thì tạo mới
  if (!window.localConfigs[adsetId]) {
    // Lưu cả CURRENT + ORIGINAL
    window.localConfigs[adsetId] = {
      maxSpend,
      maxPrice,
      maxCpm,
      maxCpc,

      originalMaxSpend: maxSpend,
      originalMaxPrice: maxPrice,
      originalMaxCpm: maxCpm,
      originalMaxCpc: maxCpc,
    };
  } else {
    // Update config hiện tại
    window.localConfigs[adsetId].maxSpend = maxSpend;
    window.localConfigs[adsetId].maxPrice = maxPrice;
    window.localConfigs[adsetId].maxCpm = maxCpm;
    if (cpcInput) window.localConfigs[adsetId].maxCpc = maxCpc;

    // Nếu chưa có bản gốc thì tạo
    if (!window.localConfigs[adsetId].originalMaxSpend) {
      window.localConfigs[adsetId].originalMaxSpend = maxSpend;
      window.localConfigs[adsetId].originalMaxPrice = maxPrice;
      window.localConfigs[adsetId].originalMaxCpm = maxCpm;
    }
    if (!window.localConfigs[adsetId].originalMaxCpc) {
      window.localConfigs[adsetId].originalMaxCpc = maxCpc;
    }
  }

  window.persistLocalConfigs();

  // Đồng bộ bảng "Tắt Camp Tự Động" (dùng chung localConfigs)
  if (typeof window.careCampRefreshThresholds === "function") {
    window.careCampRefreshThresholds();
  }

  btn.innerText = "✅ Đã Lưu";
  btn.style.background = "#28a745";

  setTimeout(() => {
    btn.innerText = "Lưu";
    btn.style.background = "#1877f2";
  }, 2000);
};

window.resetLocalConfig = function (adsetId, btn) {
  const row = btn.closest("tr");

  // Lấy config hiện tại
  let config = window.localConfigs[adsetId];

  // Global mặc định
  const globalMaxSpend =
    parseFloat(document.getElementById("apMaxSpend")?.value) || 12000;
  const globalMaxPrice =
    parseFloat(document.getElementById("apMaxPrice")?.value) || 12000;
  const globalMaxCpm =
    parseFloat(document.getElementById("apMaxCpm")?.value) || 40000;
  const globalMaxCpc =
    parseFloat(document.getElementById("apMaxCpc")?.value) || 800;

  // Nếu chưa có config riêng -> dùng global
  if (!config) {
    config = {
      maxSpend: globalMaxSpend,
      maxPrice: globalMaxPrice,
      maxCpm: globalMaxCpm,
      maxCpc: globalMaxCpc,

      originalMaxSpend: globalMaxSpend,
      originalMaxPrice: globalMaxPrice,
      originalMaxCpm: globalMaxCpm,
      originalMaxCpc: globalMaxCpc,
    };

    window.localConfigs[adsetId] = config;
  }

  // Reset về giá trị gốc
  config.maxSpend = config.originalMaxSpend || globalMaxSpend;
  config.maxPrice = config.originalMaxPrice || globalMaxPrice;
  config.maxCpm = config.originalMaxCpm || globalMaxCpm;
  config.maxCpc = config.originalMaxCpc || globalMaxCpc;

  // Save localStorage
  window.persistLocalConfigs();
  9;

  // Update UI
  row.querySelector(".local-spend").value = config.maxSpend;
  row.querySelector(".local-price").value = config.maxPrice;
  row.querySelector(".local-cpm").value = config.maxCpm;
  const cpcInput = row.querySelector(".local-cpc");
  if (cpcInput) cpcInput.value = config.maxCpc;

  // Đồng bộ bảng "Tắt Camp Tự Động" (dùng chung localConfigs)
  if (typeof window.careCampRefreshThresholds === "function") {
    window.careCampRefreshThresholds();
  }

  // Hiệu ứng
  btn.innerText = "✅ Đã Reset";
  btn.style.background = "#fa383e";

  setTimeout(() => {
    btn.innerText = "Reset";
    btn.style.background = "#f56b2a";
  }, 2000);
};

window.renderCampaignTable = function (campaigns, accountName) {
  document.getElementById("campaignModalTitle").innerText =
    `CHIẾN DỊCH: ${accountName} (${campaigns.length} CD)`;
  let html = "";

  if (campaigns.length === 0) {
    document.getElementById("campaignTableBody").innerHTML =
      `<tr><td colspan="13" style="text-align:center; color:#606770;">Không có chiến dịch nào!</td></tr>`;
    return;
  }

  campaigns.forEach((camp) => {
    const insight =
      camp.insights && camp.insights.data && camp.insights.data.length > 0
        ? camp.insights.data[0]
        : null;

    const isChecked = camp.status === "ACTIVE" ? "checked" : "";
    const budget = camp.daily_budget
      ? `${formatMoney(camp.daily_budget, true)}đ/ngày`
      : camp.lifetime_budget
        ? `${formatMoney(camp.lifetime_budget, true)}đ/Trọn đời`
        : "-";

    const spend =
      insight && insight.spend ? formatMoney(insight.spend, false) + "đ" : "0đ";
    const reach =
      insight && insight.reach
        ? Number(insight.reach).toLocaleString("vi-VN")
        : "0";
    const impressions =
      insight && insight.impressions
        ? Number(insight.impressions).toLocaleString("vi-VN")
        : "0";
    const cpm =
      insight && insight.cpm ? formatMoney(insight.cpm, false) + "đ" : "-";
    const linkClicks =
      insight && insight.inline_link_clicks
        ? Number(insight.inline_link_clicks).toLocaleString("vi-VN")
        : "0";
    const clicks =
      insight && insight.clicks
        ? Number(insight.clicks).toLocaleString("vi-VN")
        : "0";
    const cpc =
      insight && insight.cpc ? formatMoney(insight.cpc, false) + "đ" : "-";
    const ctr =
      insight && insight.ctr
        ? parseFloat(insight.ctr).toFixed(2).replace(".", ",") + "%"
        : "-";

    let results = "0";
    let costPerResult = "-";
    if (insight && insight.actions) {
      const mainAction = insight.actions.find(
        (a) =>
          a.action_type.includes("messaging_conversation_started") ||
          a.action_type === "omni_purchase" ||
          a.action_type === "link_click",
      );
      if (mainAction) {
        results = Number(mainAction.value).toLocaleString("vi-VN");
        const costAction = insight.cost_per_action_type.find(
          (c) => c.action_type === mainAction.action_type,
        );
        if (costAction)
          costPerResult = formatMoney(costAction.value, false) + "đ";
      }
    }

    html += `
            <tr>
                <td>
                    <label class="switch">
                        <input type="checkbox" class="toggle-camp-status" data-id="${camp.id}" ${isChecked}>
                        <span class="slider"></span>
                    </label>
                </td>
                <td style="font-weight:bold; color:${camp.status === "ACTIVE" ? "#137333" : "#8c939d"};">${camp.name}</td>
                <td style="color:#4b4f56;">${budget}</td>
                <td style="color:#d97706; font-weight:bold;">${spend}</td>
                <td style="color:#137333; font-weight:bold; font-size:15px;">${results}</td>
                <td style="color:#c92a2a; font-family:monospace; font-weight:bold;">${costPerResult}</td>
                <td style="font-family:monospace; color:#1c1e21;">${reach}</td>
                <td style="font-family:monospace; color:#1c1e21;">${impressions}</td>
                <td style="font-family:monospace; color:#4b4f56;">${cpm}</td>
                <td style="color:#1877f2; font-family:monospace; font-weight:bold;">${linkClicks}</td>
                <td style="color:#606770; font-family:monospace;">${clicks}</td>
                <td style="font-family:monospace; color:#4b4f56;">${cpc}</td>
                <td style="color:#1877f2; font-family:monospace; font-weight:bold;">${ctr}</td>
            </tr>
        `;
  });

  document.getElementById("campaignTableBody").innerHTML = html;
};

window.toggleCampaign = async function (campaignId, checkboxElement) {
  const token = document.getElementById("tokenInput").value;
  const newStatus = checkboxElement.checked ? "ACTIVE" : "PAUSED";
  checkboxElement.disabled = true;

  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${campaignId}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `status=${newStatus}&access_token=${token}`,
    });
    const data = await res.json();

    if (data.success) {
      const nameTd = checkboxElement.closest("tr").querySelectorAll("td")[1];
      nameTd.style.color = newStatus === "ACTIVE" ? "#137333" : "#8c939d";
    } else {
      alert("Lỗi đổi trạng thái: " + (data.error?.message || "Chưa rõ lỗi"));
      checkboxElement.checked = !checkboxElement.checked;
    }
  } catch (e) {
    alert("Lỗi mạng!");
    checkboxElement.checked = !checkboxElement.checked;
  } finally {
    checkboxElement.disabled = false;
  }
};

function extractUidFromLink(input) {
  input = input.trim();
  if (!input) return null;
  if (/^\d+$/.test(input)) return input;
  const matchId = input.match(/id=(\d+)/);
  if (matchId) return matchId[1];
  const matchSlash = input.match(/facebook\.com\/([a-zA-Z0-9.]+)/);
  if (matchSlash) {
    const val = matchSlash[1];
    if (/^\d+$/.test(val)) return val;
  }
  return input;
}

document.addEventListener("DOMContentLoaded", async () => {
  document
    .getElementById("campaignTableBody")
    ?.addEventListener("change", (e) => {
      if (e.target.classList.contains("toggle-camp-status")) {
        window.toggleCampaign(e.target.getAttribute("data-id"), e.target);
      }
    });

  document
    .querySelectorAll(".close-modal, .close-modal-camp")
    .forEach((btn) => {
      btn.addEventListener("click", function () {
        const modal = this.closest(".modal-overlay");
        if (modal) modal.style.display = "none";
      });
    });

  window.addEventListener("click", (e) => {
    if (e.target.classList.contains("modal-overlay")) {
      e.target.style.display = "none";
    }
  });

  const pages = [
    "page-dashboard",
    "page-carecamp",
    "page-accounts",
    "page-bm",
    "page-env",
    "page-auto",
    "page-spy",
    "page-share",
    "page-inbox",
    "page-share-page",
    "page-autopause",
    "page-apicount",
  ];
  const navIds = [
    "nav-dashboard",
    "nav-carecamp",
    "nav-accounts",
    "nav-bm",
    "nav-env",
    "nav-auto",
    "nav-spy",
    "nav-share",
    "nav-inbox",
    "nav-share-page",
    "nav-autopause",
    "nav-apicount",
  ];

  navIds.forEach((navId, index) => {
    const navEl = document.getElementById(navId);
    if (navEl) {
      navEl.addEventListener("click", () => {
        navIds.forEach((id) =>
          document.getElementById(id)?.classList.remove("active-icon"),
        );
        navEl.classList.add("active-icon");
        pages.forEach((page) =>
          document.getElementById(page)?.classList.remove("active-page"),
        );
        document.getElementById(pages[index])?.classList.add("active-page");
        // 🔢 Mở tab Đếm API → làm mới số liệu ngay
        if (pages[index] === "page-apicount") {
          try {
            window.__apiCounterUi?.refresh?.();
          } catch (e) {
            // ignore
          }
        }
      });
    }
  });

  const openPausedBtn = document.getElementById("btn-open-paused");
  const closePausedBtn = document.getElementById("close-paused");
  const pausedPanel = document.getElementById("paused-panel");
  if (openPausedBtn && closePausedBtn && pausedPanel) {
    openPausedBtn.addEventListener("click", () => {
      pausedPanel.style.right = "70px";
    });
    closePausedBtn.addEventListener("click", () => {
      pausedPanel.style.right = "-500px";
    });
  }

  try {
    const bubble = document.getElementById("ai-bubble"),
      chatBox = document.getElementById("ai-chat-box");
    const chatContent = document.getElementById("chat-content"),
      closeChat = document.getElementById("close-chat");
    if (bubble && chatBox && chatContent) {
      bubble.onclick = () => {
        chatBox.style.display =
          chatBox.style.display === "none" ? "flex" : "none";
      };
      if (closeChat)
        closeChat.onclick = () => {
          chatBox.style.display = "none";
        };

      chrome.storage.local.get(["aiHistory"], (res) => {
        if (res.aiHistory && res.aiHistory.length > 0)
          res.aiHistory.forEach((msg) => renderMessage(msg.role, msg.text));
        else renderMessage("ai", "Chào sếp! Em đã sẵn sàng phân tích Camp. 🚀");
      });

      function renderMessage(role, text) {
        const div = document.createElement("div");
        div.style.padding = "8px 12px";
        div.style.borderRadius = "8px";
        div.style.maxWidth = "85%";
        div.style.wordWrap = "break-word";
        if (role === "user") {
          div.style.alignSelf = "flex-end";
          div.style.background = "#e4e6eb";
          div.style.color = "#1c1e21";
        } else {
          div.style.alignSelf = "flex-start";
          div.style.background = "#1877f2";
          div.style.color = "white";
        }
        div.innerText = text;
        chatContent.appendChild(div);
        chatContent.scrollTop = chatContent.scrollHeight;
      }

      const sendBtn = document.getElementById("send-chat");
      if (sendBtn) {
        sendBtn.onclick = async () => {
          const input = document.getElementById("chat-input"),
            text = input.value.trim();
          if (!text) return;
          renderMessage("user", text);
          input.value = "";
          let tableData = "";
          const rows = document.querySelectorAll("#resultTableBody tr");
          if (rows.length > 0) {
            tableData = "\n\nDữ liệu hiện tại:\n";
            rows.forEach((row) => {
              const cols = row.querySelectorAll("td");
              if (cols.length >= 14) {
                tableData += `- Camp: ${cols[2].innerText.trim()}, Nhóm: ${cols[3].innerText.trim()}, KQ: ${cols[4].innerText.trim()}, Giá: ${cols[5].innerText.trim()}, Spend: ${cols[7].innerText.trim()}, CTR: ${cols[15].innerText.trim()}\n`;
              }
            });
            tableData += "\nHãy phân tích ngắn gọn.";
          }
          const aiResponse = await callGemini(text + tableData);
          renderMessage("ai", aiResponse);
          chrome.storage.local.get(["aiHistory"], (res) => {
            let history = res.aiHistory || [];
            history.push(
              { role: "user", text: text },
              { role: "ai", text: aiResponse },
            );
            if (history.length > 30) history.splice(0, 2);
            chrome.storage.local.set({ aiHistory: history });
          });
        };
      }
    }
    async function callGemini(prompt) {
      try {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          },
        );
        const data = await resp.json();
        if (!resp.ok)
          return `❌ Lỗi API: ${data.error ? data.error.message : "Chưa rõ"}`;
        return data.candidates[0].content.parts[0].text;
      } catch (e) {
        return `❌ Lỗi mạng AI.`;
      }
    }
  } catch (err) {
    console.error(err);
  }

  try {
    const autoTokenBtn = document.getElementById("autoTokenBtn");
    if (autoTokenBtn) {
      autoTokenBtn.addEventListener("click", async () => {
        window.setBtnLabel(autoTokenBtn, "ĐANG LẤY...", "⏳");
        autoTokenBtn.disabled = true;
        window.updateTokenChip("warn", "Đang lấy token...");
        try {
          const response = await fetch(
            "https://adsmanager.facebook.com/adsmanager/manage/campaigns",
            {
              method: "GET",
              credentials: "include",
              headers: { Accept: "text/html" },
            },
          );
          const html = await response.text();
          const match = html.match(/(EAAB[a-zA-Z0-9_]+)/);
          if (match && match[1]) {
            document.getElementById("tokenInput").value = match[1];
            chrome.storage.local.set({ fbToken: match[1] });
            window.setBtnLabel(autoTokenBtn, "THÀNH CÔNG", "✅");
            window.updateTokenChip("ok", "Token đã sẵn sàng");
            setTimeout(
              () => {
                window.setBtnLabel(autoTokenBtn, "LẤY TOKEN TỰ ĐỘNG", "⚡");
                autoTokenBtn.disabled = false;
              },
              2000,
            );
          } else {
            window.setBtnLabel(autoTokenBtn, "CHƯA ĐĂNG NHẬP FB", "❌");
            window.updateTokenChip("warn", "Chưa đăng nhập Facebook");
            alert(
              "Không tìm thấy Token. Hãy mở 1 tab Facebook để đảm bảo đã đăng nhập!",
            );
            setTimeout(
              () => {
                window.setBtnLabel(autoTokenBtn, "LẤY TOKEN TỰ ĐỘNG", "⚡");
                autoTokenBtn.disabled = false;
              },
              3000,
            );
          }
        } catch (e) {
          window.setBtnLabel(autoTokenBtn, "LỖI TRUY CẬP", "❌");
          window.updateTokenChip("warn", "Lỗi truy cập");
          
          // setTimeout(
          //   () => (autoTokenBtn.innerText = "⚡ LẤY TOKEN TỰ ĐỘNG"),
          //   3000,
          // );
        }
      });
    }

    const oauthTokenBtn = document.getElementById("oauthTokenBtn");
    if (oauthTokenBtn) {
      oauthTokenBtn.addEventListener("click", async () => {
        try {
          const stored = await new Promise((resolve) => {
            chrome.storage.local.get(["fbAppId", "workerUrl"], (data) =>
              resolve(data || {}),
            );
          });
          let workerUrl =
            document.getElementById("workerUrlInput")?.value.trim() ||
            stored.workerUrl ||
            "";
          if (!workerUrl) {
            const input = prompt(
              "Nhập URL Worker Cloudflare của bạn:\n" +
                "(VD: https://fb-token-sap.ten-cua-ban.workers.dev)\n\n" +
                "⚠️ Nếu chưa deploy Worker, xem hướng dẫn trong file README_WORKER.md.",
            );
            if (!input || !input.trim()) {
              alert("❌ Cần có URL Worker.");
              return;
            }
            workerUrl = input.trim().replace(/\/+$/, "");
            await new Promise((resolve) => {
              chrome.storage.local.set({ workerUrl }, resolve);
            });
            const inputEl = document.getElementById("workerUrlInput");
            if (inputEl) inputEl.value = workerUrl;
          }

          oauthTokenBtn.innerText = "⏳ ĐANG MỞ FACEBOOK...";

          chrome.tabs.create({ url: workerUrl + "/login" }, (tab) => {
            const tabId = tab.id;
            const onUpdated = (updatedTabId, info, updatedTab) => {
              if (updatedTabId !== tabId) return;
              if (
                info.status === "complete" &&
                updatedTab.url &&
                updatedTab.url.startsWith(workerUrl + "/callback")
              ) {
                chrome.tabs.onUpdated.removeListener(onUpdated);
                // Đợi 2.5s để Worker tự postMessage sang extension
                setTimeout(() => {
                  try {
                    chrome.tabs.remove(tabId);
                  } catch (e) {}
                }, 2500);
                oauthTokenBtn.innerText = "🔑 LẤY TOKEN ĐẦY ĐỦ QUYỀN";
              }
            };
            chrome.tabs.onUpdated.addListener(onUpdated);
            setTimeout(
              () => {
                chrome.tabs.onUpdated.removeListener(onUpdated);
                oauthTokenBtn.innerText = "🔑 LẤY TOKEN ĐẦY ĐỦ QUYỀN";
              },
              5 * 60 * 1000,
            );
          });
        } catch (e) {
          alert("Lỗi OAuth: " + e.message);
          oauthTokenBtn.innerText = "🔑 LẤY TOKEN ĐẦY ĐỦ QUYỀN";
        }
      });
    }

    // Lắng nghe Worker gửi token về qua postMessage + URL query
    window.addEventListener("message", async (event) => {
      if (!event.data || event.data.type !== "FB_LONG_TOKEN") return;
      await handleLongTokenPayload(event.data.payload);
    });

    // Nếu URL có ?fb_token=... (Worker redirect về extension)
    (async () => {
      try {
        const u = new URL(window.location.href);
        const tok = u.searchParams.get("fb_token");
        const exp = parseInt(u.searchParams.get("fb_expires_in") || "0", 10);
        if (tok) {
          await handleLongTokenPayload({
            access_token: tok,
            expires_in: exp,
            source: "url",
          });
          u.searchParams.delete("fb_token");
          u.searchParams.delete("fb_expires_in");
          window.history.replaceState({}, "", u.toString());
        }
      } catch (e) {}
    })();

    async function handleLongTokenPayload(payload) {
      if (!payload || !payload.access_token) return;
      const expiresAt = payload.expires_in
        ? Date.now() + payload.expires_in * 1000
        : Date.now() + 60 * 24 * 3600 * 1000;
      await new Promise((resolve) => {
        chrome.storage.local.set(
          {
            fbToken: payload.access_token,
            fbTokenExpiresAt: expiresAt,
            fbTokenSource: "long-lived-worker",
            fbTokenScopes: payload.scopes || [],
          },
          resolve,
        );
      });
      const ti = document.getElementById("tokenInput");
      if (ti) ti.value = payload.access_token;
      const btn = document.getElementById("oauthTokenBtn");
      if (btn) {
        btn.innerText = "✅ TOKEN 60 NGÀY";
        setTimeout(() => (btn.innerText = "🔑 LẤY TOKEN ĐẦY ĐỦ QUYỀN"), 3000);
      }
      const days = Math.round((expiresAt - Date.now()) / 86400000);
      alert(
        `✅ Đã lưu token 60 ngày (còn ~${days} ngày).\n` +
          `Scopes: ${(payload.scopes || []).join(", ") || "(chưa xác minh)"}`,
      );
    }

    // Auto-refresh: chạy mỗi khi mở tool, hoặc trước mỗi lần share
    async function ensureFreshLongLivedToken() {
      const data = await new Promise((resolve) => {
        chrome.storage.local.get(
          ["fbToken", "fbTokenExpiresAt", "workerUrl"],
          (d) => resolve(d || {}),
        );
      });
      if (!data.fbToken || !data.fbTokenExpiresAt) return data.fbToken || null;
      const msLeft = data.fbTokenExpiresAt - Date.now();
      // Refresh khi còn < 7 ngày (để chắc chắn không bị hết giữa chừng)
      if (msLeft > 7 * 86400000) return data.fbToken;
      if (!data.workerUrl) return data.fbToken;
      try {
        const r = await fetch(
          data.workerUrl.replace(/\/+$/, "") +
            "/refresh?token=" +
            encodeURIComponent(data.fbToken),
        );
        const j = await r.json();
        if (j.ok && j.access_token) {
          const newExp = Date.now() + (j.expires_in || 5184000) * 1000;
          await new Promise((resolve) => {
            chrome.storage.local.set(
              {
                fbToken: j.access_token,
                fbTokenExpiresAt: newExp,
                fbTokenSource: "long-lived-worker-refreshed",
              },
              resolve,
            );
          });
          const ti = document.getElementById("tokenInput");
          if (ti) ti.value = j.access_token;
          console.log(
            "[FB Token] Auto-refresh thành công, hạn mới:",
            new Date(newExp).toLocaleString(),
          );
          return j.access_token;
        }
      } catch (e) {
        console.warn("[FB Token] Auto-refresh lỗi:", e.message);
      }
      return data.fbToken;
    }
    // Gọi 1 lần khi load
    setTimeout(() => {
      ensureFreshLongLivedToken().catch(() => {});
    }, 2000);

    // ===== patch vào flow share page: đảm bảo dùng token còn hạn =====
    const _originalSP = window.spShare || (() => {});
    // Tự override khi click nút Share
    document.addEventListener(
      "click",
      async (e) => {
        const btn = e.target.closest(
          "#spShareBtn, [data-action='share-pages']",
        );
        if (!btn) return;
        try {
          await ensureFreshLongLivedToken();
        } catch (err) {}
      },
      true,
    );

    const fetchAllActBtn = document.getElementById("fetchAllActBtn");
    if (fetchAllActBtn) {
      fetchAllActBtn.addEventListener("click", async () => {
        const token = document.getElementById("tokenInput").value;
        if (!token) return alert("⚠️ Vui lòng Lấy Token trước khi kéo TKQC!");

        window.setBtnLabel(fetchAllActBtn, "ĐANG KÉO DỮ LIỆU...", "⏳");
        fetchAllActBtn.disabled = true;
        try {
          const res = await fetch(
            `https://graph.facebook.com/v20.0/me/adaccounts?fields=account_id,name,account_status,currency,time_zone&limit=500&access_token=${token}`,
          );
          const data = await res.json();

          if (data.data && data.data.length > 0) {
            openSelectActModal(data.data);
          } else {
            alert("❌ Không tìm thấy TKQC nào hoặc Token bị lỗi.");
            window.setBtnLabel(fetchAllActBtn, "CHỌN TKQC CỦA VIA", "⏬");
          }
        } catch (e) {
          alert("❌ Lỗi mạng khi kéo TKQC!");
          window.setBtnLabel(fetchAllActBtn, "CHỌN TKQC CỦA VIA", "⏬");
        }
        setTimeout(
          () => {
            window.setBtnLabel(fetchAllActBtn, "CHỌN TKQC CỦA VIA", "⏬");
            fetchAllActBtn.disabled = false;
          },
          3000,
        );
      });
    }

    // ===== MODAL CHỌN TÀI KHOẢN QUẢNG CÁO =====
    const selectActModal = document.getElementById("selectActModal");
    const actListContainer = document.getElementById("actListContainer");
    const actSearchInput = document.getElementById("actSearchInput");
    const actConfirmBtn = document.getElementById("actConfirmBtn");
    let allActList = []; // danh sách TKQC đầy đủ
    let filteredActList = []; // danh sách sau khi lọc tìm kiếm
    let actCurrentFilter = "all"; // all | active | inactive
    const MAX_ACT_SELECT = 5; // giới hạn tối đa số TKQC được chọn

    const getActCheckedIds = () =>
      Array.from(
        actListContainer.querySelectorAll("input.actCheckBox:checked"),
      ).map((cb) => cb.value);

    const updateActConfirmBtn = () => {
      const n = getActCheckedIds().length;
      actConfirmBtn.innerText = `➕ ĐƯA VÀO Ô ID (${n})`;
      actConfirmBtn.disabled = n === 0;
      actConfirmBtn.style.opacity = n === 0 ? "0.5" : "1";
    };

    const renderActList = () => {
      const kw = (actSearchInput.value || "").trim().toLowerCase();
      filteredActList = allActList.filter((acc) => {
        if (actCurrentFilter === "active" && acc.account_status != 1) return false;
        if (actCurrentFilter === "inactive" && acc.account_status == 1) return false;
        if (!kw) return true;
        return (
          String(acc.name || "").toLowerCase().includes(kw) ||
          String(acc.account_id || "").toLowerCase().includes(kw)
        );
      });

      const checkedSet = new Set(getActCheckedIds());
      if (!filteredActList.length) {
        actListContainer.innerHTML =
          '<div style="padding:20px;text-align:center;color:#8c939d;font-size:13px">Không có TKQC phù hợp</div>';
        updateActConfirmBtn();
        return;
      }

      actListContainer.innerHTML = filteredActList
        .map((acc, i) => {
          const isActive = acc.account_status == 1;
          const checked = checkedSet.has(String(acc.account_id));
          return `
          <label style="display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:6px;cursor:pointer;font-size:13px;color:#1c1e21;${checked ? "background:#e7f3ff;" : ""}">
            <input type="checkbox" class="actCheckBox" value="${acc.account_id}" ${checked ? "checked" : ""} style="width:16px;height:16px;cursor:pointer;flex-shrink:0" />
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${String(acc.name || "").replace(/"/g, "&quot;")}">${acc.name || "(Không tên)"}</span>
            <span style="font-size:11px;color:#8c939d;font-family:monospace">${acc.account_id}</span>
            <span style="font-size:11px;padding:2px 7px;border-radius:10px;${isActive ? "background:#d4f4dd;color:#0a5c2f" : "background:#ffe0e0;color:#a4262c"}">${isActive ? "ACTIVE" : "INACTIVE"}</span>
          </label>`;
        })
        .join("");

      actListContainer.querySelectorAll("input.actCheckBox").forEach((cb) => {
        cb.addEventListener("change", () => {
          if (cb.checked && getActCheckedIds().length > MAX_ACT_SELECT) {
            cb.checked = false;
            alert(
              `⚠️ Chỉ được chọn tối đa ${MAX_ACT_SELECT} tài khoản quảng cáo!`,
            );
          }
          const label = cb.closest("label");
          if (label) label.style.background = cb.checked ? "#e7f3ff;" : "";
          updateActConfirmBtn();
        });
      });
      updateActConfirmBtn();
    };

    const openSelectActModal = (list) => {
      allActList = list;
      actCurrentFilter = "all";
      if (actSearchInput) actSearchInput.value = "";
      // Mặc định tick sẵn những TKQC đang có trong ô ID
      const currentIds = new Set(
        (document.getElementById("idInput").value || "")
          .split(/[\s,]+/)
          .filter(Boolean)
          .map((s) => s.replace(/^act_/, "")),
      );
      renderActList();
      const boxes = actListContainer.querySelectorAll("input.actCheckBox");
      let picked = 0;
      boxes.forEach((cb) => {
        if (currentIds.has(cb.value) && picked < MAX_ACT_SELECT) {
          cb.checked = true;
          picked++;
        }
      });
      renderActList();
      updateActConfirmBtn();
      selectActModal.style.display = "flex";
    };

    actSearchInput?.addEventListener("input", renderActList);

    document.getElementById("actSelectAllBtn")?.addEventListener("click", () => {
      const boxes = Array.from(
        actListContainer.querySelectorAll("input.actCheckBox"),
      );
      boxes.slice(0, MAX_ACT_SELECT).forEach((cb) => (cb.checked = true));
      boxes.slice(MAX_ACT_SELECT).forEach((cb) => (cb.checked = false));
      renderActList();
    });

    document.getElementById("actSelectNoneBtn")?.addEventListener("click", () => {
      actListContainer
        .querySelectorAll("input.actCheckBox")
        .forEach((cb) => (cb.checked = false));
      renderActList();
    });

    actConfirmBtn?.addEventListener("click", () => {
      const ids = getActCheckedIds();
      if (!ids.length) return alert("⚠️ Chưa chọn TKQC nào!");
      if (ids.length > MAX_ACT_SELECT)
        return alert(`⚠️ Chỉ được chọn tối đa ${MAX_ACT_SELECT} tài khoản quảng cáo!`);
      const input = document.getElementById("idInput");
      // Giữ lại các ID đang có trong ô mà không nằm trong danh sách vừa tải
      const fetched = new Set(allActList.map((a) => String(a.account_id)));
      const kept = (input.value || "")
        .split(/[\s,]+/)
        .filter(Boolean)
        .filter((s) => !fetched.has(s.replace(/^act_/, "")));
      const merged = [...kept, ...ids.map((id) => `act_${id}`)];
      input.value = merged.join(",\n");
      selectActModal.style.display = "none";
      // Lưu luôn vào storage (không cần bấm LƯU CẤU HÌNH)
      chrome.storage.local.set(
        {
          fbToken: document.getElementById("tokenInput").value,
          fbIds: input.value,
        },
        () => {},
      );
      if (fetchAllActBtn)
        window.setBtnLabel(
          fetchAllActBtn,
          `ĐÃ CHỌN & LƯU ${ids.length} TKQC`,
          "✅",
        );
      window.updateTokenChip("ok", `${ids.length} TKQC đã chọn`);
      setTimeout(() => {
        if (fetchAllActBtn)
          window.setBtnLabel(fetchAllActBtn, "CHỌN TKQC CỦA VIA", "⏬");
      }, 3000);
    });

    // Filter trạng thái
    const actFilterBox = document.createElement("div");
    actFilterBox.style.cssText =
      "display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap";
    actFilterBox.innerHTML = `
      <button class="btn actFilterBtn btn-blue" data-filter="all" style="flex:1;margin-bottom:0;font-size:12px;padding:6px">TẤT CẢ</button>
      <button class="btn actFilterBtn btn-green" data-filter="active" style="flex:1;margin-bottom:0;font-size:12px;padding:6px">🟢 ĐANG CHẠY</button>
      <button class="btn actFilterBtn btn-orange" data-filter="inactive" style="flex:1;margin-bottom:0;font-size:12px;padding:6px">🔴 ĐÃ TẮT</button>
    `;
    actFilterBox.querySelectorAll(".actFilterBtn").forEach((btn) => {
      btn.addEventListener("click", () => {
        actCurrentFilter = btn.dataset.filter;
        renderActList();
      });
    });
    if (actListContainer && actListContainer.parentElement) {
      actListContainer.parentElement.insertBefore(
        actFilterBox,
        actListContainer,
      );
    }

    chrome.storage.local.get(["fbToken", "fbIds"], (result) => {
      if (result.fbToken) {
        document.getElementById("tokenInput").value = result.fbToken;
        window.updateTokenChip("ok", "Token đã sẵn sàng");
      }
      if (result.fbIds) document.getElementById("idInput").value = result.fbIds;
    });

    // Cập nhật badge trạng thái token khi người dùng tự nhập
    document.getElementById("tokenInput")?.addEventListener("input", (e) => {
      const v = (e.target.value || "").trim();
      window.updateTokenChip(v ? "ok" : null, v ? "Token đã nhập" : "Chưa có token");
      scheduleCredsSave();
    });

    // ============================================================
    // (D) AUTO-LUU TOKEN / ID → storage
    //    Background đọc chrome.storage.local["fbToken"/"fbIds"] để quét.
    //    Không có bước này thì background sẽ không có token để quét.
    // ============================================================
    let _credsSaveTimer = null;
    function scheduleCredsSave() {
      if (_credsSaveTimer) clearTimeout(_credsSaveTimer);
      _credsSaveTimer = setTimeout(() => {
        _credsSaveTimer = null;
        const t = document.getElementById("tokenInput")?.value || "";
        const ids = document.getElementById("idInput")?.value || "";
        try {
          chrome.storage.local.set({ fbToken: t, fbIds: ids }, () => {
            void chrome.runtime?.lastError;
          });
        } catch (err) {
          /* bỏ qua */
        }
      }, 1500);
    }
    document.getElementById("idInput")?.addEventListener("input", () => {
      scheduleCredsSave();
    });
    // Lưu ngay khi đóng trang (không chờ debounce)
    window.addEventListener("beforeunload", () => {
      const t = document.getElementById("tokenInput")?.value || "";
      const ids = document.getElementById("idInput")?.value || "";
      try {
        chrome.storage.local.set({ fbToken: t, fbIds: ids });
      } catch (err) {
        /* bỏ qua */
      }
    });

    document.getElementById("saveBtn")?.addEventListener("click", () => {
      chrome.storage.local.set(
        {
          fbToken: document.getElementById("tokenInput").value,
          fbIds: document.getElementById("idInput").value,
        },
        () => {
          alert("💾 Đã lưu cấu hình!");
        },
      );
    });
    document.getElementById("clearBtn")?.addEventListener("click", () => {
      chrome.storage.local.remove(
        ["fbToken", "fbIds", "prepayData", "aiHistory"],
        () => {
          alert("🗑️ Đã xóa sạch dữ liệu!");
          location.reload();
        },
      );
    });

    const handleToggleAds = async (e) => {
      if (e.target.classList.contains("toggle-btn")) {
        const btn = e.target,
          id = btn.getAttribute("data-id"),
          status = btn.getAttribute("data-status");
        const token = document.getElementById("tokenInput").value,
          newStatus = status === "ACTIVE" ? "PAUSED" : "ACTIVE";
        btn.innerText = "⏳...";
        try {
          const res = await fetch(`https://graph.facebook.com/v20.0/${id}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `status=${newStatus}&access_token=${token}`,
          });
          const data = await res.json();
          if (data.success) {
            btn.setAttribute("data-status", newStatus);
            btn.className = `toggle-btn ${newStatus === "ACTIVE" ? "status-active" : "status-paused"}`;
            btn.innerText = newStatus === "ACTIVE" ? "ĐANG CHẠY" : "BẬT LẠI";
            btn.style.background =
              newStatus === "ACTIVE" ? "#31a24c" : "#8c939d";
            // (F) Đồng bộ cache của background để bảng ✂️ Tắt Camp không bị lệch
            try {
              chrome.runtime?.sendMessage?.(
                { type: "camp-core-scan", manual: true },
                () => void chrome.runtime?.lastError,
              );
            } catch (err) {
              /* bỏ qua */
            }
          } else {
            alert(
              "❌ Lỗi FB: " + (data.error ? data.error.message : "Chưa rõ lỗi"),
            );
            btn.innerText = status === "ACTIVE" ? "ĐANG CHẠY" : "BẬT LẠI";
          }
        } catch (err) {
          alert("❌ Lỗi kết nối FB!");
          btn.innerText = status === "ACTIVE" ? "ĐANG CHẠY" : "BẬT LẠI";
        }
      }
    };

    document
      .getElementById("resultTableBody")
      ?.addEventListener("click", handleToggleAds);
    document
      .getElementById("pausedTableBody")
      ?.addEventListener("click", handleToggleAds);

    // ==========================================
    // LOGIC CHUẨN: TÍNH THUẾ 10% VÀO TIỀN TIÊU
    // ==========================================
    // Lưu hàng loạt (dùng cho nút "CẬP NHẬT TIỀN NẠP")
    const savePrepayBulk = (inputs, { silent = true } = {}) => {
      let newData = {};

      inputs.forEach((input) => {
        const id = input.getAttribute("data-id");
        const val = parseFloat(input.value);
        const todaySpend = parseFloat(input.getAttribute("data-spend")) || 0;

        if (!isNaN(val) && val >= 0) {
          newData[id] = val;
          // LÕI CHUẨN: Số dư = Tiền nạp - (Tiền cắn * 1.1)
          const balEl = document.getElementById(`bal-${id}`);
          let calcBalance = val - todaySpend * 1.1;

          balEl.innerText =
            new Intl.NumberFormat("vi-VN").format(Math.round(calcBalance)) +
            " đ";
          balEl.style.color = calcBalance < 0 ? "#fa383e" : "#31a24c";
        }
      });

      chrome.storage.local.get(["prepayData"], (res) => {
        let mergedData = { ...(res.prepayData || {}), ...newData };
        chrome.storage.local.set({ prepayData: mergedData }, () => {
          if (silent) {
            showPrepayToast(
              `✅ Đã lưu ${Object.keys(newData).length} tài khoản`,
              true,
            );
          } else {
            alert(
              "✅ Đã lưu Tiền Nạp & Cập nhật số dư (Công thức: Nạp - [Tiêu * 1.1])!",
            );
          }
        });
      });
    };

    document.getElementById("updateMoneyBtn")?.addEventListener("click", () => {
      savePrepayBulk(document.querySelectorAll(".prepay-input"), {
        silent: false,
      });
    });

    // ==========================================
    // Tự động lưu tiền nạp khi click ra ngoài ô nhập
    // ==========================================
    let prepayToastTimer = null;
    const showPrepayToast = (message, ok = true) => {
      try {
        let el = document.getElementById("prepayAutoSaveToast");
        if (!el) {
          el = document.createElement("div");
          el.id = "prepayAutoSaveToast";
          el.style.cssText =
            "position:fixed;right:16px;bottom:16px;z-index:99999;" +
            "padding:10px 14px;border-radius:8px;font-size:13px;font-weight:600;" +
            "box-shadow:0 4px 14px rgba(0,0,0,.18);pointer-events:none;" +
            "transition:opacity .25s ease;max-width:320px;";
          document.body.appendChild(el);
        }
        el.textContent = message;
        el.style.background = ok ? "#31a24c" : "#fa383e";
        el.style.color = "#fff";
        el.style.opacity = "1";
        clearTimeout(prepayToastTimer);
        prepayToastTimer = setTimeout(() => {
          el.style.opacity = "0";
        }, 1800);
      } catch (e) {
        /* bỏ qua */
      }
    };

    const savePrepayInput = (input, silent = true) => {
      const id = input?.getAttribute?.("data-id");
      if (!id) return;

      const raw = (input.value || "").trim();
      const val = parseFloat(raw);
      const todaySpend = parseFloat(input.getAttribute("data-spend")) || 0;
      const isValid = raw !== "" && !isNaN(val) && val >= 0;

      chrome.storage.local.get(["prepayData"], (res) => {
        const mergedData = { ...(res?.prepayData || {}) };

        if (isValid) mergedData[id] = val;
        else delete mergedData[id];

        chrome.storage.local.set({ prepayData: mergedData }, () => {
          // Cập nhật số dư hiển thị ngay (LÕI CHUẨN: Nạp - [Tiêu * 1.1])
          const balEl = document.getElementById(`bal-${id}`);
          if (balEl) {
            if (isValid) {
              const calcBalance = val - todaySpend * 1.1;
              balEl.innerText =
                new Intl.NumberFormat("vi-VN").format(
                  Math.round(calcBalance),
                ) + " đ";
              balEl.style.color = calcBalance < 0 ? "#fa383e" : "#31a24c";
            } else {
              balEl.innerText = "Nhập tiền ->";
              balEl.style.color = "#8c939d";
            }
          }

          if (!silent) {
            alert(
              isValid
                ? "✅ Đã lưu Tiền Nạp & Cập nhật số dư (Công thức: Nạp - [Tiêu * 1.1])!"
                : "🗑️ Đã xoá tiền nạp của tài khoản này.",
            );
          } else {
            showPrepayToast(
              isValid
                ? `✅ Đã lưu tiền nạp: ${new Intl.NumberFormat("vi-VN").format(val)} đ`
                : "🗑️ Đã xoá tiền nạp",
              isValid,
            );
          }
        });
      });
    };

    // Dùng event delegation vì #billingList được vẽ lại (innerHTML) mỗi lần quét
    const billingListEl = document.getElementById("billingList");
    billingListEl?.addEventListener("focusout", (e) => {
      const input = e.target?.closest?.(".prepay-input");
      if (input) savePrepayInput(input);
    });
    billingListEl?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const input = e.target?.closest?.(".prepay-input");
      if (input) {
        e.preventDefault();
        input.blur(); // blur => tự động lưu
      }
    });

    function getCleanIds(rawString) {
      if (!rawString) return [];
      return rawString
        .split(/[\n,]+/)
        .map((s) => {
          let cleanId = s.trim().replace(/[^\w]/g, "");
          if (cleanId && !cleanId.startsWith("act_"))
            cleanId = "act_" + cleanId;
          return cleanId;
        })
        .filter((id) => id !== "act_");
    }
    // 1. Hàm gửi tin nhắn về Telegram
    //    → Dùng cấu hình của người dùng (TelegramConfig), fallback bot mặc định
    async function sendTelegramAlert(message) {
      if (window.TelegramConfig?.sendMessage) {
        return await window.TelegramConfig.sendMessage(message);
      }

      // Fallback: dùng bot mặc định nếu module chưa nạp được
      const BOT_TOKEN = "8709933422:AAGz6LiC_DP46zjia5JLD95jNNB7Tcjx6wk";
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

      // Lấy CHAT ID từ cấu hình người dùng (không có mặc định)
      let ADMIN_CHAT_ID = [];
      try {
        const res = await chrome.storage.local.get(["ccTeleChatId"]);
        ADMIN_CHAT_ID = (res?.ccTeleChatId || "")
          .split(/[\s,;]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      } catch (e) {}

      if (!ADMIN_CHAT_ID.length) {
        console.warn(
          "[Telegram] Chưa có TELEGRAM_CHAT_ID → bỏ qua gửi tin nhắn.",
        );
        return { ok: false, sent: 0, total: 0 };
      }

      // Lặp qua từng ID admin để gửi tin nhắn
      let sent = 0;
      let lastError = "";
      for (const chatId of ADMIN_CHAT_ID) {
        try {
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: message,
              parse_mode: "HTML", // Cho phép dùng thẻ HTML cơ bản như <b>, <i>
            }),
          });

          if (!response.ok) {
            let detail = "";
            try {
              const data = await response.clone().json();
              detail = data && data.description ? data.description : "";
            } catch (e) {}
            lastError = `HTTP ${response.status}${detail ? ": " + detail : ""}`;
            console.error(
              `❌ Lỗi gửi tin nhắn đến ID ${chatId}:`,
              response.statusText,
              detail,
            );
          } else {
            sent++;
            console.log(`✅ Đã gửi cảnh báo thành công tới ID ${chatId}`);
          }
        } catch (error) {
          lastError = error?.message || String(error);
          console.error("❌ Lỗi kết nối API Telegram:", error);
        }
      }
      return {
        ok: sent > 0,
        sent,
        total: ADMIN_CHAT_ID.length,
        error: sent > 0 ? "" : lastError,
      };
    }

    // ✅ Xuất ra window để các module khác (care_camp.js…) gọi được
    window.sendTelegramAlert = sendTelegramAlert;

    async function executeScan2() {
      console.log("Đang quét dữ liệu camp...");

      // Giả sử bạn lấy được dữ liệu này từ API của Facebook/Tiktok/Google Ads
      const currentCost = 550000; // Chi phí hiện tại
      const maxThreshold = 500000; // Ngưỡng cho phép
      const campName = "Camp Quần Áo Mùa Hè 01";

      // Kiểm tra nếu đắt hơn ngưỡng thì bắn thông báo
      if (currentCost > maxThreshold) {
        const alertMessage =
          `🚨 <b>CẢNH BÁO CAMP ĐẮT</b> 🚨\n\n` +
          `📦 <b>Tên Camp:</b> ${campName}\n` +
          `💸 <b>Chi phí hiện tại:</b> ${currentCost.toLocaleString("vi-VN")} VNĐ\n` +
          `⚠️ <b>Ngưỡng báo động:</b> ${maxThreshold.toLocaleString("vi-VN")} VNĐ\n\n` +
          `🔴 Vui lòng vào trình quản lý quảng cáo kiểm tra và tắt camp ngay!`;

        await sendTelegramAlert(alertMessage);
      }
    }
    // async function runScanLoop2() {
    //     try {
    //         await executeScan2();
    //     } catch (error) {
    //         console.error("Lỗi vòng lặp:", error);
    //     } finally {
    //         setTimeout(runScanLoop, 10000); // Đợi 10 giây rồi chạy lại
    //     }
    // }

    // // Bắt đầu chạy
    // runScanLoop();

    //         async function runScanLoop() {
    //     try {
    //         // Chờ hàm executeScan chạy xong hoàn toàn
    //         await executeScan();
    //     } catch (error) {
    //         console.error("Lỗi khi chạy scan:", error);
    //     } finally {
    //         // Dù thành công hay lỗi, vẫn hẹn giờ 10 giây sau chạy lại
    //         setTimeout(runScanLoop, 20000);
    //     }
    // }

    async function fetchTodayRecharge(accountId, token) {
      try {
        // Cào 50 giao dịch gần nhất của TKQC
        const url = `https://graph.facebook.com/v20.0/${accountId}/transactions?fields=time,amount,status,charge_type,action_type&limit=50&access_token=${token}`;
        const res = await fetch(url);
        const data = await res.json();

        if (!data.data || data.data.length === 0) return 0;

        let totalNạp = 0;
        // Lấy ngày hôm nay theo định dạng của Facebook (YYYY-MM-DD)
        const todayStr = new Date().toISOString().split("T")[0];

        data.data.forEach((tx) => {
          // Kiểm tra: Nếu là giao dịch hôm nay + Trạng thái thành công
          if (
            tx.time &&
            tx.time.startsWith(todayStr) &&
            tx.status === "completed"
          ) {
            // Lọc giao dịch nạp tiền: Thường nạp tiền thì KHÔNG PHẢI là 'charge' (thanh toán tiền ad)
            // FB có thể trả về action_type là 'funding', 'manual_fund', v.v.
            if (tx.charge_type !== "charge" && tx.action_type !== "charge") {
              // API trả về string dạng số tiền. Thường tài khoản VNĐ sẽ giữ nguyên hoặc x100.
              // Nếu sếp thấy tiền ra bị x100 thì sửa lại thành: parseFloat(tx.amount) / 100
              totalNạp += parseFloat(tx.amount) || 0;
            }
          }
        });

        return totalNạp;
      } catch (e) {
        console.error("Lỗi cào giao dịch cho", accountId, e);
        return 0; // Lỗi mạng thì cho bằng 0
      }
    }

    /* =================================================================
     * (D) BẢNG 📊 CHỈ SỐ — ĐỌC TỪ CACHE, KHÔNG TỰ GỌI API
     * -----------------------------------------------------------------
     * Nguồn quét DUY NHẤT = background (camp_core.js) qua chrome.alarms.
     * Bảng này chỉ:
     *   1. Yêu cầu background quét (khi bấm nút quét tay) — vẫn 1 nguồn.
     *   2. Đọc rows từ cache và RENDER ra bảng.
     *   3. Lắng nghe "camp-core-updated" để tự làm mới.
     * ================================================================= */
    const AUTO_SCAN_INTERVAL_MS = 60000; // 1 phút (đồng hồ đếm ngược)

    const countdownBox = document.getElementById("autoScanCountdown");
    const countdownValue = document.getElementById("autoScanCountdownValue");
    const countdownLabel = document.getElementById("autoScanCountdownLabel");
    let nextAutoScanAt = Date.now() + AUTO_SCAN_INTERVAL_MS;

    const formatCountdown = (ms) => {
      const totalSec = Math.max(0, Math.ceil(ms / 1000));
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    };

    const renderCountdown = () => {
      if (!countdownValue) return;
      const remaining = nextAutoScanAt - Date.now();
      countdownValue.textContent = formatCountdown(remaining);

      if (remaining <= 10000) {
        countdownValue.style.color = "#fa383e";
        if (countdownLabel) countdownLabel.textContent = "ĐANG QUÉT...";
      } else {
        countdownValue.style.color = "#1877f2";
        if (countdownLabel) countdownLabel.textContent = "QUÉT SAU";
      }
    };

    if (countdownBox) {
      renderCountdown();
      setInterval(renderCountdown, 1000);
    }

    /* -----------------------------------------------------------------
     * Hàm gọi background quét (1 nguồn duy nhất)
     * ----------------------------------------------------------------- */
    const requestBackgroundScan = (manual = false) =>
      new Promise((resolve) => {
        try {
          chrome.runtime?.sendMessage?.(
            { type: "camp-core-scan", manual },
            (resp) => {
              void chrome.runtime?.lastError;
              resolve(resp || { ok: false });
            },
          );
        } catch (e) {
          resolve({ ok: false, error: e?.message });
        }
      });

    /* -----------------------------------------------------------------
     * Đọc cache kết quả quét từ background
     * ----------------------------------------------------------------- */
    const fetchCoreState = () =>
      new Promise((resolve) => {
        try {
          chrome.runtime?.sendMessage?.(
            { type: "camp-core-get-state" },
            (resp) => {
              void chrome.runtime?.lastError;
              resolve(resp?.data || null);
            },
          );
        } catch (e) {
          resolve(null);
        }
      });

    /* -----------------------------------------------------------------
     * (F) TẮT / BẬT THỦ CÔNG — gửi yêu cầu cho background xử lý
     *     (để không tồn tại 2 nơi quyết định tắt nhóm)
     * ----------------------------------------------------------------- */
    const requestAdsetStatus = async (adsetId, status) => {
      try {
        const res = await fetch(`https://graph.facebook.com/v20.0/${adsetId}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `status=${status}&access_token=${document.getElementById("tokenInput").value}`,
        });
        const data = await res.json();
        if (data.success) {
          // Đồng bộ lại cache của background để 2 bảng thống nhất
          requestBackgroundScan(false);
        }
        return data;
      } catch (e) {
        return { error: { message: e?.message || String(e) } };
      }
    };

    /* -----------------------------------------------------------------
     * RENDER bảng Chỉ Số từ cache của background
     * ----------------------------------------------------------------- */
    const renderScanFromCache = async (targetStatus = "ACTIVE") => {
      // Export ra window để listener ở scope khác (prepayData, camp-core-updated) gọi được
      const tableBody = document.getElementById("resultTableBody");
      const pausedTableBody = document.getElementById("pausedTableBody");
      const billingList = document.getElementById("billingList");
      if (!tableBody) return;

      if (targetStatus === "ACTIVE") tableBody.innerHTML = "";
      else if (pausedTableBody) pausedTableBody.innerHTML = "";
      if (billingList) billingList.innerHTML = "";

      const core = await fetchCoreState();
      if (!core) {
        document.getElementById("loading").style.display = "none";
        return;
      }

      const rows = core.state?.rows || [];
      const scannedAt = core.state?.scannedAt || 0;

      // Đồng hồ đếm ngược dựa trên lần quét gần nhất của background
      if (scannedAt) {
        nextAutoScanAt = scannedAt + AUTO_SCAN_INTERVAL_MS;
        renderCountdown();
      }

      const globalMaxSpend =
        parseFloat(document.getElementById("apMaxSpend")?.value) || 15000;
      const globalMaxPrice =
        parseFloat(document.getElementById("apMaxPrice")?.value) || 12000;
      const globalMaxCpm =
        parseFloat(document.getElementById("apMaxCpm")?.value) || 40000;
      const globalMaxCpc =
        parseFloat(document.getElementById("apMaxCpc")?.value) || 800;

      const modeFlags = window.getModeFlags
        ? window.getModeFlags()
        : { useCpl: false, useCpc: false, useCpcCombo: false };
      const useCpl = modeFlags.useCpl;
      const useCpc = modeFlags.useCpc;
      const useCpcCombo = modeFlags.useCpcCombo;

      const savedPrepayData = (await chrome.storage.local.get(["prepayData"]))
        .prepayData || {};

      // Gom nhóm theo tài khoản (để hiển thị quỹ + cảnh báo tiền)
      //
      // ⚠️ NGUỒN SỰ THẬT = DANH SÁCH TK ĐÃ CHỌN (fbIds trong storage),
      //    KHÔNG phải "row đã quét được".
      //    Lý do: nếu dựng từ rows thì TK lỗi API / TK không có adset nào
      //    sẽ biến mất khỏi #billingList (đúng triệu chứng user báo).
      //    Bản cũ (trước khi gộp camp_core.js) duyệt trực tiếp ids đã chọn
      //    → luôn hiện đủ. Nay seed trước danh sách đã chọn, rồi mới ghi đè
      //    bằng dữ liệu thật từ cache.
      const byAccount = new Map();

      // 1) Seed: mọi TK đã chọn đều có mặt (kể cả khi không có adset / lỗi)
      let selectedIds = [];
      try {
        const { fbIds = "" } = await chrome.storage.local.get(["fbIds"]);
        selectedIds = getCleanIds(fbIds);
      } catch (e) {
        selectedIds = [];
      }
      for (const id of selectedIds) {
        byAccount.set(id, {
          accountId: id,
          accountName: id,
          groups: [],
          todaySpend: 0,
          hasScanData: false,
        });
      }

      // Tên TK đã biết (từ modal "CHỌN TKQC CỦA VIA") → hiển thị tên thay vì act_xxx
      const actNameMap = new Map();
      for (const a of allActList || []) {
        if (a?.account_id) actNameMap.set(String(a.account_id), a.name || "");
      }

      // 2) Ghi đè bằng dữ liệu thật từ cache của background
      for (const row of rows) {
        if (row.error) continue;
        if (!byAccount.has(row.accountId)) {
          byAccount.set(row.accountId, {
            accountId: row.accountId,
            accountName: row.accountName,
            groups: [],
            todaySpend: 0,
            hasScanData: false,
          });
        }
        const acc = byAccount.get(row.accountId);
        acc.groups.push(row);
        acc.todaySpend += Number(row.spend) || 0;
        // Có ít nhất 1 adset được quét thành công → đã có dữ liệu thật
        acc.hasScanData = true;
        if (!acc.accountName || acc.accountName === acc.accountId) {
          acc.accountName = row.accountName || acc.accountName;
        }
      }

      for (const [id, acc] of byAccount) {
        try {
          // Tên hiển thị: ưu tiên tên từ cache → tên trong modal chọn TKQC → act_xxx
          const rawAccountId = String(id).replace(/^act_/, "");
          const accountName =
            (acc.accountName && acc.accountName !== id
              ? acc.accountName
              : actNameMap.get(rawAccountId)) || acc.accountName || id;
          const todaySpend = acc.todaySpend;

          // --- Render nhóm theo trạng thái ---
          for (const adset of acc.groups) {
            const isPaused = !!adset.isPaused;
            if (targetStatus === "ACTIVE" && isPaused) continue;
            if (targetStatus === "PAUSED" && !isPaused) continue;

            const insights = {
              spend: adset.spend,
              actions: adset.metrics?.actions || [],
              cpm: adset.cpm,
              clicks: adset.metrics?.clicks || 0,
              impressions: adset.metrics?.impressions || 0,
              frequency: adset.metrics?.frequency || 0,
              reach: adset.metrics?.reach || 0,
              cpc: adset.metrics?.cpc || 0,
              ctr: adset.metrics?.ctr || 0,
            };

            const spendVal = Number(adset.spend) || 0;
            const cpmVal = Number(adset.cpm) || 0;
            const clickLink = adset.metrics?.inlineLinkClicks || 0;
            const inboxCount = adset.inboxCount;
            const effectiveCount = adset.resultCount || 0;
            const effectiveLabel = adset.resultLabel || "Tin nhắn";

            const budgetStr = adset.dailyBudget
              ? parseInt(adset.dailyBudget).toLocaleString("vi-VN") + " đ"
              : adset.lifetimeBudget
                ? parseInt(adset.lifetimeBudget).toLocaleString("vi-VN") +
                  " đ(T.Đ)"
                : "N/A";
            const spendStr = spendVal.toLocaleString("vi-VN") + " đ";

            const priceNum = adset.price || 0;
            const pricePerMess =
              priceNum > 0
                ? priceNum.toLocaleString("vi-VN") + " đ"
                : "0 đ";
            const cpcValNum = adset.cpcNum || 0;
            const cpcDisplay =
              cpcValNum > 0 ? cpcValNum.toLocaleString("vi-VN") + " đ" : "0 đ";

            const editAdsetUrl = `https://adsmanager.facebook.com/adsmanager/manage/adsets/edit?act=${rawAccountId}&adset_ids=${adset.adsetId}`;

            const localDisplay = window.localConfigs?.[adset.adsetId] || {
              maxSpend: "",
              maxPrice: "",
              maxCpm: "",
              maxCpc: "",
            };
            const actionButton = `<td><button class="toggle-btn ${targetStatus === "ACTIVE" ? "status-active" : "status-paused"}" data-id="${adset.adsetId}" data-status="${targetStatus}">${targetStatus === "ACTIVE" ? "ĐANG CHẠY" : "BẬT LẠI"}</button></td>`;

            const comboOn = !!useCpcCombo;
            const cpcInputHtml = comboOn
              ? `<input type="number" class="local-cpc" placeholder="CPC" title="Ngưỡng CPC (chế độ Kết hợp CPC)" style="width:60px; border:1px solid #e0a458; border-radius:4px;" value="${localDisplay.maxCpc || globalMaxCpc}">`
              : "";

            const configCol = `
                            <td>
                                <div style="display: flex; gap: 4px; align-items: center; justify-content: center;">
                                    <input type="number" class="local-spend" placeholder="Tiền" title="Ngưỡng tiêu" style="width:55px; border:1px solid #ddd;" value="${localDisplay.maxSpend || globalMaxSpend}">
                                    <input type="number" class="local-price" placeholder="Giá" title="Ngưỡng giá (CPR/CPL/CPC)" style="width:90px; border:1px solid #ddd;" value="${localDisplay.maxPrice ?? (localDisplay.maxCpr || globalMaxPrice)}">
                                    ${cpcInputHtml}
                                    <input type="number" class="local-cpm" placeholder="CPM" title="Ngưỡng CPM" style="width:55px; border:1px solid #ddd;" value="${localDisplay.maxCpm || globalMaxCpm}">
                                 <button class="btn-save-local" data-id="${adset.adsetId}" style="padding: 4px 8px; font-size: 11px; cursor: pointer; background: #1877f2; color: #fff; border: none; border-radius: 4px;">Lưu</button>
                                  <button
    class="btn-reset-local"
    data-id="${adset.adsetId}"
    style="background:#f56b2a; color:white; border:none; padding:4px 8px; font-size:11px; cursor:pointer; border-radius:4px;">
    Reset
</button>
                                </div>
                            </td>`;

            if (targetStatus === "ACTIVE") {
              let cplCellDisplay = "<span style='color:#8c939d;'>-</span>";
              if (inboxCount !== null && inboxCount > 0 && spendVal > 0) {
                const cpl = Math.round(spendVal / inboxCount);
                cplCellDisplay = `<span style="font-weight:bold; font-family:monospace; color:#31a24c;">${cpl.toLocaleString("vi-VN")} đ</span><br><small style="color:#31a24c">(${inboxCount} HT)</small>`;
              } else if (inboxCount === 0) {
                cplCellDisplay = `<span style="font-weight:bold; font-family:monospace; color:#fa383e">0 đ</span><br><small style="color:#8c939d">(0 HT)</small>`;
              }

              const hieuQuaHtml = `<span style="font-size:16px; font-weight:bold; color:#31a24c;">${effectiveCount}</span> <br><span style="font-size:10px; color:#8c939d">${effectiveLabel}</span>`;
              const freq = insights.frequency
                ? parseFloat(insights.frequency).toFixed(2).replace(".", ",")
                : "0,00";

              tableBody.innerHTML += `
        <tr>
            ${actionButton}
            <td style="font-size:11px; color:#606770">${accountName}</td>
            <td style="color:#1877f2; font-size:12px; font-weight:bold;">${adset.campaignName || "N/A"}</td>
            <td style="font-weight:bold; font-size:13px;">${adset.name} <a href="${editAdsetUrl}" target="_blank" title="Mở trong Trình Quản Lý Quảng Cáo" style="text-decoration:none;">👁️</a></td>
            <td data-cpc-row="${adset.adsetId}" class="metric" style="color:#0e7490; font-weight:bold;">${cpcDisplay}</td>
            <td>${hieuQuaHtml}</td>
            <td class="metric" style="color:#fa383e; font-weight:bold;">${pricePerMess}</td>
            <td data-cpl="${adset.adsetId}" style="font-size:11px; text-align:center;">${cplCellDisplay}</td>
            <td class="metric" style="color:#4b4f56">${budgetStr}</td>
            <td class="metric" style="color:#d97706; font-weight:bold;">${spendStr}</td>
            ${configCol}
            <td class="metric" style="color:#4b4f56">${freq}</td>
            <td class="metric">${parseInt(insights.reach || 0).toLocaleString("vi-VN")}</td>
            <td class="metric">${parseInt(insights.impressions || 0).toLocaleString("vi-VN")}</td>
            <td class="metric">${Math.round(cpmVal).toLocaleString("vi-VN")} đ</td>
            <td class="metric" style="color:#1877f2; font-weight:bold">${clickLink}</td>
            <td class="metric">${insights.clicks || 0}</td>
            <td class="metric">${Math.round(insights.cpc || 0).toLocaleString("vi-VN")} đ</td>
            <td class="metric" style="color:#8a3ab9">${insights.ctr ? parseFloat(insights.ctr).toFixed(2).replace(".", ",") : 0}%</td>
        </tr>
    `;
            } else if (pausedTableBody) {
              pausedTableBody.innerHTML += `<tr>${actionButton}<td style="font-size:12px; font-weight:bold;">${adset.name}</td><td class="metric" style="color:#d97706">${spendStr}</td><td><span style="color:#31a24c; font-weight:bold;">${effectiveCount}</span></td>${configCol}</tr>`;
            }
          }

          // --- Quỹ & trạng thái tài khoản ---
          let displayBalance = "—";
          let balanceColor = "#31a24c";
          let inputHtml = "";
          // TK đã chọn nhưng chưa có dữ liệu quét (lỗi API / không có adset)
          const noScanData = !acc.hasScanData;

          const savedRecharge = savedPrepayData[id] || "";
          inputHtml = `<input type="number" class="prepay-input" data-id="${id}" data-spend="${todaySpend}" value="${savedRecharge}" placeholder="Tổng nạp..." title="Nhập tổng tiền nạp hôm nay">`;

          if (noScanData) {
            // Chưa quét được dữ liệu → hiện rõ trạng thái thay vì im lặng biến mất
            displayBalance = "Chưa có dữ liệu";
            balanceColor = "#d97706";
          } else if (savedRecharge) {
            const actualRecharge = parseFloat(savedRecharge);
            const calcBalance = actualRecharge - todaySpend * 1.1;
            displayBalance =
              new Intl.NumberFormat("vi-VN").format(
                Math.round(calcBalance),
              ) + " đ";
            if (calcBalance < 0) balanceColor = "#fa383e";

            // ---- Gửi Telegram cảnh báo sắp hết tiền ----
            if (calcBalance < 10000) {
              if (!window.alertLowBalCache) window.alertLowBalCache = {};
              const now = Date.now();
              if (
                !window.alertLowBalCache[id] ||
                now - window.alertLowBalCache[id] > 60000
              ) {
                window.alertLowBalCache[id] = now;

                const activeGroups = acc.groups.filter(
                  (g) => !g.isPaused && g.isCampaignActive,
                );
                let groupText = "Không có nhóm đang chạy";
                if (activeGroups.length > 0) {
                  groupText = activeGroups
                    .map(
                      (g) =>
                        `- Nhóm: ${g.name}\n` +
                        `- Đã tiêu: ${Number(g.spend).toLocaleString("vi-VN")} đ\n` +
                        `- Giá KQ: ${Number(g.price).toLocaleString("vi-VN")} đ\n` +
                        `- SL mess: ${Math.round(g.resultCount).toLocaleString("vi-VN")}`,
                    )
                    .join("\n----------------------\n");
                }

                sendTelegramAlert(
                  `⚠️ <b>SẾP ƠI, TÀI KHOẢN SẮP HẾT TIỀN!</b> ⚠️\n` +
                    `- TK: ${accountName}\n` +
                    `- ID: <code>${id}</code>\n` +
                    `- Dư hiện tại: ${Math.round(calcBalance).toLocaleString("vi-VN")} đ\n\n` +
                    `📊 <b>Nhóm đang chạy:</b>\n${groupText}\n\n` +
                    `👉 <i>Reply (Trả lời) tin nhắn này kèm số tiền nạp thêm để tự động cộng!</i>`,
                );
              }
            }
          } else {
            displayBalance = "Nhập tiền ->";
            balanceColor = "#8c939d";
          }

          const directBillingUrl = `https://www.facebook.com/ads/manager/billing/transactions/?act=${rawAccountId}`;
          if (billingList) {
            billingList.innerHTML += `
                    <div class="billing-item" style="flex-wrap: wrap;">
                        <div style="flex: 1; min-width: 120px;">
                            <span style="font-size:11px; color:#606770">${accountName}</span>
                            <span class="billing-balance" id="bal-${id}" style="color: ${balanceColor};">${displayBalance}</span>
                            <div style="font-size: 10px; color: #8c939d; margin-top: 2px;">${noScanData ? "Chưa quét được dữ liệu tài khoản" : `Đã tiêu hôm nay: ${new Intl.NumberFormat("vi-VN").format(Math.round(todaySpend))} đ`}</div>
                        </div>
                        <div style="display: flex; align-items: center; gap: 5px;">
                            ${inputHtml}
                            <a href="${directBillingUrl}" target="_blank" class="btn-nap">Nạp</a>
                        </div>
                    </div>
                `;
          }
        } catch (e) {
          console.error("Lỗi render dòng ID:", id, e);
        }
      }

      document.getElementById("loading").style.display = "none";
    };

    // Export ra window (để các listener ngoài try-block gọi được)
    window.renderScanFromCache = renderScanFromCache;

    /* -----------------------------------------------------------------
     * Hàm quét (tay hoặc tự động) — luôn đi qua background
     * ----------------------------------------------------------------- */
    const executeScan = async (targetStatus = "ACTIVE", silent = false) => {
      const token = document.getElementById("tokenInput").value;
      const ids = getCleanIds(document.getElementById("idInput").value);

      if (!token || ids.length === 0) {
        if (!silent) {
          alert("⚠️ Vui lòng nhập Access Token và ít nhất 1 ID Tài Khoản!");
        }
        return;
      }

      document.getElementById("loading").style.display = "block";
      // Reset đồng hồ đếm ngược
      nextAutoScanAt = Date.now() + AUTO_SCAN_INTERVAL_MS;
      renderCountdown();

      // ⭐ NGUỒN QUÉT DUY NHẤT: background
      await requestBackgroundScan(true);
      await renderScanFromCache(targetStatus);
    };

    /* -----------------------------------------------------------------
     * Nút quét tay
     * ----------------------------------------------------------------- */
    document.getElementById("scanBtn")?.addEventListener("click", () => {
      console.log("Sếp đang quét tay...");
      nextAutoScanAt = Date.now() + AUTO_SCAN_INTERVAL_MS;
      executeScan("ACTIVE");
    });

    document
      .getElementById("scanPausedBtn")
      ?.addEventListener("click", () => executeScan("PAUSED"));

    /* -----------------------------------------------------------------
     * Lắng nghe background báo "có dữ liệu mới" → tự làm mới bảng
     * (KHÔNG tự gọi API ở đây)
     * ----------------------------------------------------------------- */
    try {
      chrome.runtime?.onMessage?.addListener(async (msg) => {
        if (msg?.type === "camp-core-updated") {
          // (G) Đồng bộ ngưỡng từ nguồn chuẩn trước khi render
          try {
            if (window.CampCore) {
              window.localConfigs = await window.CampCore.getConfigs();
            }
          } catch (e) {
            /* bỏ qua */
          }
          renderScanFromCache("ACTIVE");
        }
      });
    } catch (e) {
      /* bỏ qua */
    }

    // Tải cache lần đầu khi mở trang (không gọi API)
    setTimeout(() => renderScanFromCache("ACTIVE"), 800);

    // ✅ Đồng hồ đếm ngược + nút quét tay đã được định nghĩa ở block "BẢNG 📊 CHỈ SỐ
    //    — ĐỌC TỪ CACHE" phía trên (dùng chung 1 nguồn quét background).
  } catch (err) {
    console.error("Lỗi code phần Ads:", err);
  }

  window.autoPauseConfig = {
    isRunning: false,
    maxSpend: 10000,
    maxPrice: 12000,
    maxCpm: 40000,
    maxCpc: 800,
    useCpl: false,
    useCpc: false,
    useCpcCombo: false,
    adsetIds: [],
  };

  document
    .getElementById("btn-fetch-ap-adsets")
    ?.addEventListener("click", async () => {
      const token = document.getElementById("tokenInput").value;
      const ids = getCleanIds(document.getElementById("idInput").value);
      if (!token || ids.length === 0)
        return alert("⚠️ Vui lòng Lấy Token và Kéo TKQC trước!");

      const tbody = document.getElementById("apTableBody");
      tbody.innerHTML = "";
      document.getElementById("apLoading").style.display = "block";
      // const globalMaxSpend = parseFloat(document.getElementById('apMaxSpend')?.value) || 10000;
      // const globalMaxCpr   = parseFloat(document.getElementById('apMaxCpr')?.value) || 12000;
      // const globalMaxCpm   = parseFloat(document.getElementById('apMaxCpm')?.value) || 50000;
      for (const id of ids) {
        try {
          const accRes = await fetch(
            `https://graph.facebook.com/v20.0/${id}?fields=name&access_token=${token}`,
          );
          const accData = await accRes.json();
          const accName = accData.name || id;

          const filtering = encodeURIComponent(
            JSON.stringify([
              { field: "effective_status", operator: "IN", value: ["ACTIVE"] },
            ]),
          );
          const url = `https://graph.facebook.com/v20.0/${id}/adsets?fields=name,optimization_goal,campaign{name},insights.date_preset(today){spend,actions,cost_per_action_type,cpc,inline_link_clicks,impressions,cpm}&filtering=${filtering}&limit=100&access_token=${token}`;
          const res = await fetch(url);
          const data = await res.json();

          if (data.data) {
            for (const adset of data.data) {
              const insights = adset.insights ? adset.insights.data[0] : null;
              const spendVal = insights ? parseFloat(insights.spend) : 0;
              const cpmVal =
                insights && insights.cpm ? parseFloat(insights.cpm) : 0;
              const local = window.localConfigs[adset.id] || {
                maxSpend: "",
                maxPrice: "",
                maxCpm: "",
              };
              const hieuQuaCount = window.getHieuQuaCount(
                insights,
                adset.optimization_goal,
              );
              const priceNum =
                hieuQuaCount > 0 ? Math.round(spendVal / hieuQuaCount) : 0;

              // --- Tính CPL từ Inbox (theo tag [N1], [N2]...) ---
              let cplDisplay = "<span style='color:#8c939d;'>-</span>";
              let inboxCount = null;
              try {
                inboxCount = await window.countInboxConversationsByTag(
                  adset.name,
                );
                if (inboxCount !== null && inboxCount > 0 && spendVal > 0) {
                  const cpl = Math.round(spendVal / inboxCount);
                  cplDisplay = `<span style="font-weight:bold; font-family:monospace; color:#31a24c;">${cpl.toLocaleString("vi-VN")} đ</span><br><small style="color:#31a24c;">(${inboxCount} HT)</small>`;
                } else if (inboxCount === 0) {
                  cplDisplay = `<span style="font-weight:bold; font-family:monospace; color:#fa383e;">0 đ</span><br><small style="color:#8c939d;">(0 HT)</small>`;
                }
              } catch (e) {
                console.error("Lỗi tính CPL:", e);
              }

              // --- 1. TẠO LOGIC HIỂN THỊ CỘT "QUY TẮC" ---
              const localPriceVal = local.maxPrice ?? local.maxCpr ?? 0;
              const isUsingLocal =
                local.maxSpend > 0 || localPriceVal > 0 || local.maxCpm > 0;
              const ruleStatusHtml = isUsingLocal
                ? `<td style="text-align:center;"><span style="background:#e7f3ff; color:#1877f2; padding:3px 8px; border-radius:10px; font-size:10px; font-weight:bold; border:1px solid #1877f2;">🛠️ CẤU HÌNH RIÊNG</span><br><small style="font-size:9px; color:#606770;">(${local.maxSpend}|${localPriceVal}|${local.maxCpm})</small></td>`
                : `<td style="text-align:center;"><span style="background:#f0f2f5; color:#606770; padding:3px 8px; border-radius:10px; font-size:10px; font-weight:bold; border:1px solid #dddfe2;">🌐 CHUNG (MẶC ĐỊNH)</span></td>`;

              // --- 2. CHÈN CỘT VÀO HTML CỦA BẢNG ---
              // Ô CPC (chế độ "Kết hợp CPC") — chỉ hiện khi bật chế độ combo
              const apComboOn =
                document.getElementById("apUseCpcCombo")?.checked === true ||
                window.autoPauseConfig?.useCpcCombo === true;
              const apGlobalMaxCpc =
                parseFloat(document.getElementById("apMaxCpc")?.value) || 800;
              const apCpcInputHtml = apComboOn
                ? `<input type="number" class="local-cpc" title="Ngưỡng CPC (chế độ Kết hợp CPC)" placeholder="CPC" style="width:60px; border: 1px solid #e0a458; border-radius: 4px;" value="${local.maxCpc || apGlobalMaxCpc}">`
                : "";
              tbody.innerHTML += `
        <tr>
            <td style="text-align:center;"><input type="checkbox" class="ap-checkbox" value="${adset.id}" style="width:16px; height:16px; cursor:pointer;"></td>
            <td style="font-size:11px; color:#606770">${accName}</td>
            <td style="color:#1877f2; font-size:12px; font-weight:bold;">${adset.campaign?.name || "N/A"}</td>
            <td style="font-weight:bold; font-size:13px;">${adset.name}</td>
            <td style="color:#d97706; font-weight:bold; font-family:monospace;">${spendVal.toLocaleString("vi-VN")} đ</td>
            <td style="color:#fa383e; font-weight:bold; font-family:monospace;">${priceNum.toLocaleString("vi-VN")} đ</td>
            <td data-cpl="${adset.id}" style="font-size:11px; text-align:center;">${cplDisplay}</td>
            <td style="color:#fa383e; font-weight:bold; font-family:monospace;">${Math.floor(cpmVal).toLocaleString("vi-VN")} đ</td>

            ${ruleStatusHtml} <td>
                <div style="display: flex; gap: 4px; align-items: center; justify-content: center;">
                    <input type="number" class="local-spend" title="Ngưỡng tiêu" placeholder="Tiền" style="width:60px; border: 1px solid #ddd; border-radius: 4px;" value="${local.maxSpend}">
                    <input type="number" class="local-price" title="Giá mỗi kết quả (CPR/CPL/CPC)" placeholder="Giá" style="width:90px; border: 1px solid #ddd; border-radius: 4px;" value="${local.maxPrice ?? local.maxCpr}">
                    ${apCpcInputHtml}
                    <input type="number" class="local-cpm" title="Ngưỡng CPM" placeholder="CPM" style="width:60px; border: 1px solid #ddd; border-radius: 4px;" value="${local.maxCpm}">
                    <button class="btn-save-local" data-id="${adset.id}" style="padding: 4px 8px; font-size: 11px; cursor: pointer; background: #1877f2; color: #fff; border: none; border-radius: 4px;">Lưu</button>
                     <button
    class="btn-reset-local"
    data-id="${adset.id}"
    style="background:#f56b2a; color:white; border:none; padding:4px 8px; border-radius:4px; cursor:pointer;">
    Reset
</button>
                </div>
            </td>
        </tr>
    `;
            }
          }
        } catch (e) {
          console.error(e);
        }
      }
      document.getElementById("apLoading").style.display = "none";
      if (tbody.innerHTML === "")
        tbody.innerHTML =
          '<tr><td colspan="6" style="text-align:center;">Không có nhóm nào đang chạy.</td></tr>';
    });

  document.getElementById("apSelectAll")?.addEventListener("change", (e) => {
    document
      .querySelectorAll(".ap-checkbox")
      .forEach((cb) => (cb.checked = e.target.checked));
  });

  document.addEventListener("click", function (e) {
    // Kiểm tra xem cái sếp vừa bấm có phải là nút Lưu không
    if (e.target && e.target.classList.contains("btn-save-local")) {
      const adsetId = e.target.getAttribute("data-id");
      const btn = e.target;

      // Gọi hàm xử lý lưu (vẫn dùng hàm saveLocalConfig sếp đã viết)
      window.saveLocalConfig(adsetId, btn);
    }
    if (e.target.classList.contains("btn-reset-local")) {
      const adsetId = e.target.getAttribute("data-id");
      resetLocalConfig(adsetId, e.target);
    }
  });

  // Tự động lưu & khôi phục trạng thái Cài đặt Auto-Pause & CPL
  const apUseCplEl = document.getElementById("apUseCpl");
  if (apUseCplEl) {
    const savedUseCpl = localStorage.getItem("fb_ap_use_cpl");
    if (savedUseCpl !== null) {
      apUseCplEl.checked = savedUseCpl === "true";
      window.autoPauseConfig.useCpl = apUseCplEl.checked;
    }
    apUseCplEl.addEventListener("change", () => {
      localStorage.setItem("fb_ap_use_cpl", apUseCplEl.checked);
      window.autoPauseConfig.useCpl = apUseCplEl.checked;
      // Đồng bộ cờ chế độ CPL sang bảng "Tắt Camp Tự Động"
      const ccCpl = document.getElementById("ccUseCpl");
      if (ccCpl && ccCpl.checked !== apUseCplEl.checked) {
        ccCpl.checked = apUseCplEl.checked;
        ccCpl.dispatchEvent(new Event("change", { bubbles: true }));
      }
      console.log(
        `📣 [Auto-Pause] Chế độ CPL: ${apUseCplEl.checked ? "BẬT" : "TẮT"}`,
      );
    });
  }

  // Tự động lưu & khôi phục trạng thái Cài đặt CPC
  const apUseCpcEl = document.getElementById("apUseCpc");
  if (apUseCpcEl) {
    const savedUseCpc = localStorage.getItem("fb_ap_use_cpc");
    if (savedUseCpc !== null) {
      apUseCpcEl.checked = savedUseCpc === "true";
      window.autoPauseConfig.useCpc = apUseCpcEl.checked;
    }
    apUseCpcEl.addEventListener("change", () => {
      localStorage.setItem("fb_ap_use_cpc", apUseCpcEl.checked);
      window.autoPauseConfig.useCpc = apUseCpcEl.checked;
      // Đồng bộ cờ chế độ CPC sang bảng "Tắt Camp Tự Động"
      const ccCpc = document.getElementById("ccUseCpc");
      if (ccCpc && ccCpc.checked !== apUseCpcEl.checked) {
        ccCpc.checked = apUseCpcEl.checked;
        ccCpc.dispatchEvent(new Event("change", { bubbles: true }));
      }
      // CPC và CPR độc lập, có thể dùng đồng thời
      console.log(
        `🖱️ [Auto-Pause] Chế độ CPC: ${apUseCpcEl.checked ? "BẬT" : "TẮT"}`,
      );
    });
  }

  // 🔀 Tự động lưu & khôi phục chế độ "KẾT HỢP CPC"
  // (CPC là điều kiện RIÊNG với ngưỡng maxCpc → cần đủ 4 điều kiện mới tắt camp)
  const apUseCpcComboEl = document.getElementById("apUseCpcCombo");
  if (apUseCpcComboEl) {
    const savedUseCpcCombo = localStorage.getItem("fb_ap_use_cpc_combo");
    if (savedUseCpcCombo !== null) {
      apUseCpcComboEl.checked = savedUseCpcCombo === "true";
      window.autoPauseConfig.useCpcCombo = apUseCpcComboEl.checked;
    }
    apUseCpcComboEl.addEventListener("change", () => {
      localStorage.setItem("fb_ap_use_cpc_combo", apUseCpcComboEl.checked);
      window.autoPauseConfig.useCpcCombo = apUseCpcComboEl.checked;
      // Đồng bộ cờ sang bảng "Tắt Camp Tự Động"
      const ccCombo = document.getElementById("ccUseCpcCombo");
      if (ccCombo && ccCombo.checked !== apUseCpcComboEl.checked) {
        ccCombo.checked = apUseCpcComboEl.checked;
        ccCombo.dispatchEvent(new Event("change", { bubbles: true }));
      }
      // Ẩn/hiện ô ngưỡng CPC toàn cục
      const apCpcCol = document.getElementById("apMaxCpcCol");
      if (apCpcCol) apCpcCol.style.display = apUseCpcComboEl.checked ? "" : "none";
      console.log(
        `🔀 [Auto-Pause] Chế độ Kết hợp CPC: ${apUseCpcComboEl.checked ? "BẬT" : "TẮT"}`,
      );
    });
    // Áp dụng trạng thái hiển thị ban đầu
    const apCpcColInit = document.getElementById("apMaxCpcCol");
    if (apCpcColInit)
      apCpcColInit.style.display = apUseCpcComboEl.checked ? "" : "none";
  }

  ["apMaxSpend", "apMaxPrice", "apMaxCpm", "apMaxCpc"].forEach((inpId) => {
    const el = document.getElementById(inpId);
    if (el) {
      // Ưu tiên key mới, nếu không có thì fallback key cũ (trước khi gộp ô)
      let savedVal = localStorage.getItem(`fb_${inpId}`);
      if (
        savedVal === null &&
        inpId === "apMaxPrice" &&
        !window.localStorage.getItem(`fb_apMaxPrice`)
      ) {
        const oldCpr = localStorage.getItem("fb_apMaxCpr");
        const oldCpc = localStorage.getItem("fb_apMaxCpc");
        if (oldCpr) savedVal = oldCpr;
        else if (oldCpc) savedVal = oldCpc;
      }
      // Ô ngưỡng CPC dùng key riêng để không đụng key cũ "fb_apMaxCpc"
      // (key cũ này là fallback của maxPrice)
      if (inpId === "apMaxCpc") {
        savedVal = localStorage.getItem("fb_apMaxCpcLimit");
      }
      if (savedVal) el.value = savedVal;
      el.addEventListener("input", () => {
        localStorage.setItem(
          inpId === "apMaxCpc" ? "fb_apMaxCpcLimit" : `fb_${inpId}`,
          el.value,
        );
        // Đồng bộ ngưỡng chung sang bảng "Tắt Camp Tự Động"
        const ccMap = {
          apMaxSpend: "ccMaxSpend",
          apMaxPrice: "ccMaxPrice",
          apMaxCpm: "ccMaxCpm",
          apMaxCpc: "ccMaxCpc",
        };
        const ccEl = document.getElementById(ccMap[inpId]);
        if (ccEl && ccEl.value !== el.value) ccEl.value = el.value;
        ccEl?.dispatchEvent(new Event("change", { bubbles: true }));
        if (typeof window.careCampRefreshThresholds === "function") {
          window.careCampRefreshThresholds();
        }
      });
    }
  });

  document.getElementById("btn-start-ap")?.addEventListener("click", () => {
    const checkedBoxes = document.querySelectorAll(".ap-checkbox:checked");
    if (checkedBoxes.length === 0)
      return alert("⚠️ Vui lòng tích chọn ít nhất 1 Nhóm để giám sát!");

    const getNum = (id, fallback) => {
      const el = document.getElementById(id);
      const v = el ? parseFloat(el.value) : NaN;
      return Number.isFinite(v) ? v : fallback;
    };
    window.autoPauseConfig.maxSpend = getNum("apMaxSpend", 10000);
    window.autoPauseConfig.maxCpm = getNum("apMaxCpm", 40000);
    window.autoPauseConfig.maxPrice = getNum("apMaxPrice", 12000);
    // Sanity check: đảm bảo không có NaN (phòng khi HTML bị thiếu id)
    ["maxSpend", "maxCpm", "maxPrice"].forEach((k) => {
      if (!Number.isFinite(window.autoPauseConfig[k])) {
        window.autoPauseConfig[k] = 0;
      }
    });
    window.autoPauseConfig.useCpl =
      document.getElementById("apUseCpl")?.checked || false;
    window.autoPauseConfig.useCpc =
      document.getElementById("apUseCpc")?.checked || false;
    window.autoPauseConfig.useCpcCombo =
      document.getElementById("apUseCpcCombo")?.checked || false;
    window.autoPauseConfig.maxCpc = getNum("apMaxCpc", 800);
    window.autoPauseConfig.adsetIds = Array.from(checkedBoxes).map(
      (cb) => cb.value,
    );
    window.autoPauseConfig.isRunning = true;

    // (F) Ghi cấu hình Auto-Pause vào storage → background đọc để quét.
    //     Đây là nơi DUY NHẤT quyết định tắt nhóm cho bảng Auto-Pause;
    //     background (camp_core.js) thực thi, không tự quyết định.
    window.CampCore?.setAutoPauseState?.({
      isRunning: true,
      adsetIds: window.autoPauseConfig.adsetIds.map(String),
      maxSpend: window.autoPauseConfig.maxSpend,
      maxPrice: window.autoPauseConfig.maxPrice,
      maxCpm: window.autoPauseConfig.maxCpm,
      maxCpc: window.autoPauseConfig.maxCpc,
      useCpl: window.autoPauseConfig.useCpl,
      useCpc: window.autoPauseConfig.useCpc,
      useCpcCombo: window.autoPauseConfig.useCpcCombo,
    });

    document.getElementById("btn-start-ap").style.display = "none";
    document.getElementById("btn-stop-ap").style.display = "block";
    // Ưu tiên Kết hợp CPC > CPC > CPL > CPR để hiển thị chế độ giá chính
    let modeText;
    if (window.autoPauseConfig.useCpcCombo) {
      modeText = "KẾT HỢP CPC (CPL + CPC — cần đủ 4 điều kiện)";
    } else if (window.autoPauseConfig.useCpc) {
      modeText = "CPC (Chi phí / Click Link)";
    } else if (window.autoPauseConfig.useCpl) {
      modeText = "CPL (Chi phí / Hội thoại mới từ Inbox)";
    } else {
      modeText = "CPR (Chi phí / Kết quả QC)";
    }
    const priceLimitText = `${window.autoPauseConfig.maxPrice.toLocaleString()}đ (CPR/CPL/CPC)`;
    const comboConditionText = window.autoPauseConfig.useCpcCombo
      ? `\nTiêu > ${window.autoPauseConfig.maxSpend.toLocaleString()}đ VÀ Giá > ${priceLimitText} VÀ CPC > ${window.autoPauseConfig.maxCpc.toLocaleString()}đ VÀ CPM > ${window.autoPauseConfig.maxCpm.toLocaleString()}đ`
      : `\nTiêu > ${window.autoPauseConfig.maxSpend.toLocaleString()}đ VÀ Giá > ${priceLimitText} VÀ CPM > ${window.autoPauseConfig.maxCpm.toLocaleString()}đ`;
    alert(
      `✅ Đã lưu cấu hình!\nHệ thống đang giám sát ${window.autoPauseConfig.adsetIds.length} nhóm.\nChế độ giá: ${modeText}\nSẽ tự động tắt khi:${comboConditionText}`,
    );

    // Nếu dùng CPL/CPC, bắt đầu interval poll inbox định kỳ
    if (
      window.autoPauseConfig.useCpl ||
      window.autoPauseConfig.useCpc ||
      window.autoPauseConfig.useCpcCombo
    ) {
      if (window.apInboxPollInterval) clearInterval(window.apInboxPollInterval);

      // Poll inbox ngay lập tức (1 lần khi bật)
      chrome.runtime?.sendMessage?.({ type: "inbox-poll-now" }, () => {
        void chrome.runtime?.lastError;
      });

      // ❌ TẮT setInterval riêng của AutoPause
      // Lý do: background.js alarm 1 phút đã poll đủ để giữ cache mới.
      // countInboxConversationsByTag() đọc từ inboxBgCache (background poll).
      // Tiết kiệm 30 batch calls/giờ = -33% API usage.
      // AutoPause vẫn hoạt động vì CPL đọc từ cache, không cần poll riêng.
      //
      // Nếu muốn poll nhanh hơn cho CPL (2 phút), bỏ comment dưới:
      // window.apInboxPollInterval = setInterval(
      //   () => {
      //     if (
      //       window.autoPauseConfig?.isRunning &&
      //       (window.autoPauseConfig?.useCpl || window.autoPauseConfig?.useCpc)
      //     ) {
      //       chrome.runtime?.sendMessage?.({ type: "inbox-poll-now" }, () => {
      //         void chrome.runtime?.lastError;
      //       });
      //     }
      //   },
      //   2 * 60 * 1000,
      // );
    }
  });

  document.getElementById("btn-stop-ap")?.addEventListener("click", () => {
    window.autoPauseConfig.isRunning = false;
    document.getElementById("btn-start-ap").style.display = "block";
    document.getElementById("btn-stop-ap").style.display = "none";

    // (F) Cập nhật storage → background biết đã dừng theo dõi
    window.CampCore?.setAutoPauseState?.({
      isRunning: false,
      adsetIds: [],
    });

    // Dừng interval poll inbox
    if (window.apInboxPollInterval) {
      clearInterval(window.apInboxPollInterval);
      window.apInboxPollInterval = null;
    }

    alert("🛑 Đã dừng giám sát!");
  });
  // ==========================================
  // PHẦN 4: CÁC TÍNH NĂNG MỞ RỘNG (BM, SHARE, SPY)
  // ==========================================

  document
    .getElementById("btn-fetch-smit-accounts")
    ?.addEventListener("click", async () => {
      const token = document.getElementById("tokenInput").value;
      if (!token)
        return alert("⚠️ Vui lòng Lấy Token ở Trang Bảng Chỉ Số trước!");
      const tbody = document.getElementById("smitAccountsBody");
      tbody.innerHTML =
        '<tr><td colspan="6" style="text-align:center; color:#d97706; font-weight:bold;">⏳ Đang kéo danh sách...</td></tr>';

      try {
        const res = await fetch(
          `https://graph.facebook.com/v20.0/me/adaccounts?fields=account_id,name,account_status,permitted_roles,owner_business,currency&limit=500&access_token=${token}`,
        );
        const data = await res.json();

        if (data.data && data.data.length > 0) {
          tbody.innerHTML = "";
          data.data.forEach((acc) => {
            const name = acc.name || `Tài khoản ${acc.account_id}`;
            const id = acc.account_id;

            let statusHtml =
              acc.account_status === 1
                ? '<span style="color:#31a24c; font-weight:bold;">● Hoạt động</span>'
                : acc.account_status === 2
                  ? '<span style="color:#fa383e; font-weight:bold;">● Vô hiệu hóa</span>'
                  : acc.account_status === 3
                    ? '<span style="color:#d97706; font-weight:bold;">● Nợ tiền</span>'
                    : `<span style="color:#606770; font-weight:bold;">● Khác (${acc.account_status})</span>`;
            let role = acc.permitted_roles
              ? acc.permitted_roles.includes("ADMIN")
                ? "ADMIN"
                : "ADVERTISER"
              : "Bị ẩn";
            const type = acc.owner_business ? "Doanh nghiệp" : "Cá nhân";

            tbody.innerHTML += `<tr>
                        <td><div style="font-weight:bold; font-size:13px; color:#1877f2;" id="smit-name-${id}">${name}</div><div style="font-size:11px; color:#606770; font-family:monospace;">${id}</div></td>
                        <td>${statusHtml}</td><td style="font-family: monospace; color:#4b4f56;">${role}</td><td style="color:#1c1e21;">${type}</td><td style="font-family:monospace; color:#1c1e21;">${acc.currency || "N/A"}</td>
                        <td>
                            <button class="btn btn-blue btn-view-camp" data-id="${id}" data-name="${name}" style="padding: 6px 12px; font-size:11px; border-radius: 4px; margin-right: 5px;">👁️ XEM C.DỊCH</button>
                            <button class="btn btn-orange btn-rename-acc" data-id="${id}" data-name="${name}" style="padding: 6px 12px; font-size:11px; border-radius: 4px;">✏️ ĐỔI TÊN</button>
                        </td>
                    </tr>`;
          });
        } else {
          tbody.innerHTML =
            '<tr><td colspan="6" style="text-align:center; color:#c92a2a; font-weight:bold;">❌ Không tìm thấy TKQC nào.</td></tr>';
        }
      } catch (e) {
        tbody.innerHTML =
          '<tr><td colspan="6" style="text-align:center; color:#c92a2a; font-weight:bold;">❌ Lỗi mạng!</td></tr>';
      }
    });

  document
    .getElementById("smitAccountsBody")
    ?.addEventListener("click", async (e) => {
      if (e.target.classList.contains("btn-view-camp")) {
        const id = e.target.getAttribute("data-id");
        const name = e.target.getAttribute("data-name");
        window.fetchAccountCampaigns(id, name);
      }

      if (e.target.classList.contains("btn-rename-acc")) {
        const token = document.getElementById("tokenInput").value;
        const id = e.target.getAttribute("data-id");
        const oldName = e.target.getAttribute("data-name");
        const newName = prompt(`Nhập Tên mới cho Tài Khoản ${id}:`, oldName);
        if (newName !== null && newName.trim() !== "" && newName !== oldName) {
          e.target.innerText = "⏳...";
          try {
            const res = await fetch(
              `https://graph.facebook.com/v20.0/act_${id}`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: `name=${encodeURIComponent(newName)}&access_token=${token}`,
              },
            );
            const data = await res.json();
            if (data.success || data.id) {
              alert("✅ Đổi tên THÀNH CÔNG!");
              document.getElementById(`smit-name-${id}`).innerText = newName;
              e.target.setAttribute("data-name", newName);
            } else {
              alert(
                "❌ ĐỔI TÊN THẤT BẠI: " +
                  (data.error ? data.error.message : "Chưa rõ."),
              );
            }
          } catch (err) {
            alert("❌ Lỗi mạng!");
          }
          e.target.innerText = "✏️ ĐỔI TÊN";
        }
      }
    });

  document
    .getElementById("btn-fetch-bms")
    ?.addEventListener("click", async () => {
      const token = document.getElementById("tokenInput").value;
      if (!token) return alert("⚠️ Vui lòng Lấy Token!");

      const tbody = document.getElementById("bmListBody");
      tbody.innerHTML =
        '<tr><td colspan="13" style="text-align:center; color:#d97706; font-weight:bold;">⏳ Đang quét Business Manager...</td></tr>';
      document.getElementById("bmAdAccountsPanel").style.display = "none";

      try {
        const url = `https://graph.facebook.com/v20.0/me/businesses?fields=id,name,verification_status,sharing_eligibility_status,ad_account_creation_request_quota,created_time,client_ad_accounts.limit(1).summary(true){currency,timezone_name,adtrust_dsl},owned_ad_accounts.limit(1).summary(true){currency,timezone_name,adtrust_dsl},business_users.limit(0).summary(true)&limit=100&access_token=${token}`;
        const res = await fetch(url);
        const data = await res.json();

        if (data.error) {
          tbody.innerHTML = `<tr><td colspan="13" style="text-align:center; color:#c92a2a; font-weight:bold;">❌ Lỗi API: ${data.error.message}</td></tr>`;
          return;
        }

        if (data.data && data.data.length > 0) {
          tbody.innerHTML = "";
          data.data.forEach((bm, index) => {
            let verif =
              bm.verification_status === "verified"
                ? '<span style="color:#31a24c; font-weight:bold;">Đã XMDN</span>'
                : '<span style="color:#606770;">Chưa XMDN</span>';
            let status =
              '<span style="color:#31a24c; font-weight:bold;">Live</span>';
            if (
              bm.sharing_eligibility_status === "restricted" ||
              bm.sharing_eligibility_status === "disabled"
            ) {
              status =
                '<span style="color:#fa383e; font-weight:bold;">Vô hiệu hóa</span>';
            }

            let ownedCount =
              bm.owned_ad_accounts && bm.owned_ad_accounts.summary
                ? bm.owned_ad_accounts.summary.total_count
                : 0;
            let clientCount =
              bm.client_ad_accounts && bm.client_ad_accounts.summary
                ? bm.client_ad_accounts.summary.total_count
                : 0;
            let totalActs = ownedCount + clientCount;
            let adminCount =
              bm.business_users && bm.business_users.summary
                ? bm.business_users.summary.total_count
                : "Ẩn";
            let bmType = bm.ad_account_creation_request_quota || "0";
            let created = bm.created_time
              ? bm.created_time.split("T")[0]
              : "N/A";

            let limitBM = "Ẩn",
              currBM = "N/A",
              timezoneBM = "N/A";
            let sampleAct = null;
            if (
              bm.owned_ad_accounts &&
              bm.owned_ad_accounts.data &&
              bm.owned_ad_accounts.data.length > 0
            )
              sampleAct = bm.owned_ad_accounts.data[0];
            else if (
              bm.client_ad_accounts &&
              bm.client_ad_accounts.data &&
              bm.client_ad_accounts.data.length > 0
            )
              sampleAct = bm.client_ad_accounts.data[0];

            if (sampleAct) {
              currBM = sampleAct.currency || "N/A";
              timezoneBM = sampleAct.timezone_name || "N/A";
              if (sampleAct.adtrust_dsl)
                limitBM =
                  sampleAct.adtrust_dsl == -1
                    ? "No Limit"
                    : formatMoney(sampleAct.adtrust_dsl, false);
            }

            tbody.innerHTML += `
                        <tr>
                            <td style="text-align:center; font-weight:bold; color:#1c1e21;">${index + 1}</td>
                            <td>${status}</td>
                            <td style="font-family:monospace; color:#4b4f56;">${bm.id}</td>
                            <td style="font-weight:bold; color:#1c1e21;">${bm.name}</td>
                            <td style="text-align:center; font-family:monospace; color:#d97706; font-weight:bold;">${bmType}</td>
                            <td style="text-align:center; font-weight:bold; color:#d97706;">${totalActs}</td>
                            <td style="text-align:center; color:#1c1e21;">${adminCount}</td>
                            <td style="text-align:center;">${verif}</td>
                            <td style="text-align:right; color:#137333; font-weight:bold;">${limitBM}</td>
                            <td style="text-align:center; font-family:monospace; color:#1c1e21;">${currBM}</td>
                            <td style="text-align:right;"><span style="font-size:11px; color:#606770;">${timezoneBM}</span></td>
                            <td style="text-align:right;"><span style="font-size:11px; color:#606770;">${created}</span></td>
                            <td style="text-align:center;">
                                <a href="https://business.facebook.com/settings/people?business_id=${bm.id}" target="_blank" class="btn btn-green" style="padding: 6px 12px; font-size:11px; border-radius:4px; margin-right:5px; text-decoration:none; display:inline-block;">MỜI USER</a>
                                <button class="btn btn-orange btn-view-bm-acts" data-id="${bm.id}" data-name="${bm.name}" style="padding: 6px 12px; font-size:11px; border-radius:4px; display:inline-block;">👁️ XEM TKQC</button>
                            </td>
                        </tr>
                    `;
          });
        } else {
          tbody.innerHTML =
            '<tr><td colspan="13" style="text-align:center; color:#c92a2a; font-weight:bold;">❌ Via không cầm BM nào.</td></tr>';
        }
      } catch (e) {
        tbody.innerHTML =
          '<tr><td colspan="13" style="text-align:center; color:#c92a2a; font-weight:bold;">❌ Lỗi mạng!</td></tr>';
      }
    });

  document
    .getElementById("bmListBody")
    ?.addEventListener("click", async (e) => {
      if (e.target.classList.contains("btn-view-bm-acts")) {
        const token = document.getElementById("tokenInput").value;
        const bmId = e.target.getAttribute("data-id");
        const bmName = e.target.getAttribute("data-name");

        document.getElementById("currentBmName").innerText = `[${bmName}]`;
        document.getElementById("currentBmIdHidden").value = bmId;
        const panel = document.getElementById("bmAdAccountsPanel");
        const tbody = document.getElementById("bmAdAccountsBody");

        panel.style.display = "block";
        tbody.innerHTML =
          '<tr><td colspan="15" style="text-align:center; color:#d97706; font-weight:bold;">⏳ Đang cào toàn bộ data TKQC từ BM...</td></tr>';

        try {
          const actFields =
            "account_id,name,account_status,currency,balance,spend_cap,amount_spent,adtrust_dsl,timezone_name,created_time,owner_business,funding_source_details,current_unbilled_spend,permitted_roles,users.limit(0).summary(true)";
          const [ownedRes, clientRes] = await Promise.all([
            fetch(
              `https://graph.facebook.com/v20.0/${bmId}/owned_ad_accounts?fields=${actFields}&limit=200&access_token=${token}`,
            ),
            fetch(
              `https://graph.facebook.com/v20.0/${bmId}/client_ad_accounts?fields=${actFields}&limit=200&access_token=${token}`,
            ),
          ]);

          const ownedData = await ownedRes.json();
          const clientData = await clientRes.json();
          let allActs = [];
          if (ownedData.data) allActs = allActs.concat(ownedData.data);
          if (clientData.data) allActs = allActs.concat(clientData.data);

          const uniqueActs = Array.from(
            new Map(allActs.map((item) => [item.account_id, item])).values(),
          );

          if (uniqueActs.length > 0) {
            tbody.innerHTML = "";
            uniqueActs.forEach((acc) => {
              const name = acc.name || `Tài khoản ${acc.account_id}`;
              const id = acc.account_id;
              const curr = acc.currency || "N/A";

              let statusHtml =
                acc.account_status === 1
                  ? '<span style="color:#31a24c; font-weight:bold;">Hoạt động</span>'
                  : acc.account_status === 2
                    ? '<span style="color:#fa383e; font-weight:bold;">Vô hiệu hóa</span>'
                    : acc.account_status === 3
                      ? '<span style="color:#d97706; font-weight:bold;">Nợ tiền</span>'
                      : `<span style="color:#606770; font-weight:bold;">Khác (${acc.account_status})</span>`;
              let owner =
                acc.owner_business && acc.owner_business.id
                  ? acc.owner_business.id
                  : "Cá Nhân";
              let typeTK = acc.owner_business ? "Doanh nghiệp" : "Cá nhân";
              let role = acc.permitted_roles
                ? acc.permitted_roles.includes("ADMIN")
                  ? "ADMIN"
                  : "ADVERTISER"
                : "Ẩn";
              let qtvCount =
                acc.users && acc.users.summary
                  ? acc.users.summary.total_count
                  : "0";

              let payment = "N/A";
              if (
                acc.funding_source_details &&
                acc.funding_source_details.length > 0
              ) {
                payment =
                  acc.funding_source_details[0].display_string || "Đã add thẻ";
              }

              let balance = "0";
              let isDebt = false;
              if (
                acc.current_unbilled_spend &&
                acc.current_unbilled_spend.amount
              ) {
                let debt = parseFloat(acc.current_unbilled_spend.amount);
                if (debt > 0) {
                  balance = formatMoney(debt, false);
                  isDebt = true;
                }
              } else if (acc.balance) {
                let debt = parseFloat(acc.balance);
                if (debt > 0) {
                  balance = formatMoney(debt, true);
                  isDebt = true;
                }
              }

              let balanceHtml = isDebt
                ? `<span style="color:#c92a2a; font-weight:bold;">${balance} (Nợ)</span>`
                : `<span style="color:#137333; font-weight:bold;">0</span>`;
              let spendHtml = acc.amount_spent
                ? formatMoney(acc.amount_spent, true)
                : `0`;
              let limitHtml = acc.adtrust_dsl
                ? acc.adtrust_dsl == -1
                  ? "Không giới hạn"
                  : formatMoney(acc.adtrust_dsl, false)
                : "Ẩn";

              let timezone = acc.timezone_name || "N/A";
              let created = acc.created_time
                ? acc.created_time.split("T")[0]
                : "N/A";

              tbody.innerHTML += `
                            <tr>
                                <td>${statusHtml}</td>
                                <td style="text-align:center;">
                                    <button class="btn btn-blue btn-open-share-act" data-id="${id}" data-name="${name}" style="padding: 6px 10px; font-size:11px; border-radius:4px; cursor:pointer; font-weight:bold;">🤝 GÁN QUYỀN</button>
                                </td>
                                <td style="font-family:monospace; color:#4b4f56;">${id}</td>
                                <td><span style="font-size:11px; color:#606770;">${owner}</span></td>
                                <td style="font-weight:bold; color:#1c1e21;">${name}</td>
                                <td style="text-align:right;">${balanceHtml}</td>
                                <td style="color:#137333; font-weight:bold; text-align:right;">${limitHtml}</td>
                                <td style="color:#d97706; text-align:right; font-weight:bold;">${spendHtml}</td>
                                <td style="text-align:center; font-family:monospace; color:#1c1e21;">${qtvCount}</td>
                                <td style="font-family:monospace; text-align:center; color:#1c1e21;">${curr}</td>
                                <td style="text-align:center;"><span style="font-size:11px; color:#1c1e21;">${typeTK}</span></td>
                                <td style="text-align:center; font-weight:bold;"><span style="font-size:11px; color:#1877f2;">${role}</span></td>
                                <td style="text-align:center;"><span style="font-size:11px; font-family:monospace; color:#d97706;">${payment}</span></td>
                                <td style="text-align:right;"><span style="font-size:11px; color:#606770;">${timezone}</span></td>
                                <td style="text-align:right;"><span style="font-size:11px; color:#606770;">${created}</span></td>
                            </tr>
                        `;
            });
          } else {
            tbody.innerHTML =
              '<tr><td colspan="15" style="text-align:center; color:#c92a2a; font-weight:bold;">BM này trống, không chứa TKQC nào.</td></tr>';
          }
        } catch (err) {
          tbody.innerHTML =
            '<tr><td colspan="15" style="text-align:center; color:#c92a2a; font-weight:bold;">❌ Lỗi mạng hoặc Token không đủ quyền.</td></tr>';
        }
      }
    });

  let currentShareActId = null;
  document
    .getElementById("bmAdAccountsBody")
    ?.addEventListener("click", async (e) => {
      const btn = e.target.closest(".btn-open-share-act");
      if (btn) {
        const token = document.getElementById("tokenInput").value;
        currentShareActId = btn.getAttribute("data-id");
        const actName = btn.getAttribute("data-name");
        const bmId = document.getElementById("currentBmIdHidden").value;

        document.getElementById("shareTargetActName").innerText = actName;
        const selectBox = document.getElementById("shareBmUserSelect");
        selectBox.innerHTML =
          "<option disabled>⏳ Đang tải danh sách nhân sự BM...</option>";
        document.getElementById("shareAdActModal").style.display = "flex";

        try {
          const res = await fetch(
            `https://graph.facebook.com/v20.0/${bmId}/business_users?fields=id,name,email&limit=100&access_token=${token}`,
          );
          const data = await res.json();

          selectBox.innerHTML = "";
          if (data.data && data.data.length > 0) {
            data.data.forEach((user) => {
              let emailInfo = user.email ? `(${user.email})` : "";
              selectBox.innerHTML += `<option value="${user.id}">👤 ${user.name} ${emailInfo}</option>`;
            });
          } else {
            selectBox.innerHTML =
              "<option disabled>❌ Không tìm thấy User nào trong BM.</option>";
          }
        } catch (err) {
          selectBox.innerHTML =
            "<option disabled>❌ Lỗi load danh sách User BM.</option>";
        }
      }
    });

  document
    .getElementById("btn-submit-share-act")
    ?.addEventListener("click", async () => {
      const token = document.getElementById("tokenInput").value;
      const selectBox = document.getElementById("shareBmUserSelect");
      const selectedUsers = Array.from(selectBox.selectedOptions).map(
        (opt) => opt.value,
      );
      const btn = document.getElementById("btn-submit-share-act");

      if (!currentShareActId || selectedUsers.length === 0)
        return alert("Vui lòng chọn ít nhất 1 User!");
      btn.innerText = "⏳ Đang cấp quyền...";

      for (const userId of selectedUsers) {
        try {
          const res = await fetch(
            `https://graph.facebook.com/v20.0/act_${currentShareActId}/assigned_users`,
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: `user=${userId}&tasks=['MANAGE']&access_token=${token}`,
            },
          );
          const data = await res.json();
          if (data.success)
            alert(`✅ Đã cấp quyền ADMIN TKQC cho User ID: ${userId}`);
          else
            alert(
              `❌ Lỗi cấp quyền cho ${userId}: ${data.error?.message || "Chưa rõ"}`,
            );
        } catch (e) {
          alert(`❌ Lỗi mạng khi cấp quyền cho ${userId}`);
        }
      }
      btn.innerText = "Cấp quyền Quản trị viên (ADMIN)";
      document.getElementById("shareAdActModal").style.display = "none";
    });

  document
    .getElementById("btn-check-via")
    ?.addEventListener("click", async () => {
      const token = document.getElementById("tokenInput").value;
      if (!token) return alert("⚠️ Cần Token!");
      const resultBox = document.getElementById("via-result");
      resultBox.innerText = "⏳ Đang kiểm tra...";
      try {
        const actRes = await fetch(
          `https://graph.facebook.com/v20.0/me/adaccounts?fields=id&limit=100&access_token=${token}`,
        );
        const actData = await actRes.json();
        if (actData.data) {
          let name = "Ẩn",
            uid = "N/A";
          try {
            const meRes = await fetch(
              `https://graph.facebook.com/v20.0/me?fields=name,id&access_token=${token}`,
            );
            const meData = await meRes.json();
            if (meData.id) {
              name = meData.name;
              uid = meData.id;
            }
          } catch (e) {}
          resultBox.innerText = `✅ TOKEN LIVE!\n👤 Via: ${name}\n🆔 UID: ${uid}\n💼 Tổng TKQC trực tiếp: ${actData.data.length}`;
        } else resultBox.innerText = `❌ Lỗi: ${actData.error?.message}`;
      } catch (e) {
        resultBox.innerText = "❌ Lỗi mạng!";
      }
    });

  document.getElementById("btn-clean-cache")?.addEventListener("click", () => {
    if (confirm("⚠️ ĐĂNG XUẤT và xóa rác?"))
      chrome.browsingData.remove(
        { since: 0 },
        { appcache: true, cache: true, cookies: true, localStorage: true },
        () => location.reload(),
      );
  });

  chrome.storage.local.get(
    ["teleBotToken", "teleChatId", "teleThreshold", "teleEnable"],
    (res) => {
      if (res.teleBotToken)
        document.getElementById("teleBotToken").value = res.teleBotToken;
      if (res.teleChatId)
        document.getElementById("teleChatId").value = res.teleChatId;
      if (res.teleThreshold)
        document.getElementById("teleThreshold").value = res.teleThreshold;
      if (res.teleEnable)
        document.getElementById("teleEnable").checked = res.teleEnable;
    },
  );

  document.getElementById("btn-save-tele")?.addEventListener("click", () => {
    chrome.storage.local.set(
      {
        teleBotToken: document.getElementById("teleBotToken").value,
        teleChatId: document.getElementById("teleChatId").value,
        teleThreshold: document.getElementById("teleThreshold").value,
        teleEnable: document.getElementById("teleEnable").checked,
      },
      () => alert("✅ Đã lưu Automation!"),
    );
  });

  /* ================================================================
   * 🔔 CẤU HÌNH TELEGRAM CỦA BẠN (card trong trang Care Camp)
   * ------------------------------------------------------------
   * - Người dùng tự nhập BOT TOKEN + CHAT ID
   * - Không nhập / bấm "Về bot mặc định" → dùng bot Telegram mặc định
   * - Nguồn sự thật: window.TelegramConfig (telegram_config.js)
   * ============================================================== */
  (function initTelegramConfigUI() {
    const botInput = document.getElementById("ccTeleBotToken");
    const chatInput = document.getElementById("ccTeleChatId");
    const msgBox = document.getElementById("ccTeleMsg");
    const envInfo = document.getElementById("ccTeleEnvInfo");
    const saveBtn = document.getElementById("ccTeleSaveBtn");
    const testBtn = document.getElementById("ccTeleTestBtn");
    const resetBtn = document.getElementById("ccTeleResetBtn");

    // Không có card trong DOM → bỏ qua (ví dụ trang khác)
    if (!botInput || !chatInput) return;

    const CFG = window.TelegramConfig;

    /** Hiện thông báo trong card */
    function showMsg(text, type) {
      if (!msgBox) return;
      const colors = {
        ok: { bg: "#e7f8ed", color: "#31a24c" },
        err: { bg: "#ffe9e9", color: "#c92a2a" },
        info: { bg: "#e7f3ff", color: "#1877f2" },
      };
      const c = colors[type] || colors.info;
      msgBox.style.display = "block";
      msgBox.style.background = c.bg;
      msgBox.style.color = c.color;
      msgBox.textContent = text;
    }

    /** Cập nhật nhãn trạng thái: đang dùng bot mặc định hay bot riêng */
    function renderEnvInfo(cfg) {
      if (!envInfo) return;
      const botEl = document.getElementById("ccTeleEnvBot");
      const chatEl = document.getElementById("ccTeleEnvChat");

      if (cfg.isDefault) {
        envInfo.style.display = "block";
        if (botEl) botEl.textContent = "✅ có (bot mặc định)";
      } else {
        envInfo.style.display = "block";
        if (botEl) botEl.textContent = "✅ có (bot của bạn)";
      }

      if (chatEl) {
        chatEl.textContent = cfg.hasChatId ? "✅ có" : "❌ chưa có";
      }
    }

    /** Nạp cấu hình hiện tại vào form */
    async function loadIntoForm() {
      if (!CFG) {
        showMsg("⚠️ Không nạp được module TelegramConfig!", "err");
        return;
      }
      try {
        const cfg = await CFG.getConfig();
        botInput.value = cfg.rawBotToken || "";
        chatInput.value = cfg.rawChatId || "";
        renderEnvInfo(cfg);
      } catch (e) {
        console.warn("[TelegramConfig] Lỗi nạp cấu hình:", e);
      }
    }

    // ---- Nút Lưu cấu hình ----
    saveBtn?.addEventListener("click", async () => {
      if (!CFG) return showMsg("⚠️ Không nạp được module TelegramConfig!", "err");
      const bot = botInput.value.trim();
      const chat = chatInput.value.trim();

      // ⚠️ CHAT ID là BẮT BUỘC — không có chat ID mặc định
      if (!chat) {
        return showMsg(
          "⚠️ Thiếu TELEGRAM_CHAT_ID! Bắt buộc nhập chat ID nhận tin nhắn (có thể nhập nhiều, cách nhau dấu phẩy).",
          "err",
        );
      }

      try {
        const cfg = await CFG.saveConfig(bot, chat);
        renderEnvInfo(cfg);
        showMsg(
          cfg.isDefault
            ? "✅ Đã lưu! Đang dùng bot mặc định @syncOrdersBOT_bot với chat ID của bạn."
            : "✅ Đã lưu cấu hình Telegram của bạn!",
          "ok",
        );
      } catch (e) {
        console.error("[TelegramConfig] Lỗi lưu:", e);
        showMsg(`❌ Lỗi lưu: ${e?.message || e}`, "err");
      }
    });

    // ---- Nút Gửi tin thử ----
    // Dùng cấu hình ĐANG GÕ trong form (không cần bấm "Lưu",
    // và không ghi đè cấu hình đã lưu trong storage).
    testBtn?.addEventListener("click", async () => {
      if (!CFG) return showMsg("⚠️ Không nạp được module TelegramConfig!", "err");

      const bot = botInput.value.trim();
      const chat = chatInput.value.trim();

      if (!chat) {
        return showMsg(
          "⚠️ Thiếu TELEGRAM_CHAT_ID! Bắt buộc nhập chat ID nhận tin nhắn.",
          "err",
        );
      }

      // Chat ID có thể nhập nhiều cái, phân tách bằng dấu phẩy
      const chatIds = chat
        ? chat
            .split(/[\s,;]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

      const original = testBtn.innerHTML;
      testBtn.disabled = true;
      testBtn.innerHTML = "⏳ Đang gửi...";

      try {
        const res = await CFG.sendMessageWith(
          "🧪 <b>TEST THÔNG BÁO TELEGRAM</b>\n\n" +
            "✅ Cấu hình Telegram của bạn đang hoạt động bình thường.\n" +
            "⏰ " +
            new Date().toLocaleString("vi-VN"),
          { botToken: bot, chatIds },
        );

        if (res.ok) {
          showMsg(
            `✅ Đã gửi tin thử thành công (${res.sent}/${res.total} chat)!`,
            "ok",
          );
        } else {
          showMsg(
            `❌ Gửi thất bại${res.error ? `: ${res.error}` : ""}. Kiểm tra lại BOT TOKEN / CHAT ID.`,
            "err",
          );
        }
      } catch (e) {
        console.error("[TelegramConfig] Lỗi gửi tin thử:", e);
        showMsg(`❌ Lỗi kết nối: ${e?.message || e}`, "err");
      } finally {
        testBtn.disabled = false;
        testBtn.innerHTML = original;
      }
    });

    // ---- Nút Về bot mặc định (@syncOrdersBOT_bot) ----
    //    Chỉ đổi về bot mặc định, GIỮ chat ID của người dùng
    resetBtn?.addEventListener("click", async () => {
      if (!CFG) return showMsg("⚠️ Không nạp được module TelegramConfig!", "err");
      if (
        !confirm(
          "🤖 Chuyển về bot mặc định @syncOrdersBOT_bot?\n\nBOT TOKEN của bạn sẽ bị xoá (chat ID được giữ nguyên).",
        )
      )
        return;

      try {
        const cfg = await CFG.resetBotToken();
        botInput.value = "";
        renderEnvInfo(cfg);
        showMsg("🤖 Đã chuyển về bot mặc định @syncOrdersBOT_bot!", "ok");
      } catch (e) {
        console.error("[TelegramConfig] Lỗi reset:", e);
        showMsg(`❌ Lỗi: ${e?.message || e}`, "err");
      }
    });

    // Nạp cấu hình hiện tại vào form
    loadIntoForm();
  })();

  document
    .getElementById("btn-scan-spy")
    ?.addEventListener("click", async () => {
      const token = document.getElementById("tokenInput").value;
      const ids = document
        .getElementById("spyIdInput")
        .value.split(/[\n,]+/)
        .map((s) => s.replace(/[^\w]/g, "").trim())
        .filter(Boolean);
      const grid = document.getElementById("spyGrid"),
        loading = document.getElementById("spyLoading");

      if (!token || ids.length === 0) return alert("⚠️ Thiếu data!");
      grid.innerHTML = "";
      loading.style.display = "block";

      for (const id of ids) {
        try {
          const url = `https://graph.facebook.com/v20.0/${id.startsWith("act_") ? id : "act_" + id}/ads?fields=name,creative{id,name,thumbnail_url,image_url,body},status&filtering=[{field:"status",operator:"IN",value:["ACTIVE"]}]&limit=20&access_token=${token}`;
          const res = await fetch(url);
          const data = await res.json();

          if (data.data) {
            data.data.forEach((ad) => {
              if (ad.creative && ad.creative.id) {
                const c = ad.creative;
                const mediaUrl =
                  c.thumbnail_url ||
                  c.image_url ||
                  "https://via.placeholder.com/300x200?text=No+Image";
                const bodyText = c.body
                  ? c.body.substring(0, 100) + "..."
                  : "Không có Text";
                const fullSpyUrl = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&id=${ad.id}&search_type=keyword_exact_phrase`;

                grid.innerHTML += `<div style="background: #fff; border: 1px solid #dddfe2; border-radius: 8px; width: 300px; padding: 15px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); display: flex; flex-direction: column;"><div style="font-size: 10px; color:#606770; margin-bottom:5px;">ID TK: ${id}</div><img src="${mediaUrl}" style="width: 100%; height: 180px; object-fit: cover; border-radius: 6px; margin-bottom: 10px;"><div style="font-size: 13px; font-weight: bold; margin-bottom: 5px; color:#1877f2;">${ad.name || "Ads"}</div><div style="font-size: 11px; color: #1c1e21; margin-bottom: 15px; flex: 1;">${bodyText}</div><a href="${fullSpyUrl}" target="_blank" class="btn btn-blue" style="text-align:center; text-decoration:none; font-size:12px;">👁️ Xem trên Thư viện Ads</a></div>`;
              }
            });
          }
        } catch (e) {}
      }
      loading.style.display = "none";
      if (grid.innerHTML === "")
        grid.innerHTML =
          '<p style="color:#fa383e;">Không tìm thấy quảng cáo đang chạy.</p>';
    });

  document
    .getElementById("btn-share-personal")
    ?.addEventListener("click", async () => {
      const token = document.getElementById("tokenInput").value;
      const actIds = document
        .getElementById("sharePersonalActIds")
        .value.split(/[\n,]+/)
        .map((s) => s.replace(/[^\w]/g, "").trim())
        .map((id) => (id.startsWith("act_") ? id : "act_" + id))
        .filter(Boolean);
      const uids = document
        .getElementById("sharePersonalUids")
        .value.split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const log = document.getElementById("log-share-personal");
      if (!token || actIds.length === 0 || uids.length === 0)
        return alert("⚠️ Điền đủ thông tin!");
      log.innerHTML = "⏳ Đang share...\n";
      for (const act of actIds) {
        for (const uid of uids) {
          try {
            const res = await fetch(
              `https://graph.facebook.com/v20.0/${act}/users`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: `uid=${uid}&role=281429548676632&access_token=${token}`,
              },
            );
            const data = await res.json();
            if (data.success) log.innerHTML += `✅ Xong ${act} -> UID ${uid}\n`;
            else
              log.innerHTML += `❌ Lỗi ${act} -> ${uid}: ${data.error?.message}\n`;
          } catch (e) {
            log.innerHTML += `❌ Lỗi mạng\n`;
          }
        }
      }
    });

  document
    .getElementById("btn-share-bm")
    ?.addEventListener("click", async () => {
      const token = document.getElementById("tokenInput").value;
      const actIds = document
        .getElementById("shareBmActIds")
        .value.split(/[\n,]+/)
        .map((s) => s.replace(/[^\w]/g, "").trim())
        .map((id) => (id.startsWith("act_") ? id : "act_" + id))
        .filter(Boolean);
      const bmUsers = document
        .getElementById("shareBmUserIds")
        .value.split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const log = document.getElementById("log-share-bm");
      if (!token || actIds.length === 0 || bmUsers.length === 0)
        return alert("⚠️ Điền đủ thông tin!");
      log.innerHTML = "⏳ Đang gán BM...\n";
      for (const act of actIds) {
        for (const bmUser of bmUsers) {
          try {
            const res = await fetch(
              `https://graph.facebook.com/v20.0/${act}/assigned_users`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: `user=${bmUser}&tasks=['MANAGE']&access_token=${token}`,
              },
            );
            const data = await res.json();
            if (data.success)
              log.innerHTML += `✅ Xong ${act} -> MemBM ${bmUser}\n`;
            else
              log.innerHTML += `❌ Lỗi ${act} -> ${bmUser}: ${data.error?.message}\n`;
          } catch (e) {
            log.innerHTML += `❌ Lỗi mạng\n`;
          }
        }
      }
    });

  document
    .getElementById("btn-share-page")
    ?.addEventListener("click", async () => {
      const token = document.getElementById("tokenInput").value.trim();
      const actorInput = document.getElementById("shareActorUids");
      const actorUidsRaw = actorInput ? actorInput.value : "";
      const actorUidsInput = actorUidsRaw
        .split(/[\n,]+/)
        .map((s) => extractUidFromLink(s) || s.trim())
        .filter(Boolean);
      const pageIds = document
        .getElementById("sharePageIds")
        .value.split(/[\n,]+/)
        .map((s) => s.replace(/[^\d]/g, "").trim())
        .filter(Boolean);
      const rawUidsInput = document
        .getElementById("sharePageUids")
        .value.split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const role = document.getElementById("sharePageRole").value;
      const log = document.getElementById("log-share-page");

      const uids = [];
      rawUidsInput.forEach((line) => {
        let cleanUid = extractUidFromLink(line) || line;
        if (cleanUid && cleanUid.length > 4 && !uids.includes(cleanUid))
          uids.push(cleanUid);
      });

      if (
        pageIds.length === 0 ||
        uids.length === 0 ||
        actorUidsInput.length === 0
      ) {
        return alert("⚠️ Vui lòng điền đủ: UID Via, Page ID và UID Sale nhận!");
      }

      log.innerHTML = `⏳ ĐANG KHỞI ĐỘNG HỆ THỐNG...\n`;

      if (token && token.startsWith("EAA")) {
        log.innerHTML += `💎 Chế độ: GRAPH API CHÍNH THỨC (Token)\n`;
        for (const page of pageIds) {
          log.innerHTML += `▶️ Đang xử lý Page: ${page}\n`;
          let pageToken = token;
          try {
            const res = await fetch(
              `https://graph.facebook.com/v20.0/${page}?fields=access_token&access_token=${token}`,
            );
            const data = await res.json();
            if (data.access_token) pageToken = data.access_token;
          } catch (e) {}

          for (let i = 0; i < uids.length; i++) {
            const uid = uids[i];
            try {
              const res = await fetch(
                `https://graph.facebook.com/v20.0/${page}/roles`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                  },
                  body: `user=${uid}&role=${role}&access_token=${pageToken}`,
                },
              );
              const data = await res.json();
              if (data.success || data.id) {
                log.innerHTML += `  ✅ THÀNH CÔNG: Page [${page}] → UID [${uid}]\n`;
              } else {
                log.innerHTML += `  ❌ LỖI: Page [${page}] → UID [${uid}]: ${data.error?.message || "Không rõ"}\n`;
              }
            } catch (e) {
              log.innerHTML += `  ❌ Lỗi mạng: Page [${page}] → UID [${uid}]\n`;
            }
            if (i < uids.length - 1)
              await new Promise((r) => setTimeout(r, 2500));
          }
        }
        log.innerHTML += `🎉 HOÀN THÀNH TOÀN BỘ BẰNG TOKEN!\n`;
        return;
      }

      log.innerHTML += `🕵️ Chế độ: GRAPHQL ẨN DANH\n`;
      let fb_dtsg = null;
      let currentUid = actorUidsInput[0];

      try {
        log.innerHTML += `🔍 Đang lấy mã bảo mật fb_dtsg...\n`;
        const urls = [
          "https://business.facebook.com/",
          "https://www.facebook.com/",
          "https://mbasic.facebook.com/",
        ];
        for (let url of urls) {
          try {
            const res = await fetch(url, {
              credentials: "include",
              headers: { Accept: "text/html" },
            });
            const html = await res.text();
            const dtsgMatch =
              html.match(/"DTSGInitialData",\[\],\{"token":"(.*?)"\}/) ||
              html.match(/\["DTSGInitialData",\[\],\{"token":"(.*?)"\}\]/) ||
              html.match(/name="fb_dtsg"\s*value="(.*?)"/i);
            if (dtsgMatch && dtsgMatch[1]) {
              fb_dtsg = dtsgMatch[1];
              log.innerHTML += `✅ Lấy fb_dtsg thành công\n`;
              break;
            }
          } catch (e) {}
        }
      } catch (e) {
        log.innerHTML += `❌ Lỗi kết nối lấy dữ liệu!\n`;
        return;
      }

      if (!fb_dtsg) {
        log.innerHTML += `❌ Chưa đăng nhập Facebook hoặc bị checkpoint!\n`;
        return;
      }

      log.innerHTML += `✅ Sẵn sàng đẩy lệnh (UID Bắt Buộc: ${currentUid})\n\n`;
      const adminType = role === "ADMIN" ? "FULL_CONTROL" : "STANDARD";
      const docId = "6022839274488812";

      for (const page of pageIds) {
        log.innerHTML += `▶️ Đang xử lý Page: ${page}\n`;
        for (let i = 0; i < uids.length; i++) {
          const uid = uids[i];
          try {
            const variables = {
              input: {
                additional_profile_id: page,
                admin_id: uid,
                admin_type: adminType,
                actor_id: currentUid,
                client_mutation_id: Math.random().toString(36).substr(2, 9),
              },
            };
            const body = new URLSearchParams({
              av: currentUid,
              __user: currentUid,
              __a: "1",
              fb_dtsg: fb_dtsg,
              fb_api_caller_class: "RelayModern",
              fb_api_req_friendly_name: "ProfilePlusAdminInviteMutation",
              variables: JSON.stringify(variables),
              server_timestamps: "true",
              doc_id: docId,
            });

            const res = await fetch("https://www.facebook.com/api/graphql/", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: body.toString(),
              credentials: "include",
            });
            const text = await res.text();

            if (
              (text.includes('"is_success":true') ||
                text.includes("success")) &&
              !text.includes('"errors":[')
            ) {
              log.innerHTML += `  ✅ THÀNH CÔNG: Page [${page}] → UID [${uid}]\n`;
            } else {
              const errMatch =
                text.match(/"description":"(.*?)"/i) ||
                text.match(/"message":"(.*?)"/i);
              const err = errMatch
                ? errMatch[1]
                : "Via không đủ quyền hoặc UID bị lỗi";
              log.innerHTML += `  ❌ LỖI: Page [${page}] → UID [${uid}]: ${err}\n`;
            }
          } catch (e) {
            log.innerHTML += `  ❌ Lỗi mạng: Page [${page}] → UID [${uid}]\n`;
          }

          if (i < uids.length - 1)
            await new Promise((r) => setTimeout(r, 2500));
        }
      }
      log.innerHTML += `🎉 HOÀN THÀNH TOÀN BỘ!\n`;
    });
  const inboxState = {
    pages: [],
    selectedPageIds: new Set(),
    conversations: [],
    visibleConversations: [],
    selectedConversationId: null,
    folder: "inbox",
    loading: false,
    live: false,
    fastHandle: null,
    lastPollAt: 0,
    aiConfigs: {},
    aiReplied: {}, // { convId: lastMessageId } — persisted
    aiReplying: new Set(), // convId đang xử lý — in-memory, chống lặp
    aiAutoReplyLock: false, // lock toàn cục chống gọi trùng
    aiDisabledConvs: new Set(), // convId bị tắt AI tạm thời — in-memory
    // Cache kết quả Vision OCR theo msgId — PERSISTED để không gọi lại LLM
    // cho cùng 1 tin nhắn khi dashboard reload / poll lại nhiều vòng.
    aiVisionCache: {}, // { msgId: { hasAddress, address, amount } }
    aiVisionInflight: new Map(), // msgId -> Promise, chống gọi song song
    aiVisionCacheDirty: false,
    processedCustomerMsgIds: new Set(), // msgId đã chạy pipeline — in-memory
    processedCustomerMsgIdsPersisted: {}, // { msgId: 1 } — PERSISTED qua reload
    processedDirty: false,
    autoReplyDebounceTimer: null, // debounce gộp 2 nguồn merge
    tokenError: null, // { message, code, backoffMinutes } — lỗi token Meta
    globalReplyStyle: "", // Gợi ý chung cho tất cả bot
    globalSystem: "", // Thông tin sản phẩm/shop chung cho tất cả bot
    globalApiKey: "", // API Key chung cho tất cả bot
    pageTokens: {}, // 🔑 { pageId: PageAccessToken dán tay } — ưu tiên cao nhất
    _pendingPageTokens: {}, // token đang gõ (chưa debounce xong)
    _pageTokenSaveTimer: null,
    conversationTags: {}, // { convId: ["đã mua hàng", "đã thanh toán", ...] }
    tagFilter: "", // "" | "__none__" | tên tag cụ thể
    adDetailsCache: {}, // { [adId]: { adId, adName, adsetId, adsetName, campaignId, campaignName } }
  };
  const INBOX_TAG_LIST = [
    "đã mua hàng",
    "🇯🇵 Mở Meta Suite",
    "🇯🇵 Tiếng Nhật",
    "🇻🇳 Tiếng Việt",
    "🇺🇸 Tiếng Anh",
    "🇰🇷 Tiếng Hàn",
    "🇹🇭 Tiếng Thái",
    "🇮🇩 Tiếng Indonesia",
    "🇲🇾 Tiếng Malaysia",
    "câu hỏi",
    "đã gửi hàng",
    "thiếu thông tin",
    "đã thanh toán",
    "chưa thanh toán",
  ];
  const INBOX_GRAPH_VERSION = "v25.0";
  const INBOX_CACHE_TTL_MS = 30 * 60 * 1000; // 30 phút

  // Tự động khôi phục cache khi mở dashboard
  (async function restoreInboxCache() {
    try {
      const cachedAdDetails = await inboxStorageGet("inboxAdDetailsCache");
      if (cachedAdDetails && typeof cachedAdDetails === "object") {
        inboxState.adDetailsCache = cachedAdDetails;
      }
      const cachedToken = await inboxStorageGet("inboxCachedToken");
      const cachedPages = await inboxStorageGet("inboxCachedPages");
      const cachedAt = await inboxStorageGet("inboxCachedPagesAt");
      const isFresh = cachedAt && Date.now() - cachedAt < INBOX_CACHE_TTL_MS;

      if (
        isFresh &&
        cachedToken &&
        Array.isArray(cachedPages) &&
        cachedPages.length > 0
      ) {
        const tokenInput = document.getElementById("tokenInput");
        if (tokenInput && !tokenInput.value.trim()) {
          tokenInput.value = cachedToken;
        }
        const storedIds = await inboxStorageGet("inboxSelectedPageIds");
        const savedIds = Array.isArray(storedIds) ? storedIds : [];
        inboxState.pages = cachedPages.map((page) => ({
          id: String(page.id),
          name: page.name,
          accessToken: page.accessToken || "",
          picture: page.picture || "",
        }));
        const availableIds = new Set(inboxState.pages.map((page) => page.id));
        inboxState.selectedPageIds = new Set(
          savedIds.filter((id) => availableIds.has(String(id))).map(String),
        );
        inboxRenderPageList();
        try {
          inboxMarketingRenderPageFilter();
        } catch (err) {}
        inboxState.conversations = [];
        inboxRenderConversationList();
        if (inboxStatus) {
          inboxStatus.innerText = `📦 Đã khôi phục ${inboxState.pages.length} Page từ cache · đã chọn ${inboxState.selectedPageIds.size}`;
        }
        console.log(
          `📦 Đã khôi phục ${cachedPages.length} Page từ cache (${Math.round((Date.now() - cachedAt) / 60000)} phút trước)`,
        );
        inboxSyncBackgroundConfig();
        if (inboxState.selectedPageIds.size > 0) {
          inboxStartLive();
        }
      } else {
        if (inboxStatus)
          inboxStatus.innerText =
            "Chưa tải Page (bấm nút để tải hoặc đợi 30 phút nếu đã có cache)";
      }
    } catch (e) {
      console.warn("Không khôi phục được cache:", e);
    }
  })();

  const inboxPageList = document.getElementById("inbox-page-list");
  const inboxConversationList = document.getElementById(
    "inbox-conversation-list",
  );
  const inboxMessages = document.getElementById("inbox-messages");
  const inboxChatHeader = document.getElementById("inbox-chat-header");
  const inboxStatus = document.getElementById("inbox-status");
  const inboxReplyInput = document.getElementById("inbox-reply-input");
  const inboxSendButton = document.getElementById("btn-send-inbox-reply");

  // ============================================================
  // 🎯 MỤC 3: Báo lỗi token rõ ràng lên UI
  //    Trước đây token hết hạn → danh sách trống im lặng, không biết vì sao.
  // ============================================================
  function inboxRenderTokenErrorBanner() {
    const banner = document.getElementById("inbox-token-error-banner");
    const detail = document.getElementById("inbox-token-error-detail");
    if (!banner) return;
    const err = inboxState.tokenError;
    if (!err) {
      banner.style.display = "none";
      return;
    }
    banner.style.display = "block";
    if (detail) {
      const parts = [];
      if (err.message) parts.push(err.message);
      if (err.code) parts.push(`(Mã lỗi: ${err.code})`);
      if (err.backoffMinutes) {
        parts.push(`Đang thử lại mỗi ${err.backoffMinutes} phút.`);
      }
      detail.textContent = parts.join(" ");
    }
  }

  // Nhận thông báo lỗi token từ background
  chrome.runtime?.onMessage?.addListener?.((msg) => {
    if (msg?.type === "inbox-token-error") {
      inboxState.tokenError = {
        message: msg.message || "Token Facebook không còn hiệu lực",
        code: msg.code || "",
        backoffMinutes: msg.backoffMinutes || 0,
      };
      inboxRenderTokenErrorBanner();
      if (inboxStatus) {
        inboxStatus.innerText = "🔴 Token hết hạn";
        inboxStatus.style.color = "#c92a2a";
      }
      console.error("🔴 Token lỗi:", msg);
    }
  });

  // Nút "Thử lại" trên banner
  document
    .getElementById("inbox-token-error-retry")
    ?.addEventListener("click", async () => {
      const btn = document.getElementById("inbox-token-error-retry");
      if (btn) {
        btn.disabled = true;
        btn.innerText = "⏳ Đang thử...";
      }
      try {
        // Lấy token mới từ phiên đăng nhập Facebook
        const autoBtn = document.getElementById("autoTokenBtn");
        if (autoBtn) autoBtn.click();
        // Ép background poll thử lại ngay (bypass backoff)
        setTimeout(() => {
          chrome.runtime?.sendMessage?.({ type: "inbox-poll-force" }, () => {
            void chrome.runtime?.lastError;
          });
        }, 1500);
        // Chờ token mới được lưu → listener sẽ tự đồng bộ & xoá banner
        setTimeout(() => {
          inboxState.tokenError = null;
          inboxRenderTokenErrorBanner();
          if (inboxStatus) inboxStatus.style.color = "";
          if (btn) {
            btn.disabled = false;
            btn.innerText = "🔄 Thử lại";
          }
        }, 4000);
      } catch (e) {
        if (btn) {
          btn.disabled = false;
          btn.innerText = "🔄 Thử lại";
        }
      }
    });

  function inboxEscape(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#039;",
        })[char],
    );
  }

  function inboxSafeUrl(value) {
    if (typeof value !== "string") return "";
    if (
      /^https:\/\//i.test(value) ||
      /^data:image\//i.test(value) ||
      /^blob:/i.test(value)
    ) {
      return inboxEscape(value);
    }
    return "";
  }

  function inboxFormatTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function inboxInitials(name) {
    return (
      String(name || "P")
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((word) => word[0])
        .join("")
        .toUpperCase() || "P"
    );
  }

  function inboxStorageGet(key) {
    return new Promise((resolve) =>
      chrome.storage.local.get([key], (result) => resolve(result[key])),
    );
  }

  function inboxStorageSet(key, value) {
    return new Promise((resolve) =>
      chrome.storage.local.set({ [key]: value }, resolve),
    );
  }

  const INBOX_AI_DEFAULTS = {
    enabled: false,
    autoOffOnAddress: true,
    autoOffOnPhone: true,
    system:
      "Bạn là nhân viên tư vấn bán hàng đa  ngôn ngữ chuyên nghiệp, trả lời ngắn gọn, thân thiện theo ngôn ngữ khách hàng ",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKey: "",
    priceImages: [],
    // 🔑 Page Access Token RIÊNG cho Page này (dán tay).
    //    Khi có token này → ưu tiên dùng nó cho MỌI lệnh gọi API của Page này
    //    (đọc hộp thư, gửi tin, đánh dấu đã đọc, auto-reply...).
    //    Rỗng → fallback về Page Token lấy từ User Token như trước.
    pageToken: "",
  };

  // ⚡ HẠNG MỨC CHI PHÍ LLM
  // Số ảnh tối đa gửi cho Vision OCR mỗi lần gọi (mỗi ảnh ~85-1100 token).
  const INBOX_VISION_MAX_IMAGES = 1;

  function inboxGetAiConfig(pageId) {
    const key = String(pageId || "");
    const perPage =
      inboxState.aiConfigs?.[key] || inboxState.aiConfigs?.[pageId] || {};
    const defaults = {
      ...INBOX_AI_DEFAULTS,
      apiKey: inboxState.globalApiKey || INBOX_AI_DEFAULTS.apiKey,
      priceImages: [],
    };
    const merged = { ...defaults, ...perPage };
    if (!merged.apiKey) merged.apiKey = inboxState.globalApiKey;
    if (!Array.isArray(merged.priceImages)) merged.priceImages = [];
    return merged;
  }

  async function inboxSaveAiConfig(pageId, patch) {
    const key = String(pageId || "");
    const current = (await inboxStorageGet("inboxPageAiConfigs")) || {};
    const next = { ...current };
    next[key] = { ...INBOX_AI_DEFAULTS, ...(next[key] || {}), ...patch };
    await inboxStorageSet("inboxPageAiConfigs", next);
    inboxState.aiConfigs = next;
  }

  // ============================================================
  // 🔑 PAGE ACCESS TOKEN DÁN TAY (ưu tiên cao nhất)
  //    Lưu riêng 1 bảng map { pageId: token } để tra cứu nhanh, độc lập
  //    với cấu hình AI (để sau này bổ sung cấu hình AI vẫn không mất token).
  // ============================================================
  async function inboxSaveManualPageToken(pageId, token) {
    const key = String(pageId || "");
    if (!key) return;
    const current = (await inboxStorageGet("inboxManualPageTokens")) || {};
    const next = { ...current };
    const clean = String(token || "").trim();
    if (clean) next[key] = clean;
    else delete next[key];
    await inboxStorageSet("inboxManualPageTokens", next);
    inboxState.pageTokens = next;
    console.log(`🔑 Đã lưu Page Token cho ${key}: ${clean ? "CÓ" : "đã xoá"}`);
  }

  async function inboxLoadManualPageTokens() {
    const data = await inboxStorageGet("inboxManualPageTokens");
    inboxState.pageTokens = data && typeof data === "object" ? { ...data } : {};
    // Gán vào page.accessToken để mọi luồng gọi API dùng luôn token này
    for (const page of inboxState.pages || []) {
      const manual = inboxState.pageTokens[String(page.id)];
      // Lưu lại token tự động để khôi phục được khi user xoá token dán tay
      if (!page.autoToken) page.autoToken = page.accessToken || "";
      if (manual) page.accessToken = manual;
    }
  }

  /**
   * Áp dụng Page Access Token dán tay cho 1 page:
   *   - lưu vào storage (map inboxManualPageTokens)
   *   - gán vào page.accessToken (để mọi luồng gọi API dùng ngay)
   *   - đồng bộ sang background để poll nền cũng dùng token này
   */
  async function inboxApplyManualPageToken(pageId, value) {
    const key = String(pageId || "");
    if (!key) return;
    const clean = String(value || "").trim();
    await inboxSaveManualPageToken(key, clean);
    // Đồng bộ pending (giữ nguyên giá trị đang gõ nếu khác)
    if (inboxState._pendingPageTokens) {
      inboxState._pendingPageTokens[key] = clean;
    }

    const page = inboxState.pages.find((p) => String(p.id) === key);
    if (page) {
      // 🗂 Giữ lại token tự động để khôi phục khi user xoá token dán tay
      if (clean && !page.autoToken) page.autoToken = page.accessToken || "";
      // Xoá token dán tay → quay lại dùng token tự động
      page.accessToken = clean || page.autoToken || "";
      await inboxStorageSet("inboxCachedPages", inboxState.pages);
    }
    // 🔄 Cập nhật luôn token của các hội thoại đã load → không phải reload
    if (clean) {
      for (const conv of inboxState.conversations || []) {
        if (String(conv.__pageId) === key) {
          conv.__pageToken = clean;
        }
      }
    }
    inboxSyncBackgroundConfig();

    // Cập nhật badge trên UI
    const badge = inboxPageList?.querySelector(
      `.ai-page-token-badge[data-page-id="${key}"]`,
    );
    if (badge) {
      badge.textContent = clean
        ? "Đang dùng token này ✅"
        : page?.accessToken
          ? "Token tự động (từ User Token)"
          : "Chưa có token";
    }
    console.log(
      `🔑 Page ${key}: token dán tay ${clean ? "đã áp dụng ✅" : "đã xoá → dùng token tự động"}`,
    );
  }

  /**
   * 🧪 Kiểm tra Page Access Token có hợp lệ không (gọi /me trên Graph API).
   */
  async function inboxTestManualPageToken(pageId, token) {
    const clean = String(token || "").trim();
    if (!clean) return { ok: false, message: "Chưa nhập token" };
    try {
      const url = `https://graph.facebook.com/${INBOX_GRAPH_VERSION}/me?fields=id,name&access_token=${encodeURIComponent(clean)}`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (data?.error) {
        return {
          ok: false,
          message: `❌ ${data.error.message || "Token không hợp lệ"}`,
        };
      }
      return {
        ok: true,
        message: `✅ Token hợp lệ — Page: ${data?.name || "?"} (ID ${data?.id || "?"})`,
      };
    } catch (e) {
      return { ok: false, message: `❌ Lỗi mạng: ${e.message}` };
    }
  }

  async function inboxLoadAiConfigs() {
    const data = await inboxStorageGet("inboxPageAiConfigs");
    inboxState.aiConfigs = data || {};
    const replied = await inboxStorageGet("inboxAiReplied");
    inboxState.aiReplied = replied || {};
    const globalStyle = await inboxStorageGet("inboxGlobalReplyStyle");
    inboxState.globalReplyStyle = globalStyle || "";
    const globalSystem = await inboxStorageGet("inboxGlobalSystem");
    inboxState.globalSystem = globalSystem || "";
    const globalKey = await inboxStorageGet("inboxGlobalApiKey");
    inboxState.globalApiKey = globalKey || "";
    const visionCache = await inboxStorageGet("inboxAiVisionCache");
    inboxState.aiVisionCache = visionCache || {};
    const processed = await inboxStorageGet("inboxProcessedMsgIds");
    inboxState.processedCustomerMsgIdsPersisted = processed || {};
    // Giới hạn cache tối đa 500 msg gần nhất để không phình storage vô hạn
    const keys = Object.keys(inboxState.aiVisionCache);
    if (keys.length > 500) {
      keys.slice(0, keys.length - 500).forEach((k) => {
        delete inboxState.aiVisionCache[k];
      });
    }
  }

  // Lưu cache Vision (debounce để không ghi storage liên tục)
  let _inboxVisionSaveTimer = null;
  function inboxPersistVisionCache() {
    inboxState.aiVisionCacheDirty = true;
    if (_inboxVisionSaveTimer) return;
    _inboxVisionSaveTimer = setTimeout(async () => {
      _inboxVisionSaveTimer = null;
      if (!inboxState.aiVisionCacheDirty) return;
      inboxState.aiVisionCacheDirty = false;
      const keys = Object.keys(inboxState.aiVisionCache);
      if (keys.length > 500) {
        keys.slice(0, keys.length - 500).forEach((k) => {
          delete inboxState.aiVisionCache[k];
        });
      }
      try {
        await inboxStorageSet("inboxAiVisionCache", inboxState.aiVisionCache);
      } catch (e) {
        // Bỏ qua lỗi storage
      }
    }, 2000);
  }

  // Lưu danh sách msgId đã xử lý (debounce) — tránh chạy lại LLM sau reload
  let _inboxProcessedSaveTimer = null;
  function inboxPersistProcessedMsgIds() {
    inboxState.processedDirty = true;
    if (_inboxProcessedSaveTimer) return;
    _inboxProcessedSaveTimer = setTimeout(async () => {
      _inboxProcessedSaveTimer = null;
      if (!inboxState.processedDirty) return;
      inboxState.processedDirty = false;
      // Gộp set in-memory vào object đã persist
      for (const id of inboxState.processedCustomerMsgIds) {
        inboxState.processedCustomerMsgIdsPersisted[id] = 1;
      }
      // Giới hạn 1000 msg gần nhất
      const keys = Object.keys(inboxState.processedCustomerMsgIdsPersisted);
      if (keys.length > 1000) {
        keys.slice(0, keys.length - 1000).forEach((k) => {
          delete inboxState.processedCustomerMsgIdsPersisted[k];
        });
      }
      try {
        await inboxStorageSet(
          "inboxProcessedMsgIds",
          inboxState.processedCustomerMsgIdsPersisted,
        );
      } catch (e) {
        // Bỏ qua lỗi storage
      }
    }, 3000);
  }

  function inboxEscapeAttr(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Nhận diện khách hàng đang hỏi giá (đa ngôn ngữ, hỗ trợ gõ không dấu, viết liền, lỗi chính tả)
  function inboxIsPriceInquiry(text) {
    if (!text || typeof text !== "string") return false;
    const str = text.toLowerCase().trim();
    // 1. Tiếng Anh / Quốc tế (how much, howmuch, how mich, howmich, price, cost, etc.)
    if (
      /(?:how\s*m[ui]ch|howm[ui]ch|price|pricing|cost|how\s*many|rate|quotation)/i.test(
        str,
      )
    )
      return true;
    // 2. Tiếng Việt (giá, bao nhiêu, bnhieu, bnh, bnhiu, nhiêu, bao tiền, bn tiền, ib giá, xin giá, v.v.)
    if (
      /(?:gi[aá]|bao\s*nhi[eê]u|bnhieu|bnh|bnhiu|nhi[eê]u|bn\s*ti[eề]n|bao\s*ti[eề]n|xin\s*gi[aá]|b[aá]o\s*gi[aá]|ib\s*gi[aá]|inbox\s*gi[aá]|gi[aá]\s*s[iỉ]|gi[aá]\s*l[eẻ]|t[oổ]ng\s*ti[eề]n|chi\s*ph[ií]|t[ií]nh\s*ti[eề]n|b[aá]n\s*sao|gi[aá]\s*sao|m[aấ]y\s*ti[eề]n|gi[aá]\s*[aạ]|bn\s*[aạ]|nhi[eê]u\s*[aạ])/i.test(
        str,
      )
    )
      return true;
    // 3. Tiếng Thái (ราคา, เท่าไหร่, เท่าไร, กี่บาท, มีราคา, etc.)
    if (
      /(?:ราคา|เท่าไหร่|เท่าไร|กี่บาท|กี่\s*rm|มีราคา|โปรโมชั่น|แพ็คเกจ|ขายยังไง|กี่ตัง)/i.test(
        str,
      )
    )
      return true;
    // 4. Tiếng Mã Lai / Indonesia (harga, berapa, brp, hrg, etc.)
    if (/(?:harga|berapa|brp|hrg|berapakah)/i.test(str)) return true;
    // 5. Tiếng Nhật (いくら, 価格, 値段, 料金, 金額, おいくら, 何円)
    if (/(?:いくら|価格|値段|料金|金額|おいくら|何円)/i.test(str)) return true;
    // 6. Tiếng Hàn (얼마, 가격, 비용, 얼마예요, 얼마인가요, 얼마입니까)
    if (/(?:얼마|가격|비용|얼마예요|얼마인가요|얼마입니까)/i.test(str))
      return true;
    // 7. Tiếng Trung (多少钱, 价格, 怎么卖, 什么价)
    if (/(?:多少钱|价格|怎么卖|什么价|多少錢)/i.test(str)) return true;
    return false;
  }

  // Nhận diện AI đang báo giá hoặc đưa ra chương trình khuyến mãi/bảng giá
  function inboxAiReplyMentionsPrice(text) {
    if (!text || typeof text !== "string") return false;
    const str = text.toLowerCase();
    // 1. Chứa số tiền kèm đơn vị tiền tệ: 99 RM, 100k, 500.000đ, 200 baht, $50, 1000円, 50000원...
    if (
      /\d+[\s.,\d]*(?:rm|k|đ|vnd|baht|฿|yen|円|peso|₱|usd|\$|won|₩|ringgit)/i.test(
        str,
      )
    )
      return true;
    // 2. Chứa từ khóa báo giá/bảng giá/khuyến mãi/mua 1 tặng 1
    if (
      /(?:giá là|bảng giá|giá ưu đãi|mua \d+ tặng \d+|buy \d+ get \d+|ซื้อ \d+ แถม \d+|ราคาโปรโมชั่น|มีราคา)/i.test(
        str,
      )
    )
      return true;
    return false;
  }

  async function inboxCallLlm({ baseUrl, apiKey, model, system, messages }) {
    if (!apiKey) throw new Error("Chưa nhập API key cho AI.");
    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.6,
        max_tokens: 400,
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (data.error?.message) throw new Error(data.error.message);
    return data?.choices?.[0]?.message?.content?.trim() || "";
  }

  async function inboxSendAiReply({ conversation, page, aiReply, images }) {
    // 🔑 ƯU TIÊN CAO NHẤT: Page Access Token dán tay của user
    //    (nếu Page này có token riêng thì luôn dùng token đó).
    let token =
      inboxGetManualPageToken(conversation?.__pageId || page?.id) ||
      conversation.__pageToken ||
      page?.access_token ||
      page?.accessToken;
    if (!token && page) {
      try {
        token = await inboxResolvePageToken(page);
        if (token) conversation.__pageToken = token;
      } catch (e) {}
    }
    if (!token) {
      console.error("❌ Không có token để gửi reply");
      return false;
    }
    const recipient =
      inboxGetCustomerParticipantId(conversation) ||
      inboxGetRecipientId(conversation);
    if (!recipient) {
      console.error("❌ Không xác định được recipient ID");
      return false;
    }
    const pageId = conversation.__pageId || page?.id || "me";
    let lastMsgId = null;

    try {
      // 1. Gửi ảnh bảng giá / sản phẩm đính kèm nếu có
      const imgsToSend = Array.isArray(images)
        ? images.filter((x) => x && x.trim())
        : [];
      if (imgsToSend.length > 0) {
        console.log(`🖼 AI đang gửi kèm ${imgsToSend.length} ảnh báo giá...`);
        const uploadPromises = imgsToSend.map(async (image, i) => {
          if (image.startsWith("data:image/")) {
            const blob = inboxBase64ToBlob(image);
            const fd = new FormData();
            fd.append("recipient", JSON.stringify({ id: recipient }));
            fd.append("messaging_type", "RESPONSE");
            fd.append(
              "message",
              JSON.stringify({
                attachment: {
                  type: "image",
                  payload: { is_reusable: true },
                },
              }),
            );
            fd.append("filedata", blob, `price_image_${i + 1}.jpg`);
            fd.append("access_token", token);

            const resImg = await fetch(
              `https://graph.facebook.com/${INBOX_GRAPH_VERSION}/${pageId}/messages`,
              { method: "POST", body: fd },
            );
            const dataImg = await resImg.json().catch(() => ({}));
            return dataImg.message_id || null;
          } else if (
            image.startsWith("http://") ||
            image.startsWith("https://")
          ) {
            const bodyImg = new URLSearchParams({
              recipient: JSON.stringify({ id: recipient }),
              messaging_type: "RESPONSE",
              message: JSON.stringify({
                attachment: {
                  type: "image",
                  payload: { url: image, is_reusable: true },
                },
              }),
              access_token: token,
            });
            const resImg = await fetch(
              `https://graph.facebook.com/${INBOX_GRAPH_VERSION}/${pageId}/messages`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: bodyImg.toString(),
              },
            );
            const dataImg = await resImg.json().catch(() => ({}));
            return dataImg.message_id || null;
          }
          return null;
        });

        const imageResults = await Promise.all(uploadPromises);
        const validIds = imageResults.filter(Boolean);
        if (validIds.length > 0) lastMsgId = validIds[validIds.length - 1];
      }

      // 2. Gửi nội dung tin nhắn AI
      if (aiReply) {
        const body = new URLSearchParams({
          recipient: JSON.stringify({ id: recipient }),
          messaging_type: "RESPONSE",
          message: JSON.stringify({ text: aiReply }),
          access_token: token,
        });
        const url = `https://graph.facebook.com/${INBOX_GRAPH_VERSION}/${pageId}/messages`;
        const data = await inboxGraphJson(url, {
          method: "POST",
          body: body.toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        if (data.error) throw new Error(data.error.message);
        lastMsgId = data.message_id || lastMsgId;
      }

      // Cập nhật ngay tin nhắn vào conversation để UI và check trùng lặp nhận diện được ngay
      const now = Date.now();
      const attachments =
        imgsToSend.length > 0
          ? {
              data: imgsToSend.map((img) => ({
                image_data: { url: img, preview_url: img },
              })),
            }
          : undefined;

      const sentMsg = {
        id: String(lastMsgId || `local_ai_${now}`),
        created_time: new Date(now).toISOString(),
        from: {
          id: conversation.__pageId || page?.id,
          name: page?.name || conversation.__pageName,
        },
        message: aiReply,
        attachments,
        __localSent: true,
      };
      if (!conversation.messages) conversation.messages = { data: [] };
      conversation.messages.data = conversation.messages.data || [];
      conversation.messages.data.push(sentMsg);
      conversation.updated_time = sentMsg.created_time;
      if (conversation.unread_count) conversation.unread_count = 0;

      // Render lại chat nếu đang mở
      if (
        inboxState.selectedConversationId &&
        String(inboxState.selectedConversationId) === String(conversation.id)
      ) {
        inboxRenderChat(conversation);
      }
      inboxRenderConversationList();

      console.log(`✅ AI Gửi thành công: ${lastMsgId}`);
      return lastMsgId || true;
    } catch (err) {
      console.error("❌ Gửi reply thất bại:", err.message);
      throw err;
    }
  }

  function inboxGetCustomerParticipantId(conversation) {
    const last = inboxGetLastMessage(conversation);
    if (last?.from?.id && !last.from.id.startsWith?.("page-"))
      return last.from.id;
    const senders = conversation.senders?.data || [];
    const customer = senders.find(
      (s) =>
        s.id &&
        !String(s.id).startsWith("page-") &&
        s.id !== conversation.__pageId,
    );
    if (customer) return customer.id;
    const participants = conversation.participants?.data || [];
    const other = participants.find((p) => p.id !== conversation.__pageId);
    return other?.id || null;
  }

  function inboxIsCustomerMessage(message, conversation) {
    if (!message) return false;
    const fromId = message.from?.id;
    if (!fromId) return false;
    return String(fromId) !== String(conversation.__pageId || "");
  }

  // ====== Gửi thông báo Telegram cho Inbox ======
  async function inboxSendTelegramAlert(htmlMessage) {
    try {
      const stored = await chrome.storage.local.get([
        "inboxTelegramBotToken",
        "inboxTelegramChatIds",
      ]);
      const botToken =
        stored.inboxTelegramBotToken ||
        "8539446685:AAGPeAgad4e5Uv5WrTqYoahJQmMA98Y6plA";
      let chatIds = stored.inboxTelegramChatIds;
      // KHÔNG có chat ID mặc định — người dùng phải tự nhập
      if (!Array.isArray(chatIds)) chatIds = [];

      for (const chatId of chatIds) {
        if (!chatId) continue;
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: htmlMessage,
              parse_mode: "HTML",
            }),
          });
        } catch (e) {
          console.warn("Lỗi gửi Telegram cho chat ID:", chatId, e);
        }
      }

      // ✅ Nếu người dùng đã tự cấu hình Telegram (card "Cấu Hình Telegram
      //    Của Bạn") → gửi thêm 1 bản tới bot/chat của họ.
      if (window.TelegramConfig) {
        const userCfg = await window.TelegramConfig.getConfig();
        if (!userCfg.isDefault) {
          await window.TelegramConfig.sendMessage(htmlMessage);
        }
      }
    } catch (err) {
      console.warn("Lỗi inboxSendTelegramAlert:", err);
    }
  }

  // ====== Chuyển URL ảnh thành Base64 (Chống lỗi 403 CDN Facebook) ======
  async function inboxFetchImageAsBase64(url) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const blob = await resp.blob();
      const mimeType = blob.type || "image/jpeg";
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const resultStr = String(reader.result || "");
          const base64Data = resultStr.includes(",")
            ? resultStr.split(",")[1]
            : resultStr;
          resolve({ mimeType, base64Data, dataUrl: resultStr });
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      console.warn("⚠️ Không tải được ảnh đính kèm để OCR:", e.message);
      return null;
    }
  }

  // ====== Trích xuất địa chỉ và số tiền đơn hàng bằng OpenAI Vision ======
  // LƯU Ý COST: Hàm này tốn kém (Vision). Bọc bằng cache theo msgId + inflight
  // để cùng 1 tin nhắn chỉ gọi OpenAI đúng 1 lần duy nhất.
  async function inboxExtractAddressAndAmount(conversation, message) {
    const msgId = String(message?.id || "");
    if (msgId) {
      // 1. Đã có trong cache → trả về ngay, 0 token
      const cached = inboxState.aiVisionCache?.[msgId];
      if (cached) return cached;
      // 2. Đang gọi dở cho msgId này → chờ kết quả, không gọi thêm
      const inflight = inboxState.aiVisionInflight?.get(msgId);
      if (inflight) {
        try {
          return await inflight;
        } catch (e) {
          return { hasAddress: false };
        }
      }
    }

    const promise = inboxExtractAddressAndAmountUncached(conversation, message);
    if (msgId) {
      inboxState.aiVisionInflight.set(msgId, promise);
      try {
        const result = await promise;
        // Cache cả kết quả dương lẫn âm.
        // Key theo msgId nên tin nhắn mới vẫn luôn được phân tích lại,
        // còn cùng 1 msgId thì không bao giờ gọi LLM 2 lần.
        inboxState.aiVisionCache[msgId] = result || { hasAddress: false };
        inboxPersistVisionCache();
        return result;
      } catch (e) {
        const fallback = { hasAddress: false };
        inboxState.aiVisionCache[msgId] = fallback;
        inboxPersistVisionCache();
        return fallback;
      } finally {
        inboxState.aiVisionInflight.delete(msgId);
      }
    }
    return promise;
  }

  async function inboxExtractAddressAndAmountUncached(conversation, message) {
    const text = (message?.message || "").trim();
    const attachments =
      message?.attachments?.data ||
      (Array.isArray(message?.attachments) ? message.attachments : []);
    const rawImageUrls = [];

    attachments.forEach((att) => {
      const url =
        att.image_data?.url ||
        att.image_url ||
        att.file_url ||
        att.url ||
        att.preview_url;
      if (
        url &&
        (att.mime_type?.startsWith("image/") ||
          att.image_data ||
          att.preview?.is_image ||
          !att.mime_type)
      ) {
        rawImageUrls.push(url);
      }
    });

    const hasImages = rawImageUrls.length > 0;
    if (!text && !hasImages) return { hasAddress: false };

    // 1. Tải ảnh sang Base64 để OpenAI Vision đọc trực tiếp (tránh lỗi 403 CDN Facebook)
    // ⚡ TỐI ƯU TOKEN: chỉ lấy 1 ảnh đầu (ảnh đầy đủ nhất), thay vì 3 ảnh.
    // detail:"low" ~85 token/ảnh so với detail:"high" ~1100 token/ảnh (tiết kiệm ~93%).
    const base64Images = [];
    if (hasImages) {
      const target = rawImageUrls.slice(0, INBOX_VISION_MAX_IMAGES);
      for (const imgUrl of target) {
        const b64 = await inboxFetchImageAsBase64(imgUrl);
        if (b64) base64Images.push(b64);
        // Chỉ gửi 1 ảnh — ảnh đầu tiên đã đủ để OCR địa chỉ/số tiền
        if (base64Images.length >= INBOX_VISION_MAX_IMAGES) break;
      }
    }

    // 2. Nhận diện địa chỉ bằng Rule-based & Regex (Hỗ trợ tiếng Việt & Nhật Bản & Quốc tế)
    const lower = text.toLowerCase();

    // Từ khóa địa chỉ tiếng Việt
    const vnAddressKeywords = [
      "địa chỉ",
      "đc:",
      "dc:",
      "d/c:",
      "đ/c:",
      "nhận hàng tại",
      "giao về",
      "giao đến",
      "ship về",
      "ship đến",
      "gửi về",
      "gửi đến",
      "nhận ở",
      "số nhà",
      "ngõ",
      "ngách",
      "hẻm",
      "đường",
      "phố",
      "phường",
      "xã",
      "quận",
      "huyện",
      "thị xã",
      "thành phố",
      "tp.",
      "tp ",
      "tỉnh",
      "thôn",
      "ấp",
      "xóm",
      "tổ dân phố",
      "chung cư",
      "tòa nhà",
      "toà nhà",
      "kđt",
      "kdc",
    ];

    // Pattern tiếng Nhật & Quốc tế (Mã bưu điện, Tỉnh/Thành/Quận/Huyện/Xã bằng Kanji & Romaji/English)
    const jpPostalRegex = /(?:〒|\b)\s*\d{3}[-‐]\d{4}\b/;
    const jpAddressRegex =
      /(東京都|北海道|(京都|大阪)府|.{2,3}県|tokyo|osaka|kyoto|chiyoda|shinjuku|shibuya|yokohama|nagoya|fukuoka|sapporo|japan|hotel|building|marunouchi|[-a-z0-9]+-(?:ku|shi|cho|machi|gun|ken))\b/i;
    const jpKeywords = [
      "住所",
      "届け先",
      "郵便番号",
      "送り先",
      "hotel",
      "station",
      "marunouchi",
      "chiyoda-ku",
      "tokyo",
    ];

    let ruleBasedAddressDetected = false;
    if (vnAddressKeywords.some((kw) => lower.includes(kw))) {
      ruleBasedAddressDetected = true;
    } else if (
      jpPostalRegex.test(text) ||
      jpAddressRegex.test(text) ||
      jpKeywords.some((kw) => lower.includes(kw))
    ) {
      ruleBasedAddressDetected = true;
    } else if (
      /(số\s*\d+|đường|phường|quận|tỉnh|thành\s*phố)/i.test(text) &&
      /\d{9,11}/.test(text)
    ) {
      ruleBasedAddressDetected = true;
    }

    // 3. Trích xuất số tiền đơn hàng từ ngữ cảnh (quét tin nhắn hiện tại và các tin gần nhất)
    let extractedAmount = "Chưa xác định";
    const allMsgs = conversation?.messages?.data || [message];
    const priceRegex =
      /(\d{1,3}(?:[.,]\d{3})+|\d+)\s*(k|vnđ|vnd|đ|d|đồng|yên|yen|円)/i;

    // Tìm trong tin nhắn hiện tại
    const msgMatch = text.match(priceRegex);
    if (msgMatch) {
      extractedAmount = msgMatch[0];
    } else {
      // Tìm ngược trong các tin nhắn trước
      for (let i = allMsgs.length - 1; i >= 0; i--) {
        const mText = allMsgs[i]?.message || "";
        const match = mText.match(priceRegex);
        if (match) {
          extractedAmount = match[0];
          break;
        }
      }
    }

    // 3b. ⚡ TỐI ƯU TOKEN: Rule-based đã đủ tin → KHÔNG gọi OpenAI.
    // Tin nhắn text thuần chứa từ khóa địa chỉ (đc:, giao về, 〒xxx-xxxx, số nhà...)
    // đã được nhận diện chính xác ở bước 2 → trả về ngay, tiết kiệm 100% token.
    if (ruleBasedAddressDetected && !hasImages) {
      return {
        hasAddress: true,
        address: text,
        amount: extractedAmount,
      };
    }

    // 3c. ⚡ TỐI ƯU TOKEN: Tin nhắn quá ngắn, không ảnh, không từ khóa địa chỉ
    // → không đáng để gọi LLM (gần như chắc chắn không có địa chỉ).
    const looksLikeAddressText =
      text.length >= 18 || /\d{3,}/.test(text) || text.includes(",");
    if (!hasImages && !ruleBasedAddressDetected && !looksLikeAddressText) {
      return { hasAddress: false };
    }

    // 4. Sử dụng OpenAI Vision từ "🔑 API Key chung" đã cấu hình
    const pageId = conversation?.__pageId;
    const globalApiKey =
      inboxState.globalApiKey || (await inboxStorageGet("inboxGlobalApiKey"));
    const config = pageId ? inboxGetAiConfig(pageId) : null;
    const apiKey = config?.apiKey || globalApiKey;

    if (apiKey) {
      try {
        const baseUrl = (
          config?.baseUrl ||
          INBOX_AI_DEFAULTS.baseUrl ||
          "https://api.openai.com/v1"
        ).replace(/\/$/, "");
        const model = config?.model || INBOX_AI_DEFAULTS.model || "gpt-4o-mini";
        const systemPrompt = `Bạn là chuyên gia trích xuất đơn hàng từ tin nhắn chat và hình ảnh của khách hàng.
Nhiệm vụ:
1. Xác định xem tin nhắn hoặc HÌNH ẢNH của khách hàng có chứa ĐỊA CHỈ GIAO HÀNG / ĐỊA CHỈ NHẬN HÀNG hay không (is_address: true/false).
   (QUAN TRỌNG: Hãy đọc chữ (OCR) trên ảnh chụp màn hình, ảnh bill/hóa đơn, tem nhãn giao hàng, ảnh viết tay địa chỉ... bằng tiếng Việt, tiếng Nhật, tiếng Anh... để tìm địa chỉ).
2. Nếu có, trích xuất ĐỊA CHỈ cụ thể và đầy đủ (address).
3. Trích xuất SỐ TIỀN / GIÁ TRỊ ĐƠN HÀNG (amount) nếu có đề cập trong tin nhắn hoặc trên hình ảnh (VD: 500k, 350.000đ, 3000円, 1000 yen...; nếu không có thì ghi "Chưa xác định").

Trả về CHỈ một chuỗi JSON hợp lệ theo định dạng:
{"is_address": true, "address": "Địa chỉ cụ thể trích xuất được", "amount": "Số tiền đơn hàng"}`;

        let userContent;
        if (base64Images.length > 0) {
          userContent = [
            {
              type: "text",
              text: text
                ? `Tin nhắn của khách: "${text}". Kèm theo ${base64Images.length} hình ảnh dưới đây. Hãy đọc chữ trên ảnh để trích xuất địa chỉ giao hàng và số tiền:`
                : `Khách hàng đã gửi ${base64Images.length} hình ảnh dưới đây. Hãy đọc chữ trên ảnh để trích xuất địa chỉ giao hàng và số tiền:`,
            },
          ];
          base64Images.forEach((img) => {
            userContent.push({
              type: "image_url",
              image_url: {
                url: img.dataUrl,
                // ⚡ "low" thay vì "high": ~85 token/ảnh thay vì ~1100.
                // Đủ để OCR địa chỉ/số tiền, tiết kiệm ~93% token ảnh.
                detail: "low",
              },
            });
          });
        } else {
          userContent = text;
        }

        const body = {
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
          max_tokens: 300,
          temperature: 0,
        };

        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        });

        if (res.ok) {
          const data = await res.json();
          const reply = data.choices?.[0]?.message?.content || "";
          try {
            const parsed = JSON.parse(
              reply.replace(/```json|```/gi, "").trim(),
            );
            if (parsed.is_address === true) {
              return {
                hasAddress: true,
                address:
                  parsed.address ||
                  (hasImages ? "[Địa chỉ trích xuất từ ảnh]" : text),
                amount:
                  parsed.amount && parsed.amount !== "Chưa xác định"
                    ? parsed.amount
                    : extractedAmount,
              };
            }
          } catch (e) {
            if (reply.toLowerCase().includes('"is_address": true')) {
              return {
                hasAddress: true,
                address: hasImages ? "[Địa chỉ trích xuất từ ảnh]" : text,
                amount: extractedAmount,
              };
            }
          }
        } else {
          const errText = await res.text().catch(() => "");
          console.warn("OpenAI API response error:", res.status, errText);
        }
      } catch (err) {
        console.warn("OpenAI vision address extraction failed:", err);
      }
    }

    // 5. Fallback sang Rule-based nếu không có API Key hoặc OpenAI trả về false
    if (ruleBasedAddressDetected) {
      return {
        hasAddress: true,
        address: text || (hasImages ? "[Ảnh đính kèm]" : ""),
        amount: extractedAmount,
      };
    }

    return { hasAddress: false };
  }

  // Tương thích ngược cho hàm cũ
  async function inboxMessageHasAddress(message, pageId, conversation) {
    const res = await inboxExtractAddressAndAmount(
      conversation || { __pageId: pageId },
      message,
    );
    return res.hasAddress === true;
  }

  // ====== Phát hiện tin nhắn có chứa số điện thoại ======
  function inboxExtractPhoneNumber(text) {
    if (!text || typeof text !== "string") return null;
    const cleaned = text.replace(/[\u00A0\u200B\u200C\u200D\uFEFF]/g, " ");
    // Pattern nhận diện SĐT Việt Nam & quốc tế phổ biến
    // - Bắt đầu bằng +84, 84, 0 rồi 9-10 số (VN)
    // - Dãy 9-15 số liên tiếp (có thể có dấu cách, gạch ngang, dấu chấm, ngoặc đơn)
    const patterns = [
      /(?:\+?84|0)[\s\-\.]?([0-9]{1,2}[\s\-\.]?){2,4}[0-9]{2,4}/g,
      /\b[0-9]{3,4}[\s\-\.]?[0-9]{3,4}[\s\-\.]?[0-9]{2,4}(?:[\s\-\.]?[0-9]{2,4})?\b/g,
    ];
    const found = new Set();
    for (const re of patterns) {
      let m;
      while ((m = re.exec(cleaned)) !== null) {
        const raw = m[0];
        // Lấy tất cả chữ số, loại bỏ ký tự phân tách
        const digits = raw.replace(/[^0-9]/g, "");
        // Chuẩn hoá: nếu bắt đầu bằng 84 + 9 số tiếp → đổi sang 0xxxxxxxxx
        let normalized = digits;
        if (normalized.startsWith("84") && normalized.length === 10) {
          normalized = "0" + normalized.slice(2);
        } else if (
          normalized.startsWith("84") &&
          normalized.length >= 10 &&
          normalized.length <= 11
        ) {
          normalized = "0" + normalized.slice(2);
        }
        // Yêu cầu tối thiểu 9 chữ số & tối đa 15 (chuẩn ITU E.164)
        if (normalized.length >= 9 && normalized.length <= 15) {
          found.add(normalized);
        }
      }
    }
    // Tránh nhầm với các chuỗi toàn số kiểu tiền tệ/ngày tháng không có dấu phân tách
    // Lọc thêm: nếu tất cả các số tìm được đều có cùng 1 chữ số lặp lại (11111111...) → bỏ
    const real = [...found].filter((s) => {
      if (/^(\d)\1+$/.test(s)) return false; // 11111111, 2222,...
      // Loại các số kiểu "1.000.000" hoặc "10.000.000" — đếm dấu phân tách gốc
      // chỉ giữ nếu số có dấu cách/gạch/dấu chấm kèm theo trong raw match
      return true;
    });
    return real.length > 0 ? real[0] : null;
  }

  function inboxMessageHasPhone(message) {
    const text = message?.message || "";
    if (!text) return false;
    return inboxExtractPhoneNumber(text) !== null;
  }

  // ====== Tự động gắn tag "đã mua hàng" và gửi thông báo Telegram ======
  async function inboxHandleCustomerAddressOrder(conversation, message) {
    if (!conversation || !message) return;
    if (!inboxIsCustomerMessage(message, conversation)) return;

    // ⚡ TỐI ƯU TOKEN: Nếu AI đã bị tắt cho hội thoại này (khách đã gửi địa chỉ)
    // → địa chỉ đã được ghi nhận ở lần trước, không cần gọi LLM lại.
    if (inboxState.aiDisabledConvs?.has(conversation.id)) return;

    // ⚡ TỐI ƯU TOKEN: Không có API key ở đâu cả → bỏ qua hoàn toàn,
    // tránh chạy pipeline OCR tốn tài nguyên mà không thể gọi được OpenAI.
    const pageIdCfg = conversation?.__pageId;
    const cfgForPage = pageIdCfg ? inboxGetAiConfig(pageIdCfg) : null;
    const anyApiKey =
      cfgForPage?.apiKey ||
      inboxState.globalApiKey ||
      (await inboxStorageGet("inboxGlobalApiKey"));
    if (!anyApiKey) return;

    // Chống gửi trùng lặp thông báo cho cùng 1 tin nhắn
    if (!inboxState.notifiedAddressMsgIds) {
      inboxState.notifiedAddressMsgIds = new Set();
    }
    const msgId = String(message.id || "");
    if (msgId && inboxState.notifiedAddressMsgIds.has(msgId)) return;

    const extracted = await inboxExtractAddressAndAmount(conversation, message);
    if (!extracted.hasAddress) return;

    if (msgId) {
      inboxState.notifiedAddressMsgIds.add(msgId);
    }

    // 1. Tự động gắn tag "đã mua hàng" cho cuộc trò chuyện
    const convId = conversation.id;
    if (!inboxState.conversationTags) {
      inboxState.conversationTags = {};
    }
    const currentTags = inboxState.conversationTags[convId] || [];
    if (!currentTags.includes("đã mua hàng")) {
      currentTags.push("đã mua hàng");
      inboxState.conversationTags[convId] = currentTags;
      await inboxPersistTags();
      inboxRenderConversationList();
      const sel = inboxGetSelectedConversation();
      if (sel && String(sel.id) === String(convId)) {
        inboxRenderChat(sel);
      }
      inboxRefreshTagFilterOptions();
      console.log(
        `🏷️ Tự động gắn tag "đã mua hàng" cho ${inboxGetContact(conversation)}`,
      );
    }

    // 2. Gửi thông báo đơn hàng về Telegram
    const customerName = inboxGetContact(conversation) || "Khách hàng";
    const pageName = conversation.__pageName || "Fanpage";
    const address =
      extracted.address || message.message || "Đã gửi thông tin địa chỉ";
    const amount = extracted.amount || "Chưa xác định";
    const rawMsg = message.message || "[Ảnh / Tệp đính kèm]";

    const alertHtml =
      `🛒 <b>ĐƠN HÀNG MỚI (PHÁT HIỆN ĐỊA CHỈ)</b>\n\n` +
      `🏢 <b>Page:</b> ${inboxEscape(pageName)}\n` +
      `👤 <b>Khách hàng:</b> ${inboxEscape(customerName)}\n` +
      `📍 <b>Địa chỉ:</b> ${inboxEscape(address)}\n` +
      `💰 <b>Số tiền đơn:</b> <code>${inboxEscape(amount)}</code>\n` +
      `💬 <b>Tin nhắn:</b> <i>${inboxEscape(rawMsg)}</i>`;

    await inboxSendTelegramAlert(alertHtml);
    console.log(
      `🚀 Đã bắn thông báo đơn hàng Telegram cho khách: ${customerName}`,
    );
  }

  // ====== Tự động nhận diện ngôn ngữ và gắn Tag ======
  function inboxDetectLanguage(text) {
    if (!text || typeof text !== "string") return null;
    const str = text.trim();
    if (!str) return null;

    // 1. Tiếng Thái: Ký tự chữ Thái [\u0E00-\u0E7F]
    if (/[\u0E00-\u0E7F]/.test(str)) {
      return "🇹🇭 Tiếng Thái";
    }

    // 2. Tiếng Nhật: có Hiragana, Katakana, hoặc từ vựng Nhật
    if (
      /[\u3040-\u309F\u30A0-\u30FF]/.test(str) ||
      /(?:〒|東京都|大阪府|京都府|北海道|.{2,3}県|ホテル|円|こんにちは|ありがとう|よろしく|サイズ|発送|注文|送り先|届け先)/i.test(
        str,
      )
    ) {
      return "🇯🇵 Tiếng Nhật";
    }

    // 3. Tiếng Hàn: có Hangul
    if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(str)) {
      return "🇰🇷 Tiếng Hàn";
    }

    // 4. Tiếng Việt: có dấu tiếng Việt hoặc từ khóa tiếng Việt
    if (
      /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(
        str,
      ) ||
      /\b(?:chào|shop|giá|bao nhiêu|bạn ơi|inbox|size|địa chỉ|giao hàng|ship|vận chuyển|đặt hàng|mua|tư vấn|mẫu)\b/i.test(
        str,
      )
    ) {
      return "🇻🇳 Tiếng Việt";
    }

    // 5. Tiếng Malaysia (Bahasa Melayu): từ khóa đặc trưng Malaysia / Ringgit / RM / Poslaju
    if (
      /\b(?:terima\s*kasih|selamat\s*(?:pagi|petang|malam|datang)|berapa|harga|poslaju|jnt|cod|sabah|sarawak|kuala\s*lumpur|selangor|malaysia|ringgit|rm|nak|beli|tuan|puan|cik|ada\s*stok|salam)\b/i.test(
        str,
      )
    ) {
      return "🇲🇾 Tiếng Malaysia";
    }

    // 6. Tiếng Indonesia (Bahasa Indonesia): từ khóa đặc trưng Indonesia / Rupiah / Rp / Ongkir
    if (
      /\b(?:terima\s*kasih|selamat\s*(?:pagi|siang|sore|malam)|berapa|harga|ongkir|kirim|paket|cod|jakarta|bandung|surabaya|indonesia|rupiah|rp|mau|beli|gan|kak|sis|mas|mbak|ready|stok|bisa)\b/i.test(
        str,
      )
    ) {
      return "🇮🇩 Tiếng Indonesia";
    }

    // 7. Tiếng Anh: chứa từ tiếng Anh hoặc bảng chữ cái Latin
    if (
      /\b(?:hello|hi|price|how\s*much|howmuch|order|shipping|address|please|thank|thanks|want|buy|size|hotel|station)\b/i.test(
        str,
      ) ||
      /[a-zA-Z]{3,}/.test(str)
    ) {
      return "🇺🇸 Tiếng Anh";
    }

    return null;
  }

  async function inboxDetectAndTagLanguage(conversation) {
    if (!conversation?.id) return;
    if (!inboxState.conversationTags) inboxState.conversationTags = {};
    const currentTags = inboxState.conversationTags[conversation.id] || [];

    // Nếu đã có bất kỳ tag ngôn ngữ nào thì bỏ qua
    const hasLangTag = currentTags.some((t) => inboxIsLanguageTag(t));
    if (hasLangTag) return;

    // Quét tin nhắn của khách hoặc snippet
    const msgs = (conversation.messages?.data || []).filter((m) =>
      inboxIsCustomerMessage(m, conversation),
    );
    const combinedText =
      msgs
        .map((m) => m.message || "")
        .filter(Boolean)
        .join(" ") ||
      conversation.snippet ||
      "";
    if (!combinedText) return;

    const detectedTag = inboxDetectLanguage(combinedText);
    if (detectedTag && !currentTags.includes(detectedTag)) {
      currentTags.push(detectedTag);
      inboxState.conversationTags[conversation.id] = currentTags;
      await inboxPersistTags();
      inboxRenderConversationList();
      const sel = inboxGetSelectedConversation();
      if (sel && String(sel.id) === String(conversation.id)) {
        inboxRenderChat(sel);
      }
      inboxRefreshTagFilterOptions();
      console.log(
        `🌐 Tự động gắn tag [${detectedTag}] cho ${inboxGetContact(conversation)}`,
      );
    }
  }

  async function inboxMaybeAutoReplyAll() {
    if (inboxState.aiAutoReplyLock) return;
    if (!Array.isArray(inboxState.conversations)) return;
    inboxState.aiAutoReplyLock = true;
    try {
      for (const conversation of inboxState.conversations) {
        // 1. Tự động nhận diện ngôn ngữ và gắn Tag ngôn ngữ
        inboxDetectAndTagLanguage(conversation);

        const messages = conversation.messages?.data || [];
        if (messages.length === 0) continue;
        const sorted = [...messages].sort(
          (a, b) =>
            new Date(a.created_time || 0) - new Date(b.created_time || 0),
        );
        const last = sorted[sorted.length - 1];
        if (!inboxIsCustomerMessage(last, conversation)) continue;

        // ⚡ TỐI ƯU TOKEN: Không có API key → bỏ qua, KHÔNG đánh dấu đã xử lý.
        // Nhờ vậy khi sếp thêm API key sau, tin nhắn chờ sẽ được xử lý ngay.
        const cfgKey =
          inboxGetAiConfig(conversation.__pageId)?.apiKey ||
          inboxState.globalApiKey;
        if (!cfgKey) continue;

        // ⚡ TỐI ƯU TOKEN: Chỉ xử lý conversation có TIN NHẮN MỚI.
        // Trước đây mỗi vòng poll 60s lặp qua TẤT CẢ hội thoại và gọi LLM
        // lại cho tin nhắn cũ đã xử lý → đốt token vô ích.
        const lastId = String(last.id || "");
        if (!lastId) continue;
        if (
          inboxState.processedCustomerMsgIds?.has(lastId) ||
          inboxState.processedCustomerMsgIdsPersisted?.[lastId]
        ) {
          continue; // Đã xử lý rồi → bỏ qua hoàn toàn, 0 token
        }

        // Đánh dấu ngay (trước khi await) để chống re-entry song song
        if (!inboxState.processedCustomerMsgIds) {
          inboxState.processedCustomerMsgIds = new Set();
        }
        inboxState.processedCustomerMsgIds.add(lastId);
        inboxPersistProcessedMsgIds();

        // 2. Tự động kiểm tra địa chỉ, gắn tag "đã mua hàng" & gửi Telegram
        // (dùng chung cache Vision với inboxAutoReplyConversation → chỉ gọi 1 lần)
        await inboxHandleCustomerAddressOrder(conversation, last);

        // 3. Tự động trả lời AI (dùng chung hàm duy nhất với atomic lock)
        const repliedOk = await inboxAutoReplyConversation(conversation);

        // ⚡ Nếu AI reply thất bại (lỗi mạng / rate limit OpenAI) → bỏ dấu đã xử lý
        // để tin nhắn được thử lại ở vòng poll kế tiếp thay vì bị bỏ rơi.
        if (repliedOk === false) {
          inboxState.processedCustomerMsgIds.delete(lastId);
          delete inboxState.processedCustomerMsgIdsPersisted[lastId];
          inboxPersistProcessedMsgIds();
        }
      }
    } finally {
      inboxState.aiAutoReplyLock = false;
    }
  }

  async function inboxGraphJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
      throw new Error(data.error?.message || `HTTP ${response.status}`);
    }
    return data;
  }

  async function inboxFetchAll(url, maxPages = 5) {
    const items = [];
    let nextUrl = url;
    let pageCount = 0;
    while (nextUrl && pageCount < maxPages) {
      const data = await inboxGraphJson(nextUrl);
      if (Array.isArray(data.data)) items.push(...data.data);
      nextUrl = data.paging?.next || "";
      pageCount += 1;
    }
    return items;
  }

  // 🎯 Trích xuất thông tin Referral / Quảng cáo từ hội thoại
  function inboxGetConversationReferral(conversation) {
    if (!conversation) return null;
    const msgs = Array.isArray(conversation.messages?.data)
      ? conversation.messages.data
      : [];
    for (const m of msgs) {
      if (m?.referral) {
        const adId = m.referral.ad_id || "";
        const adTitle = m.referral.ads_context_data?.ad_title || "";
        const photoUrl = m.referral.ads_context_data?.photo_url || "";
        const videoUrl = m.referral.ads_context_data?.video_url || "";
        const postId = m.referral.ads_context_data?.post_id || "";
        if (adId || adTitle) {
          return {
            ad_id: adId,
            source: m.referral.source || "ADS",
            ad_title: adTitle,
            photo_url: photoUrl,
            video_url: videoUrl,
            post_id: postId,
            ref_param: m.referral.ref_param || "",
          };
        }
      }
    }

    if (conversation.ad_context) {
      return {
        ad_id: conversation.ad_context.ad_id || "",
        ad_title: conversation.ad_context.ad_title || "",
        photo_url: conversation.ad_context.photo_url || "",
      };
    }

    return null;
  }

  // 🎯 Tra cứu chi tiết Chiến dịch (Campaign) & Nhóm quảng cáo (Ad Set) từ Ad ID
  const _adFetchingSet = new Set();
  async function inboxFetchAdDetails(adId) {
    if (!adId || typeof adId !== "string") return null;
    const cleanAdId = adId.trim();
    if (!cleanAdId) return null;

    if (inboxState.adDetailsCache?.[cleanAdId]) {
      return inboxState.adDetailsCache[cleanAdId];
    }

    if (_adFetchingSet.has(cleanAdId)) return null;
    _adFetchingSet.add(cleanAdId);

    try {
      const userToken =
        document.getElementById("tokenInput")?.value?.trim() ||
        (await inboxStorageGet("inboxCachedToken")) ||
        inboxState.pages[0]?.accessToken ||
        "";

      if (!userToken) return null;

      const fields =
        "id,name,adset_id,adset{id,name},campaign_id,campaign{id,name}";
      const url = `https://graph.facebook.com/${INBOX_GRAPH_VERSION}/${cleanAdId}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(userToken)}`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));

      if (data?.error) {
        console.warn(
          `⚠️ Không tra cứu được Ad ID ${cleanAdId}:`,
          data.error.message,
        );
        return null;
      }

      if (data?.id) {
        const details = {
          adId: String(data.id),
          adName: data.name || `Ad #${data.id}`,
          adsetId: data.adset?.id || data.adset_id || "",
          adsetName: data.adset?.name || "Nhóm quảng cáo",
          campaignId: data.campaign?.id || data.campaign_id || "",
          campaignName: data.campaign?.name || "Chiến dịch",
        };

        inboxState.adDetailsCache[cleanAdId] = details;
        await inboxStorageSet("inboxAdDetailsCache", inboxState.adDetailsCache);
        return details;
      }
      return null;
    } catch (e) {
      console.warn("Lỗi fetch ad details:", e);
      return null;
    } finally {
      _adFetchingSet.delete(cleanAdId);
    }
  }

  // Lazy load messages cho 1 conversation
  async function inboxLoadConversationMessages(conversation) {
    if (!conversation?.id || !conversation.__pageToken) return;
    conversation.__loadingMessages = true;
    try {
      const fields =
        "messages.limit(20){id,created_time,from,to,message,attachments{mime_type,name,file_url,image_url,image_data,url},referral{ad_id,source,type,ref_param,ads_context_data{ad_title,photo_url,video_url,post_id}}}";
      const url = `https://graph.facebook.com/${INBOX_GRAPH_VERSION}/${conversation.id}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(conversation.__pageToken)}`;
      const data = await inboxGraphJson(url);
      conversation.messages = data.messages || { data: [] };
      conversation.__messagesLoaded = true;

      // 🎯 Tra cứu thông tin nguồn Quảng cáo ngay khi tải tin nhắn
      const ref = inboxGetConversationReferral(conversation);
      if (ref?.ad_id && !inboxState.adDetailsCache[ref.ad_id]) {
        inboxFetchAdDetails(ref.ad_id).then((details) => {
          if (details) {
            inboxRenderConversationList();
            const sel = inboxGetSelectedConversation();
            if (sel && String(sel.id) === String(conversation.id)) {
              inboxRenderChat(sel);
            }
          }
        });
      }

      // Chỉ re-render nếu conversation đang được chọn
      if (
        inboxState.selectedConversationId === conversation.id &&
        typeof inboxRenderChat === "function"
      ) {
        inboxRenderChat(conversation);
      }

      // 👉 Tự động kiểm tra địa chỉ, gắn tag "đã mua hàng" và báo Telegram
      const custMsgs = (conversation.messages?.data || []).filter((m) =>
        inboxIsCustomerMessage(m, conversation),
      );
      if (custMsgs.length > 0) {
        const sortedCustMsgs = [...custMsgs].sort(
          (a, b) =>
            new Date(b.created_time || 0) - new Date(a.created_time || 0),
        );
        inboxHandleCustomerAddressOrder(conversation, sortedCustMsgs[0]);
      }

      // 👉 Tự động nhận diện ngôn ngữ và gắn Tag ngôn ngữ
      inboxDetectAndTagLanguage(conversation);
    } catch (error) {
      console.warn(
        `⚠️ Lỗi load messages cho ${conversation.id}:`,
        error.message,
      );
    } finally {
      conversation.__loadingMessages = false;
    }
  }

  function inboxGetMessages(conversation) {
    return Array.isArray(conversation.messages?.data)
      ? conversation.messages.data
      : [];
  }

  function inboxGetContact(conversation) {
    const pageId = conversation.__pageId;
    const messages = [...inboxGetMessages(conversation)].sort(
      (a, b) => new Date(b.created_time || 0) - new Date(a.created_time || 0),
    );
    const lastInbound = messages.find(
      (message) => message.from?.id && message.from.id !== pageId,
    );
    if (lastInbound?.from?.name) return lastInbound.from.name;
    const participants = conversation.participants?.data || [];
    const participant =
      participants.find((item) => item.id !== pageId) || participants[0];
    return participant?.name || participant?.username || "Khách hàng";
  }

  function inboxGetLastMessage(conversation) {
    return [...inboxGetMessages(conversation)].sort(
      (a, b) => new Date(b.created_time || 0) - new Date(a.created_time || 0),
    )[0];
  }

  function inboxGetLastCustomerMessageTime(conversation) {
    const pageId = conversation.__pageId;
    if (!pageId) return null;
    const messages = inboxGetMessages(conversation);
    if (messages.length === 0) return null;
    const inbound = messages
      .filter((message) => message.from?.id && message.from.id !== pageId)
      .sort(
        (a, b) => new Date(b.created_time || 0) - new Date(a.created_time || 0),
      );
    return inbound[0]?.created_time || null;
  }

  function inboxGetRecipientId(conversation) {
    const pageId = conversation.__pageId;
    const messages = [...inboxGetMessages(conversation)].sort(
      (a, b) => new Date(b.created_time || 0) - new Date(a.created_time || 0),
    );
    const inbound = messages.find(
      (message) => message.from?.id && message.from.id !== pageId,
    );
    if (inbound?.from?.id) return inbound.from.id;
    const participants = conversation.participants?.data || [];
    return participants.find((item) => item.id !== pageId)?.id || "";
  }

  function inboxRenderPageList() {
    if (!inboxPageList) return;
    const query = (document.getElementById("inbox-page-search")?.value || "")
      .trim()
      .toLowerCase();
    const pages = inboxState.pages.filter((page) =>
      `${page.name} ${page.id}`.toLowerCase().includes(query),
    );
    // 🛡 Giữ trạng thái ô Page Access Token đang gõ + focus (tránh mất khi re-render)
    const tokenInputMemo = (() => {
      const active = document.activeElement;
      if (
        active &&
        active.classList?.contains("ai-page-token") &&
        inboxPageList.contains(active)
      ) {
        return {
          pageId: active.getAttribute("data-page-id"),
          value: active.value,
          selStart: active.selectionStart,
          selEnd: active.selectionEnd,
        };
      }
      return null;
    })();
    // Render phần gợi ý chung + API Key chung (trước danh sách page)
    const globalSection = `
      <div class="inbox-global-ai-config" style="padding:8px 12px; border-bottom:1px solid #e9ecef;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <span style="font-size:12px; font-weight:600; color:#495057;">⚙️ Gợi ý chung (áp dụng cho tất cả bot)</span>
          <button type="button" id="inbox-save-global-style" style="font-size:11px; padding:2px 8px; cursor:pointer;">💾 Lưu</button>
        </div>
        <textarea id="inbox-global-reply-style" rows="2" style="width:100%; resize:vertical; font-size:12px; padding:6px; border:1px solid #dee2e6; border-radius:4px;" placeholder="💬 Cách trả lời: VD: Trả lời thân thiện, ngắn gọn. Luôn hỏi size trước khi đặt hàng.">${inboxEscape(inboxState.globalReplyStyle || "")}</textarea>
        <div style="margin-top:8px; padding-top:8px; border-top:1px dashed #dee2e6;">
          <div style="font-size:12px; font-weight:600; color:#495057; margin-bottom:4px;">🔑 API Key chung</div>
          <div style="display:flex; gap:6px;">
            <input id="inbox-global-api-key" type="password" style="flex:1; font-size:12px; padding:6px; border:1px solid #dee2e6; border-radius:4px;" value="${inboxEscapeAttr(inboxState.globalApiKey || "")}" placeholder="sk-... (bỏ trống nếu dùng riêng từng bot)">
            <button type="button" id="inbox-save-global-api-key" style="font-size:11px; padding:4px 10px; cursor:pointer;">💾 Lưu</button>
          </div>
        </div>
      </div>
    `;
    if (pages.length === 0) {
      inboxPageList.innerHTML =
        globalSection +
        '<div class="inbox-empty">Không tìm thấy Page phù hợp.</div>';
    } else {
      const pageItems = pages
        .map((page) => {
          const picture = inboxSafeUrl(page.picture);
          const tokenWarning =
            page.accessToken || inboxGetManualPageToken(page.id)
              ? ""
              : '<div style="color:#c92a2a; font-size:10px; margin-top:3px;">Thiếu Page Token</div>';
          const cfg = inboxGetAiConfig(page.id);
          // 🔑 Token dán tay của Page này (ưu tiên cao nhất)
          const manualToken = inboxGetManualPageToken(page.id);
          const checked = inboxState.selectedPageIds.has(page.id)
            ? "checked"
            : "";
          const aiBadge = cfg.enabled
            ? `<span class="ai-badge ai-on">AI bật</span>`
            : `<span class="ai-badge ai-off">AI tắt</span>`;
          return `
            <div class="inbox-page-item ${cfg.enabled ? "ai-active" : ""}" data-page-row="${inboxEscape(page.id)}">
              <label class="inbox-page-row-main">
                <input type="checkbox" class="inbox-page-checkbox" data-page-id="${inboxEscape(page.id)}" ${checked}>
                <span class="inbox-avatar">${picture ? `<img src="${picture}" alt="" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">` : inboxEscape(inboxInitials(page.name))}</span>
                <span class="inbox-page-meta">
                  <span class="inbox-page-name">${inboxEscape(page.name)} ${aiBadge}</span>
                  <span class="inbox-page-id">${inboxEscape(page.id)}</span>
                  ${tokenWarning}
                </span>
                <button type="button" class="ai-config-toggle" data-page-id="${inboxEscape(page.id)}" title="Cấu hình AI cho Page này">⚙️</button>
              </label>
              <div class="ai-config-panel" data-panel="${inboxEscape(page.id)}" hidden>
                <div class="ai-config-row">
                  <label style="display:flex; justify-content:space-between; align-items:center;">
                    <span>🔑 Page Access Token (dán tay — ưu tiên dùng token này)</span>
                    <span class="ai-page-token-badge" data-page-id="${inboxEscape(page.id)}" style="font-size:11px; color:#0284c7; font-weight:600;">${manualToken ? "Đang dùng token này ✅" : page.accessToken ? "Token tự động (từ User Token)" : "Chưa có token"}</span>
                  </label>
                  <div style="display:flex; gap:6px; align-items:center;">
                    <input class="ai-page-token" type="password" data-page-id="${inboxEscape(page.id)}" value="${inboxEscapeAttr(manualToken)}" placeholder="EAAxxxxx... (bỏ trống = dùng token tự động từ User Token)" autocomplete="off" style="flex:1; font-size:12px;">
                    <button type="button" class="ai-page-token-eye" data-page-id="${inboxEscape(page.id)}" title="Ẩn/Hiện token" style="font-size:12px; padding:4px 8px; cursor:pointer;">👁️</button>
                    <button type="button" class="ai-page-token-test" data-page-id="${inboxEscape(page.id)}" title="Kiểm tra token có hợp lệ không" style="font-size:12px; padding:4px 8px; cursor:pointer;">🧪</button>
                  </div>
                  <div class="ai-page-token-status" data-page-id="${inboxEscape(page.id)}" style="font-size:11px; margin-top:4px; color:#64748b;"></div>
                </div>
                <div class="ai-config-row">
                  <label class="ai-toggle">
                    <input type="checkbox" class="ai-enabled" data-page-id="${inboxEscape(page.id)}" ${cfg.enabled ? "checked" : ""}>
                    <span>Bật AI tự trả lời cho Page này</span>
                  </label>
                </div>
                <div class="ai-config-row">
                  <label class="ai-toggle">
                    <input type="checkbox" class="ai-auto-off-addr" data-page-id="${inboxEscape(page.id)}" ${cfg.autoOffOnAddress ? "checked" : ""}>
                    <span>Tự động tắt AI khi khách gửi địa chỉ</span>
                  </label>
                </div>
                <div class="ai-config-row">
                  <label class="ai-toggle">
                    <input type="checkbox" class="ai-auto-off-phone" data-page-id="${inboxEscape(page.id)}" ${cfg.autoOffOnPhone ? "checked" : ""}>
                    <span>Tự động tắt AI khi khách gửi số điện thoại</span>
                  </label>
                </div>
                <div class="ai-config-row">
                  <label>Thông tin sản phẩm / Shop</label>
                  <textarea class="ai-system" data-page-id="${inboxEscape(page.id)}" rows="3" placeholder="VD: Shop bán giày Nike, Adidas. Giá: 500k-2tr. Freeship đơn từ 500k...">${inboxEscape(cfg.system || "")}</textarea>
                </div>
                <div class="ai-config-row">
                  <label style="display:flex; justify-content:space-between; align-items:center;">
                    <span>🖼 Ảnh gửi kèm khi khách hỏi giá (Bảng giá / Mẫu sản phẩm)</span>
                    <span class="ai-price-img-count" data-page-id="${inboxEscape(page.id)}" style="font-size:11px; color:#0284c7; font-weight:600;">${(cfg.priceImages || []).length} ảnh</span>
                  </label>
                  <div class="ai-price-img-zone" data-page-id="${inboxEscape(page.id)}">
                    <input type="file" accept="image/*" multiple class="ai-price-file-input" data-page-id="${inboxEscape(page.id)}" style="display:none;" />
                    <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                      <button type="button" class="btn-ai-price-img-upload" data-page-id="${inboxEscape(page.id)}">📷 ${(cfg.priceImages || []).length > 0 ? `Thêm ảnh (${(cfg.priceImages || []).length})` : "Tải ảnh báo giá"}</button>
                      <span style="font-size:11px; color:#64748b;">Tự động gửi kèm khi khách hỏi giá</span>
                    </div>
                    <div class="ai-price-img-list" data-page-id="${inboxEscape(page.id)}" style="display:flex; flex-wrap:wrap; gap:6px; min-height:10px;">
                      ${(cfg.priceImages || [])
                        .map(
                          (src, imgIdx) => `
                        <div class="mkt-img-preview-box" data-page-id="${inboxEscape(page.id)}" data-img-idx="${imgIdx}">
                          <img src="${src}" class="mkt-img-preview-thumb ai-price-img-thumb" data-img-src="${src}" title="Bấm xem ảnh #${imgIdx + 1}" />
                          <button type="button" class="mkt-img-remove-btn ai-price-img-remove" data-page-id="${inboxEscape(page.id)}" data-img-idx="${imgIdx}" title="Xoá ảnh này">✕</button>
                        </div>
                      `,
                        )
                        .join("")}
                    </div>
                  </div>
                </div>
          
                <div class="ai-config-row ai-grid">
                  <div>
                    <label>Base URL</label>
                    <input class="ai-base" type="text" data-page-id="${inboxEscape(page.id)}" value="${inboxEscapeAttr(cfg.baseUrl)}" placeholder="https://api.openai.com/v1">
                  </div>
                  <div>
                    <label>Model</label>
                    <input class="ai-model" type="text" data-page-id="${inboxEscape(page.id)}" value="${inboxEscapeAttr(cfg.model)}" placeholder="gpt-4o-mini">
                  </div>
                </div>
                <div class="ai-config-row">
                  <label>API Key (lưu riêng cho Page này, bỏ trống nếu muốn dùng chung)</label>
                  <input class="ai-key" type="password" data-page-id="${inboxEscape(page.id)}" value="${inboxEscapeAttr(cfg.apiKey)}" placeholder="sk-...">
                </div>
                <div class="ai-config-row ai-actions">
                  <button type="button" class="ai-test" data-page-id="${inboxEscape(page.id)}">🧪 Test</button>
                  <button type="button" class="ai-save" data-page-id="${inboxEscape(page.id)}">💾 Lưu cấu hình</button>
                  <span class="ai-status" data-page-id="${inboxEscape(page.id)}"></span>
                </div>
              </div>
            </div>`;
        })
        .join("");
      inboxPageList.innerHTML = globalSection + pageItems;

      // 🛡 Khôi phục ô Page Access Token đang gõ + focus sau khi re-render
      if (tokenInputMemo) {
        const el = inboxPageList.querySelector(
          `.ai-page-token[data-page-id="${CSS.escape(tokenInputMemo.pageId)}"]`,
        );
        if (el) {
          el.value = tokenInputMemo.value;
          try {
            el.focus();
            el.setSelectionRange(
              tokenInputMemo.selStart,
              tokenInputMemo.selEnd,
            );
          } catch (e) {
            // ignore
          }
        }
      }
    }
    // Attach listeners for global controls (vì innerHTML xóa DOM cũ)
    const saveBtn = document.getElementById("inbox-save-global-style");
    if (saveBtn && !saveBtn._inboxBound) {
      saveBtn._inboxBound = true;
      saveBtn.addEventListener("click", async () => {
        const systemEl = document.getElementById("inbox-global-system");
        const styleEl = document.getElementById("inbox-global-reply-style");
        if (systemEl) inboxState.globalSystem = systemEl.value;
        if (styleEl) inboxState.globalReplyStyle = styleEl.value;
        if (systemEl)
          await inboxStorageSet("inboxGlobalSystem", inboxState.globalSystem);
        if (styleEl)
          await inboxStorageSet(
            "inboxGlobalReplyStyle",
            inboxState.globalReplyStyle,
          );
        const btn = document.getElementById("inbox-save-global-style");
        if (btn) {
          btn.textContent = "✅ Đã lưu";
          setTimeout(() => (btn.textContent = "💾 Lưu"), 1500);
        }
      });
    }
    const apiKeyBtn = document.getElementById("inbox-save-global-api-key");
    if (apiKeyBtn && !apiKeyBtn._inboxBound) {
      apiKeyBtn._inboxBound = true;
      apiKeyBtn.addEventListener("click", async () => {
        console.log("🟡 Nút Lưu API Key được bấm");
        const input = document.getElementById("inbox-global-api-key");
        if (!input) {
          console.error("❌ Không tìm thấy input");
          return;
        }
        inboxState.globalApiKey = input.value;
        await inboxStorageSet("inboxGlobalApiKey", inboxState.globalApiKey);
        console.log(
          "✅ Lưu xong, verify:",
          (await inboxStorageGet("inboxGlobalApiKey")) ? "(có)" : "(trống)",
        );
        const btn = document.getElementById("inbox-save-global-api-key");
        if (btn) {
          btn.textContent = "✅ OK";
          setTimeout(() => (btn.textContent = "💾 Lưu"), 2000);
        }
        // ⚡ Xử lý ngay các tin nhắn đang chờ (trước đó bị bỏ qua vì chưa có API key)
        setTimeout(() => {
          inboxMaybeAutoReplyAll().catch((e) =>
            console.error("❌ inboxMaybeAutoReplyAll lỗi:", e),
          );
        }, 500);
      });
    }
    const count = inboxState.selectedPageIds.size;
    const summary = document.getElementById("inbox-selection-summary");
    if (summary) summary.innerText = `Đã chọn ${count} Page`;
  }

  // ============================================================
  // 🏷 BỘ LỌC PAGE cho bulk-send & auto-tick
  // ============================================================
  if (!inboxState.marketingBulkPageFilter) {
    inboxState.marketingBulkPageFilter = null;
  }

  function inboxMarketingRenderPageFilter() {
    const listEl = document.getElementById("inbox-marketing-bulk-pages-list");
    if (!listEl) return;
    const pages = inboxState.pages || [];
    if (pages.length === 0) {
      listEl.innerHTML =
        '<span style="color:#94a3b8">Chưa load Page. Bấm "Chọn Page" → "Làm mới hộp thư" để load.</span>';
      return;
    }
    const filter = inboxState.marketingBulkPageFilter;
    listEl.innerHTML = pages
      .map((p) => {
        const checked = filter === null || filter.has(String(p.id));
        const safeName = inboxEscape(p.name || p.id);
        return `<label style="display:inline-flex;align-items:center;gap:4px;background:#fff;border:1px solid #cbd5e1;padding:3px 8px;border-radius:4px;cursor:pointer">
        <input type="checkbox" data-page-filter="${p.id}" ${checked ? "checked" : ""}>
        <span>${safeName}</span>
      </label>`;
      })
      .join("");
    listEl.querySelectorAll("input[data-page-filter]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const total = (inboxState.pages || []).length;
        const ids = Array.from(
          listEl.querySelectorAll("input[data-page-filter]:checked"),
        ).map((x) => x.getAttribute("data-page-filter"));
        inboxState.marketingBulkPageFilter =
          ids.length === total ? null : new Set(ids);
      });
    });
  }

  // Render lần đầu (sau khi DOM + state sẵn sàng) — sẽ tự re-render mỗi khi
  // load Pages xong (đã hook trong inboxLoadPages)
  setTimeout(() => {
    try {
      inboxMarketingRenderPageFilter();
    } catch (err) {
      console.warn("first render page filter error", err);
    }
  }, 800);

  // Nút "Chọn hết" / "Bỏ chọn hết"
  document
    .getElementById("inbox-marketing-bulk-pages-all")
    ?.addEventListener("click", (e) => {
      e.preventDefault();
      inboxState.marketingBulkPageFilter = null;
      inboxMarketingRenderPageFilter();
    });
  document
    .getElementById("inbox-marketing-bulk-pages-none")
    ?.addEventListener("click", (e) => {
      e.preventDefault();
      inboxState.marketingBulkPageFilter = new Set();
      document
        .querySelectorAll("input[data-page-filter]")
        .forEach((cb) => (cb.checked = false));
    });

  function inboxRenderConversationList() {
    if (!inboxConversationList) return;
    const query = (
      document.getElementById("inbox-conversation-search")?.value || ""
    )
      .trim()
      .toLowerCase();
    const tagFilter = inboxState.tagFilter || "";

    const visible = inboxState.conversations.filter((conversation) => {
      const contact = inboxGetContact(conversation);
      const pageName = conversation.__pageName || "";
      const matchQuery = `${contact} ${pageName} ${conversation.id}`
        .toLowerCase()
        .includes(query);
      if (!matchQuery) return false;
      const tags = inboxState.conversationTags[conversation.id] || [];
      if (!tagFilter) return true;
      if (tagFilter === "__none__") return tags.length === 0;
      return tags.includes(tagFilter);
    });
    inboxState.visibleConversations = visible;
    if (visible.length === 0) {
      inboxConversationList.innerHTML =
        '<div class="inbox-empty">Chưa có hội thoại phù hợp.<br>Hãy kiểm tra quyền Page Token hoặc làm mới dữ liệu.</div>';
      return;
    }
    inboxConversationList.innerHTML = visible
      .map((conversation, index) => {
        const lastMessage = inboxGetLastMessage(conversation);
        const contact = inboxGetContact(conversation);
        const pageName = conversation.__pageName || "Page";
        const preview =
          lastMessage?.message ||
          (lastMessage?.attachments?.data?.length
            ? "[Có tệp đính kèm]"
            : "Chưa có nội dung");
        const unread = Number(conversation.unread_count) || 0;
        const isActive =
          conversation.id === inboxState.selectedConversationId
            ? " active"
            : "";
        const tags = inboxState.conversationTags[conversation.id] || [];
        const hasTag = tags.length > 0 ? "1" : "0";
        const tagHtml = tags.length
          ? `<span class="conversation-tag-list">${tags
              .map(
                (t) =>
                  `<span class="conversation-tag" title="${inboxEscape(t)}">${inboxEscape(t)}<span class="conversation-tag-remove" data-remove-tag="${inboxEscape(t)}" title="Bỏ tag này">✕</span></span>`,
              )
              .join("")}</span>`
          : "";

        // 🎯 Hiển thị Tag Nhóm quảng cáo nếu khách đến từ Quảng cáo
        const ref = inboxGetConversationReferral(conversation);
        let adBadgeHtml = "";
        if (ref) {
          const adId = ref.ad_id;
          const adData = adId ? inboxState.adDetailsCache?.[adId] : null;
          const adLabel =
            adData?.adsetName ||
            adData?.adName ||
            ref.ad_title ||
            (adId ? `Ad #${adId.slice(-6)}` : "Quảng cáo");
          adBadgeHtml = `<span class="conversation-ad-tag" style="background:#fef3c7; color:#92400e; border:1px solid #fde68a; border-radius:3px; font-size:10px; padding:1px 5px; margin-left:4px; font-weight:600; display:inline-block; max-width:140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align:middle;" title="🎯 Nhóm: ${inboxEscape(adData?.adsetName || "Đang tra cứu...")} | 📁 Camp: ${inboxEscape(adData?.campaignName || "Đang tra cứu...")} | 📝 Ad: ${inboxEscape(adData?.adName || ref.ad_title || "")}">🎯 ${inboxEscape(adLabel)}</span>`;
        }

        return `<div class="conversation-item${isActive}" data-conversation-index="${index}" data-tagged="${hasTag}"><span class="inbox-avatar inbox-avatar-small">${inboxEscape(inboxInitials(contact))}</span><span class="conversation-main"><span class="conversation-topline"><span class="conversation-name">${inboxEscape(contact)}</span><span class="conversation-time">${inboxFormatTime(conversation.updated_time || lastMessage?.created_time)}</span></span><span class="conversation-preview">${inboxEscape(preview)}</span><span class="conversation-page-tag">${inboxEscape(pageName)}</span>${adBadgeHtml}${tagHtml}<button type="button" class="conversation-marketing-btn" data-marketing-btn="${conversation.id}" title="Gửi ngẫu nhiên 1 trong 10 câu tiếp thị">📣 Gửi tiếp thị lại</button></span></span>${unread > 0 ? `<span class="conversation-unread">${unread > 99 ? "99+" : unread}</span>` : ""}</div>`;
      })
      .join("");
    inboxRefreshTagFilterOptions();
  }

  function inboxRenderChat(conversation) {
    const adBannerEl = document.getElementById("inbox-chat-ad-banner");
    if (!conversation) {
      inboxState.selectedConversationId = null;
      if (adBannerEl) {
        adBannerEl.style.display = "none";
        adBannerEl.innerHTML = "";
      }
      if (inboxChatHeader)
        inboxChatHeader.innerHTML =
          '<div class="inbox-empty" style="width:100%; min-height:auto; padding:0;">Chọn một hội thoại để xem tin nhắn.</div>';
      if (inboxMessages)
        inboxMessages.innerHTML =
          '<div class="inbox-empty" style="width:100%; min-height:100%;">Tin nhắn của hội thoại được chọn sẽ hiển thị ở đây.</div>';
      if (inboxReplyInput) inboxReplyInput.disabled = true;
      if (inboxSendButton) inboxSendButton.disabled = true;
      inboxRenderConversationList();
      return;
    }
    inboxState.selectedConversationId = conversation.id;
    // Lazy load messages khi chưa load
    if (!conversation.__messagesLoaded && conversation.__pageToken) {
      inboxLoadConversationMessages(conversation);
    }
    const contact = inboxGetContact(conversation);
    const page = inboxState.pages.find(
      (item) => item.id === conversation.__pageId,
    );
    const pagePicture = inboxSafeUrl(page?.picture);
    const aiOff = inboxState.aiDisabledConvs.has(conversation.id);
    const label = aiOff ? "AI đang tắt" : "AI đang bật";
    const tags = inboxState.conversationTags[conversation.id] || [];
    const tagChipsHtml = tags.length
      ? `<div class="conversation-tag-list" style="margin-top:6px">${tags
          .map(
            (t) =>
              `<span class="conversation-tag">${inboxEscape(t)}<span class="conversation-tag-remove" data-conv-tag-remove="${inboxEscape(t)}" title="Bỏ tag">✕</span></span>`,
          )
          .join("")}</div>`
      : "";
    if (inboxChatHeader) {
      const pageId = conversation.__pageId || page?.id;
      const metaSuiteUrl = pageId
        ? `https://business.facebook.com/latest/inbox/messenger?asset_id=${pageId}&mailbox_id=${pageId}&selected_item_id=${encodeURIComponent(conversation.id)}`
        : `https://www.facebook.com/messages/t/${encodeURIComponent(inboxGetRecipientId(conversation) || "")}`;

      inboxChatHeader.innerHTML = `
        <span class="inbox-avatar">${pagePicture ? `<img src="${pagePicture}" alt="" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">` : inboxEscape(inboxInitials(conversation.__pageName))}</span>
        <span class="chat-header-info">
          <div style="display:flex; align-items:center; gap:6px;">
            <div class="chat-header-name">${inboxEscape(contact)}</div>
            <a href="${metaSuiteUrl}" target="_blank" class="btn" style="text-decoration:none; display:inline-flex; align-items:center; gap:4px; font-size:11px; padding:2px 8px; background:#1877f2; color:#fff; border-radius:4px; font-weight:600;" title="Mở trực tiếp trên Meta Business Suite (Dành cho khách Nhật/Châu Âu)">🔗 Meta Suite</a>
          </div>
          <div class="chat-header-page">${inboxEscape(conversation.__pageName)} · ${inboxGetMessages(conversation).length} tin gần nhất</div>
          ${tagChipsHtml}
        </span>
        <label class="ai-switch" id="inbox-conv-ai-toggle" title="Tắt/Bật AI cho hội thoại này"><input type="checkbox" ${aiOff ? "" : "checked"}><span class="ai-switch-slider"></span><span class="ai-switch-text">${label}</span></label>
      `;
    }

    // 🎯 Render Banner thông tin nguồn Quảng cáo (Chiến dịch + Nhóm QC + Mẫu QC)
    if (adBannerEl) {
      const ref = inboxGetConversationReferral(conversation);
      if (ref) {
        const adId = ref.ad_id;
        const adData = adId ? inboxState.adDetailsCache?.[adId] : null;
        const adTitle =
          ref.ad_title ||
          adData?.adName ||
          (adId ? `Ad #${adId}` : "Quảng cáo Facebook");
        const adsetName =
          adData?.adsetName ||
          (adId ? "⏳ Đang tra cứu nhóm..." : "Từ bài quảng cáo");
        const campaignName =
          adData?.campaignName ||
          (adId ? "⏳ Đang tra cứu chiến dịch..." : "Từ bài quảng cáo");
        const adsManagerUrl = adId
          ? `https://adsmanager.facebook.com/adsmanager/manage/ads?selected_ad_ids=${encodeURIComponent(adId)}`
          : "";

        adBannerEl.style.display = "block";
        adBannerEl.innerHTML = `
          <div style="background:linear-gradient(135deg, #f0fdf4 0%, #e0f2fe 100%); border-bottom:1px solid #bae6fd; padding:6px 12px; font-size:11px; display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;">
            <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
              <span style="font-weight:700; color:#0369a1; display:inline-flex; align-items:center; gap:4px;">🎯 NGUỒN QUẢNG CÁO:</span>
              <span style="background:#fff; border:1px solid #cbd5e1; padding:2px 6px; border-radius:4px; color:#0f172a;" title="Tên Chiến dịch">📁 <b>Camp:</b> ${inboxEscape(campaignName)}</span>
              <span style="background:#dbeafe; border:1px solid #93c5fd; padding:2px 6px; border-radius:4px; color:#1e40af; font-weight:700;" title="Tên Nhóm quảng cáo">🎯 <b>Nhóm:</b> ${inboxEscape(adsetName)}</span>
              <span style="background:#fff; border:1px solid #cbd5e1; padding:2px 6px; border-radius:4px; color:#334155;" title="Tên mẫu / Tiêu đề quảng cáo">📝 <b>Ad:</b> ${inboxEscape(adTitle)}</span>
            </div>
            ${adsManagerUrl ? `<a href="${adsManagerUrl}" target="_blank" style="color:#0284c7; text-decoration:none; font-size:11px; font-weight:600; white-space:nowrap; display:inline-flex; align-items:center; gap:3px;">📊 Ads Manager ↗</a>` : ""}
          </div>
        `;

        if (adId && !inboxState.adDetailsCache?.[adId]) {
          inboxFetchAdDetails(adId).then((details) => {
            if (details) {
              inboxRenderConversationList();
              const sel = inboxGetSelectedConversation();
              if (sel && String(sel.id) === String(conversation.id)) {
                inboxRenderChat(sel);
              }
            }
          });
        }
      } else {
        adBannerEl.style.display = "none";
        adBannerEl.innerHTML = "";
      }
    }
    const rawMessages = inboxGetMessages(conversation);
    const seenMsgIds = new Set();
    const messages = [...rawMessages]
      .filter((m) => {
        if (!m?.id) return true;
        if (seenMsgIds.has(m.id)) return false;
        seenMsgIds.add(m.id);
        return true;
      })
      .sort(
        (a, b) => new Date(a.created_time || 0) - new Date(b.created_time || 0),
      );
    if (inboxMessages) {
      // Hiển thị loading nếu chưa load messages
      if (!conversation.__messagesLoaded && conversation.__pageToken) {
        inboxMessages.innerHTML =
          '<div class="inbox-empty" style="width:100%; min-height:100%;">⏳ Đang tải tin nhắn...</div>';
      } else
        inboxMessages.innerHTML =
          messages.length === 0
            ? '<div class="inbox-empty" style="width:100%; min-height:100%;">Hội thoại chưa có tin nhắn để hiển thị.</div>'
            : messages
                .map((message) => {
                  const outgoing = message.from?.id === conversation.__pageId;

                  let bubbleHtml = "";
                  if (message.message) {
                    bubbleHtml += `<div class="message-text" style="white-space: pre-wrap; word-break: break-word;">${inboxEscape(message.message)}</div>`;
                  }

                  if (message.attachments?.data?.length > 0) {
                    const attachmentsHtml = message.attachments.data
                      .map((att) => {
                        const imgUrl =
                          att.image_data?.url ||
                          att.image_data?.preview_url ||
                          att.image_url ||
                          (att.mime_type?.startsWith("image/")
                            ? att.file_url || att.url
                            : "");
                        if (imgUrl) {
                          const safeImgUrl = inboxSafeUrl(imgUrl);
                          if (safeImgUrl) {
                            return `<a href="${safeImgUrl}" target="_blank"><img src="${safeImgUrl}" class="message-attachment-image" style="max-width: 250px; max-height: 250px; border-radius: 8px; margin-top: 6px; display: block; object-fit: contain; cursor: pointer; border: 1px solid #e4e6eb;" /></a>`;
                          }
                        }

                        const fileUrl = att.file_url || att.url;
                        if (fileUrl) {
                          const safeFileUrl = inboxSafeUrl(fileUrl);
                          if (safeFileUrl) {
                            return `<a href="${safeFileUrl}" target="_blank" class="message-attachment-link" style="display: inline-flex; align-items: center; gap: 4px; color: #1877f2; text-decoration: underline; font-size: 12px; margin-top: 6px; word-break: break-all;">📎 ${inboxEscape(att.name || "Tệp đính kèm")}</a>`;
                          }
                        }
                        return "";
                      })
                      .join("");
                    bubbleHtml += attachmentsHtml;
                  }

                  if (!bubbleHtml) {
                    bubbleHtml = `<div class="message-text" style="color: #bcc0c4; font-style: italic;">[Tin nhắn không có nội dung]</div>`;
                  }

                  return `<div class="message-row${outgoing ? " outgoing" : ""}"><div class="message-bubble">${bubbleHtml}</div><div class="message-time">${inboxEscape(message.from?.name || (outgoing ? conversation.__pageName : contact))} · ${inboxEscape(inboxFormatTime(message.created_time))}</div></div>`;
                })
                .join("");
      // Chỉ auto-scroll khi user đang ở gần đáy (100px) hoặc lần đầu render
      const wasAtBottom =
        inboxMessages.scrollHeight -
          inboxMessages.scrollTop -
          inboxMessages.clientHeight <
        100;
      const isFirstRender = !inboxMessages.dataset.rendered;
      if (wasAtBottom || isFirstRender) {
        inboxMessages.scrollTop = inboxMessages.scrollHeight;
        inboxMessages.dataset.rendered = "1";
      }
    }
    const canReply = Boolean(
      inboxGetRecipientId(conversation) && conversation.__pageToken,
    );
    if (inboxReplyInput) inboxReplyInput.disabled = !canReply;
    if (inboxSendButton) inboxSendButton.disabled = !canReply;
    inboxRenderConversationList();
  }

  function inboxSelectConversation(conversation) {
    inboxRenderChat(conversation);
    // Mark as read: cập nhật unread_count = 0 và re-render list
    if (Number(conversation.unread_count) > 0) {
      inboxMarkConversationAsRead(conversation);
    }
  }

  // Đánh dấu conversation đã đọc: set unread_count=0 và re-render list
  function inboxMarkConversationAsRead(conversation) {
    conversation.unread_count = 0;
    inboxRenderConversationList();
    // Có thể gọi Facebook API để sync server (best-effort, không chặn UI)
    if (conversation.__pageToken && conversation.id) {
      const url = `https://graph.facebook.com/${INBOX_GRAPH_VERSION}/${conversation.id}?unread_count=0&access_token=${encodeURIComponent(conversation.__pageToken)}`;
      fetch(url, { method: "POST" }).catch(() => {});
    }
  }

  // Auto-reply cho MỘT hội thoại cụ thể
  // Trả về: true = đã reply thành công / không cần reply,
  //         false = lỗi → caller có thể thử lại.
  async function inboxAutoReplyConversation(conversation) {
    if (!conversation) return true;
    const pageId = conversation.__pageId;
    const page = inboxState.pages.find((p) => String(p.id) === String(pageId));
    if (!page) return true;
    const config = inboxGetAiConfig(pageId);
    if (!config.enabled || !config.apiKey) return true;

    // Check lock
    if (inboxState.aiReplying.has(conversation.id)) return true;
    if (inboxState.aiDisabledConvs.has(conversation.id)) return true;

    const messages = conversation.messages?.data || [];
    if (messages.length === 0) return true;
    const sorted = [...messages].sort(
      (a, b) => new Date(a.created_time || 0) - new Date(b.created_time || 0),
    );
    const last = sorted[sorted.length - 1];
    if (!inboxIsCustomerMessage(last, conversation)) return true;

    // Check if already replied to this message
    if (inboxState.aiReplied[conversation.id] === last.id) return true;
    if (sorted.length >= 2) {
      const prev = sorted[sorted.length - 2];
      if (
        prev.message === last.message &&
        inboxState.aiReplied[conversation.id] === prev.id
      ) {
        inboxState.aiReplied[conversation.id] = last.id;
        return true;
      }
    }

    // Set lock
    inboxState.aiReplying.add(conversation.id);
    try {
      // Tự động tắt AI nếu khách gửi địa chỉ
      if (
        config.autoOffOnAddress &&
        (await inboxMessageHasAddress(last, pageId, conversation))
      ) {
        inboxState.aiDisabledConvs.add(conversation.id);
        console.log(
          `📍 Conv ${inboxGetContact(conversation)}: phát hiện địa chỉ → tắt AI`,
        );
        return true;
      }

      // Tự động tắt AI nếu khách gửi số điện thoại
      if (config.autoOffOnPhone && inboxMessageHasPhone(last)) {
        inboxState.aiDisabledConvs.add(conversation.id);
        console.log(
          `📱 Conv ${inboxGetContact(conversation)}: phát hiện số điện thoại → tắt AI`,
        );
        return true;
      }

      const history = sorted.slice(-10).map((m) => ({
        role: inboxIsCustomerMessage(m, conversation) ? "user" : "assistant",
        content:
          m.message || (m.attachments?.data?.length ? "[đã gửi tệp]" : ""),
      }));
      const combinedSystem = [
        inboxState.globalSystem,
        config.system,
        config.replyStyle || inboxState.globalReplyStyle,
      ]
        .filter(Boolean)
        .join("\n\n---\n\n");

      const aiReply = await inboxCallLlm({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        system: combinedSystem,
        messages: history,
      });

      if (!aiReply) return false;

      // 1. Kiểm tra xem đây có phải là tin nhắn đầu tiên của Bot với khách hàng không
      const allMsgs = conversation.messages?.data || [];
      const previousBotMsgs = allMsgs.filter(
        (m) => !inboxIsCustomerMessage(m, conversation),
      );
      const isFirstBotReply = previousBotMsgs.length === 0;

      // 2. Kiểm tra nếu khách hỏi giá HOẶC câu trả lời AI có báo giá/khuyến mãi
      const isCustomerAskingPrice = inboxIsPriceInquiry(last.message || "");
      const isAiGivingPrice = inboxAiReplyMentionsPrice(aiReply);

      // 3. Luôn luôn gửi kèm ảnh nếu là TIN NHẮN ĐẦU TIÊN hoặc khi hỏi giá/báo giá
      const shouldAttachPriceImgs =
        (isFirstBotReply || isCustomerAskingPrice || isAiGivingPrice) &&
        Array.isArray(config.priceImages) &&
        config.priceImages.length > 0;

      const priceImages = shouldAttachPriceImgs ? config.priceImages : [];

      if (priceImages.length > 0) {
        const reason = isFirstBotReply
          ? "Tin nhắn đầu tiên của Bot"
          : isCustomerAskingPrice
            ? "Khách hỏi giá"
            : "AI báo giá/khuyến mãi";
        console.log(
          `🖼️ [${reason}] → Tự động gửi kèm ${priceImages.length} ảnh cho ${inboxGetContact(conversation)} (Page ${pageId})`,
        );
      }

      const sent = await inboxSendAiReply({
        conversation,
        page,
        aiReply,
        images: priceImages,
      });
      if (sent) {
        inboxState.aiReplied[conversation.id] = last.id;
        await inboxStorageSet("inboxAiReplied", inboxState.aiReplied);
        console.log(`✅ AI đã trả lời cho ${inboxGetContact(conversation)}`);
        return true;
      }
      // Gửi tin nhắn thất bại → báo false để thử lại
      return false;
    } catch (error) {
      console.error(`❌ inboxAutoReplyConversation lỗi:`, error);
      const isJapanEuError =
        String(error?.message || "").includes("2018336") ||
        String(error?.message || "").includes("châu Âu và Nhật Bản") ||
        String(error?.message || "").includes("Europe and Japan");

      if (isJapanEuError) {
        // Ghi nhận để không lặp vô tận
        inboxState.aiReplied[conversation.id] = last.id;
        await inboxStorageSet("inboxAiReplied", inboxState.aiReplied);

        // Tự động gắn tag cảnh báo
        const currentTags = inboxState.conversationTags[conversation.id] || [];
        if (!currentTags.includes("🇯🇵 Mở Meta Suite")) {
          currentTags.push("🇯🇵 Mở Meta Suite");
          inboxState.conversationTags[conversation.id] = currentTags;
          await inboxPersistTags();
          inboxRenderConversationList();
          const sel = inboxGetSelectedConversation();
          if (sel && String(sel.id) === String(conversation.id)) {
            inboxRenderChat(sel);
          }
        }

        // Bắn thông báo Telegram kèm link Meta Suite trực tiếp
        const pageId = conversation.__pageId || page?.id;
        const metaSuiteUrl = `https://business.facebook.com/latest/inbox/messenger?asset_id=${pageId}&mailbox_id=${pageId}&selected_item_id=${encodeURIComponent(conversation.id)}`;
        const customerName = inboxGetContact(conversation);
        const alertHtml = `
⚠️ <b>[KHÁCH NHẬT BẢN] CẦN CHAT TRÊN META SUITE</b>
👤 <b>Khách:</b> ${inboxEscape(customerName)}
📄 <b>Page:</b> ${inboxEscape(page?.name || conversation.__pageName || "Fanpage")}
💬 <b>Khách nhắn:</b> <code>${inboxEscape(last.message || "Tin nhắn mới")}</code>
💡 <b>Lý do:</b> Luật riêng tư APPI/ePrivacy Nhật Bản chặn Bot API. Hãy chat trực tiếp!
🔗 <a href="${metaSuiteUrl}">👉 BẤM VÀO ĐÂY ĐỂ VÀO CHAT NGAY</a>
        `.trim();
        await inboxSendTelegramAlert(alertHtml).catch(() => {});
        return true;
      }
      // ⚡ Lỗi khác (mạng, rate limit OpenAI) → trả false để thử lại ở vòng sau
      return false;
    } finally {
      inboxState.aiReplying.delete(conversation.id);
    }
  }

  /**
   * Trao đổi User Access Token (EAAB...) thành Page Access Token cho 1 page cụ thể.
   * Endpoint: GET /{page-id}?fields=access_token&access_token={user_token}
   * - Có cache theo pageId để tránh gọi lại nhiều lần (gây rate limit 368)
   * - Có backoff khi Meta trả về 368 (Temporarily blocked)
   * - Tự fallback: nếu me/accounts không trả access_token thì gọi endpoint này để lấy
   */
  const _pageTokenCache = new Map(); // pageId -> { token, expiresAt }
  const _pageTokenInflight = new Map(); // pageId -> Promise
  const _pageTokenBlockedUntil = new Map(); // pageId -> timestamp hết block

  async function inboxExchangePageToken(pageId, userToken, attempt = 0) {
    if (!pageId || !userToken) return "";
    const cached = _pageTokenCache.get(String(pageId));
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.token;
    }
    // Nếu đang bị Meta block cho page này thì trả cache cũ (nếu có) hoặc chuỗi rỗng
    const blockedUntil = _pageTokenBlockedUntil.get(String(pageId)) || 0;
    if (blockedUntil > Date.now()) {
      return cached?.token || "";
    }
    // Dedupe nếu đang có 1 promise trao đổi cho page này
    const inflightKey = String(pageId);
    if (_pageTokenInflight.has(inflightKey)) {
      return _pageTokenInflight.get(inflightKey);
    }
    const p = (async () => {
      try {
        const url = `https://graph.facebook.com/${INBOX_GRAPH_VERSION}/${encodeURIComponent(pageId)}?fields=access_token&access_token=${encodeURIComponent(userToken)}`;
        const res = await fetch(url);
        const data = await res.json().catch(() => ({}));
        if (data?.error) {
          const code = data.error.code;
          if (code === 368) {
            // Rate limit - backoff 60s * 2^attempt, tối đa 10 phút
            const wait = Math.min(60_000 * Math.pow(2, attempt), 10 * 60_000);
            _pageTokenBlockedUntil.set(String(pageId), Date.now() + wait);
            console.warn(
              `[Inbox] Page ${pageId} bị Meta rate limit khi trao đổi Page Token, đợi ${Math.round(wait / 1000)}s`,
            );
            if (attempt < 4) {
              await new Promise((r) => setTimeout(r, wait));
              return inboxExchangePageToken(pageId, userToken, attempt + 1);
            }
            return cached?.token || "";
          }
          // Lỗi khác (thiếu scope, token invalid...) -> trả cache cũ
          console.warn(
            `[Inbox] Không trao đổi được Page Token cho ${pageId}:`,
            data.error.message,
          );
          return cached?.token || "";
        }
        const pageToken = data?.access_token || "";
        if (pageToken) {
          // Cache 50 phút (Page Token từ User Token live ~1 giờ, để an toàn cache 50p)
          _pageTokenCache.set(String(pageId), {
            token: pageToken,
            expiresAt: Date.now() + 50 * 60 * 1000,
          });
        }
        return pageToken || cached?.token || "";
      } catch (e) {
        console.warn(`[Inbox] Lỗi mạng khi trao đổi Page Token ${pageId}:`, e);
        return cached?.token || "";
      } finally {
        _pageTokenInflight.delete(inflightKey);
      }
    })();
    _pageTokenInflight.set(inflightKey, p);
    return p;
  }

  /**
   * 🔑 Lấy Page Access Token DÁN TAY của 1 page (nếu người dùng nhập).
   *    Nguồn: ô "Page Access Token" trong panel ⚙️ của từng Page.
   *    Đây là nguồn ưu tiên CAO NHẤT — không cần User Token, không cần
   *    trao đổi, không bị ảnh hưởng bởi rate limit trao đổi token.
   */
  function inboxGetManualPageToken(pageId) {
    if (!pageId) return "";
    const key = String(pageId);
    // 1) Token đang gõ (chưa qua debounce) — ưu tiên để phản hồi tức thì
    const pending = inboxState._pendingPageTokens?.[key];
    if (pending !== undefined) return String(pending).trim();
    // 2) Token đã lưu
    const saved = inboxState.pageTokens?.[key] || "";
    if (saved) return String(saved).trim();
    // 3) Đọc trực tiếp từ ô input (trường hợp DOM vừa render)
    try {
      const el = document.querySelector(
        `.ai-page-token[data-page-id="${CSS.escape(key)}"]`,
      );
      const v = el?.value?.trim();
      if (v) return v;
    } catch (e) {
      // ignore
    }
    return "";
  }

  /**
   * Lấy accessToken hiệu lực cho 1 page trong Inbox:
   *   1) ƯU TIÊN CAO NHẤT: Page Access Token dán tay của user (nếu có)
   *   2) page.accessToken (lấy từ me/accounts - thường là Page Token)
   *   3) Nếu rỗng, dùng User Token (từ ô tokenInput) gọi inboxExchangePageToken
   *      để trao đổi thành Page Token (có cache + backoff 368)
   *   4) Trả về chuỗi rỗng nếu không lấy được -> caller sẽ bỏ qua page đó
   */
  async function inboxResolvePageToken(page) {
    if (!page) return "";
    // 1) Token dán tay — ưu tiên cao nhất
    const manual = inboxGetManualPageToken(page.id);
    if (manual) return manual;
    // 2) Token đã lấy sẵn
    if (page.accessToken) return page.accessToken;
    // 3) Trao đổi từ User Token
    const userToken = document.getElementById("tokenInput")?.value.trim() || "";
    if (!userToken) return "";
    return await inboxExchangePageToken(page.id, userToken);
  }

  async function inboxLoadPages() {
    const token = document.getElementById("tokenInput")?.value.trim();
    if (!token)
      return alert(
        "⚠️ Vui lòng lấy Access Token trước khi tải danh sách Page!",
      );
    const button = document.getElementById("btn-load-inbox-pages");
    if (button) {
      button.disabled = true;
      button.innerText = "⏳ ĐANG TẢI PAGE...";
    }
    if (inboxStatus) inboxStatus.innerText = "Đang tải danh sách Page...";
    try {
      const fields = "id,name,access_token,picture.type(large)";
      const url = `https://graph.facebook.com/${INBOX_GRAPH_VERSION}/me/accounts?fields=${encodeURIComponent(fields)}&limit=100&access_token=${encodeURIComponent(token)}`;
      const pages = await inboxFetchAll(url, 10);
      const storedIds = await inboxStorageGet("inboxSelectedPageIds");
      const savedIds = Array.isArray(storedIds) ? storedIds : [];
      inboxState.pages = pages
        .filter((page) => page.id && page.name)
        .map((page) => ({
          id: String(page.id),
          name: page.name,
          accessToken: page.access_token || "",
          picture: page.picture?.data?.url || "",
        }));
      const availableIds = new Set(inboxState.pages.map((page) => page.id));
      inboxState.selectedPageIds = new Set(
        savedIds.filter((id) => availableIds.has(String(id))).map(String),
      );
      // 🔑 ÁP token dán tay lên page.accessToken (ưu tiên cao nhất)
      for (const page of inboxState.pages) {
        page.autoToken = page.accessToken || "";
        const manual = inboxState.pageTokens?.[String(page.id)];
        if (manual) page.accessToken = manual;
      }
      // Lưu cache token và pages để tránh gọi API nhiều lần
      await inboxStorageSet("inboxCachedToken", token);
      await inboxStorageSet("inboxCachedPages", inboxState.pages);
      await inboxStorageSet("inboxCachedPagesAt", Date.now());
      console.log(`💾 Đã lưu cache ${inboxState.pages.length} Page`);
      inboxRenderPageList();
      // Render lại list filter Page cho bulk/auto marketing (ngay sau khi load)
      try {
        inboxMarketingRenderPageFilter();
      } catch (err) {
        console.warn("render marketing page filter error", err);
      }
      // KHÔNG trao đổi Page Token tự động ở đây — sẽ trao đổi LAZY
      // chỉ khi user tick chọn page (xem handler inbox-page-checkbox bên dưới)
      // hoặc khi gọi /conversations (xem inboxResolvePageToken).
      // Lý do: tránh Meta rate limit (368) khi user có nhiều page.
      inboxState.conversations = [];
      inboxRenderConversationList();
      if (inboxStatus)
        inboxStatus.innerText = `${inboxState.pages.length} Page · đã chọn ${inboxState.selectedPageIds.size}`;
      inboxSyncBackgroundConfig();
      if (inboxState.selectedPageIds.size > 0) {
        inboxStartLive();
        inboxRefresh(true).catch(() => {});
      } else {
        inboxStopLive();
      }
    } catch (error) {
      if (inboxPageList)
        inboxPageList.innerHTML = `<div class="inbox-error">Không tải được Page: ${inboxEscape(error.message)}<br>Kiểm tra pages_show_list và quyền truy cập token.</div>`;
      if (inboxStatus) inboxStatus.innerText = "Lỗi tải Page";
    } finally {
      if (button) {
        button.disabled = false;
        button.innerText = "🔄 TẢI DANH SÁCH PAGE";
      }
    }
  }

  async function inboxRefresh(initial = true) {
    if (inboxState.loading) return;
    const selectedPages = inboxState.pages.filter((page) =>
      inboxState.selectedPageIds.has(page.id),
    );
    if (selectedPages.length === 0)
      return alert("⚠️ Hãy chọn ít nhất 1 Page trước khi làm mới hộp thư!");
    inboxState.loading = true;
    // Hiển thị cache ngay lập tức nếu có (TTL 2 phút)
    if (initial) {
      try {
        const cached = await inboxStorageGet("inboxBgCache");
        const cachedAt = await inboxStorageGet("inboxBgCacheAt");
        const isFresh = cachedAt && Date.now() - cachedAt < 120000;
        if (Array.isArray(cached) && cached.length && isFresh) {
          inboxState.conversations = cached.map((c) => ({
            ...c,
            __messagesLoaded: false,
          }));
          inboxState.selectedConversationId = null;
          inboxRenderChat(null);
          inboxMergeConversations([]);
        }
      } catch {}
      inboxState.conversations = [];
      inboxState.selectedConversationId = null;
      inboxRenderChat(null);
      if (inboxConversationList)
        inboxConversationList.innerHTML =
          '<div class="inbox-loading">⏳ Đang tải hội thoại từ các Page đã chọn...</div>';
      if (inboxMessages)
        inboxMessages.innerHTML =
          '<div class="inbox-empty" style="width:100%; min-height:100%;">Đang tải tin nhắn...</div>';
    } else if (inboxStatus) {
      inboxStatus.innerText = "🔄 Đang cập nhật hội thoại...";
    }
    const errors = [];
    try {
      // Load metadata KHÔNG kèm messages (để load nhanh), messages load lazy khi click
      const fields = "id,updated_time,unread_count,participants,snippet";
      const userToken =
        document.getElementById("tokenInput")?.value.trim() || "";
      // Tìm các page đã chọn nhưng chưa có Page Token -> cần trao đổi
      // 🔑 Nhưng nếu Page có token DÁN TAY thì không cần trao đổi gì cả.
      // Chạy TUẦN TỰ + delay 200ms để tránh Meta rate limit (368)
      const pagesNeedingToken = selectedPages.filter(
        (page) => !page.accessToken && !inboxGetManualPageToken(page.id),
      );
      if (pagesNeedingToken.length > 0) {
        if (inboxStatus)
          inboxStatus.innerText = `🔐 Đang lấy Page Token cho ${pagesNeedingToken.length} Page (tuần tự)...`;
        for (let i = 0; i < pagesNeedingToken.length; i++) {
          const page = pagesNeedingToken[i];
          try {
            const pageToken = await inboxResolvePageToken(page);
            if (pageToken) {
              page.accessToken = pageToken;
              // Cập nhật cache để lần sau không cần trao đổi
              await inboxStorageSet("inboxCachedPages", inboxState.pages);
            }
          } catch (e) {}
          if (inboxStatus)
            inboxStatus.innerText = `🔐 Lấy Page Token ${i + 1}/${pagesNeedingToken.length}...`;
          // Delay 200ms giữa các lần trao đổi (Meta rate limit: ~5 req/s/user)
          if (i < pagesNeedingToken.length - 1) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }
      const pagePromises = selectedPages.map(async (page) => {
        // 🔑 ƯU TIÊN: token dán tay → token đã lấy sẵn → trao đổi (đã xong ở trên)
        const effectiveToken =
          inboxGetManualPageToken(page.id) || page.accessToken;
        if (!effectiveToken) {
          errors.push(
            `${page.name}: chưa có Page Access Token (User Token thiếu quyền pages_show_list / pages_messaging)`,
          );
          return [];
        }
        try {
          const url = `https://graph.facebook.com/${INBOX_GRAPH_VERSION}/${page.id}/conversations?platform=messenger&folder=${encodeURIComponent(inboxState.folder.toUpperCase())}&fields=${encodeURIComponent(fields)}&limit=100&access_token=${encodeURIComponent(effectiveToken)}`;
          const conversations = await inboxFetchAll(url, 1);
          conversations.forEach((conversation) =>
            Object.assign(conversation, {
              __pageId: page.id,
              __pageName: page.name,
              __pageToken: effectiveToken,
              __messagesLoaded: false,
            }),
          );
          return conversations;
        } catch (error) {
          errors.push(`${page.name}: ${error.message}`);
          return [];
        }
      });
      // Chạy song song tất cả page thay vì tuần tự
      const results = await Promise.all(pagePromises);
      const incoming = results.flat();
      inboxMergeConversations(incoming);
      chrome.storage?.local?.set({
        inboxBgCache: inboxState.conversations,
        inboxBgCacheAt: Date.now(),
      });
      const errorText = errors.length
        ? ` · ${errors.length} Page lỗi quyền`
        : "";
      inboxUpdateLiveBadge();
      if (inboxStatus)
        inboxStatus.innerText = `${inboxState.conversations.length} hội thoại · ${selectedPages.length} Page · ${inboxState.live ? "🟢 Realtime" : "🟡 Tự động cập nhật"}${errorText}`;
      if (errors.length && inboxConversationList && initial)
        inboxConversationList.insertAdjacentHTML(
          "afterbegin",
          `<div class="inbox-error">${errors.map((error) => inboxEscape(error)).join("<br>")}</div>`,
        );
    } finally {
      inboxState.loading = false;
      inboxState.lastPollAt = Date.now();
      inboxSyncBackgroundConfig();
      inboxTickLiveStatus();
      // 🎯 User bấm nút "LÀM MỚI HỘP THƯ" → dùng force để bypass backoff token
      chrome.runtime?.sendMessage?.({ type: "inbox-poll-force" }, () => {
        void chrome.runtime?.lastError;
      });
    }
  }

  function inboxMergeConversations(incoming) {
    if (!Array.isArray(incoming)) return;
    const map = new Map(
      inboxState.conversations.map((conversation) => [
        conversation.id,
        conversation,
      ]),
    );
    incoming.forEach((conversation) => {
      const existing = map.get(conversation.id);
      if (existing) {
        const newMessages = conversation.messages?.data || [];
        const oldMessages = existing.messages?.data || [];
        const seen = new Set();
        const merged = [];

        // 1. Thêm toàn bộ tin nhắn mới từ Facebook
        newMessages.forEach((msg) => {
          if (msg?.id && !seen.has(msg.id)) {
            seen.add(msg.id);
            merged.push(msg);
          }
        });

        // 2. Giữ lại tin nhắn cũ nếu chưa có (và dọn dẹp tin nhắn local nếu đã có tin nhắn FB cùng nội dung)
        oldMessages.forEach((oldMsg) => {
          if (!oldMsg?.id || seen.has(oldMsg.id)) return;
          if (String(oldMsg.id).startsWith("local")) {
            const oldTime = new Date(oldMsg.created_time || 0).getTime();
            const isDuplicatedByServer = newMessages.some((srvMsg) => {
              if (srvMsg.message !== oldMsg.message) return false;
              const srvTime = new Date(srvMsg.created_time || 0).getTime();
              return Math.abs(srvTime - oldTime) < 180000; // trong vòng 3 phút
            });
            if (isDuplicatedByServer) return; // Đã có bản từ server, bỏ bản local
          }
          seen.add(oldMsg.id);
          merged.push(oldMsg);
        });

        existing.messages = { data: merged };
        existing.updated_time =
          conversation.updated_time || existing.updated_time;
        existing.unread_count =
          conversation.unread_count ?? existing.unread_count;
        existing.can_reply = conversation.can_reply ?? existing.can_reply;
        existing.participants =
          conversation.participants || existing.participants;
        existing.senders = conversation.senders || existing.senders;
        map.set(conversation.id, existing);
      } else {
        map.set(conversation.id, conversation);
      }
    });
    inboxState.conversations = Array.from(map.values());
    inboxState.conversations.sort((a, b) => {
      const aTime = new Date(a.updated_time || 0).getTime();
      const bTime = new Date(b.updated_time || 0).getTime();
      if (bTime !== aTime) return bTime - aTime;
      const aCustomer = new Date(
        inboxGetLastCustomerMessageTime(a) || 0,
      ).getTime();
      const bCustomer = new Date(
        inboxGetLastCustomerMessageTime(b) || 0,
      ).getTime();
      return bCustomer - aCustomer;
    });
    inboxRenderConversationList();
    const selected = inboxState.conversations.find(
      (item) => item.id === inboxState.selectedConversationId,
    );
    if (selected) inboxRenderChat(selected);

    // ⚡ TỐI ƯU TOKEN: Debounce 1.5s cho pipeline LLM.
    // Background gửi data qua 2 kênh (storage.onChanged + runtime.onMessage)
    // → trước đây inboxMaybeAutoReplyAll chạy 2 lần cho cùng dữ liệu,
    // nhân đôi số request OpenAI. Giờ gộp lại chỉ chạy 1 lần.
    if (inboxState.autoReplyDebounceTimer) {
      clearTimeout(inboxState.autoReplyDebounceTimer);
    }
    inboxState.autoReplyDebounceTimer = setTimeout(() => {
      inboxState.autoReplyDebounceTimer = null;
      inboxMaybeAutoReplyAll().catch((e) =>
        console.error("❌ inboxMaybeAutoReplyAll lỗi:", e),
      );
    }, 1500);
  }

  let inboxPollTimeout = null;
  let _lastAdaptiveIntervalMs = 12000;

  async function getDynamicInterval() {
    try {
      const data = await chrome.storage.local.get(["inboxLastActivityTime"]);
      const lastActivity = Number(data.inboxLastActivityTime) || 0;
      const idleTime = Date.now() - lastActivity;

      // 1. Kiểm tra xem có tin nhắn khách hàng mới trong 3 phút gần nhất không
      let recentCustomerMessage = false;
      if (Array.isArray(inboxState.conversations)) {
        for (const c of inboxState.conversations) {
          const t = inboxGetLastCustomerMessageTime(c) || c.updated_time;
          if (t && Date.now() - new Date(t).getTime() < 3 * 60 * 1000) {
            recentCustomerMessage = true;
            break;
          }
        }
      }

      // 2. NẾU ĐANG CÓ KHÁCH NHẮN TIN -> 30 giây/lần (Dashboard chỉ đọc cache từ background,
      // background.js đã poll mỗi 1 phút alarm + mỗi 15s qua inbox-poll-now → đủ realtime)
      // Để tránh Meta rate limit (368) khi user có nhiều Page.
      if (recentCustomerMessage) {
        _lastAdaptiveIntervalMs = 30000;
        return 30000;
      }

      // 3. Khi tab bị ẩn / thu nhỏ nhưng CHƯA có tin nhắn mới -> Quét mỗi 20 giây/lần
      // Đảm bảo khi khách nhắn tới, tối đa chỉ 10-20s là AI phát hiện và tự động trả lời ngay
      if (document.hidden) {
        _lastAdaptiveIntervalMs = 20000;
        return 20000;
      }

      // 4. Khi đang xem tab và vừa thao tác chuột / phím trong vòng 2 phút -> 10 giây/lần
      if (idleTime < 2 * 60 * 1000) {
        _lastAdaptiveIntervalMs = 10000;
        return 10000;
      }
      // 5. Nếu rảnh từ 2 - 8 phút -> Dãn ra 25 giây/lần
      else if (idleTime < 8 * 60 * 1000) {
        _lastAdaptiveIntervalMs = 25000;
        return 25000;
      }
      // 6. Nếu rảnh từ 8 - 25 phút -> Dãn ra 50 giây/lần
      else if (idleTime < 25 * 60 * 1000) {
        _lastAdaptiveIntervalMs = 50000;
        return 50000;
      }
      // 7. Nếu rảnh > 25 phút (treo máy đi vắng) -> Dãn ra 2 phút/lần
      else {
        _lastAdaptiveIntervalMs = 120000;
        return 120000;
      }
    } catch {
      _lastAdaptiveIntervalMs = 15000;
      return 15000;
    }
  }

  // Lắng nghe hoạt động người dùng để co thời gian quét và cập nhật tức thì
  function inboxRecordUserActivity() {
    chrome.storage?.local?.set({ inboxLastActivityTime: Date.now() });
  }
  window.addEventListener("click", inboxRecordUserActivity, { passive: true });
  window.addEventListener("keydown", inboxRecordUserActivity, {
    passive: true,
  });
  window.addEventListener(
    "mousemove",
    () => {
      if (
        !window._lastMouseActivity ||
        Date.now() - window._lastMouseActivity > 10000
      ) {
        window._lastMouseActivity = Date.now();
        inboxRecordUserActivity();
      }
    },
    { passive: true },
  );
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      inboxRecordUserActivity();
      // ❌ TẮT: không gọi runAdaptivePoll khi focus lại tab.
      // Dashboard nhận data realtime qua message "inbox-bg-updated" từ background.
      // if (inboxState.live) {
      //   if (inboxPollTimeout) clearTimeout(inboxPollTimeout);
      //   runAdaptivePoll().catch(() => {});
      // }
    }
  });

  async function runAdaptivePoll() {
    if (!inboxState.live) {
      inboxPollTimeout = null;
      return;
    }

    try {
      // 1) Yêu cầu background poll ngay
      await new Promise((resolve) => {
        chrome.runtime?.sendMessage?.({ type: "inbox-poll-now" }, () => {
          void chrome.runtime?.lastError;
          resolve();
        });
      });

      // 2) Đọc cache mới nhất từ background để cập nhật UI ngay
      await new Promise((resolve) => {
        chrome.runtime?.sendMessage?.({ type: "inbox-get-cache" }, (resp) => {
          void chrome.runtime?.lastError;
          if (resp?.ok && resp.data?.inboxBgCache) {
            const incoming = resp.data.inboxBgCache;
            if (Array.isArray(incoming) && incoming.length > 0) {
              inboxMergeConversations(incoming);
              inboxState.lastPollAt = Date.now();
              inboxTickLiveStatus();
            }
          }
          resolve();
        });
      });
    } catch (err) {
      console.warn("Lỗi trong adaptive poll loop:", err);
    }

    // ❌ TẮT vòng lặp tự động: dashboard KHÔNG tự lên lịch poll nữa.
    // Background (service worker) đã chạy alarm 1 phút + nhận "inbox-poll-now".
    // Dashboard chỉ nhận data qua message "inbox-bg-updated" → inboxMergeConversations.
    // Lý do: tránh Meta rate limit (368) khi user có nhiều Page đang chọn.
    //
    // Nếu muốn bật lại realtime poll từ dashboard, comment out block dưới:
    //
    // const nextInterval = await getDynamicInterval();
    // if (inboxState.live) {
    //   if (inboxPollTimeout) clearTimeout(inboxPollTimeout);
    //   inboxPollTimeout = setTimeout(() => {
    //     runAdaptivePoll().catch(() => {});
    //   }, nextInterval);
    // }
    if (inboxPollTimeout) {
      clearTimeout(inboxPollTimeout);
      inboxPollTimeout = null;
    }
    inboxTickLiveStatus();
  }

  function inboxStartLive() {
    inboxState.live = true;
    inboxUpdateLiveBadge();

    // Reset activity time
    inboxRecordUserActivity();

    // ❌ TẮT: Dashboard không tự poll /conversations nữa.
    // Lý do: background.js (service worker) đã lo polling + auto-reply qua alarm 1 phút
    // và message "inbox-poll-now". Dashboard chỉ cần lắng nghe "inbox-bg-updated"
    // để nhận cache mới. Tránh Meta rate limit (368) do gọi trùng lặp.
    // if (!inboxPollTimeout) {
    //   runAdaptivePoll().catch(() => {});
    // }
  }

  function inboxStopLive() {
    if (inboxPollTimeout) clearTimeout(inboxPollTimeout);
    inboxPollTimeout = null;
    inboxState.live = false;
    inboxUpdateLiveBadge();
    inboxTickLiveStatus();
  }

  function inboxUpdateLiveBadge() {
    const btn = document.getElementById("btn-refresh-inbox");
    if (!btn) return;
    if (inboxState.live) {
      btn.innerText = "🟢 Realtime";
      btn.title = "Hộp thư tự động cập nhật thích ứng. Bấm để làm mới ngay.";
      btn.setAttribute("data-live", "1");
    } else {
      btn.innerText = "🔄 LÀM MỚI HỘP THƯ";
      btn.title = "";
      btn.removeAttribute("data-live");
    }
  }

  function inboxTickLiveStatus(prefix = "") {
    if (!inboxStatus) return;
    // 🔴 Nếu đang báo lỗi token → giữ nguyên cảnh báo, không ghi đè
    if (inboxState.tokenError) {
      inboxStatus.innerText = "🔴 Token hết hạn";
      inboxStatus.style.color = "#c92a2a";
      return;
    }
    const at = new Date(
      inboxState.lastPollAt || Date.now(),
    ).toLocaleTimeString();
    const count = inboxState.conversations.length;
    const live = inboxState.live;
    const intervalSec = Math.round((_lastAdaptiveIntervalMs || 12000) / 1000);
    const intervalStr =
      intervalSec >= 60
        ? `${Math.round(intervalSec / 60)}p`
        : `${intervalSec}s`;

    inboxStatus.innerText = `${prefix}${count} hội thoại · ${live ? `🟢 Realtime (${intervalStr})` : "🟡 Tạm dừng"} · đồng bộ ${at}`;
  }

  // 👉 Khi service worker vừa được đánh thức, tự động poll ngay
  chrome.runtime?.onMessage?.addListener?.((msg) => {
    if (msg?.type === "inbox-bg-updated" && inboxState.live) {
      chrome.runtime.sendMessage({ type: "inbox-get-cache" }, (resp) => {
        void chrome.runtime?.lastError;
        if (!resp?.ok || !resp.data?.inboxBgCache) return;
        inboxMergeConversations(resp.data.inboxBgCache);
        inboxState.lastPollAt = Date.now();
        inboxTickLiveStatus();
      });
    }
  });

  function inboxUpdateLiveStatus() {
    const selectedCount = inboxState.pages.filter((page) =>
      inboxState.selectedPageIds.has(page.id),
    ).length;
    if (selectedCount === 0) {
      inboxStopLive();
      if (inboxStatus)
        inboxStatus.innerText = `${inboxState.pages.length} Page · chưa chọn Page nào`;
      return;
    }
    inboxStartLive();
  }

  async function inboxSendReply() {
    const conversation = inboxState.conversations.find(
      (item) => item.id === inboxState.selectedConversationId,
    );
    const messageText = inboxReplyInput?.value.trim();
    if (!conversation || !messageText) return;
    const recipientId = inboxGetRecipientId(conversation);
    if (!recipientId || !conversation.__pageToken)
      return alert("❌ Không xác định được người nhận hoặc Page Token.");
    if (inboxSendButton) {
      inboxSendButton.disabled = true;
      inboxSendButton.innerText = "⏳...";
    }
    try {
      const body = new URLSearchParams({
        recipient: JSON.stringify({ id: recipientId }),
        messaging_type: "RESPONSE",
        message: JSON.stringify({ text: messageText }),
        access_token: conversation.__pageToken,
      });
      const data = await inboxGraphJson(
        `https://graph.facebook.com/${INBOX_GRAPH_VERSION}/${conversation.__pageId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        },
      );
      const page = inboxState.pages.find(
        (item) => item.id === conversation.__pageId,
      );
      const sentMessage = {
        id: String(data?.message_id || `local-${Date.now()}`),
        created_time: new Date().toISOString(),
        from: {
          id: conversation.__pageId,
          name: page?.name || conversation.__pageName,
        },
        message: messageText,
        __localSent: true,
      };
      if (!conversation.messages) conversation.messages = { data: [] };
      conversation.messages.data.push(sentMessage);
      conversation.updated_time = sentMessage.created_time;
      if (inboxReplyInput) inboxReplyInput.value = "";
      if (inboxStatus) inboxStatus.innerText = "Đã gửi tin nhắn thành công";
      inboxRenderChat(conversation);
      inboxRenderConversationList();
    } catch (error) {
      const isJapanEuError =
        String(error?.message || "").includes("2018336") ||
        String(error?.message || "").includes("châu Âu và Nhật Bản") ||
        String(error?.message || "").includes("Europe and Japan");

      if (isJapanEuError) {
        const pageId = conversation.__pageId;
        const metaSuiteUrl = `https://business.facebook.com/latest/inbox/messenger?asset_id=${pageId}&mailbox_id=${pageId}&selected_item_id=${encodeURIComponent(conversation.id)}`;

        inboxAddTagToSelected("🇯🇵 Mở Meta Suite");

        const openNow = confirm(
          "⚠️ KHÁCH HÀNG THUỘC KHU VỰC NHẬT BẢN / CHÂU ÂU:\n\n" +
            "Meta (Facebook) bắt buộc các cuộc trò chuyện tại Nhật Bản phải nhắn trực tiếp trên giao diện Meta Business Suite (theo luật ePrivacy/APPI của Meta).\n\n" +
            "👉 Bấm OK để mở ngay cuộc trò chuyện này trên Meta Business Suite và gửi tin nhắn (nội dung bạn gõ vẫn được lưu giữ)!",
        );
        if (openNow) {
          window.open(metaSuiteUrl, "_blank");
        }
      } else {
        alert(`❌ Không gửi được tin nhắn: ${error.message}`);
      }
    } finally {
      if (inboxSendButton) {
        inboxSendButton.disabled = false;
        inboxSendButton.innerText = "GỬI";
      }
    }
  }

  document
    .getElementById("btn-load-inbox-pages")
    ?.addEventListener("click", inboxLoadPages);
  document
    .getElementById("btn-refresh-inbox")
    ?.addEventListener("click", () => inboxRefresh(true));
  document
    .getElementById("btn-send-inbox-reply")
    ?.addEventListener("click", inboxSendReply);
  document
    .getElementById("btn-ai-inbox-reply")
    ?.addEventListener("click", async () => {
      const conv = inboxGetSelectedConversation();
      if (!conv) return alert("Vui lòng chọn 1 hội thoại.");
      await inboxAutoReplyConversation(conv);
    });
  document
    .getElementById("inbox-page-search")
    ?.addEventListener("input", inboxRenderPageList);

  // Thêm Page thủ công bằng ID
  async function inboxAddPageManual() {
    const pageIdInput = document.getElementById("inbox-add-page-id");
    const pageNameInput = document.getElementById("inbox-add-page-name");
    const pageId = pageIdInput?.value.trim();
    if (!pageId) {
      alert("⚠️ Vui lòng nhập ID Page!");
      return;
    }
    // Kiểm tra đã tồn tại chưa
    const exists = inboxState.pages.find(
      (p) => String(p.id) === String(pageId),
    );
    if (exists) {
      alert("⚠️ Page này đã có trong danh sách!");
      return;
    }
    const pageName = pageNameInput?.value.trim() || `Page ${pageId}`;
    const newPage = {
      id: String(pageId),
      name: pageName,
      accessToken: "",
      picture: "",
    };
    inboxState.pages.push(newPage);
    // Cập nhật cache
    await inboxStorageSet("inboxCachedPages", inboxState.pages);
    await inboxStorageSet("inboxCachedPagesAt", Date.now());
    inboxRenderPageList();
    try {
      inboxMarketingRenderPageFilter();
    } catch (err) {}
    pageIdInput.value = "";
    pageNameInput.value = "";
    if (inboxStatus) {
      inboxStatus.innerText = `✅ Đã thêm "${pageName}" · ${inboxState.pages.length} Page · đã chọn ${inboxState.selectedPageIds.size}`;
    }
  }

  document
    .getElementById("btn-add-page-manual")
    ?.addEventListener("click", inboxAddPageManual);

  document
    .getElementById("inbox-global-reply-style")
    ?.addEventListener("input", (e) => {
      inboxState.globalReplyStyle = e.target.value;
      clearTimeout(inboxState._globalReplyStyleTimer);
      inboxState._globalReplyStyleTimer = setTimeout(async () => {
        await inboxStorageSet(
          "inboxGlobalReplyStyle",
          inboxState.globalReplyStyle,
        );
      }, 800);
    });
  document
    .getElementById("inbox-conversation-search")
    ?.addEventListener("input", inboxRenderConversationList);
  document
    .getElementById("inbox-folder-filter")
    ?.addEventListener("change", (event) => {
      inboxState.folder = event.target.value;
      inboxSyncBackgroundConfig();
      inboxRefresh(true);
    });
  document
    .getElementById("inbox-tag-filter")
    ?.addEventListener("change", (event) => {
      inboxState.tagFilter = event.target.value;
      inboxRenderConversationList();
    });

  // ====== Tag hội thoại ======
  function inboxStorageGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage?.local?.get([key], (data) =>
          resolve(data ? data[key] : undefined),
        );
      } catch (e) {
        resolve(undefined);
      }
    });
  }
  async function inboxPersistTags() {
    await new Promise((resolve) => {
      chrome.storage?.local?.set(
        { inboxConversationTags: inboxState.conversationTags },
        () => resolve(),
      );
    });
  }
  async function inboxLoadTags() {
    const stored = await inboxStorageGet("inboxConversationTags");
    if (stored && typeof stored === "object") {
      inboxState.conversationTags = stored;
    }
  }

  async function inboxAddTagToSelected(tag) {
    const conv = inboxGetSelectedConversation();
    if (!conv) {
      alert("Vui lòng chọn 1 hội thoại trước khi gắn tag.");
      return;
    }
    if (!tag) return;
    const list = inboxState.conversationTags[conv.id] || [];
    if (list.includes(tag)) return; // đã có rồi
    list.push(tag);
    inboxState.conversationTags[conv.id] = list;
    await inboxPersistTags();
    inboxRenderConversationList();
    inboxRenderChat(conv);
    inboxRefreshTagFilterOptions();
  }
  async function inboxClearTagsOfSelected() {
    const conv = inboxGetSelectedConversation();
    if (!conv) {
      alert("Vui lòng chọn 1 hội thoại trước.");
      return;
    }
    delete inboxState.conversationTags[conv.id];
    await inboxPersistTags();
    inboxRenderConversationList();
    inboxRenderChat(conv);
    inboxRefreshTagFilterOptions();
  }
  async function inboxRemoveTagFromConversation(convId, tag) {
    const list = inboxState.conversationTags[convId] || [];
    const next = list.filter((t) => t !== tag);
    if (next.length === 0) delete inboxState.conversationTags[convId];
    else inboxState.conversationTags[convId] = next;
    await inboxPersistTags();
    inboxRenderConversationList();
    const sel = inboxGetSelectedConversation();
    if (sel && String(sel.id) === String(convId)) inboxRenderChat(sel);
    inboxRefreshTagFilterOptions();
  }

  function inboxGetSelectedConversation() {
    const id = inboxState.selectedConversationId;
    if (!id) return null;
    return (
      inboxState.conversations.find((c) => String(c.id) === String(id)) || null
    );
  }

  function inboxRefreshTagFilterOptions() {
    const sel = document.getElementById("inbox-tag-filter");
    if (!sel) return;
    const current = sel.value;
    // Lấy tất cả tag đang dùng
    const used = new Set();
    Object.values(inboxState.conversationTags).forEach((arr) => {
      (arr || []).forEach((t) => used.add(t));
    });
    sel.innerHTML =
      '<option value="">— Tất cả tag —</option>' +
      '<option value="__none__">⚪ Chưa gắn tag</option>' +
      INBOX_TAG_LIST.filter((t) => used.has(t))
        .map(
          (t) =>
            `<option value="${inboxEscape(t)}">🏷️ ${inboxEscape(t)}</option>`,
        )
        .join("") +
      [...used]
        .filter((t) => !INBOX_TAG_LIST.includes(t))
        .map(
          (t) =>
            `<option value="${inboxEscape(t)}">🏷️ ${inboxEscape(t)} (tùy chỉnh)</option>`,
        )
        .join("");
    if (current && [...sel.options].some((o) => o.value === current)) {
      sel.value = current;
    }
    // Highlight các chip đã chọn
    document.querySelectorAll(".inbox-tag-chip").forEach((btn) => {
      const tag = btn.getAttribute("data-tag");
      const conv = inboxGetSelectedConversation();
      const tags = conv ? inboxState.conversationTags[conv.id] || [] : [];
      if (tag === "__clear__") {
        btn.style.opacity = tags.length ? "1" : "0.4";
      } else {
        btn.style.opacity = tags.includes(tag) ? "1" : "0.55";
      }
    });
  }

  // Bind chip click
  document.querySelectorAll(".inbox-tag-chip").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tag = btn.getAttribute("data-tag");
      if (tag === "__clear__") return inboxClearTagsOfSelected();
      await inboxAddTagToSelected(tag);
    });
  });
  // Bind click trên conversation item (event delegation)
  document
    .getElementById("inbox-conversation-list")
    ?.addEventListener("click", async (ev) => {
      // 1. Nút "📣 Gửi tiếp thị lại"
      const mktBtn = ev.target.closest("[data-marketing-btn]");
      if (mktBtn) {
        ev.stopPropagation();
        ev.preventDefault();
        const convId = mktBtn.getAttribute("data-marketing-btn");
        const conv = inboxState.conversations.find(
          (c) => String(c.id) === String(convId),
        );
        if (conv) {
          const origText = mktBtn.innerText;
          mktBtn.disabled = true;
          mktBtn.innerText = "⏳...";
          try {
            await inboxSendMarketingForConversation(conv, false);
          } finally {
            mktBtn.disabled = false;
            mktBtn.innerText = origText;
          }
        }
        return;
      }

      // 2. Nút xoá tag
      const removeTag = ev.target.closest("[data-remove-tag]");
      if (removeTag) {
        ev.stopPropagation();
        ev.preventDefault();
        const tag = removeTag.getAttribute("data-remove-tag");
        const item = removeTag.closest(".conversation-item");
        if (!item) return;
        const idx = Number(item.getAttribute("data-conversation-index"));
        const conv = inboxState.visibleConversations[idx];
        if (!conv) return;
        await inboxRemoveTagFromConversation(conv.id, tag);
        return;
      }

      // 3. Chọn cuộc hội thoại
      const item = ev.target.closest(".conversation-item");
      if (!item) return;
      const idx = Number(item.getAttribute("data-conversation-index"));
      const conv = inboxState.visibleConversations[idx];
      if (!conv) return;
      inboxSelectConversation(conv);
    });

  // Bind remove trên chip trong header chat (event delegation)
  document
    .getElementById("inbox-chat-header")
    ?.addEventListener("click", async (ev) => {
      const rm = ev.target.closest("[data-conv-tag-remove]");
      if (!rm) return;
      ev.stopPropagation();
      const tag = rm.getAttribute("data-conv-tag-remove");
      const conv = inboxGetSelectedConversation();
      if (!conv) return;
      await inboxRemoveTagFromConversation(conv.id, tag);
    });

  // Refresh chip highlight khi chọn hội thoại khác
  document
    .getElementById("inbox-conversation-list")
    ?.addEventListener(
      "click",
      () => setTimeout(inboxRefreshTagFilterOptions, 50),
      true,
    );

  // Load tag đã lưu khi mở
  inboxLoadTags().then(() => {
    setTimeout(() => {
      inboxRefreshTagFilterOptions();
      inboxRenderConversationList();
    }, 300);
  });

  // ============================================================
  // 📣 Tiếp thị lại (Re-marketing) — cấu hình + auto + manual
  // ============================================================
  const INBOX_MARKETING_DEFAULTS = {
    vi: [
      "Chào anh/chị, shop có chương trình ưu đãi mới dành cho bạn...",
      "Sản phẩm bạn quan tâm đang giảm giá 20% hôm nay thôi ạ!",
      "Cảm ơn anh/chị đã quan tâm, shop gửi bạn mã giảm giá FREESHIP nhé!",
      "Bạn còn cần tư vấn thêm về sản phẩm không ạ?",
      "Shop vừa về hàng mới, bạn xem qua nhé!",
      "Đơn hàng của bạn đang được chuẩn bị, shop báo lịch giao ạ!",
      "Bạn đã xem qua bộ sưu tập mới của shop chưa ạ?",
      "Cảm ơn bạn đã theo dõi shop, có gì cứ hỏi shop tư vấn nha!",
      "Shop đang có combo quà tặng kèm, bạn tham khảo nhé!",
      "Bạn ơi, bạn còn cần hỗ trợ gì thêm không ạ?",
    ],
    ja: [
      "こんにちは！本日限定の特別割引クーポンをお届けいたします。",
      "気になっていた商品は本日20%OFFとなっております！ぜひご覧ください。",
      "お問い合わせいただきありがとうございます。送料無料クーポンをプレゼントいたします！",
      "商品についてご不明な点やお困りごとはございませんか？いつでもお気軽にご相談ください。",
      "新商品が入荷いたしました！ぜひチェックしてみてくださいね。",
      "現在、お得なプレゼントキャンペーンを実施中です！",
      "最新コレクションはご覧いただけましたでしょうか？",
      "いつも当店をご利用いただきありがとうございます。何かご質問はございますか？",
      "本日限定のお得なセット商品をご用意しております！",
      "他にお手伝いできることはございますでしょうか？いつでもご連絡をお待ちしております。",
    ],
    en: [
      "Hello! We have a special discount coupon exclusively for you today.",
      "The item you were looking at is 20% OFF today only! Check it out now.",
      "Thank you for reaching out! Here is your FREE SHIPPING coupon code.",
      "Do you have any further questions about our products? We'd love to help!",
      "We just received new arrivals! Take a look at our latest items.",
      "We're currently running a special gift bundle promotion for you!",
      "Have you checked out our latest collection yet?",
      "Thank you for your interest! Feel free to ask if you need any assistance.",
      "Special combo sets are available today with extra gifts!",
      "Is there anything else we can assist you with today?",
    ],
    ko: [
      "안녕하세요! 오늘 고객님만을 위한 특별 할인 쿠폰을 드립니다.",
      "관심을 가지셨던 상품이 오늘 20% 할인 중입니다! 확인해보세요.",
      "문의해 주셔서 감사합니다. 무료 배송 쿠폰을 선물로 드립니다!",
      "상품에 대해 더 궁금하신 점이 있으신가요? 언제든 편하게 문의해 주세요.",
      "신상품이 입고되었습니다! 지금 바로 구경해보세요.",
      "현재 특별 사은품 증정 이벤트를 진행 중입니다!",
      "새로운 컬렉션을 확인해보셨나요?",
      "저희 샵을 찾아주셔서 감사합니다. 도움이 필요하시면 언제든 말씀해주세요.",
      "오늘만 특별한 선물 세트 상품이 준비되어 있습니다!",
      "더 도와드릴 부분이 있으신가요? 언제든 문의해 주세요.",
    ],
    th: [
      "สวัสดีค่ะ! วันนี้ทางร้านมีโค้ดส่วนลดพิเศษสุดคุ้มมอบให้คุณนะคะ",
      "สินค้าที่คุณสนใจ วันนี้ลดราคาพิเศษ 20% วันนี้วันเดียวเท่านั้นค่ะ!",
      "ขอบคุณที่ให้ความสนใจนะคะ ทางร้านมอบคูปองจัดส่งฟรีให้คุณค่ะ!",
      "ต้องการสอบถามข้อมูลสินค้าเพิ่มเติมไหมคะ ยินดีให้คำแนะนำตลอดนะคะ",
      "สินค้าคอลเลกชันใหม่มาถึงแล้วค่ะ ลองเข้ามาเลือกดูได้เลยนะคะ",
      "ตอนนี้มีโปรโมชั่นซื้อคู่สุดคุ้ม พร้อมของแถมพิเศษนะคะ",
      "คุณได้ดูสินค้าใหม่ของทางร้านหรือยังคะ?",
      "ขอบคุณที่ติดตามร้านเรานะคะ มีข้อสงสัยสอบถามแอดมินได้ตลอดเลยค่ะ",
      "วันนี้มีเซ็ตคอมโบสุดพิเศษพร้อมของขวัญนะคะ ลองดูได้เลยค่ะ",
      "มีอะไรให้ทางร้านช่วยเหลือเพิ่มเติมไหมคะ ทักแชทได้ตลอดเลยนะคะ",
    ],
    id: [
      "Halo kak! Hari ini kami ada voucher diskon spesial khusus untuk kakak.",
      "Produk yang kakak minati lagi ada promo diskon 20% khusus hari ini lho!",
      "Terima kasih sudah mampir! Ini kode voucher GRATIS ONGKIR untuk kakak ya.",
      "Ada yang mau ditanyakan lagi tentang produknya kak? Kami siap bantu!",
      "Produk baru kami sudah ready stock nih kak, yuk dicek sekarang!",
      "Saat ini sedang ada promo paket hemat plus gratis hadiah spesial lho!",
      "Sudah lihat koleksi terbaru kami belum kak?",
      "Terima kasih sudah mengikuti toko kami, kalau butuh info jangan ragu chat ya kak!",
      "Hari ini ada paket bundle hemat spesial untuk kakak!",
      "Ada yang bisa kami bantu lagi kak? Silakan chat kami kapan saja ya!",
    ],
    ms: [
      "Salam sejahtera! Hari ini kami ada baucar diskaun istimewa khas untuk anda.",
      "Produk yang anda minati kini ada promosi diskaun 20% hari ini sahaja!",
      "Terima kasih kerana berminat! Ini kod baucar PENGHANTARAN PERCUMA untuk anda.",
      "Ada sebarang pertanyaan lanjut mengenai produk? Kami sedia membantu anda!",
      "Stok produk baharu kami sudah sampai! Jom tengok pilihan terkini.",
      "Sekarang kami ada promosi kombo istimewa berserta hadiah percuma!",
      "Sudahkah anda melihat koleksi terkini daripada kedai kami?",
      "Terima kasih kerana menyokong kami. Hubungi kami bila-bila masa jika perlukan bantuan!",
      "Hari ini ada set kombo eksklusif dengan hadiah tambahan untuk anda!",
      "Ada apa-apa lagi yang boleh kami bantu anda hari ini?",
    ],
  };

  const INBOX_MARKETING_DEFAULT = INBOX_MARKETING_DEFAULTS.vi;

  function inboxGetLanguageFlag(lang) {
    switch (lang) {
      case "th":
        return "🇹🇭";
      case "id":
        return "🇮🇩";
      case "ms":
        return "🇲🇾";
      case "ja":
        return "🇯🇵";
      case "ko":
        return "🇰🇷";
      case "en":
        return "🇺🇸";
      case "vi":
      default:
        return "🇻🇳";
    }
  }

  // State
  inboxState.marketing = {
    enabled: false,
    currentLang: "vi", // "vi" | "ja" | "en" | "ko" | "th" | "id" | "ms"
    messagesByLang: {
      vi: [...INBOX_MARKETING_DEFAULTS.vi],
      ja: [...INBOX_MARKETING_DEFAULTS.ja],
      en: [...INBOX_MARKETING_DEFAULTS.en],
      ko: [...INBOX_MARKETING_DEFAULTS.ko],
      th: [...INBOX_MARKETING_DEFAULTS.th],
      id: [...INBOX_MARKETING_DEFAULTS.id],
      ms: [...INBOX_MARKETING_DEFAULTS.ms],
    },
    messages: [...INBOX_MARKETING_DEFAULTS.vi], // tương thích ngược
    sentLog: {}, // { convId: { lastSentAt, usedIndexes: [] } }
    totalSentCount: 0,
    intervalMs: 2 * 60 * 60 * 1000, // 2 tiếng
  };

  // Helper kiểm tra tag ngôn ngữ (không coi tag ngôn ngữ là tag dừng tiếp thị)
  function inboxIsLanguageTag(tag) {
    if (!tag || typeof tag !== "string") return false;
    const lower = tag.toLowerCase();
    return (
      lower.includes("tiếng nhật") ||
      lower.includes("tiếng hàn") ||
      lower.includes("tiếng việt") ||
      lower.includes("tiếng anh") ||
      lower.includes("tiếng thái") ||
      lower.includes("tiếng indonesia") ||
      lower.includes("tiếng malaysia") ||
      lower.includes("japan") ||
      lower.includes("korea") ||
      lower.includes("thai") ||
      lower.includes("indo") ||
      lower.includes("malay")
    );
  }

  function inboxGetNonLanguageTags(convId) {
    const tags = inboxState.conversationTags[convId] || [];
    return tags.filter((t) => !inboxIsLanguageTag(t));
  }

  function inboxGetMarketingLanguageForConv(conv) {
    if (!conv) return "vi";
    const tags = inboxState.conversationTags[conv.id] || [];
    if (
      tags.some(
        (t) =>
          t.includes("Thái") || t.toLowerCase().includes("thai") || t === "th",
      )
    )
      return "th";
    if (
      tags.some(
        (t) =>
          t.includes("Indonesia") ||
          t.toLowerCase().includes("indo") ||
          t === "id",
      )
    )
      return "id";
    if (
      tags.some(
        (t) =>
          t.includes("Malaysia") ||
          t.toLowerCase().includes("malay") ||
          t === "ms",
      )
    )
      return "ms";
    if (
      tags.some(
        (t) =>
          t.includes("Nhật") || t.toLowerCase().includes("japan") || t === "ja",
      )
    )
      return "ja";
    if (
      tags.some(
        (t) =>
          t.includes("Hàn") || t.toLowerCase().includes("korea") || t === "ko",
      )
    )
      return "ko";
    if (
      tags.some(
        (t) =>
          t.includes("Anh") ||
          t.toLowerCase().includes("english") ||
          t === "en",
      )
    )
      return "en";
    if (
      tags.some(
        (t) =>
          t.includes("Việt") ||
          t.toLowerCase().includes("vietnam") ||
          t === "vi",
      )
    )
      return "vi";

    // Nếu chưa có tag, thử nhận diện từ tin nhắn
    const msgs = conv.messages?.data || [];
    const custMsg = msgs.find((m) => inboxIsCustomerMessage(m, conv));
    const text = custMsg?.message || conv.snippet || "";
    const detected = inboxDetectLanguage(text);
    if (detected?.includes("Thái")) return "th";
    if (detected?.includes("Indonesia")) return "id";
    if (detected?.includes("Malaysia")) return "ms";
    if (detected?.includes("Nhật")) return "ja";
    if (detected?.includes("Hàn")) return "ko";
    if (detected?.includes("Anh")) return "en";
    if (detected?.includes("Việt")) return "vi";

    return "vi";
  }

  function inboxNormalizeMarketingItem(item) {
    if (!item) return { text: "", images: [], image: "" };
    if (typeof item === "string") return { text: item, images: [], image: "" };
    let imgs = [];
    if (Array.isArray(item.images)) {
      imgs = item.images.filter((img) => typeof img === "string" && img.trim());
    } else if (typeof item.image === "string" && item.image.trim()) {
      imgs = [item.image];
    }
    return {
      text: typeof item.text === "string" ? item.text : "",
      images: imgs,
      image: imgs[0] || "",
    };
  }

  function inboxBase64ToBlob(dataUrl) {
    try {
      const parts = dataUrl.split(",");
      const mime = parts[0].match(/:(.*?);/)?.[1] || "image/jpeg";
      const bstr = atob(parts[1]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
      return new Blob([u8arr], { type: mime });
    } catch (e) {
      console.error("Lỗi chuyển base64 sang Blob:", e);
      return new Blob([], { type: "image/jpeg" });
    }
  }

  function inboxMarketingRenderRows() {
    const wrap = document.getElementById("inbox-marketing-rows");
    if (!wrap) return;
    const curLang = inboxState.marketing.currentLang || "vi";
    const rawList =
      inboxState.marketing.messagesByLang?.[curLang] &&
      inboxState.marketing.messagesByLang[curLang].length > 0
        ? inboxState.marketing.messagesByLang[curLang]
        : INBOX_MARKETING_DEFAULTS[curLang] || INBOX_MARKETING_DEFAULTS.vi;

    const list = rawList.map(inboxNormalizeMarketingItem);

    wrap.innerHTML = "";
    list.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "inbox-marketing-row";
      const imgsCount = item.images.length;
      const thumbsHtml = item.images
        .map(
          (imgSrc, imgIdx) => `
            <div class="mkt-img-preview-box" data-mkt-row="${i}" data-img-idx="${imgIdx}">
              <img src="${imgSrc}" class="mkt-img-preview-thumb" data-img-src="${imgSrc}" title="Bấm để xem ảnh #${imgIdx + 1}" />
              <button type="button" class="mkt-img-remove-btn" data-mkt-remove-img="${i}" data-mkt-img-idx="${imgIdx}" title="Xoá ảnh này">✕</button>
            </div>
          `,
        )
        .join("");

      row.innerHTML = `
        <div class="inbox-marketing-row-header">
          <span class="row-num">#${i + 1} (${curLang.toUpperCase()})</span>
          <button type="button" class="row-del" data-mkt-del="${i}" title="Xoá câu này">✕ Xoá</button>
        </div>
        <textarea data-mkt-idx="${i}" placeholder="Nhập câu tiếp thị #${i + 1} (Hỗ trợ nhiều dòng, Enter xuống dòng)...">${inboxEscape(item.text || "")}</textarea>
        <div class="inbox-marketing-row-footer">
          <div class="inbox-marketing-img-zone" data-mkt-img-zone="${i}">
            <input type="file" accept="image/*" multiple class="mkt-file-input" data-mkt-file-idx="${i}" style="display:none;" />
            <button type="button" class="btn-mkt-img-upload" data-mkt-upload-btn="${i}">📷 ${imgsCount > 0 ? `Thêm ảnh (${imgsCount})` : "Tải ảnh"}</button>
            <div class="mkt-img-list" style="display:flex;flex-wrap:wrap;gap:5px;align-items:center;">
              ${thumbsHtml}
            </div>
          </div>
          <span style="font-size:10px; color:#64748b;">${imgsCount > 0 ? `🖼 ${imgsCount} ảnh` : "Chỉ gửi chữ"}</span>
        </div>
      `;
      wrap.appendChild(row);
    });

    // Cập nhật bộ đếm
    const tot = document.getElementById("inbox-marketing-total-count");
    if (tot)
      tot.textContent = list.filter(
        (t) => (t.text && t.text.trim()) || t.images.length > 0,
      ).length;
    const sent = document.getElementById("inbox-marketing-sent-count");
    if (sent) sent.textContent = String(inboxState.marketing.totalSentCount);
  }

  async function inboxMarketingLoad() {
    const data = await new Promise((resolve) =>
      chrome.storage?.local?.get(
        [
          "inboxMarketingEnabled",
          "inboxMarketingMessages",
          "inboxMarketingMessagesByLang",
          "inboxMarketingSentLog",
          "inboxMarketingTotalSent",
        ],
        (d) => resolve(d || {}),
      ),
    );
    inboxState.marketing.enabled = !!data.inboxMarketingEnabled;
    inboxState.marketing.sentLog = data.inboxMarketingSentLog || {};
    inboxState.marketing.totalSentCount = data.inboxMarketingTotalSent || 0;
    inboxState.marketing.currentLang = "vi";

    const storedByLang = data.inboxMarketingMessagesByLang;
    inboxState.marketing.messagesByLang = {
      vi: Array.isArray(storedByLang?.vi)
        ? storedByLang.vi.map(inboxNormalizeMarketingItem)
        : Array.isArray(data.inboxMarketingMessages) &&
            data.inboxMarketingMessages.length > 0
          ? data.inboxMarketingMessages.map(inboxNormalizeMarketingItem)
          : INBOX_MARKETING_DEFAULTS.vi.map(inboxNormalizeMarketingItem),
      ja: Array.isArray(storedByLang?.ja)
        ? storedByLang.ja.map(inboxNormalizeMarketingItem)
        : INBOX_MARKETING_DEFAULTS.ja.map(inboxNormalizeMarketingItem),
      en: Array.isArray(storedByLang?.en)
        ? storedByLang.en.map(inboxNormalizeMarketingItem)
        : INBOX_MARKETING_DEFAULTS.en.map(inboxNormalizeMarketingItem),
      ko: Array.isArray(storedByLang?.ko)
        ? storedByLang.ko.map(inboxNormalizeMarketingItem)
        : INBOX_MARKETING_DEFAULTS.ko.map(inboxNormalizeMarketingItem),
      th: Array.isArray(storedByLang?.th)
        ? storedByLang.th.map(inboxNormalizeMarketingItem)
        : INBOX_MARKETING_DEFAULTS.th.map(inboxNormalizeMarketingItem),
      id: Array.isArray(storedByLang?.id)
        ? storedByLang.id.map(inboxNormalizeMarketingItem)
        : INBOX_MARKETING_DEFAULTS.id.map(inboxNormalizeMarketingItem),
      ms: Array.isArray(storedByLang?.ms)
        ? storedByLang.ms.map(inboxNormalizeMarketingItem)
        : INBOX_MARKETING_DEFAULTS.ms.map(inboxNormalizeMarketingItem),
    };
    inboxState.marketing.messages = inboxState.marketing.messagesByLang.vi;

    const chk = document.getElementById("inboxMarketingChk");
    if (chk) chk.checked = inboxState.marketing.enabled;
    inboxMarketingRenderRows();
  }

  function inboxMarketingCollectCurrentRows(lang) {
    const curLang = lang || inboxState.marketing.currentLang || "vi";
    const rows = document.querySelectorAll(
      "#inbox-marketing-rows .inbox-marketing-row",
    );
    const currentItems = (
      inboxState.marketing.messagesByLang?.[curLang] || []
    ).map(inboxNormalizeMarketingItem);

    const list = [];
    rows.forEach((row, i) => {
      const textarea = row.querySelector("textarea[data-mkt-idx]");
      const text = textarea ? textarea.value : "";
      const thumbEls = row.querySelectorAll(".mkt-img-preview-thumb");
      let images = [];
      if (thumbEls && thumbEls.length > 0) {
        thumbEls.forEach((thumb) => {
          const src = thumb.getAttribute("data-img-src");
          if (src) images.push(src);
        });
      } else if (currentItems[i]?.images?.length > 0) {
        images = [...currentItems[i].images];
      }
      list.push({ text, images, image: images[0] || "" });
    });
    return list;
  }

  async function inboxMarketingSave() {
    const curLang = inboxState.marketing.currentLang || "vi";
    const list = inboxMarketingCollectCurrentRows(curLang);

    if (!inboxState.marketing.messagesByLang) {
      inboxState.marketing.messagesByLang = {};
    }
    inboxState.marketing.messagesByLang[curLang] = list;
    if (curLang === "vi") {
      inboxState.marketing.messages = list;
    }

    await new Promise((resolve) =>
      chrome.storage?.local?.set(
        {
          inboxMarketingEnabled: inboxState.marketing.enabled,
          inboxMarketingMessagesByLang: inboxState.marketing.messagesByLang,
          inboxMarketingMessages: inboxState.marketing.messagesByLang.vi,
        },
        () => resolve(),
      ),
    );
    inboxMarketingRenderRows();
    if (typeof inboxMarketingRefreshBulkDropdown === "function") {
      inboxMarketingRefreshBulkDropdown();
    }
    const btn = document.getElementById("btn-save-marketing");
    if (btn) {
      const old = btn.innerText;
      btn.innerText = `✅ Đã lưu (${curLang.toUpperCase()})`;
      setTimeout(() => (btn.innerText = old), 1500);
    }
  }

  function inboxMarketingAddRow() {
    const wrap = document.getElementById("inbox-marketing-rows");
    if (!wrap) return;
    if (wrap.children.length >= 20) {
      alert("Tối đa 20 câu.");
      return;
    }
    const curLang = inboxState.marketing.currentLang || "vi";
    const currentList = inboxMarketingCollectCurrentRows(curLang);
    currentList.push({ text: "", images: [], image: "" });
    inboxState.marketing.messagesByLang[curLang] = currentList;
    inboxMarketingRenderRows();
  }

  async function inboxMarketingClearAll() {
    const curLang = inboxState.marketing.currentLang || "vi";
    if (
      !confirm(
        `Xoá hết các câu tiếp thị (${curLang.toUpperCase()}) và lịch sử gửi?`,
      )
    )
      return;
    inboxState.marketing.messagesByLang[curLang] = [];
    if (curLang === "vi") inboxState.marketing.messages = [];
    inboxState.marketing.sentLog = {};
    inboxState.marketing.totalSentCount = 0;
    await new Promise((resolve) =>
      chrome.storage?.local?.set(
        {
          inboxMarketingMessagesByLang: inboxState.marketing.messagesByLang,
          inboxMarketingMessages: inboxState.marketing.messagesByLang.vi,
          inboxMarketingSentLog: {},
          inboxMarketingTotalSent: 0,
        },
        () => resolve(),
      ),
    );
    inboxMarketingRenderRows();
  }

  function inboxMarketingDeleteRow(idx) {
    const curLang = inboxState.marketing.currentLang || "vi";
    const list = inboxMarketingCollectCurrentRows(curLang);
    list.splice(idx, 1);
    inboxState.marketing.messagesByLang[curLang] = list;
    inboxMarketingRenderRows();
  }

  // Bind UI
  document.querySelectorAll(".btn-mkt-lang").forEach((btn) => {
    btn.addEventListener("click", () => {
      // 1. Lưu nội dung của ngôn ngữ hiện tại trước khi chuyển
      const curLang = inboxState.marketing.currentLang || "vi";
      const currentList = inboxMarketingCollectCurrentRows(curLang);
      if (!inboxState.marketing.messagesByLang) {
        inboxState.marketing.messagesByLang = {};
      }
      inboxState.marketing.messagesByLang[curLang] = currentList;

      // 2. Chuyển sang tab mới
      const newLang = btn.getAttribute("data-lang") || "vi";
      inboxState.marketing.currentLang = newLang;

      // 3. Update styles cho tab
      document.querySelectorAll(".btn-mkt-lang").forEach((b) => {
        const isActive = b.getAttribute("data-lang") === newLang;
        b.style.background = isActive ? "#0284c7" : "#fff";
        b.style.borderColor = isActive ? "#0284c7" : "#cbd5e1";
        b.style.color = isActive ? "#fff" : "#334155";
      });

      // 4. Render lại rows
      inboxMarketingRenderRows();
      inboxMarketingRefreshBulkDropdown();
    });
  });

  document
    .getElementById("inboxMarketingChk")
    ?.addEventListener("change", async (e) => {
      inboxState.marketing.enabled = e.target.checked;
      await new Promise((resolve) =>
        chrome.storage?.local?.set(
          { inboxMarketingEnabled: inboxState.marketing.enabled },
          () => resolve(),
        ),
      );
    });

  // 🔁 Thu gọn / Mở rộng bảng TIẾP THỊ LẠI
  const toggleMktBody = document.getElementById("btn-toggle-inbox-marketing");
  const mktBody = document.getElementById("inbox-marketing-body");
  if (toggleMktBody && mktBody) {
    // Khôi phục trạng thái đã lưu
    try {
      const saved = await new Promise((resolve) =>
        chrome.storage?.local?.get({ inboxMarketingCollapsed: false }, (r) =>
          resolve(r?.inboxMarketingCollapsed),
        ),
      );
      mktBody.style.display = saved ? "none" : "flex";
      toggleMktBody.textContent = saved ? "▶" : "▼";
      toggleMktBody.title = saved ? "Mở rộng" : "Thu gọn";
    } catch (_) {}

    toggleMktBody.addEventListener("click", async () => {
      const isHidden = mktBody.style.display === "none";
      mktBody.style.display = isHidden ? "flex" : "none";
      toggleMktBody.textContent = isHidden ? "▼" : "▶";
      toggleMktBody.title = isHidden ? "Thu gọn" : "Mở rộng";
      try {
        await new Promise((resolve) =>
          chrome.storage?.local?.set(
            { inboxMarketingCollapsed: !isHidden },
            () => resolve(),
          ),
        );
      } catch (_) {}
    });
  }
  document
    .getElementById("btn-save-marketing")
    ?.addEventListener("click", inboxMarketingSave);
  document
    .getElementById("btn-add-marketing-row")
    ?.addEventListener("click", inboxMarketingAddRow);
  document
    .getElementById("btn-clear-marketing")
    ?.addEventListener("click", inboxMarketingClearAll);
  document
    .getElementById("inbox-marketing-rows")
    ?.addEventListener("click", (e) => {
      // 1. Xoá row
      const del = e.target.closest("[data-mkt-del]");
      if (del) {
        const idx = Number(del.getAttribute("data-mkt-del"));
        inboxMarketingDeleteRow(idx);
        return;
      }

      // 2. Bấm chọn ảnh upload (hỗ trợ nhiều ảnh)
      const upBtn = e.target.closest("[data-mkt-upload-btn]");
      if (upBtn) {
        const idx = upBtn.getAttribute("data-mkt-upload-btn");
        const fileInput = document.querySelector(
          `.mkt-file-input[data-mkt-file-idx="${idx}"]`,
        );
        if (fileInput) {
          fileInput.value = "";
          fileInput.click();
        }
        return;
      }

      // 3. Xoá ảnh cụ thể trong danh sách
      const rmImg = e.target.closest("[data-mkt-remove-img]");
      if (rmImg) {
        const rowIdx = Number(rmImg.getAttribute("data-mkt-remove-img"));
        const imgIdx = Number(rmImg.getAttribute("data-mkt-img-idx"));
        const curLang = inboxState.marketing.currentLang || "vi";
        const currentList = inboxMarketingCollectCurrentRows(curLang);
        if (currentList[rowIdx] && Array.isArray(currentList[rowIdx].images)) {
          currentList[rowIdx].images.splice(imgIdx, 1);
          currentList[rowIdx].image = currentList[rowIdx].images[0] || "";
          inboxState.marketing.messagesByLang[curLang] = currentList;
          inboxMarketingRenderRows();
        }
        return;
      }

      // 4. Click thumbnail xem ảnh lớn
      const thumb = e.target.closest(".mkt-img-preview-thumb");
      if (thumb) {
        const src = thumb.getAttribute("data-img-src");
        if (src) {
          const win = window.open();
          win?.document?.write(
            `<img src="${src}" style="max-width:100%;height:auto;display:block;margin:auto;" />`,
          );
        }
      }
    });

  // Lắng nghe chọn file ảnh (chọn 1 hoặc nhiều ảnh)
  document
    .getElementById("inbox-marketing-rows")
    ?.addEventListener("change", async (e) => {
      const fileInput = e.target.closest(".mkt-file-input");
      if (!fileInput) return;
      const idx = Number(fileInput.getAttribute("data-mkt-file-idx"));
      const files = Array.from(fileInput.files || []);
      if (files.length === 0) return;

      const curLang = inboxState.marketing.currentLang || "vi";
      const currentList = inboxMarketingCollectCurrentRows(curLang);
      if (!currentList[idx]) return;
      currentList[idx].images = currentList[idx].images || [];

      for (const file of files) {
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (rev) => resolve(rev.target?.result || null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(file);
        });
        if (dataUrl) {
          currentList[idx].images.push(dataUrl);
        }
      }
      currentList[idx].image = currentList[idx].images[0] || "";
      inboxState.marketing.messagesByLang[curLang] = currentList;
      inboxMarketingRenderRows();
    });

  // ===== Gửi marketing (hỗ trợ văn bản nhiều dòng và NHIỀU hình ảnh) =====
  async function inboxSendMarketingMessage(conv, msgObj) {
    const text = typeof msgObj === "string" ? msgObj : msgObj?.text || "";
    let images = [];
    if (typeof msgObj === "object") {
      if (Array.isArray(msgObj.images))
        images = msgObj.images.filter((x) => x && x.trim());
      else if (msgObj.image) images = [msgObj.image];
    }
    if (!conv || (!text && images.length === 0)) {
      return {
        ok: false,
        error: "Thiếu thông tin hội thoại hoặc nội dung tin nhắn.",
      };
    }
    // 🔑 ƯU TIÊN: Page Access Token dán tay → token của Page → token conversation
    const pageToken =
      inboxGetManualPageToken(conv.__pageId) ||
      inboxState.pages.find((p) => String(p.id) === String(conv.__pageId))
        ?.accessToken ||
      conv.__pageToken;
    if (!pageToken) {
      return { ok: false, error: "Không tìm thấy Page Token của Page này." };
    }
    const recipientId = inboxGetRecipientId(conv);
    if (!recipientId) {
      return {
        ok: false,
        error: "Chưa xác định được người nhận (PSID) của cuộc trò chuyện này.",
      };
    }
    const pageId = conv.__pageId || "me";

    try {
      let lastMsgId = null;

      // 1. Gửi gom tất cả các ảnh cùng 1 lúc (Parallel Send)
      if (images.length > 0) {
        const uploadPromises = images.map(async (image, i) => {
          if (!image) return null;
          if (image.startsWith("data:image/")) {
            // Gửi dạng binary FormData
            const blob = inboxBase64ToBlob(image);
            const fd = new FormData();
            fd.append("recipient", JSON.stringify({ id: recipientId }));
            fd.append("messaging_type", "RESPONSE");
            fd.append(
              "message",
              JSON.stringify({
                attachment: {
                  type: "image",
                  payload: { is_reusable: true },
                },
              }),
            );
            fd.append("filedata", blob, `marketing_image_${i + 1}.jpg`);
            fd.append("access_token", pageToken);

            const resImg = await fetch(
              `https://graph.facebook.com/${INBOX_GRAPH_VERSION}/${pageId}/messages`,
              {
                method: "POST",
                body: fd,
              },
            );
            const dataImg = await resImg.json().catch(() => ({}));
            if (!resImg.ok || dataImg.error) {
              console.warn(
                `⚠️ Gửi ảnh #${i + 1} thất bại:`,
                dataImg.error?.message,
              );
              return null;
            }
            return dataImg.message_id || null;
          } else if (
            image.startsWith("http://") ||
            image.startsWith("https://")
          ) {
            // Gửi dạng URL
            const bodyImg = new URLSearchParams({
              recipient: JSON.stringify({ id: recipientId }),
              messaging_type: "RESPONSE",
              message: JSON.stringify({
                attachment: {
                  type: "image",
                  payload: { url: image, is_reusable: true },
                },
              }),
              access_token: pageToken,
            });
            const resImg = await fetch(
              `https://graph.facebook.com/${INBOX_GRAPH_VERSION}/${pageId}/messages`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: bodyImg.toString(),
              },
            );
            const dataImg = await resImg.json().catch(() => ({}));
            return dataImg.message_id || null;
          }
          return null;
        });

        const imageResults = await Promise.all(uploadPromises);
        const validIds = imageResults.filter(Boolean);
        if (validIds.length > 0) {
          lastMsgId = validIds[validIds.length - 1];
        }
      }

      // 2. Gửi text (nếu có)
      if (text) {
        const bodyText = new URLSearchParams({
          recipient: JSON.stringify({ id: recipientId }),
          messaging_type: "RESPONSE",
          message: JSON.stringify({ text }),
          access_token: pageToken,
        });
        const resText = await fetch(
          `https://graph.facebook.com/${INBOX_GRAPH_VERSION}/${pageId}/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: bodyText.toString(),
          },
        );
        const dataText = await resText.json().catch(() => ({}));
        if (!resText.ok || dataText.error) {
          if (!lastMsgId) {
            return {
              ok: false,
              error: dataText.error?.message || `HTTP ${resText.status}`,
            };
          }
        } else {
          lastMsgId = dataText.message_id || lastMsgId;
        }
      }

      return { ok: true, data: { message_id: lastMsgId } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Chọn 1 câu marketing "no-repeat" theo đúng ngôn ngữ của khách
  function inboxMarketingPickMessage(conv, specificIdx = null) {
    if (!conv) return null;
    const convId = conv.id;
    const lang = inboxGetMarketingLanguageForConv(conv);
    const msgsByLang =
      inboxState.marketing.messagesByLang || INBOX_MARKETING_DEFAULTS;
    const rawList =
      msgsByLang[lang] && msgsByLang[lang].length > 0
        ? msgsByLang[lang]
        : INBOX_MARKETING_DEFAULTS[lang] || INBOX_MARKETING_DEFAULTS.vi;

    const list = rawList.map(inboxNormalizeMarketingItem);
    const validMsgs = list.filter(
      (t) => (t.text && t.text.trim()) || t.images.length > 0,
    );
    if (validMsgs.length === 0) return null;

    if (
      specificIdx !== null &&
      specificIdx !== "" &&
      specificIdx !== undefined &&
      typeof Number(specificIdx) === "number" &&
      list[Number(specificIdx)]
    ) {
      const pick = list[Number(specificIdx)];
      return {
        text: pick.text,
        images: pick.images || (pick.image ? [pick.image] : []),
        image: pick.image || pick.images?.[0] || "",
        index: Number(specificIdx),
        lang,
      };
    }

    const log = inboxState.marketing.sentLog[convId] || {
      usedIndexes: [],
    };
    const used = new Set(log.usedIndexes || []);
    const available = validMsgs
      .map((m, i) => ({ m, i }))
      .filter((x) => !used.has(x.i));

    const pool =
      available.length > 0 ? available : validMsgs.map((m, i) => ({ m, i }));
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return {
      text: pick.m.text,
      images: pick.m.images || (pick.m.image ? [pick.m.image] : []),
      image: pick.m.image || pick.m.images?.[0] || "",
      index: pick.i,
      lang,
    };
  }

  function inboxMarketingRecordSent(convId, msgIndex) {
    const log = inboxState.marketing.sentLog[convId] || {
      usedIndexes: [],
      lastSentAt: 0,
    };
    log.lastSentAt = Date.now();
    log.usedIndexes = Array.from(
      new Set([...(log.usedIndexes || []), msgIndex]),
    );
    inboxState.marketing.sentLog[convId] = log;
    inboxState.marketing.totalSentCount =
      (inboxState.marketing.totalSentCount || 0) + 1;
    chrome.storage?.local?.set({
      inboxMarketingSentLog: inboxState.marketing.sentLog,
      inboxMarketingTotalSent: inboxState.marketing.totalSentCount,
    });
    const sent = document.getElementById("inbox-marketing-sent-count");
    if (sent) sent.textContent = String(inboxState.marketing.totalSentCount);
  }

  // Gửi marketing cho 1 cuộc hội thoại (manual = true ghi nhận, false = auto)
  async function inboxSendMarketingForConversation(conv, isAuto) {
    if (!conv) return;

    if (!inboxState.marketingSending) {
      inboxState.marketingSending = new Set();
    }
    if (inboxState.marketingSending.has(conv.id)) return;
    inboxState.marketingSending.add(conv.id);

    try {
      const nonLangTags = inboxGetNonLanguageTags(conv.id);
      if (nonLangTags.length > 0) {
        // Đã có tag hành động (đã mua hàng, đã gửi hàng...) → không gửi
        if (!isAuto)
          alert(
            `Cuộc hội thoại này đã có tag (${nonLangTags.join(", ")}). Không gửi tiếp thị.`,
          );
        return;
      }
      const pick = inboxMarketingPickMessage(conv);
      if (!pick) {
        if (!isAuto) alert("Bạn chưa lưu câu tiếp thị nào cho ngôn ngữ này.");
        return;
      }
      // PHÒNG THỦ: check cửa sổ 24h
      const lastTime =
        inboxGetLastCustomerMessageTime(conv) || conv.updated_time;
      if (lastTime) {
        const lastTs = new Date(lastTime).getTime();
        const ageHours = (Date.now() - lastTs) / (60 * 60 * 1000);
        if (ageHours >= 24) {
          if (!isAuto) {
            alert(
              `Không thể gửi: tin nhắn gần nhất cách đây ${ageHours.toFixed(1)} giờ (quá cửa sổ 24h của Facebook).`,
            );
          } else {
            inboxMarketingBulkLog(
              `⏰ ${inboxGetContact(conv)}: quá 24h, bỏ qua (${ageHours.toFixed(1)}h)`,
              "skip",
            );
          }
          return;
        }
      }
      // Nếu auto và đã gửi trong 2 tiếng → skip
      if (isAuto) {
        const log = inboxState.marketing.sentLog[conv.id] || {};
        if (
          log.lastSentAt &&
          Date.now() - log.lastSentAt < inboxState.marketing.intervalMs
        ) {
          return;
        }
      }
      const result = await inboxSendMarketingMessage(conv, pick);
      if (result.ok) {
        inboxMarketingRecordSent(conv.id, pick.index);
        // Đẩy tin nhắn vừa gửi vào list để UI thấy ngay
        const now = Date.now();
        conv.messages = conv.messages || { data: [] };
        conv.messages.data = conv.messages.data || [];
        const imgsList =
          Array.isArray(pick.images) && pick.images.length > 0
            ? pick.images
            : pick.image
              ? [pick.image]
              : [];

        const attachments =
          imgsList.length > 0
            ? {
                data: imgsList.map((img) => ({
                  image_data: {
                    url: img,
                    preview_url: img,
                  },
                })),
              }
            : undefined;
        conv.messages.data.unshift({
          id: String(result.data?.message_id || `local_${now}`),
          created_time: new Date(now).toISOString(),
          from: { id: conv.__pageId, name: conv.__pageName },
          message: pick.text,
          attachments,
          __localSent: true,
        });
        conv.updated_time = new Date(now).toISOString();
        if (isAuto && conv.unread_count) conv.unread_count = 0;
        inboxRenderConversationList();
        if (
          inboxState.selectedConversationId &&
          String(inboxState.selectedConversationId) === String(conv.id)
        ) {
          inboxRenderChat(conv);
        }
        if (!isAuto) {
          const flag = inboxGetLanguageFlag(pick.lang);
          const imgNotice =
            imgsList.length > 0 ? ` (kèm 🖼 ${imgsList.length} ảnh)` : "";
          alert(
            `✅ Đã gửi tiếp thị lại (${flag} ${pick.lang.toUpperCase()}${imgNotice}) thành công cho ${inboxGetContact(conv)}!`,
          );
        }
      } else {
        if (!isAuto) alert("Gửi thất bại: " + result.error);
      }
    } finally {
      inboxState.marketingSending.delete(conv.id);
    }
  }

  // ===== Auto loop: mỗi 2 tiếng quét các cuộc chưa có tag hành động, gửi 1 câu theo đúng ngôn ngữ =====
  let _marketingAutoRunning = false;
  async function inboxMarketingAutoTick() {
    if (_marketingAutoRunning) return;
    _marketingAutoRunning = true;
    try {
      if (!inboxState.marketing.enabled) return;
      if (inboxState.conversations.length === 0) return;
      const pageFilter = inboxState.marketingBulkPageFilter;
      const candidates = inboxState.conversations.filter((conv) => {
        if (pageFilter && !pageFilter.has(String(conv.__pageId || "")))
          return false;
        const nonLangTags = inboxGetNonLanguageTags(conv.id);
        if (nonLangTags.length > 0) return false;
        const pageToken =
          inboxGetManualPageToken(conv.__pageId) ||
          inboxState.pages.find((p) => String(p.id) === String(conv.__pageId))
            ?.accessToken ||
          conv.__pageToken;
        if (!pageToken) return false;
        const recipientId = inboxGetRecipientId(conv);
        if (!recipientId) return false;
        const lastTime =
          inboxGetLastCustomerMessageTime(conv) || conv.updated_time;
        const lastTs = lastTime ? new Date(lastTime).getTime() : 0;
        const ageHours = lastTs
          ? (Date.now() - lastTs) / (60 * 60 * 1000)
          : Infinity;
        if (ageHours >= 24) return false;
        return true;
      });
      for (const conv of candidates) {
        const log = inboxState.marketing.sentLog[conv.id] || {};
        if (
          log.lastSentAt &&
          Date.now() - log.lastSentAt < inboxState.marketing.intervalMs
        )
          continue;
        await inboxSendMarketingForConversation(conv, true);
        await new Promise((r) => setTimeout(r, 2000));
      }
    } finally {
      _marketingAutoRunning = false;
    }
  }
  setInterval(inboxMarketingAutoTick, 5 * 60 * 1000);
  setTimeout(inboxMarketingAutoTick, 30 * 1000);

  // Load state khi mở
  inboxMarketingLoad();
  inboxMarketingRefreshBulkDropdown();

  inboxState.marketingBulk = {
    running: false,
    stop: false,
    timer: null,
  };

  function inboxMarketingRefreshBulkDropdown() {
    const sel = document.getElementById("inbox-marketing-bulk-msg");
    if (!sel) return;
    const curLang = inboxState.marketing.currentLang || "vi";
    const rawList =
      inboxState.marketing.messagesByLang?.[curLang] &&
      inboxState.marketing.messagesByLang[curLang].length > 0
        ? inboxState.marketing.messagesByLang[curLang]
        : INBOX_MARKETING_DEFAULTS[curLang] || INBOX_MARKETING_DEFAULTS.vi;

    const list = rawList.map(inboxNormalizeMarketingItem);
    const valid = list.filter(
      (t) => (t.text && t.text.trim()) || t.images.length > 0,
    );

    sel.innerHTML =
      '<option value="">🎲 Tự động theo ngôn ngữ khách (no-repeat)</option>' +
      valid
        .map((item, i) => {
          const previewText = item.text
            ? item.text.replace(/\n+/g, " ")
            : "[Hình ảnh]";
          const display =
            previewText.length > 40
              ? previewText.slice(0, 38) + "..."
              : previewText;
          const imgBadge =
            item.images.length > 0 ? ` 🖼x${item.images.length}` : "";
          return `<option value="${i}">#${i + 1} (${curLang.toUpperCase()}): ${inboxEscape(display)}${imgBadge}</option>`;
        })
        .join("");
  }

  function inboxMarketingBulkLog(line, kind) {
    const log = document.getElementById("inbox-marketing-bulk-log");
    if (!log) return;
    const colors = {
      ok: "#15803d",
      err: "#b91c1c",
      skip: "#64748b",
      info: "#0369a1",
    };
    const color = colors[kind] || "#334155";
    const time = new Date().toLocaleTimeString();
    const div = document.createElement("div");
    div.style.color = color;
    div.style.padding = "2px 0";
    div.style.borderBottom = "1px solid #f1f5f9";
    div.textContent = `[${time}] ${line}`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function inboxMarketingBulkUpdateStatus(text) {
    const el = document.getElementById("inbox-marketing-bulk-status");
    if (el) el.textContent = text;
  }

  function inboxMarketingBulkUpdateBar(percent) {
    const bar = document.getElementById("inbox-marketing-bulk-bar");
    if (bar) bar.style.width = `${percent}%`;
  }

  async function inboxMarketingBulkStart() {
    if (inboxState.marketingBulk.running) {
      alert("Đang chạy. Bấm Dừng nếu muốn huỷ.");
      return;
    }
    if (inboxState.conversations.length === 0) {
      alert('Chưa có danh sách hội thoại. Bấm "Làm mới hộp thư" trước.');
      return;
    }
    const candidates = inboxState.conversations.filter((conv) => {
      const pageFilter = inboxState.marketingBulkPageFilter;
      if (pageFilter && !pageFilter.has(String(conv.__pageId || "")))
        return false;
      const nonLangTags = inboxGetNonLanguageTags(conv.id);
      if (nonLangTags.length > 0) return false;
      const pageToken =
        conv.__pageToken ||
        inboxState.pages.find((p) => String(p.id) === String(conv.__pageId))
          ?.accessToken;
      if (!pageToken) return false;
      const recipientId = inboxGetRecipientId(conv);
      if (!recipientId) return false;
      const lastTime =
        inboxGetLastCustomerMessageTime(conv) || conv.updated_time;
      const lastTs = lastTime ? new Date(lastTime).getTime() : 0;
      const ageHours = lastTs
        ? (Date.now() - lastTs) / (60 * 60 * 1000)
        : Infinity;
      if (ageHours >= 24) return false;
      return true;
    });
    if (candidates.length === 0) {
      alert("Không có khách nào (chưa có tag xử lý) trong cửa sổ 24h để gửi.");
      return;
    }
    const sel = document.getElementById("inbox-marketing-bulk-msg");
    const fixedIdx = sel?.value || "";

    const fixLabel =
      fixedIdx !== ""
        ? `câu #${Number(fixedIdx) + 1}`
        : "tự động theo ngôn ngữ từng khách (no-repeat)";
    if (
      !confirm(
        `Gửi "${fixLabel}" cho ${candidates.length} khách?\nMỗi 2 giây 1 người.\nTổng ~${candidates.length * 2}s.`,
      )
    )
      return;

    inboxState.marketingBulk.running = true;
    inboxState.marketingBulk.stop = false;
    const panel = document.getElementById("inbox-marketing-bulk-progress");
    const logEl = document.getElementById("inbox-marketing-bulk-log");
    if (panel) panel.style.display = "block";
    if (logEl) logEl.innerHTML = "";
    inboxMarketingBulkUpdateBar(0);

    let successCount = 0;
    let failCount = 0;
    let skipCount = 0;
    const total = candidates.length;

    for (let i = 0; i < candidates.length; i++) {
      if (inboxState.marketingBulk.stop) {
        inboxMarketingBulkLog("⏹ Đã dừng theo yêu cầu.", "info");
        break;
      }
      const conv = candidates[i];
      const contact = inboxGetContact(conv);
      const pick = inboxMarketingPickMessage(
        conv,
        fixedIdx !== "" ? Number(fixedIdx) : null,
      );
      if (!pick) {
        skipCount++;
        inboxMarketingBulkLog(`⏭ ${contact}: không có câu nào`, "skip");
        inboxMarketingBulkUpdateBar(((i + 1) / total) * 100);
        continue;
      }
      const langFlag = inboxGetLanguageFlag(pick.lang);
      const previewText = pick.text
        ? pick.text.slice(0, 40) + (pick.text.length > 40 ? "..." : "")
        : "[Kèm ảnh]";
      const imgsCount = Array.isArray(pick.images)
        ? pick.images.length
        : pick.image
          ? 1
          : 0;
      inboxMarketingBulkUpdateStatus(
        `Đang gửi ${i + 1}/${total}: ${contact} (${langFlag})...`,
      );
      inboxMarketingBulkLog(
        `➡ [${langFlag} ${pick.lang.toUpperCase()}] ${contact}: "${previewText}"${imgsCount > 0 ? ` (🖼x${imgsCount})` : ""}`,
        "info",
      );
      const result = await inboxSendMarketingMessage(conv, pick);
      if (result.ok) {
        inboxMarketingRecordSent(conv.id, pick.index);
        const now = Date.now();
        conv.messages = conv.messages || { data: [] };
        conv.messages.data = conv.messages.data || [];
        const imgsList =
          Array.isArray(pick.images) && pick.images.length > 0
            ? pick.images
            : pick.image
              ? [pick.image]
              : [];

        const attachments =
          imgsList.length > 0
            ? {
                data: imgsList.map((img) => ({
                  image_data: {
                    url: img,
                    preview_url: img,
                  },
                })),
              }
            : undefined;
        conv.messages.data.unshift({
          id: String(result.data?.message_id || `local_${now}`),
          created_time: new Date(now).toISOString(),
          from: { id: conv.__pageId, name: conv.__pageName },
          message: pick.text,
          attachments,
          __localSent: true,
        });
        conv.updated_time = new Date(now).toISOString();
        if (conv.unread_count) conv.unread_count = 0;
        successCount++;
        inboxMarketingBulkLog(`✅ ${contact}: OK`, "ok");
      } else {
        failCount++;
        inboxMarketingBulkLog(`❌ ${contact}: ${result.error}`, "err");
      }
      inboxMarketingBulkUpdateBar(((i + 1) / total) * 100);
      inboxRenderConversationList();
      if (
        inboxState.selectedConversationId &&
        String(inboxState.selectedConversationId) === String(conv.id)
      ) {
        inboxRenderChat(conv);
      }
      if (i < candidates.length - 1 && !inboxState.marketingBulk.stop) {
        await new Promise((resolve) => {
          inboxState.marketingBulk.timer = setTimeout(resolve, 2000);
        });
      }
    }

    inboxMarketingBulkUpdateStatus(
      `Xong. ✅ ${successCount} thành công, ❌ ${failCount} lỗi, ⏭ ${skipCount} bỏ qua.`,
    );
    inboxMarketingBulkLog(
      `🎉 Hoàn thành gửi tiếp thị lại! Thành công: ${successCount}/${total}`,
      "ok",
    );
    inboxState.marketingBulk.running = false;
  }

  function inboxMarketingBulkStop() {
    if (!inboxState.marketingBulk.running) return;
    inboxState.marketingBulk.stop = true;
    if (inboxState.marketingBulk.timer) {
      clearTimeout(inboxState.marketingBulk.timer);
      inboxState.marketingBulk.timer = null;
    }
    inboxMarketingBulkUpdateStatus("Đang dừng...");
  }

  document
    .getElementById("btn-marketing-bulk-send")
    ?.addEventListener("click", inboxMarketingBulkStart);
  document
    .getElementById("btn-marketing-bulk-stop")
    ?.addEventListener("click", inboxMarketingBulkStop);
  document
    .getElementById("btn-select-all-pages")
    ?.addEventListener("click", async () => {
      inboxState.selectedPageIds = new Set(
        inboxState.pages
          .filter(
            (page) => page.accessToken || inboxGetManualPageToken(page.id),
          )
          .map((page) => page.id),
      );
      await inboxStorageSet("inboxSelectedPageIds", [
        ...inboxState.selectedPageIds,
      ]);
      inboxRenderPageList();
      inboxUpdateLiveStatus();
      inboxSyncBackgroundConfig();
      if (inboxStatus)
        inboxStatus.innerText = `${inboxState.pages.length} Page · đã chọn ${inboxState.selectedPageIds.size}`;
    });
  document
    .getElementById("btn-clear-pages")
    ?.addEventListener("click", async () => {
      inboxState.selectedPageIds.clear();
      await inboxStorageSet("inboxSelectedPageIds", []);
      inboxRenderPageList();
      inboxState.conversations = [];
      inboxRenderConversationList();
      inboxUpdateLiveStatus();
      inboxSyncBackgroundConfig();
      if (inboxStatus)
        inboxStatus.innerText = `${inboxState.pages.length} Page · đã chọn 0`;
    });
  // 🔑 Ghi khi user ĐANG GÕ token → dùng ngay, không cần bấm Lưu
  inboxPageList?.addEventListener("input", (event) => {
    const target = event.target;
    if (!target.classList?.contains("ai-page-token")) return;
    const pageId = target.getAttribute("data-page-id");
    const value = target.value || "";
    inboxState._pendingPageTokens[String(pageId)] = value;
    clearTimeout(inboxState._pageTokenSaveTimer);
    inboxState._pageTokenSaveTimer = setTimeout(async () => {
      await inboxApplyManualPageToken(pageId, value);
    }, 700);
  });

  inboxPageList?.addEventListener("change", async (event) => {
    const target = event.target;
    if (target.classList.contains("inbox-page-checkbox")) {
      const pageId = target.getAttribute("data-page-id");
      if (target.checked) {
        inboxState.selectedPageIds.add(pageId);
        // LAZY: chỉ trao đổi Page Token khi user tích chọn page
        // 🔑 Nếu Page đã có token DÁN TAY → khỏi cần trao đổi
        const page = inboxState.pages.find(
          (p) => String(p.id) === String(pageId),
        );
        if (page && !page.accessToken && !inboxGetManualPageToken(pageId)) {
          const userToken =
            document.getElementById("tokenInput")?.value.trim() || "";
          if (userToken) {
            if (inboxStatus)
              inboxStatus.innerText = `🔐 Đang lấy Page Token cho ${page.name || pageId}...`;
            try {
              const pageToken = await inboxExchangePageToken(pageId, userToken);
              if (pageToken) {
                page.accessToken = pageToken;
                // Cập nhật lại cache để lần sau không phải trao đổi lại
                await inboxStorageSet("inboxCachedPages", inboxState.pages);
                if (inboxStatus)
                  inboxStatus.innerText = `✅ Đã có Page Token cho ${page.name || pageId}`;
              } else {
                if (inboxStatus)
                  inboxStatus.innerText = `⚠️ Không lấy được Page Token cho ${page.name || pageId} (User Token thiếu quyền)`;
              }
            } catch (e) {
              if (inboxStatus)
                inboxStatus.innerText = `❌ Lỗi trao đổi Page Token: ${e.message}`;
            }
          }
        }
      } else {
        inboxState.selectedPageIds.delete(pageId);
      }
      await inboxStorageSet("inboxSelectedPageIds", [
        ...inboxState.selectedPageIds,
      ]);
      inboxRenderPageList();
      inboxUpdateLiveStatus();
      inboxSyncBackgroundConfig();
      if (
        inboxStatus &&
        !inboxStatus.innerText.startsWith("🔐") &&
        !inboxStatus.innerText.startsWith("✅") &&
        !inboxStatus.innerText.startsWith("❌")
      )
        inboxStatus.innerText = `${inboxState.pages.length} Page · đã chọn ${inboxState.selectedPageIds.size}`;
      return;
    }
    if (target.classList.contains("ai-enabled")) {
      const pageId = target.getAttribute("data-page-id");
      const patch = { enabled: target.checked };
      await inboxSaveAiConfig(pageId, patch);
      inboxRenderPageList();
      return;
    }
    if (target.classList.contains("ai-page-token")) {
      const pageId = target.getAttribute("data-page-id");
      const value = target.value || "";
      // 🔑 Cập nhật ngay vào map pending để mọi lệnh gọi API dùng token này
      //    ngay cả khi user chưa bấm Lưu / chưa đợi debounce.
      inboxState._pendingPageTokens[String(pageId)] = value;
      clearTimeout(inboxState._pageTokenSaveTimer);
      inboxState._pageTokenSaveTimer = setTimeout(async () => {
        await inboxApplyManualPageToken(pageId, value);
      }, 700);
      return;
    }
    const priceFileInput = target.closest(".ai-price-file-input");
    if (priceFileInput) {
      const pageId = priceFileInput.getAttribute("data-page-id");
      const files = Array.from(priceFileInput.files || []);
      if (files.length === 0) return;

      const cfg = inboxGetAiConfig(pageId);
      const currentImgs = Array.isArray(cfg.priceImages)
        ? [...cfg.priceImages]
        : [];

      for (const file of files) {
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (rev) => resolve(rev.target?.result || null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(file);
        });
        if (dataUrl) currentImgs.push(dataUrl);
      }

      await inboxSaveAiConfig(pageId, { priceImages: currentImgs });
      inboxRenderPageList();
      const panel = inboxPageList.querySelector(
        `.ai-config-panel[data-panel="${pageId}"]`,
      );
      if (panel) panel.hidden = false;
      const toggleBtn = inboxPageList.querySelector(
        `.ai-config-toggle[data-page-id="${pageId}"]`,
      );
      if (toggleBtn) toggleBtn.classList.add("open");
      return;
    }
  });

  inboxPageList?.addEventListener("click", async (event) => {
    // 🔑 Nút Ẩn/Hiện Page Access Token
    const eyeBtn = event.target.closest(".ai-page-token-eye");
    if (eyeBtn) {
      const pageId = eyeBtn.getAttribute("data-page-id");
      const input = inboxPageList.querySelector(
        `.ai-page-token[data-page-id="${pageId}"]`,
      );
      if (input) {
        const isHidden = input.type === "password";
        input.type = isHidden ? "text" : "password";
        eyeBtn.textContent = isHidden ? "🙈" : "👁️";
        eyeBtn.title = isHidden ? "Ẩn token" : "Hiện token";
      }
      return;
    }

    // 🧪 Nút kiểm tra Page Access Token
    const testTokenBtn = event.target.closest(".ai-page-token-test");
    if (testTokenBtn) {
      const pageId = testTokenBtn.getAttribute("data-page-id");
      const input = inboxPageList.querySelector(
        `.ai-page-token[data-page-id="${pageId}"]`,
      );
      const statusEl = inboxPageList.querySelector(
        `.ai-page-token-status[data-page-id="${pageId}"]`,
      );
      const token = (input?.value || "").trim();
      if (!token) {
        if (statusEl)
          statusEl.innerHTML =
            '<span style="color:#d97706">⚠️ Chưa nhập token — hãy dán Page Access Token vào ô trên</span>';
        return;
      }
      if (statusEl) statusEl.innerHTML = "⏳ Đang kiểm tra...";
      testTokenBtn.disabled = true;
      const result = await inboxTestManualPageToken(pageId, token);
      testTokenBtn.disabled = false;
      if (statusEl) {
        statusEl.innerHTML = result.ok
          ? `<span style="color:#16a34a">${result.message}</span>`
          : `<span style="color:#dc2626">${result.message}</span>`;
      }
      // Nếu token hợp lệ → lưu & áp dụng ngay
      if (result.ok) {
        await inboxApplyManualPageToken(pageId, token);
      }
      return;
    }

    const toggleBtn = event.target.closest(".ai-config-toggle");
    if (toggleBtn) {
      const pageId = toggleBtn.getAttribute("data-page-id");
      const panel = inboxPageList.querySelector(
        `.ai-config-panel[data-panel="${pageId}"]`,
      );
      if (panel) {
        panel.hidden = !panel.hidden;
        toggleBtn.classList.toggle("open", !panel.hidden);
      }
      return;
    }
    const upPriceBtn = event.target.closest(".btn-ai-price-img-upload");
    if (upPriceBtn) {
      const pageId = upPriceBtn.getAttribute("data-page-id");
      const fileInput = inboxPageList.querySelector(
        `.ai-price-file-input[data-page-id="${pageId}"]`,
      );
      if (fileInput) {
        fileInput.value = "";
        fileInput.click();
      }
      return;
    }
    const rmPriceBtn = event.target.closest(".ai-price-img-remove");
    if (rmPriceBtn) {
      const pageId = rmPriceBtn.getAttribute("data-page-id");
      const imgIdx = Number(rmPriceBtn.getAttribute("data-img-idx"));
      const cfg = inboxGetAiConfig(pageId);
      if (
        Array.isArray(cfg.priceImages) &&
        cfg.priceImages[imgIdx] !== undefined
      ) {
        cfg.priceImages.splice(imgIdx, 1);
        await inboxSaveAiConfig(pageId, { priceImages: cfg.priceImages });
        inboxRenderPageList();
        const panel = inboxPageList.querySelector(
          `.ai-config-panel[data-panel="${pageId}"]`,
        );
        if (panel) panel.hidden = false;
        const toggle = inboxPageList.querySelector(
          `.ai-config-toggle[data-page-id="${pageId}"]`,
        );
        if (toggle) toggle.classList.add("open");
      }
      return;
    }
    const priceThumb = event.target.closest(".ai-price-img-thumb");
    if (priceThumb) {
      const src = priceThumb.getAttribute("data-img-src");
      if (src) {
        const win = window.open();
        win?.document?.write(
          `<img src="${src}" style="max-width:100%;height:auto;display:block;margin:auto;" />`,
        );
      }
      return;
    }
    const saveBtn = event.target.closest(".ai-save");
    if (saveBtn) {
      const pageId = saveBtn.getAttribute("data-page-id");
      const panel = inboxPageList.querySelector(
        `.ai-config-panel[data-panel="${pageId}"]`,
      );
      const cfg = inboxGetAiConfig(pageId);
      const patch = {
        enabled: panel.querySelector(".ai-enabled")?.checked || false,
        autoOffOnAddress:
          panel.querySelector(".ai-auto-off-addr")?.checked || false,
        autoOffOnPhone:
          panel.querySelector(".ai-auto-off-phone")?.checked || false,
        system: panel.querySelector(".ai-system")?.value || "",
        replyStyle: panel.querySelector(".ai-reply-style")?.value || "",
        baseUrl:
          panel.querySelector(".ai-base")?.value || INBOX_AI_DEFAULTS.baseUrl,
        model:
          panel.querySelector(".ai-model")?.value || INBOX_AI_DEFAULTS.model,
        apiKey: panel.querySelector(".ai-key")?.value || "",
        priceImages: cfg.priceImages || [],
        // 🔑 Page Access Token dán tay
        pageToken: panel.querySelector(".ai-page-token")?.value?.trim() || "",
      };
      await inboxSaveAiConfig(pageId, patch);
      // 🔑 Lưu Page Access Token dán tay (ưu tiên cao nhất) + áp dụng ngay
      await inboxApplyManualPageToken(pageId, patch.pageToken);
      const status = panel.querySelector(".ai-status");
      if (status) {
        status.textContent = "✅ Đã lưu";
        setTimeout(() => (status.textContent = ""), 2000);
      }
      inboxRenderPageList();
      // ⚡ Xử lý ngay tin nhắn đang chờ sau khi bật AI / thêm API key
      setTimeout(() => {
        inboxMaybeAutoReplyAll().catch((e) =>
          console.error("❌ inboxMaybeAutoReplyAll lỗi:", e),
        );
      }, 500);
      return;
    }
    const testBtn = event.target.closest(".ai-test");
    if (testBtn) {
      const pageId = testBtn.getAttribute("data-page-id");
      const panel = inboxPageList.querySelector(
        `.ai-config-panel[data-panel="${pageId}"]`,
      );
      const status = panel.querySelector(".ai-status");
      status.textContent = "⏳ Đang gọi AI...";
      try {
        const system = panel.querySelector(".ai-system")?.value || "";
        const replyStyle =
          panel.querySelector(".ai-reply-style")?.value ||
          inboxState.globalReplyStyle ||
          "";
        const combinedSystem = [system, replyStyle]
          .filter(Boolean)
          .join("\n\n---\n\n");
        const reply = await inboxCallLlm({
          baseUrl:
            panel.querySelector(".ai-base")?.value || INBOX_AI_DEFAULTS.baseUrl,
          apiKey: panel.querySelector(".ai-key")?.value || "",
          model:
            panel.querySelector(".ai-model")?.value || INBOX_AI_DEFAULTS.model,
          system: combinedSystem || INBOX_AI_DEFAULTS.system,
          messages: [
            { role: "user", content: "Xin chào, cho mình hỏi giá sản phẩm?" },
          ],
        });
        status.textContent = reply
          ? `✅ ${reply.slice(0, 60)}...`
          : "⚠️ Không có phản hồi";
      } catch (error) {
        status.textContent = `❌ ${error.message}`;
      }
      return;
    }
  });
  inboxReplyInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      inboxSendReply();
    }
  });

  document
    .getElementById("btn-ai-inbox-reply")
    ?.addEventListener("click", async () => {
      const btn = document.getElementById("btn-ai-inbox-reply");
      const conversation = inboxState.conversations.find(
        (item) => item.id === inboxState.selectedConversationId,
      );
      if (!conversation) return;
      if (btn) {
        btn.disabled = true;
        btn.innerText = "⏳...";
      }
      try {
        await inboxAutoReplyConversation(conversation);
        // Refresh chat to show new message
        const refreshed = inboxState.conversations.find(
          (item) => item.id === inboxState.selectedConversationId,
        );
        if (refreshed) inboxRenderChat(refreshed);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerText = "🤖 AI";
        }
      }
    });

  // Toggle AI cho từng hội thoại
  document
    .getElementById("inbox-chat-header")
    ?.addEventListener("change", (e) => {
      if (!e.target.matches("#inbox-conv-ai-toggle input")) return;
      const convId = inboxState.selectedConversationId;
      if (!convId) return;
      const toggle = document.getElementById("inbox-conv-ai-toggle");
      if (e.target.checked) {
        inboxState.aiDisabledConvs.delete(convId);
        if (toggle) {
          toggle.querySelector(".ai-switch-text").innerText = "AI đang bật";
        }
      } else {
        inboxState.aiDisabledConvs.add(convId);
        if (toggle) {
          toggle.querySelector(".ai-switch-text").innerText = "AI đang tắt";
        }
      }
    });

  inboxStorageGet("inboxSelectedPageIds").then((savedIds) => {
    if (Array.isArray(savedIds))
      inboxState.selectedPageIds = new Set(savedIds.map(String));
    inboxStorageGet("inboxGlobalApiKey").then((key) => {
      console.log(
        "🔑 Load inboxGlobalApiKey:",
        key ? "(có giá trị)" : "(trống)",
      );
    });
    inboxLoadAiConfigs().finally(() => {
      // 🔑 Load Page Access Token dán tay sau khi load cấu hình AI
      inboxLoadManualPageTokens().finally(() => {
        inboxRenderPageList();
        // Đồng bộ sang background để poll nền cũng dùng token ưu tiên
        inboxSyncBackgroundConfig();
      });
    });
  });

  function inboxSyncBackgroundConfig() {
    const token = document.getElementById("tokenInput")?.value.trim() || "";
    if (!chrome.storage?.local || !token) return;
    // 🔑 ƯU TIÊN token dán tay cho từng Page khi đồng bộ sang background
    const pagesForBg = inboxState.pages.map((p) => ({
      id: p.id,
      name: p.name,
      access_token: inboxGetManualPageToken(p.id) || p.accessToken || "",
      picture: { data: { url: p.picture } },
    }));
    chrome.storage.local.set({
      inboxBgToken: token,
      inboxBgSelectedPageIds: [...inboxState.selectedPageIds],
      inboxBgFolder: inboxState.folder,
      inboxBgPagesCached: pagesForBg,
      inboxBgPagesCachedAt: Date.now(),
      // 🔑 Map token dán tay để background dùng ưu tiên
      inboxManualPageTokens: { ...(inboxState.pageTokens || {}) },
    });
  }

  // 👉 Load / save cấu hình auto-reply + Telegram nền
  function loadInboxBgCfg() {
    chrome.storage.local.get(
      [
        "inboxAutoReplyEnabled",
        "inboxAutoReplyText",
        "inboxTelegramBotToken",
        "inboxTelegramChatIds",
      ],
      (data) => {
        const chk = document.getElementById("inboxAutoReplyChk");
        const txt = document.getElementById("inboxAutoReplyText");
        const bot = document.getElementById("inboxTelegramBot");
        const chs = document.getElementById("inboxTelegramChats");
        if (chk) chk.checked = !!data.inboxAutoReplyEnabled;
        if (txt) txt.value = data.inboxAutoReplyText || "";
        if (bot) bot.value = data.inboxTelegramBotToken || "";
        if (chs) chs.value = (data.inboxTelegramChatIds || []).join(",");
      },
    );
  }
  function saveInboxBgCfg() {
    const chk = document.getElementById("inboxAutoReplyChk")?.checked;
    const txt =
      document.getElementById("inboxAutoReplyText")?.value.trim() || "";
    const bot = document.getElementById("inboxTelegramBot")?.value.trim() || "";
    const chs =
      document
        .getElementById("inboxTelegramChats")
        ?.value.split(",")
        .map((s) => s.trim())
        .filter(Boolean) || [];
    chrome.storage.local.set(
      {
        inboxAutoReplyEnabled: chk,
        inboxAutoReplyText: txt,
        inboxTelegramBotToken: bot,
        inboxTelegramChatIds: chs,
      },
      () => {
        const btn = document.getElementById("btn-save-inbox-bg-cfg");
        if (btn) {
          const old = btn.innerText;
          btn.innerText = "✅ Đã lưu";
          setTimeout(() => (btn.innerText = old), 1500);
        }
      },
    );
  }
  // Bind nút Lưu
  document
    .getElementById("btn-save-inbox-bg-cfg")
    ?.addEventListener("click", saveInboxBgCfg);
  loadInboxBgCfg();

  // 🎯 Nạp trạng thái lỗi token từ storage khi mở dashboard
  //    (để sau khi F5 vẫn thấy cảnh báo token hết hạn)
  chrome.storage?.local?.get?.(
    ["inboxTokenExpired", "inboxTokenErrorMessage", "inboxTokenErrorCode"],
    (st) => {
      if (!st?.inboxTokenExpired) return;
      inboxState.tokenError = {
        message:
          st.inboxTokenErrorMessage || "Token Facebook không còn hiệu lực",
        code: st.inboxTokenErrorCode || "",
        backoffMinutes: 0,
      };
      inboxRenderTokenErrorBanner();
      if (inboxStatus) {
        inboxStatus.innerText = "🔴 Token hết hạn";
        inboxStatus.style.color = "#c92a2a";
      }
    },
  );

  chrome.storage?.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.inboxBgCache && Array.isArray(changes.inboxBgCache.newValue)) {
      inboxMergeConversations(changes.inboxBgCache.newValue);
      inboxState.lastPollAt = changes.inboxBgCacheAt?.newValue || Date.now();
      inboxTickLiveStatus();
    }
    // 🎯 Token hết hạn → hiện cảnh báo
    if (
      changes.inboxTokenExpired &&
      changes.inboxTokenExpired.newValue === true
    ) {
      inboxState.tokenError = {
        message:
          changes.inboxTokenErrorMessage?.newValue ||
          "Token Facebook không còn hiệu lực",
        code: changes.inboxTokenErrorCode?.newValue || "",
        backoffMinutes: 0,
      };
      inboxRenderTokenErrorBanner();
      if (inboxStatus) {
        inboxStatus.innerText = "🔴 Token hết hạn";
        inboxStatus.style.color = "#c92a2a";
      }
    }
    // 🎉 Token hồi sinh → xoá cảnh báo
    if (
      changes.inboxTokenExpired &&
      changes.inboxTokenExpired.newValue === false
    ) {
      inboxState.tokenError = null;
      inboxRenderTokenErrorBanner();
      if (inboxStatus) inboxStatus.style.color = "";
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      // Tab ẩn nhưng vẫn mở → vẫn để dashboard poll + Service Worker chạy
      inboxTickLiveStatus("⏸ Ẩn ");
    } else if (!inboxState.loading) {
      inboxStartLive();
    }
  });

  window.addEventListener("beforeunload", () => {
    inboxStopLive();
    chrome.storage?.local?.set({ inboxBgSelectedPageIds: [] });
  });

  function resetInboxActivity() {
    chrome.storage?.local?.set({ inboxLastActivityTime: Date.now() });
  }
  window.addEventListener("click", resetInboxActivity);
  window.addEventListener("keypress", resetInboxActivity);

  // LẮNG NGHE LỆNH NẠP TIỀN TỪ BOT TELEGRAM QUA STORAGE (Xử lý chạy ngầm ở background.js)
  // =================================================================================
  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName === "local" && changes.prepayData) {
      console.log(
        "💰 prepayData cập nhật từ background:",
        changes.prepayData.newValue,
      );
      // (D) Chỉ render lại bảng từ cache — không quét lại API.
      //     Việc quét là của background (alarm 1 phút), không cần gọi lại ở đây.
      try {
        window.renderScanFromCache?.("ACTIVE");
      } catch (e) {
        /* bỏ qua */
      }
    }
  });

  function autoRefreshToken() {
    const btn = document.getElementById("autoTokenBtn");

    if (btn) {
      console.log("🔄 Đang tự động lấy token...");
      btn.click();
    } else {
      console.log("❌ Không tìm thấy nút autoTokenBtn");
    }
  }

  // ============================================================
  // 🎯 MỤC 4: Đồng bộ fbToken → inboxBgToken ngay khi lấy token mới
  //    Trước đây token mới chỉ nằm trong ô input + storage fbToken,
  //    background vẫn dùng inboxBgToken cũ (đã hết hạn) → poll vô ích.
  // ============================================================
  let _lastSyncedBgToken = "";
  async function inboxSyncTokenToBackground(newToken) {
    const token = String(newToken || "").trim();
    if (!token) return;
    if (token === _lastSyncedBgToken) return;
    _lastSyncedBgToken = token;
    try {
      await chrome.storage.local.set({ inboxBgToken: token });
      // 🎯 Báo background: token đã mới → reset backoff + poll ngay
      chrome.runtime?.sendMessage?.({ type: "inbox-token-refreshed" }, () => {
        void chrome.runtime?.lastError;
      });
      console.log("🔄 Đã đồng bộ token mới sang background");
      // Cập nhật UI nếu đang hiển thị lỗi token
      inboxState.tokenError = null;
      inboxRenderTokenErrorBanner();
    } catch (e) {
      console.warn("⚠️ Không đồng bộ token sang background được:", e.message);
    }
  }

  // Listener: khi fbToken đổi (do nút lấy token tự động hoặc OAuth lưu vào)
  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const changed = changes.fbToken;
    if (!changed) return;
    const newToken = changed.newValue;
    if (!newToken) return;
    // Cập nhật ô input cho khớp
    const ti = document.getElementById("tokenInput");
    if (ti && ti.value !== newToken) ti.value = newToken;
    inboxSyncTokenToBackground(newToken);
  });

  // ============================================================
  // SHARE PAGE - Chia sẻ Page cho nhiều FB cá nhân
  // ============================================================
  (function initSharePage() {
    const SPPanel = document.getElementById("page-share-page");
    if (!SPPanel) return;

    const spListEl = document.getElementById("sharepage-page-list");
    const spSummary = document.getElementById("sharepage-summary");
    const spStatus = document.getElementById("sharepage-status");
    const spLogEl = document.getElementById("sharepage-log");
    const spSearchEl = document.getElementById("sharepage-page-search");

    // State
    let spPages = [];
    let spSelectedIds = new Set();
    let spLogOpen = false;

    function spEscape(text) {
      return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function spAppendLog(kind, msg) {
      if (!spLogEl) return;
      spLogEl.style.display = "block";
      const line = document.createElement("div");
      line.className = `sharepage-log-line ${kind}`;
      const ts = new Date().toLocaleTimeString("vi-VN");
      line.textContent = `[${ts}] ${msg}`;
      spLogEl.appendChild(line);
      spLogEl.scrollTop = spLogEl.scrollHeight;
    }

    function spSetStatus(msg) {
      if (spStatus) spStatus.textContent = msg;
    }

    function spUpdateSummary() {
      if (!spSummary) return;
      const n = spSelectedIds.size;
      spSummary.textContent =
        n === 0
          ? "Chưa chọn Page nào."
          : `Đã chọn ${n} Page: ${[...spSelectedIds]
              .map((id) => {
                const p = spPages.find((x) => x.id === id);
                return p ? p.name : id;
              })
              .join(", ")}`;
    }

    function spRenderList() {
      if (!spListEl) return;
      const query = (spSearchEl?.value || "").trim().toLowerCase();
      const visible = spPages.filter(
        (p) =>
          !query ||
          p.name.toLowerCase().includes(query) ||
          String(p.id).includes(query),
      );
      if (visible.length === 0) {
        spListEl.innerHTML = `<div class="inbox-empty">${
          spPages.length === 0
            ? 'Bấm <b>"🔄 TẢI PAGE"</b> để hiển thị danh sách Page.'
            : "Không tìm thấy Page nào phù hợp."
        }</div>`;
        return;
      }
      spListEl.innerHTML = visible
        .map((p) => {
          const checked = spSelectedIds.has(p.id) ? "checked" : "";
          return `<label class="sharepage-page-item">
            <input type="checkbox" data-page-id="${spEscape(p.id)}" ${checked} />
            <div class="sharepage-page-row-main">
              <span class="sharepage-page-name">${spEscape(p.name)}</span>
              <span class="sharepage-page-id">ID: ${spEscape(p.id)}</span>
            </div>
          </label>`;
        })
        .join("");
      // Bind checkbox change
      spListEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.addEventListener("change", () => {
          const id = cb.getAttribute("data-page-id");
          if (!id) return;
          if (cb.checked) spSelectedIds.add(id);
          else spSelectedIds.delete(id);
          spUpdateSummary();
        });
      });
    }

    // Load pages từ /me/accounts
    async function spLoadPages() {
      const token = document.getElementById("tokenInput")?.value.trim();
      if (!token) {
        spAppendLog(
          "err",
          '⚠️ Chưa có Access Token. Vui lòng bấm "🔑 LẤY TOKEN" trước.',
        );
        return;
      }
      const btn = document.getElementById("btn-load-sharepage-pages");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "⏳ ĐANG TẢI...";
      }
      spSetStatus("Đang tải danh sách Page...");
      try {
        const fields = "id,name,access_token";
        let url = `https://graph.facebook.com/${INBOX_GRAPH_VERSION || "v25.0"}/me/accounts?fields=${encodeURIComponent(fields)}&limit=200&access_token=${encodeURIComponent(token)}`;
        const collected = [];
        while (url && collected.length < 500) {
          const res = await fetch(url);
          const data = await res.json();
          if (data.error) throw new Error(data.error.message || "API lỗi");
          if (Array.isArray(data.data))
            collected.push(...data.data.filter((p) => p.id && p.name));
          url = data.paging?.next || null;
        }
        spPages = collected.map((p) => ({
          id: String(p.id),
          name: p.name,
          accessToken: p.access_token || "",
        }));
        spRenderList();
        spUpdateSummary();
        spSetStatus(`Đã tải ${spPages.length} Page.`);
        spAppendLog("ok", `✅ Tải được ${spPages.length} Page.`);
      } catch (e) {
        spSetStatus("Lỗi tải Page");
        spAppendLog("err", `❌ Lỗi tải Page: ${e.message}`);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "🔄 TẢI PAGE";
        }
      }
    }

    // Lấy ID số từ link/username FB
    function spExtractFbId(input) {
      if (!input) return null;
      const s = String(input).trim();
      if (!s) return null;
      // Lấy từ URL dạng facebook.com/username hoặc profile.php?id=123
      // Trước tiên check nếu đã là số
      if (/^\d{5,}$/.test(s)) return s;
      // Lấy username từ URL
      const m = s.match(/(?:facebook\.com|fb\.com)\/([^/?#&]+)/i);
      if (m && m[1]) {
        // Nếu là id=xxx
        if (/^\d+$/.test(m[1])) return m[1];
        return "@" + m[1]; // username format
      }
      // Nếu chỉ là username đơn thuần
      if (/^@?[A-Za-z0-9._-]+$/.test(s)) {
        return s.startsWith("@") ? s : "@" + s;
      }
      return null;
    }

    async function spShare() {
      // 1. Lấy danh sách FB inputs
      const fbInputs = [
        ...document.querySelectorAll(".sharepage-fb-input"),
      ].map((el) => (el.value || "").trim());
      const fbs = fbInputs.map((v) => spExtractFbId(v)).filter(Boolean);
      const blankCount = fbInputs.filter((v) => !v).length;
      const dupCount = fbs.length - new Set(fbs).size;

      // 2. Lấy danh sách page đã chọn
      const selectedPages = spPages.filter((p) => spSelectedIds.has(p.id));

      // 3. Validate
      if (selectedPages.length === 0) {
        spAppendLog("err", "⚠️ Chưa chọn Page nào để chia sẻ.");
        return alert("⚠️ Bạn chưa chọn Page nào để chia sẻ!");
      }
      if (fbs.length === 0) {
        spAppendLog("err", "⚠️ Chưa nhập FB cá nhân nào.");
        return alert("⚠️ Bạn chưa nhập FB cá nhân nào!");
      }
      if (dupCount > 0) {
        spAppendLog("err", `⚠️ Có ${dupCount} FB bị trùng lặp (đã bỏ qua).`);
      }

      const totalJobs = selectedPages.length * fbs.length;
      if (
        !confirm(
          `Bạn sắp gửi ${totalJobs} lời mời quản lý Page ` +
            `(${selectedPages.length} Page × ${fbs.length} FB).\n\n` +
            `Tiếp tục?`,
        )
      )
        return;

      const btn = document.getElementById("btn-sharepage-share");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "⏳ ĐANG GỬI...";
      }
      spSetStatus(
        `Đang gửi ${totalJobs} lời mời từ ${selectedPages.length} Page...`,
      );
      spAppendLog(
        "info",
        `🚀 Bắt đầu chia sẻ ${selectedPages.length} Page cho ${fbs.length} FB (tổng ${totalJobs} lời mời).`,
      );

      let okCount = 0;
      let errCount = 0;

      for (let pi = 0; pi < selectedPages.length; pi++) {
        const page = selectedPages[pi];
        if (!page.accessToken) {
          spAppendLog(
            "err",
            `⛔ Page "${page.name}" thiếu access_token (do user token chưa đủ quyền). Bỏ qua.`,
          );
          errCount += fbs.length;
          continue;
        }
        for (let fi = 0; fi < fbs.length; fi++) {
          const fb = fbs[fi];
          const url = `https://graph.facebook.com/${INBOX_GRAPH_VERSION || "v25.0"}/${page.id}/roles`;
          try {
            const body = new URLSearchParams();
            body.set("access_token", page.accessToken);
            body.set(
              "user",
              fb.startsWith("@") ? fb.slice(1) : fb, // username hoặc id số
            );
            body.set("role", "MANAGER");
            const res = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body,
            });
            const data = await res.json();
            if (data.error) {
              errCount++;
              const errMsg = data.error.message || "Lỗi không xác định";
              let hint = "";
              if (/privacy|disable|block/i.test(errMsg)) {
                hint =
                  " 💡 FB này đã chặn nhận lời mời quản lý Page (Settings → Privacy → 'Who can add me as an admin on a Page' → đổi về 'Anyone').";
              } else if (/permission|scope|authorize/i.test(errMsg)) {
                hint =
                  " 💡 Token thiếu quyền pages_manage_roles. Hãy thêm scope này khi lấy token.";
              } else if (/not found|does not exist/i.test(errMsg)) {
                hint = " 💡 Username/ID FB không tồn tại. Kiểm tra lại link.";
              }
              spAppendLog(
                "err",
                `❌ Page "${page.name}" → ${fb}: ${errMsg}${hint}`,
              );
            } else {
              okCount++;
              spAppendLog(
                "ok",
                `✅ Page "${page.name}" → ${fb}: đã gửi lời mời MANAGER.`,
              );
            }
          } catch (e) {
            errCount++;
            spAppendLog("err", `❌ Page "${page.name}" → ${fb}: ${e.message}`);
          }
          // Delay nhẹ để tránh rate-limit
          await new Promise((r) => setTimeout(r, 400));
        }
      }

      spAppendLog(
        "info",
        `🏁 Hoàn tất: ${okCount} thành công / ${errCount} lỗi (tổng ${totalJobs}).`,
      );
      spSetStatus(`Xong: ✅${okCount} · ❌${errCount}`);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "📤 Chia sẻ Page";
      }
    }

    function spClear() {
      document.querySelectorAll(".sharepage-fb-input").forEach((el) => {
        el.value = "";
      });
      spAppendLog("info", "🧹 Đã xóa hết các ô nhập FB.");
    }

    function spSelectAll(checked) {
      if (checked) spSelectedIds = new Set(spPages.map((p) => p.id));
      else spSelectedIds.clear();
      spRenderList();
      spUpdateSummary();
    }

    // Bind events
    document
      .getElementById("btn-load-sharepage-pages")
      ?.addEventListener("click", spLoadPages);
    document
      .getElementById("btn-sharepage-share")
      ?.addEventListener("click", spShare);
    document
      .getElementById("btn-sharepage-clear")
      ?.addEventListener("click", spClear);
    document
      .getElementById("btn-sharepage-select-all")
      ?.addEventListener("click", () => spSelectAll(true));
    document
      .getElementById("btn-sharepage-deselect-all")
      ?.addEventListener("click", () => spSelectAll(false));
    spSearchEl?.addEventListener("input", spRenderList);
  })();

  // Chạy ngay khi mở tool
  autoRefreshToken();

  // Lặp lại mỗi 3 tiếng
  setInterval(
    () => {
      autoRefreshToken();
    },
    2 * 60 * 60 * 1000,
  );
});
