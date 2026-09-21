# Topin automation server

Local helper for **Assessment Generation**. It drives config.topin.tech with Playwright (clone the chosen config → set title/tag/schedule → publish) using a Topin login saved on this machine. It is never deployed to Vercel — each POC who publishes runs it locally.

```
cd automation-server
npm install
npx playwright install chromium
npm start            # http://localhost:3001  (HEADLESS=false to watch the browser)
```

First publish: the Assessment Generation page asks for your Topin mobile number + OTP once; the session is saved to `topin-session.json` (gitignored) and reused until Topin expires it.

The frontend looks for the server at `http://localhost:3001` (override with `VITE_AUTOMATION_SERVER_URL`). Inviting students goes through the Vercel function `api/invite.js`, which needs `TOPIN_INVITE_API_KEY`.
