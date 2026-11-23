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

The smoke test checks public homepage access both with and without an ERP session, `/index.html` alias behavior, public news response, unauthenticated protection for ERP database, account, administrator, search, news, backup, and file endpoints, protected write routes, administrator login, authenticated ERP access, and public sign-up page access.

## Official nomination source received

The owner supplied `효신 지명원_26.11.pdf` (47 pages). The public homepage now uses the source material for:
- Company profile: ㈜효신글로벌 외 6개 법인, CEO 윤지훈, initial affiliate incorporation date 2014-03-21, and business fields (PDF pp. 6-12).
- Affiliate history from 2014 through 2025 (PDF p. 7).
- Business areas: real-estate development, sales agency, advertising agency, facilities management, and rental management (PDF pp. 6, 9-11).
- Selected project references from the work portfolio (PDF pp. 16-38).
- Head office address, telephone, fax, and cover email from the cover/location page (PDF pp. 1, 47).

## Publication and privacy decisions

- The public-facing brand remains “주식회사 효신(曉晨)”. The owner has clarified that the representative legal entity name to display is “㈜효신씨앤에이”; the page now uses that name in the company introduction, seal, company overview, and contact section. The 2021 establishment of “㈜효신글로벌” remains only as a historical affiliate entry.
- The PDF has two different email addresses (cover/location page: `hyosin5600@naver.com`; submission page 2: `hyoshin2455@nate.com`). The homepage currently uses the cover and head-office-location email. Owner should confirm which mailbox is intended for public inquiries.
- Pages 13-14 contain subsidiary business registration certificates; pages 40-45 contain detailed real-estate holding/inventory information. These are not exposed on the public homepage by default. Publish only after explicit approval.
- The PDF itself is not directly linked for public download yet; owner approval is needed because it contains registration and asset details.

## Remaining owner confirmations

- Confirm whether the public inquiry email should be `hyosin5600@naver.com` or `hyoshin2455@nate.com`.
- Confirm approval of the selected project names and descriptions for public display.
- Confirm whether any company registration certificates or property-holding pages may be published (default: do not publish).
- Confirm approved logo/brand assets and any required legal/footer disclosures.

## Deployment configuration review (read-only)

- Compared `render.yaml` on `main` and `public-company-homepage`: the file is unchanged (same Git blob SHA).
- Repository configuration declares a Node web service named `hyotong-api`, starts with `npm start`, and uses `/api/health` as its health check.
- The declared persistent disk is `hyotong-data`, mounted at `/var/data` with `DATA_DIR=/var/data` (1 GB).
- The application derives database, authentication, employee, audit, upload, backup, work-report, news, and search-index paths from `DATA_DIR`; therefore retaining this mount and environment variable is essential to preserve existing data.
- The homepage PR does not modify `render.yaml`, package startup settings, or the declared persistent-disk configuration.
- This repository-file review does **not** prove the live Render service currently has the same settings, which Git branch it deploys, which commit is live, or whether the disk is attached and healthy. Those must be checked in the connected Render service before deployment.
- No Render setting, live service, domain, disk, environment variable, or production deployment has been changed.

## Manual review before production

- [ ] Open the public homepage on desktop and mobile.
- [ ] Verify all navigation anchors and the small ERP link at the far right of the header.
- [ ] Verify the public news cards show source, date, and safe original links when the cache contains articles.
- [ ] Review the company name distinction, public email address, and selected project list against the source PDF.
- [ ] Verify the empty/stale-news states are clear and do not imply current reporting.
- [ ] Log in as an administrator and confirm dashboard, admin page, logout, and staff management.
- [ ] Log in as an approved staff member and confirm the correct permissions and dashboard behavior.
- [ ] Confirm direct access to `/api/db`, file, backup, restore, and administrative endpoints remains protected.
- [ ] Verify existing records, employee accounts, reports, and uploaded files are unchanged.
- [ ] Confirm Render's deployed commit and persistent disk settings before any deployment.
- [ ] Obtain owner approval before merging or deploying.

## Known limitation

The current repository has no pre-existing test suite. This branch adds a focused smoke test, but it does not replace a full browser-based regression test. A real desktop/mobile browser check and an authenticated staff-account check remain necessary before release.
