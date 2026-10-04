# BalayBalay WhatsApp AI Bot

Production-ready WhatsApp AI Bot powered by Google Gemini and direct WhatsApp Web connection via **Baileys WebSocket** (`@whiskeysockets/baileys`).

---

## Architecture Overview

```
WhatsApp
   ↓
Baileys WebSocket
   ↓
Incoming message handler (messages.upsert)
   ↓
Idempotency (anti-duplicate)
   ↓
Private / group mention filtering
   ↓
Google Gemini AI (gemini-3.7-flash)
   ↓
Baileys sendMessage()
   ↓
WhatsApp
```

> ⚠️ **Catatan Penting VPSMurah:**
> Polling `GET /wa-api/inbox` dari VPSMurah telah **DIHAPUS & DINONAKTIFKAN SECARA PERMANEN** karena endpoint tersebut mengembalikan HTTP 501 dan menguras kredit. Seluruh pesan masuk dan keluar kini ditangani langsung oleh Baileys WebSocket tanpa polling dan tanpa biaya kredit API.

---

## Features

- ⚡ **Direct WhatsApp Connection**: Real-time message reception via Baileys WebSocket (no polling delay, no credit consumption)
- 🤖 **Google Gemini AI**: Latest official `@google/genai` SDK with `gemini-3.7-flash`
- 🔐 **Secure QR Pairing**: Token-protected admin interface (`/admin/qr?token=ADMIN_TOKEN`)
- 💾 **Persistent Auth Session**: Multi-file auth stored in `/app/data/wa-auth` (re-scan tidak diperlukan saat redeploy)
- 👥 **Group Mention Logic**: Bot hanya merespons saat akun bot di-mention langsung di grup; mention otomatis dibersihkan sebelum dikirim ke AI
- 💬 **Private Chat Support**: Percakapan 1-on-1 langsung dibalas tanpa perlu mention (dapat dinonaktifkan via `RESPOND_IN_PRIVATE=false`)
- 🧠 **Conversation Memory**: Riwayat obrolan tersimpan per chat
- 🛡️ **Anti-Loop & Idempotency**: Pesan dari bot sendiri diabaikan, cache idempotency 24 jam mencegah duplikasi
- ⏱️ **Rate Limiting**: Perlindungan terhadap spam per pengirim
- 🔒 **Security Best Practices**: Helmet headers, input truncation, secret redaction, validasi startup

---

## Prerequisites

- **Node.js 22+**
- **Google Gemini API Key** (dari [Google AI Studio](https://aistudio.google.com/))
- **WhatsApp Account** (nomor HP aktif untuk bot)
- **Coolify / Docker VPS** dengan Persistent Storage mount pada `/app/data`

---

## Quick Start (Local Development)

```bash
# Clone repository
git clone <your-repo-url>
cd balaybalay-whatsapp-bot

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env dengan credentials Anda
# (Pastikan GEMINI_API_KEY dan ADMIN_TOKEN terisi)

# Test konektivitas Gemini AI
npm run test:gemini

# Jalankan development server
npm run dev
```

Buka browser dan akses halaman pairing QR:
```
http://localhost:3000/admin/qr?token=YOUR_ADMIN_TOKEN
```
Buka WhatsApp di ponsel > **Perangkat Tertaut (Linked Devices)** > **Tautkan Perangkat**, lalu scan QR code yang tampil.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | ❌ | `3000` | Port HTTP server |
| `NODE_ENV` | ❌ | `development` | Environment (`development` / `production`) |
| `WHATSAPP_PROVIDER` | ❌ | `baileys` | Provider WhatsApp (`baileys`) |
| `WHATSAPP_AUTH_DIR` | ❌ | `/app/data/wa-auth` | Path direktori penyimpanan session auth |
| `ADMIN_TOKEN` | ✅ | - | Token rahasia untuk mengakses route QR login |
| `GEMINI_API_KEY` | ✅ | - | API Key dari Google AI Studio (wajib) |
| `GEMINI_MODEL` | ❌ | `gemini-3.7-flash` | Model Gemini yang digunakan |
| `RESPOND_IN_PRIVATE` | ❌ | `true` | Balas pesan di private chat |
| `MAX_INPUT_CHARS` | ❌ | `8000` | Maksimum karakter pesan input |
| `MAX_HISTORY_MESSAGES`| ❌ | `10` | Jumlah percakapan tersimpan dalam memori |
| `RATE_LIMIT_PER_MINUTE`| ❌ | `10` | Batas maksimum pesan per menit per user |
| `SYSTEM_PROMPT` | ❌ | (default) | Instruksi kustom kepribadian bot |

---

## HTTP Endpoints

| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| `GET` | `/` | Publik | Status aplikasi |
| `GET` | `/health` | Publik | Status koneksi WhatsApp & uptime |
| `GET` | `/admin/qr?token=...` | `ADMIN_TOKEN` | Halaman scan QR code pairing |
| `POST`| `/webhook` | - | Endpoint webhook legacy (opsional/manual) |

### Format Response `/health`
```json
{
  "status": "ok",
  "whatsappProvider": "baileys",
  "whatsappConnected": true,
  "pairingRequired": false,
  "uptime": 123.45
}
```

---

## Scripts

```bash
# Type check TypeScript
npm run typecheck

# Menjalankan unit tests
npm test

# Mengetes koneksi Google Gemini API secara manual
npm run test:gemini

# Build bundle produksi
npm run build

# Menjalankan server produksi
npm start
```

---

## Coolify Persistent Storage Setup

Agar sesi login WhatsApp tidak hilang setiap kali aplikasi di-deploy ulang, Coolify **WAJIB** dikonfigurasi dengan Persistent Storage:

1. Buka resource aplikasi di **Coolify**.
2. Masuk ke tab **Storages**.
3. Tambahkan storage baru:
   - **Volume Name**: `wa-data`
   - **Destination Path (Container)**: `/app/data`
4. Klik **Save** dan **Redeploy**.

Detail lengkap panduan Coolify tersedia di [README-COOLIFY.md](./README-COOLIFY.md).

---

## License

MIT
