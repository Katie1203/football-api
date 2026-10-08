# PROMAX Dashboard + Telegram Bot

## Render setup
1. Upload all files in this folder to the same GitHub repository used by the existing bot. Start command: `npm start`. Build command: `npm install`.
2. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `RAPIDAPI_KEY`, `ODDS_API_KEY` as before.
3. Set **`DASHBOARD_PASSWORD`** to a long unique password (required to access dashboard and APIs).
4. Set **`DATABASE_URL`** to your Render Postgres connection string for persistent storage. The dashboard also runs without it, but JSON storage on a Render ephemeral filesystem can be lost on restart/redeploy; do not use JSON mode for production audit history.
5. Open `https://YOUR-SERVICE.onrender.com/dashboard`. Browser basic authentication: username can be any value, password is `DASHBOARD_PASSWORD`.
6. After a successful Telegram API send, the bot writes one audit record for each #1/#2/#3 alert. It does not count `Alert YES` until Telegram returns a message_id.

## Win/loss definitions
- GOAL: WIN if FT home+away goals > home+away goals at alert. Otherwise LOSS.
- OVER: WIN if FT total > saved Over line; LOSS if below; PUSH if exactly equal; NO_LINE if no usable Over line was captured. Only WIN and LOSS enter win rate.
- Multiple alerts for a match are separate records with different baseline scores and Over lines.
- Automatic FT reconciliation currently supports SofaScore event IDs using `events/get-event?eventId=...` via RapidAPI. Endpoint availability depends on the user's API plan and provider schema. Other sources remain PENDING until a corresponding FT resolver is added or an admin settles them.

## Manual FT settle fallback
Authenticated POST `/api/audit/settle` with JSON `{ "matchKey": "key-shown-in-record", "ftHome": 2, "ftAway": 1 }`. For example, use Postman with Basic auth. This settles all pending alerts for the match. Only settle with verified FT score. (The UI is read-only by default.)

## Security and operations
- Previously shared bot/API tokens must be revoked and rotated. Do not commit secrets to source.
- Avoid multiple bot service instances with identical credentials. PostgreSQL persistence prevents losing history across redeploys.
- Do not expose `/api/audit` without `DASHBOARD_PASSWORD`.
- This is an outcome audit, not proof of profitability: Over odds and stake need separate profit accounting.
