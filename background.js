// ============================================================
// 🔢 BỘ ĐẾM SỐ LẦN GỌI API — phải nạp ở DÒNG ĐẦU TIÊN để patch fetch
//    trước khi background.js gọi bất kỳ API nào.
// ============================================================
try {
  importScripts("api_counter.js");
} catch (e) {
  console.warn("[ApiCounter] Không nạp được api_counter.js:", e?.message);
}

// ============================================================
// 🔔 TELEGRAM CONFIG — nguồn cấu hình bot/chat dùng chung
//    (người dùng tự nhập trong dashboard; không nhập → bot mặc định)
// ============================================================
try {
  importScripts("telegram_config.js");
} catch (e) {
  console.warn("[TelegramConfig] Không nạp được telegram_config.js:", e?.message);
}

// ============================================================
// 🔐 LICENSE CORE — kiểm tra key bản quyền (dùng chung với dashboard)
//    Nạp SAU telegram_config.js, trước camp_core.js.
// ============================================================
try {
  importScripts("license_core.js");
} catch (e) {
  console.warn("[LicenseCore] Không nạp được license_core.js:", e?.message);
}

// ============================================================
// 🔐 GATE LICENSE — chặn các tác vụ nền khi chưa kích hoạt
//    - Kiểm tra license tối đa 1 lần / 5 phút (cache trong bộ nhớ)
//    - Fail-open: lỗi mạng → cho chạy tiếp (không khoá người dùng)
// ============================================================
let _licGateCache = { ok: false, at: 0 };
const LIC_GATE_TTL = 5 * 60 * 1000;

async function isLicenseValid() {
  if (!self.LicenseCore) return true; // không nạp được thì bỏ qua (không chặn oan)
  const now = Date.now();
  if (now - _licGateCache.at < LIC_GATE_TTL) return _licGateCache.ok;
  try {
    const res = await self.LicenseCore.check();
    _licGateCache = { ok: !!res.allowed, at: now };
    return _licGateCache.ok;
  } catch (e) {
    // lỗi nội bộ → fail-open
    return true;
  }
}

// ============================================================
// 🔧 CAMP CORE — Lõi quét dùng chung (D + F + G)
//    Chạy trong service worker → quét không phụ thuộc tab dashboard.
//    Phải nạp SAU telegram_config.js (cần TelegramConfig để gửi tin).
// ============================================================
try {
  importScripts("camp_core.js");
} catch (e) {
  console.warn("[CampCore] Không nạp được camp_core.js:", e?.message);
}

// 👉 Khi click icon extension → mở dashboard
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: "dashboard.html" });
});

// 👉 Chạy loop Telegram ở background
setInterval(listenTelegramReplies, 5000);

async function listenTelegramReplies() {
  console.log("🔥 BACKGROUND ĐANG CHẠY TELEGRAM");

  try {
    // Dùng bot của người dùng (nếu có), không nhập → bot Telegram mặc định
    const tgCfg = self.TelegramConfig
      ? await self.TelegramConfig.getConfig()
      : {
          botToken: "8709933422:AAGz6LiC_DP46zjia5JLD95jNNB7Tcjx6wk",
        };
    const BOT_TOKEN = tgCfg.botToken;

    const res = await chrome.storage.local.get([
      "teleLastUpdateId",
      "prepayData",
      "processedMsgIds",
    ]);

    let offset = res.teleLastUpdateId ? res.teleLastUpdateId + 1 : 0;
    let prepayData = res.prepayData || {};
    let processed = res.processedMsgIds || {};

    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}`,
    );

    const data = await response.json();

    console.log("📦 TELEGRAM DATA:", data);

    if (!data.ok || !data.result || data.result.length === 0) return;

    let maxUpdateId = offset;
    let updated = false;

    for (const update of data.result) {
      maxUpdateId = Math.max(maxUpdateId, update.update_id);

      const msg = update.message;
      if (!msg || !msg.text) continue;

      // ❗ chống lặp
      if (processed[msg.message_id]) continue;

      // ❗ chỉ nhận reply
      if (!msg.reply_to_message) continue;

      const amount = parseFloat(msg.text.replace(/[^\d]/g, ""));
      if (!amount || amount <= 0) continue;

      const originalText =
        msg.reply_to_message.text || msg.reply_to_message.caption || "";

      const cleanText = originalText.replace(/<[^>]*>/g, "");

      const idMatch = cleanText.match(/act_\d+/);
      if (!idMatch) {
        console.log("❌ Không tìm thấy ID");
        continue;
      }

      const accountId = idMatch[0];

      let current = parseFloat(prepayData[accountId]) || 0;
      prepayData[accountId] = current + amount;

      processed[msg.message_id] = true;
      updated = true;

      console.log(`✅ CỘNG TIỀN: ${accountId} +${amount}`);
    }

    await chrome.storage.local.set({
      teleLastUpdateId: maxUpdateId,
      prepayData,
      processedMsgIds: processed,
    });
  } catch (e) {
    console.log("❌ TELEGRAM ERROR:", e);
  }
}

// ============================================================
// 👉 Realtime inbox: tự động tải hội thoại Messenger
//    - chrome.alarms (1 phút, do Chrome giới hạn) làm keepalive
//    - Dashboard chủ động gọi "inbox-poll-now" mỗi 15s để có realtime thật
//    - SW được giữ sống bằng cách gọi lại create() trong handler
// ============================================================
const INBOX_BG_GRAPH_VERSION = "v25.0";
const INBOX_BG_POLL_ALARM = "inbox-bg-poll";

// ============================================================
// 👉 QUẢN LÝ TOKEN HẾT HẠN
//    Meta trả lỗi khi token không còn hiệu lực:
//      190 = Invalid OAuth access token (token hết hạn / bị thu hồi)
//      102 = Session not valid / session expired
//      463 = Session has expired
//    Khi gặp các lỗi này → dừng poll nhanh, tăng backoff, báo lỗi lên UI
// ============================================================
const INBOX_TOKEN_ERROR_CODES = new Set([190, 102, 463]);
const INBOX_TOKEN_ERROR_PATTERNS = [
  /invalid\s+oauth\s+(access\s+)?token/i,
  /session\s+(has\s+)?expired/i,
  /session\s+not\s+valid/i,
  /token\s+(is\s+)?expired/i,
  /unauthorized/i,
];

// Backoff: 1 phút (bình thường) → 5 → 15 → 30 phút (khi token hết hạn)
const INBOX_BACKOFF_MINUTES = [1, 5, 15, 30];
const INBOX_MAX_BACKOFF_MINUTES = 30;

function isTokenExpiredError(errorInfo) {
  if (!errorInfo) return false;
  if (
    errorInfo.code !== undefined &&
    errorInfo.code !== null &&
    INBOX_TOKEN_ERROR_CODES.has(Number(errorInfo.code))
  ) {
    return true;
  }
  const msg = String(errorInfo.message || "");
  return INBOX_TOKEN_ERROR_PATTERNS.some((re) => re.test(msg));
}

// Lấy thông tin lỗi từ body của batch sub-request
function parseBatchError(body) {
  try {
    const parsed = JSON.parse(body);
    if (parsed?.error) {
      return {
        code: parsed.error.code,
        message: parsed.error.message || "",
        type: parsed.error.type || "",
      };
    }
  } catch (e) {
    // ignore
  }
  return null;
}

// Lấy thông tin lỗi từ response JSON thường
function parseResponseError(data) {
  if (data?.error) {
    return {
      code: data.error.code,
      message: data.error.message || "",
      type: data.error.type || "",
    };
  }
  return null;
}

function scheduleInboxAlarm(minutes) {
  const period = Math.max(1, Math.min(minutes, INBOX_MAX_BACKOFF_MINUTES));
  chrome.alarms.create(INBOX_BG_POLL_ALARM, { periodInMinutes: period });
  return period;
}

// Đọc trạng thái backoff hiện tại từ storage
async function getInboxBackoffState() {
  const s = await chrome.storage.local.get([
    "inboxTokenExpired",
    "inboxTokenErrorAt",
    "inboxBackoffLevel",
  ]);
  return {
    expired: !!s.inboxTokenExpired,
    errorAt: Number(s.inboxTokenErrorAt) || 0,
    level: Number(s.inboxBackoffLevel) || 0,
  };
}

// Đánh dấu token đã hết hạn + tăng backoff + báo lỗi lên UI
async function markTokenExpired(errInfo) {
  const state = await getInboxBackoffState();
  // Chỉ tăng level khi lỗi mới xảy ra (sau 2 phút), tránh tăng liên tục
  const now = Date.now();
  const isNewEpisode = now - state.errorAt > 2 * 60 * 1000;
  const level = isNewEpisode
    ? Math.min(state.level + 1, INBOX_BACKOFF_MINUTES.length - 1)
    : state.level;
  const minutes = INBOX_BACKOFF_MINUTES[level] || INBOX_MAX_BACKOFF_MINUTES;

  await chrome.storage.local.set({
    inboxTokenExpired: true,
    inboxTokenErrorAt: now,
    inboxBackoffLevel: level,
    inboxTokenErrorMessage:
      errInfo?.message || "Token Facebook không còn hiệu lực",
    inboxTokenErrorCode: errInfo?.code ?? "",
  });

  // Đổi lịch poll sang chu kỳ dài hơn để không spam API Meta
  const applied = scheduleInboxAlarm(minutes);
  console.log(
    `🔴 Token hết hạn (code ${errInfo?.code ?? "?"}): ${errInfo?.message || ""} → poll mỗi ${applied} phút`,
  );

  // Báo cho dashboard hiển thị
  try {
    chrome.runtime.sendMessage({
      type: "inbox-token-error",
      code: errInfo?.code ?? "",
      message: errInfo?.message || "Token Facebook không còn hiệu lực",
      backoffMinutes: applied,
    }).catch(() => {});
  } catch (e) {}
  return applied;
}

// Token đã hết hạn → reset backoff, trở lại poll bình thường
async function clearTokenExpired() {
  const state = await getInboxBackoffState();
  if (!state.expired) return;
  await chrome.storage.local.set({
    inboxTokenExpired: false,
    inboxTokenErrorAt: 0,
    inboxBackoffLevel: 0,
    inboxTokenErrorMessage: "",
    inboxTokenErrorCode: "",
  });
  scheduleInboxAlarm(1);
  console.log("✅ Token đã hồi sinh → poll trở lại mỗi 1 phút");
}

// 🎯 MỤC 5: Xoá Page Token đã hết hạn khỏi cache
//    → lần poll kế tiếp sẽ gọi lại /me/accounts để lấy Page Token mới.
//    Không xoá User Token (vẫn có thể còn hiệu lực).
async function invalidateExpiredPageTokens(pageIds) {
  try {
    const stored = await chrome.storage.local.get([
      "inboxBgPagesCached",
      "inboxCachedPages",
    ]);
    const idSet = new Set((pageIds || []).map(String));

    // Lọc bỏ các page bị lỗi token khỏi cache background
    if (Array.isArray(stored.inboxBgPagesCached)) {
      const filtered = stored.inboxBgPagesCached.filter(
        (p) => !idSet.has(String(p.id)),
      );
      if (filtered.length !== stored.inboxBgPagesCached.length) {
        await chrome.storage.local.set({
          inboxBgPagesCached: filtered,
          // Xoá timestamp cache → buộc lấy lại /me/accounts ở lần poll sau
          inboxBgPagesCachedAt: 0,
        });
        console.log(
          `♻️ Đã xoá ${stored.inboxBgPagesCached.length - filtered.length} Page Token hết hạn khỏi cache → sẽ lấy token mới ở lần poll sau`,
        );
      }
    }

    // Tương tự cho cache của dashboard
    if (Array.isArray(stored.inboxCachedPages)) {
      const filtered = stored.inboxCachedPages.filter(
        (p) => !idSet.has(String(p.id)),
      );
      if (filtered.length !== stored.inboxCachedPages.length) {
        await chrome.storage.local.set({
          inboxCachedPages: filtered,
          inboxCachedPagesAt: 0,
        });
      }
    }
  } catch (e) {
    console.warn("❌ Không invalidate được Page Token cache:", e.message);
  }
}

chrome.runtime.onInstalled.addListener(() => scheduleInboxAlarm(1));
chrome.runtime.onStartup.addListener(() => scheduleInboxAlarm(1));

// ============================================================
// 🔧 (D) CAMP CORE — ALARM QUÉT 1 PHÚT
//    Đây là NGUỒN QUÉT DUY NHẤT cho cả bảng 📊 Bảng Chỉ Số và ✂️ Tắt Camp.
//    Dashboard chỉ ĐỌC kết quả từ cache, không tự gọi API nữa.
// ============================================================
const CAMP_CORE_ALARM = "camp-core-scan";

function scheduleCampCoreAlarm() {
  try {
    chrome.alarms.create(CAMP_CORE_ALARM, { periodInMinutes: 1 });
  } catch (e) {
    console.warn("[CampCore] Không tạo được alarm:", e?.message);
  }
}

chrome.runtime.onInstalled.addListener(() => scheduleCampCoreAlarm());
chrome.runtime.onStartup.addListener(() => scheduleCampCoreAlarm());

// 🧹 Dọn dữ liệu cũ của tính năng "số ngày chưa tiêu tiền" (đã bỏ để
//    tiết kiệm API). Xoá 1 lần khi cập nhật extension.
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.storage.local.remove(["camp_campaign_activity"], () => {});
  } catch (e) {
    /* bỏ qua */
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CAMP_CORE_ALARM) {
    if (!self.CampCore) return;
    // (D) Alarm là NGUỒN QUÉT DUY NHẤT → luôn chạy mỗi phút để bảng 📊
    //     "Chỉ Số" có dữ liệu mới. Việc TẮT/BẬT (F) bên trong runScan
    //     chỉ áp dụng cho nhóm đang được giám sát (collectMonitored).
    //     Nếu không có token/ID thì runScan tự báo lỗi và không gọi API.
    // 🔐 GATE LICENSE: chưa kích hoạt → không quét, không tốn API
    isLicenseValid().then((ok) => {
      if (!ok) {
        console.log("🔐 Chưa kích hoạt license → bỏ qua lần quét CampCore");
        return;
      }
      self.CampCore.runScan().catch((error) =>
        console.log("❌ CAMP CORE ERROR:", error?.message || error),
      );
    });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === INBOX_BG_POLL_ALARM) {
    // 🔐 GATE LICENSE: chưa kích hoạt → không poll inbox
    isLicenseValid().then((ok) => {
      if (!ok) {
        console.log("🔐 Chưa kích hoạt license → bỏ qua poll inbox");
        return;
      }
      // ⚠️ KHÔNG re-schedule ở đây nữa — markTokenExpired/clearTokenExpired
      // tự điều chỉnh chu kỳ theo trạng thái backoff.
      inboxBackgroundPoll()
        .then(() => updateBadgeFromCache())
        .catch((error) => console.log("❌ INBOX BG ERROR:", error?.message));
    });
  }
});

// Dashboard chủ động đánh thức SW + poll ngay
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // 🔐 LICENSE: dashboard hỏi trạng thái license
  if (message?.type === "license-status") {
    if (!self.LicenseCore) {
      sendResponse({ ok: false, allowed: true, state: "unknown" });
      return true;
    }
    self.LicenseCore.check()
      .then((res) =>
        sendResponse({
          ok: true,
          allowed: !!res.allowed,
          state: res.state,
          message: res.message,
          expiresAt: res.license?.expiresAt || 0,
        }),
      )
      .catch((error) =>
        sendResponse({ ok: false, allowed: true, error: error?.message }),
      );
    return true;
  }
  if (message?.type === "inbox-poll-now") {
    // ⚠️ Nếu token đang hết hạn + đang backoff → bỏ qua, tránh dashboard
    //    spam API Meta mỗi lần refresh (bypass được backoff của alarm)
    getInboxBackoffState()
      .then((state) => {
        if (state.expired) {
          console.log(
            `⏸ Token đang hết hạn → bỏ qua poll (backoff ${state.level})`,
          );
          return { ok: true, skipped: true };
        }
        return inboxBackgroundPoll().then(() => {
          updateBadgeFromCache();
          return { ok: true };
        });
      })
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || "unknown" }),
      );
    return true;
  }
  if (message?.type === "inbox-get-cache") {
    chrome.storage.local
      .get(["inboxBgCache", "inboxBgCacheAt", "inboxRealtimePing"])
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  // 🎯 Sếp vừa lấy token mới → thử poll ngay + reset backoff
  if (message?.type === "inbox-token-refreshed") {
    clearTokenExpired()
      .then(() => inboxBackgroundPoll())
      .then(() => {
        updateBadgeFromCache();
        return sendResponse({ ok: true });
      })
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || "unknown" }),
      );
    return true;
  }
  // 🎯 User bấm nút "LÀM MỚI HỘP THƯ" → poll ngay, bypass backoff
  if (message?.type === "inbox-poll-force") {
    inboxBackgroundPoll()
      .then(() => {
        updateBadgeFromCache();
        return sendResponse({ ok: true });
      })
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || "unknown" }),
      );
    return true;
  }

  // ============================================================
  // 🔧 CAMP CORE — API cho dashboard
  // ============================================================
  // 📊 Bảng Chỉ Số / ✂️ Tắt Camp: quét tay → nhờ background quét (1 nguồn duy nhất)
  // (J) `readOnly: true` → chỉ đọc chỉ số: KHÔNG nâng ngưỡng, KHÔNG tắt/bật.
  if (message?.type === "camp-core-scan") {
    if (!self.CampCore) {
      sendResponse({ ok: false, error: "CampCore chưa nạp" });
      return true;
    }
    self.CampCore
      .runScan({
        manual: message.manual !== false,
        readOnly: !!message.readOnly,
      })
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || "unknown" }),
      );
    return true;
  }

  // 📥 Đọc kết quả quét (rows + logs + thời điểm quét) từ cache của background
  if (message?.type === "camp-core-get-state") {
    if (!self.CampCore) {
      sendResponse({ ok: false, error: "CampCore chưa nạp", data: null });
      return true;
    }
    Promise.all([
      self.CampCore.getState(),
      self.CampCore.getCcState(),
      self.CampCore.getAutoPauseState(),
    ])
      .then(([state, ccState, apState]) =>
        sendResponse({
          ok: true,
          data: {
            state,
            ccState,
            apState,
            monitored: self.CampCore.collectMonitored(ccState, apState),
          },
        }),
      )
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || "unknown" }),
      );
    return true;
  }

  // ♻️ Bật/tắt alarm quét (dashboard báo trạng thái giám sát)
  if (message?.type === "camp-core-alarm") {
    try {
      if (message.enabled) {
        chrome.alarms.create(CAMP_CORE_ALARM, { periodInMinutes: 1 });
      } else {
        chrome.alarms.clear(CAMP_CORE_ALARM);
      }
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message });
    }
    return true;
  }

  return false;
});

async function updateBadgeFromCache() {
  try {
    const { inboxBgCache, inboxBgLastSeen } = await chrome.storage.local.get([
      "inboxBgCache",
      "inboxBgLastSeen",
    ]);
    if (!Array.isArray(inboxBgCache)) return;
    let unread = 0;
    for (const conv of inboxBgCache) {
      const lastMsg = conv.messages?.data?.[0];
      const lastId = lastMsg?.id;
      const isNew =
        lastId && String(lastId) !== String(inboxBgLastSeen?.[conv.id]);
      const isUnread = (conv.unread_count || 0) > 0;
      if (isUnread || isNew) unread++;
    }
    await chrome.action.setBadgeText({
      text: unread > 0 ? String(unread) : "",
    });
    await chrome.action.setBadgeBackgroundColor({ color: "#e0245e" });
  } catch (e) {
    // ignore
  }
}

async function inboxFetchAll(url, maxPages = 2) {
  let result = [];
  let next = url;
  for (let i = 0; i < maxPages && next; i++) {
    const response = await fetch(next);
    _trackApiCall(response, false); // Track BUC (Page-level) calls
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    if (Array.isArray(data.data)) result.push(...data.data);
    next = data.paging?.next || null;
  }
  return result;
}

async function inboxBackgroundPoll() {
  const config = await chrome.storage.local.get([
    "inboxBgToken",
    "inboxBgSelectedPageIds",
    "inboxBgFolder",
    "inboxBgLastSync",
    "inboxBgPagesCached",
    "inboxBgPagesCachedAt",
    // 🔑 Map Page Access Token dán tay (ưu tiên cao nhất)
    "inboxManualPageTokens",
  ]);
  const token = config.inboxBgToken;
  const selectedIds = Array.isArray(config.inboxBgSelectedPageIds)
    ? config.inboxBgSelectedPageIds.map(String)
    : [];
  const folder = (config.inboxBgFolder || "inbox").toString().toUpperCase();

  if (!token || selectedIds.length === 0) return;

  // 👉 Optimization 2: Cache pages & tokens
  let pages = config.inboxBgPagesCached || [];

  // Fallback to dashboard's built-in cache if empty
  if (pages.length === 0) {
    const dbCached = await chrome.storage.local.get(["inboxCachedPages"]);
    if (
      Array.isArray(dbCached.inboxCachedPages) &&
      dbCached.inboxCachedPages.length > 0
    ) {
      pages = dbCached.inboxCachedPages;
    }
  }

  const isFresh =
    config.inboxBgPagesCachedAt &&
    Date.now() - config.inboxBgPagesCachedAt < 24 * 60 * 60 * 1000; // 2 hours

  if (pages.length === 0 || !isFresh) {
    try {
      const fields = "id,name,access_token,picture.type(large)";
      const accountsUrl = `https://graph.facebook.com/${INBOX_BG_GRAPH_VERSION}/me/accounts?fields=${encodeURIComponent(fields)}&limit=100&access_token=${encodeURIComponent(token)}`;
      // Fetch only 1 page to minimize API calls (limit 100 is enough for most users)
      pages = await inboxFetchAll(accountsUrl, 1);
      await chrome.storage.local.set({
        inboxBgPagesCached: pages,
        inboxBgPagesCachedAt: Date.now(),
      });
      // 🎉 Lấy pages thành công → token User còn hiệu lực
      await clearTokenExpired();
    } catch (e) {
      console.log("❌ Lỗi load danh sách page ở background:", e.message);
      // 🔴 Phát hiện token hết hạn → bật backoff + báo lỗi
      if (isTokenExpiredError({ message: e.message })) {
        await markTokenExpired({ message: e.message });
        return;
      }
      if (pages.length === 0) return;
    }
  }

  // 🔑 Map Page Access Token dán tay (ưu tiên cao nhất)
  const manualTokens =
    config.inboxManualPageTokens &&
    typeof config.inboxManualPageTokens === "object"
      ? config.inboxManualPageTokens
      : {};

  const wantedPages = pages.filter(
    (page) =>
      page.id &&
      (page.access_token ||
        page.accessToken ||
        manualTokens[String(page.id)]) &&
      selectedIds.includes(String(page.id)),
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startOfTodaySec = Math.floor(today.getTime() / 1000);

  const incoming = [];
  if (wantedPages.length > 0) {
    // 👉 Optimization 1: Batch Requests (Cách 2: Tách hôm nay/hôm trước - tải full tin nhắn hôm nay)
    // 👉 Gom tất cả Page vào 1 batch request duy nhất (1 request/Page, tránh lỗi 500 của Facebook)
    const batch = [];
    wantedPages.forEach((page) => {
      // 🔑 ƯU TIÊN: token dán tay → token lấy từ /me/accounts
      const pageToken =
        manualTokens[String(page.id)] || page.access_token || page.accessToken;
      const convFields =
        "id,updated_time,unread_count,participants,snippet,link,messages.limit(30){id,created_time,from,to,message,attachments{mime_type,name,file_url,image_url,image_data,url},referral{ad_id,source,type,ref_param,ads_context_data{ad_title,photo_url,video_url,post_id}}}";
      const convUrl = `${INBOX_BG_GRAPH_VERSION}/${page.id}/conversations?platform=messenger&folder=${encodeURIComponent(folder)}&fields=${encodeURIComponent(convFields)}&limit=50&access_token=${encodeURIComponent(pageToken)}`;
      batch.push({
        method: "GET",
        relative_url: convUrl,
      });
    });

    try {
      const batchUrl = `https://graph.facebook.com/?access_token=${encodeURIComponent(token)}`;
      const params = new URLSearchParams();
      params.append("batch", JSON.stringify(batch));
      const response = await fetch(batchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      // Track API call cho rate limit
      _trackApiCall(response, true);
      const batchResults = await response.json();

      // 🔴 Lỗi ở TẦNG BATCH (token User hết hạn) → dừng ngay, không fallback
      if (batchResults?.error) {
        const batchErr = parseResponseError(batchResults);
        if (isTokenExpiredError(batchErr)) {
          await markTokenExpired(batchErr);
          return;
        }
        console.log("❌ Lỗi batch:", batchErr?.message);
        return;
      }

      // Ghi nhận Page nào bị lỗi token → cần lấy lại Page Token
      const pagesWithExpiredToken = [];

      if (Array.isArray(batchResults)) {
        for (let index = 0; index < wantedPages.length; index++) {
          const page = wantedPages[index];
          const res = batchResults[index];

          if (res && res.code === 200) {
            try {
              const body = JSON.parse(res.body);
              if (Array.isArray(body.data)) {
                body.data.forEach((conversation) => {
                  Object.assign(conversation, {
                    __pageId: page.id,
                    __pageName: page.name,
                    __pageToken: page.access_token || page.accessToken,
                  });
                  incoming.push(conversation);
                });
              }
            } catch (err) {
              console.warn("Lỗi parse body sub-request:", err);
            }
          } else {
            // 🔴 Sub-request lỗi → parse lỗi để biết có phải token hết hạn không
            const subErr = parseBatchError(res?.body);
            if (isTokenExpiredError(subErr)) {
              console.warn(
                `🔴 Page ${page.id} (${page.name}): token hết hạn — ${subErr.message}`,
              );
              pagesWithExpiredToken.push(page.id);
              // KHÔNG fallback vì fallback dùng cùng token chết
              continue;
            }

            // 👉 Fallback nếu sub-request lỗi (lỗi khác, không phải token)
            try {
              const safeFields =
                "id,updated_time,unread_count,participants,snippet";
              // 🔑 ƯU TIÊN: token dán tay → token lấy từ /me/accounts
              const safeToken =
                manualTokens[String(page.id)] ||
                page.access_token ||
                page.accessToken;
              const safeUrl = `https://graph.facebook.com/${INBOX_BG_GRAPH_VERSION}/${page.id}/conversations?platform=messenger&folder=${encodeURIComponent(folder)}&fields=${encodeURIComponent(safeFields)}&limit=50&access_token=${encodeURIComponent(safeToken)}`;
              const safeRes = await fetch(safeUrl);
              _trackApiCall(safeRes, true); // Fallback = app-level call
              const safeData = await safeRes.json();
              if (Array.isArray(safeData.data)) {
                safeData.data.forEach((conversation) => {
                  Object.assign(conversation, {
                    __pageId: page.id,
                    __pageName: page.name,
                    __pageToken: safeToken,
                  });
                  incoming.push(conversation);
                });
              }
            } catch (err) {
              // ignore
            }
          }
        }
      }

      // 🎯 MỤC 5: Page Token hết hạn → xoá cache để lần poll sau lấy token mới
      if (pagesWithExpiredToken.length > 0) {
        await invalidateExpiredPageTokens(pagesWithExpiredToken);
      }
    } catch (e) {
      console.log("❌ Lỗi Batch Request ở background:", e.message);
      if (isTokenExpiredError({ message: e.message })) {
        await markTokenExpired({ message: e.message });
        return;
      }
    }
  }

  // 🎉 Có dữ liệu → token còn hiệu lực → reset backoff
  if (incoming.length > 0) {
    await clearTokenExpired();
  }

  // 🔴 KHÔNG ghi đè cache cũ bằng mảng rỗng khi có lỗi token
  //    (nếu không, người dùng sẽ thấy danh sách trống mà không biết vì sao)
  if (incoming.length === 0) {
    const errState = await getInboxBackoffState();
    if (errState.expired) {
      console.log(
        "⚠️ Token hết hạn → giữ nguyên cache cũ, không ghi đè bằng danh sách rỗng",
      );
      return;
    }
  }

  await chrome.storage.local.set({
    inboxBgCache: incoming,
    inboxBgCacheAt: Date.now(),
    inboxBgLastSync: Date.now(),
    inboxRealtimePing: { at: Date.now(), count: incoming.length },
  });

  // Thông báo dashboard biết có data mới (nếu dashboard đang mở)
  try {
    chrome.runtime.sendMessage({ type: "inbox-bg-updated" }).catch(() => {});
  } catch (e) {}

  // Tự động trả lời các tin nhắn mới (nếu bật) + thông báo Telegram
  await processAutoReplyAndNotify(incoming);
}

// ============================================================
// 👉 Rate Limit Tracking cho Facebook API
// ============================================================
let _rateLimitHourly = { calls: 0, resetAt: Date.now() + 3600000, usage: null };
let _rateLimitAppLevel = { calls: 0, resetAt: Date.now() + 3600000 };

function _checkRateLimitReset() {
  const now = Date.now();
  if (now >= _rateLimitHourly.resetAt) {
    _rateLimitHourly = { calls: 0, resetAt: now + 3600000, usage: null };
  }
  if (now >= _rateLimitAppLevel.resetAt) {
    _rateLimitAppLevel = { calls: 0, resetAt: now + 3600000 };
  }
}

function _trackApiCall(response, isAppLevel = false) {
  _checkRateLimitReset();
  const now = Date.now();

  // Đếm calls
  if (isAppLevel) {
    _rateLimitAppLevel.calls++;
  } else {
    _rateLimitHourly.calls++;
  }

  // Parse headers từ response
  if (response && response.headers) {
    try {
      // X-App-Usage header
      const appUsage = response.headers.get("X-App-Usage");
      if (appUsage) {
        _rateLimitAppLevel.usage = JSON.parse(appUsage);
      }
      // X-Business-Use-Case-Usage header
      const bucUsage = response.headers.get("X-Business-Use-Case-Usage");
      if (bucUsage) {
        _rateLimitHourly.usage = JSON.parse(bucUsage);
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Lưu vào storage để dashboard đọc
  chrome.storage.local.set({
    inboxBgRateLimit: {
      hourly: { calls: _rateLimitHourly.calls, resetAt: _rateLimitHourly.resetAt },
      appLevel: { calls: _rateLimitAppLevel.calls, resetAt: _rateLimitAppLevel.resetAt },
      appUsage: _rateLimitAppLevel.usage,
      bucUsage: _rateLimitHourly.usage,
      updatedAt: now,
    },
  });
}

// ============================================================
// 👉 Auto-reply + Telegram notify (chạy nền, không cần dashboard)
// ============================================================
async function processAutoReplyAndNotify(conversations) {
  try {
    const cfg = await chrome.storage.local.get([
      "inboxAutoReplyEnabled",
      "inboxAutoReplyText",
      "inboxTelegramBotToken",
      "inboxTelegramChatIds",
      "inboxBgLastSeen",
    ]);
    if (!Array.isArray(conversations) || conversations.length === 0) return;

    const lastSeen = cfg.inboxBgLastSeen || {};
    const newLastSeen = { ...lastSeen };
    const newEvents = [];

    for (const conv of conversations) {
      const lastMsg = conv.messages?.data?.[0];
      if (!lastMsg) continue;
      const msgId = String(lastMsg.id);
      const lastMsgTime = lastMsg.created_time
        ? new Date(lastMsg.created_time).getTime()
        : 0;

      // Lưu last msg id cho lần sau
      newLastSeen[conv.id] = msgId;

      // Bỏ qua nếu đã xử lý
      if (lastSeen[conv.id] === msgId) continue;

      // Bỏ qua nếu là tin nhắn mình gửi
      const pageId = conv.__pageId;
      const isMine = lastMsg.from?.id === pageId;
      if (isMine) continue;

      // Auto-reply nếu bật + đoạn hội thoại còn có thể reply
      if (cfg.inboxAutoReplyEnabled && conv.can_reply && conv.__pageToken) {
        const text =
          cfg.inboxAutoReplyText ||
          "Cảm ơn bạn đã nhắn tin, chúng tôi sẽ phản hồi sớm nhất!";
        try {
          const replyRes = await fetch(
            `https://graph.facebook.com/${INBOX_BG_GRAPH_VERSION}/me/messages?access_token=${encodeURIComponent(conv.__pageToken)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                recipient: { id: lastMsg.from?.id },
                message: { text },
              }),
            },
          );
          _trackApiCall(replyRes, false); // Track message send
        } catch (e) {
          console.log("❌ auto-reply lỗi:", e.message);
        }
      }

      // Thu thập event để báo Telegram
      newEvents.push({
        conversationId: conv.id,
        pageId,
        pageName: conv.__pageName,
        fromName: lastMsg.from?.name || "Khách",
        fromId: lastMsg.from?.id,
        text: lastMsg.message || "[đính kèm]",
        time: lastMsgTime,
      });
    }

    await chrome.storage.local.set({ inboxBgLastSeen: newLastSeen });

    // Gửi Telegram nếu có cấu hình
    if (
      cfg.inboxTelegramBotToken &&
      Array.isArray(cfg.inboxTelegramChatIds) &&
      cfg.inboxTelegramChatIds.length > 0 &&
      newEvents.length > 0
    ) {
      for (const ev of newEvents.slice(0, 5)) {
        const text =
          `💬 Tin nhắn mới từ ${ev.fromName}\n` +
          `📄 Page: ${ev.pageName || ev.pageId}\n` +
          `🕒 ${new Date(ev.time).toLocaleString("vi-VN")}\n\n` +
          `📝 ${ev.text.slice(0, 500)}`;
        for (const chatId of cfg.inboxTelegramChatIds) {
          try {
            await fetch(
              `https://api.telegram.org/bot${cfg.inboxTelegramBotToken}/sendMessage`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: chatId, text }),
              },
            );
          } catch (e) {}
        }
      }
    }
  } catch (e) {
    console.log("❌ auto-reply/notify lỗi:", e.message);
  }
}
