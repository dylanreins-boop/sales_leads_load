# Lead Pipeline · Bob Moses Ceramic Coating

The lead pipeline for **Bob Moses Ceramic Coating, Las Vegas**: cars, trucks, coaches, boats and planes.
It:

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
npm install               # two packages, used only by the dialer's AI call notes
npm start                 # http://localhost:3000
npm test                  # runs the test suite
```

## Company branding

The company name, city, phone, address and website live in `.env` (`BRAND_NAME`, `BRAND_SHORT_NAME`,
`BRAND_CITY`, `BRAND_PHONE`, `BRAND_ADDRESS`, `BRAND_WEBSITE`). `.env.example` is filled in from the
Las Vegas page on bobmosescc.com: 3120 W Sirius Ave Ste 103, (702) 600-1128, open 6 AM–2:30 PM
Monday–Friday. They appear in the header, the browser tab, the phone app name, and
the default follow-up email. `TZ=America/Los_Angeles` keeps reminder times on Las Vegas time.

- **Colors:** glossy black header with a gold accent. All colors are tokens at the top of
  `public/styles.css`; change `--accent`, `--bar` and friends to match the company's brand colors.
- **Logo:** the app icon is a gold water bead (`public/icons/icon.svg`). To use the company logo,
  replace that file and the three PNGs next to it (`icon-192.png`, `icon-512.png`,
  `apple-touch-icon.png`) with square versions of the logo.

## Two pipelines: RVs and everything else

The board has two tabs:

- **RV Pipeline:** leads whose vehicle type is **Coach / RV** or **Trailer / Toy Hauler**.
- **All Other Vehicles:** cars, SUVs, trucks, semis, motorcycles, SXS / OHVs, boats, jet skis, planes,
  and any lead whose vehicle type isn't known yet.

Each tab shows how many leads it has and remembers which one you were on. A lead's pipeline follows its
vehicle type, so a website form that says "RV" lands in the RV Pipeline, and changing a lead's vehicle type
in Lead info moves it to the other board (the move is logged). "+ Add lead" on the RV tab starts the new
lead as a Coach / RV. Reminders cover both pipelines; RV leads are tagged "RV". You can link straight to a
tab with `#rv` or `#other` at the end of the address. To change which types count as RVs, edit
`PIPELINES` in `src/vehicle.js`. The API also takes `GET /api/leads?pipeline=rv` (or `other`).

## Shop calendar

**Calendar** (next to **Leads** in the header) shows every booked job.

On **Month** and **Week**, anything that runs over several days (a two-day RV job, a week of vacation) is
one connected bar across those days, so it reads at a glance. Approved time off is on top, then jobs.

- **Booking puts the job on the calendar.** "Appointment Booked" also asks for the **work time** (about 4
  hours for cars, 1 to 5 days for RVs and trailers), **drop-off** (8 AM the next work day) and **pick-up**
  (filled in for when the work is done). Booking the same lead again moves its job instead of adding a
  second one.
- **Shop hours and overbooking.** The shop works 8 hours a day, Monday to Friday (admins change this under
  **Shop hours**). Each day shows its booked hours (e.g. 6/8 hrs) and turns red when it's over; booking or
  moving a job warns when a day would go over, when drop-off or pick-up is on a closed day, or when pick-up
  is before the work can be done.
- **Day sheet** (a view next to Month/Week/List): one day's drop-offs, pick-ups and jobs already in the shop,
  with phone numbers, vehicles, services, work time, notes and checklist progress. **Print** gives a clean
  one-page sheet; admins can have it **emailed every work-day morning** (Morning email).
- **Views:** Month, Week and List (List is the default on phones). Jobs are colored by status:
  Scheduled, In the shop, Ready for pickup, Picked up, Cancelled / Rescheduled. Multi-day jobs show on each day
  ("day 2 of 3"), with drop-off and pick-up times on the first and last day. RV jobs are tagged "RV".
  Each card shows the customer, vehicle, services, checklist progress and photo count.
- **Booked leads not on the calendar yet** (e.g. booked before the calendar existed) are listed at the
  top of the calendar with a button to add them. The lead's panel also shows its job ("Open on
  calendar") or a "Put on calendar" button.
- **Job panel** (click any job): change the status, move drop-off/pick-up, call or email the customer,
  see the services, keep job notes (keys, gate codes), work the **vehicle checklist**, and add **photos**.
- **Customer sign-off at drop-off.** In the job panel, the shop writes the condition notes (chips, scratches,
  curb rash), the customer types their name, signs with a finger and ticks that they agree. The signature,
  notes, wording and before-photo count are saved on the job and logged on the lead.

### Vehicle checklist

Each job starts with a checklist built from the vehicle type and the services booked: check-in items
(walk-around for chips and dents, before photos, glass, wheels, mileage/hours), the work (decon wash,
clay, paint depth readings and correction if booked, wheels/glass/trim/interior/pop-outs/roof/hull if
booked, panel wipe, coating, cure time) and finish items (final inspection, after photos, customer
walk-through). Coaches and toy haulers also get roof and slide-out checks; boats get hull and gelcoat;
planes get tail number and leading edges. Ticking an item records **who** ticked it and **when**. The
shop can add its own items to any section or remove ones that don't apply. To change the starting list,
edit `BASE_CHECKLIST`, `TYPE_CHECKLIST` and `SERVICE_CHECKLIST` in `src/jobs.js`.

### Job photos

Pick **Before**, **During** or **After**, then **Add photos**. On a phone this offers the camera or the
photo library, and several can be added at once. Photos are shrunk to 1600 px JPEGs in the browser before
uploading, so they're quick on a phone connection (about 200–400 KB each). Tap a photo to see it full
size with who added it and when, flip through with the arrows, or delete it (tap twice). Photos are stored
in `PHOTOS_DIR` (by default a `photos` folder next to the database, so on Fly they're on the same volume).

Shop logins only see the calendar; sales logins see it view only. See [Login levels](#login-levels).

## Job amounts and Revenue

Sales and admins put a **dollar amount** on each job: in the **Job amount** box when logging "Appointment
Booked" (optional), or later from the lead's Shop job box (sales and admins) or the job on the calendar
(admins). Every set or change is logged on the lead with who did it ("Job amount: $1,400.00 (was
$1,250.50)"). **Shop logins never see amounts**; the server removes them from everything it sends a
shop login.

Admins get a **Revenue** page (next to Leads and Calendar):

- **Today, This week, This month, Year to date** totals, each with the job count and average job, how much
  is still scheduled, and a warning when jobs in that period have no amount yet.
- **Count by job date** (drop-off day) or **by booking date** (the day the rep booked it), and filter to
  the RV pipeline or all other vehicles.
- A **breakdown table** by day (this month), week (Sunday to Saturday) or month (this year), with totals.
- **By sales rep, year to date**: jobs and revenue for whoever booked each job.
- A list of jobs with **no amount yet**, with a box to add each one.

Jobs marked Cancelled / Rescheduled don't count. The Excel export includes a Job amount column.

**Where leads come from** (bottom of the Revenue page): for this month, the last 90 days or the year to
date, the leads that came in by lead source (Facebook, website, phone / walk-in) and by "How they heard
about us", with how many booked, the booking rate, the revenue their jobs brought in, and revenue per lead.

## Deposits and commissions

**Deposits.** Every booked job shows the deposit due (10% of the job amount). Tick **Deposit taken now**
when booking (the amount fills in at 10%; change it if they paid a different amount, and pick how they
paid), or use **Mark taken** on the lead's Shop job box later. Who took it and when is logged.

**Commissions.** The rep who booked a job earns 10% of the job amount. A commission is only earned once
the vehicle is **booked and in the shop**: it's **Pending** until the shop marks the job In the shop (or
Ready / Picked up), then **Owed** until an admin marks it **Paid**. Cancelled jobs earn nothing.

**Reminders to pay.** Admins' **Reminders** (and the badge and banner) list each rep who is owed, how much,
how many jobs, and since when, with a **Pay** button that opens that rep's owed commissions. When a job's
commission becomes owed, it's logged on the lead and shows in Updates.

The **Commissions** page (sales and admins):

- **Sales reps** see only their own: owed to them, pending, paid this year, their deposits not taken
  yet, and each job's status.
- **Admins** see every rep. **By rep** shows owed, pending and paid this year, with a **Pay** button per
  rep. Tick individual jobs and **Mark paid** (with an optional note like a check number). **Undo paid**
  reverses a payment. **Edit** gives a commission to another rep or sets a different amount. **Rates**
  changes the commission % and deposit %, and when commission is owed (vehicle in the shop, which is
  the default; job picked up; deposit taken; or booked).

Every deposit, commission change and payment is logged on the lead and shows in Updates. Shop logins
never see job amounts, deposits or commissions.

## Quotes

Every lead has a **Quote** box (sales and admins). Pick a vehicle package or an RV / trailer rate (enter the
length in feet), tick add-ons, add custom lines (for example wheels & windows until it has a set price),
and an optional discount and note. The total updates as you go and always comes from the saved price list.

- **Save quote** keeps it on the lead and logs it ("Quote $6,300.00: RV / trailer, windows & slides
  included (42 ft × $150.00/ft) $6,300.00").
- **Email to customer** sends it as a plain email from the shop (needs the email service set up).
- **Use for booking** fills the "Appointment Booked" form with the quote total as the job amount.

**Price list (admins):** the **Price list** button edits what the quote builder charges. It starts with
vehicle packages at $800, $1,300, $1,400 and $1,700, RV / trailer coating at $130 per linear foot (no wheels or
windows) and $150 per foot (windows and slide-outs included), and Wheels & windows with no price yet (it can't be ticked until it has one). Rename packages,
change prices, or add packages, rates and add-ons. Shop logins never see prices.

## Review requests

Under **Emails**, admins can turn on a **review request**: a few days after a job is marked Picked up
(2 by default), the customer is emailed a link to leave a review. Set your Google review link, the
wait, and the wording ({{review_link}} drops the link in). Each customer gets it once (at most once every
six months), only jobs picked up in the last 30 days are emailed so turning it on never emails old
customers, and every send shows on the lead. It uses the same email service as the follow-up email.

## Past Customers

Booked leads stay in the Booked column while their job is coming up or in the shop. **14 days after the
job is marked Picked up** (with nothing else on the calendar for them), the customer moves to the **Past
Customers** tab, so the Booked column only holds work that's still happening. A job marked Cancelled /
Rescheduled keeps the lead on the board until it's rescheduled.

Past Customers lists each customer's vehicle, last pick-up, number of finished jobs, services and total
spent, filtered by vehicle type and exportable to Excel. Customers go back on the board when they inquire
again (as a new lead), when someone logs a call on them, or with **Book again**. Adding an "Updated Notes"
entry keeps them in Past Customers. Their revenue keeps counting on the Revenue page.

**Due for maintenance:** coatings need a yearly maintenance visit, so customers are flagged **Maintenance
due** 11 months after their last pick-up (change with `RECOAT_MONTHS`). Pick "Due for maintenance" under
Show to get the call list, then log a call or use Book again.

## Old & Dead Leads

**14 days after a lead comes in**, it leaves its board and moves to the **Old & Dead Leads** tab, unless
it's **Booked**. Its open reminders are closed so nobody gets chased about it. "Dead" leads are the ones
that were marked Waste; "Old" leads aged out without a booking. Change the number of days with
`LEAD_ARCHIVE_DAYS`.

The tab separates leads **by vehicle type and lead type** (Facebook, Website, Manual): a count grid with
vehicle types down the side and lead types across the top (click any number to see those leads), filters
for vehicle type, lead type and old vs. dead, and one table per vehicle type.

A lead goes back on its board (with another 14 days) when:

- someone clicks **Restore** (in the table, or in the lead's panel),
- a rep logs a call on it, or
- the person submits the website form or a Facebook ad again (it comes back as New).

## Export to Excel

**Export to Excel** (right end of the tabs) downloads a real `.xlsx` file of what the current tab shows,
including the search box and any filters. The workbook has:

- **Summary:** lead counts by vehicle type and lead type.
- **All leads** on one sheet, with every field: status, pipeline, vehicle type, lead type, name, phone,
  email, OK to text, how they heard about us, year/make/model/color, stage, last call outcome, services
  booked, campaign, message, dates, and the full **notes & history** (who did what, and when).
- **One sheet per vehicle type**, with the same columns.

The sheets also include each lead's latest shop job: drop-off, pick-up, status, checklist progress,
photo count and job notes.

Headers are frozen and filterable. `GET /api/export.xlsx` takes the same filters as `/api/leads`
(`view=active|old|all`, `pipeline`, `vehicle_type`, `source`, `status=old|dead`, `q`).

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

**Appointment Booked** also asks which services were booked: Full decon & coat, Paint correction,
Wheels & windows, Wheels & calipers only, Windows / glass only, Trim & plastics, Interior protection,
Pop-outs / slide-outs and Roof (coaches, RVs, trailers and toy haulers only), Hull & gelcoat (boats and jet skis only), and
Other. At least one must be ticked; the box turns red otherwise. The booked services show on the
lead's card and in its Lead info, where they can be changed later (the change is logged). To change
the list, edit `BOOKING_SERVICES` in `src/services.js`.

Every disposition needs a note. If the rep tries to save without one, the Notes box turns red and
nothing is saved until they write something.

The shop is closed weekends, so a call-back that would land on Saturday or Sunday moves to **Monday**
(set `REMINDER_SKIP_WEEKENDS=false` to allow weekends).

The reminder defaults to **tomorrow at 9:00 AM** in the rep's own time zone. The rep can change the time or
untick "Remind me to call" before saving. Saving a new disposition closes the lead's older open reminders,
since the call has now happened. Leads can also be dragged between columns, or moved with the Stage
dropdown.

To change the stages or dispositions, edit `src/pipeline.js`.

## Welcome text: the best time to reach them

Every new lead from Facebook, the website, Google, a referral link or a text gets an automatic text right
away: "Hi Ana, thanks for your interest in Bob Moses Ceramic Coating! What time of day is best to reach
you: morning, afternoon or evening? Just reply here." Leads that come in between 8 PM and 8 AM get it at
8 AM. When they answer, the app reads it ("afternoons", "after 3", "evenings or weekends", "Thursday",
"anytime") and puts it on the **front of the lead card** as **Best time**, with their words, and texts a
short thanks ("Thanks Ana! We will reach out in the afternoon."). Until they answer, the card says it's
waiting. Reps can also type a best time in the lead's info (when the customer tells them on the phone).

Imported leads and missed callers (who already got the missed-call text) don't get it; for leads added
by hand there's a box on the Add lead form. It's skipped when a rep already reached the lead. Admins edit
both texts or turn them off under **Texts & reminders → Welcome text for new leads**. Analytics shows how
many answered and which times they picked.

## Pipelines (admins set them up)

The tabs on the Leads page are pipelines. Admins open **Pipelines** to:

- **Add one** (for example **Boats**) and pick the vehicle types that go on it (Boat, Jet Ski). Leads
  go on the pipeline that has their vehicle type, so every boat lead moves there as soon as you save,
  and new boat leads land there from then on. A type goes on one pipeline; clicking a type that's on
  another pipeline moves it.
- **Choose who sees it:** everyone, or only the people you pick (sales reps, other admins). Admins
  always see every pipeline. This keeps each person's menu to the boards they work.
- **Rename, reorder or remove** pipelines. Removing one sends its leads to **All Other Vehicles**,
  which is always last and takes every type no other pipeline has (and leads with no type yet). The RV
  pipeline can be renamed and its types changed, but not removed (RV quotes and work times use it).

The pipeline menus on Revenue, Analytics and the Excel export list the pipelines too.

## Search

The search box at the top looks through **every** lead: working leads on every pipeline, past customers, and old
and dead leads, by name, phone, email or vehicle. Matches drop down as you type (two letters or any digits),
best first (names that start with what you typed), each with the basics: name, where it is (e.g. "Follow Up 2 ·
RV Pipeline", "Past customer", "Old lead", "Dead lead"), phone and email, vehicle and color, and when it came in
or was last contacted. Click one (or use the arrow keys and Enter) to open it full screen. The board itself isn't
filtered by the search box.

## Full screen

Click a lead to open it at the side; **double-click** it (or Shift+Enter) to open it full screen, with its sections in
columns side by side. **⤢ Full screen** in the lead's header switches either way, and Esc goes back to
the side panel (Esc again closes it).

## Opened and contacted, on every card

Each lead card shows the exact time the lead was **last opened** and by whom, and when it was **last
contacted** (a call logged or a text a rep sent), how and by whom: "Opened Today 3:14 PM · Sam",
"Contacted Yesterday 4:02 PM · call by Sam". Leads nobody has opened or contacted yet say "not yet" in
orange. Notes and automatic texts (confirmations, follow-ups) don't count as contact.

## Lead info and vehicle details

Each lead has a **Lead info** section that anyone can edit: first and last name, phone, email, and
the **vehicle type** (Car, SUV, Truck, Van, Motorcycle, SXS / OHV, Semi, Coach / RV, Trailer / Toy Hauler, Boat,
Jet Ski, Plane, Other), **how they heard about us**, whether they **agreed to texts**, and
the vehicle's **year, make, model and color**. The vehicle shows on the lead's card, for example
"Boat · 2021 Sea Ray SLX 400 · White", and the search box finds leads by vehicle too.

Every save is logged in the lead's activity with what changed, who changed it and when, for example
"Color: (blank) → Pearl White".

Vehicle details fill in automatically from Facebook and website forms. Field names are matched
loosely, so Facebook questions like "What is the year, make and model of your vehicle?" or "What
color is your car?" land in the right place, and answers like "motorhome" or "pontoon" become
"Coach / RV" or "Boat". A combined year/make/model answer is kept together in the Model field. To
change the vehicle types, edit `VEHICLE_TYPES` in `src/vehicle.js`.

### From their quote form

The quote form on bobmosescc.com asks "How did you hear about us?" (Searched on the internet, Saw an ad
on social media, Word of mouth referral, Radio, Other), has a text-message opt-in checkbox, a
"Services" choice of Auto / RV / Boat, and "Tell us about your vehicle". All of these are picked up when
the form is connected: the answer lands in **How they heard about us**, **OK to text**, **Vehicle
type** and the lead's message. Facebook leads are marked "Saw an ad on social media". Only text leads
marked **OK to text**.

### 24-hour call-back promise

Their site tells customers "if we don't pick up right away, leave a message and we'll call you back
within 24 hours". New leads that haven't been called show a countdown on their card ("Call back ·
18h left"), turning amber under 4 hours and red ("24h call-back missed") after that.

## Follow-up email after a voicemail

Open **Emails** in the top bar (admins), write the subject and message, tick **Send this email
automatically**, and save. From then on, saving "No Answer – Left Voicemail" on a lead that has an
email address sends that email. The rep can untick "Send follow-up email" on any single call.

- Personalize with `{{first_name}}`, `{{last_name}}`, `{{full_name}}`, `{{vehicle}}`, `{{email}}` and
  `{{phone}}`. `{{vehicle}}` becomes e.g. "2021 Sea Ray SLX 400", or "boat" if only the type is known.
  The editor shows a live preview.
- The starting email is written for Bob Moses Ceramic Coating and uses `BRAND_PHONE` if it's set.
  Replace `[your name]` (and the number, if `BRAND_PHONE` is empty) before turning it on.
- Every email (sent, failed, or not sent) shows in the lead's **Emails** section and activity log.
  A failed email never undoes the disposition.
- To actually deliver mail, sign up for [Resend](https://resend.com), [SendGrid](https://sendgrid.com)
  or [Postmark](https://postmarkapp.com), verify your sending domain, and set `EMAIL_PROVIDER`,
  `EMAIL_API_KEY` and `EMAIL_FROM` (plus optional `EMAIL_REPLY_TO`) in `.env`. Until then, emails are
  logged as "Not sent".
- There's one template for the whole team for now. Once logins are added, each rep can have their own.

To send the email for other dispositions too, add `email: true` to them in `src/pipeline.js`.

## Logins and who did what

Everyone gets their own login. Set up the first admin on the server, then admins add everyone else from
the **Team** panel in the app:

```
APP_USERS=Dylan:their-password:admin
```

### Team panel (admins)

Admins open **Team** to:

- **Add a person:** type their name, a password (8+ characters) and a level (Admin, Sales or Shop). Admins
  can add other admins.
- **Change a level**, **reset a password**, or **deactivate** someone who left. A deactivated person can't
  sign in, but everything they did stays in the history under their name. Reactivate them any time.
- See **who added each person and when**, when each person was last in the app, and a **Team changes**
  log of every add, level change, password reset and deactivation, with the admin who did it.

Names can't be changed after a login is created, so the activity history always points to the right
person. Two people can't share a name (add a last initial). Admins can't change their own level or
deactivate themselves, and there is always at least one admin. Passwords are stored hashed (scrypt), never
as plain text.

Logins set in `APP_USERS` show on the Team panel as server logins and are changed on the server. With no
`APP_USERS` and no Team logins at all, the app is open; the first login added there has to be an admin,
and from then on everyone signs in.

The browser asks for a name and password when the app opens. From then on, every note, call outcome,
stage move, completed reminder and email in a lead's activity log shows **who did it and when**
(for example "Sam · Fri, Oct 23, 3:07 PM"). Leads that arrive from Facebook or the website have no
name, since nobody entered them.

### Login levels

The word after the password sets what that person can do:

| Level | Sees | Can |
|---|---|---|
| `admin` | Everything: both pipelines, Old & Dead Leads, the shop calendar | Everything sales and shop can, plus the **Updates** feed, Excel export, the follow-up email template and Facebook sync |
| `sales` | The lead pipelines, their call reminders, and the shop calendar (view only) | Work leads, log calls, edit lead info, and **book** jobs (the booking time goes on the shop calendar). On the calendar they can open any job to see times, status, notes, the checklist and photos, but can't change anything. No export or settings |
| `shop` | The job calendar only | Open jobs, change status, times and notes, tick the checklist, add photos, clock in and out, ask for time off |

A login with no level is `sales`. The single shared `APP_USER`/`APP_PASSWORD` login is `admin`, and with no
logins set at all, everyone is treated as `admin`.

**Updates (admins).** The **Updates** button shows a count of changes made by others since you last looked.
It opens a feed of every change, newest first: calls logged, notes, lead info edits, bookings, and shop work
(status changes, job notes, checklist ticks, photos added or deleted), each with who did it and when. Filter
it to Sales or Shop, and tap a change to open that lead or job.

**Signing in:** the app opens on a Bob Moses sign-in page. People stay signed in on that device for 30
days or until they tap **Sign out**. Resetting someone's password or deactivating them signs them out
everywhere. After 8 wrong passwords for a name, sign-in pauses for 15 minutes. "Forgot your password?"
tells them to ask an admin, who resets it on the Team panel. Scripts can still use HTTP Basic auth.

## Texting customers

With Twilio connected (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`; about $1 a month for the
number plus about a cent a text), each lead has a **Texts** section: the whole conversation, a **saved
texts** picker (filled in with the customer's name, vehicle, quote and the rep's name, and still editable)
and **Send text**. Point the Twilio number's "A message comes in" webhook at `/webhooks/twilio` and replies
show up on the lead (and alert the rep working it). A customer who replies STOP isn't texted again; a
number the app doesn't know becomes a new lead. Admins edit the saved texts under **Texts & reminders**.

## Booking confirmations and day-before reminders

When a job is booked (from a call, the calendar or an online booking), the customer gets a **confirmation**
by text and email with the drop-off and pick-up times, and a **reminder the day before** drop-off (at 10 AM
by default; a moved job gets a fresh one). The rep can untick "Send the customer a booking confirmation"
for a single booking. Admins edit the wording and turn either message on or off under **Texts & reminders**.
Email works with the email settings above; texts need Twilio.

## New-lead alerts (speed to lead)

A new Facebook, website, Google, referral, missed-call or text lead sends a **phone alert** to the sales team right away; tapping it opens
the lead. If nobody has called, texted or logged anything on it within **15 minutes**, the admins get an
alert too. Alerts go out 7 AM to 8 PM (`ALERT_HOURS`); overnight leads are alerted in the morning.

Each person turns alerts on in **Reminders → My phone alerts** (on iPhone, add the app to the Home Screen
first and turn them on from there). Alerts use the browser's built-in push service: free, no outside
account. Anyone can also enter a mobile number to get alerts by text (with Twilio connected).

## Online booking links

From a lead (usually right after a quote), **Send a booking link** by text or email, or copy it. The
customer's page shows the price, the 10% deposit, and only the days that still have room in the shop
under the hours-per-day rule. Picking a day books the job on the calendar for that rep (their booking and
their commission) and sends the confirmation. With `STRIPE_SECRET_KEY` set, the customer then pays the
deposit on Stripe's payment page and it's recorded on the job; without it, they pay at drop-off. **Preview**
shows the rep what the customer sees. Links work for 30 days and can be turned off.

## Work timer

Every job on the calendar has a **Work timer** for the shop. Tap **Start work** when you begin on the
vehicle (it moves the job to In the shop), **Pause** when you step away, and **Finished** when the work is
done. Each person's time is kept separately, and starting another job pauses your clock on the last one.
The calendar shows a green dot on vehicles being worked on right now. A clock left running overnight stops
at closing time and is flagged. Admins can fix or remove a time, or add time someone forgot to clock, from
the job's **Time log**. Sales logins see the time but can't run the clock.

The **Work time** section of Analytics shows hours worked by person, real time against booked time (by
vehicle type and by service), jobs that ran long, revenue per work hour, how long vehicles wait for work
to start, and how long finished vehicles wait for pick-up.

### Work time that learns

Jobs finished on the work timer teach the app how long work really takes. When a lead is booked (from
the lead, the calendar's Schedule button or an online booking link), the work time starts from:

- the **average real time for that vehicle type**,
- adjusted for the **paint color** (for example, if black cars keep running 15% longer, black bookings get
  15% more time), and
- adjusted for **extra services** such as paint correction.

Newer jobs count more than old ones (a job from six months ago counts half), so the times keep adapting
as the shop speeds up or the work changes. Each number leans on the standard time (4 hours for cars,
2 days for RVs) until a few jobs back it up, so one odd job can't swing it. The booking form shows the
suggestion and why ("SUVs here average 5.8 hours · Black paint runs 12% longer"), and the rep can still
pick a different time; once they do, the suggestion becomes a "Use" button. Paint color comes from the
lead's Color field, grouped into black, white, silver/gray and so on. Analytics → Work time shows the
results by paint color and **What booking suggestions use now**.

## Time clock, time off and pay

Everyone with a login (sales, shop, and admins if they like) clocks in and out with the **Clock in** button
at the top of the app. While they're on, it shows a green dot and their hours today (orange while on lunch).
Tapping it opens **My time**, full screen on every device:

- A live clock, where they stand (off, on the clock, on lunch), and hours worked today.
- Big buttons for what comes next: **Clock in**; **Start lunch** or **Clock out**; **End lunch** or **Clock
  out for the day**. Each one asks to confirm ("Clock in now? 8:02:14 AM"), then shows a confirmation ("You're
  clocked in. Have a good shift!"). Closing the confirmation takes them to the shop calendar.
- **Lunch** is off the clock and unpaid. Clocking out from lunch ends the day when lunch started.
- **Today**: when they clocked in, went to lunch and came back, and clocked out. **This week**: hours each day.
- **Timecard**: every punch for this or last week (or two), with the hours per day. **Fix** asks an admin to
  change a punch's times or remove it; **Add time you forgot to clock** asks for a punch that's missing. They
  say what happened, see the answer (and the admin's note) under **My correction requests**, and can cancel a
  request while it waits.
- **Ask for time off** (first and last day, kind: vacation, sick, personal or unpaid, hours a day, a note), and
  their requests with the answer.

- Someone who forgets to clock out is clocked out at the end of the shop day (or a normal day's hours after
  they clocked in, if that was later), never past midnight, and the time is flagged **to check**.
- Time off waits for an admin. Approved time off shows on the shop calendar ("Mike off") so nobody books
  around a missing tech by surprise. Only days the shop is open count toward the hours. Admins click the
  bar to see the request: their note, when they asked, who approved it, and a button to cancel it.

**Clock in at the shop (geo-lock).** In Time & Pay → **Payroll rules**, an admin stands at the shop, taps **Use my
current location** (or types the latitude and longitude), picks how close counts (about 500 ft by default) and who
it applies to (Shop logins by default; Sales too if you like). From then on, **Clock in** and **End lunch** ask the
phone where it is and the server refuses anyone farther away ("You're about 3.4 miles from the shop") or with
location turned off, with **Try again**. Going to lunch and clocking out work anywhere. GPS is fuzzy indoors, so up
to 100 m of the phone's stated accuracy counts in their favor. Each clock-in keeps how far from the shop it was
(📍 on the day in Time & Pay; Edit shows the distance). Admins can still add or fix time by hand. Phones only share
location with sites on HTTPS, which the deploy guides set up.

**Paid weekly (Sunday to Saturday).** On Friday (or their last scheduled day that week, if they're off
Friday), **Clock out** first shows the week's time, day by day with the total. They tick **My hours are right**
and **Approve my week & clock out**, or tap **Something's wrong** to ask for a fix first. They can also approve
early from their Timecard. Once everyone who worked or was scheduled has approved, the admins listed in
**Payroll rules** get an email: each person's rate, regular, overtime and paid-off hours, total, gross pay and
when they approved, plus a CSV of every punch, ready to forward to payroll. If someone never approves, it goes
the next morning at 8 anyway and says who it's waiting on. (Email needs EMAIL_ settings on the server.)

**Time & Pay (admins)** is its own page in the main menu, with a badge for time off waiting on approval:

- It opens on the **pay week** (‹ › to go back and forth), or pick this or last month, or any dates.
- **Pay week** card: who has approved their time (✓ with when, ○ waiting, ⚠ if their hours changed after they
  approved), **Approve week for payroll**, **Email summary now**, and whether the email has gone out.
- **Attendance**: set each person's **Work schedule** (the days they work and their start and end times) and
  Time & Pay flags what went wrong in the period: **late arrivals**, **left early**, **long lunches**, **no-shows**
  (scheduled, didn't clock in, no approved time off) and **forgot to clock out**. You see totals for each, a list
  of every one (newest first, tap a name to open their days), and an issue count per person. Late or early counts
  after a grace period (5 minutes by default) and lunch is 30 minutes by default; both are set with the schedules.
- Open a person to see one row per day: scheduled hours, in, lunch, out, hours and any attendance flags.
  **Edit** opens that day's punches to fix the times or delete one.
- **Approve** or **Deny** timecard corrections and time off (a denial can carry a note the person sees). An
  approved correction changes the timecard right away, noted with the reason they gave.
- Totals: hours, regular, overtime, paid time off, and gross pay for everyone.
- One row per person: the **hourly rate** (type it in and press Enter), regular, overtime and paid-off hours,
  total, and gross pay. Open a row to see every punch, **Edit** or **Delete** one, or **Add time** someone
  forgot to clock.
- **Overtime & time off rules**: overtime after 40 hours a week (Sunday to Saturday) at 1.5× by default; an
  optional daily overtime limit (Nevada has daily overtime for some hourly workers: check with your
  accountant); which kinds of time off are paid (vacation and sick by default, at the regular rate).
- **Download CSV**: the totals per person plus every punch, for whoever runs payroll.

Gross pay is before taxes and deductions. Shop logins never see rates or pay.

## The dialer (the build with CALLS_ENABLED)

The app comes in two builds from the same code: **without the dialer** (the default) and **with the
dialer**, turned on with `CALLS_ENABLED=1`. With it off, none of the dialer exists: no buttons, no
screens, no routes.

**Calling.** On a lead, **Call** rings the rep's own phone (set under Reminders → My phone for the
dialer); when they pick up, Twilio calls the customer from the shop's number. The customer first hears
"Hi, this call may be transcribed for quality. Connecting you now." (`CALL_NOTICE`), then they're
connected. Calls only go out during calling hours (`CALL_HOURS`, default 8 AM to 9 PM) and never to
leads marked do-not-call or wrong number.

**No recordings.** What each side says is written out live (Twilio real-time transcription). No
audio is recorded or kept, by Twilio or the app. The lead shows the conversation as it happens.

**Call notes.** When the call ends, the notes are written for the lead: a short summary, what the
customer wants, the price given, their concerns, the next step, the outcome, and flags for anything
missed (no price given, no next step, booking link not offered, customer upset, asked not to call…),
plus a coaching tip. With `ANTHROPIC_API_KEY` set, Claude writes the notes; without it (or if Claude
can't be reached), the app writes basic notes from the words used. **Use as the call outcome** fills
in the disposition and notes for the rep to check and save.

**Start calling** works through the call list: call-backs that are due first, then new leads nobody
has reached (leads whose best time is now go first). After the rep saves the outcome, the next call
starts in 5 seconds; they can pause, skip or stop.

**Reviewing calls.** Admins get **Calls**: every call with its notes, filterable by rep, flagged, or
not reviewed yet. Open one to read the notes and what was said, give it a score (1–5) and a coaching
note; the rep sees the note on the lead. Analytics adds a Calls section: calls, reached, talk time,
bookings, flags and average score per rep.

**Setting it up.** Twilio (the same account as texting), `PUBLIC_URL` (Twilio has to reach the app),
`CALLS_ENABLED=1`, and an `ANTHROPIC_API_KEY` for AI notes. Each rep adds their phone for the dialer.
Before turning it on, have your attorney confirm the transcription notice covers Nevada and the
states your customers call from; it plays on every call.

## Analytics

Admins get an **Analytics** tab with every number the app keeps, for one date range (last 7 or 30 days,
this or last month, 90 days, year to date, 12 months or any dates) and either board. Each headline number
shows the change from the period just before.

- **Headline:** new leads, booked, booking rate, revenue, money collected, average job, how fast new leads
  get a first call or text, and cost per booking.
- **Over time:** leads and bookings, and revenue and money collected, by day, week or month.
- **The new leads:** how far they got (reached, quoted, booked, picked up), how fast they were worked,
  why the rest didn't book, and which days and hours leads come in.
- **Where they came from:** lead sources with ad spend, cost per lead and return; how they heard about us;
  vehicle types.
- **The team:** per person, leads worked, calls logged, texts, emails, quotes, bookings, close rate,
  revenue, commission and how fast they respond.
- **Follow-up and marketing:** quotes and follow-ups, online booking links and card deposits, texts and
  reply rate, missed calls, emails, win-back campaigns, referrals and partners.
- **The shop and the money:** drop-offs, pick-ups, days in the shop, how full the shop's hours were,
  sign-offs, photos, reminders and review requests; deposits, payments, refunds, still owed and commissions.

Every chart has **Show as a table**, and **Download CSV** saves all of it for Excel.

## Payments, balance due and invoices

Every job shows its **balance**: the price minus the deposit and any payments. **Record payment** adds a
payment (blank amount = the whole balance) or a refund, by cash, card, Zelle and so on; admins can remove
one entered by mistake. **Invoice PDF** (or **Receipt PDF** once it's paid in full) gives a branded PDF with
the quote's line items, and **Email invoice** sends it to the customer. Revenue has a **Still owed** list of
finished jobs with money still due. Shop logins never see any amounts.

### Card payments from Talech / Elavon

The shop's card payments run through Talech (Elavon). Talech doesn't offer an open connection for
outside apps, so the app reads Talech's export instead: in the Talech back office (or Elavon's
Converge / Merchant Connect) export the transactions or sales report for the days you want as Excel or
CSV, then on **Revenue → Import card payments** choose the file. The app:

- finds the columns (transaction ID, date, amount, type, status, tender, cardholder, card number, tip;
  title lines above the columns are fine, and any column can be re-pointed if it guessed wrong);
- leaves out declines, voids and cash, and treats refunds and negative amounts as refunds;
- matches each card payment to its job by amount (the balance due, the job price or the deposit), the
  cardholder's name ("DIAZ/BO" is Bo Diaz) and the date (around drop-off or pick-up), and marks each
  one **Matched**, **Check this** or **No match**;
- records the ones you keep as card payments on the job, dated when the card was run, with the last 4
  digits and the processor's transaction number. A transaction is never recorded twice, so overlapping
  exports are fine.

Balances, Still owed, receipts and Analytics update right away. A live connection (payments flowing in on
their own, or a "pay your balance" link) needs Elavon's approval: either Talech partner access through
Elavon's WorksWith program, or API keys for Elavon's online gateway (Converge or the Elavon Payment
Gateway). Ask the Elavon rep which one the account has.

## Ready for pickup

When a job is moved to **Ready**, the customer gets a text and email saying their vehicle is ready, with the
balance due. It goes once per job, and admins edit the wording or turn it off under **Texts & reminders**.

## Missed calls

Point the Twilio number's voice webhook ("A call comes in") at `/webhooks/twilio/voice`. Calls ring through
to `FORWARD_CALLS_TO` (the shop's real phone) for 20 seconds, showing the customer's number. If nobody picks
up, the caller gets a text right away ("Sorry we missed your call...", editable under **Texts & reminders**,
at most once every 12 hours) and an unknown number becomes a new lead tagged **Missed call**, which sets off
the new-lead alerts. Their reply lands on the lead like any other text.

## Quote follow-ups

A quote that hasn't booked gets a friendly text from the rep **3 days** and **7 days** later, with a booking
link (email if there's no number to text). They stop as soon as the customer replies, books, or the lead is
marked lost. Follow-ups only go out Monday to Saturday, 9 AM to 7 PM. Admins change the days and the wording
under **Texts & reminders → Quote follow-ups**. Booking links need `PUBLIC_URL`.

## Win-back campaigns

Admins: **Win-back** sends one text (or email) to a group of Old & Dead leads: pick old, dead or both, RVs
or everything else, and how far back. **Check** shows how many it reaches and a sample of the message.
People marked do-not-call, wrong number or duplicate, anyone who replied STOP, and anyone contacted in the
last 30 days are left out. Messages go out up to 10 a minute, Monday to Saturday, 9 AM to 7 PM; the campaign list shows
sent, replied and booked, and can be stopped. Anyone who replies goes back on the board.

## Referrals and partners

From a past customer's lead, **Referral link** makes their own link (or texts it to them). Whoever fills in
the short form on it lands on the board tagged **Referral** with "Referred by" on their lead. Admins add
**partners** (RV dealers, storage lots, detailers) under **Referrals**, each with their own link, and see
who has sent leads, what they booked, and which customers are due a **thank-you** (mark it once they're
thanked). A partner's link can be turned off.

## Ad spend vs. results

On **Revenue → Where leads come from**, admins open **Ad spend** and enter what was spent each month on
Facebook, the website, Google Local Services, referral rewards and other ads. The lead source table then
adds **Ad spend**, **Cost per lead**, **Cost per booking** and **Return** (revenue for every dollar spent)
for the months in the chosen period.

## Google Local Services leads

With Google Ads API access, Local Services leads (calls, messages and bookings from the "Google Guaranteed"
ads) come in by themselves every 5 minutes, tagged **Google**, with the customer's message when they sent
one. Admins also get **Sync Google**. You need, from Google:

1. A **developer token** (Google Ads → Tools → API Center; basic access is enough).
2. An **OAuth client** (Google Cloud console → Credentials → OAuth client ID) and a **refresh token** for a
   Google login that can see the ads account.
3. The Local Services ads **customer ID** (and the manager account's ID if you sign in through one).

Set `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`,
`GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID` and, if needed, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`.
The first sync reaches back 30 days. Google only shares a caller's number when there is one (some are
tracking numbers).

## Importing leads from before the app

Admins: **Import leads** takes an Excel (.xlsx) or CSV file with one lead per row. The app matches the
columns from their names (a "Vehicle" column like "2022 Tesla Model Y" is split into year, make and model),
shows a preview, and asks where the leads go: **by date** (recent ones on the board, older ones straight to
Old & Dead Leads, old booked customers to Past Customers), all on the board, or none. Leads already in the
app and repeats in the file are skipped, columns that aren't matched are kept in the lead's notes, imports
don't set off new-lead alerts, and every import can be **undone**. There's a sample file to start from.

## Appearance

**Appearance** (top bar) lets **everyone** set up their own look, saved to their login so it follows
them to any phone or computer:

- **Light, Dark or Match my device.**
- **My look:** colors (buttons and links, highlight, and the top bar, page background, columns and
  cards, and borders for the light and the dark look; text follows the column color so it stays
  readable), a ready-made look (Midnight, Carbon, Clean white, Desert, Forest...), see-through columns
  and their own background picture. Anything they don't change follows the company look, and **Use the
  company look again** clears it.

Admins also get **Company look**: the same settings for everyone (also used on the sign-in and booking
pages), plus the **logos** (one for light backgrounds, one for dark). **Go back to the standard Bob Moses
look** undoes the company look.

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
`vehicle_color` and `vehicle_type` (`year`, `make`, `model`, `color` and `type` work too).

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

## Deploying on Fly.io

`fly.toml` and `Dockerfile` are set up for Fly: one machine in Los Angeles (closest to Las Vegas), a 1 GB
volume at `/data` for the database, Las Vegas time, and the company details. Run these from this folder
with the [Fly CLI](https://fly.io/docs/flyctl/install/) installed and `fly auth login` done:

```bash
fly launch --copy-config --no-deploy          # creates the app from fly.toml (pick a new name if asked)
fly volumes create leads_data --region lax --size 1
fly secrets set APP_USERS='Dylan:a-strong-password:admin,Sam:another-strong-password:sales,Mike:shop-password:shop'
fly deploy
fly open                                      # opens https://<app-name>.fly.dev
```

**Prefer your own server?** Oracle Cloud's free tier, AWS Lightsail or EC2 work too. See
[deploy/oracle/README.md](deploy/oracle/README.md): one setup script installs everything. Static-site
hosting (AWS Amplify, S3 + CloudFront, Netlify) can't run this app.

Then put it on the company's domain:

```bash
fly certs add leads.bobmosescc.com
```

Fly prints the DNS record to add (a CNAME from `leads` to `<app-name>.fly.dev`). Once that's added at
whoever hosts bobmosescc.com's DNS, `fly certs show leads.bobmosescc.com` shows the certificate is ready,
usually within minutes.

**On Namecheap** (the company's registrar): Domain List → **Manage** next to bobmosescc.com. Check that
**Nameservers** says Namecheap BasicDNS (if it says Custom DNS, add the record at that provider instead).
Then **Advanced DNS** → Host Records → **Add New Record** → **CNAME Record**:

| Type | Host | Value | TTL |
|---|---|---|---|
| CNAME Record | `leads` | `bob-moses-leads.fly.dev` | Automatic |

Save it with the green check. If `fly certs add` also lists an `_acme-challenge` CNAME, add it the same
way with Host `_acme-challenge.leads`. Leave the website (`@`, `www`) and email (MX/TXT) records alone,
and don't add an A record for `leads`.

Later, add the other secrets the same way when you have them:
`fly secrets set WEBSITE_API_KEY=… EMAIL_PROVIDER=resend EMAIL_API_KEY=… EMAIL_FROM='Bob Moses Ceramic Coating <…>' FB_VERIFY_TOKEN=… FB_APP_SECRET=… FB_PAGE_ACCESS_TOKEN=… FB_FORM_IDS=…`
Each `fly secrets set` restarts the app with the new values. Keep it at one machine: the database is a
single file on the volume. Turn on volume snapshots (`fly volumes list`, then the Fly dashboard) for backups.

Off-server backups, if you run the app on your own server: see `deploy/oracle/README.md`.

## Deploying elsewhere

Any host that runs Node 22 works, such as Render, Railway, Fly.io or a small VPS. Things to check:

- Set `APP_USERS` so the dashboard needs a login (see below). The webhook and website intake URLs stay public.
- Keep `data/leads.db` on a persistent disk, and back it up.
- Set `TZ=America/Los_Angeles` so server-side reminder times are Las Vegas time.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/leads?q=&source=&pipeline=&view=&vehicle_type=&status=` | List leads (`view=old` for Old & Dead) |
| GET | `/api/leads/search?q=` | The search box: every lead, best matches first |
| POST | `/api/leads/:id/restore` | Put an old or dead lead back on its board |
| GET | `/api/export.xlsx?…same filters…` | Excel download |
| GET | `/api/jobs?from=&to=` | Jobs on the calendar between two dates |
| GET / PATCH | `/api/jobs/:id` | A job with its checklist and photos / change status, times, notes |
| POST | `/api/leads/:id/job` | Put a booked lead on the calendar `{ job_start, job_end }` |
| POST / PATCH / DELETE | `/api/jobs/:id/checklist[/:item]` | Add, tick (`{ done }`) or remove checklist items |
| POST / GET / DELETE | `/api/jobs/:id/photos[/:photo]` | Upload (raw image body, `?phase=before\|during\|after`), view, delete |
| POST | `/api/leads` | Add a lead manually |
| GET / PATCH | `/api/leads/:id` | Lead details, or edit fields / stage |
| POST | `/api/leads/:id/disposition` | `{ disposition, note?, reminder?, reminder_at? }` |
| POST | `/api/leads/:id/notes` | `{ note }` |
| GET | `/api/reminders` | Open reminders |
| POST | `/api/reminders/:id/complete` | Mark a reminder done |
| POST | `/api/reminders/:id/snooze` | `{ due_at }` |
| GET / PUT | `/api/settings/email` | Follow-up email template `{ enabled, subject, body }` |
| POST | `/api/facebook/sync` | Pull leads from `FB_FORM_IDS` |
| POST | `/api/google/sync` | Pull Google Local Services leads now |
| POST | `/api/jobs/:id/payments` | Record a payment or refund `{ amount, method, note, kind }` |
| GET | `/api/jobs/:id/invoice.pdf` | Invoice or receipt PDF |
| GET / PUT | `/api/ad-spend` | Monthly ad spend by source |
| GET | `/api/analytics?from=&to=&pipeline=` | Everything on the Analytics page |
| POST | `/api/jobs/:id/work/start` · `/pause` · `/finish` | The shop's work timer |
| POST / PATCH / DELETE | `/api/jobs/:id/work`, `/api/work/:id` | Admins add, fix or remove work time |
| GET | `/api/estimate?lead_id=&services=` or `?job_id=` | Suggested work time and why |
| POST | `/api/leads/:id/calls` | Dialer: start a call (CALLS_ENABLED) |
| GET / PUT | `/api/pipelines` | The pipelines (admins) |
| GET / POST | `/api/clock`, `/api/clock/in { location: { lat, lng, accuracy } }`, `/api/clock/out`, `/api/clock/lunch` | The time clock for whoever is signed in (clock in again to end lunch; the location is needed when the geo-lock applies) |
| GET | `/api/timecard?from=&to=` | Your own punches and correction requests |
| POST / DELETE | `/api/timecard/corrections[/:id]` | Ask for a correction `{ action: change\|add\|remove, punch_id, clock_in, clock_out, reason }` / cancel it |
| GET / PATCH | `/api/timecard/corrections?status=pending`, `/api/timecard/corrections/:id` | Admins: corrections, `{ status: approved\|denied, note }` |
| POST / DELETE | `/api/time-off[/:id]` | Ask for time off `{ start_date, end_date, kind, hours_per_day, note }` / cancel it |
| GET / PATCH | `/api/time-off?status=pending`, `/api/time-off/:id` | Admins: requests, `{ status: approved\|denied, note }` |
| GET | `/api/time-off/calendar?from=&to=` | Approved time off for the calendar |
| GET | `/api/payroll?from=&to=` | Time & Pay for a period (admins) |
| PUT | `/api/pay-rates`, `/api/payroll/settings` | Hourly rates `{ user_name, rate }` and payroll rules (overtime, `review_day`, `payroll_emails`) |
| POST | `/api/timecard/approve-week`, `/api/clock/out { approve_week }` | Approve your own week (on Friday, clocking out needs it) |
| POST | `/api/payroll/weeks/:sunday/approve`, `/api/payroll/weeks/:sunday/email` | Admins: approve a pay week, email its summary now |
| GET / PUT | `/api/schedules` | Work schedules for attendance |
| POST / PATCH / DELETE | `/api/time/punches[/:id]` | Admins add, fix or remove clocked time |
| GET / PATCH | `/api/calls`, `/api/calls/:id`, `/api/calls/:id/review` | Dialer: calls, notes, admin review |
| GET / POST | `/api/campaigns` | Win-back campaigns |
| GET / POST | `/api/public/referral/:code` | The public referral form (`/r/:code`) |
| POST | `/webhooks/twilio/voice` | Incoming calls (forward, then text back if missed) |
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
src/services.js      services that can be booked
src/export.js        Excel workbook layout (summary, all leads, sheet per vehicle type)
src/xlsx.js          writes .xlsx files with no dependencies
src/jobs.js          shop calendar jobs, vehicle checklist, job photos
public/calendar.js   calendar views and the job panel
src/email.js         email templates and sending (Resend / SendGrid / Postmark)
src/db.js            SQLite schema
src/messages.js      texts, saved texts, booking confirmations and day-before reminders
src/sms.js           Twilio texting (send, webhook signature check)
src/alerts.js        new-lead and reply alerts; src/push.js sends them (Web Push, no dependencies)
src/bookings.js      online booking links; src/stripe.js card deposits (Stripe Checkout)
src/daysheet.js      the shop's morning day-sheet email
src/payments.js      payments and balance due; src/invoices.js invoice PDFs (src/pdf.js, no dependencies)
src/campaigns.js     quote follow-ups and win-back campaigns
src/referrals.js     customer referral and partner links; public/refer.html their form
src/adspend.js       monthly ad spend by source
src/analytics.js     the Analytics report; public/analytics.js its page and charts
src/worktime.js      the shop's work timer
src/estimates.js     work time learned from finished jobs (vehicle type, paint color, services)
src/cardimport.js    card payments from a Talech / Elavon export, matched to jobs
src/calls.js         the dialer (CALLS_ENABLED): calls, live transcription, review
src/pipelines.js     the pipelines admins set up; public/pipelines.js its screen
src/timeclock.js     time clock, time off, hourly rates and Time & Pay; public/timeclock.js its screens
src/callsummary.js   call notes with Claude (or basic notes without a key)
public/calls.js      the dialer's screens
src/google-lsa.js    Google Local Services leads (Google Ads API)
public/growth.js     referral links and the Referrals panel
src/import.js        importing leads from a spreadsheet; src/sheets.js reads .xlsx and CSV
public/shop-time.js  work time and hours per day (shared by the server and the browser)
public/messages.js   texts, alerts, booking links and the Texts & reminders panel
public/import.js     the Import leads panel
public/appearance.js light/dark and the Appearance panel; src/appearance.js its settings and CSS
public/book.html     the customer's online booking page
scripts/backup-offsite.js  nightly copy of the database and photos to a cloud bucket
public/              dashboard (HTML/CSS/JS), app manifest, service worker, icons
examples/            website form snippet
test/                tests (npm test)
```
