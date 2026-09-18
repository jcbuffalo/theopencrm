# Deployment Guide - Lightweight CRM

Complete step-by-step guide for deploying to Google Cloud Run with automated deployment pipelines.

## Prerequisites

- Google Cloud Project created
- `gcloud` CLI installed: https://cloud.google.com/sdk/docs/install
- Billing enabled on GCP project
- Docker installed locally (optional, Cloud Run can build from source)
- GitHub repository (for CI/CD pipelines)

## GCP Setup (One-time)

### 1. Initialize GCP Project

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# Or set project per command:
export GCP_PROJECT=your-project-id
```

### 2. Enable Required APIs

```bash
gcloud services enable compute.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable sqladmin.googleapis.com
gcloud services enable cloudbuild.googleapis.com
gcloud services enable artifactregistry.googleapis.com
```

### 3. Create Cloud SQL Instance

```bash
gcloud sql instances create lightweight-crm-db \
  --database-version POSTGRES_15 \
  --tier db-f1-micro \
  --region us-central1 \
  --storage-auto-increase

# Set password for postgres user
gcloud sql users set-password postgres \
  --instance lightweight-crm-db \
  --password YOUR_SECURE_PASSWORD

# Create database
gcloud sql databases create lightweight_crm \
  --instance lightweight-crm-db
```

**Save connection name**: `PROJECT_ID:us-central1:lightweight-crm-db`

## ⚠️ CRITICAL: Database Migrations & Cloud SQL Connection

Migrations run automatically on service startup in Cloud Run:

1. **Environment Variables** in `backend/.env.yaml`:
   - Use Unix socket for Cloud Run: `INSTANCE_CONNECTION_NAME=PROJECT_ID:us-central1:lightweight-crm-db`
   - Local dev uses TCP: `DB_HOST=localhost, DB_PORT=5432`

2. **Migration Files** in `backend/migrations/`:
   - Run automatically in alphabetical order
   - Only execute once per file (tracked in migrations table)
   - CRM-specific migrations: `010_contacts.sql`, `011_deals.sql`, `012_activities.sql`

3. **Example .env.yaml for Cloud Run**:
```yaml
DB_HOST: /cloudsql/PROJECT_ID:us-central1:lightweight-crm-db
DB_PORT: "5432"
DB_NAME: lightweight_crm
DB_USER: postgres
DB_PASSWORD: YOUR_PASSWORD
JWT_SECRET: your_jwt_secret_key
GOOGLE_CLIENT_ID: your_google_oauth_client_id
GOOGLE_CLIENT_SECRET: your_google_oauth_secret
FRONTEND_URL: https://lightweight-crm-web.run.app
NODE_ENV: production
INSTANCE_CONNECTION_NAME: PROJECT_ID:us-central1:lightweight-crm-db
```

## Deployment Options

### Option 1: Manual Deployment (Simple)

```bash
# Deploy Backend
gcloud run deploy lightweight-crm-api \
  --source backend/ \
  --platform managed \
  --region us-central1 \
  --memory 512Mi \
  --env-vars-file backend/.env.yaml \
  --add-cloudsql-instances PROJECT_ID:us-central1:lightweight-crm-db

# Deploy Frontend
gcloud run deploy lightweight-crm-web \
  --source frontend/ \
  --platform managed \
  --region us-central1 \
  --memory 256Mi
```

### Option 2: GitHub Actions CI/CD (Recommended)

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Cloud Run

on:
  push:
    branches: [ main ]

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Authenticate to Google Cloud
      uses: google-github-actions/auth@v1
      with:
        credentials_json: ${{ secrets.GCP_SA_KEY }}
    
    - name: Set up Cloud SDK
      uses: google-github-actions/setup-gcloud@v1
    
    - name: Deploy Backend
      run: |
        gcloud run deploy lightweight-crm-api \
          --source backend/ \
          --region us-central1 \
          --platform managed \
          --set-env-vars-file backend/.env.yaml
    
    - name: Deploy Frontend
      run: |
        gcloud run deploy lightweight-crm-web \
          --source frontend/ \
          --region us-central1 \
          --platform managed
```

## Google OAuth Setup

### Create OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Navigate to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
3. Select **Web Application**
4. Add authorized origins:
   - `http://localhost:3000` (development)
   - `https://lightweight-crm-web.run.app` (production)
5. Add authorized redirect URIs:
   - `http://localhost:3000/auth/callback` (development)
   - `https://lightweight-crm-web.run.app/auth/callback` (production)
6. Copy Client ID and Client Secret

### Update Environment Variables

**Backend `.env.yaml`:**
```yaml
GOOGLE_CLIENT_ID: <your-client-id>
GOOGLE_CLIENT_SECRET: <your-client-secret>
FRONTEND_URL: https://lightweight-crm-web.run.app
```

**Frontend `.env.production`:**
```
REACT_APP_GOOGLE_CLIENT_ID=<your-client-id>
REACT_APP_API_URL=https://lightweight-crm-api.run.app
```

## Deployment Checklist

- [ ] GCP project created and APIs enabled
- [ ] Cloud SQL instance created with database
- [ ] Google OAuth credentials created
- [ ] Backend `.env.yaml` configured with all secrets
- [ ] Frontend `.env.production` configured
- [ ] Backend deployed: `gcloud run deploy lightweight-crm-api --source backend/`
- [ ] Frontend deployed: `gcloud run deploy lightweight-crm-web --source frontend/`
- [ ] OAuth redirect URIs added to credentials
- [ ] Test login flow
- [ ] Monitor logs: `gcloud run logs read lightweight-crm-api`

## Health Checks & Monitoring

### Health Check Endpoint
Backend includes health check at `GET /health` - Cloud Run uses this automatically

### View Logs
```bash
gcloud run logs read lightweight-crm-api --limit 50
gcloud run logs read lightweight-crm-web --limit 50
```

### View Service Status
```bash
gcloud run services list
gcloud run services describe lightweight-crm-api --region us-central1
```

## Scaling & Performance

### Auto-scaling Configuration
Cloud Run automatically scales based on requests:
- Min instances: 0 (default) - cold starts apply
- Max instances: 100 (default)
- Memory: 512Mi backend, 256Mi frontend (configurable)

### For Always-On Service
```bash
gcloud run services update lightweight-crm-api \
  --region us-central1 \
  --min-instances 1
```

## Troubleshooting

### "SequelizeError: password authentication failed"
- Check DB_HOST is Unix socket path: `/cloudsql/PROJECT_ID:region:instance`
- Verify Cloud SQL Auth proxy is enabled
- Check DB_PASSWORD in `.env.yaml`

### OAuth "redirect_uri_mismatch" error
- Frontend URL must match authorized redirect URI exactly
- Include protocol: `https://` not `http://`
- No trailing slashes

### CORS errors during login
- Check `FRONTEND_URL` env var matches actual frontend domain
- Restart backend after changing `FRONTEND_URL`

### Migrations not running
- Check migration files exist in `backend/migrations/`
- Verify database connection works
- Check Cloud Run logs: `gcloud run logs read lightweight-crm-api`

## References

- [Google Cloud Run Documentation](https://cloud.google.com/run/docs)
- [Cloud SQL Proxy Documentation](https://cloud.google.com/sql/docs/postgres/cloud-sql-proxy)
- [GitHub Actions Google Cloud Deploy](https://github.com/google-github-actions)

## Cost Estimation

**Monthly costs (rough):**
- Cloud Run API (backend): ~$7 (for 1M requests)
- Cloud Run Web (frontend): ~$3 (for 1M requests)
- Cloud SQL f1-micro: ~$4 (minimal tier)
- Total: ~$14/month for small deployments

Scale will increase costs based on usage.
