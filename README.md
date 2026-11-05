# School Progress Management System (MVP)

A secure, deliberately basic web platform where **teachers record attendance and daily performance** and **authorised parents securely monitor their own children**. Administrators manage the school. Blue-and-yellow with white highlights, mobile-first.

**Stack (as in the specification):** HTML + CSS + JavaScript · Supabase (Auth, PostgreSQL, Row Level Security) · Vercel · Git/GitHub.
No frameworks, no build step, no third-party scripts, fonts or images loaded at run time.

---

## 1. What is in the project

```text
school-system/
├── index.html about.html (about + contact form) academics.html admissions.html news.html contact.html   public website
├── login.html  reset-password.html                                               sign in / set or reset password
├── admin/    dashboard, students, teachers, parents, classes, subjects,
│             academic-years, semester, corrections, news
├── teacher/  dashboard, class, attendance, performance
├── parent/   dashboard, child, attendance, performance
├── css/      style.css  dashboard.css  responsive.css
├── js/       config.js  supabase.js  auth.js  ui.js  validation.js
│             admin.js  teacher.js  parent.js  contact.js  news.js  news-admin.js
│             vendor/supabase.js        (supabase-js 2.116.0, MIT, served from this site)
├── supabase/
│   ├── 01_schema.sql        tables + constraints
│   ├── 02_security.sql      RLS, privileges, business-rule triggers, audit log
│   ├── 03_functions.sql     semester closure, promotion, corrections (atomic transactions)
│   ├── 04_first_admin.sql   creates the first administrator
│   ├── 05_mvp_improvements.sql   parent notifications and MVP updates
│   ├── 06_news_and_programmes.sql   public news, admin policies, flyer storage
│   ├── 07_academic_records_lesson_notes.sql   lesson notes and approvals
│   └── functions/admin-create-account/index.ts   server-side account creation
├── tests/    SQL security test-suite (111 checks)
├── vercel.json   security headers incl. strict Content-Security-Policy
└── robots.txt
```

## 2. Setup (about 30 minutes)

### Step 1 - Supabase project
Create a project at supabase.com. Then **SQL Editor → run the files in this order:** `01_schema.sql`, `02_security.sql`, `03_functions.sql`, `05_mvp_improvements.sql`, `06_news_and_programmes.sql`, and `07_academic_records_lesson_notes.sql` in that order. Run `04_first_admin.sql` separately after creating the first admin Auth user, following the instructions in that file.

### Step 2 - Lock down sign-up (important)
In **Authentication → Sign In / Providers**:
1. Turn **OFF "Allow new users to sign up"**. Nobody can register themselves; only administrators create accounts.
2. Leave **Anonymous sign-ins** off.
3. Email provider → set **minimum password length to 12** and require lowercase, uppercase and digits. If your plan offers it, turn on **leaked-password protection**.

Even if sign-up were left on by mistake, a stranger's account has no profile row, so the database gives it access to nothing.

**Authentication → URL Configuration:** set *Site URL* to your final address (e.g. `https://your-school.vercel.app`) and add `https://your-school.vercel.app/reset-password.html` to *Redirect URLs*.

**Authentication → Email Templates** - paste these link formats (they keep the one-time token from being consumed by email scanners):

*Reset password*
```html
<h2>Reset your password</h2>
<p><a href="{{ .SiteURL }}/reset-password.html?token_hash={{ .TokenHash }}&type=recovery">Choose a new password</a></p>
```
**Email delivery:** Supabase's built-in sender is intended for testing and is heavily rate-limited. Configure your own SMTP service (**Authentication → SMTP Settings**) before relying on password-reset emails for real users.

### Step 3 - First administrator
Follow the instructions at the top of `supabase/04_first_admin.sql` (create the user in the dashboard, then run the script). Teachers and parents are afterwards created from the website.

### Step 4 - Deploy the account-creation function
Creating a login needs the *service-role* key, which must never be in website code, so this one operation runs on Supabase's servers:

```bash
npm i -g supabase            # or see supabase.com/docs/guides/cli
supabase login
supabase init                # only if asked for a config; it does not touch supabase/functions
supabase link --project-ref YOUR-PROJECT-REF
supabase functions deploy admin-create-account
```
The function verifies that the caller is an active administrator and can only create `teacher` and `parent` accounts. The admin sets an initial password (12–72 characters with uppercase, lowercase, and a number); share it securely and ask the user to use **Forgot password** to set a private password as soon as possible. This implementation confirms the Auth email and does not send an invitation email. Password-reset email is sent through Supabase Auth.

### Step 5 - Configure the website
Edit **`js/config.js`**: project URL, public publishable/anon key (Project Settings → API), school name, school email. The public key is expected in browser code; Row Level Security must protect all data. *Never* put the `service_role` or secret key anywhere in this project.
Review every public page for factual accuracy (school name, history, address, phone numbers, admissions status, and claims) before publishing.

### Step 6 - Deploy
Push to GitHub → import in Vercel → *Framework preset: Other*, no build command, output directory = project root. `vercel.json` adds the security headers automatically. To try locally first: `npx serve .` (headers are Vercel-only).

## MVP improvement update (October 2026)

- The teacher-facing semester-results entry point and `teacher/results.html` page have been removed. Teachers now focus on attendance and daily student performance ratings; semester summaries remain available through the existing administrator closure workflow and parent history.
- Responsive layout hardening has been added for narrow phones, landscape phones, tablets and laptop/desktop widths, including overflow-safe tables, larger touch targets, and responsive parent notification cards.
- A secure `parent_notifications` table now records in-app alerts for absent/late attendance, daily performance ratings, semester summaries after semester closure, academic-year progression, and graduation. Parents can mark alerts as read. The notification table uses RLS and only allows a parent to read their own notifications; the database triggers write events.
- Existing student records, attendance, performance, semester summaries, promotion history and audit records are preserved. No existing records were deleted as part of this update.
- This MVP provides in-app notifications when the parent opens or refreshes the portal; it does not yet send SMS, email, or browser push notifications.

Run `supabase/05_mvp_improvements.sql` only if applying the improvement set to another environment. The connected Supabase project has already received the changes.

## Academic records and lesson notes

- Admins can export semester summaries from **Academic Records**. Filters use class, student, semester, and academic year. Attendance, overall results, ratings, remarks, and subject breakdowns are read from the existing summary tables; percentages follow `03_functions.sql`. ExcelJS is served locally from `js/vendor/` and the workbook is configured for landscape printing.
- Teachers submit lesson notes from **Lesson Notes** as PDF, JPG, PNG, or WebP (up to 15 MB). Notes are private in the `lesson-notes` Storage bucket. The migration creates the bucket, row/object policies, notification triggers, and `decide_lesson_note` RPC. Admins review from **Lesson Notes**; rejected notes include a reason and can be edited/replaced and resubmitted by their submitting teacher.
- Apply the new migration once to each Supabase environment. No new Vercel secrets are required. The migration relies on the existing Supabase Storage schema and existing `private` role/assignment helpers, so run it after the main schema and security files.
- Private document previews use short-lived signed URLs. The Vercel `frame-src` allowance is limited to the project’s Supabase host pattern; scripts remain same-origin only.

## 3. How security is built in

| Layer | What it does |
|---|---|
| **No self-registration** | Sign-up disabled; accounts created only by an admin (invitation email). First admin created manually. |
| **Roles live in the database** | `profiles.role` cannot be edited from the site (column privileges), not even by an admin. Deactivating a profile cuts access immediately, even for a logged-in session. |
| **Row Level Security on every table** | Parent → only children linked to them. Teacher → only classes/subjects assigned to them. Admin → school management. Guessing another child's ID returns nothing. Anonymous users can read only published news and public flyers; portal data remains inaccessible. |
| **Least privilege writes** | Column-level grants: e.g. a teacher can only set `status` on attendance, never re-point a record to another student; student IDs are immutable. |
| **Integrity in the database** | One attendance record per student/class/semester/date (unique constraint); ratings 1-5; percentages 0-100; comments ≤ 500 chars; student ID format; consecutive academic years; only one active semester. |
| **Time rules** | Teachers can only create/edit **today's** records, only in the **active** semester, only for students actually enrolled. |
| **Atomic semester closure** | Prepare → review → typed confirmation → one PostgreSQL transaction: summaries, closure, eligible clean-up, audit entry. Any failure rolls everything back. Closed semesters cannot be reopened or edited. |
| **Audit log** | Written by database triggers (cannot be skipped by the website); append-only - even the admin cannot edit or delete entries. |
| **XSS** | No `innerHTML` anywhere; all text is inserted as text. Teacher comments containing HTML are displayed as harmless text. |
| **SQL injection** | No SQL is built in the browser. Search is filtered client-side; all queries use Supabase's parameterised API. |
| **Content-Security-Policy** | `script-src 'self'`, no inline scripts/styles, no third-party hosts except your Supabase project; `frame-ancestors 'none'`; HSTS; nosniff; strict referrer and permissions policies. |
| **Sessions** | Server-verified session on every portal page, 30-minute inactivity logout (`IDLE_TIMEOUT_MINUTES`), logout, generic login errors, client back-off after 5 failed attempts (Supabase enforces its own rate limits too). |
| **Privacy by design** | Students: ID, first name, last name, parent, status only. Parents see final semester results only after closure. |

> The website's JavaScript decides what is **shown**. The database decides what is **allowed**.

## 4. Decisions the specification did not state

You asked for nothing invented, so these are the places where I had to choose or add something. Please confirm them with the school - each is a small, isolated change.

1. **Percentages.** The spec shows "Mathematics 82%" but the MVP has no exam or test scores. Percentages are therefore **calculated from the daily ratings** (average of the four ratings ÷ 5 × 100). Overall % = average of subject %. If the school wants real marks, an assessment table is needed. Rules are in comments at the top of `03_functions.sql`.
2. **Attendance %** counts **Present + Late** as attended.
3. **Corrections (§39):** same day → teacher edits directly; **any earlier day → correction request → admin approves/rejects**. (The spec's "previous day" and "older records" both end with admin approval.) This needs one extra table `attendance_corrections` and page `admin/corrections.html`. Corrections cover **attendance only**, as in the spec heading.
4. **Retention.** No retention period is invented. `school_settings.detail_retention_days` is empty until the school approves a number on the *Semester* page. While empty, **nothing is ever deleted**. When set, closing a semester (or a later "Clean up") removes only daily records older than that period. Summaries are always kept.
5. Semesters are **1 or 2** (spec examples). Student IDs look like **ST001** (`ST` + 3-6 digits, from the spec example).
6. **`teacher_assignments` also stores the academic year** so assignments can change each year.
7. **Admins** are created manually (step 3); the site creates only teachers and parents, so nobody can grant themselves admin.
8. **One parent per student** (the spec's "Parent" field is singular).
9. **Final teacher remark and promotion status** are entered by the admin during the closure review (teachers may not touch summaries per §31).
10. **Notifications (§42)** are worked out from the records themselves - no notifications table.
11. **Extra columns/tables:** `profiles.email` (so admins can tell accounts apart), `school_settings`, `semesters.closure_prepared_at`.
12. **Server-side function** for account creation (see step 4). The spec says no separate backend; this is a small function hosted by Supabase, not a server you run, and it is unavoidable for safe account creation.
13. supabase-js is **copied into `js/vendor/`** instead of loaded from a CDN, so the CSP can stay strict.
14. **Public pages** contain placeholders, not made-up facts. The contact form opens the visitor's email app (nothing is stored). News and programmes are managed by admins and stored in Supabase.
15. School time zone is `Africa/Accra` in two places: `SCHOOL_TIMEZONE` (config.js) and `private.today()` (02_security.sql).

## 5. Known limits (honest list)

- **Not yet run against a live Supabase project, real email delivery, the Edge Function, or Vercel** - see "Testing". Do the checklist in section 6 before real use.
- The Supabase session token is kept in the browser's local storage (normal for browser-only apps). The strict CSP and the no-`innerHTML` rule are the mitigation. No MFA yet (spec: "later").
- Teachers cannot record a day they missed (only today). An admin can correct existing records; adding a *missing* past register is out of scope.
- Lists load up to 1,000 rows per query (Supabase default) - fine for ~450 students; add paging for larger schools.
- Clean-up deletes are permanent: keep Supabase backups enabled (or take a manual export) before closing a semester once a retention period is set.

## 6. Go-live checklist

- [ ] Sign-up disabled; try `curl -X POST "https://REF.supabase.co/auth/v1/signup" -H "apikey: ANON" -H "Content-Type: application/json" -d '{"email":"x@y.com","password":"Aaaaaaaaaa1!"}'` → must be refused.
- [ ] `curl "https://REF.supabase.co/rest/v1/students" -H "apikey: ANON"` (not logged in) → must be refused.
- [ ] Two parent accounts, two children: each sees only their own (including by editing IDs in the URL).
- [ ] Teacher sees only assigned classes; cannot open another class's attendance URL.
- [ ] Deactivate a teacher while they are logged in → their next action shows no data / logs them out.
- [ ] Invitation email arrives; link sets a password; forgot-password works.
- [ ] Attendance: second save for the same day updates, never duplicates; airplane mode shows "Connection lost…" and never "saved".
- [ ] Run one full semester closure on **test data** (prepare → review → confirm) before real use.
- [ ] Verify the public news page shows published news and programmes, and an admin can create, edit, and delete posts and upload flyers.
- [ ] Check headers at securityheaders.com; Supabase backups enabled; SMTP configured.

## 7. Testing

`tests/` contains a **security test-suite for the database** (111 checks: RLS for every role, column privileges, duplicate/rating/date rules, corrections, semester closure maths, retention, promotion, audit immutability, function permissions). It runs on a throw-away PostgreSQL with a small stand-in for Supabase's `auth` schema:

```bash
PSQL="psql -U postgres" ./tests/reset.sh
PSQL="psql -U postgres" python3 tests/rls_test.py
```
Run `reset.sh` before **every** run (the tests leave data behind). Never point it at your real project. Results at hand-over: **111 / 111 pass** on PostgreSQL 16. The website was additionally exercised page-by-page in a simulated browser against a mock Supabase (all 17 portal pages render, XSS text stays inert, validation and closure confirmation behave).
