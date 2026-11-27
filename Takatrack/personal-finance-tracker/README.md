# TakaTrack — Personal Finance Tracker (BDT, ৳)

A mobile-first, Progressive Web App (PWA) personal finance tracker built with **HTML, CSS, vanilla JavaScript (ES Modules)**, **Supabase (PostgreSQL + Auth + Row Level Security)**, and **Vercel**.

Designed specifically for personal daily use in **Bangladeshi Taka (BDT, ৳)** with strict accounting separation between expenses, income, borrowing, lending, repayments, and loan collections.

---

## Key Features

- **Mobile-First Native Feel**: Bottom navigation bar on phones, collapsible sidebar on desktop, large touch targets, light/dark/system theme support, and installable PWA.
- **Dashboard & One-Tap Quick Expense**: Monthly income, expenses, net cash flow (`income − expenses`), total I owe, total owed to me, month switcher, one-tap Quick Expense Entry (amount only required; optional description & category), and Quick Income Entry.
- **Strict Accounting Integrity**:
  - All monetary values stored as **integer `BIGINT` Bangladeshi Taka** (no floating-point rounding bugs).
  - Borrowing money is **never** counted as income; lending money is **never** counted as an expense.
  - Repaying debt is **never** counted as an expense; collecting a loan is **never** counted as income.
  - Outstanding balances are derived directly from `loan_transactions` via PostgreSQL views and atomic RPCs.
- **Persistent People & Debt Management**: Separated **People I Owe** and **People Who Owe Me** sections. Borrowing or lending multiple times to the same person appends to their single persistent profile (enforced by a unique database constraint on normalized name). Supports partial repayments and guards against over-repayments unless explicitly confirmed.
- **Unified Transaction History**: Filter by search query, type, category, person, date range, and amount; edit or delete with confirmation and Undo.
- **Live Monthly & Yearly Reports**: Interactive Chart.js visualizations (Daily Spending, Spending by Category, 12-Month Income vs. Expenses) plus average monthly spending and highest-spending month calculated live from PostgreSQL.
- **Offline Queue & Sync**: Queues expenses locally when offline, displays online/offline/syncing status honestly, and deduplicates cloud writes via `client_mutation_id` UUIDs.
- **Data Portability**: Excel-compatible UTF-8 BOM CSV export and full JSON backup & restore.

---

## Project Structure

```text
personal-finance-tracker/
├── index.html                    # Home / Dashboard
├── pages/
│   ├── activity.html             # Unified Transaction History
│   ├── people.html               # People I Owe & People Who Owe Me
│   ├── person-details.html       # Person Profile, Balance & Repayment History
│   ├── reports.html              # Monthly & Yearly Analytics (Chart.js)
│   └── settings.html             # Theme, Custom Categories, CSV/JSON Export & Account
├── api/
│   └── config.js                 # Vercel Serverless Function exposing public Supabase URL/Anon Key
├── css/
│   ├── style.css                 # Design tokens & Light/Dark/System themes
│   ├── components.css            # Cards, nav, forms, modals, toasts, badges
│   ├── dashboard.css             # Dashboard summary cards, quick entry, charts
│   └── responsive.css            # Tablet & desktop breakpoints
├── js/
│   ├── accounting.js             # Pure accounting, validation & CSV engine
│   ├── app.js                    # Shared shell, navigation, theme, sync & SW registration
│   ├── auth.js                   # Supabase Auth sign-in/sign-up & private session gate
│   ├── config.js                 # Runtime config loader (/api/config or local js/env.js)
│   ├── dashboard.js              # Dashboard controller
│   ├── database.js               # Supabase client, queries & atomic RPCs
│   ├── loans.js                  # Person Details & repayment controller
│   ├── people.js                 # People & debt overview controller
│   ├── reports.js                # Chart.js reports controller
│   ├── settings.js               # Settings, categories & backup/restore controller
│   ├── sync.js                   # Persistent offline queue & deduplicated sync
│   ├── transactions.js           # Unified ledger & filtering controller
│   └── utils.js                  # BDT formatting, Asia/Dhaka dates, toasts & dialogs
├── assets/icons/                 # PWA icons (192px, 512px, maskable, favicon.svg)
├── supabase/
│   ├── schema.sql                # Combined full SQL setup script
│   └── migrations/
│       ├── 001_initial_schema.sql
│       ├── 002_rls_policies.sql
│       └── 003_accounting_rpcs.sql
├── tests/
│   └── accounting.test.mjs       # Automated Node.js test suite
├── manifest.json                 # PWA Web App Manifest
├── service-worker.js             # App shell caching & offline support
├── vercel.json                   # Vercel headers & SW cache policy
├── .env.example                  # Placeholder environment variables
└── .gitignore
```

---

## 1. Prerequisites

- A free [Supabase](https://supabase.com/) account
- A [GitHub](https://github.com/) account
- A free [Vercel](https://vercel.com/) account
- Node.js 18+ (for running tests and optional local static server)

---

## 2. Supabase Project Setup & Database Migration

1. Create a new project in the [Supabase Dashboard](https://supabase.com/dashboard).
2. Open **SQL Editor** → **New Query**.
3. Copy the entire contents of `supabase/schema.sql` (or run `001_initial_schema.sql`, `002_rls_policies.sql`, and `003_accounting_rpcs.sql` in order) and click **Run**.
4. Verify in **Table Editor** that `profiles`, `categories`, `people`, `transactions`, and `loan_transactions` exist and all show **RLS enabled**.
5. Go to **Project Settings → API** and copy:
   - **Project URL** (`SUPABASE_URL`)
   - **anon / public key** (`SUPABASE_ANON_KEY`)
   - **Never** copy or expose the `service_role` key in frontend code or GitHub.
6. Under **Authentication → Providers → Email**, ensure Email Signups are enabled. (For faster personal onboarding, you may optionally disable "Confirm email" if you only use it for yourself, or keep it enabled for extra verification.)

---

## 3. Running Locally

Because the app uses ES Modules and `/api/config`, choose one of these two local workflows:

### Option A: Local Static Server (Fastest)
1. Create a gitignored file `js/env.js` (do **not** commit this file):
   ```js
   window.__ENV__ = {
     SUPABASE_URL: 'https://your-project-ref.supabase.co',
     SUPABASE_ANON_KEY: 'your-public-anon-key-here',
   };
   ```
2. Include `<script src="./js/env.js"></script>` (or `../js/env.js` inside `pages/*.html`) before the page's module script during local static testing, OR use Option B (`vercel dev`) which requires zero edits.
3. Serve the folder:
   ```bash
   npx serve .
   ```

### Option B: Vercel CLI (Matches Production Exactly)
1. Copy `.env.example` to `.env.local` and fill in your `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
2. Run:
   ```bash
   npx vercel dev
   ```
   This serves both the static files and `/api/config` automatically.

---

## 4. Running Automated Tests

Run the built-in Node.js test suite (zero external dependencies):

```bash
node --test tests/accounting.test.mjs
```

---

## 5. Pushing to GitHub

```bash
cd personal-finance-tracker
git init
git add .
git commit -m "Initial commit: TakaTrack Personal Finance Tracker PWA"
git branch -M main
git remote add origin https://github.com/<your-username>/personal-finance-tracker.git
git push -u origin main
```

---

## 6. Deploying to Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and import your `personal-finance-tracker` GitHub repository.
2. Leave **Framework Preset** as **Other** (no build step needed).
3. Under **Environment Variables**, add:
   - `SUPABASE_URL` = your Supabase Project URL
   - `SUPABASE_ANON_KEY` = your Supabase public `anon` key
4. Click **Deploy**.
5. Once deployed, copy your Vercel URL (e.g. `https://your-app.vercel.app`) and add it to Supabase **Authentication → URL Configuration → Site URL** and **Redirect URLs**.

---

## 7. Installing as a PWA on Mobile

- **Android (Chrome)**: Open your deployed Vercel URL → tap the **⋮** menu → **Add to Home screen / Install app**.
- **iOS (Safari)**: Open your deployed Vercel URL → tap the **Share** icon → **Add to Home Screen**.

---

## 8. Backup & Restore

- **CSV Export**: Open **Settings → Export CSV (Excel)** to download a UTF-8 BOM `.csv` file that opens cleanly in Microsoft Excel and Google Sheets.
- **JSON Backup**: Open **Settings → Download JSON Backup** to save all categories, people, transactions, and loan history.
- **JSON Restore**: Open **Settings → Restore JSON Backup** and select a previously exported `.json` file. Records are merged idempotently using unique mutation IDs to avoid duplicates.

---

## Important Limitations & Notes

- **Live Cloud Verification**: Supabase Auth, PostgreSQL RLS, and real mobile PWA installability require connecting your own live Supabase project and Vercel deployment via the steps above.
- **Offline Scope**: Offline queuing currently supports adding expenses and income while disconnected and syncs them automatically when internet returns. Viewing historical reports or editing existing cloud records requires an active connection.
- **Chart.js & Supabase SDK CDN**: The frontend loads `@supabase/supabase-js` and `Chart.js` from jsDelivr CDN; first online load caches the app shell via the service worker.
