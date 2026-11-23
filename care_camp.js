/* =========================================================================
 * ✂️ TẮT CAMP TỰ ĐỘNG (CARE CAMP) — chạy hoàn toàn trong extension
 * -------------------------------------------------------------------------
 * Gọi Meta Graph API trực tiếp bằng token của extension:
 *   - Tải danh sách nhóm quảng cáo ACTIVE + chỉ số hôm nay
 *   - Tự động tắt nhóm khi: tiêu > ngưỡng tiền VÀ giá/KQ > ngưỡng giá
 *     VÀ CPM > ngưỡng CPM
 *   - Bật lại nhóm đã trở lại trong ngưỡng
 *   - Lưu nhật ký + danh sách nhóm đã tắt tự động vào chrome.storage.local
 * ========================================================================= */
(function () {
  "use strict";

  const GRAPH = "https://graph.facebook.com/v20.0";
  const STORAGE_KEY = "cc_camp_state";
  const SCAN_INTERVAL_MS = 60 * 1000;
  const CONFIGS_KEY = "fb_local_configs";
  // Chỉ giữ log trong 30 tiếng gần nhất (theo thời gian thực tế)
  const LOG_WINDOW_MS = 30 * 60 * 60 * 1000;
  // Trần cứng: tối đa 100 log (~25 KB storage) — tránh ghi đè toàn bộ state
  // mỗi 60s khi log dày bất thường, và tránh render quá nhiều dòng <tr>
  const MAX_LOGS = 100;
  // Trần cứng cho danh sách nhóm đã tắt tự động (~37 KB storage)
  const MAX_AUTO_PAUSED = 100;
  // Ghi state theo lô (debounce) — ghi storage mỗi 3 phút thay vì mỗi 60s
  const SAVE_DEBOUNCE_MS = 3 * 60 * 1000;

  /* ---------------------------- Ngày làm việc ----------------------------
   * Sang ngày mới (theo giờ địa phương của máy) danh sách "nhóm đã tắt tự
   * động" của hôm trước sẽ bị XOÁ và KHÔNG được bật lại, vì chỉ số ngày mới
   * đã reset về 0 nên mọi ngưỡng đều "trong ngưỡng cho phép" → nếu bật lại
   * sẽ bật nhầm nhóm vốn đã vượt ngưỡng hôm qua.
   * ---------------------------------------------------------------------- */

  /** Khoá ngày theo định dạng YYYY-MM-DD (giờ địa phương) */
  function dayKey(ts = Date.now()) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /** Khoá ngày của 1 bản ghi trong danh sách đã tắt tự động */
  function pausedDayKey(p) {
    if (!p) return "";
    if (p.dayStamp) return String(p.dayStamp);
    // Dữ liệu cũ (chưa có dayStamp) → suy ra từ pausedAt
    return p.pausedAt ? dayKey(p.pausedAt) : "";
  }

  /* ------------------------------- Tiện ích ------------------------------ */
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? "" : s).replace(
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
  const money = (n) => Math.round(Number(n || 0)).toLocaleString("vi-VN");
  const num = (v, fb) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fb;
  };

  function toast(msg, type = "info") {
    const box = $("ccMsg");
    if (!box) return;
    box.style.display = "block";
    box.style.background =
      type === "ok" ? "#e7f6ec" : type === "err" ? "#fdecea" : "#eef3fb";
    box.style.color =
      type === "ok" ? "#1a7f37" : type === "err" ? "#b3261e" : "#1c4e9c";
    box.textContent = msg;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (box.style.display = "none"), 6000);
  }

  function getToken() {
    const inp = $("ccTokenInput");
    const v = inp && inp.value ? inp.value.trim() : "";
    if (v) return v;
    const main = $("tokenInput");
    if (main && main.value) return main.value.trim();
    return window.__ccToken || "";
  }

  function getAccountIds() {
    const raw = ($("ccIdsInput") && $("ccIdsInput").value) || "";
    return raw
      .split(/[\s,;]+/)
      .map((s) => s.trim().replace(/^act_/i, ""))
      .filter(Boolean)
      // Meta Graph API BẮT BUỘC tiền tố "act_" khi gọi /{id}/adsets,
      // nếu thiếu sẽ lỗi #100 "Tried accessing nonexisting field (adsets)".
      .map((s) => "act_" + s);
  }

  /* ------------------ Cấu hình dùng chung (nguồn duy nhất) ------------------
   * Nguồn sự thật duy nhất cho ngưỡng tiền / giá / CPM của từng nhóm QC:
   *   window.localConfigs  (được dashboard.js nạp từ localStorage["fb_local_configs"])
   *   ↕ đồng bộ 2 chiều
   *   localStorage["fb_local_configs"]
   *
   * Dùng chung cho: Bảng Chỉ Số · Bảng Auto-Pause · Bảng Tắt Camp Tự Động.
   * state.monitored[].limits chỉ còn là bản sao lưu trữ, KHÔNG phải nguồn đọc.
   * ---------------------------------------------------------------------- */

  /** Lấy object cấu hình dùng chung (luôn trả về cùng 1 object reference) */
  function sharedConfigs() {
    if (!window.localConfigs || typeof window.localConfigs !== "object") {
      try {
        window.localConfigs = JSON.parse(
          localStorage.getItem(CONFIGS_KEY) || "{}",
        );
      } catch (e) {
        window.localConfigs = {};
      }
      if (!window.localConfigs || typeof window.localConfigs !== "object") {
        window.localConfigs = {};
      }
    }
    return window.localConfigs;
  }

  function readConfigs() {
    return sharedConfigs();
  }

  /**
   * Ghi cấu hình — MUTATE đúng object đang dùng chung (không thay thế reference)
   * rồi lưu xuống localStorage để không mất khi F5.
   */
  function writeConfigs(cfg) {
    const shared = sharedConfigs();
    // Merge (không xoá key) — luôn giữ đủ cấu hình của mọi nhóm
    for (const k of Object.keys(cfg || {})) {
      shared[k] = cfg[k];
    }
    try {
      localStorage.setItem(CONFIGS_KEY, JSON.stringify(shared));
    } catch (e) {
      console.warn("Không lưu được cấu hình ngưỡng:", e);
    }
  }

  /** Ghi ngưỡng riêng của 1 nhóm vào localConfigs (đồng bộ với bảng Chỉ Số) */
  function saveConfigFor(adsetId, maxSpend, maxPrice, maxCpm) {
    const cfg = readConfigs();
    const id = String(adsetId);
    const old = cfg[id] || {};
    cfg[id] = {
      ...old,
      maxSpend,
      maxPrice,
      maxCpm,
      originalMaxSpend: old.originalMaxSpend || maxSpend,
      originalMaxPrice: old.originalMaxPrice || maxPrice,
      originalMaxCpm: old.originalMaxCpm || maxCpm,
    };
    writeConfigs(cfg);
    return cfg[id];
  }

  /** Đồng bộ ngưỡng CHUNG giữa bảng Tắt Camp (ccMax*) và bảng Auto-Pause (apMax*) */
  function syncGlobalThreshold(which, value) {
    const map = {
      maxSpend: { cc: "ccMaxSpend", ap: "apMaxSpend", key: "fb_apMaxSpend" },
      maxPrice: { cc: "ccMaxPrice", ap: "apMaxPrice", key: "fb_apMaxPrice" },
      maxCpm: { cc: "ccMaxCpm", ap: "apMaxCpm", key: "fb_apMaxCpm" },
    };
    const m = map[which];
    if (!m) return;
    // Ghi sang ô của bảng Auto-Pause
    const apEl = $(m.ap);
    if (apEl && apEl.value !== String(value)) apEl.value = value;
    try {
      localStorage.setItem(m.key, String(value));
    } catch (e) {
      /* bỏ qua */
    }
  }

  /** Đọc ngưỡng CHUNG từ bảng Auto-Pause (ưu tiên) để 2 bảng không lệch nhau */
  function readGlobalThreshold(which, fallback) {
    const map = {
      maxSpend: { cc: "ccMaxSpend", ap: "apMaxSpend", key: "fb_apMaxSpend" },
      maxPrice: { cc: "ccMaxPrice", ap: "apMaxPrice", key: "fb_apMaxPrice" },
      maxCpm: { cc: "ccMaxCpm", ap: "apMaxCpm", key: "fb_apMaxCpm" },
    };
    const m = map[which];
    if (!m) return fallback;
    const apEl = $(m.ap);
    if (apEl && apEl.value !== "") {
      const v = parseFloat(apEl.value);
      if (Number.isFinite(v)) return v;
    }
    try {
      const saved = localStorage.getItem(m.key);
      if (saved !== null) {
        const v = parseFloat(saved);
        if (Number.isFinite(v)) return v;
      }
    } catch (e) {
      /* bỏ qua */
    }
    return fallback;
  }

  /* ------------------------------- Trạng thái ----------------------------- */
  const state = {
    rows: [],
    monitored: [], // [{ adsetId, accountId, accountName, name, campaignName, limits:{maxSpend,maxPrice,maxCpm} }]
    autoPaused: [], // [{ adsetId, accountId, accountName, name, campaignName, spend, cpm, price, result, resultLabel, maxSpend, maxPrice, maxCpm, reason, pausedAt }]
    logs: [], // [{ createdAt, type, adsetName, campaignName, message }]
    running: false,
    autoScan: true,
    dayStamp: "", // khoá ngày của lần chạy hiện tại (YYYY-MM-DD) — dùng để xoá danh sách tắt tự động khi sang ngày mới
    settings: { maxSpend: 10000, maxPrice: 12000, maxCpm: 50000, useCpl: false, useCpc: false },
    timer: null,
  };

  // Timer cho lô ghi state (debounce)
  let saveTimer = null;

  /**
   * Ghi state vào chrome.storage.local.
   *
   * Mặc định dùng DEBOUNCE (gộp lô): nhiều lần gọi trong 3 phút chỉ ghi 1 lần
   * → giảm I/O storage xuống ~1/3 (quét 60s nhưng chỉ ghi mỗi 3 phút).
   * Truyền immediate = true cho các thay đổi quan trọng (bật/dừng giám sát,
   * đổi ngưỡng) để ghi ngay, tránh mất dữ liệu khi đóng tab.
   */
  async function saveState(immediate = false) {
    if (!immediate) {
      scheduleSave();
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = null;
    await writeState();
  }

  /** Hẹn giờ ghi state sau SAVE_DEBOUNCE_MS */
  function scheduleSave() {
    if (saveTimer) return; // đã có lô đang chờ
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeState();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Ghi state ngay lập tức (bỏ qua lô đang chờ) */
  async function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    await writeState();
  }

  async function writeState() {
    await new Promise((r) =>
      chrome.storage.local.set(
        {
          [STORAGE_KEY]: {
            monitored: state.monitored,
            autoPaused: state.autoPaused.slice(0, MAX_AUTO_PAUSED),
            logs: pruneLogs(state.logs),
            running: state.running,
            autoScan: state.autoScan,
            settings: state.settings,
            dayStamp: state.dayStamp || dayKey(),
          },
        },
        r,
      ),
    );
  }

  async function loadState() {
    const d = await new Promise((resolve) =>
      chrome.storage.local.get([STORAGE_KEY], (res) => resolve(res)),
    );
    const s = (d && d[STORAGE_KEY]) || null;
    if (!s) {
      state.dayStamp = dayKey();
      return;
    }
    state.monitored = Array.isArray(s.monitored) ? s.monitored : [];
    state.autoPaused = (Array.isArray(s.autoPaused) ? s.autoPaused : []).slice(
      0,
      MAX_AUTO_PAUSED,
    );
    state.logs = pruneLogs(Array.isArray(s.logs) ? s.logs : []);
    state.running = !!s.running;
    state.autoScan = s.autoScan !== false;
    state.settings = Object.assign(
      { maxSpend: 10000, maxPrice: 12000, maxCpm: 50000, useCpl: false, useCpc: false },
      s.settings || {},
    );

    // Sang ngày mới → xoá danh sách "nhóm đã tắt tự động" của hôm trước
    // và KHÔNG bật lại các nhóm đó (chỉ số ngày mới đã reset về 0).
    state.dayStamp = dayKey();
    purgeStaleAutoPaused();
  }

  /**
   * Xoá khỏi danh sách "nhóm đã tắt tự động" những nhóm thuộc ngày hôm trước.
   * KHÔNG bật lại các nhóm này trên Facebook (chỉ số ngày mới đã reset về 0
   * nên nếu bật lại sẽ bật nhầm nhóm vốn đã vượt ngưỡng hôm qua).
   * @returns {number} số nhóm đã bị xoá
   */
  function purgeStaleAutoPaused() {
    const today = state.dayStamp || dayKey();
    const stale = state.autoPaused.filter((p) => pausedDayKey(p) !== today);
    if (!stale.length) return 0;
    state.autoPaused = state.autoPaused.filter(
      (p) => pausedDayKey(p) === today,
    );
    pushLog(
      "info",
      "-",
      "",
      `Sang ngày mới (${today}) — đã xoá ${stale.length} nhóm đã tắt tự động của ngày hôm trước khỏi danh sách (không bật lại vì chỉ số đã reset).`,
    );
    return stale.length;
  }

  /**
   * Kiểm tra ngày mới mỗi lần quét — nếu đã sang ngày (tab mở qua đêm)
   * thì xoá danh sách nhóm đã tắt tự động của hôm trước, KHÔNG bật lại.
   * @returns {number} số nhóm đã bị xoá
   */
  function rolloverDayIfNeeded() {
    const today = dayKey();
    if (state.dayStamp === today) return 0;
    state.dayStamp = today;
    return purgeStaleAutoPaused();
  }

  /** Chỉ giữ lại log trong 30 tiếng gần nhất (và tối đa MAX_LOGS bản ghi) */
  function pruneLogs(list) {
    const now = Date.now();
    const cutoff = now - LOG_WINDOW_MS;
    return (Array.isArray(list) ? list : [])
      .filter((l) => {
        const t = Number(l && l.createdAt);
        return Number.isFinite(t) && t >= cutoff;
      })
      .slice(0, MAX_LOGS);
  }

  function pushLog(type, adsetName, campaignName, message) {
    state.logs.unshift({
      createdAt: Date.now(),
      type,
      adsetName: adsetName || "-",
      campaignName: campaignName || "",
      message: message || "",
    });
    state.logs = pruneLogs(state.logs);
  }

  /**
   * Tính chỉ số kết quả — LOGIC GIỐNG HỆT bảng "Bảng Chỉ Số Vít Camp"
   * (dashboard.js → window.getHieuQuaCount + effectiveCount).
   *
   * 1. Ưu tiên hội thoại inbox (messaging_conversation_started) — nhãn "Tin nhắn"
   * 2. Nếu không có tin nhắn và mục tiêu là Click → link_click — nhãn "Click Link"
   * 3. Bật CPC → dùng inline_link_clicks nếu có
   * 4. Bật CPL → dùng số hội thoại đếm được từ inbox theo tag
   */
  function pickResult(metrics, useCpl, useCpc, optimizationGoal, inboxCount) {
    let count = 0;
    let label = "Tin nhắn";

    // 1. Hội thoại inbox từ Meta
    if (metrics.actions && metrics.actions.length) {
      const messAction = metrics.actions.find((a) =>
        String(a.action_type || "").includes("messaging_conversation_started"),
      );
      if (messAction) count = parseInt(messAction.value) || 0;
    }

    // 2. Không có tin nhắn + mục tiêu Click → lấy link_click
    if (count === 0 && optimizationGoal === "LINK_CLICKS") {
      const linkAction = metrics.actions?.find(
        (a) => a.action_type === "link_click",
      );
      if (linkAction) {
        count = parseInt(linkAction.value) || 0;
        label = "Click Link";
      }
    }

    // 3. Bật CPC → ưu tiên click link
    if (useCpc) {
      if (metrics.inlineLinkClicks > 0) {
        count = metrics.inlineLinkClicks;
        label = "Click Link";
      } else if (useCpl && inboxCount != null && inboxCount > 0) {
        count = inboxCount;
        label = "Hội thoại (Inbox)";
      }
    } else if (useCpl && inboxCount != null) {
      // 4. Bật CPL → dùng số hội thoại đếm từ inbox theo tag
      count = inboxCount;
      label = "Hội thoại (Inbox)";
    }

    return { count, label };
  }

  /** Trích xuất tag [N1] từ tên nhóm */
  function extractTag(name) {
    const m = String(name || "").match(/\[([A-Za-z0-9_\-]+)\]/i);
    return m ? m[1].toUpperCase() : "";
  }

  function limitsFor(adsetId) {
    // Nguồn duy nhất: localStorage["fb_local_configs"] (đồng bộ với bảng Chỉ Số)
    // Fallback: ngưỡng riêng đã lưu trong state.monitored (dữ liệu cũ) → ngưỡng chung
    const cfg = readConfigs();
    const local = cfg[String(adsetId)];
    if (local) {
      const g = state.settings;
      return {
        maxSpend: num(local.maxSpend, g.maxSpend),
        maxPrice: num(local.maxPrice ?? local.maxCpr, g.maxPrice),
        maxCpm: num(local.maxCpm, g.maxCpm),
      };
    }
    const m = state.monitored.find(
      (x) => String(x.adsetId) === String(adsetId),
    );
    const g = state.settings;
    return {
      maxSpend: m?.limits?.maxSpend || g.maxSpend,
      maxPrice: m?.limits?.maxPrice || g.maxPrice,
      maxCpm: m?.limits?.maxCpm || g.maxCpm,
    };
  }

  function isBreached(row) {
    const lim = limitsFor(row.adsetId);
    // Không có kết quả => giá = vô hạn => coi như vượt ngưỡng giá
    const priceBreached = row.resultCount === 0 || row.price > lim.maxPrice;
    return row.spend > lim.maxSpend && priceBreached && row.cpm > lim.maxCpm;
  }

  /**
   * Thêm (hoặc cập nhật) một nhóm vào bảng GIÁM SÁT (state.monitored).
   *
   * Dùng sau khi BẬT LẠI một nhóm (tự động hoặc thủ công) để nhóm đó tiếp tục
   * được theo dõi: nếu chỉ số lại vượt ngưỡng ở lần quét kế tiếp thì sẽ bị
   * tắt tự động tiếp (đúng ý "bật lại xong vẫn giám sát, vượt ngưỡng lại tắt").
   */
  function addToMonitored(info, lim) {
    const adsetId = String(info.adsetId);
    const limits = lim || limitsFor(adsetId);
    const existing = state.monitored.find(
      (x) => String(x.adsetId) === adsetId,
    );
    if (existing) {
      existing.name = info.name || existing.name;
      existing.campaignName = info.campaignName || existing.campaignName;
      existing.accountId = info.accountId || existing.accountId;
      existing.accountName = info.accountName || existing.accountName;
      existing.limits = limits;
      return existing;
    }
    const item = {
      adsetId,
      accountId: info.accountId || "",
      accountName: info.accountName || "",
      name: info.name || "",
      campaignName: info.campaignName || "",
      campaignId: info.campaignId || "",
      limits,
    };
    state.monitored.push(item);
    return item;
  }

  /* ------------------------------ Gọi Meta API ---------------------------- */
  async function fetchAdsets(token, ids, includePaused = true) {
    // Lấy cả ACTIVE và PAUSED để sau khi tắt còn đọc được chỉ số để quyết định bật lại
    const statuses = includePaused ? ["ACTIVE", "PAUSED"] : ["ACTIVE"];
    const filtering = encodeURIComponent(
      JSON.stringify([
        { field: "effective_status", operator: "IN", value: statuses },
      ]),
    );
    const out = [];
    for (const id of ids) {
      try {
        const accUrl = `${GRAPH}/${id}?fields=name&access_token=${encodeURIComponent(token)}`;
        const accData = await fetch(accUrl).then((r) => r.json());
        if (accData.error) {
          out.push({
            error: true,
            accountId: id,
            accountName: id,
            errorMsg: accData.error.message,
          });
          continue;
        }
        const accountName = accData.name || id;

        const url =
          `${GRAPH}/${id}/adsets?fields=name,optimization_goal,effective_status,status,` +
          `campaign{id,name,effective_status,status},insights.date_preset(today){spend,actions,clicks,impressions,cpm,inline_link_clicks,ctr,cpc}&` +
          `filtering=${filtering}&limit=500&access_token=${encodeURIComponent(token)}`;
        const data = await fetch(url).then((r) => r.json());
        if (data.error) {
          out.push({
            error: true,
            accountId: id,
            accountName,
            errorMsg: data.error.message,
          });
          continue;
        }
        for (const adset of data.data || []) {
          const ins = adset.insights ? adset.insights.data[0] : null;
          const metrics = {
            spend: parseFloat(ins?.spend || 0),
            cpm: parseFloat(ins?.cpm || 0),
            impressions: parseFloat(ins?.impressions || 0),
            inlineLinkClicks: parseFloat(ins?.inline_link_clicks || 0),
            cpc: parseFloat(ins?.cpc || 0),
            actions: ins?.actions || [],
          };
          // Đếm hội thoại inbox theo tag [N1] (nếu bật CPL)
          let inboxCount = null;
          if (state.settings.useCpl) {
            try {
              inboxCount = await window.countInboxConversationsByTag(
                adset.name,
              );
            } catch (e) {
              inboxCount = null;
            }
          }
          const res = pickResult(
            metrics,
            state.settings.useCpl,
            state.settings.useCpc,
            adset.optimization_goal,
            inboxCount,
          );
          const price = res.count > 0 ? Math.round(metrics.spend / res.count) : 0;

          // CPL từ inbox (giống cột "CPL (INBOX)" của bảng Bảng Chỉ Số)
          let cpl = null;
          if (inboxCount !== null && inboxCount > 0 && metrics.spend > 0) {
            cpl = Math.round(metrics.spend / inboxCount);
          } else if (inboxCount === 0) {
            cpl = 0;
          }
          // CPC thực tế (spend / click link)
          const cpcNum =
            metrics.inlineLinkClicks > 0
              ? Math.round(metrics.spend / metrics.inlineLinkClicks)
              : 0;

          out.push({
            key: String(adset.id),
            adsetId: String(adset.id),
            accountId: id,
            accountName,
            name: adset.name,
            tag: extractTag(adset.name),
            campaignName: adset.campaign?.name || "",
            campaignId: adset.campaign?.id || "",
            campaignStatus:
              adset.campaign?.effective_status || adset.campaign?.status || "",
            optimizationGoal: adset.optimization_goal || "",
            effectiveStatus: adset.effective_status || adset.status || "",
            isPaused: (adset.effective_status || adset.status) === "PAUSED",
            // Chiến dịch có đang bật không (effective_status = ACTIVE)
            isCampaignActive:
              (adset.campaign?.effective_status || adset.campaign?.status) ===
              "ACTIVE",
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
            editUrl: `https://adsmanager.facebook.com/adsmanager/manage/adsets/edit?act=${id}&adset_ids=${adset.id}`,
          });
        }
      } catch (e) {
        out.push({
          error: true,
          accountId: id,
          accountName: id,
          errorMsg: e?.message || String(e),
        });
      }
    }
    return out;
  }

  async function setAdsetStatus(token, adsetId, status) {
    const res = await fetch(`${GRAPH}/${adsetId}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `status=${status}&access_token=${encodeURIComponent(token)}`,
    }).then((r) => r.json());
    return res;
  }

  /* -------------------------------- Render -------------------------------- */
  function renderStatCards() {
    // Chỉ tính nhóm đang bật và thuộc chiến dịch đang bật (giống bảng hiển thị)
    const active = state.rows.filter(
      (r) => !r.error && !r.isPaused && r.isCampaignActive,
    );
    const delivering = active.filter((r) => r.delivering);
    const totalSpend = delivering.reduce((s, r) => s + r.spend, 0);
    const totalResult = delivering.reduce((s, r) => s + r.resultCount, 0);
    const breached = delivering.filter((r) => isBreached(r)).length;
    const activeCampaigns = new Set(
      active.map((r) => r.campaignId || r.campaignName).filter(Boolean),
    ).size;
    const cards = [
      { label: "Nhóm đang bật", value: active.length, color: "#1877f2" },
      { label: "Chiến dịch đang bật", value: activeCampaigns, color: "#7950f2" },
      { label: "Nhóm đang phân phối", value: delivering.length, color: "#0e7490" },
      { label: "Tổng tiêu hôm nay", value: money(totalSpend) + " đ", color: "#d97706" },
      { label: "Tổng kết quả", value: money(totalResult), color: "#31a24c" },
      { label: "Vượt ngưỡng", value: breached, color: breached ? "#fa383e" : "#65676b" },
      {
        label: "Đang giám sát",
        value: state.running ? state.monitored.length + " nhóm" : "TẮT",
        color: state.running ? "#31a24c" : "#65676b",
      },
      { label: "Đã tắt tự động", value: state.autoPaused.length, color: "#fa383e" },
    ];
    const html = cards
      .map(
        (c) => `<div class="cc-card">
          <div class="cc-card-label">${esc(c.label)}</div>
          <div class="cc-card-value" style="color:${c.color}">${esc(c.value)}</div>
        </div>`,
      )
      .join("");
    const el = $("ccStats");
    if (el) el.innerHTML = html;
  }

  function renderRowsTable() {
    const tb = $("ccTableBody");
    if (!tb) return;
    // Chỉ hiển thị nhóm ĐANG BẬT (ACTIVE) và thuộc chiến dịch ĐANG BẬT (ACTIVE)
    const rows = state.rows.filter(
      (r) => !r.error && !r.isPaused && r.isCampaignActive,
    );
    const hiddenCount = state.rows.filter(
      (r) => !r.error && (r.isPaused || !r.isCampaignActive),
    ).length;
    if (!rows.length) {
      tb.innerHTML =
        '<tr><td colspan="12" style="text-align:center;color:#65676b;padding:20px">Chưa có nhóm nào đang bật — bấm "Tải danh sách nhóm".</td></tr>';
      return;
    }
    tb.innerHTML = rows
      .map((r) => {
        const lim = limitsFor(r.adsetId);
        const bad = isBreached(r);
        const watched = state.monitored.some(
          (m) => String(m.adsetId) === String(r.adsetId),
        );
        return `<tr>
        <td style="text-align:center">
          <input type="checkbox" class="cc-check" value="${esc(r.adsetId)}" ${watched ? "checked" : ""} />
        </td>
        <td style="font-size:11px;color:#65676b">${esc(r.accountName)}</td>
        <td style="color:#1877f2;font-size:12px;font-weight:bold">${esc(r.campaignName || "-")}
          <div style="font-size:10px;color:#31a24c;font-weight:bold">🟢 ${esc(r.campaignStatus || "ACTIVE")}</div>
        </td>
        <td style="font-weight:bold;font-size:13px">${esc(r.name)}
          ${r.tag ? `<span style="background:#f3e8ff;color:#7950f2;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:bold">${esc(r.tag)}</span>` : ""}
          <div style="font-size:10px;color:#8c939d;font-family:monospace">${esc(r.adsetId)}</div>
        </td>
        <td style="color:#d97706;font-weight:bold;font-family:monospace;text-align:right">${money(r.spend)} đ</td>
        <td style="text-align:right">
          <b style="color:#31a24c;font-family:monospace">${money(r.resultCount)}</b>
          <div style="font-size:10px;color:#8c939d">${esc(r.resultLabel)}</div>
        </td>
        <td style="color:#fa383e;font-weight:bold;font-family:monospace;text-align:right">${money(r.price)} đ</td>
        <td style="text-align:center;font-size:11px">
          ${
            r.cpl === null
              ? "<span style='color:#8c939d'>-</span>"
              : r.cpl === 0
                ? `<span style="font-weight:bold;font-family:monospace;color:#fa383e">0 đ</span><br><small style="color:#8c939d">(0 HT)</small>`
                : `<span style="font-weight:bold;font-family:monospace;color:#31a24c">${money(r.cpl)} đ</span><br><small style="color:#31a24c">(${money(r.inboxCount)} HT)</small>`
          }
        </td>
        <td style="color:#0e7490;font-weight:bold;font-family:monospace;text-align:right">${money(r.cpcNum)} đ</td>
        <td style="color:#fa383e;font-weight:bold;font-family:monospace;text-align:right">${money(Math.floor(r.cpm))} đ</td>
        <td style="text-align:center">
          ${
            r.isPaused
              ? '<span style="background:#f0f2f5;color:#65676b;padding:3px 8px;border-radius:10px;font-size:10px;font-weight:bold;border:1px solid #ccd0d5">⏸️ ĐÃ TẮT</span>'
              : bad
                ? '<span style="background:#fdecea;color:#fa383e;padding:3px 8px;border-radius:10px;font-size:10px;font-weight:bold;border:1px solid #fa383e">⚠️ VƯỢT NGƯỠNG</span>'
                : '<span style="background:#e7f6ec;color:#1a7f37;padding:3px 8px;border-radius:10px;font-size:10px;font-weight:bold;border:1px solid #31a24c">✅ An toàn</span>'
          }
          <div style="font-size:10px;color:#8c939d;margin-top:2px">${money(lim.maxSpend)} | ${money(lim.maxPrice)} | ${money(lim.maxCpm)}</div>
        </td>
        <td>
          <div style="display:flex;gap:4px;align-items:center;justify-content:center">
            <input type="number" class="cc-lim-spend" placeholder="Tiền" style="width:62px" value="${lim.maxSpend}" />
            <input type="number" class="cc-lim-price" placeholder="Giá" style="width:70px" value="${lim.maxPrice}" />
            <input type="number" class="cc-lim-cpm" placeholder="CPM" style="width:62px" value="${lim.maxCpm}" />
            <button class="cc-btn-save" data-id="${esc(r.adsetId)}" style="padding:4px 8px;font-size:11px;cursor:pointer;background:#1877f2;color:#fff;border:none;border-radius:4px">Lưu</button>
          </div>
        </td>
      </tr>`;
      })
      .join("");

    // Thông báo số nhóm bị ẩn (đã tắt hoặc chiến dịch đã tắt)
    const info = $("ccHiddenInfo");
    if (info) {
      const pausedAdsets = state.rows.filter((r) => !r.error && r.isPaused).length;
      const pausedCampaigns = state.rows.filter(
        (r) => !r.error && !r.isPaused && !r.isCampaignActive,
      ).length;
      const parts = [];
      if (pausedAdsets) parts.push(`${pausedAdsets} nhóm đã tắt`);
      if (pausedCampaigns) parts.push(`${pausedCampaigns} nhóm thuộc chiến dịch đã tắt`);
      info.textContent = parts.length
        ? `🚫 Đang ẩn: ${parts.join(" · ")}`
        : "";
    }
  }

  function renderMonitoredTable() {
    const tb = $("ccMonBody");
    if (!tb) return;

    // Đếm số nhóm trong tiêu đề
    const cnt = $("ccMonCount");
    if (cnt) {
      cnt.textContent = state.monitored.length
        ? `${state.monitored.length} nhóm`
        : "";
    }

    if (!state.monitored.length) {
      tb.innerHTML =
        '<tr><td colspan="7" style="text-align:center;color:#65676b;padding:16px">Chưa có nhóm nào được giám sát.</td></tr>';
      return;
    }
    const rows = state.monitored.map((m) => {
      const live = state.rows.find(
        (r) => String(r.adsetId) === String(m.adsetId),
      );
      const spend = live ? live.spend : m.spend || 0;
      const price = live ? live.price : 0;
      const cpm = live ? live.cpm : 0;
      const bad = live ? isBreached(live) : false;
      // Đọc ngưỡng từ nguồn chung (localConfigs), fallback về bản sao trong state
      const lim = limitsFor(m.adsetId);
      const saved = m.limits || {};
      const limMaxSpend = lim.maxSpend || saved.maxSpend || 0;
      const limMaxPrice = lim.maxPrice || saved.maxPrice || 0;
      const limMaxCpm = lim.maxCpm || saved.maxCpm || 0;
      return `<tr>
        <td style="font-size:11px;color:#65676b">${esc(m.accountName || "-")}</td>
        <td style="color:#1877f2;font-size:12px;font-weight:bold">${esc(m.campaignName || "-")}</td>
        <td style="font-weight:bold;font-size:13px">${esc(m.name || "-")}
          <div style="font-size:10px;color:#8c939d;font-family:monospace">${esc(m.adsetId)}</div>
        </td>
        <td style="color:#d97706;font-weight:bold;font-family:monospace;text-align:right">${money(spend)} đ</td>
        <td style="color:#fa383e;font-weight:bold;font-family:monospace;text-align:right">${money(price)} đ</td>
        <td style="color:#fa383e;font-weight:bold;font-family:monospace;text-align:right">${money(Math.floor(cpm))} đ</td>
        <td style="text-align:center">
          ${
            bad
              ? '<span style="background:#fdecea;color:#fa383e;padding:3px 8px;border-radius:10px;font-size:10px;font-weight:bold;border:1px solid #fa383e">⚠️ VƯỢT NGƯỠNG</span>'
              : '<span style="background:#e7f6ec;color:#1a7f37;padding:3px 8px;border-radius:10px;font-size:10px;font-weight:bold;border:1px solid #31a24c">✅ An toàn</span>'
          }
          <div style="font-size:10px;color:#8c939d;margin-top:2px">${money(limMaxSpend)} | ${money(limMaxPrice)} | ${money(limMaxCpm)}</div>
        </td>
        <td>
          <button class="cc-btn-remove" data-id="${esc(m.adsetId)}" style="padding:4px 8px;font-size:11px;cursor:pointer;background:#fa383e;color:#fff;border:none;border-radius:4px">Bỏ giám sát</button>
          <button class="cc-btn-resume" data-id="${esc(m.adsetId)}" style="padding:4px 8px;font-size:11px;cursor:pointer;background:#31a24c;color:#fff;border:none;border-radius:4px;margin-top:3px">Bật lại</button>
        </td>
      </tr>`;
    });
    tb.innerHTML = rows.join("");
  }

  function renderAutoPausedTable() {
    const tb = $("ccPausedBody");
    if (!tb) return;

    // Đếm số nhóm trong tiêu đề
    const cnt = $("ccPausedCount");
    if (cnt) {
      cnt.textContent = state.autoPaused.length
        ? `${state.autoPaused.length} nhóm`
        : "";
    }

    if (!state.autoPaused.length) {
      tb.innerHTML =
        '<tr><td colspan="9" style="text-align:center;color:#65676b;padding:16px">Chưa có nhóm nào bị tắt tự động.</td></tr>';
      return;
    }
    tb.innerHTML = state.autoPaused
      .map(
        (p) => `<tr>
        <td style="font-size:11px;color:#65676b">${esc(p.accountName || "-")}</td>
        <td style="color:#1877f2;font-size:12px;font-weight:bold">${esc(p.campaignName || "-")}</td>
        <td style="font-weight:bold;font-size:13px">${esc(p.name || "-")}
          <div style="font-size:10px;color:#8c939d;font-family:monospace">${esc(p.adsetId)}</div>
        </td>
        <td style="color:#fa383e;font-weight:bold;font-family:monospace;text-align:right">${money(p.spend)} đ</td>
        <td style="color:#fa383e;font-weight:bold;font-family:monospace;text-align:right">${money(p.price)} đ</td>
        <td style="color:#fa383e;font-weight:bold;font-family:monospace;text-align:right">${money(Math.floor(p.cpm || 0))} đ</td>
        <td style="font-size:11px;color:#b45309">${esc(p.reason || "-")}</td>
        <td style="font-size:11px;color:#65676b">${esc(
          p.pausedAt ? new Date(p.pausedAt).toLocaleString("vi-VN") : "-",
        )}</td>
        <td style="text-align:center;white-space:nowrap">
          <button class="cc-btn-resume-paused" data-id="${esc(p.adsetId)}" title="Bật lại nhóm này trên Facebook" style="padding:4px 9px;font-size:11px;cursor:pointer;background:#31a24c;color:#fff;border:none;border-radius:4px;margin-right:4px">▶️ Bật lại</button>
          <button class="cc-btn-del-paused" data-id="${esc(p.adsetId)}" title="Xoá nhóm này khỏi danh sách đã tắt tự động" style="padding:4px 9px;font-size:11px;cursor:pointer;background:#fa383e;color:#fff;border:none;border-radius:4px">🗑️ Xoá</button>
        </td>
      </tr>`,
      )
      .join("");
  }

  function renderLogs() {
    const tb = $("ccLogBody");
    if (!tb) return;
    if (!state.logs.length) {
      tb.innerHTML =
        '<tr><td colspan="4" style="text-align:center;color:#65676b;padding:16px">Chưa có nhật ký.</td></tr>';
      return;
    }
    const typeMap = {
      auto_pause: ["#fa383e", "TẮT NHÓM"],
      auto_resume: ["#31a24c", "BẬT LẠI"],
      manual_pause: ["#f56b2a", "TẮT TAY"],
      manual_resume: ["#31a24c", "BẬT TAY"],
      error: ["#f56b2a", "LỖI"],
      info: ["#1877f2", "THÔNG TIN"],
    };
    tb.innerHTML = state.logs
      .slice(0, MAX_LOGS)
      .map((l) => {
        const m = typeMap[l.type] || ["#65676b", l.type];
        return `<tr>
        <td style="font-size:11px;color:#65676b">${esc(
          new Date(l.createdAt).toLocaleString("vi-VN"),
        )}</td>
        <td style="text-align:center"><span style="background:${m[0]}22;color:${m[0]};padding:2px 7px;border-radius:9px;font-size:10px;font-weight:bold">${esc(m[1])}</span></td>
        <td style="font-size:12px;font-weight:bold">${esc(l.adsetName || "-")}</td>
        <td style="font-size:12px;color:#475569">${esc(l.message || "")}</td>
      </tr>`;
      })
      .join("");
  }

  function renderAll() {
    renderStatCards();
    renderRowsTable();
    renderMonitoredTable();
    renderAutoPausedTable();
    renderLogs();
    renderRunningState();
  }

  // Cầu nối: gọi từ dashboard.js khi ngưỡng trong localConfigs thay đổi
  // để cột "NGƯỠNG RIÊNG" của bảng Tắt Camp cập nhật ngay.
  window.careCampRefreshThresholds = function () {
    try {
      renderAll();
    } catch (e) {
      console.warn("careCampRefreshThresholds:", e);
    }
  };

  function renderRunningState() {
    const btnStart = $("ccBtnStart");
    const btnStop = $("ccBtnStop");
    if (btnStart) btnStart.style.display = state.running ? "none" : "block";
    if (btnStop) btnStop.style.display = state.running ? "block" : "none";
    const tag = $("ccRunningTag");
    if (tag) {
      tag.textContent = state.running
        ? `🟢 ĐANG GIÁM SÁT (${state.monitored.length} nhóm)`
        : "⚪ ĐÃ DỪNG";
      tag.style.background = state.running ? "#e7f6ec" : "#f0f2f5";
      tag.style.color = state.running ? "#1a7f37" : "#65676b";
    }
    const sw = $("ccAutoScan");
    if (sw) sw.checked = state.autoScan;
  }

  /* --------------------------------- Hành động ---------------------------- */
  async function doLoadAdsets() {
    const token = getToken();
    const ids = getAccountIds();
    if (!token) return toast("❌ Chưa có Access Token. Lấy token ở trang Bảng Chỉ Số rồi quay lại.", "err");
    if (!ids.length) return toast("❌ Vui lòng nhập ít nhất 1 ID tài khoản quảng cáo.", "err");

    const btn = $("ccBtnLoad");
    btn.disabled = true;
    btn.innerText = "⏳ Đang tải...";
    $("ccLoading").style.display = "block";
    try {
      const rows = await fetchAdsets(token, ids);
      state.rows = rows;
      const errs = rows.filter((r) => r.error);
      renderAll();
      if (errs.length) {
        toast(
          `⚠️ Không đọc được ${errs.length}/${rows.length} tài khoản — ${errs[0].errorMsg}`,
          "err",
        );
      } else {
        toast(
          `✅ Đã tải ${rows.length} nhóm ACTIVE (${rows.filter((r) => r.delivering).length} đang phân phối).`,
          "ok",
        );
      }
      await saveState(true);
    } catch (e) {
      toast("❌ " + (e?.message || e), "err");
    } finally {
      btn.disabled = false;
      btn.innerText = "🔄 1. TẢI DANH SÁCH NHÓM ĐANG CHẠY";
      $("ccLoading").style.display = "none";
    }
  }

  async function doStartMonitoring() {
    const checked = Array.from(
      document.querySelectorAll("#ccTableBody .cc-check:checked"),
    ).map((c) => c.value);
    if (!checked.length) return toast("❌ Hãy tick ít nhất 1 nhóm quảng cáo.", "err");

    const s = state.settings;
    const list = checked.map((adsetId) => {
      const row = state.rows.find((r) => String(r.adsetId) === String(adsetId));
      const rowEl = document.querySelector(
        `#ccTableBody input.cc-check[value="${CSS.escape(adsetId)}"]`,
      );
      const tr = rowEl ? rowEl.closest("tr") : null;
      // Ưu tiên giá trị đang hiển thị trong ô input (render từ nguồn chung),
      // nhưng KHÔNG ghi đè config đã bị nâng tự động nếu người dùng không sửa.
      const inpSpend = tr?.querySelector(".cc-lim-spend")?.value;
      const inpPrice = tr?.querySelector(".cc-lim-price")?.value;
      const inpCpm = tr?.querySelector(".cc-lim-cpm")?.value;
      const existing = readConfigs()[String(adsetId)] || {};
      const lim = {
        maxSpend: num(inpSpend, num(existing.maxSpend, s.maxSpend)),
        maxPrice: num(inpPrice, num(existing.maxPrice, s.maxPrice)),
        maxCpm: num(inpCpm, num(existing.maxCpm, s.maxCpm)),
      };
      // Ghi ngưỡng vào nguồn cấu hình chung để bảng Chỉ Số thấy giống
      saveConfigFor(adsetId, lim.maxSpend, lim.maxPrice, lim.maxCpm);
      return {
        adsetId: String(adsetId),
        accountId: row?.accountId || "",
        accountName: row?.accountName || "",
        name: row?.name || "",
        campaignName: row?.campaignName || "",
        campaignId: row?.campaignId || "",
        limits: lim,
      };
    });

    state.monitored = list;
    state.running = true;
    await saveState(true);
    renderAll();
    startTimer();
    toast(`🚀 Đang giám sát ${list.length} nhóm.`, "ok");
    doScan(true);
  }

  async function doStopMonitoring() {
    state.running = false;
    state.monitored = [];
    await saveState(true);
    stopTimer();
    renderAll();
    toast("🛑 Đã dừng giám sát và xoá danh sách nhóm theo dõi.", "ok");
  }

  /**
   * Nâng ngưỡng MAXSPEND tự động — dùng chung nguồn cấu hình
   * localStorage["fb_local_configs"] với bảng Chỉ Số / Auto-Pause.
   *
   * Công thức (giống dashboard.js):
   *   maxSpend mới = maxSpend cũ + maxPrice × (số KQ tăng thêm)
   *
   * Số KQ dùng để so sánh là "effective count" đã tính sẵn trong fetchAdsets:
   *   - Bật CPC → click link
   *   - Bật CPL → hội thoại inbox
   *   - Mặc định → kết quả QC (actions)
   *
   * Dùng chung window.raiseThresholdForAdset() + window.prevHieuQua của
   * dashboard.js → mỗi lần KQ tăng chỉ nâng ngưỡng ĐÚNG 1 LẦN, không nhân đôi
   * khi cả bảng Chỉ Số và bảng Tắt Camp cùng quét.
   */
  function raiseThresholds(rows) {
    if (typeof window.raiseThresholdForAdset !== "function") return false;
    let changed = false;

    for (const row of rows.filter((r) => !r.error)) {
      const g = state.settings;
      const res = window.raiseThresholdForAdset(row.adsetId, row.resultCount || 0, {
        maxSpend: g.maxSpend,
        maxPrice: g.maxPrice,
        maxCpm: g.maxCpm,
      });
      if (res?.raised) {
        changed = true;
        console.log(
          `🚀 [CARE CAMP] Nâng ngưỡng nhóm ${row.name}: ${res.currentMaxSpend}đ -> ${res.newMaxSpend}đ (+${res.diff} KQ)`,
        );
      }
    }

    if (changed && typeof window.careCampRefreshThresholds === "function") {
      window.careCampRefreshThresholds();
    }
    return changed;
  }

  /**
   * Có nhóm nào cần thực sự giám sát không?
   *
   * Quét chỉ có 2 việc:
   *   1. TẮT nhóm vượt ngưỡng  → chỉ xét nhóm trong state.monitored
   *   2. BẬT LẠI nhóm đã tắt   → chỉ xét nhóm trong state.autoPaused
   * Nếu CẢ HAI danh sách đều rỗng thì không có gì để làm → bỏ qua,
   * không gọi API Meta (tiết kiệm 2 request/tài khoản mỗi lần quét).
   */
  function hasMonitoredWork() {
    return state.monitored.length > 0 || state.autoPaused.length > 0;
  }

  /** Quét & tự động tắt/bật lại nhóm vượt ngưỡng */
  async function doScan(silent = false) {
    const token = getToken();
    const ids = getAccountIds();
    if (!token || !ids.length) {
      if (!silent) toast("❌ Thiếu token hoặc ID tài khoản.", "err");
      return;
    }

    // ⚡ CHỈ QUÉT KHI THỰC SỰ CÓ NHÓM ĐANG GIÁM SÁT
    //    Không có nhóm theo dõi VÀ không có nhóm đã tắt tự động → bỏ qua
    //    lần quét này (không gọi API) để không tốn request vô ích.
    if (!hasMonitoredWork()) {
      if (!silent) {
        toast(
          "ℹ️ Chưa có nhóm nào đang giám sát — bỏ qua lần quét (không tốn API).",
          "info",
        );
      }
      return;
    }

    const btn = $("ccBtnScan");
    if (btn) {
      btn.disabled = true;
      btn.innerText = "⏳ Đang quét...";
    }

    try {
      // 0. SANG NGÀY MỚI → xoá danh sách nhóm đã tắt tự động của hôm trước,
      //    KHÔNG bật lại (chỉ số ngày mới đã reset về 0 nên không có nghĩa
      //    nhóm đó còn vượt ngưỡng).
      rolloverDayIfNeeded();

      const rows = await fetchAdsets(token, ids);
      state.rows = rows;
      let paused = 0;
      let resumed = 0;

      // 0. NÂNG NGƯỠNG TỰ ĐỘNG (dùng chung localConfigs với bảng Chỉ Số)
      //    Khi số kết quả (hội thoại inbox / click / CPR) tăng so với lần quét
      //    trước → maxSpend += maxPrice * (số KQ tăng thêm).
      raiseThresholds(rows);

      // 1. Tắt nhóm đang giám sát vượt ngưỡng
      //    Bỏ qua nhóm thuộc chiến dịch đã tắt (không thể tắt con của chiến dịch tắt)
      for (const row of rows.filter((r) => !r.error)) {
        const m = state.monitored.find(
          (x) => String(x.adsetId) === String(row.adsetId),
        );
        if (!m) continue;
        if (row.isPaused) continue; // đã tắt rồi
        if (!row.isCampaignActive) continue; // chiến dịch đã tắt
        if (!isBreached(row)) continue;

        const res = await setAdsetStatus(token, row.adsetId, "PAUSED");
        if (res.success) {
          paused++;
          const reason = `Tiêu ${money(row.spend)} > ${money(limitsFor(row.adsetId).maxSpend)} · Giá ${money(row.price)} > ${money(limitsFor(row.adsetId).maxPrice)} · CPM ${money(Math.floor(row.cpm))} > ${money(limitsFor(row.adsetId).maxCpm)}`;
          state.autoPaused.unshift({
            adsetId: row.adsetId,
            accountId: row.accountId,
            accountName: row.accountName,
            name: row.name,
            campaignName: row.campaignName,
            spend: row.spend,
            price: row.price,
            cpm: row.cpm,
            result: row.resultCount,
            resultLabel: row.resultLabel,
            maxSpend: limitsFor(row.adsetId).maxSpend,
            maxPrice: limitsFor(row.adsetId).maxPrice,
            maxCpm: limitsFor(row.adsetId).maxCpm,
            reason,
            pausedAt: Date.now(),
            dayStamp: state.dayStamp || dayKey(),
          });
          state.autoPaused = state.autoPaused.slice(0, MAX_AUTO_PAUSED);
          state.monitored = state.monitored.filter(
            (x) => String(x.adsetId) !== String(row.adsetId),
          );
          pushLog(
            "auto_pause",
            row.name,
            row.campaignName,
            `Tự động tắt — ${reason}`,
          );
        } else {
          pushLog(
            "error",
            row.name,
            row.campaignName,
            `Không tắt được: ${res?.error?.message || "unknown"}`,
          );
        }
      }

      // 2. Bật lại nhóm đã tắt tự động khi chỉ số đã trở lại trong ngưỡng
      //    Nhóm đã tắt vẫn có insights hôm nay nên vẫn đọc được chỉ số.
      //    Điều kiện bật lại: đã có KQ mới (giá giảm về ngưỡng) HOẶC CPM đã
      //    tụt xuống dưới ngưỡng.
      for (const p of [...state.autoPaused]) {
        const row = rows.find((r) => String(r.adsetId) === String(p.adsetId));
        if (!row || row.error) continue; // không còn đọc được -> giữ nguyên trạng thái tắt
        // Chiến dịch cha đã tắt -> không bật lại con (sẽ bật khi bật lại chiến dịch)
        if (!row.isCampaignActive) continue;

        // Mốc ngưỡng = ngưỡng CŨ lúc mới tắt (p.maxSpend / p.maxPrice / p.maxCpm)
        const baseLim = {
          maxSpend: p.maxSpend || state.settings.maxSpend,
          maxPrice: p.maxPrice || state.settings.maxPrice,
          maxCpm: p.maxCpm || state.settings.maxCpm,
        };
        const prevResult = Number(p.result || 0);
        const newResults = Math.max(0, row.resultCount - prevResult);
        const newPrice =
          row.resultCount > 0 ? Math.round(row.spend / row.resultCount) : Infinity;

        // NÂNG NGƯỠNG TỔNG CHI TIÊU theo số KẾT QUẢ MỚI phát sinh trong lúc bị tắt:
        //   maxSpend mới = maxSpend lúc tắt + maxPrice × (số KQ mới)
        // Lấy MAX với ngưỡng đang lưu ở nguồn cấu hình chung (bảng Chỉ Số cũng
        // tự nâng ngưỡng) để KHÔNG BAO GIỜ làm ngưỡng bị hạ xuống.
        const sharedMaxSpend = limitsFor(p.adsetId).maxSpend || 0;
        const newMaxSpend = Math.max(
          baseLim.maxSpend + baseLim.maxPrice * newResults,
          sharedMaxSpend,
        );
        // Điều kiện bật lại:
        //   - priceOk: đã có KQ mới và giá mới <= ngưỡng giá
        //   - cpmOk  : CPM đã tụt xuống dưới ngưỡng CPM
        //   - spendOk: tổng chi tiêu <= ngưỡng tiêu MỚI (đã nâng theo KQ mới)
        const priceOk = newResults > 0 && newPrice <= baseLim.maxPrice;
        const cpmOk = row.cpm <= baseLim.maxCpm;
        const spendOk = row.spend <= newMaxSpend;
        if (!(priceOk || cpmOk || spendOk)) continue;

        const res = await setAdsetStatus(token, p.adsetId, "ACTIVE");
        if (res.success) {
          resumed++;
          state.autoPaused = state.autoPaused.filter(
            (x) => String(x.adsetId) !== String(p.adsetId),
          );

          // Ngưỡng MỚI áp dụng cho nhóm sau khi bật lại
          const lim = {
            maxSpend: newMaxSpend,
            maxPrice: baseLim.maxPrice,
            maxCpm: baseLim.maxCpm,
          };

          // Ghi ngưỡng mới vào nguồn cấu hình chung (đồng bộ bảng Chỉ Số)
          saveConfigFor(p.adsetId, lim.maxSpend, lim.maxPrice, lim.maxCpm);

          // BẬT LẠI XONG → thêm lại vào bảng GIÁM SÁT để tiếp tục theo dõi.
          // Nếu chỉ số lại vượt ngưỡng ở lần quét kế tiếp → sẽ bị tắt tiếp.
          addToMonitored(
            {
              adsetId: p.adsetId,
              accountId: row.accountId || p.accountId,
              accountName: row.accountName || p.accountName,
              name: row.name || p.name,
              campaignName: row.campaignName || p.campaignName,
              campaignId: row.campaignId || "",
            },
            lim,
          );

          // Đồng bộ mốc đếm KQ dùng chung (window.prevHieuQua) để lần quét sau
          // KHÔNG nâng ngưỡng thêm cho các KQ đã tính ở lần này.
          if (window.prevHieuQua) {
            window.prevHieuQua[String(p.adsetId)] = row.resultCount;
          }
          if (typeof window.careCampRefreshThresholds === "function") {
            window.careCampRefreshThresholds();
          }

          // Đồng bộ trạng thái trong bộ nhớ (nhóm đã không còn PAUSED)
          row.isPaused = false;
          row.effectiveStatus = "ACTIVE";
          // Đảm bảo có tiến trình quét để nhóm vừa bật lại được giám sát lại
          if (!state.running) {
            state.running = true;
            startTimer();
          }
          pushLog(
            "auto_resume",
            p.name,
            p.campaignName,
            `Đã bật lại — chỉ số đã trở lại trong ngưỡng (giá mới ${money(newPrice)} đ, CPM ${money(Math.floor(row.cpm))} đ). ` +
              `Nâng ngưỡng tiêu ${money(baseLim.maxSpend)} đ → ${money(newMaxSpend)} đ (+${newResults} KQ mới). Đã thêm lại vào bảng giám sát.`,
          );
        }
      }

      await saveState();
      renderAll();
      if (!silent) {
        toast(
          `✅ Quét xong — tắt ${paused} nhóm, bật lại ${resumed} nhóm.`,
          "ok",
        );
      }
    } catch (e) {
      pushLog("error", "-", "", "Lỗi quét: " + (e?.message || e));
      await saveState();
      if (!silent) toast("❌ " + (e?.message || e), "err");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerText = "⚡ QUÉT & TẮT NGAY";
      }
    }
  }

  async function doResumeAdset(adsetId) {
    const token = getToken();
    if (!token) return toast("❌ Chưa có Access Token.", "err");
    const btn = document.querySelector(
      `.cc-btn-resume-paused[data-id="${CSS.escape(String(adsetId))}"]`,
    );
    if (btn) {
      btn.disabled = true;
      btn.innerText = "⏳ Đang bật...";
    }
    try {
      const res = await setAdsetStatus(token, adsetId, "ACTIVE");
      if (res.success) {
        const p = state.autoPaused.find(
          (x) => String(x.adsetId) === String(adsetId),
        );
        state.autoPaused = state.autoPaused.filter(
          (x) => String(x.adsetId) !== String(adsetId),
        );
        // Cập nhật lại trạng thái trong bộ nhớ cho đúng (không còn PAUSED)
        const row = state.rows.find(
          (r) => String(r.adsetId) === String(adsetId),
        );
        if (row) {
          row.isPaused = false;
          row.effectiveStatus = "ACTIVE";
        }
        pushLog(
          "manual_resume",
          p?.name || adsetId,
          p?.campaignName || "",
          "Bật lại thủ công từ danh sách nhóm đã tắt tự động",
        );
        await saveState(true);
        renderAll();
        toast(
          `✅ Đã bật lại nhóm "${p?.name || adsetId}". Nhóm sẽ hiện lại ở bảng nhóm đang bật.`,
          "ok",
        );
      } else {
        toast("❌ " + (res?.error?.message || "Không bật lại được"), "err");
        if (btn) {
          btn.disabled = false;
          btn.innerText = "▶️ Bật lại";
        }
      }
    } catch (e) {
      toast("❌ " + (e?.message || e), "err");
      if (btn) {
        btn.disabled = false;
        btn.innerText = "▶️ Bật lại";
      }
    }
  }

  function saveRowLimits(adsetId, btn) {
    const tr = btn.closest("tr");
    const maxSpend = num(tr.querySelector(".cc-lim-spend")?.value, 0);
    const maxPrice = num(tr.querySelector(".cc-lim-price")?.value, 0);
    const maxCpm = num(tr.querySelector(".cc-lim-cpm")?.value, 0);

    // 1. Ghi vào nguồn cấu hình chung (localStorage["fb_local_configs"])
    saveConfigFor(adsetId, maxSpend, maxPrice, maxCpm);

    // 2. Đồng bộ bản sao trong state.monitored (để tương thích dữ liệu cũ)
    let m = state.monitored.find((x) => String(x.adsetId) === String(adsetId));
    if (!m) {
      const row = state.rows.find((r) => String(r.adsetId) === String(adsetId));
      m = {
        adsetId: String(adsetId),
        accountId: row?.accountId || "",
        accountName: row?.accountName || "",
        name: row?.name || "",
        campaignName: row?.campaignName || "",
        limits: { maxSpend, maxPrice, maxCpm },
      };
      state.monitored.push(m);
    } else {
      m.limits = { maxSpend, maxPrice, maxCpm };
    }
    saveState(true);
    btn.innerText = "✅ Đã lưu";
    setTimeout(() => (btn.innerText = "Lưu"), 1500);
    renderAll();
  }

  /* --------------------- Xoá nhóm đã tắt tự động --------------------- */
  /** Xoá 1 nhóm khỏi danh sách "đã tắt tự động" (KHÔNG bật lại nhóm trên Facebook) */
  async function removeAutoPaused(adsetId) {
    const p = state.autoPaused.find((x) => String(x.adsetId) === String(adsetId));
    if (!p) return;
    state.autoPaused = state.autoPaused.filter(
      (x) => String(x.adsetId) !== String(adsetId),
    );
    pushLog(
      "info",
      p.name,
      p.campaignName,
      "Đã xoá khỏi danh sách nhóm tắt tự động (nhóm vẫn đang tắt trên Facebook)",
    );
    await saveState(true);
    renderAll();
    toast(`🗑️ Đã xoá "${p.name || adsetId}" khỏi danh sách tắt tự động.`, "ok");
  }

  /** Xoá toàn bộ danh sách "đã tắt tự động" */
  async function clearAllAutoPaused() {
    if (!state.autoPaused.length) {
      toast("ℹ️ Danh sách nhóm đã tắt tự động đang trống.", "info");
      return;
    }
    const n = state.autoPaused.length;
    const ok = window.confirm(
      `Xoá toàn bộ ${n} nhóm khỏi danh sách "đã tắt tự động"?\n\n` +
        `⚠️ Lưu ý: các nhóm này VẪN ĐANG TẮT trên Facebook.\n` +
        `Thao tác này chỉ xoá lịch sử theo dõi trong extension.`,
    );
    if (!ok) return;
    state.autoPaused = [];
    pushLog("info", "-", "", `Đã xoá toàn bộ ${n} nhóm khỏi danh sách tắt tự động`);
    await saveState(true);
    renderAll();
    toast(`🗑️ Đã xoá ${n} nhóm khỏi danh sách tắt tự động.`, "ok");
  }

  /** Xoá toàn bộ nhóm đang theo dõi (dừng giám sát + xoá danh sách) */
  async function clearAllMonitored() {
    if (!state.monitored.length) {
      toast("ℹ️ Chưa có nhóm nào đang được giám sát.", "info");
      return;
    }
    const n = state.monitored.length;
    const ok = window.confirm(
      `Xoá toàn bộ ${n} nhóm khỏi danh sách đang theo dõi?\n\n` +
        `⚠️ Hệ thống sẽ DỪNG tự động tắt các nhóm này.\n` +
        `(Các nhóm không bị tắt trên Facebook.)`,
    );
    if (!ok) return;
    state.monitored = [];
    state.running = false;
    stopTimer();
    pushLog("info", "-", "", `Đã xoá toàn bộ ${n} nhóm đang theo dõi và dừng giám sát`);
    await saveState(true);
    renderAll();
    toast(`🗑️ Đã xoá ${n} nhóm đang theo dõi và dừng giám sát.`, "ok");
  }

  /* ------------------------------ Timer quét ------------------------------ */
  function startTimer() {
    stopTimer();
    state.timer = setInterval(() => {
      if (!state.running || !state.autoScan) return;
      // ⚡ Không có nhóm nào cần theo dõi → bỏ qua, không gọi API
      if (!hasMonitoredWork()) return;
      doScan(true);
    }, SCAN_INTERVAL_MS);
  }
  function stopTimer() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  /* ------------------------------- Khởi tạo ------------------------------ */
  async function init() {
    await loadState();

    // Khôi phục ngưỡng chung — ưu tiên giá trị đang có ở bảng Auto-Pause (apMax*)
    // để 2 bảng luôn dùng chung 1 bộ ngưỡng chung.
    $("ccMaxSpend").value = readGlobalThreshold(
      "maxSpend",
      state.settings.maxSpend,
    );
    $("ccMaxPrice").value = readGlobalThreshold(
      "maxPrice",
      state.settings.maxPrice,
    );
    $("ccMaxCpm").value = readGlobalThreshold("maxCpm", state.settings.maxCpm);
    state.settings.maxSpend = num($("ccMaxSpend").value, 10000);
    state.settings.maxPrice = num($("ccMaxPrice").value, 12000);
    state.settings.maxCpm = num($("ccMaxCpm").value, 50000);
    // Cờ chế độ CPL/CPC: ưu tiên giá trị đã lưu ở bảng Auto-Pause
    const apCplEl = $("apUseCpl");
    const apCpcEl = $("apUseCpc");
    state.settings.useCpl = apCplEl
      ? apCplEl.checked
      : !!state.settings.useCpl;
    state.settings.useCpc = apCpcEl
      ? apCpcEl.checked
      : !!state.settings.useCpc;
    $("ccUseCpl").checked = state.settings.useCpl;
    $("ccUseCpc").checked = state.settings.useCpc;
    $("ccAutoScan").checked = state.autoScan;

    $("ccBtnLoad")?.addEventListener("click", doLoadAdsets);
    $("ccBtnStart")?.addEventListener("click", doStartMonitoring);
    $("ccBtnStop")?.addEventListener("click", doStopMonitoring);
    $("ccBtnScan")?.addEventListener("click", () => doScan(false));
    $("ccBtnRescan")?.addEventListener("click", () => doScan(false));
    $("ccSelectAll")?.addEventListener("change", (e) => {
      document
        .querySelectorAll("#ccTableBody .cc-check")
        .forEach((cb) => (cb.checked = e.target.checked));
    });

    // Lưu ngưỡng chung khi thay đổi (đồng bộ 2 chiều với bảng Auto-Pause)
    const persistSettings = async () => {
      state.settings.maxSpend = num($("ccMaxSpend").value, 10000);
      state.settings.maxPrice = num($("ccMaxPrice").value, 12000);
      state.settings.maxCpm = num($("ccMaxCpm").value, 50000);
      state.settings.useCpl = !!$("ccUseCpl").checked;
      state.settings.useCpc = !!$("ccUseCpc").checked;
      // Đồng bộ sang bảng Auto-Pause
      syncGlobalThreshold("maxSpend", state.settings.maxSpend);
      syncGlobalThreshold("maxPrice", state.settings.maxPrice);
      syncGlobalThreshold("maxCpm", state.settings.maxCpm);
      await saveState(true);
      renderAll();
    };
    ["ccMaxSpend", "ccMaxPrice", "ccMaxCpm"].forEach((id) =>
      $(id)?.addEventListener("change", persistSettings),
    );
    $("ccUseCpl")?.addEventListener("change", persistSettings);
    $("ccUseCpc")?.addEventListener("change", persistSettings);
    $("ccAutoScan")?.addEventListener("change", async (e) => {
      state.autoScan = e.target.checked;
      await saveState(true);
    });

    // Đồng bộ cờ chế độ CPL/CPC sang bảng Auto-Pause (2 chiều)
    const syncModeFlags = () => {
      const apCpl = document.getElementById("apUseCpl");
      const apCpc = document.getElementById("apUseCpc");
      if (apCpl && apCpl.checked !== !!$("ccUseCpl")?.checked) {
        apCpl.checked = !!$("ccUseCpl")?.checked;
        apCpl.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (apCpc && apCpc.checked !== !!$("ccUseCpc")?.checked) {
        apCpc.checked = !!$("ccUseCpc")?.checked;
        apCpc.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };
    $("ccUseCpl")?.addEventListener("change", syncModeFlags);
    $("ccUseCpc")?.addEventListener("change", syncModeFlags);
    syncModeFlags();

    // Nút trong bảng (dùng event delegation)
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (t.classList?.contains("cc-btn-save")) {
        saveRowLimits(t.getAttribute("data-id"), t);
      } else if (t.classList?.contains("cc-btn-remove")) {
        const id = t.getAttribute("data-id");
        state.monitored = state.monitored.filter(
          (x) => String(x.adsetId) !== String(id),
        );
        saveState(true);
        renderAll();
      } else if (t.classList?.contains("cc-btn-resume")) {
        doResumeAdset(t.getAttribute("data-id"));
      } else if (t.classList?.contains("cc-btn-del-paused")) {
        removeAutoPaused(t.getAttribute("data-id"));
      } else if (t.classList?.contains("cc-btn-resume-paused")) {
        doResumeAdset(t.getAttribute("data-id"));
      }
    });

    // Nút xoá toàn bộ danh sách nhóm đã tắt tự động
    $("ccBtnClearPaused")?.addEventListener("click", clearAllAutoPaused);
    // Nút xoá toàn bộ nhóm đang theo dõi
    $("ccBtnClearMonitored")?.addEventListener("click", clearAllMonitored);

    // Khi bấm menu ✂️ → đồng bộ token/ID từ trang Bảng Chỉ Số
    document.getElementById("nav-carecamp")?.addEventListener("click", () => {
      const ti = $("tokenInput");
      if (ti && ti.value) {
        window.__ccToken = ti.value.trim();
        const ct = $("ccTokenInput");
        if (ct && !ct.value.trim()) ct.value = ti.value.trim();
      }
      const ii = $("idInput");
      const ci = $("ccIdsInput");
      if (ii && ci && !ci.value.trim() && ii.value.trim()) ci.value = ii.value.trim();
      renderAll();
    });

    renderAll();
    if (state.running) startTimer();

    // Ghi nốt lô đang chờ khi người dùng đóng tab / chuyển tab
    // (debounce 3 phút có thể chưa tới hạn → ghi ngay để không mất dữ liệu)
    window.addEventListener("beforeunload", () => {
      flushSave();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushSave();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
