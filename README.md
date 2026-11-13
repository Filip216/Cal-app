# Meal Tracker

Calorie and macro tracker where you enter your own foods (per 100 g) from sources you trust.
Everything is stored in the browser (localStorage). No server, no account, no cost.

## Files
- `index.html`, `style.css`, `app.js` – the app
- `manifest.json`, `sw.js`, `*.png` – make it installable on the iPhone Home Screen and work offline

## Put it online (free)
Upload all files to any static host, e.g. GitHub Pages, Netlify or Cloudflare Pages.
The site must be served over **https** (all of those do this) so the Home Screen app and offline mode work.

## Install on iPhone
1. Open the site in **Safari** → Share → **Add to Home Screen**.
2. Open the app **from the Home Screen icon** and create your profile there.

Important: the Home Screen app has its own storage, separate from Safari.
Data created in a Safari tab will not appear in the Home Screen app (use Profile → Backup & restore to move it).

## Backups
Profile → Backup & restore → Export. Do this now and then; clearing browser data deletes everything.

## Migrating from the first version
If the old app was on the same address, your old profile, foods, today's entries and finished days are imported
automatically the first time the new version opens. The old data is not deleted. Log in with your old password.

## New in v3
- **Meals:** combine foods (e.g. toast sandwich = bread + salami) and change the grams of each ingredient every time you add it.
- **Look up values:** in the food form, "Look up values by name" searches USDA FoodData Central and Open Food Facts,
  fills in the numbers and saves the source link. Needs internet. For a higher daily limit, put a free USDA API key into Profile -> Settings.
- **Light / dark mode:** Profile -> Appearance (System follows the phone).
- **Wide screens:** side navigation and a two-column Today page.

## New in v3.1
- Sliders for the grams of every ingredient when creating a meal and when adding it to a day.
- Today: units next to every number, larger text. Tap an entry to expand it: big values, share of energy, share of your daily goal
  and arrows comparing the food's macro mix with your target mix (protein up = green, down = red; carbs and fat up = amber, down = blue).
- Darker, bluer dark mode.

## New in v3.2
- Eye icons replace the check marks: eye = counted, crossed eye = paused (meal: dashed = some ingredients paused).
- A meal on Today stays closed; tap it for the totals of the whole meal (with the arrows) and its ingredients.
- Weekly stats: daily average vs goal, streak, days on target, surplus / deficit against your maintenance calories and an estimated weight change.
  Set maintenance calories in Profile -> Daily goals.
- Small animations (page open, new entries, bars, ring). They switch off automatically if the phone has "Reduce motion" turned on.
