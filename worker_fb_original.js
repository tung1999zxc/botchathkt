/**
 * Cloudflare Worker — FB Token Swap
 * Endpoint:
 *   GET /login?appId=XXX                  → redirect user tới Facebook OAuth (response_type=code)
 *   GET /callback?code=YYY&state=ZZZ      → đổi code → long-lived token → trả HTML auto-redirect về extension
 *   GET /refresh?token=LLL                → gia hạn long-lived token (còn <60 ngày) → token mới 60 ngày
 *
 * Cấu hình biến môi trường trong Cloudflare Dashboard:
 *   FB_APP_ID       : App ID của bạn
 *   FB_APP_SECRET   : App Secret
 *   REDIRECT_URI    : https://<worker-subdomain>.workers.dev/callback
 *   EXT_ORIGIN      : chrome-extension://<EXTENSION_ID>
 */

const FB_GRAPH = "https://graph.facebook.com/v25.0";

const HTML_ESC = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

function jsonResponse(data, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function handleOptions(request) {
  const origin = request.headers.get("Origin") || "*";
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

async function exchangeCodeForLongLivedToken(code, appId, appSecret, redirectUri) {
  // Bước 1: code → short-lived token
  const s1 = await fetch(
    `${FB_GRAPH}/oauth/access_token?` +
      new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      }),
  );
  const d1 = await s1.json();
  if (d1.error) throw new Error(d1.error.message);
  const shortToken = d1.access_token;

  // Bước 2: short-lived → long-lived (60 ngày)
  const s2 = await fetch(
    `${FB_GRAPH}/oauth/access_token?` +
      new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortToken,
      }),
  );
  const d2 = await s2.json();
  if (d2.error) throw new Error(d2.error.message);

  return {
    access_token: d2.access_token,
    token_type: d2.token_type || "bearer",
    expires_in: d2.expires_in || 5184000,
  };
}

async function refreshLongLivedToken(token, appId, appSecret) {
  const s = await fetch(
    `${FB_GRAPH}/oauth/access_token?` +
      new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: token,
      }),
  );
  const d = await s.json();
  if (d.error) throw new Error(d.error.message);
  return {
    access_token: d.access_token,
    token_type: d.token_type || "bearer",
    expires_in: d.expires_in || 5184000,
  };
}

async function debugToken(token, appId, appSecret) {
  const s = await fetch(
    `${FB_GRAPH}/debug_token?` +
      new URLSearchParams({
        input_token: token,
        access_token: `${appId}|${appSecret}`,
      }),
  );
  const d = await s.json();
  return d.data || {};
}

function buildLoginUrl(appId, redirectUri, state) {
  const scope = [
    "pages_show_list",
    "pages_manage_metadata",
    "pages_manage_roles",
    "business_management",
    "pages_messaging",
    "ads_read",
    "ads_management",
  ].join(",");

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    state,
  });
  return `https://www.facebook.com/v25.0/dialog/oauth?${params}`;
}

function successHtml(tokenData, extOrigin) {
  const safeOrigin = HTML_ESC(extOrigin || "");
  const tokenJson = JSON.stringify({
    ok: true,
    access_token: tokenData.access_token,
    expires_in: tokenData.expires_in,
    token_type: tokenData.token_type,
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Đang chuyển về Extension...</title>
<style>body{font-family:system-ui;background:#f4f6fa;margin:0;padding:40px;text-align:center}
.box{max-width:480px;margin:auto;background:#fff;padding:32px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.08)}
h1{color:#1877f2;margin:0 0 16px}
p{color:#555;line-height:1.6}
.btn{display:inline-block;background:#1877f2;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;margin-top:16px;font-weight:600}
.err{color:#c0392b;background:#fdecea;padding:12px;border-radius:8px;margin-top:16px;word-break:break-all}</style>
</head><body><div class="box">
<h1>✅ Lấy token thành công</h1>
<p>Token 60 ngày đã sẵn sàng. Extension sẽ tự đóng tab này trong giây lát.</p>
<p>Nếu không tự đóng, bấm nút bên dưới:</p>
<a class="btn" id="cbBtn">📥 MỞ EXTENSION</a>
</div>
<script>
(function(){
  var data = ${tokenJson};
  var origin = ${JSON.stringify(safeOrigin)};
  function fallback(){
    document.body.innerHTML = '<div class="box"><h1>❌ Không tự chuyển được</h1><p>Tab không tự đóng được. Hãy copy token bên dưới và dán vào extension:</p><div class="err"><code>' + data.access_token + '</code></div></div>';
  }
  if (window.opener && !window.opener.closed) {
    try { window.opener.postMessage({type:'FB_LONG_TOKEN', payload:data}, origin || '*'); setTimeout(function(){window.close()}, 800); return; } catch(e){}
  }
  if (origin && origin.startsWith('chrome-extension://')) {
    try { chrome.runtime.sendMessage ? chrome.runtime.sendMessage(origin, data) : null; } catch(e){}
    var u = origin + '/dashboard.html?fb_token=' + encodeURIComponent(data.access_token) + '&fb_expires_in=' + data.expires_in;
    document.getElementById('cbBtn').href = u;
    setTimeout(function(){ try { window.location.href = u; } catch(e){} }, 1200);
  } else {
    fallback();
  }
})();
</script>
</body></html>`;
}

async function handle(request, env) {
  const appId = env.FB_APP_ID;
  const appSecret = env.FB_APP_SECRET;
  const redirectUri = env.REDIRECT_URI;
  const extOrigin = env.EXT_ORIGIN || "";

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const origin = request.headers.get("Origin") || "*";

  if (request.method === "OPTIONS") return handleOptions(request);

  // ===== /login =====
  if (path === "/login" || path === "/") {
    if (!appId) {
      return new Response("Server chưa cấu hình FB_APP_ID", { status: 500 });
    }
    const state = crypto.randomUUID();
    const loginUrl = buildLoginUrl(appId, redirectUri, state);
    return Response.redirect(loginUrl, 302);
  }

  // ===== /callback =====
  if (path === "/callback") {
    const code = url.searchParams.get("code");
    const errParam = url.searchParams.get("error_description") || url.searchParams.get("error");
    if (errParam) {
      return htmlResponse(
        `<!doctype html><html><body style="font-family:system-ui;padding:40px;text-align:center">
        <h1 style="color:#c0392b">❌ Facebook báo lỗi</h1>
        <p>${HTML_ESC(errParam)}</p>
        <p>Vui lòng kiểm tra App đã Live chưa và Redirect URI đúng chưa.</p>
        </body></html>`,
        400,
      );
    }
    if (!code) {
      return new Response("Missing code", { status: 400 });
    }
    try {
      const tokenData = await exchangeCodeForLongLivedToken(
        code,
        appId,
        appSecret,
        redirectUri,
      );
      const debug = await debugToken(tokenData.access_token, appId, appSecret).catch(() => ({}));
      const scopes = debug.scopes || [];
      const html = successHtml(
        { ...tokenData, scopes },
        extOrigin,
      );
      return htmlResponse(html);
    } catch (e) {
      return htmlResponse(
        `<!doctype html><html><body style="font-family:system-ui;padding:40px;text-align:center">
        <h1 style="color:#c0392b">❌ Lỗi đổi token</h1>
        <p>${HTML_ESC(e.message)}</p>
        </body></html>`,
        500,
      );
    }
  }

  // ===== /refresh =====
  if (path === "/refresh") {
    const token = url.searchParams.get("token");
    if (!token) {
      return jsonResponse({ ok: false, error: "missing token" }, 400, origin);
    }
    try {
      const tokenData = await refreshLongLivedToken(token, appId, appSecret);
      return jsonResponse({ ok: true, ...tokenData }, 200, origin);
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, 500, origin);
    }
  }

  // ===== /info =====
  if (path === "/info") {
    return jsonResponse(
      {
        ok: true,
        fb_app_id: appId,
        redirect_uri: redirectUri,
        ext_origin: extOrigin,
        endpoints: ["/login", "/callback", "/refresh"],
      },
      200,
      origin,
    );
  }

  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    return handle(request, env);
  },
};
