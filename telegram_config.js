/* =========================================================================
 * 🔔 TELEGRAM CONFIG — Nguồn cấu hình duy nhất cho mọi thông báo Telegram
 * -------------------------------------------------------------------------
 * Cho phép mỗi người dùng tự nhập BOT TOKEN + CHAT ID riêng.
 * Nếu KHÔNG nhập (hoặc xoá) → tự động fallback về bot Telegram mặc định.
 *
 * Cấu hình được lưu trong chrome.storage.local:
 *    ccTeleBotToken : string  (trống = dùng bot mặc định)
 *    ccTeleChatId   : string  (trống = dùng chat ID mặc định)
 *
 * Module này được nạp ở CẢ dashboard.html VÀ background.js (importScripts)
 * nên cả hai nơi đều dùng chung một nguồn cấu hình.
 * ========================================================================= */
(function (global) {
  "use strict";

  // ---- Bot mặc định & chat ID ----
  // Bot mặc định: @syncOrdersBOT_bot
  // KHÔNG có chat ID mặc định — người dùng BẮT BUỘC tự nhập.
  // (Trống → không gửi được tin nào, hiện cảnh báo yêu cầu nhập.)
  const DEFAULT_BOT_TOKEN =
    "8709933422:AAGz6LiC_DP46zjia5JLD95jNNB7Tcjx6wk";
  const DEFAULT_BOT_USERNAME = "@syncOrdersBOT_bot";
  const DEFAULT_CHAT_IDS = [];

  // Key trong chrome.storage.local
  const KEY_BOT_TOKEN = "ccTeleBotToken";
  const KEY_CHAT_ID = "ccTeleChatId";

  // Cache trong bộ nhớ để tránh đọc storage mỗi lần gửi
  let cache = { botToken: "", chatId: "", loaded: false };

  /** Đọc storage (dạng Promise) — hoạt động cả trong service worker */
  function getStorage(keys) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === "undefined" || !chrome.storage) {
          resolve({});
          return;
        }
        chrome.storage.local.get(keys, (res) => resolve(res || {}));
      } catch (e) {
        console.warn("[TelegramConfig] Không đọc được storage:", e?.message);
        resolve({});
      }
    });
  }

  /** Ghi storage (dạng Promise) */
  function setStorage(obj) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === "undefined" || !chrome.storage) {
          resolve();
          return;
        }
        chrome.storage.local.set(obj, () => resolve());
      } catch (e) {
        console.warn("[TelegramConfig] Không ghi được storage:", e?.message);
        resolve();
      }
    });
  }

  /**
   * Lấy cấu hình Telegram hiện tại.
   * @returns {Promise<{botToken:string, chatIds:string[], isDefault:boolean}>}
   */
  async function getConfig() {
    const res = await getStorage([KEY_BOT_TOKEN, KEY_CHAT_ID]);

    let botToken = (res[KEY_BOT_TOKEN] || "").trim();
    let chatId = (res[KEY_CHAT_ID] || "").trim();

    // Cache lại để dùng cho các lần gửi ngay sau
    cache.botToken = botToken;
    cache.chatId = chatId;
    cache.loaded = true;

    // Fallback về bot mặc định khi người dùng không nhập
    if (!botToken) botToken = DEFAULT_BOT_TOKEN;

    let chatIds = chatId
      ? chatId
          .split(/[\s,;]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : DEFAULT_CHAT_IDS.slice();

    return {
      botToken,
      chatIds,
      isDefault: !((res[KEY_BOT_TOKEN] || "").trim()),
      hasChatId: chatIds.length > 0,
      rawBotToken: (res[KEY_BOT_TOKEN] || "").trim(),
      rawChatId: (res[KEY_CHAT_ID] || "").trim(),
    };
  }

  /** Lấy cấu hình đã cache (không đọc storage) — fallback về mặc định */
  function getCachedConfig() {
    const botToken = cache.botToken || DEFAULT_BOT_TOKEN;
    const chatIds = cache.chatId
      ? cache.chatId
          .split(/[\s,;]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : DEFAULT_CHAT_IDS.slice();
    return {
      botToken,
      chatIds,
      isDefault: !cache.botToken,
      hasChatId: chatIds.length > 0,
    };
  }

  /**
   * Lưu cấu hình của người dùng.
   * Chuỗi rỗng → xoá key → dùng bot mặc định.
   */
  async function saveConfig(botToken, chatId) {
    const b = (botToken || "").trim();
    const c = (chatId || "").trim();
    await setStorage({ [KEY_BOT_TOKEN]: b, [KEY_CHAT_ID]: c });
    cache.botToken = b;
    cache.chatId = c;
    cache.loaded = true;
    return getConfig();
  }

  /** Xoá cấu hình → quay về bot Telegram mặc định (xoá cả chat ID) */
  async function resetConfig() {
    await setStorage({ [KEY_BOT_TOKEN]: "", [KEY_CHAT_ID]: "" });
    cache.botToken = "";
    cache.chatId = "";
    cache.loaded = true;
    return getConfig();
  }

  /**
   * Chỉ chuyển về bot Telegram mặc định, GIỮ NGUYÊN chat ID của người dùng.
   * (Chat ID là bắt buộc nên không nên xoá khi đổi bot.)
   */
  async function resetBotToken() {
    const res = await getStorage([KEY_CHAT_ID]);
    const chatId = (res[KEY_CHAT_ID] || "").trim();
    await setStorage({ [KEY_BOT_TOKEN]: "", [KEY_CHAT_ID]: chatId });
    cache.botToken = "";
    cache.chatId = chatId;
    cache.loaded = true;
    return getConfig();
  }

  /**
   * Gửi 1 tin nhắn Telegram (dùng cấu hình của người dùng, fallback bot mặc định).
   * Nếu chưa nhập CHAT ID → không gửi được, trả về lỗi rõ ràng.
   * @param {string} message  Nội dung (hỗ trợ HTML cơ bản)
   * @param {object} [opts]   { parseMode, silent }
   * @returns {Promise<{ok:boolean, sent:number, total:number, error?:string}>}
   */
  /** Bo the th the HTML (fallback khi Telegram loi parse) */
  function stripHtml(s) {
    return String(s == null ? "" : s)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/b>/gi, "")
      .replace(/<[^>]*>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  /**
   * Gui tin toi 1 chat.
   * Neu Telegram bao loi parse (vi du "can't parse entities") -> thu lai
   * KHONG dung parse_mode de tin luon duoc gui.
   */
  async function sendToChat(url, chatId, message, parseMode, silent) {
    try {
      let response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: parseMode,
          disable_notification: !!silent,
        }),
      });

      if (!response.ok && parseMode) {
        let detail = "";
        try {
          const data = await response.clone().json();
          detail = data && data.description ? data.description : "";
        } catch (e) {}
        if (/parse|entities/i.test(detail)) {
          response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: stripHtml(message),
              disable_notification: !!silent,
            }),
          });
        }
      }

      if (!response.ok) {
        let detail = "";
        try {
          const data = await response.json();
          detail =
            data && data.description ? data.description : response.statusText;
        } catch (e) {
          detail = response.statusText || "";
        }
        const err = "HTTP " + response.status + (detail ? ": " + detail : "");
        console.error(
          "[TelegramConfig] Loi gui tin den ID " + chatId + ": " + err,
        );
        return { ok: false, error: err };
      }
      console.log(
        "[TelegramConfig] Da gui canh bao thanh cong toi ID " + chatId,
      );
      return { ok: true, error: "" };
    } catch (error) {
      const msg = error && error.message ? error.message : String(error);
      console.error("[TelegramConfig] Loi ket noi API Telegram:", error);
      return { ok: false, error: msg };
    }
  }

  async function sendMessage(message, opts) {
    const options = opts || {};
    const parseMode = options.parseMode || "HTML";
    const cfg = await getConfig();

    // ⚠️ Chưa cấu hình CHAT ID → không có nơi để gửi
    if (!cfg.chatIds.length) {
      console.warn(
        "[TelegramConfig] Chưa có TELEGRAM_CHAT_ID → bỏ qua gửi tin nhắn.",
      );
      return {
        ok: false,
        sent: 0,
        total: 0,
        error: "Chưa cấu hình TELEGRAM_CHAT_ID",
        isDefault: cfg.isDefault,
        missingChatId: true,
      };
    }

    const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;

    let sent = 0;
    let lastError = "";

    for (const chatId of cfg.chatIds) {
      const ok = await sendToChat(url, chatId, message, parseMode, options.silent);
      if (ok.ok) sent++;
      else lastError = ok.error;
    }

    return {
      ok: sent > 0,
      sent,
      total: cfg.chatIds.length,
      error: sent > 0 ? "" : lastError,
      isDefault: cfg.isDefault,
    };
  }

  /**
   * Gửi 1 tin nhắn Telegram với cấu hình chỉ định (KHÔNG ghi vào storage).
   * Dùng cho nút "Gửi tin thử" để người dùng thử cấu hình đang gõ
   * mà không cần bấm "Lưu" và không làm bẩn cấu hình đã lưu.
   * @param {string} message
   * @param {{botToken?:string, chatIds?:string[]}} cfg
   */
  async function sendMessageWith(message, cfg) {
    const options = arguments[2] || {};
    const parseMode = options.parseMode || "HTML";
    const botToken = (cfg?.botToken || "").trim() || DEFAULT_BOT_TOKEN;
    const chatIds = Array.isArray(cfg?.chatIds) && cfg.chatIds.length
      ? cfg.chatIds
      : DEFAULT_CHAT_IDS.slice();

    // ⚠️ Chưa có CHAT ID → không có nơi để gửi
    if (!chatIds.length) {
      return {
        ok: false,
        sent: 0,
        total: 0,
        error: "Chưa cấu hình TELEGRAM_CHAT_ID",
        missingChatId: true,
      };
    }

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    let sent = 0;
    let lastError = "";

    for (const chatId of chatIds) {
      const r = await sendToChat(url, chatId, message, parseMode, options.silent);
      if (r.ok) sent++;
      else lastError = r.error;
    }

    return {
      ok: sent > 0,
      sent,
      total: chatIds.length,
      error: sent > 0 ? "" : lastError,
    };
  }

  // ---- Xuất API ra global (window cho trang, self cho service worker) ----
  const api = {
    DEFAULT_BOT_TOKEN,
    DEFAULT_BOT_USERNAME,
    DEFAULT_CHAT_IDS,
    KEY_BOT_TOKEN,
    KEY_CHAT_ID,
    getConfig,
    getCachedConfig,
    saveConfig,
    resetConfig,
    resetBotToken,
    sendMessage,
    sendMessageWith,
  };

  global.TelegramConfig = api;

  // Nạp sẵn cache khi khởi động (không chặn)
  getConfig().catch(() => {});
})(typeof window !== "undefined" ? window : self);
