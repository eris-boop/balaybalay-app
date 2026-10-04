# BalayBalay WhatsApp AI Bot

Production-ready WhatsApp AI Bot powered by Google Gemini, using VPSMurah WhatsApp Unofficial API.

## Features

- 🤖 AI-powered responses via Google Gemini
- 👥 Group chat support — bot responds only when mentioned
- 💬 Private chat support — configurable
- 🧠 Conversation memory per chat
- 🔒 Security: helmet, payload validation, no secret logging
- 🛡️ Anti-loop: idempotency cache, self-message detection
- ⏱️ Rate limiting per sender
- 📦 Production-ready: Docker, Coolify-compatible, health checks

## Quick Start

### Prerequisites

- Node.js 22+
- VPSMurah WhatsApp Unofficial API account
- Google Gemini API key

### Setup

```bash
# Clone the repository
git clone <your-repo-url>
cd balaybalay-whatsapp-bot

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your actual values
# IMPORTANT: Never commit .env to git!
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `VPSMURAH_API_KEY` | ✅ | API key from VPSMurah dashboard |
| `VPSMURAH_WHATSAPP_SEND_URL` | ❌ | Send endpoint (default: `https://my.vpsmurah.co.id/api/svc/v1/wa-api/messages`) |
| `VPSMURAH_WHATSAPP_INBOX_URL` | ❌ | Inbox polling endpoint (default: `https://my.vpsmurah.co.id/api/svc/v1/wa-api/inbox`) |
| `POLLING_ENABLED` | ❌ | Enable background polling (default: `true`) |
| `POLL_INTERVAL_MS` | ❌ | Polling interval in ms (default: `60000`, min: `5000`) |
| `VPSMURAH_WEBHOOK_SECRET` | ❌ | Webhook signature secret (if available) |
| `BOT_WHATSAPP_NUMBER` | ✅ | Bot's WhatsApp number (e.g., `628123456789`) |
| `GEMINI_API_KEY` | ✅ | Google Gemini API key |
| `GEMINI_MODEL` | ❌ | Gemini model (default: `gemini-2.0-flash`) |
| `RESPOND_IN_PRIVATE` | ❌ | Reply to DMs (default: `true`) |
| `MAX_INPUT_CHARS` | ❌ | Max input chars (default: `8000`) |
| `MAX_HISTORY_MESSAGES` | ❌ | History depth (default: `10`) |
| `RATE_LIMIT_PER_MINUTE` | ❌ | Max requests/min/sender (default: `10`) |
| `SYSTEM_PROMPT` | ❌ | Custom AI system prompt |
| `PORT` | ❌ | Server port (default: `3000`) |

> ⚠️ **Credit Consumption Notice**: VPSMurah charges 1 credit per API request (including each `GET /wa-api/inbox` poll). Setting `POLL_INTERVAL_MS` too low will deplete credits rapidly. The default is **60,000 ms (60 seconds)**, and intervals below 5,000 ms are automatically clamped.

### VPSMurah Outgoing & Inbox API Specification

**Inbox Polling (Incoming Messages):**
```
GET https://my.vpsmurah.co.id/api/svc/v1/wa-api/inbox
Authorization: Bearer VPSMURAH_API_KEY
Accept: application/json
```

**Send Message (Outgoing Replies):**
```
POST https://my.vpsmurah.co.id/api/svc/v1/wa-api/messages
Authorization: Bearer VPSMURAH_API_KEY
Content-Type: application/json

{
  "to": "6281234567890",
  "text": "Halo dari API"
}
```

Headers:
```
Authorization: Bearer VPSMURAH_API_KEY
Content-Type: application/json
```

Request Body:
```json
{
  "to": "6281234567890",
  "text": "Halo dari API"
}
```

### Development

```bash
# Start dev server with hot reload
npm run dev

# Type checking
npm run typecheck

# Run tests
npm test

# Build for production
npm run build

# Start production server
npm start
```

### API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Bot info and status |
| `GET` | `/health` | Health check |
| `POST` | `/webhook` | WhatsApp webhook receiver |
| `GET` | `/webhook` | Webhook verification |

## Architecture

```
src/
├── server.ts                 # Express server entry point & poller lifecycle
├── config.ts                 # Centralized config from env vars
├── routes/
│   └── webhook.ts            # Webhook endpoint handler (manual/test)
├── providers/
│   ├── vpsmurah.ts           # VPSMurah webhook payload adapter
│   └── vpsmurahInbox.ts      # VPSMurah GET /wa-api/inbox adapter
├── services/
│   ├── poller.ts             # Background poller for inbox messages
│   ├── messageProcessor.ts   # Unified message filtering, dedup & AI dispatch
│   ├── gemini.ts             # Gemini AI generation
│   ├── whatsapp.ts           # WhatsApp message sending (POST /wa-api/messages)
│   ├── mention.ts            # Mention detection & stripping
│   ├── memory.ts             # Conversation memory
│   ├── idempotency.ts        # Duplicate prevention (24h TTL)
│   └── rateLimit.ts          # Rate limiting
├── types/
│   └── whatsapp.ts           # TypeScript interfaces
└── utils/
    ├── logger.ts             # Structured logging with secret redaction
    └── phone.ts              # Phone number normalization & recipient formatting
```

## Group Chat Behavior

1. Bot **only responds** when its number is @mentioned in a group
2. Mention is stripped from the text before sending to Gemini
3. Reply goes to the **group chat**, not the individual sender
4. If no mention → ignored with HTTP 200 (no Gemini API cost)

## Security

- Helmet middleware for HTTP headers
- JSON body size limited to 1MB
- No secrets/API keys in logs
- Environment validation at startup
- Request timeouts on external API calls
- Rate limiting per sender
- No stack traces exposed in production

## Webhook Payload

This bot uses an adapter pattern (`src/providers/vpsmurah.ts`) to normalize
incoming webhook payloads. If VPSMurah changes their payload format, only
the adapter needs to be updated.

> **Note**: VPSMurah's WhatsApp Unofficial API does not currently document
> a webhook signature/secret verification mechanism. The `VPSMURAH_WEBHOOK_SECRET`
> env var is reserved for future use when/if the provider adds this feature.

## License

MIT
