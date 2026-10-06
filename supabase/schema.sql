-- Run in Supabase: SQL Editor → New query → paste → Run.
-- Re-runnable: it drops and recreates all tables, so existing entries and likes are deleted.
-- Also requires: Authentication → Sign In / Providers → Email → "Confirm email" OFF
-- (the page logs in with username + password, mapped to a placeholder email).

drop table if exists public.ingredient_preferences;
drop table if exists public.entry_ingredients;
drop table if exists public.entries;
drop table if exists public.ingredients;

-- ---------- ingredients (from ing.json, plus ones users add) ----------
create table public.ingredients (
  id             text primary key
                   default 'custom_' || substr(md5(random()::text || clock_timestamp()::text), 1, 10),
  name           text not null check (char_length(btrim(name)) between 1 and 60),
  category       text not null check (category in
                   ('liquid', 'base', 'fruit', 'carbohydrate', 'fat', 'protein', 'extra', 'sweetener', 'flavor')),
  -- physical form, i.e. how it goes into the blender
  form           text not null check (form in
                   ('liquid', 'creamy', 'paste', 'syrup', 'solid', 'powder', 'granular')),
  serving_amount numeric not null check (serving_amount > 0),
  serving_unit   text not null check (char_length(btrim(serving_unit)) between 1 and 20),
  calories       numeric not null check (calories >= 0),
  protein_g      numeric not null check (protein_g >= 0),
  carbs_g        numeric not null check (carbs_g >= 0),
  fat_g          numeric not null check (fat_g >= 0),
  -- null for the built-in ingredients below
  created_by     uuid default auth.uid() references auth.users(id) on delete set null,
  check (serving_amount <= 10000 and calories <= 5000 and protein_g <= 500 and carbs_g <= 500 and fat_g <= 500)
);
create index ingredients_created_by_idx on public.ingredients (created_by);

insert into public.ingredients
  (id, name, category, form, serving_amount, serving_unit, calories, protein_g, carbs_g, fat_g)
values
  ('whole_milk', 'Whole Milk', 'liquid', 'liquid', 250, 'ml', 153, 8, 12, 8),
  ('greek_yogurt', 'Greek Yogurt (Full Fat)', 'base', 'creamy', 150, 'g', 146, 13.5, 5.5, 7.5),
  ('banana', 'Banana', 'fruit', 'solid', 1, 'medium', 105, 1.3, 27, 0.4),
  ('blueberries', 'Blueberries', 'fruit', 'solid', 100, 'g', 57, 0.7, 14.5, 0.3),
  ('strawberries', 'Strawberries', 'fruit', 'solid', 100, 'g', 32, 0.7, 7.7, 0.3),
  ('oats', 'Rolled Oats', 'carbohydrate', 'granular', 50, 'g', 190, 6.5, 34, 3.5),
  ('peanut_butter', 'Peanut Butter', 'fat', 'paste', 2, 'tbsp', 188, 8, 7, 16),
  ('almond_butter', 'Almond Butter', 'fat', 'paste', 2, 'tbsp', 196, 7, 6, 18),
  ('avocado', 'Avocado', 'fat', 'solid', 0.5, 'medium', 120, 1.5, 6.5, 11),
  ('whey_protein', 'Whey Protein', 'protein', 'powder', 1, 'scoop', 120, 24, 3, 2),
  ('chia_seeds', 'Chia Seeds', 'extra', 'granular', 1, 'tbsp', 58, 2, 5, 3.7),
  ('hemp_seeds', 'Hemp Seeds', 'extra', 'granular', 1, 'tbsp', 57, 3.3, 0.9, 4.7),
  ('dates', 'Medjool Dates', 'sweetener', 'solid', 2, 'dates', 133, 0.9, 36, 0.1),
  ('honey', 'Honey', 'sweetener', 'syrup', 1, 'tbsp', 64, 0, 17, 0),
  ('cocoa_powder', 'Unsweetened Cocoa Powder', 'flavor', 'powder', 1, 'tbsp', 12, 1, 3, 0.7);

-- ---------- entries (logged shakes and favorite stacks, private to each user) ----------
create table public.entries (
  id             bigint generated always as identity primary key,
  type           text not null check (type in ('favorites', 'milkshake')),
  name           text check (char_length(name) <= 100),
  created_at     timestamptz not null default now(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade
);
create index entries_user_created_idx on public.entries (user_id, created_at desc);

-- One row per ingredient in an entry, with portions (in halves) and a snapshot of the
-- ingredient's values at save time, so later ingredient edits never change past shakes.
create table public.entry_ingredients (
  id             bigint generated always as identity primary key,
  entry_id       bigint not null references public.entries(id) on delete cascade,
  ingredient_id  text references public.ingredients(id) on delete set null,
  portions       numeric not null check (portions > 0 and portions <= 20 and portions * 2 = trunc(portions * 2)),
  name           text not null,
  serving_amount numeric not null,
  serving_unit   text not null,
  calories       numeric not null,
  protein_g      numeric not null,
  carbs_g        numeric not null,
  fat_g          numeric not null,
  unique (entry_id, ingredient_id)
);
create index entry_ingredients_ingredient_idx on public.entry_ingredients (ingredient_id);

-- Saves an entry and its ingredients in one transaction. Runs as the caller, so RLS applies.
-- p_items: [{"ingredient_id": "banana", "portions": 2}, ...]
create or replace function public.create_entry(p_type text, p_name text, p_items jsonb)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id    bigint;
  v_count int;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 30 then
    raise exception 'A shake needs between 1 and 30 ingredients';
  end if;
  if p_type = 'milkshake' and nullif(btrim(p_name), '') is null then
    raise exception 'A shake needs a name';
  end if;

  insert into public.entries (type, name)
  values (p_type, nullif(btrim(p_name), ''))
  returning id into v_id;

  insert into public.entry_ingredients
    (entry_id, ingredient_id, portions, name, serving_amount, serving_unit, calories, protein_g, carbs_g, fat_g)
  select v_id, i.id, (item ->> 'portions')::numeric,
         i.name, i.serving_amount, i.serving_unit, i.calories, i.protein_g, i.carbs_g, i.fat_g
  from jsonb_array_elements(p_items) as item
  join public.ingredients i on i.id = item ->> 'ingredient_id';

  get diagnostics v_count = row_count;
  if v_count <> jsonb_array_length(p_items) then
    raise exception 'Unknown ingredient in %', p_items;
  end if;

  return v_id;
end;
$$;

grant execute on function public.create_entry(text, text, jsonb) to authenticated;

-- ---------- ingredient preferences (per user) ----------
-- Users log in on the page, so auth.uid() identifies them.
create table public.ingredient_preferences (
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ingredient_id text not null references public.ingredients(id) on delete cascade,
  status        text not null check (status in ('like', 'dont_like')),
  updated_at    timestamptz not null default now(),
  primary key (user_id, ingredient_id)
);
create index ingredient_preferences_ingredient_idx on public.ingredient_preferences (ingredient_id);

-- ---------- access ----------
-- Everyone may read ingredients. Logged-in users may also add ingredients, read + add +
-- delete only their own entries, and manage only their own preferences.
alter table public.ingredients enable row level security;
alter table public.entries enable row level security;
alter table public.entry_ingredients enable row level security;
alter table public.ingredient_preferences enable row level security;

grant select on public.ingredients to anon, authenticated;
-- Column-level grant: clients can't choose an ingredient's id or created_by.
grant insert (name, category, form, serving_amount, serving_unit, calories, protein_g, carbs_g, fat_g)
  on public.ingredients to authenticated;
grant select, insert, delete on public.entries to authenticated;
grant select, insert on public.entry_ingredients to authenticated;
grant select, insert, update, delete on public.ingredient_preferences to authenticated;

create policy "Anyone can read ingredients"
  on public.ingredients for select to anon, authenticated
  using (true);

create policy "Users can add ingredients as themselves"
  on public.ingredients for insert to authenticated
  with check (created_by = (select auth.uid()));

create policy "Users read their own entries"
  on public.entries for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Users add their own entries"
  on public.entries for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "Users delete their own entries"
  on public.entries for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "Users read their own entry ingredients"
  on public.entry_ingredients for select to authenticated
  using (exists (select 1 from public.entries e where e.id = entry_id and e.user_id = (select auth.uid())));

create policy "Users add ingredients to their own entries"
  on public.entry_ingredients for insert to authenticated
  with check (exists (select 1 from public.entries e where e.id = entry_id and e.user_id = (select auth.uid())));

create policy "Visitors read their own preferences"
  on public.ingredient_preferences for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Visitors add their own preferences"
  on public.ingredient_preferences for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "Visitors change their own preferences"
  on public.ingredient_preferences for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "Visitors clear their own preferences"
  on public.ingredient_preferences for delete to authenticated
  using (user_id = (select auth.uid()));
