# Reputation Pulse — Setup Guide (no coding required, just following steps)

This runs on its own, checks Google for new reviews every day, drafts replies
with Claude, and emails you a digest once a month.

You don't need to write any code. But you will need to:
- Create a few free accounts (Google Cloud, Anthropic, Resend)
- Copy/paste some values into one file
- Type a few commands into a terminal (copy-paste, not typing code)

Budget about 45-60 minutes for first-time setup, plus however long Google
takes to approve API access (this can take 2-4+ weeks — see Step 2).

---

## Step 0: Install Node.js

This project runs on Node.js. Download and install it from https://nodejs.org
(choose the "LTS" version). This is a one-time install on your computer.

---

## Step 1: Get your Anthropic API key

1. Go to https://console.anthropic.com and sign up / log in
2. Go to "API Keys" and create a new key
3. Copy it somewhere safe — you'll paste it into `.env` in Step 5

---

## Step 2: Apply for Google Business Profile API access

This is the step that takes the longest, so start it first.

1. Go to https://console.cloud.google.com and create a new project
2. Search for and enable these three APIs in your project:
   - "My Business Account Management API"
   - "My Business Business Information API"
   - "My Business API"
3. Go to "APIs & Services" → "Credentials" → "Create Credentials" → "OAuth client ID"
   - Application type: "Web application"
   - Add an "Authorized redirect URI": `http://localhost:3000/auth/google/callback`
     (you'll update this later once your server has a real web address)
   - Save your Client ID and Client Secret — you'll need them in Step 5
4. Google restricts these APIs by default. Look for "Business Profile API
   access request" in the Google Cloud docs and submit the form explaining
   you're building review management tooling for a small business you
   own/manage. Approval can take a few weeks — you can build and test
   everything else in the meantime.

---

## Step 3: Get a Resend email API key (for the digest email)

1. Go to https://resend.com and sign up (free tier is enough)
2. Create an API key and copy it
3. For testing, you can send from their default `onboarding@resend.dev`
   address. To send from your own business email later, you'll verify your
   domain in Resend's dashboard.

---

## Step 4: Download and open this project

1. Unzip the project folder you downloaded onto your computer
2. Open a terminal:
   - **Mac**: open the "Terminal" app
   - **Windows**: open "Command Prompt" or "PowerShell"
3. In the terminal, navigate into the folder. For example:
   ```
   cd Downloads/reputation-pulse-server
   ```
4. Install the project's dependencies (this downloads the small libraries
   the code needs to run):
   ```
   npm install
   ```

---

## Step 5: Fill in your `.env` file

1. In the project folder, copy `.env.example` and rename the copy to `.env`
2. Open `.env` in any text editor (Notepad, TextEdit, VS Code, etc.)
3. Paste in the values you collected:
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (Step 2)
   - `ANTHROPIC_API_KEY` (Step 1)
   - `RESEND_API_KEY` and `OWNER_EMAIL` (Step 3 — OWNER_EMAIL is where the
     digest gets sent, e.g. your own email)
   - `BUSINESS_NAME` and `REPLY_TONE` — set these to match your business
4. Save the file

---

## Step 6: Run it

In your terminal, still inside the project folder, run:
```
npm start
```

You should see a message like:
```
Reputation Pulse server running at http://localhost:3000
```

Open that address in your web browser. Click "Connect Google" and approve
access (this only works once Google has approved your API access from
Step 2). Once connected, click "Check for new reviews now" to pull in your
first batch and see drafted replies appear.

---

## Step 7: Keep it running 24/7 (so it works even when your computer is off)

Running it on your own computer only works while that computer is on. To
have it run automatically forever, deploy it to a hosting service like
Render (https://render.com):

1. Push this project folder to a GitHub repository (GitHub has guides on
   this if you're new to it — search "upload a folder to GitHub")
2. In Render, choose "New Web Service" and connect your GitHub repo
3. Set the same environment variables from your `.env` file in Render's
   dashboard (under "Environment")
4. Update `GOOGLE_REDIRECT_URI` in both Render's environment variables AND
   your Google Cloud OAuth settings to match your new Render web address,
   e.g. `https://your-app-name.onrender.com/auth/google/callback`
5. Deploy — Render will give you a live URL you can visit anytime

---

## What runs automatically once it's live

- **Every day at 8am**: checks Google for new reviews.
  - **4-5 star reviews**: a reply is drafted and **posted automatically** —
    no action needed from you.
  - **1-3 star reviews**: two reply options are drafted and left on the
    dashboard marked "Needs your approval." Nothing gets posted until you
    click "Post this reply" on the one you want to use.
- **The 1st of every month at 8am**: builds a digest from the last 30 days
  of reviews and emails it to `OWNER_EMAIL`

You can change which star ratings auto-post vs. wait for approval by
editing `AUTO_POST_STARS` and `DRAFT_ONLY_STARS` near the top of
`lib/scheduler.js`.

---

## If something breaks

- Check the terminal output (or Render's "Logs" tab once deployed) — every
  part of this code prints a clear error message when something fails
- Common issues: a typo in `.env`, Google API access not yet approved, or
  the redirect URI not matching exactly between Google Cloud and your `.env`
