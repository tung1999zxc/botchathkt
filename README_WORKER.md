# Cloudflare Worker — FB Token Swap (60 ngày)

Worker này giúp lấy **long-lived token Facebook 60 ngày** (thay vì ~2 giờ).
Extension sẽ gọi worker này khi bấm nút **🔑 LẤY TOKEN ĐẦY ĐỦ QUYỀN**.

## Ưu điểm

- **Miễn phí** (100k request/ngày — dư sức dùng cá nhân)
- Không cần mua server
- Có thể deploy trong 2 phút
- Token tự động refresh khi còn <7 ngày

## Endpoint

| Đường dẫn | Mô tả |
| --- | --- |
| `GET /login` | Redirect sang Facebook OAuth (`response_type=code`) |
| `GET /callback?code=...` | Đổi code → long-lived token (60 ngày) |
| `GET /refresh?token=...` | Gia hạn token còn hạn → token mới 60 ngày |
| `GET /info` | Kiểm tra cấu hình |

## Deploy (một lần duy nhất)

### 1. Tạo Worker

1. Đăng nhập https://dash.cloudflare.com (tài khoản miễn phí)
2. Vào **Workers & Pages** → **Create** → **Create Worker**
3. Đặt tên (ví dụ `fb-token-sap`) → **Deploy**
4. Vào **Edit Code** → xóa hết → paste toàn bộ nội dung file `worker.js` → **Save and Deploy**

### 2. Lấy URL Worker

Sau khi deploy, URL sẽ có dạng:
```
https://fb-token-sap.<TÊN_CỦA_BẠN>.workers.dev
```
Copy URL này.

### 3. Lấy App ID + App Secret

1. Vào https://developers.facebook.com/apps/ → chọn App của bạn
2. **Settings → Basic** → copy **App ID**
3. Bấm **Show** ở **App Secret** → copy

### 4. Thêm Redirect URI hợp lệ

Trong App Facebook → **Facebook Login → Settings** → ở **Valid OAuth Redirect URIs** thêm:
```
https://fb-token-sap.<TÊN_CỦA_BẠN>.workers.dev/callback
```
(Phải khớp chính xác URL Worker + `/callback`)

### 5. Cấu hình biến môi trường cho Worker

Trong Cloudflare Dashboard → **Workers → fb-token-sap → Settings → Variables** → **Add variable**:

| Biến | Giá trị |
| --- | --- |
| `FB_APP_ID` | App ID (số) |
| `FB_APP_SECRET` | App Secret |
| `REDIRECT_URI` | URL Worker + `/callback` (chính xác như bước 4) |
| `EXT_ORIGIN` | (tùy chọn) `chrome-extension://<EXTENSION_ID>` — lấy EXT_ID từ `chrome://extensions` |

Sau đó **Save and Deploy** lại Worker.

### 6. Test nhanh

Mở trình duyệt, gõ:
```
https://fb-token-sap.<TÊN>.workers.dev/info
```
→ phải trả JSON với `fb_app_id` và `redirect_uri` đúng như đã cấu hình.

## Dùng trong extension

1. Mở extension → bấm **🔑 LẤY TOKEN ĐẦY ĐỦ QUYỀN**
2. Lần đầu sẽ hỏi URL Worker → paste `https://fb-token-sap.<TÊN>.workers.dev`
3. Tab Facebook mở → chọn tài khoản → cấp quyền → tab tự đóng
4. Token 60 ngày được lưu vào extension + alert xác nhận

## Auto-refresh

Mỗi lần mở tool (hoặc trước khi share page), extension sẽ kiểm tra:
- Token còn ≥ 7 ngày → dùng tiếp
- Token còn < 7 ngày → tự gọi `/refresh` → token mới 60 ngày (lưu đè)

Không cần làm gì thêm.

## Bảo mật

- `FB_APP_SECRET` là bí mật — chỉ lưu trong Worker, không bao giờ gửi về extension
- Worker chỉ xử lý 3 endpoint, không log token ra ngoài
- Nếu lo lắng: thêm `Access-Control-Allow-Origin` whitelist chỉ cho phép extension ID của bạn

## Sự cố thường gặp

| Lỗi | Nguyên nhân / Cách sửa |
| --- | --- |
| `Can't load URL: domain not allowed` | Thêm URL Worker vào Valid OAuth Redirect URIs trong App Facebook |
| `Missing authorization` / lỗi app | App đang ở Development mode → bật Live mode |
| `Invalid redirect_uri` | REDIRECT_URI trong Worker ≠ Redirect URI trong App Facebook (phải khớp chính xác) |
| Token trả về nhưng chưa thấy `pages_manage_roles` | User chưa tick scope đó → cần thoát Facebook rồi thử lại, hoặc revoke app tại https://www.facebook.com/settings?tab=applications |

## Xóa Worker khi không dùng nữa

Cloudflare Dashboard → Workers → chọn Worker → **Delete**.
