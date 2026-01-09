# Book That Boat — Payload CMS (Backend)

This repository contains the **Payload CMS backend** for **Book That Boat**, running on **Payload CMS v3** with **MongoDB**.

It provides:

* Payload Admin UI (CMS)
* Collections + hooks (Reservations, Boats, Media, etc.)
* API routes (REST / GraphQL if enabled)
* Payment link creation + polling logic (Mamo Pay) and email notifications (SMTP)

---

## Tech Stack

* **Payload CMS v3**
* **Next.js (Payload Admin + API routes)**
* **MongoDB Atlas**
* **Node.js**
* **Railway** for hosting

---

## Repo Structure

Typical layout:

```
.
├─ src/
│  ├─ payload.config.ts
│  ├─ payload-types.ts
│  ├─ collections/
│  └─ app/
│     └─ (payload)/   # Payload admin + API routes
├─ server.ts
├─ package.json
└─ README.md
```

> This repo is **CMS-only**. Your frontend should live in a separate repository deployed on **Vercel**.

---

## Requirements

* Node.js **20+** (recommended for Payload + modern Next builds)
* MongoDB Atlas cluster (M10+ recommended; M30 is perfect)

---

## Environment Variables

Create a `.env` file locally (Railway will set these in production).

### Required

```env
PAYLOAD_SECRET=your_long_random_secret
DATABASE_URI=mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/DB_NAME?retryWrites=true&w=majority
PAYLOAD_PUBLIC_SERVER_URL=http://localhost:3000
```

### Email (SMTP)

Used for reservation/payment emails.

```env
EMAIL_ENABLED=true
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your_user
SMTP_PASSWORD=your_password
EMAIL_FROM="Book That Boat <no-reply@bookthatboat.com>"
ADMIN_EMAIL=admin@bookthatboat.com
```

### Mamo Pay (Payments)

```env
MAMOPAY_API_KEY=your_mamo_api_key
MAMOPAY_BASE_URL=https://business.mamopay.com
```

### Scheduler

Installment scheduler runs daily; defaults to 09:00 server time if not set.

```env
INSTALLMENT_SCHEDULER_HOUR=9
INSTALLMENT_SCHEDULER_MINUTE=0
TZ=Asia/Dubai
```

### Optional / If used in CMS hooks

If your CMS generates content with OpenAI:

```env
OPENAI_API_KEY=your_openai_key
```

---

## Install & Run Locally

### 1) Install dependencies

```bash
npm install
```

### 2) Generate Payload artifacts

**Important:** Payload admin uses an importMap. Generate it before running.

```bash
npm run generate:importmap
npm run generate:types
```

### 3) Start in dev

```bash
npm run dev
```

CMS will run on:

* **Admin:** `http://localhost:3000/admin`
* **API:** `http://localhost:3000/api`

---

## Creating the First Admin User

When running locally the first time, open:

`http://localhost:3000/admin`

Payload will prompt you to create the first admin user.

If you already have users in DB, you can login using the existing credentials.

---

## Build & Start (Production)

```bash
npm run generate:importmap
npm run generate:types
npm run build
npm run start
```

---

## Fix: ImportMap Errors (Admin UI)

If you see:

> `PayloadComponent not found in importMap ... run payload generate:importmap`

Run:

```bash
npm run generate:importmap
```

Then restart the server.

**Railway tip:** Ensure your build command includes importMap generation (see Railway section).

---

## Railway Deployment (Recommended)

### 1) Create Railway Project

* Railway → New Project → Deploy from GitHub
* Select this CMS repo

### 2) Add Environment Variables

Go to **Variables** and add at least:

* `PAYLOAD_SECRET`
* `DATABASE_URI`
* `PAYLOAD_PUBLIC_SERVER_URL` (Railway domain)
* Any email + payment vars you use

Example:

```env
PAYLOAD_PUBLIC_SERVER_URL=https://your-railway-service.up.railway.app
```

### 3) Set Build & Start Commands

**Build Command**

```bash
npm install && npm run generate:importmap && npm run generate:types && npm run build
```

**Start Command**

```bash
npm run start
```

### 4) Add Health Check (Optional)

Railway can use your root route `/` or `/admin` depending on your setup.

---

## Connect Frontend (Vercel) to CMS (Railway)

Your frontend should point to Railway CMS base URL.

Typical env vars on Vercel:

```env
NEXT_PUBLIC_PAYLOAD_URL=https://your-railway-service.up.railway.app
```

Make sure:

* CORS + CSRF in `payload.config.ts` includes your Vercel domain
* Example: `https://bookthatboat.com` and `https://your-vercel-app.vercel.app`

---

## MongoDB Atlas Notes

### Dedicated vs Shared

* **Shared (M0/M2/M5):** limited performance and may cause throttling / write contention under concurrent operations.
* **Dedicated (M10+):** recommended for production.
* **M30:** excellent for stability and concurrency.

---

## Common Errors

### 1) `Module not found: Can't resolve '@vercel/blob'`

That dependency should only exist in the **frontend repo**.

* If CMS still imports it, remove the usage from CMS or install it (not recommended for CMS).
* Best practice: keep Vercel Blob usage in frontend only.

### 2) `Module not found: Can't resolve 'openai'`

Install in CMS repo:

```bash
npm i openai
```

### 3) MongoDB `WriteConflict (code 112)`

This can happen on production due to concurrent updates (poller + hooks + admin edits).
Best practice is to add **retry logic** around writes or reduce concurrent writers.
(If you want, paste the exact failing operation call site and I’ll give you a safe “no-business-logic-change” retry patch.)

---

## Scripts

* `npm run dev` → Next dev (CMS + admin)
* `npm run build` → production build
* `npm run start` → start server
* `npm run generate:importmap` → generates admin importMap
* `npm run generate:types` → generates `payload-types.ts`

---

## License

MIT (or replace with your internal license)

---

If you tell me your **final CMS repo name** (example: `book-that-boat-cms`) and your **Railway production URL**, I can tailor the README with the exact URLs and copy-paste environment variable examples exactly matching your setup.
