# The Open CRM — Setup & First Steps Guide

**Status**: ✅ Week 1 Complete - Backend & Frontend Deployed  
**What's Live**: API + Landing Page + App Architecture (missing: Google OAuth credentials)  
**Next Step**: Configure Google OAuth to enable login

---

## 🚀 Current State (April 25, 2026)

### What's Deployed
✅ **Backend API** - https://synccrm-backend-615440681743.us-central1.run.app
- All CRUD endpoints working
- Database connected and migrated
- Auth middleware ready

✅ **Frontend SPA** - https://synccrm-frontend-615440681743.us-central1.run.app
- Landing page live and beautiful
- App pages built (Dashboard, Companies, Contacts, Deals, Activities, Tasks)
- Login page ready (waiting for Google OAuth credentials)

✅ **Database** - Cloud SQL PostgreSQL
- 6 tables created (companies, contacts, deals, activities, tasks, pipelines)
- Auto-migrations on startup
- User isolation (multi-tenant ready)

✅ **Domain** - theopencrm.com (ready for DNS mapping)

### What's Missing (Required for Login)
❌ **Google OAuth Credentials** - Need to create in GCP Console

---

## 🔐 Set Up Google OAuth (5 minutes)

### Step 1: Go to GCP Console
1. Open: https://console.cloud.google.com/
2. Select project: **xfte-platform**
3. Navigate to: **APIs & Services** → **Credentials**

### Step 2: Create OAuth 2.0 Credential
1. Click: **Create Credentials** → **OAuth 2.0 Client ID**
2. Application type: **Web application**
3. Name: "The Open CRM Frontend"
4. Authorized JavaScript origins:
   ```
   https://synccrm-frontend-615440681743.us-central1.run.app
   https://theopencrm.com
   http://localhost:3000
   ```
5. Authorized redirect URIs:
   ```
   https://synccrm-frontend-615440681743.us-central1.run.app/login
   https://theopencrm.com/login
   http://localhost:3000/login
   ```
6. Click: **Create**
7. Copy the **Client ID** (looks like: `123456-abc.apps.googleusercontent.com`)

### Step 3: Update Frontend with Client ID
```bash
cd /c/Users/jbcol/projects/lightweight-crm

# Set the Google Client ID in Cloud Run
gcloud run deploy synccrm-frontend \
  --image gcr.io/xfte-platform/synccrm-frontend:latest \
  --region us-central1 \
  --set-env-vars "REACT_APP_GOOGLE_CLIENT_ID=YOUR_CLIENT_ID_HERE"
```

Replace `YOUR_CLIENT_ID_HERE` with the Client ID from Step 2.

### Step 4: Test Login
Visit: https://synccrm-frontend-615440681743.us-central1.run.app/login
- Click "Continue with Google"
- Sign in with your Google account
- You should see the Dashboard with stats

---

## 📂 Project Structure (Everything in One Folder)

```
lightweight-crm/
├── backend/
│   ├── routes/              ← CRUD endpoints for all 6 resources
│   ├── migrations/          ← Database schema SQL files
│   ├── index.js            ← Express server entry point
│   ├── db.js               ← PostgreSQL connection
│   ├── auth.js             ← JWT + authMiddleware
│   ├── package.json        ← Dependencies
│   └── Dockerfile          ← Container definition
│
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Landing.js          ← Public landing page
│   │   │   ├── Login.js            ← Login with Google OAuth
│   │   │   ├── Dashboard.js        ← Main app home
│   │   │   ├── Companies.js        ← CRUD companies
│   │   │   ├── Contacts.js         ← CRUD contacts
│   │   │   ├── Deals.js            ← Sales pipeline
│   │   │   ├── Activities.js       ← Call/email/meeting log
│   │   │   └── Tasks.js            ← Task management
│   │   ├── components/
│   │   │   ├── DataTable.js        ← Reusable table
│   │   │   ├── CompanyForm.js      ← Create/edit company
│   │   │   └── ContactForm.js      ← Create/edit contact
│   │   ├── AuthContext.js          ← Global auth state
│   │   ├── api.js                  ← Axios client with JWT
│   │   └── App.js                  ← Router (Landing + App pages)
│   ├── package.json        ← Dependencies
│   └── Dockerfile          ← Container definition
│
├── CLAUDE.md               ← FULL PROJECT CONTEXT (start here!)
├── SETUP_GUIDE.md          ← This file - how to configure & test
├── CONTEXT_SUMMARY.md      ← 15-min product overview
├── STRATEGIC_PLAN.md       ← 12-week roadmap & features
├── IMPLEMENTATION_CHECKLIST.md ← Week-by-week tasks
├── GCLOUD_DEPLOYMENT.md    ← Deployment commands
└── .claude/
    ├── settings.json       ← Project metadata
    ├── STATUS.md          ← Week 1 progress
    └── DECISIONS.md       ← Key decisions with rationale
```

---

## 💻 Local Development (Optional)

### Start Backend
```bash
cd backend
npm install
npm run dev
# Runs on http://localhost:5001
```

### Start Frontend
```bash
cd frontend
npm install
npm start
# Runs on http://localhost:3000
# Update .env to point to local backend
```

---

## 🎯 Next Steps After Google OAuth Setup

1. **Test login** at https://synccrm-frontend-615440681743.us-central1.run.app
2. **Create test data**: Add a company, contact, and deal
3. **Week 2 tasks**: See IMPLEMENTATION_CHECKLIST.md
   - AI enrichment (contact summaries)
   - Deal win probability scoring
   - Activity auto-summarization

---

## 📋 Key Files to Know

| File | Purpose |
|------|---------|
| **CLAUDE.md** | Complete project context for Claude Code sessions |
| **SETUP_GUIDE.md** | This file - how to get started |
| **IMPLEMENTATION_CHECKLIST.md** | Your task list (work from this) |
| **backend/index.js** | Express server + migrations runner |
| **frontend/src/App.js** | Router configuration |
| **backend/routes/*.js** | API endpoints |
| **frontend/src/pages/*.js** | App pages |

---

## 🆘 Troubleshooting

### Frontend shows blank page
- Check browser console for errors
- Verify REACT_APP_API_URL is set correctly in Cloud Run
- Make sure backend service is running

### Backend API returning 500 errors
- Check Cloud Logs: `gcloud logging read --limit=50`
- Verify Cloud SQL instance is running
- Check environment variables are set correctly

### Google sign-in not working
- Verify REACT_APP_GOOGLE_CLIENT_ID is set
- Check GCP Console has correct authorized URIs
- Try incognito window (cookie issues)

### Database connection failing
- Verify Cloud SQL user exists: `gcloud sql users list --instance=xfte-postgres`
- Verify INSTANCE_CONNECTION_NAME is correct
- Check DB_USER and DB_PASSWORD match

---

## 📞 For Next Session

When you open this project in Claude Code again:

1. Read **CLAUDE.md** (5 min) - full context
2. Check **.claude/STATUS.md** - where you left off
3. Open **IMPLEMENTATION_CHECKLIST.md** - see what's next
4. Start coding - all context is in place

No need to re-explain anything - all decisions are documented in STRATEGIC_PLAN.md and DECISIONS.md.

---

**All systems ready. Just add Google OAuth credentials and you're live.** 🚀


## Email transport: Gmail vs SendGrid

Gmail app-password SMTP is a getting-started transport: roughly 500 sends/day
account cap (the sequence worker self-pauses at 400/day; override with
GMAIL_DAILY_SEND_CAP), weaker deliverability for customer-facing volume, and
account-suspension risk. For production volume set SENDGRID_API_KEY with a
verified domain sender (SMTP_FROM) - it takes precedence over Gmail
automatically when both are configured.
