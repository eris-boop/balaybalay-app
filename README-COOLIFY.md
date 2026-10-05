# Panduan Deployment Coolify: BalayBalay Enterprise WhatsApp AI Bot

Panduan lengkap untuk men-deploy **BalayBalay WhatsApp AI Assistant** pada platform **Coolify** di VPS Ubuntu dengan arsitektur **Database-First**, **Global Shared Memory**, **Background Fact Learner**, **Persistent DB Spool**, dan **Multi-Model Failover Routing**.

---

## 1. Arsitektur Enterprise Bot

- **Runtime**: Node.js 22 (Alpine) / TypeScript
- **WhatsApp Engine**: `@whiskeysockets/baileys` dengan session auth multi-file persisten
- **AI Engine (Primary)**: VPSMurah OpenAI-Compatible Smart Model Router (`gemini-38`, `qwen3-flash`, dll.)
- **AI Engine (Fallback)**: Google Gemini API Direct SDK (`@google/genai`)
- **Database**: PostgreSQL internal di Coolify (Connection Pool `pg.Pool`, migrations aditif idempotensial)
- **Persistent Outage Spool**: JSONL file spool (`/app/data/db-spool/messages.jsonl`) untuk perlindungan data saat database offline
- **Background Memory Learner**: Pekerja latar belakang asinkron (`memory_ingest_queue` & `memory_facts`) dengan deduplikasi fingerprint SHA-256
- **Human-Readable Projection**: Atomic text snapshot (`/app/data/memory/knowledge_snapshot.txt`)
- **Port**: `3000` (HTTPS via Coolify Traefik reverse proxy)
- **Domain**: `https://wa.balaybalay.sbs`
- **Persistent Volume**: `/app/data` (Menyimpan sesi WhatsApp, spool darurat DB, dan snapshot pengetahuan)

---

## 2. Persiapan Persistent Storage di Coolify (PENTING ⚠️)

Seluruh data state aplikasi tersimpan di container path:
```
/app/data
```
Struktur subdirektori volume `/app/data`:
- `/app/data/wa-auth`: Sesi multi-file login WhatsApp (Baileys)
- `/app/data/db-spool`: File spool darurat jika PostgreSQL sedang maintenance/restart
- `/app/data/memory`: Human-readable text snapshot dari fakta yang dipelajari

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

Bot WhatsApp ini terintegrasi penuh dengan **PostgreSQL** untuk menyimpan riwayat percakapan, antrean pembelajaran memori, dan fakta pengetahuan global secara terstruktur.

### Langkah-langkah Pembuatan Database PostgreSQL:
1. Buka dashboard **Coolify** Anda.
2. Masuk ke **Project** yang sama dengan aplikasi bot WhatsApp Anda.
3. Klik tombol **+ New Resource**.
4. Pilih kategori **Database** > **PostgreSQL**.
5. Isi nama database (misalnya Database Name: `balaybalay`).
6. **JANGAN centang "Expose to public internet"** (Port 5432 tidak perlu dibuka ke publik; bot dan database terhubung melalui internal Docker network Coolify).
7. Pastikan **Persistent Volume** PostgreSQL aktif agar data tidak hilang saat restart/redeploy.
8. Klik **Deploy** pada resource PostgreSQL Anda.
9. Setelah status PostgreSQL *Running*, buka tab **General** atau **Environment Variables** pada resource PostgreSQL tersebut.
10. Salin **Internal Connection String** (format: `postgresql://postgres:password123@balaybalay-postgres:5432/balaybalay`).
11. Masuk kembali ke resource aplikasi bot WhatsApp Anda > tab **Environment Variables**, dan masukkan nilai tersebut ke variable `DATABASE_URL`.

---

## 4. Konfigurasi Environment Variables di Coolify

Salin blok konfigurasi berikut ke tab **Environment Variables** di resource bot Coolify Anda:

```env
NODE_ENV=production
PORT=3000

# WhatsApp Provider & Persistent Auth
WHATSAPP_PROVIDER=baileys
WHATSAPP_AUTH_DIR=/app/data/wa-auth

# Keamanan Admin Diagnostics & Memory Management
ADMIN_TOKEN=ganti_dengan_token_rahasia_anda_yang_kuat

# PostgreSQL Database (Coolify Internal Network)
DATABASE_URL=postgresql://postgres:password123@balaybalay-postgres:5432/balaybalay
DB_POOL_MAX=10
DB_CONNECTION_TIMEOUT_MS=10000
DB_IDLE_TIMEOUT_MS=30000
DB_QUERY_TIMEOUT_MS=15000

# Database Outage Spool Recovery
DB_SPOOL_ENABLED=true
DB_SPOOL_PATH=/app/data/db-spool/messages.jsonl

# Group Trigger & Archival Policy
GROUP_REPLY_ON_MENTION=true
GROUP_REPLY_ON_QUOTE=true
GROUP_REPLY_ALWAYS=false
GROUP_ARCHIVE_ALL_TEXT=true

# Global Shared Knowledge Memory
GLOBAL_MEMORY_ENABLED=true
GLOBAL_MEMORY_CROSS_CHAT=true
GLOBAL_MEMORY_SCOPE=shared_global
GLOBAL_MEMORY_RETRIEVAL_LIMIT=16

# Per-Chat Memory & Context Budget
MAX_HISTORY_MESSAGES=30
MEMORY_RETRIEVAL_LIMIT=12
MEMORY_FACT_RETRIEVAL_LIMIT=20
MEMORY_MAX_CONTEXT_CHARS=30000
MEMORY_SUMMARY_ENABLED=true
MEMORY_SUMMARY_AFTER_MESSAGES=30
MEMORY_SUMMARY_KEEP_RECENT=20

# Background Memory Learner
MEMORY_LEARNER_ENABLED=true
MEMORY_LEARNER_MODEL=gemini-38
MEMORY_LEARNER_FALLBACK_MODEL=qwen3-flash
MEMORY_LEARNER_INTERVAL_MS=5000
MEMORY_LEARNER_BATCH_SIZE=10
MEMORY_LEARNER_MAX_RETRIES=5
MEMORY_LEARNER_CONCURRENCY=1

# Human-Readable Knowledge Text Snapshot
MEMORY_TEXT_SNAPSHOT_ENABLED=true
MEMORY_TEXT_SNAPSHOT_PATH=/app/data/memory/knowledge_snapshot.txt
MEMORY_NEW_INFO_SNAPSHOT_PATH=/app/data/memory/new_information.txt

# AI Provider Configuration (VPSMurah Smart Model Router)
AI_PROVIDER=vpsmurah
VPSMURAH_AI_BASE_URL=https://my.vpsmurah.co.id/api/v1
VPSMURAH_AI_API_KEY=vps_ai_live_...

# Smart Category Chains (Gemini & Qwen Priority)
AI_GENERAL_CHAIN=gemini-38,qwen3-flash,gpt-5-mini,gemini-37,gpt-4o-mini,mistral-small
AI_CODING_CHAIN=qwen3-coder,gemini-38,gpt-53-codex,deepseek-coder,codestral,gpt-5-mini
AI_REASONING_CHAIN=gemini-38,qwen3-plus,gpt-5-mini,gemini-37,deepseek-r1,kimi-k3,gpt-55
AI_LONGFORM_CHAIN=gemini-38,gemini-37,qwen3-max,gpt-55,llama-4-maverick
AI_EMERGENCY_CHAIN=qwen3-flash,gpt-5-mini,gpt-4o-mini,mistral-small

# Patient Enterprise AI Timeouts (ms)
AI_GENERAL_TIMEOUT_MS=90000
AI_CODING_TIMEOUT_MS=180000
AI_REASONING_TIMEOUT_MS=240000
AI_LONGFORM_TIMEOUT_MS=360000
DIRECT_GEMINI_TIMEOUT_MS=180000
AI_TOTAL_TIMEOUT_MS=600000
CHAT_JOB_TIMEOUT_MS=660000

# Direct Google Gemini Fallback (Optional Last Resort)
AI_DIRECT_GEMINI_FALLBACK=true
GEMINI_API_KEY=AIzaSy...
GEMINI_MODEL=gemini-3.7-flash

# Perilaku Percakapan
RESPOND_IN_PRIVATE=true
MAX_INPUT_CHARS=8000

# Profanity Filter (Output Masking Ringan)
PROFANITY_FILTER_ENABLED=true
PROFANITY_FILTER_MODE=mask
```

---

## 5. Fitur Utama & Cara Kerja Bot

### A. Database-First Message Ingestion
Setiap pesan teks yang masuk melalui WhatsApp disimpan terlebih dahulu ke PostgreSQL sebelum pemrosesan AI dimulai:
```
WhatsApp Inbound Message
       ↓
Normalisasi & Validasi JID
       ↓
Idempotency Cache Check
       ↓
Simpan Raw Message ke PostgreSQL
       ↓
Enqueue ke memory_ingest_queue
       ↓
Evaluasi Trigger Balasan (Mention / Quoted)
       ↓
Load Context (Recent + Facts + Summaries)
       ↓
AI Generation (dengan typing indicator)
       ↓
Kirim Balasan ke WhatsApp
       ↓
Simpan Balasan Assistant (memory_eligible: false)
```
Jika AI mengalami kegagalan atau timeout, pesan pengguna tetap tersimpan di database dan tidak hilang.

### B. Reply-to-Bot Tanpa @Mention di Grup
Pada obrolan grup WhatsApp:
- Bot **hanya** membalas jika:
  1. Bot di-mention (`@bot jelaskan ini`), ATAU
  2. Pengguna me-reply / quote pesan yang sebelumnya dikirim oleh bot (`Jawabannya 42` -> user me-reply: `kenapa?`).
- Bot mencatat setiap ID pesan yang dikirimkannya ke dalam tabel `bot_sent_messages`. Ketika pesan grup memiliki `quotedStanzaId` yang cocok dengan ID pesan bot, bot otomatis merespons meskipun tidak ada `@mention`.

### C. Pemisahan Arsip Teks vs Trigger Respon
- `GROUP_ARCHIVE_ALL_TEXT=true`: Seluruh pesan teks percakapan di grup tetap disimpan untuk keperluan retensi dan pembelajaran memori.
- `GROUP_REPLY_ALWAYS=false`: Bot tidak akan spam membalas percakapan acak anggota grup. Bot hanya membalas saat dipanggil (mention/quote).

### D. Global Shared Knowledge & Background Fact Learner
- **Background Worker**: Bekerja secara asinkron di latar belakang mengambil antrean pesan dari `memory_ingest_queue`.
- **Ekstraksi Fakta**: Mengekstrak fakta terstruktur (`subject`, `predicate`, `object`, `fact_text`) ke dalam tabel `memory_facts`.
- **Anti Hallucination Loop**: Seluruh respon assistant AI ditandai `memory_eligible: false` sehingga bot tidak akan mempelajari halusinasi AI sebagai fakta kebenaran permanen.
- **Cross-Chat Memory**: Fakta yang dipelajari di Grup A dapat diingat dan digunakan saat menjawab pertanyaan di Grup B atau Private Chat.
- **Penyebutan Konversasional**: Bot membedakan antara fakta eksternal terverifikasi dan klaim percakapan ("Sebelumnya ada informasi dalam percakapan bahwa...").

### E. Database Outage Resilience & Persistent Spool
- Jika PostgreSQL down, restart, atau mengalami gangguan koneksi, aplikasi **TIDAK crash**.
- Status kesehatan database ditandai `degraded`.
- Pesan masuk otomatis di-spool sebagai event JSONL yang aman ke disk persisten: `/app/data/db-spool/messages.jsonl`.
- Percakapan tetap dapat berlanjut menggunakan in-memory cache.
- Ketika PostgreSQL kembali online (`healthy`), antrean spool otomatis di-replay ke database secara aman dan idempoten (`ON CONFLICT DO NOTHING`), lalu file spool dipadatkan/dibersihkan.

### F. Human-Readable Knowledge Text Snapshot
Untuk mempermudah verifikasi dan inspeksi fakta yang telah dipelajari bot tanpa perlu membuka SQL query:
- `/app/data/memory/knowledge_snapshot.txt`: Menampilkan daftar seluruh fakta aktif yang tersimpan di PostgreSQL.
- `/app/data/memory/new_information.txt`: Log penambahan fakta terbaru beserta stempel waktu.
- Penulisan snapshot dilakukan secara atomik (temporary file -> rename) agar file tidak korup.

---

## 6. Observability & Diagnostic Endpoints

### 1. Health Check
```http
GET /health
```
Menampilkan status koneksi WhatsApp dan kesiapan handler:
```json
{
  "status": "ok",
  "whatsappProvider": "baileys",
  "whatsappConnected": true,
  "pairingRequired": false,
  "messageHandlerReady": true,
  "uptime": 1205.4
}
```

### 2. Admin Diagnostics
```http
GET /admin/status?token=ADMIN_TOKEN
```
Headers: `x-admin-token: ADMIN_TOKEN` atau query param `?token=...`.
Menampilkan metrik internal lengkap tanpa membocorkan data pribadi atau kredensial rahasia:
- `connected`, `handlerReady`
- `databaseConnected`, `databaseHealth`
- `dbPoolTotal`, `dbPoolIdle`, `dbPoolWaiting`
- `dbSpoolPending`
- `memoryLearnerEnabled`, `memoryLearnerPending`, `memoryLearnerFailed`
- `knowledgeFactCount`, `textSnapshotEnabled`, `lastTextSnapshotAt`
- `lastUsedModel`, `lastAttemptedModels`, `lastAIDurationMs`, `lastAIStatus`

### 3. Memory Stats Endpoint
```http
GET /admin/memory/stats?token=ADMIN_TOKEN
```
Mengembalikan data agregat statistik memori:
```json
{
  "messagesTotal": 1420,
  "userMessages": 820,
  "assistantMessages": 600,
  "activeFacts": 48,
  "pendingLearningJobs": 0,
  "failedLearningJobs": 0,
  "globalSummaryExists": true,
  "dbSpoolPending": 0
}
```

### 4. QR Pairing Page
```http
GET /admin/qr?token=ADMIN_TOKEN
```
Halaman antarmuka HTML modern untuk scan pairing WhatsApp Web.

---

## 7. Langkah Deployment & Migrasi

1. **Pastikan Persistent Volume** `/app/data` sudah ditambahkan pada resource aplikasi di Coolify.
2. **Deploy PostgreSQL** di Coolify dan hubungkan `DATABASE_URL`.
3. **Simpan Environment Variables** sesuai bagian 4 di atas.
4. **Deploy Bot**: Coolify akan menjalankan build Docker dan memulai server.
   - Skema database (tabel `conversations`, `messages`, `memory_ingest_queue`, `memory_facts`, `bot_sent_messages`) dibuat secara otomatis dan aditif saat startup (`ensureSchema()`). Tidak ada tabel yang di-drop.
5. **Buka `/admin/qr?token=ADMIN_TOKEN`** dan scan QR Code menggunakan WhatsApp di ponsel Anda.
6. **Selesai!** Bot kini aktif dalam mode enterprise dengan memori global dan ketahanan data tingkat produksi.
