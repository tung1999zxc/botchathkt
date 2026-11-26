/* =========================================================================
 * 🔧 CAMP CORE — Lõi dùng chung cho Background (quét) + Dashboard (hiển thị)
 * -------------------------------------------------------------------------
 * MỤC TIÊU (sau khi refactor D + F + G):
 *
 *  (D) QUÉT CHẠY Ở BACKGROUND (chrome.alarms) — không phụ thuộc tab dashboard
 *       mở hay đóng. 1 nguồn quét duy nhất cho toàn hệ thống.
 *
 *  (F) MỘT NGUỒN QUYẾT ĐỊNH TẮT/BẬT DUY NHẤT → background "camp-core".
 *       Cả bảng 📊 Bảng Chỉ Số và bảng ✂️ Tắt Camp Tự Động chỉ ĐỌC kết quả,
 *       không tự gọi API / không tự POST status nữa.
 *
 *  (G) MỘT NGUỒN NÂNG NGƯỠNG DUY NHẤT → hàm raiseThresholdForAdset dùng
 *       chung, nhưng MỐC SO SÁNH (prevHieuQua) nằm trong storage và chỉ
 *       được cập nhật bởi background → không thể bị nâng 2 lần/phút.
 *
 * Module này được nạp bởi:
 *   - background.js  : importScripts("camp_core.js")   → chạy quét thật
 *   - dashboard.html : <script src="camp_core.js">     → đọc cache + cấu hình
 *
 * ⚠️ Bắt buộc nạp camp_core.js TRƯỚC dashboard.js để window.CampCore sẵn sàng.
 * ========================================================================= */
(function (global) {
  "use strict";

  const GRAPH = "https://graph.facebook.com/v20.0";
  const GRAPH_VERSION = "v20.0";

  /* ------------------------------------------------------------------
   * HẰNG SỐ / KEY STORAGE
   * ---------------------------------------------------------------- */
  const KEY_STATE = "camp_core_state"; // kết quả quét + mốc thời gian
  const KEY_PREV = "camp_core_prev"; // mốc đếm KQ (G) — nguồn nâng ngưỡng
  const KEY_CONFIGS = "fb_local_configs"; // ngưỡng từng nhóm (nguồn chuẩn)
  const KEY_CC_STATE = "cc_camp_state"; // state của care_camp.js (monitored/autoPaused)
  const KEY_AUTO_PAUSE = "camp_core_auto_pause"; // Auto-Pause (bảng trong dashboard)
  const KEY_ALARM = "camp-core-scan";

  const SCAN_INTERVAL_MINUTES = 1; // chu kỳ alarm (Chrome tối thiểu 1 phút)
  const SCAN_INTERVAL_MS = 60 * 1000;
  const MAX_ROWS = 2000; // trần số dòng nhóm trong cache
  const MAX_LOGS = 100;
  const MAX_AUTO_PAUSED = 100;
  const SAVE_DEBOUNCE_MS = 3 * 60 * 1000;

  /* ------------------------------------------------------------------
   * TIỆN ÍCH
   * ---------------------------------------------------------------- */
  const num = (v, fb) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fb;
  };

  const money = (n) => Math.round(Number(n || 0)).toLocaleString("vi-VN");

  function esc(s) {
    return String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  /** Khoá ngày theo định dạng YYYY-MM-DD (giờ địa phương) */
  function dayKey(ts = Date.now()) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /**
   * (F) Khoá ngày THỰC TẾ của 1 bản ghi "đã tắt tự động".
   *
   * ⚠️ ƯU TIÊN "pausedAt" (thời điểm nhóm thực sự bị tắt) — luôn đúng.
   *    "dayStamp" chỉ là fallback vì có thể đã đóng băng từ lần ghi đầu
   *    tiên (nếu từng được ghi từ camp_core_state) → dẫn tới việc nhóm
   *    vừa tắt hôm nay bị coi là "của hôm trước" và bị xoá khỏi danh sách.
   */
  function dayKeyOf(p) {
    if (!p) return "";
    if (p.pausedAt) return dayKey(p.pausedAt);
    if (p.dayStamp) return String(p.dayStamp);
    return "";
  }

  /** Bọc chrome.storage.local thành Promise (chạy được cả SW lẫn trang) */
  function storageGet(keys) {
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

  function storageSet(obj) {
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

  /** Chuẩn hoá danh sách ID tài khoản → luôn có tiền tố "act_" */
  function normalizeIds(raw) {
    if (!raw) return [];
    return String(raw)
      .split(/[\s,;]+/)
      .map((s) => s.trim().replace(/^act_/i, ""))
      .filter(Boolean)
      .map((s) => "act_" + s);
  }

  /* ------------------------------------------------------------------
   * (G) NGUỒN NÂNG NGƯỠNG DUY NHẤT
   * ------------------------------------------------------------------
   * localStorage["fb_local_configs"] là nguồn sự thật cho ngưỡng của từng
   * nhóm. Hàm raiseThresholdForAdset ở dashboard.js vẫn là hàm được gọi,
   * NHƯNG mốc so sánh (prev) giờ nằm trong storage "camp_core_prev" do
   * background quản lý → mỗi lần KQ tăng chỉ nâng ngưỡng ĐÚNG 1 LẦN.
   * ---------------------------------------------------------------- */
  function readPrevMap() {
    return {};
  }

  async function getPrevMap() {
    const res = await storageGet([KEY_PREV]);
    return res[KEY_PREV] && typeof res[KEY_PREV] === "object"
      ? res[KEY_PREV]
      : {};
  }

  async function setPrevMap(map) {
    await storageSet({ [KEY_PREV]: map });
  }

  /**
   * Nâng ngưỡng MaxSpend cho 1 nhóm (dùng chung cho background & dashboard).
   *
   * @param {string} adsetId
   * @param {number} effectiveCount  số KQ hiện tại (hội thoại / click / CPR)
   * @param {object} opts { maxSpend, maxPrice, maxCpm, maxCpc }
   * @returns {Promise<{raised:boolean, diff:number, currentMaxSpend:number, newMaxSpend:number}>}
   */
  async function raiseThresholdForAdset(adsetId, effectiveCount, opts = {}) {
    const id = String(adsetId);
    const globalMaxSpend = num(opts.maxSpend, 10000);
    const globalMaxPrice = num(opts.maxPrice, 12000);
    const globalMaxCpm = num(opts.maxCpm, 40000);
    const globalMaxCpc = num(opts.maxCpc, 800);

    const configs = await getConfigs();
    const prevMap = await getPrevMap();
    const cur = num(effectiveCount, 0);

    // (G) Chưa có mốc so sánh → coi mốc cũ = 0.
    //     Nhóm đã có KQ ngay từ lần quét đầu tiên vẫn được nâng ngưỡng
    //     ngay: diff = cur - 0 = cur.
    const hasPrev = prevMap[id] !== undefined;
    const prev = hasPrev ? num(prevMap[id], 0) : 0;

    // KQ không tăng (và đã có mốc) → không nâng
    if (hasPrev && cur <= prev) {
      prevMap[id] = cur;
      await setPrevMap(prevMap);
      return {
        raised: false,
        diff: 0,
        currentMaxSpend: 0,
        newMaxSpend: 0,
        currentMaxPrice: globalMaxPrice,
        currentMaxCpm: globalMaxCpm,
        currentMaxCpc: globalMaxCpc,
      };
    }

    const diff = cur - prev;

    // diff <= 0 → không có gì để nâng (VD nhóm mới, chưa có KQ nào)
    if (diff <= 0) {
      prevMap[id] = cur;
      await setPrevMap(prevMap);
      return {
        raised: false,
        diff: 0,
        currentMaxSpend: 0,
        newMaxSpend: 0,
        currentMaxPrice: globalMaxPrice,
        currentMaxCpm: globalMaxCpm,
        currentMaxCpc: globalMaxCpc,
      };
    }

    const local = configs[id] || {};
    const currentMaxSpend = num(local.maxSpend, globalMaxSpend);
    const currentMaxPrice = num(local.maxPrice ?? local.maxCpr, globalMaxPrice);
    const currentMaxCpm = num(local.maxCpm, globalMaxCpm);
    const currentMaxCpc = num(local.maxCpc, globalMaxCpc);

    // maxSpend mới = ngưỡng cũ + (ngưỡng giá × số KQ tăng thêm)
    const newMaxSpend = currentMaxSpend + currentMaxPrice * diff;

    configs[id] = {
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
    await setConfigs(configs);
    prevMap[id] = cur;
    await setPrevMap(prevMap);

    return {
      raised: true,
      diff,
      currentMaxSpend,
      newMaxSpend,
      currentMaxPrice,
      currentMaxCpm,
      currentMaxCpc,
    };
  }

  /* ------------------------------------------------------------------
   * CẤU HÌNH NGƯỠNG DÙNG CHUNG (localStorage "fb_local_configs")
   * ---------------------------------------------------------------- */
  function hasLocalStorage() {
    try {
      return typeof localStorage !== "undefined";
    } catch (e) {
      return false;
    }
  }

  function readLocalStorageConfigs() {
    if (!hasLocalStorage()) return {};
    try {
      const raw = localStorage.getItem(KEY_CONFIGS);
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === "object" ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function writeLocalStorageConfigs(cfg) {
    if (!hasLocalStorage()) return;
    try {
      localStorage.setItem(KEY_CONFIGS, JSON.stringify(cfg || {}));
    } catch (e) {
      /* bỏ qua */
    }
  }

  /**
   * Đọc cấu hình ngưỡng — NGUỒN CHUẨN cho background.
   *
   * ⚠️ Service worker KHÔNG có localStorage → phải đọc từ
   *    chrome.storage.local["fb_local_configs"].
   *    Nếu chưa có trong storage → fallback đọc localStorage (chạy ở tab).
   */
  async function getConfigs() {
    const res = await storageGet([KEY_CONFIGS]);
    const stored = res[KEY_CONFIGS];
    if (stored && typeof stored === "object" && Object.keys(stored).length) {
      return stored;
    }
    const local = readLocalStorageConfigs();
    if (Object.keys(local).length) {
      // Đồng bộ ngược sang storage để background có
      await storageSet({ [KEY_CONFIGS]: local });
    }
    return local;
  }

  /** Ghi cấu hình ngưỡng — ghi cả storage (chuẩn) và localStorage (mirror UI) */
  async function setConfigs(cfg) {
    const clean = cfg && typeof cfg === "object" ? cfg : {};
    await storageSet({ [KEY_CONFIGS]: clean });
    writeLocalStorageConfigs(clean);
  }

  /** Đọc ngưỡng của 1 nhóm (fallback ngưỡng chung) */
  async function limitsFor(adsetId, globalCfg = {}) {
    const cfg = await getConfigs();
    const local = cfg[String(adsetId)];
    const g = {
      maxSpend: num(globalCfg.maxSpend, 10000),
      maxPrice: num(globalCfg.maxPrice, 12000),
      maxCpm: num(globalCfg.maxCpm, 40000),
      maxCpc: num(globalCfg.maxCpc, 800),
    };
    if (local) {
      return {
        maxSpend: num(local.maxSpend, g.maxSpend),
        maxPrice: num(local.maxPrice ?? local.maxCpr, g.maxPrice),
        maxCpm: num(local.maxCpm, g.maxCpm),
        maxCpc: num(local.maxCpc, g.maxCpc),
      };
    }
    return g;
  }

  /* ------------------------------------------------------------------
   * GỬI TELEGRAM (dùng chung — nguồn cấu hình: telegram_config.js)
   * ---------------------------------------------------------------- */
  async function notifyTelegram(html) {
    try {
      const TG = global.TelegramConfig;
      if (TG && typeof TG.sendMessage === "function") {
        const res = await TG.sendMessage(html);
        // ⚠️ KHÔNG nuốt lỗi — nếu không gửi được thì phải biết ngay
        if (res && res.ok === false) {
          console.error(
            "[CAMP CORE] ❌ Gửi Telegram THẤT BẠI:",
            res.error || "không rõ lý do",
          );
          return false;
        }
        return true;
      }
      console.warn("[CAMP CORE] Chưa có TelegramConfig → bỏ qua gửi tin.");
      return false;
    } catch (e) {
      console.error("[CAMP CORE] Lỗi gửi Telegram:", e?.message || e);
      return false;
    }
  }

  /* ------------------------------------------------------------------
   * GỌI META GRAPH API
   * ---------------------------------------------------------------- */
  async function graphGet(url) {
    const res = await fetch(url);
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      data = {};
    }
    return data;
  }

  async function setAdsetStatus(token, adsetId, status) {
    try {
      const res = await fetch(`${GRAPH}/${adsetId}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `status=${status}&access_token=${encodeURIComponent(token)}`,
      });
      return await res.json();
    } catch (e) {
      return { error: { message: e?.message || String(e) } };
    }
  }

  /* ------------------------------------------------------------------
   * ĐẾM HỘI THOẠI INBOX THEO TAG (đọc cache — KHÔNG gọi API Meta)
   * ---------------------------------------------------------------- */
  async function countInboxConversationsByTag(adsetName) {
    try {
      if (!adsetName || typeof adsetName !== "string") return null;
      const tagMatch = adsetName.match(/\[([A-Za-z0-9_\-]+)\]/i);
      if (!tagMatch) return null;
      const tag = tagMatch[1].trim().toUpperCase();
      const tagBracket = `[${tag}]`;

      const res = await storageGet(["inboxBgCache"]);
      const inboxList = Array.isArray(res.inboxBgCache)
        ? res.inboxBgCache
        : [];
      if (inboxList.length === 0) return null;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const countedConvIds = new Set();
      let count = 0;

      for (const conv of inboxList) {
        if (!conv || !conv.id) continue;
        const convId = String(conv.id);
        let hasTag = false;
        const messages = conv.messages?.data || [];
        for (const msg of messages) {
          const msgText = (msg.message || "").toUpperCase();
          const adTitle = (
            msg.referral?.ads_context_data?.ad_title || ""
          ).toUpperCase();
          if (
            msgText.includes(tagBracket) ||
            adTitle.includes(tagBracket)
          ) {
            const msgTime = msg.created_time
              ? new Date(msg.created_time)
              : null;
            if (msgTime && msgTime >= today) {
              hasTag = true;
              break;
            }
          }
        }
        if (hasTag && !countedConvIds.has(convId)) {
          countedConvIds.add(convId);
          count++;
        }
      }
      return count;
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------------
   * TÍNH CHỈ SỐ KẾT QUẢ (giống hệt logic cũ của 2 bảng)
   * ---------------------------------------------------------------- */
  function pickResult(metrics, useCpl, useCpc, optimizationGoal, inboxCount, useCpcCombo) {
    let count = 0;
    let label = "Tin nhắn";

    if (metrics.actions && metrics.actions.length) {
      const messAction = metrics.actions.find((a) =>
        String(a.action_type || "").includes("messaging_conversation_started"),
      );
      if (messAction) count = parseInt(messAction.value) || 0;
    }

    if (count === 0 && optimizationGoal === "LINK_CLICKS") {
      const linkAction = metrics.actions?.find(
        (a) => a.action_type === "link_click",
      );
      if (linkAction) {
        count = parseInt(linkAction.value) || 0;
        label = "Click Link";
      }
    }

    if (useCpcCombo) {
      if (useCpl && inboxCount != null) {
        count = inboxCount;
        label = "Hội thoại (Inbox)";
      }
    } else if (useCpc) {
      if (metrics.inlineLinkClicks > 0) {
        count = metrics.inlineLinkClicks;
        label = "Click Link";
      } else if (useCpl && inboxCount != null && inboxCount > 0) {
        count = inboxCount;
        label = "Hội thoại (Inbox)";
      }
    } else if (useCpl && inboxCount != null) {
      count = inboxCount;
      label = "Hội thoại (Inbox)";
    }

    return { count, label };
  }

  function extractTag(name) {
    const m = String(name || "").match(/\[([A-Za-z0-9_\-]+)\]/i);
    return m ? m[1].toUpperCase() : "";
  }

  /* ------------------------------------------------------------------
   * LẤY DỮ LIỆU ADSETS CHO 1 TÀI KHOẢN
   * ---------------------------------------------------------------- */
  async function fetchAdsetsForAccount(token, accountId, settings) {
    const statuses = ["ACTIVE", "PAUSED"];
    const filtering = encodeURIComponent(
      JSON.stringify([
        { field: "effective_status", operator: "IN", value: statuses },
      ]),
    );
    const out = [];

    try {
      const accData = await graphGet(
        `${GRAPH}/${accountId}?fields=name&access_token=${encodeURIComponent(token)}`,
      );
      if (accData.error) {
        out.push({
          error: true,
          accountId,
          accountName: accountId,
          errorMsg: accData.error.message,
        });
        return out;
      }
      const accountName = accData.name || accountId;

      const url =
        `${GRAPH}/${accountId}/adsets?fields=name,optimization_goal,effective_status,status,` +
        `daily_budget,lifetime_budget,` +
        `campaign{id,name,effective_status,status},` +
        `insights.date_preset(today){spend,actions,clicks,impressions,cpm,inline_link_clicks,ctr,cpc,frequency,reach}&` +
        `filtering=${filtering}&limit=500&access_token=${encodeURIComponent(token)}`;
      const data = await graphGet(url);
      if (data.error) {
        out.push({
          error: true,
          accountId,
          accountName,
          errorMsg: data.error.message,
        });
        return out;
      }

      for (const adset of data.data || []) {
        const ins = adset.insights ? adset.insights.data[0] : null;
        const metrics = {
          spend: num(ins?.spend, 0),
          cpm: num(ins?.cpm, 0),
          impressions: num(ins?.impressions, 0),
          clicks: num(ins?.clicks, 0),
          reach: num(ins?.reach, 0),
          frequency: num(ins?.frequency, 0),
          inlineLinkClicks: num(ins?.inline_link_clicks, 0),
          cpc: num(ins?.cpc, 0),
          ctr: num(ins?.ctr, 0),
          actions: ins?.actions || [],
        };

        let inboxCount = null;
        if (settings.useCpl || settings.useCpcCombo) {
          inboxCount = await countInboxConversationsByTag(adset.name);
        }

        const res = pickResult(
          metrics,
          settings.useCpl,
          settings.useCpc,
          adset.optimization_goal,
          inboxCount,
          settings.useCpcCombo,
        );
        const price = res.count > 0 ? Math.round(metrics.spend / res.count) : 0;
        let cpl = null;
        if (inboxCount !== null && inboxCount > 0 && metrics.spend > 0) {
          cpl = Math.round(metrics.spend / inboxCount);
        } else if (inboxCount === 0) {
          cpl = 0;
        }
        const cpcNum =
          metrics.inlineLinkClicks > 0
            ? Math.round(metrics.spend / metrics.inlineLinkClicks)
            : 0;

        out.push({
          adsetId: String(adset.id),
          accountId,
          accountName,
          name: adset.name || "",
          tag: extractTag(adset.name),
          campaignName: adset.campaign?.name || "",
          campaignId: adset.campaign?.id || "",
          campaignStatus:
            adset.campaign?.effective_status || adset.campaign?.status || "",
          optimizationGoal: adset.optimization_goal || "",
          effectiveStatus: adset.effective_status || adset.status || "",
          isPaused: (adset.effective_status || adset.status) === "PAUSED",
          isCampaignActive:
            (adset.campaign?.effective_status || adset.campaign?.status) ===
            "ACTIVE",
          dailyBudget: adset.daily_budget || 0,
          lifetimeBudget: adset.lifetime_budget || 0,
          metrics,
          inboxCount,
          cpl,
          cpcNum,
          resultCount: res.count,
          resultLabel: res.label,
          price,
          cpc: Math.round(metrics.cpc),
          spend: metrics.spend,
          cpm: metrics.cpm,
          delivering: metrics.spend > 0,
          editUrl: `https://adsmanager.facebook.com/adsmanager/manage/adsets/edit?act=${String(accountId).replace(/^act_/, "")}&adset_ids=${adset.id}`,
        });
      }
    } catch (e) {
      out.push({
        error: true,
        accountId,
        accountName: accountId,
        errorMsg: e?.message || String(e),
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------
   * ĐỌC / GHI STATE
   * ---------------------------------------------------------------- */
  async function getState() {
    const res = await storageGet([KEY_STATE]);
    const s = res[KEY_STATE];
    if (!s) {
      return {
        rows: [],
        scannedAt: 0,
        nextScanAt: 0,
        running: false,
        paused: 0,
        resumed: 0,
        logs: [],
        dayStamp: dayKey(),
        error: "",
      };
    }
    return {
      rows: Array.isArray(s.rows) ? s.rows : [],
      scannedAt: Number(s.scannedAt) || 0,
      nextScanAt: Number(s.nextScanAt) || 0,
      running: !!s.running,
      paused: Number(s.paused) || 0,
      resumed: Number(s.resumed) || 0,
      logs: Array.isArray(s.logs) ? s.logs.slice(0, MAX_LOGS) : [],
      dayStamp: s.dayStamp || dayKey(),
      error: s.error || "",
    };
  }

  async function setState(state) {
    await storageSet({
      [KEY_STATE]: {
        rows: (state.rows || []).slice(0, MAX_ROWS),
        scannedAt: state.scannedAt || Date.now(),
        nextScanAt: state.nextScanAt || 0,
        running: !!state.running,
        paused: state.paused || 0,
        resumed: state.resumed || 0,
        logs: (state.logs || []).slice(0, MAX_LOGS),
        // Luôn là ngày hiện tại — không dùng state.dayStamp (có thể đóng băng)
        dayStamp: dayKey(),
        error: state.error || "",
      },
    });
  }

  function pushLog(state, type, adsetName, campaignName, message) {
    state.logs = state.logs || [];
    state.logs.unshift({
      createdAt: Date.now(),
      type,
      adsetName: adsetName || "-",
      campaignName: campaignName || "",
      message: message || "",
    });
    state.logs = state.logs.slice(0, MAX_LOGS);
  }

  /* ------------------------------------------------------------------
   * (F) NGUỒN QUYẾT ĐỊNH TẮT / BẬT DUY NHẤT
   * ------------------------------------------------------------------
   * Nguồn sự thật cho "nhóm nào đang bị giám sát" và "nhóm nào đã bị tắt
   * tự động" = chrome.storage.local["cc_camp_state"] (do care_camp.js quản lý).
   * Bảng Auto-Pause trong dashboard cũng ghi vào đây → không còn 2 nơi cùng
   * quyết định tắt một nhóm.
   * ---------------------------------------------------------------- */
  async function getCcState() {
    const res = await storageGet([KEY_CC_STATE]);
    const s = res[KEY_CC_STATE] || {};
    return {
      monitored: Array.isArray(s.monitored) ? s.monitored : [],
      autoPaused: Array.isArray(s.autoPaused)
        ? s.autoPaused.slice(0, MAX_AUTO_PAUSED)
        : [],
      running: !!s.running,
      autoScan: s.autoScan !== false,
      settings: s.settings || {},
      dayStamp: s.dayStamp || dayKey(),
    };
  }

  async function setCcState(patch) {
    const cur = await getCcState();
    await storageSet({
      [KEY_CC_STATE]: {
        monitored: cur.monitored,
        autoPaused: cur.autoPaused,
        running: cur.running,
        autoScan: cur.autoScan,
        settings: cur.settings,
        dayStamp: cur.dayStamp,
        ...patch,
      },
    });
  }

  /**
   * (F) XOÁ danh sách "đã tắt tự động" của ngày hôm trước.
   *
   * ⚠️ PHẢI chạy ở BACKGROUND chứ không chỉ ở care_camp.js (UI):
   *    Nếu chỉ xử lý ở UI thì khi extension chạy nền (đóng tab), danh sách
   *    vẫn giữ nhóm bị tắt hôm qua → background có thể BẬT LẠI NHẦM
   *    các nhóm đó (chỉ số ngày mới đã reset về 0 nên điều kiện
   *    "spendOk" dễ thành true).
   *
   * Không bật lại các nhóm này trên Facebook — chỉ số ngày mới đã reset
   * về 0 nên bật lại sẽ bật nhầm nhóm vốn đã vượt ngưỡng hôm qua.
   *
   * @returns {number} số nhóm đã bị xoá
   */
  function purgeStaleAutoPaused(autoPaused, today = dayKey()) {
    const stale = (autoPaused || []).filter(
      (p) => dayKeyOf(p) !== today,
    );
    if (!stale.length) return 0;
    return stale.length;
  }

  /** Nhóm đang bị giám sát (từ cả 2 bảng) — gộp & khử trùng */
  function collectMonitored(ccState, apState) {
    const map = new Map();
    for (const m of ccState.monitored || []) {
      if (m && m.adsetId) map.set(String(m.adsetId), { ...m, source: "carecamp" });
    }
    for (const id of apState?.adsetIds || []) {
      const key = String(id);
      if (!map.has(key)) {
        map.set(key, {
          adsetId: key,
          accountId: "",
          accountName: "",
          name: "",
          campaignName: "",
          limits: null,
          source: "autopause",
        });
      }
    }
    return Array.from(map.values());
  }

  async function getAutoPauseState() {
    const res = await storageGet([KEY_AUTO_PAUSE]);
    const s = res[KEY_AUTO_PAUSE] || {};
    return {
      isRunning: !!s.isRunning,
      adsetIds: Array.isArray(s.adsetIds) ? s.adsetIds.map(String) : [],
      maxSpend: num(s.maxSpend, 10000),
      maxPrice: num(s.maxPrice, 12000),
      maxCpm: num(s.maxCpm, 40000),
      maxCpc: num(s.maxCpc, 800),
      useCpl: !!s.useCpl,
      useCpc: !!s.useCpc,
      useCpcCombo: !!s.useCpcCombo,
    };
  }

  async function setAutoPauseState(patch) {
    const cur = await getAutoPauseState();
    await storageSet({ [KEY_AUTO_PAUSE]: { ...cur, ...patch } });
  }

  /* ------------------------------------------------------------------
   * (D) VÒNG QUÉT CHÍNH — chạy trong BACKGROUND
   * ---------------------------------------------------------------- */
  let _scanInFlight = false;

  /**
   * Quét toàn bộ: đọc chỉ số → nâng ngưỡng (G) → tắt/bật (F) → ghi cache.
   * Đây là NGUỒN QUÉT DUY NHẤT của hệ thống.
   */
  async function runScan(opts = {}) {
    if (_scanInFlight) {
      console.log("[CAMP CORE] Đang quét → bỏ qua lần này (chống chồng).");
      return { ok: false, skipped: true };
    }
    _scanInFlight = true;

    const state = await getState();
    const startedAt = Date.now();

    // (F) Đồng bộ ngày hiện tại vào state — tránh dayStamp bị đóng băng
    //     từ lần tạo camp_core_state đầu tiên (nguyên nhân nhóm bị tắt
    //     hôm nay nhưng bị xoá khỏi danh sách).
    state.dayStamp = dayKey();

    try {
      const res = await storageGet([
        "fbToken",
        "fbIds",
        "ccTokenInput",
        "ccIdsInput",
      ]);
      const token = String(res.fbToken || res.ccTokenInput || "").trim();
      const ids = normalizeIds(res.fbIds || res.ccIdsInput || "");

      if (!token || ids.length === 0) {
        state.error = "Thiếu token hoặc ID tài khoản";
        state.nextScanAt = startedAt + SCAN_INTERVAL_MS;
        state.scannedAt = startedAt;
        await setState(state);
        return { ok: false, error: state.error };
      }

      const ccState = await getCcState();
      const apState = await getAutoPauseState();
      const monitored = collectMonitored(ccState, apState);

      // (F) SANG NGÀY MỚI → xoá danh sách "đã tắt tự động" của hôm trước.
      //     KHÔNG bật lại các nhóm đó (chỉ số ngày mới đã reset về 0).
      //     Phải làm ở BACKGROUND vì extension có thể chạy khi đóng tab.
      const today = dayKey();
      // (F) CHỈ purge khi NGÀY THỰC SỰ ĐỔI (ccState.dayStamp !== today).
      //     Trước đây purge chạy mỗi lần quét và so từng bản ghi → quá
      //     nhạy cảm, xoá nhầm cả nhóm vừa tắt trong ngày.
      const dayChanged = ccState.dayStamp !== today;
      if (dayChanged) {
        const staleCount = purgeStaleAutoPaused(ccState.autoPaused, today);
        const kept = (ccState.autoPaused || []).filter(
          (p) => dayKeyOf(p) === today,
        );
        await setCcState({ autoPaused: kept, dayStamp: today });
        // (5) Ghi log chi tiết để truy vết
        if (staleCount > 0) {
          const removedNames = (ccState.autoPaused || [])
            .filter((p) => dayKeyOf(p) !== today)
            .map((p) => p?.name || p?.adsetId || "?");
          console.log(
            `[CAMP CORE] 📅 Sang ngày mới (${today}) — đã xoá ${staleCount} nhóm đã tắt tự động của ngày hôm trước: ${removedNames.join(", ")}`,
          );
        } else {
          console.log(
            `[CAMP CORE] 📅 Sang ngày mới (${today}) — không có nhóm tắt tự động nào của hôm trước.`,
          );
        }
        ccState.autoPaused = kept;
      }

      const settings = {
        maxSpend: num(ccState.settings?.maxSpend, apState.maxSpend),
        maxPrice: num(ccState.settings?.maxPrice, apState.maxPrice),
        maxCpm: num(ccState.settings?.maxCpm, apState.maxCpm),
        maxCpc: num(ccState.settings?.maxCpc, apState.maxCpc),
        useCpl: !!(ccState.settings?.useCpl || apState.useCpl),
        useCpc: !!(ccState.settings?.useCpc || apState.useCpc),
        useCpcCombo: !!(
          ccState.settings?.useCpcCombo || apState.useCpcCombo
        ),
      };

      // ---- 1. GOM DỮ LIỆU ADSETS (1 lần / tài khoản) ----
      const allRows = [];
      for (const id of ids) {
        const rows = await fetchAdsetsForAccount(token, id, settings);
        allRows.push(...rows);
      }
      state.rows = allRows;

      // ---- 2. (G) NÂNG NGƯỠNG — 1 nguồn duy nhất ----
      const prevMap = await getPrevMap();
      for (const row of allRows) {
        if (row.error) continue;
        const res2 = await raiseThresholdForAdset(row.adsetId, row.resultCount, {
          maxSpend: settings.maxSpend,
          maxPrice: settings.maxPrice,
          maxCpm: settings.maxCpm,
          maxCpc: settings.maxCpc,
        });
        if (res2.raised) {
          console.log(
            `🚀 [CAMP CORE] Nâng ngưỡng ${row.name}: ${res2.currentMaxSpend}đ -> ${res2.newMaxSpend}đ (+${res2.diff} KQ)`,
          );
          pushLog(
            state,
            "info",
            row.name,
            row.campaignName,
            `Nâng ngưỡng tiêu ${money(res2.currentMaxSpend)} → ${money(res2.newMaxSpend)} (+${res2.diff} KQ)`,
          );
          await notifyTelegram(
            `🚀 <b>NÂNG NGƯỠNG TỰ ĐỘNG</b> 🚀\n- Nhóm: ${esc(row.name)}\n- TK: ${esc(row.accountName)}\n- KQ mới: +${res2.diff} (tổng ${row.resultCount})\n- Ngưỡng tiêu cũ: ${money(res2.currentMaxSpend)}đ\n- Ngưỡng tiêu MỚI: <b>${money(res2.newMaxSpend)}đ</b>`,
          );
        }
      }

      // ---- 3. (F) TẮT NHÓM VƯỢT NGƯỠNG — 1 nguồn quyết định duy nhất ----
      let paused = 0;
      let resumed = 0;
      const newlyPaused = [];

      if (monitored.length > 0) {
        for (const m of monitored) {
          const row = allRows.find(
            (r) => String(r.adsetId) === String(m.adsetId),
          );
          if (!row || row.error) continue;
          if (row.isPaused) continue;
          if (!row.isCampaignActive) continue;

          const lim = await limitsFor(row.adsetId, settings);
          const priceBreached =
            row.resultCount === 0 || row.price > lim.maxPrice;
          const spendOk = row.spend > lim.maxSpend;
          const cpmOk = row.cpm > lim.maxCpm;
          const cpcOk = row.cpcNum === 0 || row.cpcNum > lim.maxCpc;

          const breached = settings.useCpcCombo
            ? spendOk && priceBreached && cpcOk && cpmOk
            : spendOk && priceBreached && cpmOk;
          if (!breached) continue;

          const res3 = await setAdsetStatus(token, row.adsetId, "PAUSED");
          if (!res3.success) {
            pushLog(
              state,
              "error",
              row.name,
              row.campaignName,
              `Không tắt được: ${res3?.error?.message || "unknown"}`,
            );
            continue;
          }

          paused++;
          const modeTag = settings.useCpcCombo
            ? "KẾT HỢP CPC (4 điều kiện)"
            : settings.useCpc
              ? "CPC (Click Link)"
              : settings.useCpl
                ? "CPL (Hội thoại Inbox)"
                : "CPR (Quảng cáo)";
          const reason =
            `Tiêu ${money(row.spend)} > ${money(lim.maxSpend)}` +
            ` · Giá ${money(row.price)} > ${money(lim.maxPrice)}` +
            (settings.useCpcCombo
              ? ` · CPC ${money(row.cpcNum)} > ${money(lim.maxCpc)}`
              : "") +
            ` · CPM ${money(Math.floor(row.cpm))} > ${money(lim.maxCpm)}`;

          newlyPaused.push({
            adsetId: String(row.adsetId),
            accountId: row.accountId,
            accountName: row.accountName,
            name: row.name,
            campaignName: row.campaignName,
            spend: row.spend,
            price: row.price,
            cpm: row.cpm,
            cpcNum: row.cpcNum,
            result: row.resultCount,
            resultLabel: row.resultLabel,
            maxSpend: lim.maxSpend,
            maxPrice: lim.maxPrice,
            maxCpm: lim.maxCpm,
            maxCpc: lim.maxCpc,
            reason,
            pausedAt: Date.now(),
            // (F) Dùng ngày HIỆN TẠI — KHÔNG dùng state.dayStamp vì
            //     camp_core_state.dayStamp có thể đã đóng băng từ hôm trước
            //     → bản ghi sẽ mang ngày cũ và bị purge xoá ngay.
            dayStamp: dayKey(),
          });

          pushLog(state, "auto_pause", row.name, row.campaignName, `Tự động tắt — ${reason}`);
          await notifyTelegram(
            `⛔ <b>TỰ ĐỘNG TẮT NHÓM QUẢNG CÁO</b> ⛔\n` +
            `- TK: ${esc(row.accountName || "-")}\n` +
            `- Chiến dịch: ${esc(row.campaignName || "-")}\n` +
            `- Nhóm: ${esc(row.name)}\n` +
              `- Chế độ: ${modeTag}\n` +
              `- Đã tiêu: ${money(row.spend)} đ\n` +
              `- ${row.resultLabel || "Kết quả"}: ${money(row.resultCount)}\n` +
              `- Giá/KQ: ${money(row.price)} đ (ngưỡng ${money(lim.maxPrice)} đ)\n` +
              (settings.useCpcCombo
                ? `- CPC: ${money(row.cpcNum)} đ (ngưỡng ${money(lim.maxCpc)} đ)\n`
                : "") +
              `- CPM: ${money(Math.floor(row.cpm))} đ (ngưỡng ${money(lim.maxCpm)} đ)\n` +
              `- Lý do: <b>${reason}</b>`,
          );
        }
      }

      // Ghi danh sách "đã tắt tự động" về nguồn chung (cc_camp_state)
      if (newlyPaused.length > 0) {
        const merged = [...newlyPaused, ...ccState.autoPaused].slice(
          0,
          MAX_AUTO_PAUSED,
        );
        await setCcState({ autoPaused: merged });
      }

      // ---- 4. BẬT LẠI NHÓM ĐÃ TẮT TỰ ĐỘNG ----
      const ccState2 = await getCcState();
      for (const p of ccState2.autoPaused) {
        const row = allRows.find(
          (r) => String(r.adsetId) === String(p.adsetId),
        );
        if (!row || row.error) continue;
        if (!row.isCampaignActive) continue;

        const baseLim = {
          maxSpend: num(p.maxSpend, settings.maxSpend),
          maxPrice: num(p.maxPrice, settings.maxPrice),
          maxCpm: num(p.maxCpm, settings.maxCpm),
          maxCpc: num(p.maxCpc, settings.maxCpc),
        };
        const prevResult = num(p.result, 0);
        const newResults = Math.max(0, row.resultCount - prevResult);
        const newPrice =
          row.resultCount > 0
            ? Math.round(row.spend / row.resultCount)
            : Infinity;

        // Nâng ngưỡng tiêu theo số KQ mới phát sinh lúc đang bị tắt
        const shared = await limitsFor(p.adsetId, settings);
        const newMaxSpend = Math.max(
          baseLim.maxSpend + baseLim.maxPrice * newResults,
          shared.maxSpend || 0,
        );

        // (F) ĐIỀU KIỆN BẬT LẠI — KHÔNG DÙNG CPM
        //   CPM chỉ dùng để TẮT nhóm, KHÔNG dùng để BẬT LẠI:
        //   CPM tụt xuống chỉ vì ngừng chi tiêu, không có nghĩa
        //   nhóm đã chạy lại được tốt hơn.
        //   - priceOk: đã có KQ MỚI và giá/KQ mới <= ngưỡng giá
        //   - spendOk: tổng chi tiêu <= ngưỡng tiêu (đã nâng theo KQ mới)
        //   - cpcOk  : CPC <= ngưỡng CPC (chỉ ở chế độ Kết hợp CPC)
        const priceOk = newResults > 0 && newPrice <= baseLim.maxPrice;
        const spendOk = row.spend <= newMaxSpend;

        let canResume;
        if (settings.useCpcCombo) {
          const cpcOk =
            row.cpcNum > 0 && row.cpcNum <= baseLim.maxCpc;
          canResume = cpcOk && priceOk && spendOk;
        } else {
          canResume = priceOk || spendOk;
        }
        if (!canResume) continue;

        const res4 = await setAdsetStatus(token, p.adsetId, "ACTIVE");
        if (!res4.success) continue;

        resumed++;
        // Cập nhật DANH SÁCH CỤC BỘ trước khi ghi — nếu không, khi có nhiều
        // nhóm được bật lại trong cùng 1 lần quét, các lần ghi sau sẽ dùng
        // lại danh sách cũ và đưa nhóm đã bật lại trở lại vào autoPaused.
        ccState2.autoPaused = ccState2.autoPaused.filter(
          (x) => String(x.adsetId) !== String(p.adsetId),
        );
        await setCcState({
          autoPaused: ccState2.autoPaused,
        });

        // Ghi ngưỡng mới vào nguồn cấu hình chung
        const cfg = await getConfigs();
        const cid = String(p.adsetId);
        const old = cfg[cid] || {};
        cfg[cid] = {
          ...old,
          maxSpend: newMaxSpend,
          maxPrice: baseLim.maxPrice,
          maxCpm: baseLim.maxCpm,
          maxCpc: baseLim.maxCpc,
          originalMaxSpend: old.originalMaxSpend || baseLim.maxSpend,
          originalMaxPrice: old.originalMaxPrice || baseLim.maxPrice,
          originalMaxCpm: old.originalMaxCpm || baseLim.maxCpm,
          originalMaxCpc: old.originalMaxCpc || baseLim.maxCpc,
        };
        await setConfigs(cfg);

        // Đồng bộ mốc đếm KQ → lần sau không nâng ngưỡng 2 lần cho KQ này
        const prevMap2 = await getPrevMap();
        prevMap2[cid] = row.resultCount;
        await setPrevMap(prevMap2);

        // (F) Lý do bật lại (KHÔNG dùng CPM — CPM chỉ dùng để TẮT nhóm)
        const resumeReason = priceOk
          ? `có KQ mới (${money(newResults)}) với giá ${money(newPrice)} đ ≤ ngưỡng ${money(baseLim.maxPrice)} đ`
          : `tổng chi tiêu ${money(row.spend)} đ ≤ ngưỡng tiêu ${money(newMaxSpend)} đ`;

        pushLog(
          state,
          "auto_resume",
          p.name,
          p.campaignName,
          `Đã bật lại — ${resumeReason}. Nâng ngưỡng tiêu ${money(baseLim.maxSpend)} → ${money(newMaxSpend)} (+${newResults} KQ).`,
        );
        await notifyTelegram(
          `✅ <b>TỰ ĐỘNG BẬT LẠI NHÓM QUẢNG CÁO</b> ✅\n` +
            `- TK: ${esc(row.accountName || p.accountName || "-")}\n` +
            `- Chiến dịch: ${esc(row.campaignName || p.campaignName || "-")}\n` +
            `- Nhóm: ${esc(row.name || p.name)}\n` +
            `- KQ mới: ${money(newResults)}\n` +
            `- Giá mới: ${money(newPrice)} đ (ngưỡng ${money(baseLim.maxPrice)} đ)\n` +
            `- Lý do bật lại: ${resumeReason}\n` +
            `- Ngưỡng tiêu: ${money(baseLim.maxSpend)} → <b>${money(newMaxSpend)} đ</b>`,
        );
      }

      state.paused = paused;
      state.resumed = resumed;
      state.running = true;
      state.error = "";
      state.scannedAt = Date.now();
      state.nextScanAt = Date.now() + SCAN_INTERVAL_MS;
      await setState(state);

      // Báo dashboard biết có dữ liệu mới
      try {
        chrome.runtime.sendMessage({ type: "camp-core-updated" }).catch(() => {});
      } catch (e) {
        /* bỏ qua */
      }

      console.log(
        `[CAMP CORE] ✅ Quét xong trong ${Date.now() - startedAt}ms — ` +
          `${allRows.length} nhóm · tắt ${paused} · bật lại ${resumed}`,
      );
      return { ok: true, rows: allRows.length, paused, resumed };
    } catch (e) {
      state.error = e?.message || String(e);
      state.nextScanAt = Date.now() + SCAN_INTERVAL_MS;
      await setState(state);
      console.error("[CAMP CORE] ❌ Lỗi quét:", e);
      return { ok: false, error: state.error };
    } finally {
      _scanInFlight = false;
    }
  }

  /* ------------------------------------------------------------------
   * ĐIỀU KHIỂN ALARM (D)
   * ---------------------------------------------------------------- */
  function scheduleAlarm(minutes = SCAN_INTERVAL_MINUTES) {
    try {
      chrome.alarms.create(KEY_ALARM, {
        periodInMinutes: Math.max(1, minutes),
      });
    } catch (e) {
      console.warn("[CAMP CORE] Không tạo được alarm:", e?.message);
    }
  }

  function clearAlarm() {
    try {
      chrome.alarms.clear(KEY_ALARM);
    } catch (e) {
      /* bỏ qua */
    }
  }

  /* ------------------------------------------------------------------
   * API PUBLIC
   * ---------------------------------------------------------------- */
  const api = {
    GRAPH,
    GRAPH_VERSION,
    SCAN_INTERVAL_MS,
    SCAN_INTERVAL_MINUTES,
    KEY_STATE,
    KEY_PREV,
    KEY_CONFIGS,
    KEY_CC_STATE,
    KEY_AUTO_PAUSE,
    KEY_ALARM,

    // storage helpers
    storageGet,
    storageSet,

    // tiện ích
    num,
    money,
    esc,
    dayKey,
    normalizeIds,

    // (G) nâng ngưỡng
    raiseThresholdForAdset,
    getPrevMap,
    setPrevMap,
    getConfigs,
    setConfigs,
    limitsFor,

    // inbox
    countInboxConversationsByTag,

    // (F) state dùng chung
    getState,
    setState,
    getCcState,
    setCcState,
    getAutoPauseState,
    setAutoPauseState,
    collectMonitored,

    // (D) quét
    runScan,
    scheduleAlarm,
    clearAlarm,

    // hàm nâng ngưỡng đồng bộ cho code cũ (fallback khi chưa có storage)
    syncRaiseThreshold: async (adsetId, effectiveCount, opts) =>
      raiseThresholdForAdset(adsetId, effectiveCount, opts),
  };

  global.CampCore = api;
})(typeof window !== "undefined" ? window : self);
