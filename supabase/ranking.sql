-- =============================================================================
-- Classement BUT1 — extension du projet Supabase du gestionnaire de scolarité
--
-- À coller tel quel dans Supabase : SQL Editor → New query → Run.
-- Idempotent : peut être relancé sans risque (aucune donnée supprimée).
--
-- Ce script NE MODIFIE NI la table `items` de l'application, NI ses politiques, NI ses
-- données. Il ajoute :
--   1. public.ranking_profiles  : les participants (une ligne = un étudiant inscrit) ;
--   2. public.ranking_snapshot(): les moyennes de tous les participants, recalculées à
--      partir des notes de l'application avec EXACTEMENT les mêmes formules ;
--   3. public.ranking_pulse     : un compteur diffusé en temps réel, incrémenté dès
--      qu'une note d'un participant change (deux déclencheurs en lecture seule sur `items`).
--
-- Confidentialité : les notes individuelles ne sortent jamais de la base. Seules les
-- moyennes des étudiants INSCRITS au classement sont visibles, et uniquement par les
-- autres inscrits, sous un pseudo (jamais l'adresse e-mail ni l'identifiant du compte).
--
-- Prérequis : le schéma de l'application (table public.items) est déjà installé.
-- Désinstallation : supabase/uninstall.sql.
-- =============================================================================

do $$
begin
    if to_regclass('public.items') is null then
        raise exception 'Table public.items introuvable : installez d''abord le schéma de l''application (supabase/schema.sql du gestionnaire de scolarité).';
    end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 1. Participants
-- -----------------------------------------------------------------------------
create table if not exists public.ranking_profiles (
    user_id      uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
    display_name text,
    joined_at    timestamptz not null default now(),
    constraint ranking_profiles_name_check check (
        display_name is null
        or (
            char_length(display_name) between 2 and 24
            and display_name = btrim(display_name)
            and display_name !~ '[[:cntrl:]]'
            -- « Étudiant XXXX » est réservé aux pseudos automatiques
            and display_name !~* '^(é|e)tudiant'
        )
    )
);

-- Profil étendu (v1.1) : tout est facultatif. Les colonnes sont ajoutées sans toucher aux
-- lignes existantes : un inscrit de la v1.0 garde exactement son affichage.
alter table public.ranking_profiles
    add column if not exists first_name          text,
    add column if not exists last_name           text,
    add column if not exists name_mode           text    not null default 'pseudo',
    add column if not exists student_number      text,
    add column if not exists origin              text,
    add column if not exists class_name          text,
    add column if not exists td_group            text,
    add column if not exists track               text,
    add column if not exists show_origin         boolean not null default true,
    add column if not exists show_class          boolean not null default true,
    add column if not exists show_td_group       boolean not null default true,
    add column if not exists show_track          boolean not null default true,
    add column if not exists show_student_number boolean not null default false,
    add column if not exists show_grades         boolean not null default false;

alter table public.ranking_profiles drop constraint if exists ranking_profiles_details_check;

-- Classes et groupes TD : listes fermées depuis la v1.2. Une valeur saisie librement en
-- v1.1 et absente de la liste est effacée (l'étudiant la choisit de nouveau dans son profil).
update public.ranking_profiles set class_name = null
    where class_name is not null and class_name not in ('S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7');
update public.ranking_profiles set td_group = null
    where td_group is not null and td_group not in ('TD1', 'TD2');

alter table public.ranking_profiles add constraint ranking_profiles_details_check check (
    name_mode in ('pseudo', 'real')
    and (first_name is null or (char_length(first_name) between 1 and 30 and first_name = btrim(first_name) and first_name !~ '[[:cntrl:]]' and first_name !~* '^(é|e)tudiant'))
    and (last_name is null or (char_length(last_name) between 1 and 30 and last_name = btrim(last_name) and last_name !~ '[[:cntrl:]]'))
    and (student_number is null or student_number ~ '^[0-9A-Za-z]{1,20}$')
    and (origin is null or origin in ('general', 'sti2d', 'autre'))
    and (class_name is null or class_name in ('S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'))
    and (td_group is null or td_group in ('TD1', 'TD2'))
    and (track is null or track in ('racdv', 'dacs', 'aged', 'iamsi', 'indecis', 'autre'))
);

comment on table public.ranking_profiles is 'Classement : une ligne par étudiant inscrit (pseudo facultatif). Supprimer la ligne = quitter le classement.';

create unique index if not exists ranking_profiles_name_key on public.ranking_profiles (lower(display_name));

alter table public.ranking_profiles enable row level security;

drop policy if exists ranking_profiles_select_own on public.ranking_profiles;
create policy ranking_profiles_select_own on public.ranking_profiles
    for select to authenticated
    using ((select auth.uid()) = user_id);

drop policy if exists ranking_profiles_insert_own on public.ranking_profiles;
create policy ranking_profiles_insert_own on public.ranking_profiles
    for insert to authenticated
    with check ((select auth.uid()) = user_id);

drop policy if exists ranking_profiles_update_own on public.ranking_profiles;
create policy ranking_profiles_update_own on public.ranking_profiles
    for update to authenticated
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);

drop policy if exists ranking_profiles_delete_own on public.ranking_profiles;
create policy ranking_profiles_delete_own on public.ranking_profiles
    for delete to authenticated
    using ((select auth.uid()) = user_id);

revoke all on table public.ranking_profiles from public;
revoke all on table public.ranking_profiles from anon;
revoke all on table public.ranking_profiles from authenticated;
grant select, insert, delete on table public.ranking_profiles to authenticated;
grant update (
    display_name, first_name, last_name, name_mode, student_number, origin, class_name, td_group, track,
    show_origin, show_class, show_td_group, show_track, show_student_number, show_grades
) on table public.ranking_profiles to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Signal temps réel : une seule ligne, lisible par tout compte connecté.
--    Elle ne contient aucune donnée personnelle : seulement un compteur.
-- -----------------------------------------------------------------------------
create table if not exists public.ranking_pulse (
    id         boolean     primary key default true,
    version    bigint      not null default 0,
    updated_at timestamptz not null default now(),
    constraint ranking_pulse_single_row check (id)
);

comment on table public.ranking_pulse is 'Classement : compteur incrémenté à chaque changement, diffusé par Realtime pour rafraîchir les écrans.';

insert into public.ranking_pulse (id) values (true) on conflict (id) do nothing;

alter table public.ranking_pulse enable row level security;

drop policy if exists ranking_pulse_select_all on public.ranking_pulse;
create policy ranking_pulse_select_all on public.ranking_pulse
    for select to authenticated
    using (true);

revoke all on table public.ranking_pulse from public;
revoke all on table public.ranking_pulse from anon;
revoke all on table public.ranking_pulse from authenticated;
grant select on table public.ranking_pulse to authenticated;

-- Incrémente le compteur. Ne doit JAMAIS faire échouer l'écriture qui l'a déclenché
-- (une note enregistrée par l'application) : toute erreur est ignorée.
create or replace function public.ranking_touch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    begin
        update public.ranking_pulse set version = version + 1, updated_at = clock_timestamp() where id;
    exception when others then
        null;
    end;
    return null;
end;
$$;

-- Notes (ou parcours) modifiés : on ne signale que s'ils appartiennent à un participant.
create or replace function public.ranking_items_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    begin
        if exists (
            select 1
            from changed c
            join public.ranking_profiles p on p.user_id = c.user_id
            where c.collection = 'grades'
               or (c.collection = 'settings' and c.data ->> 'key' = 'parcours')
        ) then
            update public.ranking_pulse set version = version + 1, updated_at = clock_timestamp() where id;
        end if;
    exception when others then
        null;
    end;
    return null;
end;
$$;

revoke all on function public.ranking_touch() from public, anon, authenticated;
revoke all on function public.ranking_items_changed() from public, anon, authenticated;

drop trigger if exists ranking_items_inserted on public.items;
create trigger ranking_items_inserted
    after insert on public.items
    referencing new table as changed
    for each statement execute function public.ranking_items_changed();

drop trigger if exists ranking_items_updated on public.items;
create trigger ranking_items_updated
    after update on public.items
    referencing new table as changed
    for each statement execute function public.ranking_items_changed();

drop trigger if exists ranking_profiles_changed on public.ranking_profiles;
create trigger ranking_profiles_changed
    after insert or update or delete on public.ranking_profiles
    for each statement execute function public.ranking_touch();

do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
       and not exists (
           select 1 from pg_publication_tables
           where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ranking_pulse'
       ) then
        alter publication supabase_realtime add table public.ranking_pulse;
    end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Programme : semestres 1 à 6 (v1.3)
--
-- Une ligne par élément noté de chaque UE : semestre, parcours ('*' = tronc commun),
-- UE, module (coefficient du module) et élément (coefficient). Données publiques du
-- programme, lues uniquement par les fonctions ci-dessous (aucun accès direct).
-- -----------------------------------------------------------------------------
create table if not exists public.ranking_curriculum (
    semester    smallint         not null,
    parcours    text             not null,
    ue          text             not null,
    ue_ord      smallint         not null,
    competence  smallint         not null,
    module_ord  smallint         not null,
    module_coef double precision not null,
    subject     text             not null,
    item_ord    smallint         not null,
    coef        double precision not null,
    primary key (semester, parcours, ue, module_ord, item_ord)
);

comment on table public.ranking_curriculum is 'Classement : programme du BUT Informatique S1-S6 (MCCC de l''IUT), coefficients par UE, module et élément.';

alter table public.ranking_curriculum enable row level security;
revoke all on table public.ranking_curriculum from public;
revoke all on table public.ranking_curriculum from anon;
revoke all on table public.ranking_curriculum from authenticated;

-- BEGIN CURRICULUM (généré par scripts/curriculum-sql.mjs, ne pas modifier à la main)
delete from public.ranking_curriculum;
insert into public.ranking_curriculum (semester, parcours, ue, ue_ord, competence, module_ord, module_coef, subject, item_ord, coef) values
    (1, '*', 'UE 1.1', 1, 1, 1, 100, 'SAE 1.01', 1, 40),
    (1, '*', 'UE 1.1', 1, 1, 1, 100, 'R1.01', 2, 42),
    (1, '*', 'UE 1.1', 1, 1, 1, 100, 'R1.02', 3, 12),
    (1, '*', 'UE 1.1', 1, 1, 1, 100, 'R1.10', 4, 6),
    (1, '*', 'UE 1.2', 2, 2, 1, 100, 'SAE 1.02', 1, 40),
    (1, '*', 'UE 1.2', 2, 2, 1, 100, 'R1.01', 2, 24),
    (1, '*', 'UE 1.2', 2, 2, 1, 100, 'R1.03', 3, 3),
    (1, '*', 'UE 1.2', 2, 2, 1, 100, 'R1.04', 4, 3),
    (1, '*', 'UE 1.2', 2, 2, 1, 100, 'R1.06', 5, 15),
    (1, '*', 'UE 1.2', 2, 2, 1, 100, 'R1.07', 6, 15),
    (1, '*', 'UE 1.3', 3, 3, 1, 100, 'SAE 1.03', 1, 40),
    (1, '*', 'UE 1.3', 3, 3, 1, 100, 'R1.03', 2, 21),
    (1, '*', 'UE 1.3', 3, 3, 1, 100, 'R1.04', 3, 21),
    (1, '*', 'UE 1.3', 3, 3, 1, 100, 'R1.10', 4, 12),
    (1, '*', 'UE 1.3', 3, 3, 1, 100, 'R1.11', 5, 6),
    (1, '*', 'UE 1.4', 4, 4, 1, 100, 'SAE 1.04', 1, 40),
    (1, '*', 'UE 1.4', 4, 4, 1, 100, 'R1.05', 2, 36),
    (1, '*', 'UE 1.4', 4, 4, 1, 100, 'R1.06', 3, 18),
    (1, '*', 'UE 1.4', 4, 4, 1, 100, 'R1.09', 4, 6),
    (1, '*', 'UE 1.5', 5, 5, 1, 100, 'SAE 1.05', 1, 40),
    (1, '*', 'UE 1.5', 5, 5, 1, 100, 'R1.02', 2, 18),
    (1, '*', 'UE 1.5', 5, 5, 1, 100, 'R1.08', 3, 27),
    (1, '*', 'UE 1.5', 5, 5, 1, 100, 'R1.11', 4, 15),
    (1, '*', 'UE 1.6', 6, 6, 1, 100, 'SAE 1.06', 1, 40),
    (1, '*', 'UE 1.6', 6, 6, 1, 100, 'R1.02', 2, 5),
    (1, '*', 'UE 1.6', 6, 6, 1, 100, 'R1.08', 3, 11),
    (1, '*', 'UE 1.6', 6, 6, 1, 100, 'R1.09', 4, 11),
    (1, '*', 'UE 1.6', 6, 6, 1, 100, 'R1.10', 5, 11),
    (1, '*', 'UE 1.6', 6, 6, 1, 100, 'R1.11', 6, 11),
    (1, '*', 'UE 1.6', 6, 6, 1, 100, 'R1.12', 7, 11),
    (2, '*', 'UE 2.1', 1, 1, 1, 40, 'SAE 2.01', 1, 38),
    (2, '*', 'UE 2.1', 1, 1, 2, 60, 'R2.02', 1, 21),
    (2, '*', 'UE 2.1', 1, 1, 2, 60, 'R2.03', 2, 12),
    (2, '*', 'UE 2.1', 1, 1, 2, 60, 'R2.01', 3, 21),
    (2, '*', 'UE 2.1', 1, 1, 2, 60, 'R2.13', 4, 6),
    (2, '*', 'UE 2.2', 2, 2, 1, 40, 'SAE 2.02', 1, 38),
    (2, '*', 'UE 2.2', 2, 2, 2, 60, 'R2.07', 1, 21),
    (2, '*', 'UE 2.2', 2, 2, 2, 60, 'R2.04', 2, 12),
    (2, '*', 'UE 2.2', 2, 2, 2, 60, 'R2.01', 3, 15),
    (2, '*', 'UE 2.2', 2, 2, 2, 60, 'R2.09', 4, 12),
    (2, '*', 'UE 2.3', 3, 3, 1, 40, 'SAE 2.03', 1, 38),
    (2, '*', 'UE 2.3', 3, 3, 2, 60, 'R2.12', 1, 6),
    (2, '*', 'UE 2.3', 3, 3, 2, 60, 'R2.05', 2, 15),
    (2, '*', 'UE 2.3', 3, 3, 2, 60, 'R2.04', 3, 36),
    (2, '*', 'UE 2.3', 3, 3, 2, 60, 'R2.13', 4, 3),
    (2, '*', 'UE 2.4', 4, 4, 1, 40, 'SAE 2.04', 1, 38),
    (2, '*', 'UE 2.4', 4, 4, 2, 60, 'R2.12', 1, 6),
    (2, '*', 'UE 2.4', 4, 4, 2, 60, 'R2.08', 2, 12),
    (2, '*', 'UE 2.4', 4, 4, 2, 60, 'R2.06', 3, 30),
    (2, '*', 'UE 2.4', 4, 4, 2, 60, 'R2.10', 4, 12),
    (2, '*', 'UE 2.5', 5, 5, 1, 40, 'SAE 2.05', 1, 38),
    (2, '*', 'UE 2.5', 5, 5, 2, 60, 'R2.02', 1, 3),
    (2, '*', 'UE 2.5', 5, 5, 2, 60, 'R2.07', 2, 6),
    (2, '*', 'UE 2.5', 5, 5, 2, 60, 'R2.12', 3, 6),
    (2, '*', 'UE 2.5', 5, 5, 2, 60, 'R2.03', 4, 6),
    (2, '*', 'UE 2.5', 5, 5, 2, 60, 'R2.10', 5, 30),
    (2, '*', 'UE 2.5', 5, 5, 2, 60, 'R2.13', 6, 9),
    (2, '*', 'UE 2.6', 6, 6, 1, 40, 'SAE 2.06', 1, 38),
    (2, '*', 'UE 2.6', 6, 6, 2, 60, 'R2.02', 1, 4),
    (2, '*', 'UE 2.6', 6, 6, 2, 60, 'R2.12', 2, 17),
    (2, '*', 'UE 2.6', 6, 6, 2, 60, 'R2.14', 3, 11),
    (2, '*', 'UE 2.6', 6, 6, 2, 60, 'R2.11', 4, 17),
    (2, '*', 'UE 2.6', 6, 6, 2, 60, 'R2.13', 5, 11),
    (3, '*', 'UE 3.1', 1, 1, 1, 40, 'SAE 3', 1, 40),
    (3, '*', 'UE 3.1', 1, 1, 2, 60, 'R3.02', 1, 10),
    (3, '*', 'UE 3.1', 1, 1, 2, 60, 'R3.04', 2, 15),
    (3, '*', 'UE 3.1', 1, 1, 2, 60, 'R3.11', 3, 8),
    (3, '*', 'UE 3.1', 1, 1, 2, 60, 'R3.01', 4, 15),
    (3, '*', 'UE 3.1', 1, 1, 2, 60, 'R3.03', 5, 12),
    (3, '*', 'UE 3.2', 2, 2, 1, 40, 'SAE 3', 1, 40),
    (3, '*', 'UE 3.2', 2, 2, 2, 60, 'R3.02', 1, 13),
    (3, '*', 'UE 3.2', 2, 2, 2, 60, 'R3.06', 2, 5),
    (3, '*', 'UE 3.2', 2, 2, 2, 60, 'R3.09', 3, 10),
    (3, '*', 'UE 3.2', 2, 2, 2, 60, 'R3.01', 4, 5),
    (3, '*', 'UE 3.2', 2, 2, 2, 60, 'R3.08', 5, 17),
    (3, '*', 'UE 3.2', 2, 2, 2, 60, 'R3.03', 6, 5),
    (3, '*', 'UE 3.2', 2, 2, 2, 60, 'R3.12', 7, 5),
    (3, '*', 'UE 3.3', 3, 3, 1, 40, 'SAE 3', 1, 40),
    (3, '*', 'UE 3.3', 3, 3, 2, 60, 'R3.06', 1, 18),
    (3, '*', 'UE 3.3', 3, 3, 2, 60, 'R3.09', 2, 10),
    (3, '*', 'UE 3.3', 3, 3, 2, 60, 'R3.01', 3, 5),
    (3, '*', 'UE 3.3', 3, 3, 2, 60, 'R3.05', 4, 22),
    (3, '*', 'UE 3.3', 3, 3, 2, 60, 'R3.12', 5, 5),
    (3, '*', 'UE 3.4', 4, 4, 1, 40, 'SAE 3', 1, 40),
    (3, '*', 'UE 3.4', 4, 4, 2, 60, 'R3.10', 1, 10),
    (3, '*', 'UE 3.4', 4, 4, 2, 60, 'R3.11', 2, 5),
    (3, '*', 'UE 3.4', 4, 4, 2, 60, 'R3.09', 3, 5),
    (3, '*', 'UE 3.4', 4, 4, 2, 60, 'R3.01', 4, 10),
    (3, '*', 'UE 3.4', 4, 4, 2, 60, 'R3.08', 5, 5),
    (3, '*', 'UE 3.4', 4, 4, 2, 60, 'R3.07', 6, 25),
    (3, '*', 'UE 3.5', 5, 5, 1, 40, 'SAE 3', 1, 40),
    (3, '*', 'UE 3.5', 5, 5, 2, 60, 'R3.10', 1, 18),
    (3, '*', 'UE 3.5', 5, 5, 2, 60, 'R3.04', 2, 8),
    (3, '*', 'UE 3.5', 5, 5, 2, 60, 'R3.11', 3, 10),
    (3, '*', 'UE 3.5', 5, 5, 2, 60, 'R3.13', 4, 7),
    (3, '*', 'UE 3.5', 5, 5, 2, 60, 'R3.03', 5, 10),
    (3, '*', 'UE 3.5', 5, 5, 2, 60, 'R3.12', 6, 7),
    (3, '*', 'UE 3.6', 6, 6, 1, 40, 'SAE 3', 1, 40),
    (3, '*', 'UE 3.6', 6, 6, 2, 60, 'R3.10', 1, 16),
    (3, '*', 'UE 3.6', 6, 6, 2, 60, 'R3.04', 2, 5),
    (3, '*', 'UE 3.6', 6, 6, 2, 60, 'R3.13', 3, 16),
    (3, '*', 'UE 3.6', 6, 6, 2, 60, 'R3.14', 4, 15),
    (3, '*', 'UE 3.6', 6, 6, 2, 60, 'R3.12', 5, 8),
    (4, 'RACDV', 'UE 4.1', 1, 1, 1, 60, 'Stage S4', 1, 30),
    (4, 'RACDV', 'UE 4.1', 1, 1, 1, 60, 'Portfolio S4', 2, 5),
    (4, 'RACDV', 'UE 4.1', 1, 1, 1, 60, 'SAE 4.A', 3, 15),
    (4, 'RACDV', 'UE 4.1', 1, 1, 2, 40, 'R4.01', 1, 20),
    (4, 'RACDV', 'UE 4.1', 1, 1, 2, 40, 'R4.02', 2, 10),
    (4, 'RACDV', 'UE 4.1', 1, 1, 2, 40, 'R4.A.11', 3, 10),
    (4, 'RACDV', 'UE 4.1', 1, 1, 2, 40, 'R4.A.10', 4, 10),
    (4, 'RACDV', 'UE 4.2', 2, 2, 1, 60, 'Stage S4', 1, 30),
    (4, 'RACDV', 'UE 4.2', 2, 2, 1, 60, 'Portfolio S4', 2, 5),
    (4, 'RACDV', 'UE 4.2', 2, 2, 1, 60, 'SAE 4.A', 3, 15),
    (4, 'RACDV', 'UE 4.2', 2, 2, 2, 40, 'R4.05', 1, 5),
    (4, 'RACDV', 'UE 4.2', 2, 2, 2, 40, 'R4.A.09', 2, 5),
    (4, 'RACDV', 'UE 4.2', 2, 2, 2, 40, 'R4.A.11', 3, 6),
    (4, 'RACDV', 'UE 4.2', 2, 2, 2, 40, 'R4.A.12', 4, 14),
    (4, 'RACDV', 'UE 4.2', 2, 2, 2, 40, 'R4.A.10', 5, 6),
    (4, 'RACDV', 'UE 4.2', 2, 2, 2, 40, 'R4.04', 6, 14),
    (4, 'RACDV', 'UE 4.3', 3, 3, 1, 60, 'Stage S4', 1, 30),
    (4, 'RACDV', 'UE 4.3', 3, 3, 1, 60, 'Portfolio S4', 2, 5),
    (4, 'RACDV', 'UE 4.3', 3, 3, 1, 60, 'SAE 4.A', 3, 15),
    (4, 'RACDV', 'UE 4.3', 3, 3, 2, 40, 'R4.01', 1, 16),
    (4, 'RACDV', 'UE 4.3', 3, 3, 2, 40, 'R4.A.08', 2, 34),
    (4, 'RACDV', 'UE 4.4', 4, 4, 1, 60, 'Stage S4', 1, 30),
    (4, 'RACDV', 'UE 4.4', 4, 4, 1, 60, 'Portfolio S4', 2, 5),
    (4, 'RACDV', 'UE 4.4', 4, 4, 1, 60, 'SAE 4.A', 3, 15),
    (4, 'RACDV', 'UE 4.4', 4, 4, 2, 40, 'R4.06', 1, 7),
    (4, 'RACDV', 'UE 4.4', 4, 4, 2, 40, 'R4.03', 2, 23),
    (4, 'RACDV', 'UE 4.4', 4, 4, 2, 40, 'R4.A.11', 3, 10),
    (4, 'RACDV', 'UE 4.4', 4, 4, 2, 40, 'R4.A.10', 4, 10),
    (4, 'RACDV', 'UE 4.5', 5, 5, 1, 60, 'Stage S4', 1, 30),
    (4, 'RACDV', 'UE 4.5', 5, 5, 1, 60, 'Portfolio S4', 2, 5),
    (4, 'RACDV', 'UE 4.5', 5, 5, 1, 60, 'SAE 4.A', 3, 15),
    (4, 'RACDV', 'UE 4.5', 5, 5, 2, 40, 'R4.A.09', 1, 27),
    (4, 'RACDV', 'UE 4.5', 5, 5, 2, 40, 'R4.02', 2, 13),
    (4, 'RACDV', 'UE 4.5', 5, 5, 2, 40, 'R4.A.11', 3, 5),
    (4, 'RACDV', 'UE 4.5', 5, 5, 2, 40, 'R4.A.10', 4, 5),
    (4, 'RACDV', 'UE 4.6', 6, 6, 1, 60, 'Stage S4', 1, 30),
    (4, 'RACDV', 'UE 4.6', 6, 6, 1, 60, 'Portfolio S4', 2, 5),
    (4, 'RACDV', 'UE 4.6', 6, 6, 1, 60, 'SAE 4.A', 3, 15),
    (4, 'RACDV', 'UE 4.6', 6, 6, 2, 40, 'R4.05', 1, 16),
    (4, 'RACDV', 'UE 4.6', 6, 6, 2, 40, 'R4.06', 2, 16),
    (4, 'RACDV', 'UE 4.6', 6, 6, 2, 40, 'R4.07', 3, 13),
    (4, 'RACDV', 'UE 4.6', 6, 6, 2, 40, 'R4.01', 4, 5),
    (4, 'DACS', 'UE 4.1', 1, 1, 1, 60, 'Stage S4', 1, 30),
    (4, 'DACS', 'UE 4.1', 1, 1, 1, 60, 'Portfolio S4', 2, 5),
    (4, 'DACS', 'UE 4.1', 1, 1, 1, 60, 'SAE 4.B', 3, 15),
    (4, 'DACS', 'UE 4.1', 1, 1, 2, 40, 'R4.01', 1, 32),
    (4, 'DACS', 'UE 4.1', 1, 1, 2, 40, 'R4.02', 2, 18),
    (4, 'DACS', 'UE 4.2', 2, 2, 1, 60, 'Stage S4', 1, 30),
    (4, 'DACS', 'UE 4.2', 2, 2, 1, 60, 'Portfolio S4', 2, 5),
    (4, 'DACS', 'UE 4.2', 2, 2, 1, 60, 'SAE 4.B', 3, 15),
    (4, 'DACS', 'UE 4.2', 2, 2, 2, 40, 'R4.05', 1, 6),
    (4, 'DACS', 'UE 4.2', 2, 2, 2, 40, 'R4.B.10', 2, 14),
    (4, 'DACS', 'UE 4.2', 2, 2, 2, 40, 'R4.04', 3, 21),
    (4, 'DACS', 'UE 4.2', 2, 2, 2, 40, 'R4.B.09', 4, 9),
    (4, 'DACS', 'UE 4.3', 3, 3, 1, 60, 'Stage S4', 1, 30),
    (4, 'DACS', 'UE 4.3', 3, 3, 1, 60, 'Portfolio S4', 2, 5),
    (4, 'DACS', 'UE 4.3', 3, 3, 1, 60, 'SAE 4.B', 3, 15),
    (4, 'DACS', 'UE 4.3', 3, 3, 2, 40, 'R4.01', 1, 6),
    (4, 'DACS', 'UE 4.3', 3, 3, 2, 40, 'R4.B.11', 2, 13),
    (4, 'DACS', 'UE 4.3', 3, 3, 2, 40, 'R4.B.08', 3, 12),
    (4, 'DACS', 'UE 4.3', 3, 3, 2, 40, 'R4.B.10', 4, 6),
    (4, 'DACS', 'UE 4.3', 3, 3, 2, 40, 'R4.B.12', 5, 13),
    (4, 'DACS', 'UE 4.4', 4, 4, 1, 60, 'Stage S4', 1, 30),
    (4, 'DACS', 'UE 4.4', 4, 4, 1, 60, 'Portfolio S4', 2, 5),
    (4, 'DACS', 'UE 4.4', 4, 4, 1, 60, 'SAE 4.B', 3, 15),
    (4, 'DACS', 'UE 4.4', 4, 4, 2, 40, 'R4.06', 1, 9),
    (4, 'DACS', 'UE 4.4', 4, 4, 2, 40, 'R4.03', 2, 31),
    (4, 'DACS', 'UE 4.4', 4, 4, 2, 40, 'R4.B.10', 3, 10),
    (4, 'DACS', 'UE 4.5', 5, 5, 1, 60, 'Stage S4', 1, 30),
    (4, 'DACS', 'UE 4.5', 5, 5, 1, 60, 'Portfolio S4', 2, 5),
    (4, 'DACS', 'UE 4.5', 5, 5, 1, 60, 'SAE 4.B', 3, 15),
    (4, 'DACS', 'UE 4.5', 5, 5, 2, 40, 'R4.02', 1, 18),
    (4, 'DACS', 'UE 4.5', 5, 5, 2, 40, 'R4.B.09', 2, 32),
    (4, 'DACS', 'UE 4.6', 6, 6, 1, 60, 'Stage S4', 1, 30),
    (4, 'DACS', 'UE 4.6', 6, 6, 1, 60, 'Portfolio S4', 2, 5),
    (4, 'DACS', 'UE 4.6', 6, 6, 1, 60, 'SAE 4.B', 3, 15),
    (4, 'DACS', 'UE 4.6', 6, 6, 2, 40, 'R4.01', 1, 5),
    (4, 'DACS', 'UE 4.6', 6, 6, 2, 40, 'R4.06', 2, 16),
    (4, 'DACS', 'UE 4.6', 6, 6, 2, 40, 'R4.07', 3, 13),
    (4, 'DACS', 'UE 4.6', 6, 6, 2, 40, 'R4.05', 4, 16),
    (4, 'IAMSI', 'UE 4.1', 1, 1, 1, 50, 'Portfolio S4', 1, 5),
    (4, 'IAMSI', 'UE 4.1', 1, 1, 1, 50, 'Stage S4', 2, 30),
    (4, 'IAMSI', 'UE 4.1', 1, 1, 1, 50, 'SAE 4.D', 3, 15),
    (4, 'IAMSI', 'UE 4.1', 1, 1, 2, 50, 'R4.02', 1, 22),
    (4, 'IAMSI', 'UE 4.1', 1, 1, 2, 50, 'R4.01', 2, 28),
    (4, 'IAMSI', 'UE 4.2', 2, 2, 1, 50, 'Portfolio S4', 1, 5),
    (4, 'IAMSI', 'UE 4.2', 2, 2, 1, 50, 'Stage S4', 2, 30),
    (4, 'IAMSI', 'UE 4.2', 2, 2, 1, 50, 'SAE 4.D', 3, 15),
    (4, 'IAMSI', 'UE 4.2', 2, 2, 2, 50, 'R4.05', 1, 6),
    (4, 'IAMSI', 'UE 4.2', 2, 2, 2, 50, 'R4.D.10', 2, 6),
    (4, 'IAMSI', 'UE 4.2', 2, 2, 2, 50, 'R4.04', 3, 23),
    (4, 'IAMSI', 'UE 4.2', 2, 2, 2, 50, 'R4.D.09', 4, 15),
    (4, 'IAMSI', 'UE 4.3', 3, 3, 1, 50, 'Portfolio S4', 1, 5),
    (4, 'IAMSI', 'UE 4.3', 3, 3, 1, 50, 'Stage S4', 2, 30),
    (4, 'IAMSI', 'UE 4.3', 3, 3, 1, 50, 'SAE 4.D', 3, 15),
    (4, 'IAMSI', 'UE 4.3', 3, 3, 2, 50, 'R4.01', 1, 18),
    (4, 'IAMSI', 'UE 4.3', 3, 3, 2, 50, 'R4.D.08', 2, 32),
    (4, 'IAMSI', 'UE 4.4', 4, 4, 1, 50, 'Portfolio S4', 1, 5),
    (4, 'IAMSI', 'UE 4.4', 4, 4, 1, 50, 'Stage S4', 2, 30),
    (4, 'IAMSI', 'UE 4.4', 4, 4, 1, 50, 'SAE 4.D', 3, 15),
    (4, 'IAMSI', 'UE 4.4', 4, 4, 2, 50, 'R4.03', 1, 27),
    (4, 'IAMSI', 'UE 4.4', 4, 4, 2, 50, 'R4.06', 2, 7),
    (4, 'IAMSI', 'UE 4.4', 4, 4, 2, 50, 'R4.D.10', 3, 16),
    (4, 'IAMSI', 'UE 4.5', 5, 5, 1, 50, 'Portfolio S4', 1, 5),
    (4, 'IAMSI', 'UE 4.5', 5, 5, 1, 50, 'Stage S4', 2, 30),
    (4, 'IAMSI', 'UE 4.5', 5, 5, 1, 50, 'SAE 4.D', 3, 15),
    (4, 'IAMSI', 'UE 4.5', 5, 5, 2, 50, 'R4.02', 1, 6),
    (4, 'IAMSI', 'UE 4.5', 5, 5, 2, 50, 'R4.D.10', 2, 35),
    (4, 'IAMSI', 'UE 4.5', 5, 5, 2, 50, 'R4.D.09', 3, 9),
    (4, 'IAMSI', 'UE 4.6', 6, 6, 1, 50, 'Portfolio S4', 1, 5),
    (4, 'IAMSI', 'UE 4.6', 6, 6, 1, 50, 'Stage S4', 2, 30),
    (4, 'IAMSI', 'UE 4.6', 6, 6, 1, 50, 'SAE 4.D', 3, 15),
    (4, 'IAMSI', 'UE 4.6', 6, 6, 2, 50, 'R4.05', 1, 16),
    (4, 'IAMSI', 'UE 4.6', 6, 6, 2, 50, 'R4.07', 2, 13),
    (4, 'IAMSI', 'UE 4.6', 6, 6, 2, 50, 'R4.01', 3, 5),
    (4, 'IAMSI', 'UE 4.6', 6, 6, 2, 50, 'R4.06', 4, 16),
    (5, 'RACDV', 'UE 5.1', 1, 1, 1, 40, 'SAE 5.A', 1, 40),
    (5, 'RACDV', 'UE 5.1', 1, 1, 2, 60, 'R5.A.08', 1, 8),
    (5, 'RACDV', 'UE 5.1', 1, 1, 2, 60, 'R5.A.04', 2, 3),
    (5, 'RACDV', 'UE 5.1', 1, 1, 2, 60, 'R5.A.13', 3, 3),
    (5, 'RACDV', 'UE 5.1', 1, 1, 2, 60, 'R5.A.10', 4, 14),
    (5, 'RACDV', 'UE 5.1', 1, 1, 2, 60, 'R5.A.07', 5, 8),
    (5, 'RACDV', 'UE 5.1', 1, 1, 2, 60, 'R5.A.09', 6, 8),
    (5, 'RACDV', 'UE 5.1', 1, 1, 2, 60, 'R5.A.06', 7, 3),
    (5, 'RACDV', 'UE 5.1', 1, 1, 2, 60, 'R5.A.14', 8, 3),
    (5, 'RACDV', 'UE 5.1', 1, 1, 2, 60, 'R5.A.05', 9, 10),
    (5, 'RACDV', 'UE 5.2', 2, 2, 1, 40, 'SAE 5.A', 1, 40),
    (5, 'RACDV', 'UE 5.2', 2, 2, 2, 60, 'R5.A.08', 1, 6),
    (5, 'RACDV', 'UE 5.2', 2, 2, 2, 60, 'R5.A.12', 2, 15),
    (5, 'RACDV', 'UE 5.2', 2, 2, 2, 60, 'R5.A.04', 3, 7),
    (5, 'RACDV', 'UE 5.2', 2, 2, 2, 60, 'R5.A.11', 4, 8),
    (5, 'RACDV', 'UE 5.2', 2, 2, 2, 60, 'R5.A.10', 5, 5),
    (5, 'RACDV', 'UE 5.2', 2, 2, 2, 60, 'R5.A.09', 6, 3),
    (5, 'RACDV', 'UE 5.2', 2, 2, 2, 60, 'R5.A.06', 7, 3),
    (5, 'RACDV', 'UE 5.2', 2, 2, 2, 60, 'R5.A.14', 8, 5),
    (5, 'RACDV', 'UE 5.2', 2, 2, 2, 60, 'R5.A.05', 9, 8),
    (5, 'RACDV', 'UE 5.6', 3, 6, 1, 40, 'SAE 5.A', 1, 40),
    (5, 'RACDV', 'UE 5.6', 3, 6, 2, 60, 'R5.02', 1, 7),
    (5, 'RACDV', 'UE 5.6', 3, 6, 2, 60, 'R5.A.13', 2, 6),
    (5, 'RACDV', 'UE 5.6', 3, 6, 2, 60, 'R5.A.07', 3, 3),
    (5, 'RACDV', 'UE 5.6', 3, 6, 2, 60, 'R5.01', 4, 11),
    (5, 'RACDV', 'UE 5.6', 3, 6, 2, 60, 'R5.A.06', 5, 3),
    (5, 'RACDV', 'UE 5.6', 3, 6, 2, 60, 'R5.03', 6, 15),
    (5, 'RACDV', 'UE 5.6', 3, 6, 2, 60, 'R5.A.14', 7, 15),
    (5, 'DACS', 'UE 5.1', 1, 1, 1, 50, 'SAE 5.B', 1, 50),
    (5, 'DACS', 'UE 5.1', 1, 1, 2, 50, 'R5.B.04', 1, 12),
    (5, 'DACS', 'UE 5.1', 1, 1, 2, 50, 'R5.B.07', 2, 12),
    (5, 'DACS', 'UE 5.1', 1, 1, 2, 50, 'R5.B.06', 3, 12),
    (5, 'DACS', 'UE 5.1', 1, 1, 2, 50, 'R5.B.05', 4, 14),
    (5, 'DACS', 'UE 5.1', 1, 1, 2, 50, 'R5.B.12', 5, 10),
    (5, 'DACS', 'UE 5.3', 2, 3, 1, 40, 'SAE 5.B', 1, 40),
    (5, 'DACS', 'UE 5.3', 2, 3, 2, 60, 'R5.B.10', 1, 8),
    (5, 'DACS', 'UE 5.3', 2, 3, 2, 60, 'R5.B.04', 2, 3),
    (5, 'DACS', 'UE 5.3', 2, 3, 2, 60, 'R5.B.07', 3, 5),
    (5, 'DACS', 'UE 5.3', 2, 3, 2, 60, 'R5.B.11', 4, 3),
    (5, 'DACS', 'UE 5.3', 2, 3, 2, 60, 'R5.B.06', 5, 12),
    (5, 'DACS', 'UE 5.3', 2, 3, 2, 60, 'R5.B.08', 6, 15),
    (5, 'DACS', 'UE 5.3', 2, 3, 2, 60, 'R5.B.09', 7, 11),
    (5, 'DACS', 'UE 5.3', 2, 3, 2, 60, 'R5.B.12', 8, 3),
    (5, 'DACS', 'UE 5.6', 3, 6, 1, 40, 'SAE 5.B', 1, 40),
    (5, 'DACS', 'UE 5.6', 3, 6, 2, 60, 'R5.02', 1, 7),
    (5, 'DACS', 'UE 5.6', 3, 6, 2, 60, 'R5.B.11', 2, 7),
    (5, 'DACS', 'UE 5.6', 3, 6, 2, 60, 'R5.01', 3, 10),
    (5, 'DACS', 'UE 5.6', 3, 6, 2, 60, 'R5.03', 4, 18),
    (5, 'DACS', 'UE 5.6', 3, 6, 2, 60, 'R5.B.05', 5, 4),
    (5, 'DACS', 'UE 5.6', 3, 6, 2, 60, 'R5.B.12', 6, 14),
    (5, 'IAMSI', 'UE 5.1', 1, 1, 1, 40, 'SAE 5.D', 1, 40),
    (5, 'IAMSI', 'UE 5.1', 1, 1, 2, 60, 'R5.D.08', 1, 12),
    (5, 'IAMSI', 'UE 5.1', 1, 1, 2, 60, 'R5.D.12', 2, 6),
    (5, 'IAMSI', 'UE 5.1', 1, 1, 2, 60, 'R5.D.05', 3, 12),
    (5, 'IAMSI', 'UE 5.1', 1, 1, 2, 60, 'R5.D.04', 4, 18),
    (5, 'IAMSI', 'UE 5.1', 1, 1, 2, 60, 'R5.D.07', 5, 12),
    (5, 'IAMSI', 'UE 5.5', 2, 5, 1, 40, 'SAE 5.D', 1, 40),
    (5, 'IAMSI', 'UE 5.5', 2, 5, 2, 60, 'R5.D.12', 1, 5),
    (5, 'IAMSI', 'UE 5.5', 2, 5, 2, 60, 'R5.D.05', 2, 9),
    (5, 'IAMSI', 'UE 5.5', 2, 5, 2, 60, 'R5.D.11', 3, 17),
    (5, 'IAMSI', 'UE 5.5', 2, 5, 2, 60, 'R5.D.04', 4, 6),
    (5, 'IAMSI', 'UE 5.5', 2, 5, 2, 60, 'R5.D.06', 5, 6),
    (5, 'IAMSI', 'UE 5.5', 2, 5, 2, 60, 'R5.D.07', 6, 4),
    (5, 'IAMSI', 'UE 5.5', 2, 5, 2, 60, 'R5.D.09', 7, 7),
    (5, 'IAMSI', 'UE 5.5', 2, 5, 2, 60, 'R5.D.10', 8, 6),
    (5, 'IAMSI', 'UE 5.6', 3, 6, 1, 40, 'SAE 5.D', 1, 40),
    (5, 'IAMSI', 'UE 5.6', 3, 6, 2, 60, 'R5.02', 1, 7),
    (5, 'IAMSI', 'UE 5.6', 3, 6, 2, 60, 'R5.D.12', 2, 13),
    (5, 'IAMSI', 'UE 5.6', 3, 6, 2, 60, 'R5.D.11', 3, 6),
    (5, 'IAMSI', 'UE 5.6', 3, 6, 2, 60, 'R5.D.04', 4, 4),
    (5, 'IAMSI', 'UE 5.6', 3, 6, 2, 60, 'R5.D.10', 5, 4),
    (5, 'IAMSI', 'UE 5.6', 3, 6, 2, 60, 'R5.01', 6, 4),
    (5, 'IAMSI', 'UE 5.6', 3, 6, 2, 60, 'R5.03', 7, 17),
    (6, 'RACDV', 'UE 6.1', 1, 1, 1, 60, 'Portfolio S6', 1, 5),
    (6, 'RACDV', 'UE 6.1', 1, 1, 1, 60, 'SAE 6.A', 2, 10),
    (6, 'RACDV', 'UE 6.1', 1, 1, 1, 60, 'Stage S6', 3, 45),
    (6, 'RACDV', 'UE 6.1', 1, 1, 2, 40, 'R6.A.05', 1, 22),
    (6, 'RACDV', 'UE 6.1', 1, 1, 2, 40, 'R6.A.06', 2, 18),
    (6, 'RACDV', 'UE 6.2', 2, 2, 1, 60, 'Portfolio S6', 1, 5),
    (6, 'RACDV', 'UE 6.2', 2, 2, 1, 60, 'SAE 6.A', 2, 10),
    (6, 'RACDV', 'UE 6.2', 2, 2, 1, 60, 'Stage S6', 3, 45),
    (6, 'RACDV', 'UE 6.2', 2, 2, 2, 40, 'R6.A.05', 1, 22),
    (6, 'RACDV', 'UE 6.2', 2, 2, 2, 40, 'R6.A.06', 2, 18),
    (6, 'RACDV', 'UE 6.6', 3, 6, 1, 60, 'Portfolio S6', 1, 5),
    (6, 'RACDV', 'UE 6.6', 3, 6, 1, 60, 'SAE 6.A', 2, 10),
    (6, 'RACDV', 'UE 6.6', 3, 6, 1, 60, 'Stage S6', 3, 45),
    (6, 'RACDV', 'UE 6.6', 3, 6, 2, 40, 'R6.03', 1, 7),
    (6, 'RACDV', 'UE 6.6', 3, 6, 2, 40, 'R6.A.05', 2, 2),
    (6, 'RACDV', 'UE 6.6', 3, 6, 2, 40, 'R6.01', 3, 12),
    (6, 'RACDV', 'UE 6.6', 3, 6, 2, 40, 'R6.04', 4, 8),
    (6, 'RACDV', 'UE 6.6', 3, 6, 2, 40, 'R6.02', 5, 12),
    (6, 'DACS', 'UE 6.1', 1, 1, 1, 60, 'Portfolio S6', 1, 5),
    (6, 'DACS', 'UE 6.1', 1, 1, 1, 60, 'SAE 6.B', 2, 10),
    (6, 'DACS', 'UE 6.1', 1, 1, 1, 60, 'Stage S6', 3, 45),
    (6, 'DACS', 'UE 6.1', 1, 1, 2, 40, 'R6.B.06', 1, 15),
    (6, 'DACS', 'UE 6.1', 1, 1, 2, 40, 'R6.B.05', 2, 25),
    (6, 'DACS', 'UE 6.3', 2, 3, 1, 60, 'Portfolio S6', 1, 5),
    (6, 'DACS', 'UE 6.3', 2, 3, 1, 60, 'SAE 6.B', 2, 10),
    (6, 'DACS', 'UE 6.3', 2, 3, 1, 60, 'Stage S6', 3, 45),
    (6, 'DACS', 'UE 6.3', 2, 3, 2, 40, 'R6.B.06', 1, 25),
    (6, 'DACS', 'UE 6.3', 2, 3, 2, 40, 'R6.B.05', 2, 15),
    (6, 'DACS', 'UE 6.6', 3, 6, 1, 60, 'Portfolio S6', 1, 5),
    (6, 'DACS', 'UE 6.6', 3, 6, 1, 60, 'SAE 6.B', 2, 10),
    (6, 'DACS', 'UE 6.6', 3, 6, 1, 60, 'Stage S6', 3, 45),
    (6, 'DACS', 'UE 6.6', 3, 6, 2, 40, 'R6.03', 1, 8),
    (6, 'DACS', 'UE 6.6', 3, 6, 2, 40, 'R6.01', 2, 12),
    (6, 'DACS', 'UE 6.6', 3, 6, 2, 40, 'R6.04', 3, 8),
    (6, 'DACS', 'UE 6.6', 3, 6, 2, 40, 'R6.02', 4, 12),
    (6, 'IAMSI', 'UE 6.1', 1, 1, 1, 60, 'Portfolio S6', 1, 5),
    (6, 'IAMSI', 'UE 6.1', 1, 1, 1, 60, 'SAE 6.D', 2, 10),
    (6, 'IAMSI', 'UE 6.1', 1, 1, 1, 60, 'Stage S6', 3, 45),
    (6, 'IAMSI', 'UE 6.1', 1, 1, 2, 45, 'R6.D.06', 1, 8),
    (6, 'IAMSI', 'UE 6.1', 1, 1, 2, 45, 'R6.D.05', 2, 33),
    (6, 'IAMSI', 'UE 6.5', 2, 5, 1, 60, 'Portfolio S6', 1, 5),
    (6, 'IAMSI', 'UE 6.5', 2, 5, 1, 60, 'SAE 6.D', 2, 10),
    (6, 'IAMSI', 'UE 6.5', 2, 5, 1, 60, 'Stage S6', 3, 45),
    (6, 'IAMSI', 'UE 6.5', 2, 5, 2, 40, 'R6.D.06', 1, 25),
    (6, 'IAMSI', 'UE 6.5', 2, 5, 2, 40, 'R6.D.05', 2, 15),
    (6, 'IAMSI', 'UE 6.6', 3, 6, 1, 60, 'Portfolio S6', 1, 5),
    (6, 'IAMSI', 'UE 6.6', 3, 6, 1, 60, 'SAE 6.D', 2, 10),
    (6, 'IAMSI', 'UE 6.6', 3, 6, 1, 60, 'Stage S6', 3, 45),
    (6, 'IAMSI', 'UE 6.6', 3, 6, 2, 40, 'R6.03', 1, 6),
    (6, 'IAMSI', 'UE 6.6', 3, 6, 2, 40, 'R6.01', 2, 9),
    (6, 'IAMSI', 'UE 6.6', 3, 6, 2, 40, 'R6.04', 3, 8),
    (6, 'IAMSI', 'UE 6.6', 3, 6, 2, 40, 'R6.D.06', 4, 8),
    (6, 'IAMSI', 'UE 6.6', 3, 6, 2, 40, 'R6.02', 5, 9);
-- END CURRICULUM

-- -----------------------------------------------------------------------------
-- 4. Moyennes de tous les participants, semestre par semestre
--
-- Reprend à l'identique le calcul du gestionnaire de scolarité :
--   matière : Σ (note / barème × 20 × coeff) / Σ coeff, notes prises dans l'ordre
--             (createdAt, id) ;
--   S1      : UE = Σ (moyenne matière × coeff UE) / Σ coeff des matières notées
--             (calcul d'origine, js/core/grades-calc.js) ;
--   S2 à S6 : module = Σ (moyenne matière × coeff) / Σ coeff des matières notées,
--             UE = Σ (moyenne module × coeff module) / Σ coeff des modules notés
--             (js/core/semester-calc.js, calcul des MCCC) ;
--   semestre : moyenne simple des UE calculées.
-- Le parcours (S4 à S6) est celui choisi dans le gestionnaire (réglage « parcours ») ;
-- sans parcours, ces semestres ne sont pas calculés, comme dans l'application.
-- Tout est calculé en double précision, dans le même ordre : les résultats sont
-- identiques au bit près à ceux de l'application (vérifié par les tests).
-- Les moyennes sont renvoyées en JSON, écrites avec tous leurs chiffres
-- (extra_float_digits = 1) : par défaut, Supabase tronque les doubles à 15 chiffres.
--
-- Renvoie une ligne par participant ayant au moins une moyenne de semestre, et rien du
-- tout si l'appelant n'est pas lui-même inscrit.
--
-- Colonnes : subject_averages, ue_averages et general_average restent celles du S1
-- (sites v1.0 à v1.2) ; « semesters » donne chaque semestre calculé :
--   { "2": { "general": 12.3, "ues": { "UE 2.1": … }, "subjects": { "R2.01": … } }, … }
--
-- Profil : chaque information n'est renvoyée que si son propriétaire a choisi de
-- l'afficher (colonnes show_*), y compris pour sa propre ligne : on voit ce que
-- les autres voient. Les colonnes ajoutées en fin de résultat sont ignorées par
-- les anciennes versions du site.
-- -----------------------------------------------------------------------------
drop function if exists public.ranking_snapshot();
create function public.ranking_snapshot()
returns table (
    student_key      text,
    display_name     text,
    is_me            boolean,
    subject_averages jsonb,
    ue_averages      jsonb,
    general_average  jsonb,
    origin           text,
    class_name       text,
    td_group         text,
    track            text,
    student_number   text,
    shares_grades    boolean,
    semesters        jsonb,
    parcours         text
)
language sql
stable
security definer
set search_path = ''
set extra_float_digits = 1
as $$
    with me as (
        select (select auth.uid()) as uid
    ),
    participants as (
        select
            p.user_id,
            coalesce(
                case when p.name_mode = 'real' then nullif(concat_ws(' ', p.first_name, p.last_name), '') end,
                p.display_name,
                'Étudiant ' || upper(substr(md5(p.user_id::text), 1, 4))
            ) as shown_name,
            case when p.show_origin then p.origin end as origin,
            case when p.show_class then p.class_name end as class_name,
            case when p.show_td_group then p.td_group end as td_group,
            case when p.show_track then p.track end as track,
            case when p.show_student_number then p.student_number end as student_number,
            p.show_grades
        from public.ranking_profiles p
        where exists (
            select 1 from public.ranking_profiles mine, me where mine.user_id = me.uid
        )
    ),
    -- Parcours choisi dans le gestionnaire (réglage synchronisé « parcours »)
    user_parcours as (
        select distinct on (i.user_id) i.user_id, i.data ->> 'value' as parcours
        from public.items i
        join participants p on p.user_id = i.user_id
        where i.collection = 'settings'
          and i.deleted_at is null
          and i.data ->> 'key' = 'parcours'
          and jsonb_typeof(i.data -> 'value') = 'string'
        order by i.user_id, i.updated_at desc
    ),
    -- Programme suivi par chaque participant : tronc commun + son parcours
    plan as (
        select p.user_id, c.*
        from participants p
        left join user_parcours up on up.user_id = p.user_id
        join public.ranking_curriculum c on c.parcours = '*' or c.parcours = up.parcours
    ),
    known as (
        select distinct c.subject, c.semester from public.ranking_curriculum c
    ),
    -- Notes vivantes des participants. Les valeurs sont lues en `numeric` (aucun
    -- dépassement possible) ; tout ce qui n'est pas un nombre est écarté.
    raw as (
        select
            i.user_id,
            i.id::text as id,
            i.data ->> 'subjectCode' as code,
            case when jsonb_typeof(i.data -> 'score') = 'number' then (i.data ->> 'score')::numeric end as score,
            case when jsonb_typeof(i.data -> 'max') = 'number' then (i.data ->> 'max')::numeric end as max,
            case when jsonb_typeof(i.data -> 'coeff') = 'number' then (i.data ->> 'coeff')::numeric end as coeff,
            case when jsonb_typeof(i.data -> 'createdAt') = 'number' then (i.data ->> 'createdAt')::numeric else 0 end as created
        from public.items i
        join participants p on p.user_id = i.user_id
        where i.collection = 'grades'
          and i.deleted_at is null
    ),
    -- Bornes de bon sens : une valeur absurde saisie par un compte ne doit ni fausser
    -- ni faire échouer le classement de tous.
    valid as (
        select
            r.user_id, r.id, r.code, r.created,
            r.score::double precision as score,
            r.max::double precision as max,
            r.coeff::double precision as coeff
        from raw r
        join known k on k.subject = r.code
        where r.score is not null and r.max is not null and r.coeff is not null
          and r.score between -1000000 and 1000000
          and r.max > 0 and r.max <= 1000000
          and r.coeff >= 0 and r.coeff <= 1000000
    ),
    subject_sums as (
        select
            v.user_id,
            v.code,
            sum(((v.score / v.max) * 20::double precision) * v.coeff order by v.created, v.id collate "C") as score_sum,
            sum(v.coeff order by v.created, v.id collate "C") as coeff_sum
        from valid v
        group by v.user_id, v.code
    ),
    subject_avg as (
        select ss.user_id, ss.code, ss.score_sum / nullif(ss.coeff_sum, 0) as average
        from subject_sums ss
        where ss.coeff_sum > 0
    ),
    module_avg as (
        select
            pl.user_id, pl.semester, pl.ue, pl.ue_ord, pl.module_ord, pl.module_coef,
            sum(sa.average * pl.coef order by pl.item_ord) / sum(pl.coef order by pl.item_ord) as average
        from plan pl
        join subject_avg sa on sa.user_id = pl.user_id and sa.code = pl.subject
        group by pl.user_id, pl.semester, pl.ue, pl.ue_ord, pl.module_ord, pl.module_coef
    ),
    ue_avg as (
        select
            m.user_id, m.semester, m.ue, m.ue_ord,
            case
                when m.semester = 1 then min(m.average)  -- S1 : une seule liste par UE
                else sum(m.average * m.module_coef order by m.module_ord) / sum(m.module_coef order by m.module_ord)
            end as average
        from module_avg m
        group by m.user_id, m.semester, m.ue, m.ue_ord
    ),
    semester_avg as (
        select u.user_id, u.semester, sum(u.average order by u.ue_ord) / count(*)::double precision as average
        from ue_avg u
        group by u.user_id, u.semester
    ),
    semester_subjects as (
        select distinct pl.user_id, pl.semester, sa.code, sa.average
        from plan pl
        join subject_avg sa on sa.user_id = pl.user_id and sa.code = pl.subject
    ),
    semesters_json as (
        select
            s.user_id,
            jsonb_object_agg(
                s.semester::text,
                jsonb_build_object(
                    'general', to_jsonb(s.average),
                    'ues', (select jsonb_object_agg(u.ue, u.average) from ue_avg u where u.user_id = s.user_id and u.semester = s.semester),
                    'subjects', (select jsonb_object_agg(x.code, x.average) from semester_subjects x where x.user_id = s.user_id and x.semester = s.semester)
                )
            ) as semesters
        from semester_avg s
        group by s.user_id
    )
    select
        substr(md5(p.user_id::text), 1, 12) as student_key,
        p.shown_name as display_name,
        p.user_id = me.uid as is_me,
        sj.semesters -> '1' -> 'subjects' as subject_averages,
        sj.semesters -> '1' -> 'ues' as ue_averages,
        sj.semesters -> '1' -> 'general' as general_average,
        p.origin,
        p.class_name,
        p.td_group,
        p.track,
        p.student_number,
        p.show_grades as shares_grades,
        sj.semesters,
        case when p.user_id = me.uid then up.parcours end as parcours  -- le sien seulement
    from participants p
    cross join me
    join semesters_json sj on sj.user_id = p.user_id
    left join user_parcours up on up.user_id = p.user_id
    order by student_key;
$$;

comment on function public.ranking_snapshot() is 'Classement : moyennes (matières, UE, générale) de chaque semestre de tous les inscrits, visibles des seuls inscrits.';

revoke all on function public.ranking_snapshot() from public;
revoke all on function public.ranking_snapshot() from anon;
grant execute on function public.ranking_snapshot() to authenticated;

-- -----------------------------------------------------------------------------
-- 5. Détail des notes d'un étudiant (v1.1)
--
-- Renvoie les évaluations d'un inscrit UNIQUEMENT s'il a choisi de partager le détail
-- de ses notes (show_grades), ou s'il s'agit de l'appelant lui-même. L'appelant doit
-- être inscrit. Mêmes notes que celles retenues pour le calcul des moyennes.
-- -----------------------------------------------------------------------------
drop function if exists public.ranking_student_grades(text);
create function public.ranking_student_grades(p_student_key text)
returns table (
    subject_code text,
    name         text,
    score        jsonb,
    max          jsonb,
    coeff        jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
    with me as (
        select (select auth.uid()) as uid
    ),
    target as (
        select p.user_id
        from public.ranking_profiles p, me
        where substr(md5(p.user_id::text), 1, 12) = p_student_key
          and (p.show_grades or p.user_id = me.uid)
          and exists (select 1 from public.ranking_profiles mine where mine.user_id = me.uid)
    ),
    raw as (
        select
            i.id::text as id,
            i.data ->> 'subjectCode' as code,
            left(coalesce(i.data ->> 'name', ''), 120) as name,
            i.data -> 'score' as score_json,
            i.data -> 'max' as max_json,
            i.data -> 'coeff' as coeff_json,
            case when jsonb_typeof(i.data -> 'score') = 'number' then (i.data ->> 'score')::numeric end as score,
            case when jsonb_typeof(i.data -> 'max') = 'number' then (i.data ->> 'max')::numeric end as max,
            case when jsonb_typeof(i.data -> 'coeff') = 'number' then (i.data ->> 'coeff')::numeric end as coeff,
            case when jsonb_typeof(i.data -> 'createdAt') = 'number' then (i.data ->> 'createdAt')::numeric else 0 end as created
        from public.items i
        join target t on t.user_id = i.user_id
        where i.collection = 'grades'
          and i.deleted_at is null
    )
    select r.code, r.name, r.score_json, r.max_json, r.coeff_json
    from raw r
    where r.score is not null and r.max is not null and r.coeff is not null
      and r.score between -1000000 and 1000000
      and r.max > 0 and r.max <= 1000000
      and r.coeff >= 0 and r.coeff <= 1000000
      and exists (select 1 from public.ranking_curriculum c where c.subject = r.code)
    order by r.created, r.id collate "C";
$$;

comment on function public.ranking_student_grades(text) is 'Classement : détail des notes d''un inscrit, seulement s''il a choisi de le partager.';

revoke all on function public.ranking_student_grades(text) from public;
revoke all on function public.ranking_student_grades(text) from anon;
grant execute on function public.ranking_student_grades(text) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Suppression de son compte (v1.2)
--
-- Supprime le compte de l'appelant et, par cascade, TOUTES ses données : notes, devoirs
-- et réglages du gestionnaire de scolarité (table items), profil du classement, sessions.
-- Irréversible. Le site télécharge une sauvegarde JSON avant d'appeler cette fonction.
-- Personne ne peut supprimer un autre compte que le sien.
-- -----------------------------------------------------------------------------
create or replace function public.ranking_delete_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    caller uuid := (select auth.uid());
begin
    if caller is null then
        raise exception 'Connexion requise.' using errcode = '42501';
    end if;
    delete from auth.users where id = caller;
end;
$$;

comment on function public.ranking_delete_account() is 'Classement : supprime le compte de l''appelant et toutes ses données (cascade). Irréversible.';

revoke all on function public.ranking_delete_account() from public;
revoke all on function public.ranking_delete_account() from anon;
grant execute on function public.ranking_delete_account() to authenticated;
