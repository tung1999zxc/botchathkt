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
  const KEY_PREV = "camp_core_prev"; // mốc đếm KQ (G) — nguồn nâng ngưỡng (legacy)
  const KEY_CONFIGS = "fb_local_configs"; // ngưỡng từng nhóm (nguồn chuẩn)
  const KEY_CC_STATE = "cc_camp_state"; // state của care_camp.js (monitored/autoPaused)
  const KEY_AUTO_PAUSE = "camp_core_auto_pause"; // Auto-Pause (bảng trong dashboard)
  const KEY_ALARM = "camp-core-scan";
  // (I) Khoá ngày RIÊNG cho cơ chế "sang ngày mới" (reset mốc so sánh +
  // đưa ngưỡng riêng từng nhóm về ngưỡng chung).
  //
  // ⚠️ KHÔNG dùng "cc_camp_state.dayStamp" cho việc này: care_camp.js cũng
  //    ghi vào đó (state.dayStamp = dayKey()) → nếu tab dashboard mở qua đêm
  //    thì dayStamp đã bị cập nhật sang ngày mới TRƯỚC khi background kịp
  //    quét → background sẽ KHÔNG phát hiện sang ngày mới → không reset mốc.
  //    Key riêng này chỉ do background (runScan) ghi → luôn đúng.
  const KEY_DAY = "camp_core_day";

  // (I) Khoá ngắn hạn khi nâng ngưỡng — chống việc background và UI
  //     realtime cùng nâng 1 lần KQ (đặc biệt vào đúng 00:00 khi sang
  //     ngày mới, mốc cũ = 0 → cả hai đều thấy diff > 0).
  const KEY_RAISE_LOCK = "camp_core_raise_lock";
  const RAISE_LOCK_TTL_MS = 15000; // coi lock cũ hơn 15s là stale → giành lại

  // (I) Field đánh dấu NGÀY của mốc so sánh, gắn trong từng map mốc.
  //     Giúp biết mốc đang lưu thuộc ngày nào → sang ngày mới thì coi
  //     mốc cũ = 0 (mà không cần xoá map).
  const PREV_DAY_FIELD = "__day";

  // (I) Cache khoá ngày trong RAM — tránh đọc storage mỗi lần nâng ngưỡng.
  //     "" = chưa biết (đọc storage lần đầu).
  let _dayCache = "";

  /* ------------------------------------------------------------------
   * (H) MỐC SO SÁNH TÁCH THEO KÊNH SỐ
   * ------------------------------------------------------------------
   * Trước đây mốc đếm chỉ có 1 map ("camp_core_prev") cho mọi chế độ →
   * khi đổi chế độ (Tin nhắn ↔ Inbox) số của chế độ cũ bị so với số
   * của chế độ mới → sinh "diff oan" và nâng ngưỡng sai.
   *
   * Nay mỗi kênh số có 1 map riêng:
   *   - "inbox"    : số hội thoại Inbox (chế độ CPL)
   *   - "messages" : số Tin nhắn (messaging_conversation_started của Meta)
   *   - "click"    : số Click Link (chế độ CPC)
   *   - "unknown"  : KHÔNG xác định được số → KHÔNG nâng ngưỡng, KHÔNG ghi mốc
   * ---------------------------------------------------------------- */
  const CHANNEL_INBOX = "inbox";
  const CHANNEL_MESSAGES = "messages";
  const CHANNEL_CLICK = "click";
  const CHANNEL_UNKNOWN = "unknown";

  const PREV_KEYS = {
    [CHANNEL_INBOX]: "camp_core_prev_inbox",
    [CHANNEL_MESSAGES]: "camp_core_prev_messages",
    [CHANNEL_CLICK]: "camp_core_prev_click",
  };

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

  /**
   * (H) Đọc mốc so sánh THEO KÊNH SỐ.
   *
   * @param {string} [channel] "inbox" | "messages" | "click"
   *   - Bỏ trống → trả về map LEGACY ("camp_core_prev") để tương thích.
   * @returns {Promise<object>} map { adsetId: soKQ } (KHÔNG kèm field "__day")
   */
  async function getPrevMap(channel) {
    const raw = await readPrevMapRaw(channel);
    const out = {};
    for (const k of Object.keys(raw)) {
      if (k === PREV_DAY_FIELD) continue;
      out[k] = raw[k];
    }
    return out;
  }

  /**
   * (I) Đọc map mốc RAW (bao gồm field "__day" đánh dấu ngày của mốc).
   * Dùng nội bộ để biết mốc thuộc ngày nào.
   */
  async function readPrevMapRaw(channel) {
    const key = channel ? PREV_KEYS[channel] : KEY_PREV;
    if (!key) return {};
    const res = await storageGet([key]);
    return res[key] && typeof res[key] === "object" ? res[key] : {};
  }

  /**
   * (I) Ngày của mốc so sánh đang lưu (đọc từ field "__day").
   * @returns {Promise<string>} YYYY-MM-DD ("" nếu map chưa có dấu ngày)
   */
  async function getPrevMapDay(channel) {
    const raw = await readPrevMapRaw(channel);
    return String(raw[PREV_DAY_FIELD] || "");
  }

  /**
   * (H) MIGRATION 1 LẦN — copy map legacy sang map của kênh khi map kênh
   * còn TRỐNG.
   *
   * Bối cảnh: trước khi tách kênh, mọi chế độ dùng chung map "camp_core_prev"
   * (chứa số "Tin nhắn" của Meta). Sau khi cập nhật extension, map kênh
   * "messages" / "click" sẽ trống → nếu không migrate, lần quét đầu tiên
   * coi mốc cũ = 0 và nâng ngưỡng theo TOÀN BỘ số KQ tích luỹ → ngưỡng
   * nhảy 1 lần rất lớn.
   *
   * ⚠️ KHÔNG migrate sang kênh "inbox" — vì mốc legacy là số "Tin nhắn",
   *    khác hoàn toàn số hội thoại Inbox. Kênh inbox dùng cơ chế "seed"
   *    (thiết lập mốc nền, không nâng) ở lần quan sát đầu tiên.
   *
   * @param {string} channel
   * @returns {Promise<boolean>} true nếu đã migrate
   */
  async function migrateLegacyPrevMap(channel) {
    if (!channel || channel === CHANNEL_INBOX) return false;
    const key = PREV_KEYS[channel];
    if (!key) return false;

    const res = await storageGet([key, KEY_PREV]);
    const current = res[key];
    // Map kênh đã có dữ liệu → không migrate (tránh ghi đè mốc đúng)
    if (current && typeof current === "object" && Object.keys(current).length) {
      return false;
    }
    const legacy = res[KEY_PREV];
    if (!legacy || typeof legacy !== "object" || !Object.keys(legacy).length) {
      return false;
    }

    // (I) Bỏ field "__day" khỏi bản copy rồi gắn lại dấu ngày HÔM NAY.
    //     Mốc legacy được "mượn" làm mốc nền của HÔM NAY (để tránh nhảy
    //     ngưỡng 1 lần rất lớn) → KHÔNG được coi là mốc của hôm qua.
    const copy = { ...legacy };
    delete copy[PREV_DAY_FIELD];
    copy[PREV_DAY_FIELD] = dayKey();
    await storageSet({ [key]: copy });
    console.log(
      `[CAMP CORE] ♻️ Đã migrate mốc so sánh legacy → kênh "${channel}" (${Object.keys(legacy).length} nhóm).`,
    );
    return true;
  }

  /**
   * (H) Ghi mốc so sánh THEO KÊNH SỐ.
   *
   * @param {object} map
   * @param {string} [channel]
   */
  async function setPrevMap(map, channel) {
    const key = channel ? PREV_KEYS[channel] : KEY_PREV;
    if (!key) return;
    const clean = { ...(map || {}) };
    // (I) Luôn gắn dấu ngày hiện tại → giúp phát hiện "mốc thuộc hôm qua"
    //     khi sang ngày mới (mốc cũ = 0).
    clean[PREV_DAY_FIELD] = dayKey();
    await storageSet({ [key]: clean });
  }

  /**
   * (H) Ghi 1 mốc so sánh cho 1 nhóm mà không cần đọc/ghi cả map.
   * Dùng khi cần ghi đè mốc cũ (VD sau khi bật lại nhóm) — tránh race
   * với các lần ghi map khác trong cùng 1 vòng quét.
   *
   * @param {string} adsetId
   * @param {number} value
   * @param {string} [channel]
   */
  async function setPrevForAdset(adsetId, value, channel) {
    const key = channel ? PREV_KEYS[channel] : KEY_PREV;
    if (!key) return;
    const raw = await readPrevMapRaw(channel);
    const map = {};
    for (const k of Object.keys(raw)) {
      if (k === PREV_DAY_FIELD) continue;
      map[k] = raw[k];
    }
    map[String(adsetId)] = num(value, 0);
    await setPrevMap(map, channel);
  }

  /**
   * Nâng ngưỡng MaxSpend cho 1 nhóm (dùng chung cho background & dashboard).
   *
   * @param {string} adsetId
   * @param {number} effectiveCount  số KQ hiện tại (hội thoại / click / CPR)
   * @param {object} opts { maxSpend, maxPrice, maxCpm, maxCpc, channel, readOnly }
   * @param {string} [opts.channel] Kênh số: "inbox" | "messages" | "click"
   *   - Bỏ trống → dùng map legacy ("camp_core_prev") (tương thích cũ).
   *   - "unknown" → KHÔNG nâng ngưỡng, KHÔNG ghi mốc (chỉ biết là chưa xác định).
   * @param {boolean} [opts.readOnly] CHẾ ĐỘ CHỈ ĐỌC:
   *   - KHÔNG nâng ngưỡng, KHÔNG ghi log nâng, KHÔNG gửi Telegram.
   *   - Nhóm CHƯA có mốc → ghi "mốc nền" = 0 (để lần quét thật sau coi
   *     mốc cũ = 0 và nâng theo toàn bộ KQ, giống hành vi sang ngày mới).
   *   - Nhóm ĐÃ có mốc → giữ nguyên mốc cũ (không ghi đè).
   * @returns {Promise<{raised:boolean, diff:number, currentMaxSpend:number, newMaxSpend:number}>}
   */
  async function raiseThresholdForAdset(adsetId, effectiveCount, opts = {}) {
    const id = String(adsetId);
    const globalMaxSpend = num(opts.maxSpend, 10000);
    const globalMaxPrice = num(opts.maxPrice, 12000);
    const globalMaxCpm = num(opts.maxCpm, 40000);
    const globalMaxCpc = num(opts.maxCpc, 800);
    const channel = opts.channel || "";

    // (H) Kênh "unknown" = KHÔNG xác định được số KQ (VD bật CPL nhưng
    //     cache inbox chưa sẵn sàng / nhóm không có tag [N1]).
    //     → BỎ QUA lần nâng ngưỡng này (chờ lần sau), KHÔNG ghi mốc
    //     để tránh "diff oan" khi dữ liệu về sau.
    if (channel === CHANNEL_UNKNOWN) {
      return {
        raised: false,
        diff: 0,
        skipped: true,
        currentMaxSpend: 0,
        newMaxSpend: 0,
        currentMaxPrice: globalMaxPrice,
        currentMaxCpm: globalMaxCpm,
        currentMaxCpc: globalMaxCpc,
      };
    }

    const configsIn = await getConfigs();

    // (I) AN TOÀN QUA NGÀY — nguồn quyết định DUY NHẤT là khoá ngày
    //     "camp_core_day" (chỉ background/UI qua camp_core.js ghi).
    //
    //   - lastDay === ""            → LẦN CHẠY ĐẦU: chỉ ghi nhận ngày,
    //                                  KHÔNG reset ngưỡng riêng (tránh xoá
    //                                  cấu hình user đã tự thiết lập).
    //   - lastDay === today         → trong ngày → dùng mốc bình thường.
    //   - lastDay !== today         → SANG NGÀY MỚI → coi mốc cũ = 0,
    //                                  reset ngưỡng riêng về ngưỡng chung.
    //
    //   Sau khi reset, mốc được XOÁ THẬT (không chỉ "coi = 0") để nhóm
    //   thứ 2, thứ 3... trong cùng vòng quét cũng thấy mốc rỗng → nâng
    //   đúng theo toàn bộ KQ của ngày mới.
    let prevReset = false;
    const today = dayKey();
    try {
      const lastDay = await getRolloverDay();
      if (!lastDay) {
        // ⭐ Lần chạy đầu tiên → chỉ ghi nhận ngày, không reset gì.
        await storageSet({ [KEY_DAY]: today });
        _dayCache = today;
        // Mốc legacy (không có dấu ngày) → coi là của hôm qua → xoá.
        const rawMap = await readPrevMapRaw(channel);
        const hasLegacy = Object.keys(rawMap).some(
          (k) => k !== PREV_DAY_FIELD,
        );
        if (hasLegacy && !rawMap[PREV_DAY_FIELD]) {
          await resetAllPrevMaps();
          prevReset = true;
        }
      } else if (lastDay !== today) {
        // 📅 SANG NGÀY MỚI
        await resetAllPrevMaps();
        prevReset = true;
        await resetConfigsToGlobal(opts);
        await storageSet({ [KEY_RAISE_LOCK]: {} });
        await storageSet({ [KEY_DAY]: today });
        _dayCache = today;
        console.log(
          `[CAMP CORE] 📅 Phát hiện sang ngày mới (${today}) — coi mốc cũ = 0 và đưa ngưỡng riêng về ngưỡng chung.`,
        );
      }
    } catch (e) {
      /* bỏ qua */
    }

    // (H) Migrate mốc legacy → map kênh (chỉ 1 lần, khi map kênh còn trống)
    //     ⚠️ CHẠY SAU bước kiểm tra ngày → nếu vừa sang ngày mới thì mốc
    //     đã bị xoá → không migrate mốc của HÔM QUA sang ngày mới.
    if (channel && !prevReset) {
      try {
        await migrateLegacyPrevMap(channel);
      } catch (e) {
        /* bỏ qua */
      }
    }

    // (I) Đọc LẠI cấu hình sau khi có thể đã reset về ngưỡng chung.
    const configs = prevReset ? await getConfigs() : configsIn;

    // (I) Đọc LẠI mốc sau khi có thể đã xoá (sang ngày mới).
    const prevMap = prevReset ? {} : await getPrevMap(channel);
    const cur = num(effectiveCount, 0);

    // (H) CHƯA CÓ MỐC SO SÁNH cho kênh này → coi mốc cũ = 0 và nâng
    //     ngưỡng theo toàn bộ số KQ hiện tại (giữ hành vi gốc).
    //     Lưu ý: mốc của mỗi kênh là RIÊNG, nên khi bật CPL lần đầu thì
    //     mốc kênh "inbox" chưa có → coi mốc cũ = 0 → nâng ngưỡng theo
    //     số hội thoại Inbox đang có. Từ lần quét sau chỉ nâng theo phần
    //     TĂNG THÊM của số hội thoại Inbox.
    //     (I) Sau khi sang ngày mới → mốc cũ = 0 → nâng theo toàn bộ KQ
    //     của ngày mới (giống hành vi "lần đầu bật CPL").
    const hasPrev = !prevReset && prevMap[id] !== undefined;
    const prev = hasPrev ? num(prevMap[id], 0) : 0;

    // (J) CHẾ ĐỘ CHỈ ĐỌC (readOnly) — dùng cho lần quét "xem chỉ số" khi
    //     user vừa chọn TKQC: KHÔNG nâng ngưỡng, KHÔNG gửi Telegram.
    //
    //     - Nhóm CHƯA có mốc → ghi "mốc nền" = 0.
    //       → Lần quét THẬT sau coi mốc cũ = 0 → nâng ngưỡng theo TOÀN BỘ
    //         KQ đang có (giống hành vi "sang ngày mới").
    //     - Nhóm ĐÃ có mốc → GIỮ NGUYÊN mốc cũ (không ghi đè), để lần
    //       quét thật sau vẫn thấy phần tăng và nâng đúng 1 lần.
    if (opts.readOnly) {
      if (!hasPrev) {
        prevMap[id] = 0;
        await setPrevMap(prevMap, channel);
        const curLocal = configs[id] || {};
        const curMaxSpend = num(curLocal.maxSpend, globalMaxSpend);
        return {
          raised: false,
          diff: 0,
          seeded: true,
          currentMaxSpend: curMaxSpend,
          newMaxSpend: curMaxSpend,
          currentMaxPrice: globalMaxPrice,
          currentMaxCpm: globalMaxCpm,
          currentMaxCpc: globalMaxCpc,
        };
      }
      // Đã có mốc → không đụng vào mốc, không nâng ngưỡng.
      const curLocal = configs[id] || {};
      const curMaxSpend = num(curLocal.maxSpend, globalMaxSpend);
      return {
        raised: false,
        diff: 0,
        readOnly: true,
        currentMaxSpend: curMaxSpend,
        newMaxSpend: curMaxSpend,
        currentMaxPrice: globalMaxPrice,
        currentMaxCpm: globalMaxCpm,
        currentMaxCpc: globalMaxCpc,
      };
    }

    // KQ không tăng (và đã có mốc) → không nâng
    if (hasPrev && cur <= prev) {
      prevMap[id] = cur;
      await setPrevMap(prevMap, channel);
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
      await setPrevMap(prevMap, channel);
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

    // (I) KHOÁ CHỐNG NÂNG 2 LẦN — background và UI realtime có thể chạy
    //     cùng lúc (đặc biệt đúng 00:00 khi sang ngày mới, mốc cũ = 0 →
    //     cả hai đều thấy diff > 0 → cả hai đều nâng).
    //     Dùng khoá lưu trong storage: ai giành được khoá thì mới nâng.
    const lockKey = `${channel || "legacy"}:${id}`;
    const lockRes = await storageGet([KEY_RAISE_LOCK]);
    const locks = lockRes[KEY_RAISE_LOCK] || {};
    const nowTs = Date.now();
    const myLock = locks[lockKey];
    if (myLock && nowTs - Number(myLock.ts || 0) < RAISE_LOCK_TTL_MS) {
      // Có người khác đang/đã nâng cho nhóm này → BỎ QUA (KHÔNG nâng 2 lần).
      // ⚠️ KHÔNG ghi mốc ở đây: người giữ khoá sẽ ghi mốc sau khi nâng xong.
      //    Nếu ta ghi mốc trước → lần nâng của người kia có thể bị bỏ sót.
      return {
        raised: false,
        diff: 0,
        locked: true,
        currentMaxSpend,
        newMaxSpend: currentMaxSpend,
        currentMaxPrice,
        currentMaxCpm,
        currentMaxCpc,
      };
    }
    // Giành khoá (ghi trước khi nâng để chặn lời gọi song song)
    locks[lockKey] = { ts: nowTs };
    await storageSet({ [KEY_RAISE_LOCK]: locks });

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
      // (I) Dấu ngày của lần nâng ngưỡng → dùng để biết ngưỡng đã được
      //     "đặt lại về ngưỡng chung" trong ngày hay chưa (idempotent).
      __day: today,
    };
    await setConfigs(configs);
    // ⚠️ Ghi mốc SAU khi đã lưu ngưỡng → nếu lời gọi song song bị khoá,
    //    lần sau sẽ thấy mốc = cur → không nâng lại (đúng 1 lần).
    prevMap[id] = cur;
    await setPrevMap(prevMap, channel);

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
   * ------------------------------------------------------------------
   * (H) Trả về thêm `raiseCount` + `channel` — SỐ DÙNG ĐỂ NÂNG NGƯỠNG:
   *   - "inbox"    : số hội thoại Inbox (chế độ CPL)
   *   - "click"    : số Click Link (chế độ CPC)
   *   - "messages" : số Tin nhắn của Meta insights (chế độ CPR/mặc định)
   *   - "unknown"  : KHÔNG xác định được số KQ đáng tin cậy
   *                  (VD bật CPL nhưng nhóm không có tag [N1] hoặc cache
   *                   inbox chưa sẵn sàng) → KHÔNG nâng ngưỡng, chờ lần sau.
   *
   * ⚠️ `count` / `label` (dùng cho HIỂN THỊ và tính giá) GIỮ NGUYÊN logic
   *    cũ — không thay đổi hành vi bảng.
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

    // Kênh số mặc định (không ở chế độ CPL) — suy ra từ nhãn đã chọn
    let channel = label === "Click Link" ? CHANNEL_CLICK : CHANNEL_MESSAGES;

    if (useCpcCombo) {
      if (useCpl && inboxCount != null) {
        count = inboxCount;
        label = "Hội thoại (Inbox)";
        channel = CHANNEL_INBOX;
      }
    } else if (useCpc) {
      if (metrics.inlineLinkClicks > 0) {
        count = metrics.inlineLinkClicks;
        label = "Click Link";
        channel = CHANNEL_CLICK;
      } else if (useCpl && inboxCount != null && inboxCount > 0) {
        count = inboxCount;
        label = "Hội thoại (Inbox)";
        channel = CHANNEL_INBOX;
      }
    } else if (useCpl && inboxCount != null) {
      count = inboxCount;
      label = "Hội thoại (Inbox)";
      channel = CHANNEL_INBOX;
    }

    // (H) Số dùng để NÂNG NGƯỠNG.
    //   - Bật CPL (đơn hoặc kết hợp CPC) → nguồn DUY NHẤT là Inbox.
    //     Không xác định được (không có tag [N1] / cache inbox chưa sẵn
    //     sàng) → channel = "unknown" → bỏ qua lần nâng ngưỡng này.
    //   - Còn lại → dùng đúng số đang hiển thị (Click Link / Tin nhắn).
    let raiseCount = count;
    if (useCpl) {
      if (inboxCount != null) {
        raiseCount = inboxCount;
        channel = CHANNEL_INBOX;
      } else {
        raiseCount = 0;
        channel = CHANNEL_UNKNOWN;
      }
    }

    return { count, label, raiseCount, channel };
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
          // (H) Số + kênh dùng để NÂNG NGƯỠNG (tách riêng số hiển thị)
          raiseCount: res.raiseCount,
          raiseChannel: res.channel,
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

  /* ------------------------------------------------------------------
   * (I) SANG NGÀY MỚI — RESET MỐC SO SÁNH + ĐƯA NGƯỠNG RIÊNG VỀ NGƯỠNG CHUNG
   * ------------------------------------------------------------------
   * VÌ SAO cần:
   *   Mốc so sánh (camp_core_prev_*) lưu SỐ KQ TÍCH LUỸ TRONG NGÀY, còn
   *   chỉ số Meta (date_preset(today)) và số hội thoại Inbox (msgTime >=
   *   00:00 hôm nay) RESET MỖI NGÀY. Nếu không reset mốc, sang ngày mới
   *   ta sẽ so số KQ hôm nay (bắt đầu lại từ 0) với số KQ tích luỹ của
   *   HÔM QUA → sai lệch:
   *     - Hôm nay ít hơn hôm qua → KHÔNG nâng ngưỡng dù có KQ mới.
   *     - Hôm nay nhiều hơn hôm qua → chỉ nâng theo PHẦN CHÊNH LỆCH.
   *
   * HÀNH VI MỚI (giống hành vi "lần đầu bật CPL"):
   *   Sang ngày mới → coi mốc cũ = 0 → lần quét đầu tiên của ngày mới
   *   sẽ nâng ngưỡng theo TOÀN BỘ số KQ hiện có (hội thoại Inbox / click /
   *   action của ngày mới).
   *
   * ĐỒNG THỜI reset ngưỡng riêng từng nhóm (fb_local_configs) về NGƯỠNG
   * CHUNG, vì ngưỡng riêng đã bị nâng dồn lên cả ngày qua → nếu giữ, ngày
   * mới nhóm sẽ được phép tiêu nhiều hơn hẳn so với thiết kế ban đầu.
   * ------------------------------------------------------------------ */

  /**
   * Đưa toàn bộ ngưỡng riêng từng nhóm về NGƯỠNG CHUNG.
   *
   * - `maxSpend` / `maxPrice` / `maxCpm` / `maxCpc` → về giá trị chung.
   * - `original*` cũng được đặt lại = giá trị chung (để nút "Reset" ở bảng
   *   Chỉ Số sau này vẫn trả về đúng ngưỡng chung).
   * - Nhóm KHÔNG có cấu hình riêng → xoá hẳn khỏi map (dùng ngưỡng chung).
   *
   * ⚠️ IDEMPOTENT: mỗi cấu hình được đánh dấu `__day` = ngày đã reset.
   *    Nếu đã reset hôm nay rồi → GIỮ NGUYÊN (tránh xoá nâng ngưỡng vừa
   *    thực hiện trong cùng ngày, ví dụ UI realtime nâng trước background).
   *
   * @param {object} globalCfg { maxSpend, maxPrice, maxCpm, maxCpc }
   * @returns {Promise<number>} số nhóm đã bị reset
   */
  async function resetConfigsToGlobal(globalCfg = {}) {
    const g = {
      maxSpend: num(globalCfg.maxSpend, 10000),
      maxPrice: num(globalCfg.maxPrice, 12000),
      maxCpm: num(globalCfg.maxCpm, 40000),
      maxCpc: num(globalCfg.maxCpc, 800),
    };
    const configs = await getConfigs();
    const ids = Object.keys(configs || {});
    if (!ids.length) return 0;

    const today = dayKey();
    const next = {};
    let count = 0;
    for (const id of ids) {
      const cur = configs[id] || {};
      // Đã reset hôm nay → giữ nguyên (kể cả ngưỡng đã được nâng).
      if (String(cur.__day || "") === today) {
        next[id] = cur;
        continue;
      }
      next[id] = {
        ...cur,
        maxSpend: g.maxSpend,
        maxPrice: g.maxPrice,
        maxCpm: g.maxCpm,
        maxCpc: g.maxCpc,
        originalMaxSpend: g.maxSpend,
        originalMaxPrice: g.maxPrice,
        originalMaxCpm: g.maxCpm,
        originalMaxCpc: g.maxCpc,
        __day: today,
      };
      count++;
    }
    if (count > 0) await setConfigs(next);
    return count;
  }

  /**
   * (I) RESET MỐC SO SÁNH của TẤT CẢ kênh số (inbox / messages / click)
   * + map legacy → lần quét kế tiếp coi mốc cũ = 0 (giống "lần đầu bật CPL").
   *
   * ⚠️ RESET CÓ ĐIỀU KIỆN: map nào ĐÃ có dấu ngày hôm nay ("__day") thì
   *    GIỮ NGUYÊN — nghĩa là đã có người (background hoặc UI realtime) xử lý
   *    ngày mới rồi → không reset lần nữa (tránh nâng ngưỡng 2 lần).
   *
   * @returns {Promise<string[]>} danh sách key đã bị reset
   */
  async function resetAllPrevMaps() {
    const keys = [
      ...Object.values(PREV_KEYS),
      KEY_PREV,
    ];
    const today = dayKey();
    const res = await storageGet(keys);
    const patch = {};
    const cleared = [];
    for (const k of keys) {
      const raw = res[k];
      const mapDay = String((raw && raw[PREV_DAY_FIELD]) || "");
      if (mapDay === today) continue; // đã xử lý ngày mới rồi → giữ nguyên
      // Ghi map rỗng KÈM dấu ngày hôm nay → mốc = 0, và đánh dấu là của
      // ngày hôm nay (để không bị coi là "mốc của hôm qua" lần nữa).
      patch[k] = { [PREV_DAY_FIELD]: today };
      cleared.push(k);
    }
    if (Object.keys(patch).length) await storageSet(patch);
    return cleared;
  }

  /**
   * (I) Đọc khoá ngày hiện tại do background giữ ("camp_core_day").
   * Dùng để UI biết "đã sang ngày mới" → xoá cache mốc trong RAM.
   * @returns {Promise<string>} YYYY-MM-DD ("" nếu chưa có)
   */
  async function getDayStamp() {
    const res = await storageGet([KEY_DAY]);
    return String(res[KEY_DAY] || "");
  }

  /**
   * (I) Đọc khoá ngày (có cache trong RAM để tránh đọc storage mỗi nhóm).
   * @returns {Promise<string>} YYYY-MM-DD ("" nếu chưa từng chạy)
   */
  async function getRolloverDay() {
    if (_dayCache) return _dayCache;
    const res = await storageGet([KEY_DAY]);
    _dayCache = String(res[KEY_DAY] || "");
    return _dayCache;
  }

  /**
   * (I) Xử lý SANG NGÀY MỚI (gọi 1 lần / vòng quét, khi phát hiện ngày đổi).
   *
   * @param {object} globalCfg { maxSpend, maxPrice, maxCpm, maxCpc }
   * @returns {Promise<{dayChanged:boolean, resetPrev:number, resetConfigs:number}>}
   */
  async function rolloverDayIfNeeded(globalCfg = {}) {
    const today = dayKey();
    const res = await storageGet([KEY_DAY]);
    const lastDay = String(res[KEY_DAY] || "");

    // ⭐ CHƯA TỪNG CHẠY (lần đầu tiên) → chỉ ghi nhận ngày, KHÔNG reset.
    //    Nếu reset ở lần đầu thì ngưỡng riêng từng nhóm mà user đã cấu
    //    hình trước đó sẽ bị xoá oan.
    if (!lastDay) {
      await storageSet({ [KEY_DAY]: today });
      _dayCache = today;
      console.log(
        `[CAMP CORE] 📅 Khởi tạo khoá ngày (${today}) — lần chạy đầu tiên, không reset.`,
      );
      return { dayChanged: false, resetPrev: 0, resetConfigs: 0, firstRun: true };
    }
    if (lastDay === today) {
      return { dayChanged: false, resetPrev: 0, resetConfigs: 0 };
    }

    // 1. Xoá mốc so sánh của TẤT CẢ kênh số (inbox/messages/click/legacy)
    //    → ngày mới coi mốc cũ = 0 → nâng ngưỡng theo toàn bộ KQ ngày mới.
    const cleared = await resetAllPrevMaps();

    // 2. Đưa ngưỡng riêng từng nhóm về ngưỡng chung
    const cfgCount = await resetConfigsToGlobal(globalCfg);

    // 3. Xoá khoá chống nâng 2 lần (để ngày mới có thể nâng lại từ đầu)
    await storageSet({ [KEY_RAISE_LOCK]: {} });

    await storageSet({ [KEY_DAY]: today });
    _dayCache = today;

    console.log(
      `[CAMP CORE] 📅 SANG NGÀY MỚI (${today}) — đã reset ${cleared.length} map mốc so sánh (${cleared.join(", ")}) ` +
        `và đưa ${cfgCount} ngưỡng riêng về ngưỡng chung. Ngày mới coi mốc cũ = 0.`,
    );

    return { dayChanged: true, resetPrev: cleared.length, resetConfigs: cfgCount };
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
   *
   * @param {object} opts
   * @param {boolean} [opts.manual]  true = quét tay (bấm nút).
   * @param {boolean} [opts.readOnly] true = CHỈ ĐỌC chỉ số:
   *   - KHÔNG nâng ngưỡng (bước 2) — nhóm chưa có mốc sẽ được ghi "mốc nền = 0".
   *   - KHÔNG tắt/bật nhóm (bước 3 & 4).
   *   - Dùng cho lần quét "xem chỉ số" khi user vừa chọn TKQC.
   */
  async function runScan(opts = {}) {
    const READ_ONLY = !!opts.readOnly;
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

      // (I) SANG NGÀY MỚI — RESET MỐC SO SÁNH + ĐƯA NGƯỠNG RIÊNG VỀ NGƯỠNG CHUNG.
      //     ⚠️ Dùng KEY RIÊNG ("camp_core_day") do BACKGROUND ghi — KHÔNG dùng
      //        "cc_camp_state.dayStamp" vì care_camp.js (UI) cũng ghi vào đó
      //        → tab mở qua đêm sẽ "đánh dấu" ngày mới trước background →
      //        background không phát hiện sang ngày → không reset mốc.
      //     Thứ tự: reset TRƯỚC bước nâng ngưỡng (bước 2) để lần quét đầu
      //     tiên của ngày mới coi mốc cũ = 0 và nâng theo toàn bộ KQ ngày mới.
      const rollover = await rolloverDayIfNeeded(settings);
      if (rollover.dayChanged) {
        pushLog(
          state,
          "info",
          "-",
          "",
          `Sang ngày mới (${dayKey()}) — reset mốc so sánh (mốc cũ = 0) và đưa ${rollover.resetConfigs} ngưỡng riêng về ngưỡng chung.`,
        );
        await notifyTelegram(
          `📅 <b>SANG NGÀY MỚI</b> 📅\n` +
            `- Đã reset mốc đếm KQ (mốc cũ = 0)\n` +
            `- Đã đưa ${rollover.resetConfigs} ngưỡng riêng của nhóm về ngưỡng chung\n` +
            `- Ngày mới sẽ nâng ngưỡng theo toàn bộ KQ phát sinh trong ngày`,
        );
      }

      // (F) SANG NGÀY MỚI → xoá danh sách "đã tắt tự động" của hôm trước.
      //     KHÔNG bật lại các nhóm đó (chỉ số ngày mới đã reset về 0).
      //     Phải làm ở BACKGROUND vì extension có thể chạy khi đóng tab.
      const today = dayKey();
      // (F) CHỈ purge khi NGÀY THỰC SỰ ĐỔI.
      //     Dùng `rollover.dayChanged` (khoá ngày RIÊNG do background giữ) —
      //     KHÔNG dùng `ccState.dayStamp` vì care_camp.js (UI) cũng ghi vào đó
      //     → tab mở qua đêm sẽ tự "đánh dấu" ngày mới → background tưởng
      //     đã xử lý → danh sách nhóm đã tắt tự động của hôm qua KHÔNG
      //     được xoá → background có thể BẬT LẠI NHẦM nhóm đó.
      //     Fallback: `ccState.dayStamp !== today` cho lần chạy đầu tiên.
      const dayChanged =
        rollover.dayChanged || ccState.dayStamp !== today;
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

      // ---- 1. GOM DỮ LIỆU ADSETS (1 lần / tài khoản) ----
      const allRows = [];
      for (const id of ids) {
        const rows = await fetchAdsetsForAccount(token, id, settings);
        allRows.push(...rows);
      }
      state.rows = allRows;

      // ---- 2. (G) NÂNG NGƯỠNG — 1 nguồn duy nhất ----
      // (H) Dùng `raiseCount` + `raiseChannel` của từng nhóm:
      //   - Chế độ CPL → chỉ nâng theo số hội thoại Inbox.
      //   - Nếu không xác định được số (nhóm không có tag [N1] hoặc cache
      //     inbox chưa sẵn sàng) → channel = "unknown" → BỎ QUA lần nâng
      //     ngưỡng này (chờ lần sau), KHÔNG ghi mốc.
      for (const row of allRows) {
        if (row.error) continue;
        const res2 = await raiseThresholdForAdset(
          row.adsetId,
          row.raiseCount ?? row.resultCount,
          {
            maxSpend: settings.maxSpend,
            maxPrice: settings.maxPrice,
            maxCpm: settings.maxCpm,
            maxCpc: settings.maxCpc,
            channel: row.raiseChannel || "",
            // (J) readOnly → KHÔNG nâng ngưỡng, chỉ ghi mốc nền nếu chưa có.
            readOnly: READ_ONLY,
          },
        );
        if (res2.skipped) {
          console.log(
            `⏭️ [CAMP CORE] BỎ QUA nâng ngưỡng ${row.name} — chế độ CPL nhưng chưa xác định được số hội thoại Inbox (thiếu tag [N1] hoặc cache inbox chưa sẵn sàng).`,
          );
          continue;
        }
        if (res2.seeded) {
          console.log(
            READ_ONLY
              ? `📌 [CAMP CORE] (chỉ đọc) Đã đặt mốc nền = 0 cho nhóm ${row.name} — lần quét thật sau sẽ nâng theo toàn bộ KQ.`
              : `📌 [CAMP CORE] Mốc nền nhóm ${row.name}: ${row.raiseCount} HT.`,
          );
          continue;
        }
        if (res2.readOnly) {
          // (J) readOnly + nhóm ĐÃ có mốc → giữ nguyên mốc cũ, không nâng.
          continue;
        }
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
            `🚀 <b>NÂNG NGƯỠNG TỰ ĐỘNG</b> 🚀\n- Nhóm: ${esc(row.name)}\n- TK: ${esc(row.accountName)}\n- KQ mới: +${res2.diff} (tổng ${row.raiseCount ?? row.resultCount})\n- Ngưỡng tiêu cũ: ${money(res2.currentMaxSpend)}đ\n- Ngưỡng tiêu MỚI: <b>${money(res2.newMaxSpend)}đ</b>`,
          );
        }
      }

      // ---- 3. (F) TẮT NHÓM VƯỢT NGƯỠNG — 1 nguồn quyết định duy nhất ----
      // (J) readOnly → BỎ QUA bước tắt/bật: lần quét "xem chỉ số" không
      //     được đụng vào trạng thái nhóm quảng cáo trên Facebook.
      let paused = 0;
      let resumed = 0;
      const newlyPaused = [];

      if (!READ_ONLY && monitored.length > 0) {
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
            // (H) Lưu thêm số theo kênh Inbox để tính "KQ mới" đúng kênh
            raiseResult:
              row.raiseChannel === CHANNEL_INBOX
                ? num(row.raiseCount, 0)
                : num(row.resultCount, 0),
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
      // (J) readOnly → BỎ QUA bước bật lại (không đụng trạng thái FB).
      const ccState2 = await getCcState();
      for (const p of READ_ONLY ? [] : ccState2.autoPaused) {
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
        // (H) Số KQ dùng để tính "KQ MỚI" phải theo ĐÚNG kênh số đang dùng.
        //   - Kênh "inbox" → dùng số hội thoại Inbox.
        //   - Kênh "unknown" (chế độ CPL nhưng chưa xác định được số) →
        //     KHÔNG tính KQ mới (newResults = 0) để không nâng ngưỡng oan.
        const resumeChannel = row.raiseChannel || "";
        const useInboxChannel = resumeChannel === CHANNEL_INBOX;
        const unknownChannel = resumeChannel === CHANNEL_UNKNOWN;
        const currentCount = useInboxChannel
          ? num(row.raiseCount, 0)
          : num(row.resultCount, 0);
        // Mốc KQ lúc nhóm bị tắt (lưu theo cùng kênh)
        const prevResult = useInboxChannel
          ? num(p.raiseResult, num(p.result, 0))
          : num(p.result, 0);
        const newResults = unknownChannel
          ? 0
          : Math.max(0, currentCount - prevResult);
        const newPrice =
          !unknownChannel && currentCount > 0
            ? Math.round(row.spend / currentCount)
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
        // (H) Ghi vào map của ĐÚNG kênh số đang dùng (inbox/messages/click)
        //     `resumeChannel` đã khai báo ở trên.
        if (resumeChannel && resumeChannel !== CHANNEL_UNKNOWN) {
          await setPrevForAdset(cid, currentCount, resumeChannel);
        }

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
        READ_ONLY
          ? `[CAMP CORE] ✅ Quét xong (CHỈ ĐỌC) trong ${Date.now() - startedAt}ms — ${allRows.length} nhóm · không nâng ngưỡng, không tắt/bật`
          : `[CAMP CORE] ✅ Quét xong trong ${Date.now() - startedAt}ms — ` +
            `${allRows.length} nhóm · tắt ${paused} · bật lại ${resumed}`,
      );
      return { ok: true, rows: allRows.length, paused, resumed, readOnly: READ_ONLY };
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
    KEY_DAY,
    KEY_RAISE_LOCK,

    // storage helpers
    storageGet,
    storageSet,

    // tiện ích
    num,
    money,
    esc,
    dayKey,
    normalizeIds,

    // (H) nâng ngưỡng
    raiseThresholdForAdset,
    getPrevMap,
    getPrevMapDay,
    setPrevMap,
    setPrevForAdset,
    migrateLegacyPrevMap,
    getConfigs,
    setConfigs,
    limitsFor,

    // (I) sang ngày mới — reset mốc so sánh + đưa ngưỡng riêng về ngưỡng chung
    rolloverDayIfNeeded,
    resetAllPrevMaps,
    resetConfigsToGlobal,
    getDayStamp,

    // (H) kênh số — dùng để tách mốc so sánh theo nguồn số
    CHANNEL_INBOX,
    CHANNEL_MESSAGES,
    CHANNEL_CLICK,
    CHANNEL_UNKNOWN,
    PREV_KEYS,
    PREV_DAY_FIELD,

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
