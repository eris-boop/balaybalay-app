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

## 3. Setup PostgreSQL Resource di Coolify (Persistent Long-Term Memory)

Bot WhatsApp ini menggunakan **PostgreSQL internal** di VPS/Coolify yang sama untuk menyimpan conversation history, long-term memory summary, dan full-text search tanpa memerlukan database cloud eksternal.

### Langkah-langkah Pembuatan Database PostgreSQL:
1. Buka dashboard **Coolify** Anda.
2. Masuk ke **Project** yang sama dengan aplikasi bot WhatsApp Anda.
3. Klik tombol **+ New Resource**.
4. Pilih kategori **Database**.
5. Pilih **PostgreSQL**.
6. Isi konfigurasi database (misalnya Database Name: `balaybalay`).
7. **JANGAN centang "Expose to public internet"** (Port 5432 tidak perlu dibuka ke publik; bot dan database terhubung melalui internal Docker network Coolify).
8. Pastikan **Persistent Volume** PostgreSQL aktif (secara default sudah aktif di Coolify agar data tidak hilang saat restart/redeploy).
9. Klik **Deploy** pada resource PostgreSQL Anda.
10. Setelah status PostgreSQL *Running*, buka tab **General** atau **Environment Variables** pada resource PostgreSQL tersebut.
11. Salin **Internal Connection String** (format: `postgresql://USER:PASSWORD@INTERNAL_HOST:5432/balaybalay`).
12. Masuk kembali ke resource aplikasi bot WhatsApp Anda > tab **Environment Variables**, dan masukkan nilai tersebut ke variable `DATABASE_URL`.

---

## 4. Konfigurasi Environment Variables di Coolify

Masuk ke tab **Environment Variables** di resource bot Coolify Anda, lalu masukkan variabel berikut:

```env
NODE_ENV=production
PORT=3000

# WhatsApp Provider & Storage
WHATSAPP_PROVIDER=baileys
WHATSAPP_AUTH_DIR=/app/data/wa-auth

# Keamanan Admin Diagnostics & Memory Management
ADMIN_TOKEN=buat_token_rahasia_anda_disini_123456

# PostgreSQL Database (Coolify Internal Resource)
DATABASE_URL=postgresql://postgres:password123@balaybalay-postgres:5432/balaybalay

# Shared Global Memory (Cross-Chat Cross-Group Knowledge)
GLOBAL_MEMORY_ENABLED=true
GLOBAL_MEMORY_CROSS_CHAT=true
GLOBAL_MEMORY_SCOPE=shared_global
GLOBAL_MEMORY_RETRIEVAL_LIMIT=12
GLOBAL_MEMORY_SUMMARY_AFTER_MESSAGES=50
GLOBAL_MEMORY_SUMMARY_KEEP_RECENT=30

# Per-Chat Memory & History
MAX_HISTORY_MESSAGES=25
MEMORY_SUMMARY_ENABLED=true
MEMORY_SUMMARY_AFTER_MESSAGES=30
MEMORY_SUMMARY_KEEP_RECENT=20
MEMORY_RETRIEVAL_ENABLED=true
MEMORY_RETRIEVAL_LIMIT=10
MEMORY_MAX_CONTEXT_CHARS=22000

# Group Archival Policy
GROUP_STORE_PROCESSED_MESSAGES=true
GROUP_ARCHIVE_ALL_TEXT=false

# Profanity Filter (Bot Output Masking)
PROFANITY_FILTER_ENABLED=true
PROFANITY_FILTER_MODE=mask
PROFANITY_EXTRA_WORDS=

# AI Provider Configuration (VPSMurah OpenAI-Compatible Smart Router)
AI_PROVIDER=vpsmurah
VPSMURAH_AI_BASE_URL=https://my.vpsmurah.co.id/api/v1
VPSMURAH_AI_API_KEY=vps_ai_live_...

# Smart Category Chains (Gemini top priority)
AI_GENERAL_CHAIN=gemini-38,qwen3-flash,gpt-5-mini,gemini-37,gemini-36,gpt-4o-mini,mistral-small
AI_CODING_CHAIN=qwen3-coder,gemini-38,gpt-53-codex,deepseek-coder,codestral,gpt-5-mini
AI_REASONING_CHAIN=gemini-38,qwen3-plus,gpt-5-mini,gemini-37,deepseek-r1,kimi-k3,gpt-55
AI_LONGFORM_CHAIN=gemini-38,gemini-37,qwen3-max,gpt-55,llama-4-maverick
AI_EMERGENCY_CHAIN=qwen3-flash,gpt-5-mini,gpt-4o-mini,mistral-small,llama-4-scout

# Timeouts & Deadlines
AI_MODEL_TIMEOUT_MS=8000
AI_TOTAL_TIMEOUT_MS=30000
CHAT_JOB_TIMEOUT_MS=35000

# Direct Google Gemini Fallback (Optional Last Resort)
AI_DIRECT_GEMINI_FALLBACK=true
GEMINI_API_KEY=AIzaSy...
GEMINI_MODEL=gemini-3.7-flash

# Perilaku Bot
RESPOND_IN_PRIVATE=true
MAX_INPUT_CHARS=8000

# System Prompt Kustom (Opsional)
SYSTEM_PROMPT=Kamu adalah asisten WhatsApp cerdas yang ramah, ringkas, dan faktual. Jika ada informasi dari percakapan sebelumnya, sebutkan sebagai informasi yang pernah didiskusikan sebelumnya secara wajar tanpa mengklaimnya sebagai kebenaran mutlak.
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
