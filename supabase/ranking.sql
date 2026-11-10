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
alter table public.ranking_profiles add constraint ranking_profiles_details_check check (
    name_mode in ('pseudo', 'real')
    and (first_name is null or (char_length(first_name) between 1 and 30 and first_name = btrim(first_name) and first_name !~ '[[:cntrl:]]' and first_name !~* '^(é|e)tudiant'))
    and (last_name is null or (char_length(last_name) between 1 and 30 and last_name = btrim(last_name) and last_name !~ '[[:cntrl:]]'))
    and (student_number is null or student_number ~ '^[0-9A-Za-z]{1,20}$')
    and (origin is null or origin in ('general', 'sti2d', 'autre'))
    and (class_name is null or (char_length(class_name) between 1 and 16 and class_name = upper(btrim(class_name)) and class_name !~ '[[:cntrl:]]'))
    and (td_group is null or (char_length(td_group) between 1 and 16 and td_group = upper(btrim(td_group)) and td_group !~ '[[:cntrl:]]'))
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

-- Notes modifiées : on ne signale que si elles appartiennent à un participant.
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
-- 3. Moyennes de tous les participants
--
-- Reprend à l'identique le calcul de l'application (js/core/grades-calc.js) :
--   matière : Σ (note / barème × 20 × coeff) / Σ coeff, notes prises dans l'ordre
--             (createdAt, id) ;
--   UE      : Σ (moyenne matière × coeff UE) / Σ coeff UE des matières notées ;
--   générale: moyenne simple des UE calculées.
-- Tout est calculé en double précision, dans le même ordre : les résultats sont
-- identiques au bit près à ceux affichés par l'application (vérifié par les tests).
-- Les moyennes sont renvoyées en JSON, écrites avec tous leurs chiffres
-- (extra_float_digits = 1) : par défaut, Supabase tronque les doubles à 15 chiffres.
--
-- Renvoie une ligne par participant ayant au moins une moyenne, et rien du tout si
-- l'appelant n'est pas lui-même inscrit.
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
    shares_grades    boolean
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
    subjects (code, ord) as (
        values
        ('R1.01', 1), ('R1.02', 2), ('R1.03', 3), ('R1.04', 4), ('R1.05', 5), ('R1.06', 6),
        ('R1.07', 7), ('R1.08', 8), ('R1.09', 9), ('R1.10', 10), ('R1.11', 11), ('R1.12', 12),
        ('SAE 1.01', 13), ('SAE 1.02', 14), ('SAE 1.03', 15), ('SAE 1.04', 16), ('SAE 1.05', 17), ('SAE 1.06', 18)
    ),
    coeffs (ue, ue_ord, subject, sub_ord, coeff) as (
        values
        ('UE 1.1', 1, 'SAE 1.01', 1, 40), ('UE 1.1', 1, 'R1.01', 2, 42), ('UE 1.1', 1, 'R1.02', 3, 12), ('UE 1.1', 1, 'R1.10', 4, 6),
        ('UE 1.2', 2, 'SAE 1.02', 1, 40), ('UE 1.2', 2, 'R1.01', 2, 24), ('UE 1.2', 2, 'R1.03', 3, 3), ('UE 1.2', 2, 'R1.04', 4, 3), ('UE 1.2', 2, 'R1.06', 5, 15), ('UE 1.2', 2, 'R1.07', 6, 15),
        ('UE 1.3', 3, 'SAE 1.03', 1, 40), ('UE 1.3', 3, 'R1.03', 2, 21), ('UE 1.3', 3, 'R1.04', 3, 21), ('UE 1.3', 3, 'R1.10', 4, 12), ('UE 1.3', 3, 'R1.11', 5, 6),
        ('UE 1.4', 4, 'SAE 1.04', 1, 40), ('UE 1.4', 4, 'R1.05', 2, 36), ('UE 1.4', 4, 'R1.06', 3, 18), ('UE 1.4', 4, 'R1.09', 4, 6),
        ('UE 1.5', 5, 'SAE 1.05', 1, 40), ('UE 1.5', 5, 'R1.02', 2, 18), ('UE 1.5', 5, 'R1.08', 3, 27), ('UE 1.5', 5, 'R1.11', 4, 15),
        ('UE 1.6', 6, 'SAE 1.06', 1, 40), ('UE 1.6', 6, 'R1.02', 2, 5), ('UE 1.6', 6, 'R1.08', 3, 11), ('UE 1.6', 6, 'R1.09', 4, 11), ('UE 1.6', 6, 'R1.10', 5, 11), ('UE 1.6', 6, 'R1.11', 6, 11), ('UE 1.6', 6, 'R1.12', 7, 11)
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
        join subjects s on s.code = r.code
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
    ue_avg as (
        select
            sa.user_id,
            c.ue,
            c.ue_ord,
            sum(sa.average * c.coeff::double precision order by c.sub_ord)
                / sum(c.coeff::double precision order by c.sub_ord) as average
        from subject_avg sa
        join coeffs c on c.subject = sa.code
        group by sa.user_id, c.ue, c.ue_ord
    ),
    general_avg as (
        select u.user_id, sum(u.average order by u.ue_ord) / count(*)::double precision as average
        from ue_avg u
        group by u.user_id
    )
    select
        substr(md5(p.user_id::text), 1, 12) as student_key,
        p.shown_name as display_name,
        p.user_id = me.uid as is_me,
        (select jsonb_object_agg(sa.code, sa.average) from subject_avg sa where sa.user_id = p.user_id) as subject_averages,
        (select jsonb_object_agg(u.ue, u.average) from ue_avg u where u.user_id = p.user_id) as ue_averages,
        to_jsonb(g.average) as general_average,
        p.origin,
        p.class_name,
        p.td_group,
        p.track,
        p.student_number,
        p.show_grades as shares_grades
    from participants p
    cross join me
    join general_avg g on g.user_id = p.user_id
    order by g.average desc, student_key;
$$;

comment on function public.ranking_snapshot() is 'Classement : moyennes (matières, UE, générale) de tous les inscrits, visibles des seuls inscrits.';

revoke all on function public.ranking_snapshot() from public;
revoke all on function public.ranking_snapshot() from anon;
grant execute on function public.ranking_snapshot() to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Détail des notes d'un étudiant (v1.1)
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
      and r.code in (
          'R1.01', 'R1.02', 'R1.03', 'R1.04', 'R1.05', 'R1.06', 'R1.07', 'R1.08', 'R1.09', 'R1.10', 'R1.11', 'R1.12',
          'SAE 1.01', 'SAE 1.02', 'SAE 1.03', 'SAE 1.04', 'SAE 1.05', 'SAE 1.06'
      )
    order by r.created, r.id collate "C";
$$;

comment on function public.ranking_student_grades(text) is 'Classement : détail des notes d''un inscrit, seulement s''il a choisi de le partager.';

revoke all on function public.ranking_student_grades(text) from public;
revoke all on function public.ranking_student_grades(text) from anon;
grant execute on function public.ranking_student_grades(text) to authenticated;
