# Public homepage review and pre-deployment checklist

## Scope of this change

This branch adds a public company landing page while preserving the existing ERP application behind authentication.

### Routes

| Route | Expected behavior |
| --- | --- |
| `/` and `/index.html` | Public company homepage |
| `/login.html` | Existing login page |
| `/signup.html` | Existing staff sign-up page |
| `/erp` and `/erp/` | Existing protected ERP dashboard (`index.html`) |
| `/admin.html` | Existing administrator page; session and role checks remain in place |
| `/api/public/news` | Read-only public view of the existing news cache |
| `/api/db` and other ERP APIs | Existing authentication and permission checks |

## Data protection

- No production data file is read or changed by the smoke test.
- The smoke test starts the server with a fresh temporary `DATA_DIR` and deletes it on exit.
- The change does not edit database schemas, user records, employee permissions, reports, uploaded files, backups, or authentication secrets.
- No production deployment or merge to `main` is part of this change.

## Automated checks

The GitHub Actions workflow `.github/workflows/public-homepage-smoke.yml` runs:
1. `npm ci`
2. `node --check server.js`
3. `node scripts/smoke-public-homepage.js`

The smoke test checks public homepage access, public news response, unauthenticated ERP/API protection, administrator login, authenticated ERP access, and public sign-up page access.

## Business details still required

Do not invent these details. Confirm them from official company records before replacing placeholders:
- Legal company name and exact Korean/Chinese character styling
- Business registration address and main telephone number
- Official contact email and public inquiry channel
- Establishment date and verified company milestones
- Confirmed business lines and service descriptions
- Approved company profile and nomination/proposal (지명원) files
- Approved logo, brand colors, and any required legal/footer disclosures

## Manual review before production

- [ ] Open the public homepage on desktop and mobile.
- [ ] Verify all navigation anchors and the small ERP link at the far right of the header.
- [ ] Verify the public news cards show source, date, and safe original links when the cache contains articles.
- [ ] Verify the empty/stale-news states are clear and do not imply current reporting.
- [ ] Log in as an administrator and confirm dashboard, admin page, logout, and staff management.
- [ ] Log in as an approved staff member and confirm the correct permissions and dashboard behavior.
- [ ] Confirm direct access to `/api/db`, file, backup, restore, and administrative endpoints remains protected.
- [ ] Verify existing records, employee accounts, reports, and uploaded files are unchanged.
- [ ] Confirm Render's deployed commit and persistent disk settings before any deployment.
- [ ] Obtain owner approval before merging or deploying.

## Known limitation

The current repository has no pre-existing test suite. This branch adds a focused smoke test, but it does not replace a full browser-based regression test. A real desktop/mobile browser check and an authenticated staff-account check remain necessary before release.
