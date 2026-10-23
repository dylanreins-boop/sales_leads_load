# Lead Pipeline

A lead pipeline board for a sales or call team. It:

- **Pulls in leads** from **Facebook Lead Ads** (real-time webhook plus a "Sync Facebook" backstop) and from your **company website** form.
- Shows them on a **pipeline board**: New / Working → Voicemail → Follow Up 1 → Follow Up 2 → Follow Up 3 → Contacted → Booked → Waste.
- Lets reps **disposition** every call. The disposition moves the lead to the right stage and **sets a reminder to call the lead the next day**.
- Shows due reminders as a banner, a badge, a reminders panel and (optionally) desktop notifications.
- Sends **your own follow-up email** to the lead when a rep saves "No Answer – Left Voicemail" (off until you turn it on).
- Works as a **website and as a phone app**: people can add it to their home screen from the browser.

It needs no npm packages: just Node.js 22.13 or newer. Data is stored in SQLite (built into Node).

## Quick start

```bash
cp .env.example .env      # then edit it
npm start                 # http://localhost:3000
npm test                  # runs the test suite
```

## How dispositions work

| Disposition | Lead moves to | Call-tomorrow reminder |
|---|---|---|
| No Answer – Left Voicemail | next attempt stage* | yes |
| No Answer – No Voicemail | next attempt stage* | yes |
| Contacted – Needs Follow Up | Contacted | yes |
| Contacted – Call Back Requested | Contacted | yes |
| Appointment Booked | Booked | yes (confirmation call) |
| Updated Notes | stays where it is | yes |
| Not Interested / Wrong Number / Duplicate / Do Not Call | Waste | no (can be turned on) |

\* Attempt stages go New / Working → Voicemail → Follow Up 1 → 2 → 3, one step per no-answer.
A lead that is already Contacted or Booked stays where it is.

Every disposition needs a note. If the rep tries to save without one, the Notes box turns red and
nothing is saved until they write something.

The reminder defaults to **tomorrow at 9:00 AM** in the rep's own time zone. The rep can change the time or
untick "Remind me to call" before saving. Saving a new disposition closes the lead's older open reminders,
since the call has now happened. Leads can also be dragged between columns, or moved with the Stage
dropdown.

To change the stages or dispositions, edit `src/pipeline.js`.

## Lead info and vehicle details

Each lead has a **Lead info** section that anyone can edit: first and last name, phone, email, and
the vehicle's **year, make, model and color**, plus the **service they're interested in** (pick from
the list or type your own). The vehicle shows on the lead's card, for example "2023 Tesla Model Y ·
Pearl White", and the search box finds leads by vehicle too.

Every save is logged in the lead's activity with what changed, who changed it and when, for example
"Color: (blank) → Pearl White".

Vehicle details fill in automatically from Facebook and website forms. Field names are matched
loosely, so Facebook questions like "What is the year, make and model of your vehicle?" or "What
color is your car?" land in the right place. A combined year/make/model answer is kept together in
the Model field. To change the service list, edit the `serviceOptions` list in `public/index.html`.

## Follow-up email after a voicemail

Open **Email template** in the top bar, write the subject and message, tick **Send this email
automatically**, and save. From then on, saving "No Answer – Left Voicemail" on a lead that has an
email address sends that email. The rep can untick "Send follow-up email" on any single call.

- Personalize with `{{first_name}}`, `{{last_name}}`, `{{full_name}}`, `{{email}}` and `{{phone}}`.
  The editor shows a live preview.
- Every email (sent, failed, or not sent) shows in the lead's **Emails** section and activity log.
  A failed email never undoes the disposition.
- To actually deliver mail, sign up for [Resend](https://resend.com), [SendGrid](https://sendgrid.com)
  or [Postmark](https://postmarkapp.com), verify your sending domain, and set `EMAIL_PROVIDER`,
  `EMAIL_API_KEY` and `EMAIL_FROM` (plus optional `EMAIL_REPLY_TO`) in `.env`. Until then, emails are
  logged as "Not sent".
- There's one template for the whole team for now. Once logins are added, each rep can have their own.

To send the email for other dispositions too, add `email: true` to them in `src/pipeline.js`.

## Logins and who did what

Give each person their own login in `.env`:

```
APP_USERS=Dylan:their-password,Sam:another-password
```

The browser asks for a name and password when the app opens. From then on, every note, call outcome,
stage move, completed reminder and email in a lead's activity log shows **who did it and when**
(for example "Sam · Fri, Oct 23, 3:07 PM"). Leads that arrive from Facebook or the website have no
name, since nobody entered them.

This is a simple browser login. A proper login page, password resets, and an admin screen for adding
people come next. Those will use the same names, so the history recorded now carries over.

## Using it on a phone

The app is a Progressive Web App, so the same site works in a browser and as a home-screen app.
It must be served over HTTPS (any normal host gives you this).

- **iPhone:** open the site in Safari → Share → **Add to Home Screen**.
- **Android:** open the site in Chrome → menu → **Install app** (or **Add to Home screen**).

It opens full-screen with its own icon. Lead data always loads live from the server. If you later
want it in the App Store or Google Play, the same web app can be wrapped with a tool such as
Capacitor without a rewrite.

## Connecting Facebook Lead Ads

1. Create an app at <https://developers.facebook.com> (type **Business**) and add the **Webhooks** product.
2. Get a **long-lived Page access token** for the business Page, with the permissions `leads_retrieval`,
   `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata` and `pages_manage_ads`.
   Put it in `FB_PAGE_ACCESS_TOKEN`.
3. Set `FB_APP_SECRET` (App settings → Basic) and pick any random `FB_VERIFY_TOKEN`.
4. In **Webhooks**, choose **Page**, set the callback URL to `https://<your-host>/webhooks/facebook`,
   enter the same verify token, and subscribe to the **leadgen** field.
5. Subscribe the Page to the app:
   ```bash
   curl -X POST "https://graph.facebook.com/v23.0/<PAGE_ID>/subscribed_apps?subscribed_fields=leadgen&access_token=<PAGE_TOKEN>"
   ```
6. Test with Meta's [Lead Ads Testing Tool](https://developers.facebook.com/tools/lead-ads-testing).
7. Optional: put your lead form IDs in `FB_FORM_IDS` to enable the **Sync Facebook** button. It
   re-pulls recent leads in case a webhook delivery was missed. Duplicates are skipped.

Webhooks need a public HTTPS URL. When testing locally, use a tunnel such as `ngrok http 3000`.

## Connecting the website form

Send each form submission as a POST to `https://<your-host>/api/intake/website`, as JSON or regular form
fields. Recognised field names include `name`, `first_name`, `last_name`, `email`, `phone`, `message`,
`utm_campaign`, `form_name`, and the vehicle fields `vehicle_year`, `vehicle_make`, `vehicle_model`,
`vehicle_color` and `service_interest` (`year`, `make`, `model`, `color` and `service` work too).

- **Plain HTML form:** see `examples/website-form.html`. It includes a spam trap and redirects to your
  thank-you page.
- **WordPress (Gravity Forms, WPForms, Contact Form 7), Webflow, Wix, Squarespace, Zapier:** use the
  form's webhook / "send to URL" option and point it at the same URL.
- Add your site's address to `CORS_ORIGINS`.
- `WEBSITE_API_KEY` is optional. If you set it, send it as an `X-API-Key` header from your server or
  form tool. A key inside a public HTML form can be read by anyone, so treat it as a spam filter there,
  not a password.

If someone who is already in the pipeline submits again (same email or phone), the inquiry is added to
their existing lead's activity log instead of creating a duplicate card.

## Deploying

Any host that runs Node 22 works, such as Render, Railway, Fly.io or a small VPS. Things to check:

- Set `APP_USERS` so the dashboard needs a login (see below). The webhook and website intake URLs stay public.
- Keep `data/leads.db` on a persistent disk, and back it up.
- Set `TZ` (for example `America/Chicago`) so server-side reminder times match your office.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/leads?q=&source=` | List leads |
| POST | `/api/leads` | Add a lead manually |
| GET / PATCH | `/api/leads/:id` | Lead details, or edit fields / stage |
| POST | `/api/leads/:id/disposition` | `{ disposition, note?, reminder?, reminder_at? }` |
| POST | `/api/leads/:id/notes` | `{ note }` |
| GET | `/api/reminders` | Open reminders |
| POST | `/api/reminders/:id/complete` | Mark a reminder done |
| POST | `/api/reminders/:id/snooze` | `{ due_at }` |
| GET / PUT | `/api/settings/email` | Follow-up email template `{ enabled, subject, body }` |
| POST | `/api/facebook/sync` | Pull leads from `FB_FORM_IDS` |
| GET / POST | `/webhooks/facebook` | Facebook verification and lead events |
| POST | `/api/intake/website` | Website form submissions |

## Project layout

```
server.js            HTTP server, routes, auth
src/pipeline.js      stages, dispositions, follow-up rules
src/leads.js         lead, disposition and reminder logic
src/facebook.js      webhook signature check and Graph API client
src/website.js       website form field mapping
src/vehicle.js       vehicle fields and matching them in form answers
src/email.js         email templates and sending (Resend / SendGrid / Postmark)
src/db.js            SQLite schema
public/              dashboard (HTML/CSS/JS), app manifest, service worker, icons
examples/            website form snippet
test/                tests (npm test)
```
