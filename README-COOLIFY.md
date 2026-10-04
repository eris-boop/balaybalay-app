# Deployment Guide: Coolify

Step-by-step guide to deploy BalayBalay WhatsApp AI Bot on Coolify.

## Prerequisites

- GitHub repository with this project pushed
- Coolify instance running on your Ubuntu VPS
- Domain `wa.balaybalay.sbs` pointed to your VPS IP
- VPSMurah API key
- Gemini API key

---

## Step 1: Push to GitHub

```bash
cd balaybalay-whatsapp-bot

git init
git add .
git commit -m "Initial commit: BalayBalay WhatsApp AI Bot"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/balaybalay-whatsapp-bot.git
git push -u origin main
```

## Step 2: Connect Repository to Coolify

1. Open your Coolify dashboard
2. Go to **Projects** → **Create New Resource**
3. Select **Public Repository** or **Private Repository** (via GitHub App)
4. Enter your repository URL
5. Select branch: **main**

## Step 3: Configure Build Settings

| Setting | Value |
|---|---|
| **Build Pack** | Railpack |
| **Port** | `3000` |
| **Base Directory** | `/` |
| **Install Command** | `npm ci` |
| **Build Command** | `npm run build` |
| **Start Command** | `npm start` |

> **Note**: Railpack should auto-detect Node.js and use these settings.
> If not, set them manually.

## Step 4: Set Domain

1. In the resource settings, go to **Domains**
2. Add: `wa.balaybalay.sbs`
3. Enable HTTPS (Coolify handles Let's Encrypt automatically)

## Step 5: Configure Environment Variables

Go to **Environment Variables** in Coolify and add:

```env
NODE_ENV=production
PORT=3000

VPSMURAH_API_KEY=<your_actual_api_key>
VPSMURAH_WHATSAPP_SEND_URL=https://my.vpsmurah.co.id/api/service/whatsapp-unofficial/send

BOT_WHATSAPP_NUMBER=<your_bot_whatsapp_number>

GEMINI_API_KEY=<your_actual_gemini_key>
GEMINI_MODEL=gemini-2.0-flash

RESPOND_IN_PRIVATE=true
MAX_INPUT_CHARS=8000
MAX_HISTORY_MESSAGES=10
RATE_LIMIT_PER_MINUTE=10
```

⚠️ **IMPORTANT**: Enter actual secret values ONLY in Coolify's environment variables panel. Never commit them to git.

## Step 6: Deploy

1. Click **Deploy** in Coolify
2. Wait for the build to complete
3. Check the deployment logs for any errors

## Step 7: Verify Deployment

Open in browser:

```
https://wa.balaybalay.sbs/health
```

Expected response:

```json
{
  "status": "ok",
  "timestamp": "2026-10-04T12:00:00.000Z",
  "uptime": 42
}
```

Also check root:

```
https://wa.balaybalay.sbs/
```

Expected:

```json
{
  "name": "BalayBalay WhatsApp AI Bot",
  "status": "running"
}
```

## Step 8: Configure VPSMurah Webhook

1. Log in to your VPSMurah dashboard
2. Navigate to WhatsApp Unofficial API settings
3. Set the **Webhook URL** to:

```
https://wa.balaybalay.sbs/webhook
```

4. Save the settings
5. The webhook is now active

## Step 9: Test the Bot

### Test via curl

```bash
# Simulate a private chat message
curl -X POST https://wa.balaybalay.sbs/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "key": {
      "id": "TEST_MSG_001",
      "remoteJid": "6281234567890@s.whatsapp.net",
      "fromMe": false
    },
    "pushName": "Test User",
    "messageTimestamp": 1696406400,
    "message": {
      "conversation": "Halo, apa kabar?"
    }
  }'
```

### Test via WhatsApp

1. Send a direct message to the bot's WhatsApp number
2. In a group: mention the bot with `@<bot-number>` followed by your question
3. Verify the bot responds

---

## Operations

### Reading Logs

In Coolify:
1. Go to your resource
2. Click **Logs**
3. View real-time application logs

Log prefixes:
- `[SERVER]` - Server lifecycle
- `[WEBHOOK]` - Incoming webhook events
- `[WHATSAPP]` - Outgoing messages
- `[GEMINI]` - AI generation
- `[ERROR]` - Errors
- `[RATE_LIMIT]` - Rate limit events

### Restarting

1. Go to your resource in Coolify
2. Click **Restart**
3. Or click **Redeploy** for a fresh build

### Updating After Code Changes

```bash
# Make your changes
git add .
git commit -m "your change description"
git push origin main
```

Coolify will auto-deploy if you enabled **Auto Deploy**.
Otherwise, click **Deploy** manually in Coolify.

### Rollback

In Coolify, go to **Deployments** and click **Rollback** on a previous successful deployment.

---

## Troubleshooting

| Issue | Solution |
|---|---|
| Health check fails | Check env vars are set correctly in Coolify |
| Bot doesn't respond | Check VPSMurah webhook URL is correct |
| Bot responds in group without mention | Verify `BOT_WHATSAPP_NUMBER` matches your bot |
| Gemini errors | Check `GEMINI_API_KEY` and API quota |
| 502 Bad Gateway | Check PORT is 3000 and app is running |
| Build fails | Check Node.js version (needs 22+) |

## Architecture Notes

- The app binds to `0.0.0.0:3000` (compatible with Coolify/Docker)
- All secrets come from environment variables (never hardcoded)
- Conversation memory is in-memory (resets on restart)
- For persistent memory, implement Redis adapter in `src/services/memory.ts`
