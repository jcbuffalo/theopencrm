# Lightweight CRM - Quick Start Guide

Get up and running in 5 minutes.

## 1. Install Dependencies

### Backend
```bash
cd backend
npm install
```

### Frontend
```bash
cd frontend
npm install
```

## 2. Set Up Database (Local Development)

### Create PostgreSQL database
```bash
createdb lightweight_crm
```

### Copy environment file
```bash
cd backend
cp .env.example .env
```

Edit `.env`:
```
DB_HOST=localhost
DB_PORT=5432
DB_NAME=lightweight_crm
DB_USER=postgres
DB_PASSWORD=your_password
JWT_SECRET=your_secret_key
FRONTEND_URL=http://localhost:3000
```

### Run migrations
```bash
npm run migrate
```

## 3. Set Up Google OAuth (Optional but Recommended)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create OAuth 2.0 credentials (Web Application)
3. Add authorized origins:
   - `http://localhost:3000`
4. Add redirect URIs:
   - `http://localhost:3000/auth/callback`
5. Copy Client ID and Secret into `.env`

## 4. Start Development Servers

### Backend (Terminal 1)
```bash
cd backend
npm run dev
```
Server runs on `http://localhost:5001`

### Frontend (Terminal 2)
```bash
cd frontend
npm start
```
App opens at `http://localhost:3000`

## 5. Test the App

1. Navigate to `http://localhost:3000/login`
2. Click "Sign in with Google" or create an account
3. After login, you'll see the dashboard

## API Endpoints (So Far)

### Authentication
- `POST /api/auth/login` - Login with email/password
- `POST /api/auth/register` - Create account
- `POST /api/auth/google-signin` - Google OAuth
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Current user

### Contacts (⚠️ Routes ready, UI to be implemented)
- `GET /api/contacts` - List all contacts
- `POST /api/contacts` - Create contact
- `GET /api/contacts/:id` - Get contact details
- `PUT /api/contacts/:id` - Update contact
- `DELETE /api/contacts/:id` - Delete contact

### Deals (⚠️ Routes ready, UI to be implemented)
- `GET /api/deals` - List all deals
- `POST /api/deals` - Create deal
- `PUT /api/deals/:id` - Update deal
- `DELETE /api/deals/:id` - Delete deal

### Activities (⚠️ Routes ready, UI to be implemented)
- `GET /api/activities` - List all activities
- `GET /api/activities/contact/:contact_id` - Activities for contact
- `GET /api/activities/deal/:deal_id` - Activities for deal
- `POST /api/activities` - Create activity
- `PUT /api/activities/:id` - Update activity
- `DELETE /api/activities/:id` - Delete activity

## Database Schema

### Contacts
```sql
id, user_id, first_name, last_name, email, phone, company, 
job_title, source, notes, tags, status, created_at, updated_at
```

### Deals
```sql
id, user_id, contact_id, title, description, amount, currency, 
stage, expected_close_date, closed_date, probability, notes, tags, created_at, updated_at
```

### Activities
```sql
id, user_id, contact_id, deal_id, type, title, description, 
activity_date, duration_minutes, outcome, notes, attachments, created_at, updated_at
```

## Common Issues

### "Cannot find module" error
```bash
# Make sure you're in the right directory
cd backend  # or frontend
npm install
```

### Database connection failed
- Check PostgreSQL is running
- Verify `DB_HOST`, `DB_PORT`, `DB_NAME` in `.env`
- Make sure database exists: `createdb lightweight_crm`

### Port already in use
```bash
# Find process using port 5001 (backend)
lsof -i :5001
kill -9 <PID>

# Or use different port:
PORT=5002 npm run dev
```

## Next Steps

1. Build the contact management UI (`frontend/src/pages/Contacts.js`)
2. Build the deal pipeline UI (`frontend/src/pages/Deals.js`)
3. Build the activities feed UI (`frontend/src/pages/Activities.js`)
4. Add dashboard with key metrics
5. Deploy to Google Cloud Run (see DEPLOYMENT.md)

## File Structure

```
lightweight-crm/
├── backend/
│   ├── routes/
│   │   ├── authRoutes.js      ✅ Ready
│   │   ├── contactRoutes.js   ✅ Ready
│   │   ├── dealRoutes.js      ✅ Ready
│   │   └── activityRoutes.js  ✅ Ready
│   ├── migrations/
│   │   ├── 010_create_contacts.sql
│   │   ├── 011_create_deals.sql
│   │   └── 012_create_activities.sql
│   ├── middleware/
│   │   └── authMiddleware.js
│   ├── db.js                  (PostgreSQL connection)
│   ├── index.js               (Express server)
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Login.js       ✅ Ready
│   │   │   ├── Dashboard.js   📋 To implement
│   │   │   ├── Contacts.js    📋 To implement
│   │   │   ├── Deals.js       📋 To implement
│   │   │   └── Activities.js  📋 To implement
│   │   ├── AuthContext.js     ✅ Ready
│   │   └── api.js             ✅ Ready
│   └── package.json
├── DEPLOYMENT.md              (Cloud Run setup)
├── README.md                  (Project overview)
└── QUICKSTART.md              (This file)
```

## Support

- See `CLAUDE.md` for project guidelines
- See `DEPLOYMENT.md` for production setup
- See `README.md` for full feature documentation
