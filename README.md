# Academy Nexus

Internal assessment management platform for NxtWave placement exams — exam scheduling, student data uploads, assessment config, assessment generation, and results/interview tracking.

## Stack

- React + Vite (frontend, single-page app in `src/App.jsx`)
- Firebase Firestore + Firebase Auth (Google + Email/Password)
- Vercel Serverless Functions (`api/`) for backend integrations
- Deployed on Vercel

## Development

```bash
npm install
npm run dev       # frontend at http://localhost:5173
npm run dev:api   # vercel dev, for testing api/ functions locally
```

Copy `.env.example` to `.env.local` and fill in the required values before running `dev:api`.

## Structure

- `src/App.jsx` — main app (pages, auth, roles/permissions)
- `src/firebase.js` — Firebase client config
- `api/` — serverless functions (Interview Coordinator App integration)
