-- One-time cleanup for the live database, after the app saves shakes through entry_ingredients.
-- Run in Supabase: SQL Editor → New query → paste → Run.
-- Shakes' ingredients were already copied into public.entry_ingredients; this removes the old
-- ingredient_ids array and its check, which nothing reads or writes any more.

drop trigger if exists entries_check_ingredients on public.entries;
drop function if exists public.check_entry_ingredients();
alter table public.entries drop column if exists ingredient_ids;
