# GCP Setup Walkthrough

Step-by-step instructions for creating a Google Cloud Platform project with OAuth credentials for the Google Multi-Account MCP.

## 1. Create a GCP Project

1. Go to https://console.cloud.google.com
2. Click the project selector dropdown (top bar)
3. Click "New Project"
4. Name it something like "Claude Google MCP"
5. Click Create, then select the new project

## 2. Enable APIs

1. Navigate to APIs & Services → Library
2. Search for "Gmail API" → Click → Enable
3. Search for "Google Calendar API" → Click → Enable

## 3. Configure OAuth Consent Screen

1. Go to Google Auth Platform → Branding (or APIs & Services → OAuth consent screen)
2. Select "External" user type → Create
3. Fill in required fields:
   - App name: "Claude Google MCP" (or anything you like)
   - User support email: your email
   - Developer contact email: your email
4. Click Save and Continue
5. Add scopes (click "Add or Remove Scopes"):
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/gmail.compose`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/calendar.events`
6. Save and Continue
7. Add Test Users: add every Google email address you plan to connect
8. Save

## 4. Create OAuth Client ID

1. Go to Google Auth Platform → Clients (or APIs & Services → Credentials)
2. Click "Create Credentials" → "OAuth client ID"
3. Application type: **Web application**
4. Name: "Claude MCP" (or anything)
5. Under "Authorized redirect URIs", click "Add URI":
   - Enter: `http://localhost:3847/oauth/callback`
6. Click Create
7. **Copy the Client ID and Client Secret** — you'll need these for the setup script

## 5. Important Notes

- The app will be in "Testing" mode, which means only test users can authenticate
- Google shows an "unverified app" warning — this is normal, click through it
- Test user status allows up to 100 users
- To remove the warning for public use, you'd need to go through Google's verification process

## 6. Multiple Google Workspace Accounts

If connecting a Google Workspace (company) account:
- The Workspace admin may need to allow the app
- Add the Workspace email as a test user in Step 3.7
- The same OAuth client works for both personal Gmail and Workspace accounts
