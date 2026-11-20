/* ============================================================
 * 🔢 API COUNTER — Bộ đếm số lần gọi API (dùng chung cho mọi context)
 * ------------------------------------------------------------
 * CÁCH HOẠT ĐỘNG
 *  1. Patch `fetch` (window.fetch trong trang, globalThis.fetch trong
 *     Service Worker) → MỌI lệnh gọi HTTP đều bị đếm, không phải sửa
 *     từng chỗ gọi API trong code.
 *  2. Phân loại mỗi lần gọi:
 *       - Máy chủ (host): graph.facebook.com, api.telegram.org, ...
 *       - Nhóm API: Meta Graph API / Meta GraphQL / Telegram / OpenAI / ...
 *       - Endpoint chuẩn hoá: /v20.0/{act_id}/insights  (ID đã che)
 *       - Loại: api | asset (ảnh/css/js) | internal
 *  3. Ghi trạng thái vào chrome.storage.local. MỗI context (Dashboard,
 *     Background, Popup) có 1 bucket riêng → không đụng nhau, Dashboard
 *     gộp tất cả bucket để hiển thị.
 *  4. Tính năng: Tạm dừng đếm, Xóa bộ đếm (epoch), tự reset khi sang ngày mới.
 *
 * CÁCH DÙNG
 *  - Dashboard : <script src="api_counter.js"></script>
 *  - Popup     : <script src="api_counter.js"></script>
 *  - Background: importScripts("api_counter.js");   (đặt ở DÒNG ĐẦU TIÊN)
 * ============================================================ */
(function () {
  "use strict";

  const GLOBAL =
    typeof globalThis !== "undefined"
      ? globalThis
      : typeof self !== "undefined"
        ? self
        : window;

  // Chống cài đặt 2 lần (vd: importScripts chạy lại khi SW khởi động lại)
  if (GLOBAL.__API_COUNTER_INSTALLED__) return;
  GLOBAL.__API_COUNTER_INSTALLED__ = true;

  /* ---------------------------------------------------------
   * HẰNG SỐ / CẤU HÌNH
   * ------------------------------------------------------- */
  const STORAGE_PREFIX = "apiCounter_v1:";
  const KEY_PAUSED = "apiCounterPaused";
  const KEY_EPOCH = "apiCounterEpoch";
  const KEY_REGISTRY = "apiCounterRegistry";
  const LOG_MAX = 120; // số dòng nhật ký giữ lại mỗi context
  const FLUSH_DELAY = 1200; // ms — gộp nhiều lần ghi thành 1 lần
  const PRUNE_EVERY = 20; // mỗi 20 lần flush thì dọn bucket cũ 1 lần
  const EPOCH_CHECK_EVERY = 3; // mỗi 3 lần flush thì kiểm tra lệnh "Đặt lại"
  const INSTANCE_TTL = 2 * 60 * 60 * 1000; // giữ bucket của context cũ 2 giờ
  const MAX_BUCKETS_PER_TYPE = 3; // giữ tối đa 3 bucket/context loại

  const ctxType = detectContext();
  const instanceId =
    ctxType +
    "_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 7);
  const storageKey = STORAGE_PREFIX + instanceId;

  const CTX_LABEL = {
    dashboard: "Dashboard",
    background: "Background (SW)",
    popup: "Popup",
    other: "Trang khác",
  };

  /* ---------------------------------------------------------
   * TRẠNG THÁI TRONG BỘ NHỚ
   * ------------------------------------------------------- */
  let state = createEmptyState();
  let flushTimer = null;
  let flushCount = 0;

  function createEmptyState() {
    return {
      instanceId,
      type: ctxType,
      label: CTX_LABEL[ctxType] || ctxType,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      dayKey: todayKey(),
      lastResetAt: 0,
      paused: false,
      total: 0,
      errors: 0,
      byHost: {},
      byGroup: {},
      byType: {},
      byEndpoint: {},
      byResource: {},
      byStatus: {},
      byContext: {},
      log: [],
    };
  }

  function todayKey() {
    const d = new Date();
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }

  function detectContext() {
    const path = String(GLOBAL.location?.pathname || "").toLowerCase();
    if (path.includes("dashboard")) return "dashboard";
    if (path.includes("popup")) return "popup";
    if (path.includes("background") || path.includes("worker"))
      return "background";
    if (typeof document === "undefined") return "background";
    return "other";
  }

  /* ---------------------------------------------------------
   * PHÂN LOẠI REQUEST
   * ------------------------------------------------------- */
  const IMAGE_EXT =
    /\.(png|jpe?g|gif|webp|svg|ico|bmp|mp4|webm|css|js|woff2?|ttf)(\?|$)/i;

  // Danh sách resource nổi bật của Meta Graph API để gom nhóm dễ đọc
  const META_RESOURCES = [
    "insights",
    "insights_async",
    "campaigns",
    "adsets",
    "ads",
    "adcreatives",
    "adimages",
    "advideos",
    "conversations",
    "messages",
    "accounts",
    "adaccounts",
    "business_managers",
    "pages",
    "page_access_tokens",
    "page_images",
    "comments",
    "leads",
    "catalogs",
    "targeting",
    "alerts",
    "rules",
    "webhooks",
    "permissions",
    "roles",
    "pixelstats",
    "image",
    "video",
    "me",
  ];

  function classify(rawUrl) {
    let u;
    try {
      u = new URL(rawUrl, GLOBAL.location?.href || "https://localhost/");
    } catch (e) {
      return {
        host: "(invalid)",
        group: "(invalid)",
        type: "other",
        path: String(rawUrl).slice(0, 80),
        endpoint: String(rawUrl).slice(0, 80),
        resource: "",
      };
    }

    const host = u.hostname || "(relative)";
    const path = u.pathname || "/";
    const isInternal = !u.host || u.protocol === "chrome-extension:";

    let type = "api";
    if (isInternal) type = "internal";
    else if (IMAGE_EXT.test(path)) type = "asset";

    const group = groupOf(host, path, isInternal);
    const segments = path.split("/").filter(Boolean);
    const resource = detectResource(segments);
    const endpoint = group + " " + normalizePath(segments);

    return { host, group, type, path, endpoint, resource };
  }

  function groupOf(host, path, isInternal) {
    if (isInternal) return "Nội bộ extension";
    if (host === "graph.facebook.com") return "Meta Graph API";
    if (host.endsWith("facebook.com") && path.includes("/api/graphql"))
      return "Meta GraphQL";
    if (host === "api.telegram.org") return "Telegram Bot API";
    if (host === "api.openai.com") return "OpenAI API";
    if (
      host === "script.google.com" ||
      host === "script.googleusercontent.com" ||
      host.endsWith("googleapis.com")
    )
      return "Google API / Apps Script";
    if (host.endsWith("workers.dev")) return "Worker API";
    if (host.endsWith("facebook.com")) return "Facebook Web";
    if (host === "www.google.com" || host === "google.com")
      return "Google Web";
    return host;
  }

  function detectResource(segments) {
    // Duyệt TỪ CUỐI về đầu để lấy segment cụ thể nhất
    // (vd: /v20.0/me/accounts → "accounts", không phải "me")
    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i].toLowerCase();
      if (META_RESOURCES.includes(s)) return s;
    }
    return "";
  }

  // Che mọi thứ giống token/khoá bí mật trong URL
  function maskSegment(seg) {
    // Bot token Telegram: 123456789:AAH...
    if (/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(seg)) return "bot{token}";
    // OAuth access token dạng EAA...
    if (/^E[A-Za-z0-9]{20,}$/.test(seg)) return "{access_token}";
    // Chuỗi hex/base64 dài
    if (/^[A-Za-z0-9_-]{40,}$/.test(seg)) return "{secret}";
    return seg;
  }

  function normalizePath(segments) {
    return segments
      .map((seg) => {
        if (/^\d+$/.test(seg)) return "{id}";
        if (/^act_\d+$/i.test(seg)) return "{act_id}";
        if (/^[0-9a-f]{13,}$/i.test(seg)) return "{id}";
        if (/^[a-z]_\d+$/i.test(seg)) return "{id}";
        return maskSegment(seg);
      })
      .join("/");
  }

  /* ---------------------------------------------------------
   * GHI NHẬN 1 LẦN GỌI
   * ------------------------------------------------------- */
  function record(info) {
    if (state.paused) return;

    ensureDay();

    const now = Date.now();
    const cls = classify(info.urlStr || "");
    const isError = !info.ok || (info.status && info.status >= 400);

    state.total++;
    if (isError) state.errors++;

    bump(state.byHost, cls.host);
    bump(state.byGroup, cls.group);
    bump(state.byType, cls.type);
    bump(state.byContext, state.label);
    bump(state.byStatus, String(info.status || 0));

    if (cls.group === "Meta Graph API") {
      if (cls.resource) {
        const r = state.byResource[cls.resource] || {
          calls: 0,
          errors: 0,
        };
        r.calls++;
        if (isError) r.errors++;
        state.byResource[cls.resource] = r;
      }
      const e = state.byEndpoint[cls.endpoint] || { calls: 0, errors: 0 };
      e.calls++;
      if (isError) e.errors++;
      state.byEndpoint[cls.endpoint] = e;
    } else if (cls.group !== "(invalid)") {
      const e = state.byEndpoint[cls.endpoint] || { calls: 0, errors: 0 };
      e.calls++;
      if (isError) e.errors++;
      state.byEndpoint[cls.endpoint] = e;
    }

    state.log.push({
      ts: now,
      src: state.label,
      method: info.method || "GET",
      url: shortenUrl(info.urlStr || ""),
      status: info.status || 0,
      ms: Math.round(info.duration || 0),
      group: cls.group,
    });
    if (state.log.length > LOG_MAX) {
      state.log.splice(0, state.log.length - LOG_MAX);
    }

    scheduleFlush();
  }

  function bump(obj, key) {
    obj[key] = (obj[key] || 0) + 1;
  }

  function shortenUrl(u) {
    try {
      const url = new URL(u, GLOBAL.location?.href || "https://localhost/");
      // access_token nằm trong query
      const token = url.searchParams.get("access_token");
      if (token) url.searchParams.set("access_token", "***");
      // Che bot token Telegram nằm trong path: /bot<TOKEN>/...
      url.pathname = url.pathname.replace(
        /\/bot\d{6,}:[A-Za-z0-9_-]{20,}/,
        "/bot{TOKEN}",
      );
      // Che token dạng path segment dài
      url.pathname = url.pathname
        .split("/")
        .map((seg) => maskSegment(seg))
        .join("/");
      return (url.hostname + url.pathname + url.search).slice(0, 220);
    } catch (e) {
      return String(u).slice(0, 220);
    }
  }

  /* ---------------------------------------------------------
   * RESET THEO NGÀY / THEO LỆNH TỪ UI
   * ------------------------------------------------------- */
  function ensureDay() {
    const k = todayKey();
    if (state.dayKey !== k) {
      const keep = { instanceId, type: ctxType, label: state.label };
      state = Object.assign(createEmptyState(), keep, {
        startedAt: Date.now(),
        dayKey: k,
        paused: state.paused,
        lastResetAt: state.lastResetAt,
      });
    }
  }

  function resetCounters() {
    const keep = {
      instanceId,
      type: ctxType,
      label: state.label,
      paused: state.paused,
    };
    state = Object.assign(createEmptyState(), keep, {
      startedAt: Date.now(),
      updatedAt: Date.now(),
      dayKey: todayKey(),
      lastResetAt: Date.now(),
    });
    scheduleFlush(true);
  }

  /* ---------------------------------------------------------
   * GHI VÀO STORAGE
   * ------------------------------------------------------- */
  function snapshot() {
    return {
      instanceId: state.instanceId,
      type: state.type,
      label: state.label,
      startedAt: state.startedAt,
      updatedAt: Date.now(),
      dayKey: state.dayKey,
      total: state.total,
      errors: state.errors,
      lastResetAt: state.lastResetAt || 0,
      byHost: state.byHost,
      byGroup: state.byGroup,
      byType: state.byType,
      byEndpoint: state.byEndpoint,
      byResource: state.byResource,
      byStatus: state.byStatus,
      byContext: state.byContext,
      log: state.log,
    };
  }

  function scheduleFlush(force = false) {
    if (force) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flush();
      return;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_DELAY);
  }

  async function flush() {
    if (!globalThis.chrome?.storage?.local) return;
    try {
      // 1. Kiểm tra lệnh "Đặt lại" TRƯỚC khi ghi, để không ghi đè số liệu cũ
      //    (kiểm tra mỗi 3 lần flush ~ 4s, đủ nhanh mà không dồn storage I/O)
      if (flushCount % EPOCH_CHECK_EVERY === 0) await syncEpochFromStorage();
      // 2. Ghi snapshot của context này
      state.updatedAt = Date.now();
      await chrome.storage.local.set({ [storageKey]: snapshot() });
      flushCount++;
      // 3. Đăng ký context này vào registry (UI đọc registry để biết có bao nhiêu context)
      await touchRegistry();
      // 4. Dọn bucket của context đã đóng (mỗi 20 lần flush)
      if (flushCount % PRUNE_EVERY === 0) pruneOldBuckets();
    } catch (e) {
      // im lặng — bộ đếm không được làm hỏng chức năng chính
    }
  }

  // Cập nhật registry: danh sách các context đang ghi
  async function touchRegistry() {
    try {
      const reg = await chrome.storage.local.get([KEY_REGISTRY]);
      const list = Array.isArray(reg[KEY_REGISTRY]) ? reg[KEY_REGISTRY] : [];
      const withoutMe = list.filter((b) => b && b.instanceId !== instanceId);
      withoutMe.push({
        instanceId,
        type: ctxType,
        label: CTX_LABEL[ctxType] || ctxType,
        updatedAt: Date.now(),
      });
      await chrome.storage.local.set({ [KEY_REGISTRY]: withoutMe });
    } catch (e) {
      // ignore
    }
  }

  // Đọc epoch hiện tại từ storage; nếu lớn hơn epoch đã biết → reset
  async function syncEpochFromStorage() {
    try {
      const res = await chrome.storage.local.get([KEY_EPOCH]);
      const epoch = Number(res[KEY_EPOCH]) || 0;
      if (epoch > (state.lastResetAt || 0)) {
        state.lastResetAt = epoch;
        resetCounters();
      }
    } catch (e) {
      // ignore
    }
  }

  // Dọn bucket của các context đã đóng (để storage không phình vô hạn).
  // Dùng registry key thay vì get(null) — extension lưu cache inbox rất lớn.
  async function pruneOldBuckets() {
    try {
      const reg = await chrome.storage.local.get([KEY_REGISTRY]);
      const list = Array.isArray(reg[KEY_REGISTRY]) ? reg[KEY_REGISTRY] : [];

      const byType = {};
      for (const b of list) {
        if (!b || b.instanceId === instanceId) continue;
        (byType[b.type] = byType[b.type] || []).push(b);
      }
      const toRemove = [];
      for (const type of Object.keys(byType)) {
        const arr = byType[type].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        arr.forEach((b, i) => {
          const tooOld = Date.now() - (b.updatedAt || 0) > INSTANCE_TTL;
          if (i >= MAX_BUCKETS_PER_TYPE || tooOld) toRemove.push(b.instanceId);
        });
      }

      // Cập nhật registry: bỏ các instance đã bị xóa
      const keep = list.filter(
        (b) => b && !toRemove.includes(b.instanceId),
      );
      const updated = keep.map((b) => {
        const mine = b.instanceId === instanceId;
        return mine
          ? { instanceId, type: ctxType, updatedAt: Date.now() }
          : b;
      });
      await chrome.storage.local.set({ [KEY_REGISTRY]: updated });

      if (toRemove.length) {
        await chrome.storage.local.remove(
          toRemove.map((id) => STORAGE_PREFIX + id),
        );
      }
    } catch (e) {
      // ignore
    }
  }

  /* ---------------------------------------------------------
   * PATCH FETCH — ĐÂY LÀ PHẦN CỐT LÕI
   * ------------------------------------------------------- */
  function installFetchHook() {
    if (typeof GLOBAL.fetch !== "function") return;
    if (GLOBAL.fetch.__apiCounterPatched) return;

    const originalFetch = GLOBAL.fetch.bind(GLOBAL);

    async function patchedFetch(input, init) {
      const urlStr =
        typeof input === "string"
          ? input
          : input && typeof input.url === "string"
            ? input.url
            : "";
      const method = String(
        (init && init.method) || (input && input.method) || "GET",
      ).toUpperCase();

      const started = Date.now();
      try {
        const res = await originalFetch(input, init);
        record({
          urlStr,
          method,
          status: res.status,
          ok: res.ok,
          duration: Date.now() - started,
        });
        return res;
      } catch (err) {
        record({
          urlStr,
          method,
          status: 0,
          ok: false,
          duration: Date.now() - started,
        });
        throw err;
      }
    }

    patchedFetch.__apiCounterPatched = true;
    GLOBAL.fetch = patchedFetch;
  }

  /* ---------------------------------------------------------
   * ĐỒNG BỘ TRẠNG THÁI PAUSE / RESET TỪ UI
   * ------------------------------------------------------- */
  function initStorageSync() {
    if (!globalThis.chrome?.storage?.local) return;

    chrome.storage.local
      .get([KEY_PAUSED, KEY_EPOCH])
      .then((res) => {
        state.paused = !!res[KEY_PAUSED];
        const epoch = Number(res[KEY_EPOCH]) || 0;
        if (epoch > (state.lastResetAt || 0)) {
          state.lastResetAt = epoch;
          resetCounters();
        }
        scheduleFlush(true);
      })
      .catch(() => {});

    if (chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes[KEY_PAUSED]) {
          state.paused = !!changes[KEY_PAUSED].newValue;
          scheduleFlush(true);
        }
        if (changes[KEY_EPOCH]) {
          const epoch = Number(changes[KEY_EPOCH].newValue) || 0;
          if (epoch > (state.lastResetAt || 0)) {
            state.lastResetAt = epoch;
            resetCounters();
          }
        }
      });
    }
  }

  // Cho phép UI điều khiển TẤT CẢ context (dashboard/background/popup)
  function initMessageBridge() {
    if (!globalThis.chrome?.runtime?.onMessage) return;
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || msg.type !== "api-counter:cmd") return false;
      try {
        if (msg.cmd === "pause") {
          state.paused = !!msg.value;
          chrome.storage.local
            .set({ [KEY_PAUSED]: state.paused })
            .catch(() => {});
          scheduleFlush(true);
          safeRespond(sendResponse, { ok: true, paused: state.paused });
          return true;
        }
        if (msg.cmd === "reset") {
          resetCounters();
          safeRespond(sendResponse, { ok: true });
          return true;
        }
        if (msg.cmd === "get") {
          safeRespond(sendResponse, { ok: true, state: snapshot() });
          return true;
        }
      } catch (e) {
        // ignore
      }
      return false;
    });
  }

  // Nhiều context cùng đăng ký listener → chỉ 1 listener được gọi
  // sendResponse. Bọc try/catch để không phát sinh lỗi "message port closed".
  function safeRespond(sendResponse, payload) {
    try {
      sendResponse(payload);
    } catch (e) {
      // ignore
    }
  }

  /* ---------------------------------------------------------
   * PUBLIC API
   * ------------------------------------------------------- */
  GLOBAL.__apiCounter = {
    ctxType,
    instanceId,
    label: CTX_LABEL[ctxType] || ctxType,
    getState: () => snapshot(),
    reset: () => resetCounters(),
    flush: () => scheduleFlush(true),
    isPaused: () => state.paused,
    setPaused: (v) => {
      state.paused = !!v;
      chrome.storage.local.set({ [KEY_PAUSED]: state.paused }).catch(() => {});
      scheduleFlush(true);
    },
    STORAGE_PREFIX,
  };

  installFetchHook();
  initStorageSync();
  initMessageBridge();

  // Đảm bảo dữ liệu đã ghi được lưu lại khi context bị đóng
  GLOBAL.addEventListener?.("pagehide", () => scheduleFlush(true));
  GLOBAL.addEventListener?.("beforeunload", () => scheduleFlush(true));
})();
