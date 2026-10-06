// Supabase project settings (Project Settings → API). The anon/publishable key is
// meant to be public; row-level security in supabase/schema.sql limits what it can do.
const SUPABASE_URL = "https://mimrzkpppjfrcciyjgqf.supabase.co";
const SUPABASE_KEY = "sb_publishable_oNCzcOBRWIAbl01lw5eKxg_hH6ttfD7";

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const EMOJI = {
  whole_milk: "🥛", greek_yogurt: "🥣", banana: "🍌", blueberries: "🫐", strawberries: "🍓",
  oats: "🌾", peanut_butter: "🥜", almond_butter: "🌰", avocado: "🥑", whey_protein: "💪",
  chia_seeds: "⚫", hemp_seeds: "🌱", dates: "🟤", honey: "🍯", cocoa_powder: "🍫",
};

// Built-in ingredients have a 256px picture at img/ingredients/<id>.webp (full-size originals
// are in img/ingredients/original/). Ingredients users add keep an emoji.
const ING_IMG = Object.fromEntries(Object.keys(EMOJI).map((id) => [id, `img/ingredients/${id}.webp`]));

// Fills an icon slot with the ingredient's picture, or its emoji when there is none.
function setIngIcon(el, id) {
  el.textContent = "";
  if (ING_IMG[id]) {
    const img = document.createElement("img");
    img.src = ING_IMG[id];
    img.alt = "";
    img.className = "ing-img";
    el.appendChild(img);
  } else {
    el.textContent = EMOJI[id] || "🥄";
  }
}

const $ = (id) => document.getElementById(id);
const selected = new Map();   // ingredient id -> portions (steps of 0.5)
const PORTION_STEP = 0.5;
const MAX_PORTIONS = 20;      // matches the check on entry_ingredients.portions
let ingredients = [];   // rows from the ingredients table, in display order
let byId = {};
let entries = [];
let userId;             // logged-in Supabase user; null when logged out, undefined until checked
let username = "";
let prefs = {};         // ingredient_id -> "like" | "dont_like"
let quizIndex = 0;

const SHAKE_GOAL_KCAL = 800;   // a typical mass-gain shake
const RECENT_COUNT = 3;

// Display order: what matters most for a mass-gain shake comes first.
const CATEGORY_ORDER = ["protein", "liquid", "base", "carbohydrate", "fat", "fruit", "sweetener", "extra", "flavor"];
const TAB_KEY = "milkshake-tab";

// ---------- translations ----------
// Each language is one file, lang/<code>.json, and only the selected one is loaded.
// Values are strings with {placeholders}, plural objects ({ one, few, many, other }), or arrays.
const LANGS = ["en", "ru"];
const LANG_KEY = "supermark-lang";
let lang = "en";
let dict = {};
const dictCache = {};

async function loadDict(code) {
  if (!dictCache[code]) {
    const res = await fetch(`lang/${code}.json`);
    if (!res.ok) throw new Error(`lang/${code}.json: HTTP ${res.status}`);
    dictCache[code] = await res.json();
  }
  return dictCache[code];
}

// t("key", { n: 3 }) → translated text. Missing keys fall back to the key itself.
// Plural forms are picked by params.count, or params.n when there is no count
// (pass count separately when n is a formatted number like "1,5").
function t(key, params = {}) {
  let value = dict[key];
  if (value === undefined) return key;
  if (Array.isArray(value)) return value;
  if (typeof value === "object") {
    value = value[new Intl.PluralRules(lang).select(params.count ?? params.n ?? 0)] ?? value.other;
  }
  return value.replace(/\{(\w+)\}/g, (m, name) => (name in params ? params[name] : m));
}

// Built-in ingredients have translated names; ones users add keep the name they typed.
const ingName = (ing) => dict[`ing.${ing.id}`] ?? ing.name;
const unitName = (unit) => dict[`unit.${unit}`] ?? unit;

function applyStaticText() {
  document.documentElement.lang = lang;
  document.title = t("meta.title");
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    if (el.dataset.i18n in dict) el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    el.dataset.i18nAttr.split(",").forEach((pair) => {
      const [attr, key] = pair.split(":").map((s) => s.trim());
      if (key in dict) el.setAttribute(attr, t(key));
    });
  });
  document.querySelectorAll(".lang-btn").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
  });
}

async function setLanguage(code) {
  try {
    dict = await loadDict(code);
    lang = code;
  } catch (err) {
    console.error("Couldn't load translations", err);
    return;
  }
  try { localStorage.setItem(LANG_KEY, code); } catch {}
  applyStaticText();
  renderAccount();
  setAuthMode(authMode);
  updateShakeBtn();
  setStatus("");
  renderPrefs();     // also re-renders the builder
  renderQuiz();
  renderEntries();
  renderDemoTray();
}

function initialLanguage() {
  let saved = null;
  try { saved = localStorage.getItem(LANG_KEY); } catch {}
  if (LANGS.includes(saved)) return saved;
  return navigator.language?.toLowerCase().startsWith("ru") ? "ru" : "en";
}

// ---------- accounts ----------
// Supabase Auth needs an email, so a username maps to a placeholder address that is never
// mailed (.invalid is a reserved TLD). Requires "Confirm email" to be off in Supabase.
const USERNAME_DOMAIN = "supermark.invalid";

// Registration is closed for now: every sign-up button and link is hidden (see .signup-closed
// in style.css). Set to true to bring them back.
const REGISTRATION_OPEN = false;
document.body.classList.toggle("signup-closed", !REGISTRATION_OPEN);
const usernameToEmail = (name) => `${name.trim().toLowerCase()}@${USERNAME_DOMAIN}`;

async function logIn(name, password) {
  const { error } = await db.auth.signInWithPassword({ email: usernameToEmail(name), password });
  if (error) throw new Error(error.message === "Invalid login credentials" ? t("auth.wrongCredentials") : error.message);
}

async function signUp(name, password) {
  const { data, error } = await db.auth.signUp({
    email: usernameToEmail(name),
    password,
    options: { data: { username: name.trim().toLowerCase() } },
  });
  if (error?.code === "user_already_exists") throw new Error(t("auth.usernameTaken"));
  // Supabase only rejects the placeholder address when it tries to send a confirmation email.
  if (error?.code === "email_address_invalid") throw new Error(t("auth.confirmEmailOn"));
  if (error) throw error;
  if (!data.session) throw new Error(t("auth.noSession"));
}

// Called on page load and whenever the user logs in or out.
async function applySession(session) {
  // A leftover anonymous session from the earlier version of the page counts as logged out.
  const user = session?.user && !session.user.is_anonymous ? session.user : null;
  const id = user?.id || null;
  if (id === userId) return;
  const firstCheck = userId === undefined;
  userId = id;
  username = user?.user_metadata?.username || user?.email?.split("@")[0] || "";
  renderAccount();
  showView();
  if (!firstCheck) window.scrollTo({ top: 0 });   // just logged in or out: start at the top

  prefs = {};
  entries = [];
  await Promise.all([loadPrefs(), loadEntries()]);
  renderEntries();
  quizIndex = firstUnrated();
  renderQuiz();
  renderPrefs();
}

function renderAccount() {
  $("accountName").innerHTML = "";
  if (userId) {
    $("accountName").append(`${t("account.signedInAs")} `);
    const b = document.createElement("b");
    b.textContent = username;
    $("accountName").append(b);
  }
  $("accountName").hidden = !userId;
  $("dashGreeting").textContent = t("dash.greeting", { name: username });
  $("registerOpen").hidden = !!userId;
  $("loginOpen").hidden = !!userId;
  $("logoutBtn").hidden = !userId;
  $("addForm").hidden = !userId;
  $("addLoginHint").hidden = !!userId;
}

// Landing page when logged out, dashboard when logged in. Until the saved session has been
// checked (userId === undefined) both stay hidden, so neither one flashes on load.
function showView() {
  if (userId === undefined) return;
  $("landing").hidden = !!userId;
  $("dashboard").hidden = !userId;
  document.body.classList.toggle("logged-in", !!userId);
}

// The login popup doubles as the register popup; the link at the bottom switches between them.
let authMode = "login";

function setAuthMode(mode) {
  authMode = mode;
  $("authTitle").textContent = t(`auth.${mode}.title`);
  $("authHint").textContent = t(`auth.${mode}.hint`);
  $("authSubmit").textContent = t(`auth.${mode}.submit`);
  $("authSwitchText").textContent = t(`auth.${mode}.switchText`);
  $("authSwitch").textContent = t(`auth.${mode}.switchLink`);
  $("authPass").autocomplete = mode === "signup" ? "new-password" : "current-password";
  $("authError").textContent = "";
}

function openLogin(message = "", mode = "login") {
  if (!REGISTRATION_OPEN) mode = "login";
  setAuthMode(mode);
  $("authError").textContent = message;
  if (!$("authDialog").open) $("authDialog").showModal();
  $("authUser").focus();
}

// ---------- database ----------
async function loadPrefs() {
  if (!userId) return;
  const { data, error } = await db.from("ingredient_preferences").select("ingredient_id, status");
  if (error) {
    setStatus(t("error.loadPrefs", { msg: error.message }), "error");
    return;
  }
  prefs = Object.fromEntries(data.map((p) => [p.ingredient_id, p.status]));
}

// status: "like" | "dont_like" | null (clear). Updates the screen first, reverts on failure.
async function setPref(id, status) {
  if (!userId) {
    openLogin(t("auth.loginForLikes"));
    return;
  }
  const prev = prefs[id];
  if (status) prefs[id] = status; else delete prefs[id];
  renderPrefs();

  const { error } = status
    ? await db.from("ingredient_preferences")
        .upsert({ user_id: userId, ingredient_id: id, status, updated_at: new Date().toISOString() })
    : await db.from("ingredient_preferences").delete().eq("user_id", userId).eq("ingredient_id", id);

  if (error) {
    if (prev) prefs[id] = prev; else delete prefs[id];
    renderPrefs();
    renderQuiz();
    setStatus(t("error.savePref", { name: ingName(byId[id]), msg: error.message }), "error");
  }
}

async function loadIngredients() {
  const { data, error } = await db.from("ingredients").select("*").order("category").order("name");
  if (error) {
    setStatus(t("error.loadIngredients", { msg: error.message }), "error");
    return;
  }
  setIngredients(data);
}

function setIngredients(rows) {
  const rank = (c) => (CATEGORY_ORDER.indexOf(c) + 1) || 99;
  ingredients = rows.sort((a, b) => rank(a.category) - rank(b.category) || a.name.localeCompare(b.name));
  byId = Object.fromEntries(ingredients.map((i) => [i.id, i]));
  renderIngredients();
}

async function addIngredient(row) {
  const { data, error } = await db.from("ingredients").insert(row).select().single();
  if (error) throw error;
  return data;
}

// Only the logged-in user's own entries come back (row-level security).
async function loadEntries() {
  if (!userId) return;
  const { data, error } = await db
    .from("entries")
    .select("*, entry_ingredients(*)")
    .order("created_at", { ascending: false })
    .order("id", { referencedTable: "entry_ingredients" })
    .limit(100);
  if (error) {
    setStatus(t("error.loadEntries", { msg: error.message }), "error");
    return;
  }
  entries = data;
  renderEntries();
}

// Saves the entry and its ingredients (with portions and a snapshot of their values) in one
// transaction via the create_entry database function, then reads it back.
async function saveEntry(type, name, items) {
  const { data: id, error } = await db.rpc("create_entry", { p_type: type, p_name: name, p_items: items });
  if (error) throw error;
  const { data, error: readError } = await db
    .from("entries")
    .select("*, entry_ingredients(*)")
    .eq("id", id)
    .order("id", { referencedTable: "entry_ingredients" })
    .single();
  if (readError) throw readError;
  return data;
}

// Row-level security only lets users delete their own entries.
async function deleteEntry(e) {
  const title = entryTitle(e);
  if (!confirm(t("entries.confirmDelete", { name: title }))) return;
  const { error } = await db.from("entries").delete().eq("id", e.id);
  if (error) {
    setStatus(t("error.delete", { msg: error.message }), "error");
    return;
  }
  entries = entries.filter((x) => x.id !== e.id);
  renderEntries();
  setStatus(t("status.deleted", { name: title }), "ok");
}

// ---------- UI ----------
// Decimal separator follows the language ("13.5" / "13,5").
const num = (n) => Number(n).toLocaleString(lang, { maximumFractionDigits: 1 });

// "250 ml · 153 kcal · 8g protein"
function ingredientMeta(ing) {
  return t("ingredient.meta", {
    amount: num(ing.serving_amount), unit: unitName(ing.serving_unit),
    kcal: num(ing.calories), protein: num(ing.protein_g),
  });
}

// The builder leaves out ingredients the user marked "Avoid" (and drops them from the selection).
function renderIngredients() {
  const box = $("ingredients");
  box.innerHTML = "";
  const avoided = ingredients.filter((ing) => prefs[ing.id] === "dont_like");
  avoided.forEach((ing) => selected.delete(ing.id));
  $("hiddenNote").hidden = avoided.length === 0;
  $("hiddenCount").textContent = t("builder.hiddenCount", { n: avoided.length });
  ingredients.filter((ing) => prefs[ing.id] !== "dont_like").forEach((ing) => {
    // Card = a toggle button (select / unselect) plus, once selected, a − / + portion stepper.
    const card = document.createElement("div");
    card.className = "chip";
    card.innerHTML =
      `<button type="button" class="chip-main"><span class="emoji" aria-hidden="true"></span>` +
      `<span><span class="chip-cat"></span><span class="chip-name"></span><span class="chip-meta"></span></span></button>` +
      `<div class="stepper" role="group"><button type="button" class="step-btn step-less">−</button>` +
      `<output class="step-val" aria-live="polite"></output><button type="button" class="step-btn step-more">+</button></div>`;
    setIngIcon(card.querySelector(".emoji"), ing.id);
    card.querySelector(".chip-cat").textContent = t(`category.${ing.category}`);
    card.querySelector(".chip-name").textContent = ingName(ing);
    card.querySelector(".chip-meta").textContent = ingredientMeta(ing);
    card.querySelector(".stepper").setAttribute("aria-label", t("portions.aria", { name: ingName(ing) }));
    card.querySelector(".step-less").setAttribute("aria-label", t("portions.less"));
    card.querySelector(".step-more").setAttribute("aria-label", t("portions.more"));

    const update = () => {
      const p = selected.get(ing.id) || 0;
      card.classList.toggle("selected", p > 0);
      card.querySelector(".chip-main").setAttribute("aria-pressed", String(p > 0));
      card.querySelector(".stepper").hidden = p === 0;
      card.querySelector(".step-val").textContent = `×${num(p)}`;
      card.querySelector(".step-more").disabled = p >= MAX_PORTIONS;
      renderTotals();
    };
    const setPortions = (p) => {
      if (p > 0) selected.set(ing.id, Math.min(p, MAX_PORTIONS)); else selected.delete(ing.id);
      update();
    };
    card.querySelector(".chip-main").addEventListener("click", () => setPortions(selected.has(ing.id) ? 0 : 1));
    card.querySelector(".step-less").addEventListener("click", () => setPortions((selected.get(ing.id) || 0) - PORTION_STEP));
    card.querySelector(".step-more").addEventListener("click", () => setPortions((selected.get(ing.id) || 0) + PORTION_STEP));
    update();
    box.appendChild(card);
  });
  renderTotals();
}

// Live macro panel for the current selection.
function renderTotals() {
  const tot = macroTotals([...selected].map(([id, p]) => [byId[id], p]));
  const pct = Math.round((tot.calories / SHAKE_GOAL_KCAL) * 100);
  $("totalKcal").textContent = Math.round(tot.calories);
  $("totalProtein").textContent = Math.round(tot.protein_g);
  $("totalCarbs").textContent = Math.round(tot.carbs_g);
  $("totalFat").textContent = Math.round(tot.fat_g);
  $("goalFill").style.width = `${Math.min(pct, 100)}%`;
  $("goalBar").setAttribute("aria-valuenow", String(Math.min(pct, 100)));
  $("goalLabel").textContent = t(pct >= 100 ? "macros.goalHit" : "macros.goal", { pct, goal: SHAKE_GOAL_KCAL });
  $("selCount").textContent = selected.size
    ? t("macros.selected", { n: selected.size })
    : t("macros.noneSelected");
}

// Sums [source, portions] pairs. A source is an ingredient row (the builder) or a saved
// entry_ingredients snapshot row (logged shakes); both have the same macro columns.
function macroTotals(pairs) {
  const tot = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  pairs.forEach(([src, portions]) => {
    if (src) Object.keys(tot).forEach((k) => (tot[k] += Number(src[k]) * Number(portions)));
  });
  return tot;
}

// Snapshot rows use the translated name for built-ins, and the saved name for the rest.
const rowName = (row) => (row.ingredient_id && dict[`ing.${row.ingredient_id}`]) || row.name;
const entryTitle = (e) => (e.type === "milkshake" ? e.name : t("entries.favoriteTitle"));
const entryDate = (e) => new Date(e.created_at).toLocaleString(lang, { dateStyle: "medium", timeStyle: "short" });

// The builder shows the latest few; the "My shakes" tab shows the full history.
function renderEntries() {
  const empty = t(userId ? "entries.emptyLoggedIn" : "entries.emptyLoggedOut");
  renderEntryList($("entries"), $("emptyMsg"), entries.slice(0, RECENT_COUNT), empty);
  renderEntryList($("allEntries"), $("allEmptyMsg"), entries, empty);
  $("viewAllShakes").hidden = entries.length <= RECENT_COUNT;
  $("viewAllShakes").textContent = t("entries.viewAll", { n: entries.length });
  $("historyCount").textContent = userId && entries.length
    ? t("entries.count", { n: entries.length }) + (entries.length === 100 ? ` ${t("entries.countCapped")}` : "")
    : "";
}

// Each entry is a button that opens its exact contents, plus a separate delete button.
function renderEntryList(ul, emptyMsg, list, emptyText) {
  ul.innerHTML = "";
  emptyMsg.hidden = list.length > 0;
  emptyMsg.textContent = emptyText;
  list.forEach((e) => {
    const li = document.createElement("li");
    li.className = `entry ${e.type}`;
    li.innerHTML = `<button type="button" class="entry-open"><span class="icon" aria-hidden="true"></span>` +
      `<span class="entry-body"><span class="title"></span><span class="ing-tags"></span><span class="stats"></span></span></button>` +
      `<span class="entry-side"><time class="meta"></time><button type="button" class="entry-delete">` +
      `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 7v4M9.2 7v4"/></svg>` +
      `<span></span></button></span>`;
    li.querySelector(".icon").textContent = e.type === "milkshake" ? "🥤" : "★";
    // Shake names are saved in the language that was active when the shake was logged.
    li.querySelector(".title").textContent = entryTitle(e);
    const tags = li.querySelector(".ing-tags");
    (e.entry_ingredients || []).forEach((row) => {
      const tag = document.createElement("span");
      tag.className = "ing-tag";
      tag.innerHTML = `<span class="ing-tag-emoji" aria-hidden="true"></span><span class="ing-tag-name"></span>`;
      setIngIcon(tag.querySelector(".ing-tag-emoji"), row.ingredient_id);
      tag.querySelector(".ing-tag-name").textContent = rowName(row);
      if (Number(row.portions) !== 1) {
        const n = document.createElement("b");
        n.textContent = `×${num(row.portions)}`;
        tag.appendChild(n);
      }
      tags.appendChild(tag);
    });
    if (e.type === "milkshake") {
      // Totals use the values saved with the shake, not the ingredient's current values.
      const tot = macroTotals((e.entry_ingredients || []).map((row) => [row, row.portions]));
      const stats = li.querySelector(".stats");
      [["kcal-stat", "stat.kcal", tot.calories], ["p", "stat.protein", tot.protein_g],
       ["c", "stat.carbs", tot.carbs_g], ["f", "stat.fat", tot.fat_g]].forEach(([cls, key, value]) => {
        const s = document.createElement("span");
        s.className = `stat ${cls}`;
        s.textContent = t(key, { n: Math.round(value) });
        stats.appendChild(s);
      });
    }
    li.querySelector(".entry-open").setAttribute("aria-label", t("entries.openAria", { name: entryTitle(e) }));
    li.querySelector(".entry-open").addEventListener("click", () => openShakeDetails(e));
    const time = li.querySelector(".meta");
    time.dateTime = e.created_at;
    time.textContent = entryDate(e);
    const del = li.querySelector(".entry-delete");
    del.querySelector("span").textContent = t("entries.delete");
    del.setAttribute("aria-label", t("entries.deleteAria", { name: entryTitle(e) }));
    del.addEventListener("click", () => deleteEntry(e));
    ul.appendChild(li);
  });
}

// ---------- shake details (dialog with exact amounts) ----------
// Amounts come from the snapshot saved with the entry: portions × the serving at save time.
function openShakeDetails(e) {
  const rows = e.entry_ingredients || [];
  $("shakeDialogTitle").textContent = entryTitle(e);
  $("shakeDialogDate").dateTime = e.created_at;
  $("shakeDialogDate").textContent = entryDate(e);
  $("shakeDialogCount").textContent = t("shake.ingredientCount", { n: rows.length });

  const ul = $("shakeDialogList");
  ul.innerHTML = "";
  rows.forEach((row) => {
    const portions = Number(row.portions);
    const unit = unitName(row.serving_unit);
    const li = document.createElement("li");
    li.className = "detail-row";
    li.innerHTML = `<span class="emoji" aria-hidden="true"></span>` +
      `<div class="detail-info"><div class="detail-name"></div><div class="detail-portion"></div><div class="detail-macros"></div></div>` +
      `<div class="detail-amount"><b></b><span></span></div>`;
    setIngIcon(li.querySelector(".emoji"), row.ingredient_id);
    li.querySelector(".detail-name").textContent = rowName(row);
    li.querySelector(".detail-portion").textContent = t("shake.portionLine", {
      portions: num(portions), amount: num(row.serving_amount), unit, count: portions,
    });
    const macros = li.querySelector(".detail-macros");
    [["p", "stat.protein", row.protein_g], ["c", "stat.carbs", row.carbs_g], ["f", "stat.fat", row.fat_g]]
      .forEach(([cls, key, value]) => {
        const s = document.createElement("span");
        s.className = cls;
        s.textContent = t(key, { n: num(Number(value) * portions) });
        macros.appendChild(s);
      });
    li.querySelector(".detail-amount b").textContent = `${num(portions * Number(row.serving_amount))} ${unit}`;
    li.querySelector(".detail-amount span").textContent = t("stat.kcal", { n: Math.round(Number(row.calories) * portions) });
    ul.appendChild(li);
  });

  const tot = macroTotals(rows.map((row) => [row, row.portions]));
  $("shakeDialogKcal").textContent = Math.round(tot.calories);
  $("shakeDialogProtein").textContent = t("demo.grams", { n: Math.round(tot.protein_g) });
  $("shakeDialogCarbs").textContent = t("demo.grams", { n: Math.round(tot.carbs_g) });
  $("shakeDialogFat").textContent = t("demo.grams", { n: Math.round(tot.fat_g) });
  $("shakeDialog").showModal();
}

$("shakeDialogClose").addEventListener("click", () => $("shakeDialog").close());
// A click on the dimmed backdrop (outside the dialog box) closes it too.
$("shakeDialog").addEventListener("click", (ev) => {
  if (ev.target === $("shakeDialog")) $("shakeDialog").close();
});

// ---------- landing demo (a glass that fills as you add servings) ----------
// Fixed copies of six built-in ingredients, so the demo works before the database answers.
// color is the layer's color in the glass.
const DEMO = [
  { id: "whole_milk", calories: 153, protein_g: 8, carbs_g: 12, fat_g: 8, color: "#f7f1e8" },
  { id: "whey_protein", calories: 120, protein_g: 24, carbs_g: 3, fat_g: 2, color: "#e2c9a4" },
  { id: "banana", calories: 105, protein_g: 1.3, carbs_g: 27, fat_g: 0.4, color: "#ffd24a" },
  { id: "oats", calories: 190, protein_g: 6.5, carbs_g: 34, fat_g: 3.5, color: "#d8b47c" },
  { id: "peanut_butter", calories: 188, protein_g: 8, carbs_g: 7, fat_g: 16, color: "#b5733a" },
  { id: "strawberries", calories: 32, protein_g: 0.7, carbs_g: 7.7, fat_g: 0.3, color: "#ff7c98" },
];
const DEMO_SCALE_KCAL = 1200;   // a full glass; the goal line sits at 800 of it
const DEMO_START = ["whole_milk", "banana", "banana", "whey_protein"];
const demoById = Object.fromEntries(DEMO.map((d) => [d.id, d]));
let demoPour = [];   // ingredient ids, bottom layer first

function renderDemoTray() {
  const tray = $("demoTray");
  tray.innerHTML = "";
  DEMO.forEach((d) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "demo-ing";
    b.dataset.id = d.id;
    b.innerHTML = `<span class="demo-swatch" aria-hidden="true"></span><span class="demo-ing-name"></span>` +
      `<span class="demo-ing-kcal"></span><span class="demo-count" aria-hidden="true"></span>`;
    b.querySelector(".demo-swatch").style.background = d.color;
    b.querySelector(".demo-ing-name").textContent = t(`ing.${d.id}`);
    b.querySelector(".demo-ing-kcal").textContent = t("demo.serving", { kcal: d.calories });
    b.setAttribute("aria-label", t("demo.add", { name: t(`ing.${d.id}`) }));
    b.addEventListener("click", () => pourDemo(d.id));
    tray.appendChild(b);
  });
  $("demoGoalMark").textContent = t("demo.goalMark", { goal: SHAKE_GOAL_KCAL });
  renderDemo();
}

function demoTotals() {
  return macroTotals(demoPour.map((id) => [demoById[id], 1]));
}

function renderDemo() {
  const tot = demoTotals();
  $("demoKcal").textContent = Math.round(tot.calories);
  $("demoGoal").textContent = tot.calories >= SHAKE_GOAL_KCAL
    ? t("demo.goalHit")
    : t("demo.of", { goal: SHAKE_GOAL_KCAL });
  $("demoProtein").textContent = t("demo.grams", { n: Math.round(tot.protein_g) });
  $("demoCarbs").textContent = t("demo.grams", { n: Math.round(tot.carbs_g) });
  $("demoFat").textContent = t("demo.grams", { n: Math.round(tot.fat_g) });
  $("demoGoal").classList.toggle("hit", tot.calories >= SHAKE_GOAL_KCAL);
  document.querySelectorAll(".demo-ing").forEach((b) => {
    const n = demoPour.filter((id) => id === b.dataset.id).length;
    b.querySelector(".demo-count").textContent = n ? `×${n}` : "";
    b.disabled = tot.calories + demoById[b.dataset.id].calories > DEMO_SCALE_KCAL;
  });
  const full = DEMO.every((d) => tot.calories + d.calories > DEMO_SCALE_KCAL);
  $("demoFull").hidden = !full;
}

// Adds one layer; it grows from zero height so the pour is visible.
function pourDemo(id) {
  const d = demoById[id];
  if (demoTotals().calories + d.calories > DEMO_SCALE_KCAL) return;
  demoPour.push(id);
  const layer = document.createElement("div");
  layer.className = "glass-layer";
  layer.style.background = d.color;
  $("demoFill").appendChild(layer);
  requestAnimationFrame(() => {
    layer.style.height = `${(d.calories / DEMO_SCALE_KCAL) * 100}%`;
  });
  renderDemo();
}

function emptyDemo() {
  demoPour = [];
  $("demoFill").innerHTML = "";
  renderDemo();
}

// The one animation on load: the starter shake pours in, a serving at a time.
function startDemo() {
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  DEMO_START.forEach((id, i) => {
    if (still) pourDemo(id); else setTimeout(() => pourDemo(id), 300 + i * 380);
  });
}

$("demoEmpty").addEventListener("click", emptyDemo);

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  });
  document.querySelectorAll(".panel").forEach((p) => {
    p.hidden = p.id !== `panel-${name}`;
  });
  setStatus("");
  try { localStorage.setItem(TAB_KEY, name); } catch {}
}

// ---------- taste test (one ingredient at a time) ----------
function firstUnrated() {
  const i = ingredients.findIndex((ing) => !prefs[ing.id]);
  return i === -1 ? ingredients.length : i;
}

function quizProgressText() {
  return ingredients.length
    ? t("quiz.progress", { rated: Object.keys(prefs).length, total: ingredients.length })
    : "";
}

function renderQuiz() {
  const done = quizIndex >= ingredients.length;
  $("quizCard").hidden = done;
  $("quizDone").hidden = !done;
  $("quizProgress").textContent = quizProgressText();
  if (done) return;

  const ing = ingredients[quizIndex];
  setIngIcon($("quizEmoji"), ing.id);
  $("quizName").textContent = ingName(ing);
  $("quizMeta").textContent = `${t(`form.${ing.form}`)} · ${ingredientMeta(ing)}`;
  $("quizCurrent").textContent = prefs[ing.id]
    ? t("quiz.current", { answer: t(prefs[ing.id] === "like" ? "quiz.like" : "quiz.dislike") })
    : t("quiz.notRated");
}

function answerQuiz(status) {
  const ing = ingredients[quizIndex];
  if (!ing) return;
  if (status && !userId) {
    openLogin(t("auth.loginForProfile"));
    return;
  }
  if (status) setPref(ing.id, status);
  quizIndex++;
  renderQuiz();
}

// ---------- my ingredients (full list) ----------
function renderPrefs() {
  const ul = $("prefList");
  ul.innerHTML = "";
  ingredients.forEach((ing) => {
    const li = document.createElement("li");
    li.className = "pref-row";
    li.innerHTML = `<span class="emoji"></span><div class="pref-info"><div class="chip-name"></div><div class="chip-meta"></div></div><div class="seg" role="group"></div>`;
    setIngIcon(li.querySelector(".emoji"), ing.id);
    li.querySelector(".chip-name").textContent = ingName(ing);
    li.querySelector(".chip-meta").textContent = ingredientMeta(ing);
    const seg = li.querySelector(".seg");
    seg.setAttribute("aria-label", t("pref.aria", { name: ingName(ing) }));
    [["like", "pref.like"], ["dont_like", "pref.avoid"], [null, "pref.none"]].forEach(([status, key]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `seg-btn ${status || "none"}`;
      b.textContent = t(key);
      b.setAttribute("aria-pressed", String((prefs[ing.id] || null) === status));
      b.addEventListener("click", () => setPref(ing.id, status));
      seg.appendChild(b);
    });
    ul.appendChild(li);
  });
  $("quizProgress").textContent = quizProgressText();
  renderIngredients();   // likes changed, so the builder's hidden ingredients may have too
}

function setStatus(msg, kind = "") {
  const s = $("status");
  s.textContent = msg;
  s.className = `status ${kind}`;
}

// A shake can only be logged once it has a name.
function updateShakeBtn() {
  const named = $("shakeName").value.trim() !== "";
  $("shakeBtn").disabled = !named;
  $("shakeBtn").title = named ? "" : t("shake.nameRequired");
}

async function addEntry(type) {
  if (!userId) {
    openLogin(t(type === "milkshake" ? "auth.loginForShake" : "auth.loginForFavorites"));
    return;
  }
  if (selected.size === 0) {
    setStatus(t("status.selectFirst"), "error");
    return;
  }
  // Builder display order, with portions: [{ ingredient_id: "banana", portions: 2 }, ...]
  const items = ingredients
    .filter((i) => selected.has(i.id))
    .map((i) => ({ ingredient_id: i.id, portions: selected.get(i.id) }));
  const name = type === "milkshake" ? $("shakeName").value.trim() : null;
  if (type === "milkshake" && !name) {
    setStatus(t("shake.nameRequired"), "error");
    $("shakeName").focus();
    return;
  }

  const buttons = [$("pickBtn"), $("shakeBtn")];
  buttons.forEach((b) => (b.disabled = true));
  setStatus(t("status.saving"));
  try {
    const saved = await saveEntry(type, name, items);
    entries.unshift(saved);
    renderEntries();
    if (type === "milkshake") $("shakeName").value = "";
    const kcal = macroTotals(saved.entry_ingredients.map((row) => [row, row.portions])).calories;
    setStatus(type === "milkshake"
      ? t("status.logged", { name, kcal: Math.round(kcal) })
      : t("status.favSaved"), "ok");
  } catch (err) {
    setStatus(t("error.save", { msg: err.message }), "error");
  } finally {
    $("pickBtn").disabled = false;
    updateShakeBtn();
  }
}

$("pickBtn").addEventListener("click", () => addEntry("favorites"));
$("shakeBtn").addEventListener("click", () => addEntry("milkshake"));
$("shakeName").addEventListener("input", updateShakeBtn);
$("shakeName").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !$("shakeBtn").disabled) addEntry("milkshake");
});
$("quizLike").addEventListener("click", () => answerQuiz("like"));
$("quizDislike").addEventListener("click", () => answerQuiz("dont_like"));
$("quizSkip").addEventListener("click", () => answerQuiz(null));
$("quizRestart").addEventListener("click", () => { quizIndex = 0; renderQuiz(); });
document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
  showTab(tab.dataset.tab);
  setMenu(false);
}));

// Phone menu: the hamburger shows or hides the tabs; picking a tab, Esc or a click elsewhere closes it.
function setMenu(open) {
  document.querySelector(".site-header").classList.toggle("menu-open", open);
  $("menuBtn").setAttribute("aria-expanded", String(open));
}
$("menuBtn").addEventListener("click", () => setMenu($("menuBtn").getAttribute("aria-expanded") !== "true"));
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && $("menuBtn").getAttribute("aria-expanded") === "true") {
    setMenu(false);
    $("menuBtn").focus();
  }
});
document.addEventListener("click", (ev) => {
  if (!ev.target.closest(".site-header")) setMenu(false);
});
document.querySelectorAll(".lang-btn").forEach((b) => b.addEventListener("click", () => setLanguage(b.dataset.lang)));

let savedTab = "shake";
try { savedTab = localStorage.getItem(TAB_KEY) || "shake"; } catch {}
showTab(document.getElementById(`panel-${savedTab}`) ? savedTab : "shake");

// ---------- login dialog ----------
$("loginOpen").addEventListener("click", () => openLogin());
$("registerOpen").addEventListener("click", () => openLogin("", "signup"));
document.querySelectorAll("[data-auth]").forEach((b) => {
  b.addEventListener("click", () => openLogin("", b.dataset.auth));
});
$("authCancel").addEventListener("click", () => $("authDialog").close());
$("showAvoided").addEventListener("click", () => {
  showTab("list");
  window.scrollTo({ top: 0, behavior: "smooth" });
});
$("viewAllShakes").addEventListener("click", () => {
  showTab("history");
  window.scrollTo({ top: 0, behavior: "smooth" });
});
$("authSwitch").addEventListener("click", () => {
  setAuthMode(authMode === "login" ? "signup" : "login");
  $("authUser").focus();
});
$("logoutBtn").addEventListener("click", async () => {
  await db.auth.signOut();
  setStatus(t("status.loggedOut"), "ok");
});

$("authForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const mode = authMode;
  const name = $("authUser").value;
  const password = $("authPass").value;
  $("authSubmit").disabled = true;
  $("authError").textContent = "";
  try {
    await (mode === "signup" ? signUp(name, password) : logIn(name, password));
    $("authForm").reset();
    $("authDialog").close();
    if (mode === "login") setStatus(t("status.welcome"), "ok");
  } catch (err) {
    $("authError").textContent = err.message;
  } finally {
    $("authSubmit").disabled = false;
  }
});

// ---------- add ingredient ----------
$("addForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = Object.fromEntries(new FormData(ev.target));
  const row = {
    name: f.name.trim(), category: f.category, form: f.form, serving_unit: f.serving_unit.trim(),
    serving_amount: Number(f.serving_amount), calories: Number(f.calories),
    protein_g: Number(f.protein_g), carbs_g: Number(f.carbs_g), fat_g: Number(f.fat_g),
  };
  $("addBtn").disabled = true;
  try {
    const added = await addIngredient(row);
    setIngredients([...ingredients, added]);
    renderPrefs();
    renderQuiz();
    ev.target.reset();
    setStatus(t("status.added", { name: added.name }), "ok");
  } catch (err) {
    setStatus(t("error.addIngredient", { msg: err.message }), "error");
  } finally {
    $("addBtn").disabled = false;
  }
});

(async () => {
  // The saved session is read from this browser (no network), so check it first and show
  // the right view straight away; the data for it loads afterwards.
  const { data: { session } } = await db.auth.getSession();
  const user = session?.user && !session.user.is_anonymous ? session.user : null;
  $("landing").hidden = !!user;
  $("dashboard").hidden = !user;
  document.body.classList.toggle("logged-in", !!user);

  // Language next, so everything renders translated; then ingredients, so entries and
  // likes can show names and nutrition.
  await setLanguage(initialLanguage());
  if (!user) startDemo();
  await loadIngredients();
  await applySession(session);
  db.auth.onAuthStateChange((_event, session) => {
    // Supabase advises not awaiting other Supabase calls inside this callback.
    setTimeout(() => applySession(session), 0);
  });
})();
