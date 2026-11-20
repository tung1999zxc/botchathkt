/* ============================================================
 * 🔢 API COUNTER — PHẦN GIAO DIỆN (Dashboard)
 * ------------------------------------------------------------
 * Đọc tất cả bucket trong chrome.storage.local (do api_counter.js ghi)
 * rồi gộp lại thành:
 *   - Thẻ tổng quan: Tổng lần gọi / Lỗi / Máy chủ / Loại
 *   - Bảng theo nhóm API (Meta Graph API, Telegram, ...)
 *   - Bảng theo endpoint (đã che ID + access_token)
 *   - Bảng theo resource Meta (insights, conversations, ...)
 *   - Nhật ký gọi gần nhất (real-time)
 *   - Nút: Tạm dừng / Đặt lại / Làm mới / Xuất CSV
 * ============================================================ */
(function () {
  "use strict";

  const PREFIX = "apiCounter_v1:";
  const KEY_PAUSED = "apiCounterPaused";
  const KEY_EPOCH = "apiCounterEpoch";
  const KEY_REGISTRY = "apiCounterRegistry";

  let merged = null;
  let refreshTimer = null;

  /* ---------------------------------------------------------
   * GỘP DỮ LIỆU TỪ MỌI CONTEXT
   * ------------------------------------------------------- */
  async function loadMerged() {
    // Đọc registry trước để biết chính xác key của các bucket
    // (không dùng get(null) vì extension còn lưu cache inbox rất lớn)
    const regRes = await chrome.storage.local.get([KEY_REGISTRY]);
    const registry = Array.isArray(regRes[KEY_REGISTRY])
      ? regRes[KEY_REGISTRY]
      : [];

    const keys = registry.map((b) => PREFIX + b.instanceId);
    if (keys.length === 0) return emptyMerged();

    const all = await chrome.storage.local.get(keys);
    const buckets = [];
    for (const key of keys) {
      const v = all[key];
      if (!v || typeof v !== "object" || typeof v.total !== "number") continue;
      buckets.push(v);
    }
    buckets.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const m = emptyMerged();

    for (const b of buckets) {
      m.total += b.total || 0;
      m.errors += b.errors || 0;
      m.dayKey = m.dayKey || b.dayKey || "";
      m.updatedAt = Math.max(m.updatedAt, b.updatedAt || 0);
      mergeCounters(m.byHost, b.byHost);
      mergeCounters(m.byGroup, b.byGroup);
      mergeCounters(m.byType, b.byType);
      mergeCounters(m.byContext, b.byContext);
      mergeCounters(m.byStatus, b.byStatus);
      mergeDetailed(m.byEndpoint, b.byEndpoint);
      mergeDetailed(m.byResource, b.byResource);
      if (Array.isArray(b.log)) {
        m.log = m.log.concat(b.log);
      }
    }
    m.log.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    m.log = m.log.slice(0, 150);
    return m;
  }

  function emptyMerged() {
    return {
      total: 0,
      errors: 0,
      byHost: {},
      byGroup: {},
      byType: {},
      byContext: {},
      byStatus: {},
      byEndpoint: {},
      byResource: {},
      log: [],
      buckets: [],
      dayKey: "",
      updatedAt: 0,
    };
  }

  function mergeCounters(target, src) {
    if (!src) return;
    for (const k of Object.keys(src)) {
      target[k] = (target[k] || 0) + (src[k] || 0);
    }
  }

  function mergeDetailed(target, src) {
    if (!src) return;
    for (const k of Object.keys(src)) {
      const row = target[k] || { calls: 0, errors: 0 };
      row.calls += src[k]?.calls || 0;
      row.errors += src[k]?.errors || 0;
      target[k] = row;
    }
  }

  /* ---------------------------------------------------------
   * TIỆN ÍCH HIỂN THỊ
   * ------------------------------------------------------- */
  function esc(s) {
    return String(s ?? "").replace(
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

  function topEntries(obj, limit = 50) {
    return Object.entries(obj || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);
  }

  function topDetailed(obj, limit = 50) {
    return Object.entries(obj || {})
      .sort((a, b) => (b[1]?.calls || 0) - (a[1]?.calls || 0))
      .slice(0, limit);
  }

  function fmtTime(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleTimeString("vi-VN");
  }

  function statusColor(code) {
    const c = Number(code) || 0;
    if (c === 0) return "#6b7280";
    if (c < 300) return "#16a34a";
    if (c < 400) return "#0e7490";
    if (c < 500) return "#d97706";
    return "#dc2626";
  }

  function bar(pct, color) {
    const p = Math.max(2, Math.min(100, pct));
    return `<div style="height:6px;border-radius:3px;background:#e4e6eb;overflow:hidden;min-width:60px">
      <div style="height:100%;width:${p}%;background:${color};border-radius:3px"></div>
    </div>`;
  }

  /* ---------------------------------------------------------
   * RENDER
   * ------------------------------------------------------- */
  function render() {
    const root = document.getElementById("apicount-panel");
    if (!root || !merged) return;

    // Giữ vị trí cuộn của các bảng khi vẽ lại (auto-refresh mỗi 3s)
    const scrollMemo = {};
    root.querySelectorAll("div[style*='overflow']").forEach((el, i) => {
      scrollMemo[i] = el.scrollTop;
    });
    const pageScroll = window.scrollY;

    const m = merged;
    const paused = !!m.paused;
    const maxGroup = Math.max(1, ...Object.values(m.byGroup || {}));

    // Tần suất: số lượt gọi trong 60 giây gần nhất (từ nhật ký)
    const nowTs = Date.now();
    const last60 = (m.log || []).filter((l) => nowTs - (l.ts || 0) <= 60000);
    const last10 = (m.log || []).filter((l) => nowTs - (l.ts || 0) <= 600000);
    const perMin = last60.length;
    const per10Min = last10.length;
    const avgPerMin = per10Min / 10;

    /* --- Thẻ tổng quan --- */
    const cards = [
      {
        label: "TỔNG LẦN GỌI API",
        value: m.total,
        color: "#1877f2",
        icon: "📡",
      },
      {
        label: "LỖI (4xx/5xx)",
        value: m.errors,
        color: "#dc2626",
        icon: "⚠️",
      },
      {
        label: "MÁY CHỦ",
        value: Object.keys(m.byHost || {}).length,
        color: "#7c3aed",
        icon: "🌐",
      },
      {
        label: "CONTEXT ĐANG GHI",
        value: m.buckets.length,
        color: "#0e7490",
        icon: "🧩",
      },
      {
        label: "60 GIÂY QUA",
        value: perMin,
        color: perMin > 120 ? "#dc2626" : "#16a34a",
        icon: "⚡",
      },
      {
        label: "TB/PHÚT (10' QUA)",
        value: avgPerMin.toFixed(1),
        color: "#d97706",
        icon: "⏱️",
      },
    ];

    const cardHtml = cards
      .map(
        (c) => `
      <div style="flex:1;min-width:160px;background:#fff;border:1px solid #dddfe2;border-radius:12px;padding:16px">
        <div style="font-size:12px;color:#606770;font-weight:700;letter-spacing:.3px">${c.icon} ${c.label}</div>
        <div style="font-size:30px;font-weight:800;color:${c.color};margin-top:6px;font-family:monospace">${c.value}</div>
      </div>`,
      )
      .join("");

    /* --- Bảng nhóm API --- */
    const groupRows = topEntries(m.byGroup)
      .map(([k, v]) => {
        const pct = (v / maxGroup) * 100;
        return `<tr>
        <td style="font-weight:700">${esc(k)}</td>
        <td style="font-family:monospace;text-align:right">${v}</td>
        <td style="width:35%">${bar(pct, "#1877f2")}</td>
        <td style="font-family:monospace;text-align:right;color:#606770">${((v / (m.total || 1)) * 100).toFixed(1)}%</td>
      </tr>`;
      })
      .join("");

    /* --- Bảng endpoint --- */
    const endpointRows = topDetailed(m.byEndpoint, 80)
      .map(
        ([k, v]) => `<tr>
        <td style="font-family:monospace;font-size:12px">${esc(k)}</td>
        <td style="font-family:monospace;text-align:right">${v.calls}</td>
        <td style="font-family:monospace;text-align:right;color:${v.errors ? "#dc2626" : "#8a8d91"}">${v.errors}</td>
      </tr>`,
      )
      .join("");

    /* --- Bảng resource Meta --- */
    const resourceRows = topDetailed(m.byResource, 30)
      .map(
        ([k, v]) => `<tr>
        <td style="font-weight:700">${esc(k)}</td>
        <td style="font-family:monospace;text-align:right">${v.calls}</td>
        <td style="font-family:monospace;text-align:right;color:${v.errors ? "#dc2626" : "#8a8d91"}">${v.errors}</td>
      </tr>`,
      )
      .join("");

    /* --- Bảng context / host --- */
    const contextRows = m.buckets
      .map(
        (b) => `<tr>
        <td><b>${esc(b.label || b.type)}</b><div style="font-size:11px;color:#8a8d91">${esc(b.type)}</div></td>
        <td style="font-family:monospace;text-align:right">${b.total || 0}</td>
        <td style="font-family:monospace;text-align:right;color:${b.errors ? "#dc2626" : "#8a8d91"}">${b.errors || 0}</td>
        <td style="font-size:11px;color:#606770">${fmtTime(b.updatedAt)}</td>
      </tr>`,
      )
      .join("");

    const hostRows = topEntries(m.byHost, 20)
      .map(
        ([k, v]) => `<tr>
        <td style="font-family:monospace;font-size:12px">${esc(k)}</td>
        <td style="font-family:monospace;text-align:right">${v}</td>
      </tr>`,
      )
      .join("");

    /* --- Log --- */
    const logRows = (m.log || [])
      .slice(0, 80)
      .map(
        (l) => `<tr>
        <td style="font-family:monospace;font-size:11px;color:#606770;white-space:nowrap">${fmtTime(l.ts)}</td>
        <td style="font-size:11px">${esc(l.src || "")}</td>
        <td style="font-family:monospace;font-size:11px;font-weight:700">${esc(l.method || "GET")}</td>
        <td style="font-family:monospace;font-size:11px;word-break:break-all">${esc(l.url || "")}</td>
        <td style="font-family:monospace;font-size:11px;text-align:right;color:${statusColor(l.status)};font-weight:700">${l.status || "ERR"}</td>
        <td style="font-family:monospace;font-size:11px;text-align:right">${l.ms ?? 0}ms</td>
      </tr>`,
      )
      .join("");

    root.innerHTML = `
      <!-- Thanh điều khiển -->
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:16px">
        <div style="flex:1;min-width:220px">
          <div style="font-size:12px;color:#606770;font-weight:700">
            NGÀY: ${esc(m.dayKey || "--")} · CẬP NHẬT: ${fmtTime(m.updatedAt)}
          </div>
          <div style="font-size:11px;color:#8a8d91">
            Bấm ⏹ Tạm dừng để dừng đếm toàn bộ context (Dashboard + Background + Popup).
            Vòng lặp nền (Telegram poll 5s, inbox poll 1–15s) cũng được tính — dùng để tìm vòng lặp gọi API.
          </div>
        </div>
        <button id="ac-toggle-pause" class="btn ${paused ? "btn-orange" : "btn-blue"}" style="padding:10px 18px">
          ${paused ? "▶ TIẾP TỤC ĐẾM" : "⏹ TẠM DỪNG ĐẾM"}
        </button>
        <button id="ac-reset" class="btn btn-red" style="padding:10px 18px">🔄 ĐẶT LẢI BỘ ĐẾM</button>
        <button id="ac-refresh" class="btn btn-green" style="padding:10px 18px">♻️ LÀM MỚI</button>
        <button id="ac-export" class="btn" style="padding:10px 18px;background:#8a8d91;color:#fff">⬇ XUẤT CSV</button>
      </div>

      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:18px">${cardHtml}</div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px">

        <div style="background:#fff;border:1px solid #dddfe2;border-radius:12px;padding:16px">
          <h3 style="margin:0 0 12px;color:#1877f2;font-size:15px">📊 THEO NHÓM API</h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="background:#f5f6f7">
              <th style="padding:8px;text-align:left">Nhóm</th>
              <th style="padding:8px;text-align:right">Lượt</th>
              <th style="padding:8px">Tỷ lệ</th>
              <th style="padding:8px;text-align:right">%</th>
            </tr></thead>
            <tbody>${groupRows || `<tr><td colspan="4" style="padding:14px;color:#8a8d91">Chưa có dữ liệu</td></tr>`}</tbody>
          </table>
        </div>

        <div style="background:#fff;border:1px solid #dddfe2;border-radius:12px;padding:16px">
          <h3 style="margin:0 0 12px;color:#1877f2;font-size:15px">🧩 THEO CONTEXT</h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="background:#f5f6f7">
              <th style="padding:8px;text-align:left">Context</th>
              <th style="padding:8px;text-align:right">Lượt</th>
              <th style="padding:8px;text-align:right">Lỗi</th>
              <th style="padding:8px;text-align:left">Cập nhật</th>
            </tr></thead>
            <tbody>${contextRows || `<tr><td colspan="4" style="padding:14px;color:#8a8d91">Chưa có dữ liệu</td></tr>`}</tbody>
          </table>

          <h3 style="margin:18px 0 10px;color:#1877f2;font-size:15px">🌐 THEO MÁY CHỦ</h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="background:#f5f6f7">
              <th style="padding:8px;text-align:left">Host</th>
              <th style="padding:8px;text-align:right">Lượt</th>
            </tr></thead>
            <tbody>${hostRows || `<tr><td colspan="2" style="padding:14px;color:#8a8d91">Chưa có dữ liệu</td></tr>`}</tbody>
          </table>
        </div>

        <div style="background:#fff;border:1px solid #dddfe2;border-radius:12px;padding:16px;grid-column:1/-1">
          <h3 style="margin:0 0 12px;color:#1877f2;font-size:15px">🎯 THEO ENDPOINT (đã che ID / access_token)</h3>
          <div style="max-height:340px;overflow:auto">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="background:#f5f6f7;position:sticky;top:0">
              <th style="padding:8px;text-align:left">Endpoint</th>
              <th style="padding:8px;text-align:right">Lượt</th>
              <th style="padding:8px;text-align:right">Lỗi</th>
            </tr></thead>
            <tbody>${endpointRows || `<tr><td colspan="3" style="padding:14px;color:#8a8d91">Chưa có dữ liệu</td></tr>`}</tbody>
          </table>
          </div>
        </div>

        <div style="background:#fff;border:1px solid #dddfe2;border-radius:12px;padding:16px">
          <h3 style="margin:0 0 12px;color:#1877f2;font-size:15px">🧬 THEO TÀI NGUYÊN META</h3>
          <div style="max-height:300px;overflow:auto">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="background:#f5f6f7;position:sticky;top:0">
              <th style="padding:8px;text-align:left">Resource</th>
              <th style="padding:8px;text-align:right">Lượt</th>
              <th style="padding:8px;text-align:right">Lỗi</th>
            </tr></thead>
            <tbody>${resourceRows || `<tr><td colspan="3" style="padding:14px;color:#8a8d91">Chưa có dữ liệu</td></tr>`}</tbody>
          </table>
          </div>
        </div>

        <div style="background:#fff;border:1px solid #dddfe2;border-radius:12px;padding:16px;grid-column:1/-1">
          <h3 style="margin:0 0 12px;color:#1877f2;font-size:15px">📜 NHẬT KÝ GỌI GẦN NHẤT (80 dòng)</h3>
          <div style="max-height:420px;overflow:auto">
          <table style="width:100%;border-collapse:collapse;font-size:11px">
            <thead><tr style="background:#f5f6f7;position:sticky;top:0">
              <th style="padding:6px;text-align:left">Lúc</th>
              <th style="padding:6px;text-align:left">Nguồn</th>
              <th style="padding:6px;text-align:left">Method</th>
              <th style="padding:6px;text-align:left">URL</th>
              <th style="padding:6px;text-align:right">Mã</th>
              <th style="padding:6px;text-align:right">ms</th>
            </tr></thead>
            <tbody>${logRows || `<tr><td colspan="6" style="padding:14px;color:#8a8d91">Chưa có dữ liệu</td></tr>`}</tbody>
          </table>
          </div>
        </div>

      </div>`;

    bindButtons();

    // Khôi phục vị trí cuộn sau khi vẽ lại
    root.querySelectorAll("div[style*='overflow']").forEach((el, i) => {
      if (scrollMemo[i]) el.scrollTop = scrollMemo[i];
    });
    window.scrollTo({ top: pageScroll });
  }

  /* ---------------------------------------------------------
   * NÚT BẤM
   * ------------------------------------------------------- */
  function bindButtons() {
    document
      .getElementById("ac-toggle-pause")
      ?.addEventListener("click", async () => {
        const next = !(merged?.paused ?? false);
        await chrome.storage.local.set({ [KEY_PAUSED]: next });
        merged.paused = next;
        // Áp cho mọi context qua message bridge
        try {
          await chrome.runtime.sendMessage({
            type: "api-counter:cmd",
            cmd: "pause",
            value: next,
          });
        } catch (e) {
          // không có context nào nhận thì bỏ qua
        }
        await refresh();
      });

    document.getElementById("ac-reset")?.addEventListener("click", async () => {
      if (!confirm("Đặt lại toàn bộ bộ đếm API? Số liệu hiện tại sẽ bị xóa."))
        return;
      const epoch = Date.now();
      await chrome.storage.local.set({ [KEY_EPOCH]: epoch });
      // Xóa luôn các bucket đã ghi (dựa trên registry, không đụng cache khác)
      const reg = await chrome.storage.local.get([KEY_REGISTRY]);
      const registry = Array.isArray(reg[KEY_REGISTRY]) ? reg[KEY_REGISTRY] : [];
      const removeKeys = registry.map((b) => PREFIX + b.instanceId);
      if (removeKeys.length) await chrome.storage.local.remove(removeKeys);
      try {
        await chrome.runtime.sendMessage({ type: "api-counter:cmd", cmd: "reset" });
      } catch (e) {}
      await refresh();
    });

    document.getElementById("ac-refresh")?.addEventListener("click", refresh);

    document.getElementById("ac-export")?.addEventListener("click", () => {
      const m = merged;
      if (!m) return;
      const rows = [["Nguồn", "Thời gian", "Method", "URL", "Mã", "ms"]];
      for (const l of m.log) {
        rows.push([
          l.src || "",
          new Date(l.ts).toLocaleString("vi-VN"),
          l.method || "",
          l.url || "",
          l.status || "",
          l.ms ?? 0,
        ]);
      }
      const csv = rows
        .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
        .join("\n");
      const blob = new Blob(["\uFEFF" + csv], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `api-calls-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
  }

  /* ---------------------------------------------------------
   * VÒNG LẶP LÀM MỚI (chỉ chạy khi mở tab đếm API)
   * ------------------------------------------------------- */
  async function refresh() {
    try {
      const res = await chrome.storage.local.get([KEY_PAUSED]);
      merged = await loadMerged();
      merged.paused = !!res[KEY_PAUSED];
      // Chỉ vẽ lại DOM khi tab Đếm API đang mở (tránh dựng lại DOM 3s/lần)
      const page = document.getElementById("page-apicount");
      if (page?.classList.contains("active-page")) render();
      updateNavBadge();
    } catch (e) {
      console.warn("[ApiCounter] refresh lỗi:", e);
    }
  }

  // Hiện số lượt gọi ngay trên icon sidebar (🔢) để kiểm tra nhanh
  function updateNavBadge() {
    const nav = document.getElementById("nav-apicount");
    if (!nav || !merged) return;
    const total = merged.total || 0;
    nav.dataset.count = String(total);
    nav.title = `Đếm Số Lần Gọi API — ${total} lượt hôm nay`;
    nav.style.boxShadow = total
      ? "0 0 0 2px rgba(24,119,242,.25)"
      : "none";
  }

  function start() {
    refresh();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refresh, 3000);
  }

  // Dừng vòng lặp khi người dùng rời khỏi tab
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
    } else if (!refreshTimer) {
      start();
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  // Cho phép gọi từ console: __apiCounterUi.refresh()
  window.__apiCounterUi = { refresh, start, getMerged: () => merged };
})();
