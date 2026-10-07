// ==============================================================================
// 🎯 Content Script: Tự động trích xuất Nhóm Quảng Cáo [N1], [N2]... từ Meta Suite
// ==============================================================================
(function () {
  console.log("🚀 [Ads Manager Pro] Content Inbox Script đã kích hoạt trên Meta Business Suite");

  const TAG_REGEX = /\[([A-Za-z0-9_\-]+)\]/i;
  let lastProcessedKey = "";

  // 1. Trích xuất ID cuộc hội thoại từ URL hoặc DOM
  function getSelectedConversationId() {
    try {
      const url = new URL(window.location.href);
      // Dạng 1: selected_item_id=t_1050008964865202_... hoặc selected_item_id=...
      const selectedItemId = url.searchParams.get("selected_item_id");
      if (selectedItemId) {
        // Chuẩn hóa bỏ tiền tố 't_' nếu có
        return selectedItemId.replace(/^t_/, "");
      }
      // Dạng 2: /messages/t/123456789
      const match = window.location.pathname.match(/\/messages\/t\/([^\/?#]+)/);
      if (match) return match[1];
    } catch (e) { }
    return "";
  }

  // 2. Quét DOM tìm thông tin Quảng cáo (Banner & Tin nhắn)
  function scanAdReferralInfo() {
    try {
      const convId = getSelectedConversationId();
      if (!convId) return;

      // Tìm tất cả các đoạn text có chứa thông tin quảng cáo hoặc đoạn chat
      // Thẻ banner "Đoạn chat này chứa tin trả lời quảng cáo của bạn" hoặc "Quảng cáo đã xem"
      const bodyText = document.body?.innerText || "";
      
      // Quét các phần tử chứa bài quảng cáo
      const candidateElements = document.querySelectorAll(
        'div[role="main"], div[aria-label*="quảng cáo" i], div[aria-label*="ad" i], div[data-testid], div'
      );

      let foundTag = null;
      let matchedSnippet = "";

      // Quét banner cụ thể
      const allTextNodes = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode())) {
        const txt = (node.nodeValue || "").trim();
        if (txt.length > 2 && txt.length < 500) {
          allTextNodes.push(txt);
        }
      }

      for (const txt of allTextNodes) {
        const match = txt.match(TAG_REGEX);
        if (match) {
          const tag = match[1].toUpperCase();
          // Lọc các tag hợp lệ dạng N1, N2, JP1, COMBO1...
          if (/^(N\d+|JP\d+|M\d+|CAMP\d+|[A-Z0-9_\-]+)$/i.test(tag)) {
            foundTag = tag;
            matchedSnippet = txt;
            break;
          }
        }
      }

      if (foundTag) {
        const processKey = `${convId}_${foundTag}`;
        if (processKey === lastProcessedKey) return;
        lastProcessedKey = processKey;

        console.log(`🎯 [Ads Manager Pro] Tìm thấy Tag [${foundTag}] cho hội thoại: ${convId}`);
        console.log(`📝 Đoạn text trích xuất: "${matchedSnippet}"`);

        // Lưu vào chrome.storage.local
        chrome.storage.local.get(["inboxAdsetMapping"], (res) => {
          const mapping = res.inboxAdsetMapping || {};
          mapping[convId] = {
            tag: foundTag,
            fullTag: `[${foundTag}]`,
            snippet: matchedSnippet,
            updatedAt: Date.now()
          };
          chrome.storage.local.set({ inboxAdsetMapping: mapping }, () => {
            console.log(`✅ [Ads Manager Pro] Đã lưu mapping [${foundTag}] cho conv ${convId}`);
          });
        });

        // Bắn tin nhắn trực tiếp tới Background / Dashboard
        chrome.runtime.sendMessage({
          type: "SYNC_CONV_ADSET_TAG",
          conversationId: convId,
          tag: foundTag,
          fullTag: `[${foundTag}]`,
          snippet: matchedSnippet
        }).catch(() => {});
      }
    } catch (err) {
      console.warn("Lỗi scan ad referral:", err);
    }
  }

  // Chạy định kỳ và lắng nghe thay đổi DOM
  setInterval(scanAdReferralInfo, 2500);

  const observer = new MutationObserver(() => {
    scanAdReferralInfo();
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }
})();
