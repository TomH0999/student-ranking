/**
 * Postgres réel (PGlite) avec une émulation minimale de Supabase : schéma `auth`,
 * auth.uid() lu dans les claims JWT, rôles `anon` / `authenticated`, publication
 * `supabase_realtime`. On y exécute tels quels le schéma de l'application
 * (tests/reference/app-schema.sql, copie de référence) puis supabase/ranking.sql.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => readFileSync(path.join(root, ...p), "utf8");

export const APP_SCHEMA_SQL = read("tests", "reference", "app-schema.sql");
export const RANKING_SQL = read("supabase", "ranking.sql");
/** Script de la version précédente, pour tester la mise à jour d'une base déjà installée. */
export const RANKING_SQL_V1_0_1 = read("tests", "reference", "ranking-v1.0.1.sql");
export const UNINSTALL_SQL = read("supabase", "uninstall.sql");

const SUPABASE_EMULATION = `
set timezone = 'UTC';
-- Comme sur Supabase : les doubles sont affichés sur 15 chiffres par défaut
set extra_float_digits = 0;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text unique);
create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                           (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
$$;
do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
grant usage on schema public to anon, authenticated;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
do $$ begin
    if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then create publication supabase_realtime; end if;
end $$;
`;

export async function createDatabase({ ranking = true } = {}) {
    const db = new PGlite();
    await db.exec(SUPABASE_EMULATION);
    await db.exec(APP_SCHEMA_SQL);
    if (ranking) await db.exec(RANKING_SQL);
    return db;
}

/** Exécute `fn(tx)` comme PostgREST : rôle + claims JWT, dans une transaction. */
export async function asRole(db, userId, fn) {
    return db.transaction(async (tx) => {
        if (userId) {
            await tx.exec("set local role authenticated");
            await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
        } else {
            await tx.exec("set local role anon");
        }
        return fn(tx);
    });
}

export async function createUser(db, email) {
    const id = crypto.randomUUID();
    await db.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
    return id;
}

/** Écrit une note comme le fait l'application (insertion par l'utilisateur lui-même). */
export async function addGrade(db, userId, data, { id = crypto.randomUUID() } = {}) {
    await asRole(db, userId, (tx) =>
        tx.query("insert into public.items (user_id, id, collection, data, device_id) values ($1, $2, 'grades', $3::jsonb, 'test')", [userId, id, JSON.stringify(data)])
    );
    return id;
}

export const join = (db, userId, name = null) =>
    asRole(db, userId, (tx) => tx.query("insert into public.ranking_profiles (user_id, display_name) values ($1, $2)", [userId, name]));

export async function snapshot(db, userId) {
    const r = await asRole(db, userId, (tx) => tx.query("select * from public.ranking_snapshot()"));
    return r.rows;
}

export async function pulseVersion(db) {
    const r = await db.query("select version from public.ranking_pulse");
    return Number(r.rows[0].version);
}
