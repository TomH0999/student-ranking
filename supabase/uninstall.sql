-- =============================================================================
-- Classement BUT1 — désinstallation
--
-- Supprime tout ce que supabase/ranking.sql a ajouté (participants et pseudos compris).
-- La table `items` de l'application, ses politiques et ses données ne sont pas touchées.
-- =============================================================================

drop trigger if exists ranking_items_inserted on public.items;
drop trigger if exists ranking_items_updated on public.items;

drop function if exists public.ranking_snapshot();
drop table if exists public.ranking_profiles;
drop table if exists public.ranking_pulse;
drop function if exists public.ranking_items_changed();
drop function if exists public.ranking_touch();
