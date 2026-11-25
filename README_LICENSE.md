# HUONG DAN SU DUNG HE THONG LICENSE KEY

Tay ban ghi san: bat buoc nhap key ban quyen truoc khi dung extension. Ban la nguoi tao va quan tri key.

> **DA TRIEN KHAI XONG**
> - License Server: `https://botchathkt.tung1999zxc.workers.dev`
> - Trang quan tri: `https://botchathkt.tung1999zxc.workers.dev/admin`
> - Worker: `botchathkt` | KV Namespace: `license-kv` (ID `0568ad83a0b74ab094d69bcc20b2f610`)
> - Extension da tro mac dinh ve server nay (`DEFAULT_SERVER_URL` trong `license_core.js`)
> - Nguoi dung khong can nhap dia chi server - chi nhap key.

---

## 1. TONG QUAN

He thong gom 4 phan:

| File | Vai tro |
| --- | --- |
| `worker.js` | Cloudflare Worker: chua ca FB Token Swap, License Server va trang quan tri |
| `license_core.js` | Module loi dung chung (nap o dashboard + background) |
| `license_gate.js` | Canh gac tren UI: hien overlay chan, xu ly kich hoat |
| `dashboard.html` | Da them overlay + badge trang thai |

**Luong hoat dong:**

```
Nguoi dung mo extension
   -> license_gate.js kiem tra chrome.storage.local
   -> Da co key hop le? -> BO OVERLAY, chay binh thuong
   -> Chua co / het han / bi thu hoi? -> HIEN OVERLAY, chan toan man hinh
   -> Nguoi dung nhap key -> goi /license/activate -> luu -> mo khoa
```

---

## 2. PHIA BAN (ADMIN) - 3 BUOC

### Buoc 1: Tao KV Namespace

1. Vao https://dash.cloudflare.com
2. Menu **Storage & Databases** > **KV** > **Create Instance**
3. Ten: `license-kv` > **Add**
4. Mo namespace vua tao > **Settings** > copy **KV Namespace ID** (chuoi 32 ky tu hex)
   - Neu ban da tao san `license-kv` thi lay ID cua namespace do
   - ID hien tai cua repo: xem trong `wrangler.toml`
### Buoc 2: Gan bien moi truong cho Worker

Vao **Workers & Pages** > worker cua ban > **Settings** > **Bindings** > **Add**:

| Binding | Type | Name |
| --- | --- | --- |
| KV Namespace | KV Namespace | `LICENSE_KV` |

Vao **Settings** > **Variables and Secrets** > **Add**:

| Bien | Gia tri | Loai |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Mat khau cua ban vao trang quan tri | **Secret** |
| `FB_APP_ID` | App ID Facebook (da co san) | Variable |
| `FB_APP_SECRET` | App Secret Facebook (da co san) | Secret |
| `REDIRECT_URI` | `https://botchathkt.tung1999zxc.workers.dev/callback` | Variable |
| `EXT_ORIGIN` | `chrome-extension://<ID>` | Variable |

> `ADMIN_PASSWORD` BAT BUOC dat dang **Secret**. Dat trong code thi bat ky ai cung doc duoc.

### Buoc 3: Deploy

Repo da co san `wrangler.toml` + `package.json` + `.github/workflows/deploy.yml`.

**Cach A - GitHub Actions (khuyen nghi, ban dang dung cach nay)**

1. GitHub > **Settings** > **Secrets and variables** > **Actions** > **New repository secret**
2. Tao 2 secret:
   - `CLOUDFLARE_API_TOKEN` — Cloudflare API Token
   - `CLOUDFLARE_ACCOUNT_ID` — Account ID cua ban
3. Push code len `main` -> GitHub Actions tu dong deploy

**Lay API Token:**
Cloudflare Dashboard > My Profile > **API Tokens** > **Create Token** > chon template **Edit Cloudflare Workers** > Account Resources chon account cua ban > Client IP giu trong `0.0.0.0/0` > **Create Token** > copy.

**Lay Account ID:**
Cloudflare Dashboard > **Workers & Pages** > `license-kv` > **Settings** > **Account ID**.

**Cach B - Cloudflare Workers Builds (tu dong theo git)**

Cloudflare Dashboard > Workers & Pages > `license-kv` > **Settings** > **Builds** > **Connect to Git** > chon repo > branch `main`.
> Cach nay can `wrangler.toml` co dung `name` va `main`. Cach A it rui ro hon vi ban tu control.

**Cach C - Cai dat truc tiep tren may**

```bash
npm install
npx wrangler login
npx wrangler deploy
```

**Kiem tra sau khi deploy:**
```
https://botchathkt.tung1999zxc.workers.dev/license/ping
```
Phai tra JSON: `{"ok":true,"service":"license-server","hasKv":true,"hasAdmin":true}`

Neu `hasKv` hoac `hasAdmin` la `false` -> quay lai Buoc 2.

**Trang quan tri:**
```
https://botchathkt.tung1999zxc.workers.dev/admin
```

---

## 3. QUAN TRI KEY

Mo `https://botchathkt.tung1999zxc.workers.dev/admin` -> nhap mat khau -> dang nhap.

### Tao key

Chon goi thoi han, so may toi da, ghi chu -> **TAO KEY**.

| Goi | Han su dung |
| --- | --- |
| 7 ngay | 7 ngay |
| 30 ngay | 30 ngay |
| Vo han | Khong hieu luc (dung cho test/doi tra) |
| Tuy chinh | So ngay bat ky (1-3650) |

Key co dang: `TL_Z9EA-91M5-WGDE-9GMR`

> **Quan trong:** Key chi hien thi MOT lan ngay khi tao. Luu lai ngay. Server luoi bang SHA-256 nen khong the xem lai key da tao - chi thay duoi dang `TL_Z9EA...`.

### Bang quan tri

| Cot | Y nghia |
| --- | --- |
| KEY | 7 ky tu dau, du de phan biet |
| GOI | Goi thoi han da tao |
| TRANG THAI | Hoat dong / Het han / Da thu hoi |
| HET HAN | Ngay hien han cuoi |
| MAY | So may da kich hoat / toi da + danh sach chi tiet |
| GHI CHU | Ghi chu cua ban |

### Thao tac

| Nut | Tac dung |
| --- | --- |
| **THU HOI** | Vo hieu hoa key ngay. User bi chan o lan xac minh tiep theo (toi da 24h) hoac ngay khi mo extension |
| **KICH HOAT LAI** | Bo thu hoi, key chay lai |
| **GIA HAN** | Cong them N ngay vao han cu |
| **GO MAY** | Xoa 1 may khoi key -> may do kich hoat lai duoc |
| **XOA** | Xoa vinh vien key (khong khoi phuc) |

---

## 4. PHA NGUOI DUNG

1. Cai extension -> bam icon -> dashboard mo ra
2. Overlay **KICH HOAT TOOL TL_** hien len, che toan man hinh
3. **Ma may** hien o tren - gui ma nay cho ban de tao key
4. Nhap key (server mac dinh da tro san ve `botchathkt`, khong can nhap dia chi)
5. Bam **KICH HOAT NGAY** -> xac nhan -> dashboard mo binh thuong

Sau khi kich hoat, o goc phai duoi co badge: `License: con 30 ngay`. Bam **Quan tri key** de doi key moi.

---

## 5. KIEM TRA NHANH (khong can deploy)

Chay test truc tiep tren may ban:

```bash
node _test_license.js
```

Kiem tra Worker + license API + trang admin (42 assertions).

```bash
node _test_core.js
```

Kiem tra module phia client tren trinh duyet gia lap (30 assertions).

Cau hinh chay:
```
KET QUA: 42 PASS / 0 FAIL
KET QUA: 30 PASS / 0 FAIL
```

---

## 6. PHONG TOAN BI QUAN TRONG

### 6.1 Key KHONG luoi plaintext trong database

Server luoi `sha256(key)` lam dinh danh tra cuu, kem `keyPrefix` 7 ky tu de ban nhin ra key nao la gi.

Neu database bi lo, ban KHONG khoi phuc duoc key cua khach - chi thay duoi dang `TL_Z9EA...`. Do do:
- Key bi lo -> phai tao key moi cho khach
- Ban KHONG the "xem lai" key da cap

### 6.2 Token bot Telegram trong code

`telegram_config.js` dang hardcode `DEFAULT_BOT_TOKEN`. Bat ky ai unpack extension deu doc duoc. Neu dung bot de quan tri key -> **tach ra**, dat token tren Worker.

### 6.3 Fail-open khi mat mang

Extension KHONG khoa nguoi dung khi mat mang. Chi khi server tra loi "dung khop" (revoked / expired / invalid) moi chan.

Ly do: neu fail-closed, moi lan server ban gap loi la toan bo khach mat tool. Loi mang != key khong hop le.

### 6.4 Rate limit

- 20 lan kich hoat / 10 phut / IP
- 5 lan thu key sai -> khoa key tam thoi 15 phut

Chong brute-force key.

### 6.5 Gioi han so may

Mac dinh 1 may/key. Khi user go may cu vao may moi, server bao `max_devices`. Ban co the **GO MAY** trong trang quan tri de release cho may moi.

---

## 7. VAN DE THUONG GAP

| Loi | Nguyen nhan | Cach sua |
| --- | --- | --- |
| `Khong ket noi duoc server` | Server khong phai hoac extension chua co `DEFAULT_SERVER_URL` | Kiem tra `https://botchathkt.tung1999zxc.workers.dev/license/ping` |
| `Key khong ton tai` | Key sai hoac da xoa | Kiem tra lai key da cap |
| `Key da het han` | Qua han | Gia han trong trang quan tri |
| `Key da bi thu hoi` | Ban da thu hoi | Tao key moi |
| `Key nay da kich hoat du 1 may` | Da dung tren may khac | GO MAY trong trang quan tri |
| `Key dang bi khoa tam thoi` | 5 lan nhap sai | Do 15 phut |
| `hasKv: false` khi ping | Chua binding KV | Them binding `LICENSE_KV` |
| `hasAdmin: false` khi ping | Chua dat `ADMIN_PASSWORD` | Them Secret |
| Overlay khong an sau khi kich hoat | Server tra loi loi | Mo Console dashboard xem loi |

---

## 8. SAU KHI KHACH HANG UPDATE CHROME

Fingerprint chuan hoa nen Chrome update khong lam vo key. Tuy nhien neu user doi **may** (cai lai Windows, doi may) -> fingerprint doi -> can kich hoat lai key tren may moi. Ban go may cu trong trang quan tri truoc do.

---

## 9. HAN DONG THUONG TRUONG (KHUYEN NGHI)

| Han | Tac dong |
| --- | --- |
| Thu hoi key | User bi chan ngay lan xac minh tiep theo |
| Doi `ADMIN_PASSWORD` | Phai doi `ADMIN_PASSWORD` tren Worker roi **Save and Deploy** lai |
| Muon doi dia chi server | Doi `workerUrl` trong dashboard (nut lay token) hoac nhap o overlay |

---

## 10. GHI CHU VE GIAO DIEN

Badge `License: con N ngay` hien o goc phai duoi cua dashboard.

Nut **Quan tri key** trong badge mo hop thoai de:
- Xem ma may
- Doi key moi (cho phep doi key ma khong can go lai trang admin)
