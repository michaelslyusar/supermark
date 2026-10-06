# SuperMark Mass Lab: what the site contains and does

SuperMark Mass Lab is a one-page web app for building high-calorie, high-protein shakes for gaining weight. Users pick ingredients and portions, the calorie and macro totals update as they go, and they can save shakes to a private history. It's plain HTML and JavaScript, with Supabase for accounts and storage.

## 1. Accounts

- **Sign up and log in** use only a username and password; no email is needed.
  - The username must be 3–20 letters, numbers or underscores.
  - Behind the scenes, the username becomes a fake address `username@supermark.invalid`, because Supabase Auth requires an email. For this to work, "Confirm email" must be turned off in Supabase.
- Login and registration share one popup, with a link at the bottom to switch between them.
- **Error messages** cover a wrong username or password, a username that's taken, and email confirmation being on in Supabase.
- **Log out** is in the header, which also shows "Signed in as *username*".
- If a logged-out user tries to save something, the login popup opens with a message explaining why.

## 2. Landing page (logged out)

- **Intro:** a headline, short description, and "Create free account" and "I have an account" buttons.
- **Live demo:** a glass that fills in layers as visitors tap six built-in ingredients, with a running calorie and macro count, an 800 kcal goal line, and "Empty the glass". It starts pre-filled with milk, two bananas and whey. Nothing is saved.
- **Feature list:**
  - totals that update with every ingredient
  - half-portion steps
  - avoided ingredients are hidden
  - a private shake history
- **How it works:** create an account → build a shake → name it and log it.
- **Closing call to action** with another sign-up button.

## 3. Dashboard (logged in)

The dashboard opens with "Welcome back, *username*" and has four tabs. The site remembers the last open tab.

### Tab 1: Shake builder

- **Ingredient list:** built-in and user-added ingredients, sorted by category, most useful first:
  - protein → liquid → dairy → carbs → fats → fruit → sweeteners → seeds and extras → flavor.
  - Each ingredient shows its category, name, serving size, calories and protein.
- **Selecting and portions:** clicking an ingredient adds it at 1 portion. Its − / + buttons then change the amount in half-portion steps, up to 20 portions. Going below 0.5 removes it.
- **Hidden ingredients:** anything the user marked "Avoid" is left out. A note says how many are hidden and links to "My ingredients".
- **Shake totals:**
  - calories, protein, carbs and fat for the current selection
  - progress toward an 800 kcal target, with a "Goal hit" message at 100%
  - a count of selected ingredients
- **Saving:**
  - **Log this shake:** saves it under a name, which is required. Pressing Enter in the name field also saves.
  - **Save as favorites:** saves the selection as an unnamed favorite combination.
- **Recent shakes:** the 3 latest saved items, with a "View all N →" link to the history tab.

### Tab 2: My shakes

- Lists everything the user has saved, newest first, showing the latest 100.
- **Each item shows:**
  - the name (favorites are labeled "Favorite stack")
  - its ingredients and portions, e.g. "Banana ×2 · Whole Milk"
  - for named shakes, total calories, protein, carbs and fat
  - the date and time it was saved
- **Delete** asks for confirmation first.
- Totals come from a copy of each ingredient's values taken at save time. If an ingredient changes later, past shakes stay the same.

### Tab 3: Food profile (quiz)

- Shows one ingredient at a time, with **"I'd eat this" / "Not for me" / "Skip"**.
- It starts at the first ingredient the user hasn't rated, and shows progress ("X of Y rated") and the current answer.
- When every ingredient is answered, a "Profile complete" screen offers "Start over".

### Tab 4: My ingredients

- **Preferences:** the full ingredient list, each with **Eat it / Avoid / No answer**. These are the same ratings as the quiz, saved to the account.
  - The screen updates right away and undoes the change if saving fails.
- **Add an ingredient** (logged-in users only):
  - name, category, form (liquid, creamy, paste, syrup, solid, powder or granular)
  - serving amount and unit, calories, protein, carbs, fat
  - Added ingredients become **available to all users**.

## 4. Languages

- English and Russian, switched with the EN / RU buttons in the header.
- Each language's text is in `lang/en.json` and `lang/ru.json`. Only the selected file is loaded.
- **The first language** comes from the saved choice, or from the browser language if nothing is saved.
- Plurals follow each language's rules, and number formats are local (13.5 vs 13,5).
- Built-in ingredient names are translated. User-added ingredients and shake names stay as typed.

## 5. Data (Supabase)

| Table | Contents | Who can access |
|---|---|---|
| `ingredients` | 15 built-in ingredients plus user-added ones | Anyone can read; logged-in users can add |
| `entries` | Saved shakes and favorites (type, name, time) | Only the owner: read, add, delete |
| `entry_ingredients` | Each ingredient in a saved item, with portions and a copy of its values | Only the owner of the saved item |
| `ingredient_preferences` | Each user's like / avoid answers | Only that user |

- **Saving** goes through the `create_entry` database function. It saves a shake and its ingredients together, so a failure saves nothing.
  - It checks for 1–30 ingredients, requires a name for a shake, and rejects unknown ingredients.
- **Limits enforced in the database:** portions are in halves up to 20, an ingredient name is at most 60 characters, and nutrition values have upper limits.

**Built-in ingredients:** whole milk, Greek yogurt, banana, blueberries, strawberries, rolled oats, peanut butter, almond butter, avocado, whey protein, chia seeds, hemp seeds, Medjool dates, honey, cocoa powder.

## 6. Project files

- `index.html`, `app.js`, `style.css`: the app itself.
- `lang/`: the translations.
- `supabase/schema.sql`: sets up the whole database. Re-running it **deletes all data**.
- `supabase/cleanup_ingredient_ids.sql`: a one-time change that removes an old column and the check that went with it.
- `ing.json`: the original ingredient list the database was filled from. The app doesn't read it while running.
