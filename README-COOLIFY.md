# Panduan Deployment Coolify: WhatsApp AI Bot (Baileys + Gemini)

Panduan lengkap untuk men-deploy BalayBalay WhatsApp AI Bot pada platform **Coolify** di Ubuntu VPS menggunakan koneksi **Baileys WebSocket** dan **Google Gemini AI**.

---

## 1. Arsitektur Deployment

- **Container**: Node.js 22 (Alpine)
- **WhatsApp**: Direct WebSocket via `@whiskeysockets/baileys`
- **AI**: `@google/genai` (default: `gemini-3.7-flash`)
- **Port**: `3000` (HTTPS via Coolify Traefik reverse proxy)
- **Domain**: `https://wa.balaybalay.sbs`
- **Persistent Storage**: `/app/data` (menyimpan session auth WhatsApp multi-file)

---

## 2. Persiapan Persistent Storage (PENTING ⚠️)

Sesi login WhatsApp disimpan pada path container:
```
/app/data/wa-auth
```
**Jika persistent storage tidak dikonfigurasi, sesi login akan terhapus setiap kali aplikasi di-restart atau di-deploy ulang, mengharuskan Anda scan QR ulang!**

### Cara Menambahkan Persistent Storage di Coolify:
1. Buka dashboard **Coolify** Anda.
2. Masuk ke project / resource bot Anda (`wa.balaybalay.sbs`).
3. Pilih tab **Storages** (atau **Persistent Storage**).
4. Klik **Add Storage** / **New Persistent Storage**.
5. Isi konfigurasi:
   - **Name**: `wa-data`
   - **Destination (Container Path)**: `/app/data`
6. Klik **Save**.

---

## 3. Konfigurasi Environment Variables di Coolify

Masuk ke tab **Environment Variables** di resource Coolify Anda, lalu masukkan variabel berikut:

```env
NODE_ENV=production
PORT=3000

# WhatsApp Provider & Storage
WHATSAPP_PROVIDER=baileys
WHATSAPP_AUTH_DIR=/app/data/wa-auth

# Keamanan QR Login (Buat token acak yang kuat)
ADMIN_TOKEN=buat_token_rahasia_anda_disini_123456

# Google Gemini AI (dari Google AI Studio)
GEMINI_API_KEY=AIzaSy...
GEMINI_MODEL=gemini-3.7-flash
GEMINI_FALLBACK_MODEL=

# Perilaku Bot
RESPOND_IN_PRIVATE=true
MAX_INPUT_CHARS=8000
MAX_HISTORY_MESSAGES=10

# System Prompt Kustom (Opsional)
SYSTEM_PROMPT=Kamu adalah asisten WhatsApp yang ramah, ringkas, dan cerdas.
```

> ⚠️ **Catatan Penting Keamanan:**
> - `GEMINI_API_KEY` berasal dari [Google AI Studio](https://aistudio.google.com/), bukan VPSMurah.
> - Buat `ADMIN_TOKEN` yang sulit ditebak untuk mencegah pihak lain mengakses QR code WhatsApp Anda.

---

## 4. Konfigurasi Domain & Build Pack

1. Di tab **Configuration**:
   - **Build Pack**: `Docker` atau `Railpack` (Dockerfile sudah disediakan di root repository).
   - **Port**: `3000`
2. Di bagian **Domains**:
   - Isi: `https://wa.balaybalay.sbs`
   - Aktifkan auto-SSL (Let's Encrypt).

---

## 5. Deployment & Login Pairing WhatsApp

1. Klik tombol **Deploy** di Coolify.
2. Tunggu hingga proses build dan startup container selesai.
3. Buka URL health check untuk memastikan bot berjalan:
   ```
   https://wa.balaybalay.sbs/health
   ```
   Response awal akan menampilkan:
   ```json
   {
     "status": "ok",
     "whatsappProvider": "baileys",
     "whatsappConnected": false,
     "pairingRequired": true,
     "uptime": 10.2
   }
   ```
4. Buka halaman QR login yang dilindungi token rahasia:
   ```
   https://wa.balaybalay.sbs/admin/qr?token=ADMIN_TOKEN_ANDA
   ```
   *(Ganti `ADMIN_TOKEN_ANDA` sesuai token yang Anda atur di Coolify)*
5. Ambil ponsel yang memiliki nomor WhatsApp bot Anda:
   - Buka WhatsApp.
   - Masuk ke **Pengaturan (Settings)** > **Perangkat Tertaut (Linked Devices)**.
   - Klik **Tautkan Perangkat (Link a Device)**.
   - Arahkan kamera ponsel ke QR Code yang tampil di layar.
6. Setelah berhasil, halaman `/admin/qr` otomatis me-refresh dan menampilkan:
   ```json
   {
     "connected": true
   }
   ```
   Dan endpoint `/health` akan menampilkan:
   ```json
   {
     "status": "ok",
     "whatsappProvider": "baileys",
     "whatsappConnected": true,
     "pairingRequired": false,
     "uptime": 65.4
   }
   ```

Sesi Anda sekarang tersimpan aman di volume `/app/data/wa-auth` dan tetap bertahan meskipun container di-redeploy!

---

## 6. Verifikasi & Pengujian Bot

1. **Private Chat**: Kirim pesan langsung ke nomor bot di WhatsApp. Bot akan menjawab secara otomatis.
2. **Group Chat**: Masukkan bot ke grup. Bot **hanya** akan menjawab saat bot di-mention (`@NomorBot pertanyaan kamu`). Jawaban akan dikirimkan ke dalam grup.
3. **Anti-Duplikat**: Kirim pesan yang sama secara berulang; idempotency cache mencegah bot memproses pesan ganda.

---

## 7. Monitoring & Log

Cek log aplikasi melalui tab **Logs** di Coolify. Log didesain aman dan tidak akan menampilkan API key, kredensial auth, maupun session secret:

- `[WHATSAPP] Connecting`
- `[WHATSAPP] QR ready`
- `[WHATSAPP] Connected`
- `[WHATSAPP] Message received`
- `[GEMINI] Generating response`
- `[WHATSAPP] Reply sent`
- `[WHATSAPP] Connection closed`
