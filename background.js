// 👉 Khi click icon extension → mở dashboard
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: "dashboard.html" });
});

// 👉 Chạy loop Telegram ở background
setInterval(listenTelegramReplies, 5000);

async function listenTelegramReplies() {
  console.log("🔥 BACKGROUND ĐANG CHẠY TELEGRAM");

  const BOT_TOKEN = "8709933422:AAGz6LiC_DP46zjia5JLD95jNNB7Tcjx6wk";

  try {
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

function scheduleInboxAlarm() {
  chrome.alarms.create(INBOX_BG_POLL_ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => scheduleInboxAlarm());
chrome.runtime.onStartup.addListener(() => scheduleInboxAlarm());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === INBOX_BG_POLL_ALARM) {
    // Re-schedule để SW không bị Chrome ngủ giữa chừng
    scheduleInboxAlarm();
    inboxBackgroundPoll()
      .then(() => updateBadgeFromCache())
      .catch((error) => console.log("❌ INBOX BG ERROR:", error?.message));
  }
});

// Dashboard chủ động đánh thức SW + poll ngay
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "inbox-poll-now") {
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
  if (message?.type === "inbox-get-cache") {
    chrome.storage.local
      .get(["inboxBgCache", "inboxBgCacheAt", "inboxRealtimePing"])
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
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
    } catch (e) {
      console.log("❌ Lỗi load danh sách page ở background:", e.message);
      if (pages.length === 0) return;
    }
  }

  const wantedPages = pages.filter(
    (page) =>
      page.id &&
      (page.access_token || page.accessToken) &&
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
      const pageToken = page.access_token || page.accessToken;
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
      const batchResults = await response.json();

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
            // 👉 Fallback nếu sub-request lỗi
            try {
              const safeFields =
                "id,updated_time,unread_count,participants,snippet";
              const safeUrl = `https://graph.facebook.com/${INBOX_BG_GRAPH_VERSION}/${page.id}/conversations?platform=messenger&folder=${encodeURIComponent(folder)}&fields=${encodeURIComponent(safeFields)}&limit=50&access_token=${encodeURIComponent(page.access_token || page.accessToken)}`;
              const safeRes = await fetch(safeUrl);
              const safeData = await safeRes.json();
              if (Array.isArray(safeData.data)) {
                safeData.data.forEach((conversation) => {
                  Object.assign(conversation, {
                    __pageId: page.id,
                    __pageName: page.name,
                    __pageToken: page.access_token || page.accessToken,
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
    } catch (e) {
      console.log("❌ Lỗi Batch Request ở background:", e.message);
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
          await fetch(
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
