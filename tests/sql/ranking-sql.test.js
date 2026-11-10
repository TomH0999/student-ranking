/**
 * Tests de supabase/ranking.sql sur un vrai Postgres (PGlite) :
 *  - parité AU BIT PRÈS avec le calcul de l'application (tests/reference/grades-calc.js,
 *    copie conforme de js/core/grades-calc.js du gestionnaire de scolarité) ;
 *  - confidentialité (RLS, inscrits seulement, aucun accès anonyme) ;
 *  - signal temps réel ; robustesse face aux données absurdes ; idempotence ; désinstallation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabase, asRole, createUser, addGrade, join, snapshot, pulseVersion, RANKING_SQL, UNINSTALL_SQL } from "./pglite-env.js";
import { calculateAllAverages, sortGradesForCalculation } from "../reference/grades-calc.js";
import { ALL_SUBJECTS, PROGRAM_S1, COEFFICIENTS_UE } from "../../js/program.js";

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function randomGrades(rand, count) {
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const grades = [];
    for (let i = 0; i < count; i++) {
        const max = pick([20, 20, 20, 10, 40, 100, 5, 30, 12.5]);
        grades.push({
            id: crypto.randomUUID(),
            name: `Éval ${i}`,
            subjectCode: pick(ALL_SUBJECTS).code,
            score: Math.round(rand() * max * 100) / 100,
            max,
            coeff: pick([1, 1, 2, 0.5, 3, 1.5, 0.25, 7]),
            // Dates de création parfois identiques : l'ordre retombe alors sur l'identifiant
            createdAt: 1700000000000 + Math.floor(rand() * 5) * 1000
        });
    }
    return grades;
}

/** Ce que l'application afficherait pour ces notes (clés sans moyenne retirées). */
function expectedFor(grades) {
    const r = calculateAllAverages(sortGradesForCalculation(grades));
    const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));
    return { subjects: clean(r.subjectAverages), ues: clean(r.ueAverages), general: r.globalAverage };
}

let db;
beforeAll(async () => {
    db = await createDatabase();
});
afterAll(async () => {
    await db.close();
});

describe("parité avec le calcul de l'application", () => {
    it("les coefficients du SQL sont ceux du programme", () => {
        for (const [i, s] of ALL_SUBJECTS.entries()) expect(RANKING_SQL).toContain(`('${s.code}', ${i + 1})`);
        for (const [u, ue] of PROGRAM_S1.ues.entries()) {
            for (const [i, [sub, coeff]] of Object.entries(COEFFICIENTS_UE[ue.code]).entries()) {
                expect(RANKING_SQL).toContain(`('${ue.code}', ${u + 1}, '${sub}', ${i + 1}, ${coeff})`);
            }
        }
    });

    it("moyennes identiques au bit près sur 40 étudiants aléatoires", async () => {
        const rand = rng(20261110);
        const expected = new Map();
        for (let n = 0; n < 40; n++) {
            const user = await createUser(db, `parite${n}@example.com`);
            await join(db, user, `Parité ${n}`);
            const grades = randomGrades(rand, 1 + Math.floor(rand() * 45));
            for (const g of grades) {
                const { id, ...data } = g;
                await addGrade(db, user, data, { id });
            }
            expected.set(`Parité ${n}`, expectedFor(grades));
        }
        const viewer = await createUser(db, "lecteur-parite@example.com");
        await join(db, viewer);
        const rows = (await snapshot(db, viewer)).filter((r) => r.display_name.startsWith("Parité "));
        expect(rows).toHaveLength(40);
        for (const row of rows) {
            const exp = expected.get(row.display_name);
            expect(row.subject_averages, row.display_name).toEqual(exp.subjects);
            expect(row.ue_averages, row.display_name).toEqual(exp.ues);
            expect(Object.is(row.general_average, exp.general), `${row.display_name} : ${row.general_average} ≠ ${exp.general}`).toBe(true);
        }
    });

    it("notes supprimées, matières inconnues et coefficient nul : comme l'application", async () => {
        const user = await createUser(db, "cas-limites@example.com");
        await join(db, user, "Cas limites");
        const kept = [
            { id: crypto.randomUUID(), subjectCode: "R1.01", score: 22, max: 20, coeff: 1, createdAt: 1 },
            { id: crypto.randomUUID(), subjectCode: "R1.01", score: 7.5, max: 10, coeff: 2, createdAt: 2 },
            // Coefficient nul seul dans sa matière : pas de moyenne pour R1.05
            { id: crypto.randomUUID(), subjectCode: "R1.05", score: 12, max: 20, coeff: 0, createdAt: 3 },
            { id: crypto.randomUUID(), subjectCode: "MATIERE INCONNUE", score: 3, max: 20, coeff: 1, createdAt: 4 },
            // Sans createdAt : rangée en premier (0), comme dans l'application
            { id: crypto.randomUUID(), subjectCode: "SAE 1.01", score: 13.37, max: 20, coeff: 1 }
        ];
        for (const g of kept) {
            const { id, ...data } = g;
            await addGrade(db, user, data, { id });
        }
        const deleted = await addGrade(db, user, { subjectCode: "R1.01", score: 0, max: 20, coeff: 5, createdAt: 5 });
        await asRole(db, user, (tx) => tx.query("update public.items set deleted_at = now() where id = $1", [deleted]));

        const row = (await snapshot(db, user)).find((r) => r.is_me);
        const exp = expectedFor(kept);
        expect(row.subject_averages).toEqual(exp.subjects);
        expect(row.subject_averages).not.toHaveProperty("R1.05");
        expect(row.ue_averages).toEqual(exp.ues);
        expect(row.general_average).toBe(exp.general);
    });
});

describe("participants et confidentialité", () => {
    let alice, bob, carol, dave;
    beforeAll(async () => {
        alice = await createUser(db, "alice@example.com");
        bob = await createUser(db, "bob@example.com");
        carol = await createUser(db, "carol@example.com");
        dave = await createUser(db, "dave@example.com");
        await addGrade(db, alice, { subjectCode: "R1.01", score: 16, max: 20, coeff: 1, createdAt: 1 });
        await addGrade(db, bob, { subjectCode: "R1.01", score: 11, max: 20, coeff: 1, createdAt: 1 });
        await addGrade(db, carol, { subjectCode: "R1.01", score: 19, max: 20, coeff: 1, createdAt: 1 });
        await join(db, alice, "Alice");
        await join(db, bob);
        // carol a l'application et des notes mais n'est pas inscrite ; dave est inscrit sans note
        await join(db, dave, "Dave");
    });

    it("un compte non inscrit ne voit rien et n'apparaît pas", async () => {
        expect(await snapshot(db, carol)).toEqual([]);
        const names = (await snapshot(db, alice)).map((r) => r.display_name);
        expect(names).toContain("Alice");
        expect(names).not.toContain("Dave"); // inscrit, mais aucune moyenne
        const total = await db.query("select count(*)::int as n from public.ranking_profiles");
        expect((await snapshot(db, alice)).length).toBeLessThan(total.rows[0].n);
    });

    it("pseudo automatique, indicateur « moi », aucun identifiant de compte ni e-mail", async () => {
        const rows = await snapshot(db, bob);
        const mine = rows.filter((r) => r.is_me);
        expect(mine).toHaveLength(1);
        expect(mine[0].display_name).toMatch(/^Étudiant [0-9A-F]{4}$/);
        expect(mine[0].general_average).toBe(11);
        const dump = JSON.stringify(rows);
        for (const secret of [alice, bob, "alice@example.com", "bob@example.com"]) expect(dump).not.toContain(secret);
        expect(Object.keys(rows[0]).sort()).toEqual(["display_name", "general_average", "is_me", "student_key", "subject_averages", "ue_averages"]);
    });

    it("accès anonyme refusé partout", async () => {
        await expect(asRole(db, null, (tx) => tx.query("select * from public.ranking_snapshot()"))).rejects.toThrow(/permission denied/);
        await expect(asRole(db, null, (tx) => tx.query("select * from public.ranking_profiles"))).rejects.toThrow(/permission denied/);
        await expect(asRole(db, null, (tx) => tx.query("select * from public.ranking_pulse"))).rejects.toThrow(/permission denied/);
    });

    it("RLS : on ne lit, ne modifie et ne supprime que son propre profil", async () => {
        const seen = await asRole(db, alice, (tx) => tx.query("select display_name from public.ranking_profiles"));
        expect(seen.rows).toEqual([{ display_name: "Alice" }]);
        const upd = await asRole(db, alice, (tx) => tx.query("update public.ranking_profiles set display_name = 'Pirate' where user_id = $1", [bob]));
        expect(upd.affectedRows).toBe(0);
        const del = await asRole(db, alice, (tx) => tx.query("delete from public.ranking_profiles where user_id = $1", [bob]));
        expect(del.affectedRows).toBe(0);
        await expect(join(db, alice, "Usurpation").catch((e) => Promise.reject(new Error(e.message)))).rejects.toThrow();
        await expect(asRole(db, alice, (tx) => tx.query("insert into public.ranking_profiles (user_id, display_name) values ($1, 'Faux')", [carol]))).rejects.toThrow(/row-level security/);
        await expect(asRole(db, alice, (tx) => tx.query("update public.ranking_pulse set version = 0"))).rejects.toThrow(/permission denied/);
    });

    it("les notes des autres restent illisibles (RLS de l'application intacte)", async () => {
        const r = await asRole(db, alice, (tx) => tx.query("select distinct user_id from public.items"));
        expect(r.rows).toEqual([{ user_id: alice }]);
    });

    it("pseudos : unicité sans tenir compte de la casse, longueur, noms réservés", async () => {
        const rename = (user, name) => asRole(db, user, (tx) => tx.query("update public.ranking_profiles set display_name = $2 where user_id = $1", [user, name]));
        await expect(rename(bob, "alice")).rejects.toThrow(/ranking_profiles_name_key/);
        await expect(rename(bob, "A")).rejects.toThrow(/ranking_profiles_name_check/);
        await expect(rename(bob, "x".repeat(25))).rejects.toThrow(/ranking_profiles_name_check/);
        await expect(rename(bob, " Bob ")).rejects.toThrow(/ranking_profiles_name_check/);
        await expect(rename(bob, "Étudiant ABCD")).rejects.toThrow(/ranking_profiles_name_check/);
        await rename(bob, "Bob");
        expect((await snapshot(db, bob)).find((r) => r.is_me).display_name).toBe("Bob");
        await rename(bob, null);
    });

    it("quitter le classement retire l'étudiant et lui ferme l'accès", async () => {
        const eve = await createUser(db, "eve@example.com");
        await addGrade(db, eve, { subjectCode: "R1.02", score: 20, max: 20, coeff: 1, createdAt: 1 });
        await join(db, eve, "Eve");
        expect((await snapshot(db, alice)).map((r) => r.display_name)).toContain("Eve");
        await asRole(db, eve, (tx) => tx.query("delete from public.ranking_profiles where user_id = $1", [eve]));
        expect((await snapshot(db, alice)).map((r) => r.display_name)).not.toContain("Eve");
        expect(await snapshot(db, eve)).toEqual([]);
    });
});

describe("signal temps réel", () => {
    it("ranking_pulse est publiée pour Realtime", async () => {
        const r = await db.query("select tablename from pg_publication_tables where pubname = 'supabase_realtime'");
        expect(r.rows.map((x) => x.tablename)).toEqual(expect.arrayContaining(["items", "ranking_pulse"]));
    });

    it("s'incrémente quand un inscrit ajoute, modifie ou supprime une note, ou change de pseudo", async () => {
        const user = await createUser(db, "pulse@example.com");
        let v = await pulseVersion(db);
        const bumped = async () => {
            const next = await pulseVersion(db);
            const changed = next > v;
            v = next;
            return changed;
        };
        await join(db, user, "Pulse");
        expect(await bumped()).toBe(true);
        const id = await addGrade(db, user, { subjectCode: "R1.03", score: 10, max: 20, coeff: 1, createdAt: 1 });
        expect(await bumped()).toBe(true);
        await asRole(db, user, (tx) => tx.query("update public.items set data = data || '{\"score\": 14}'::jsonb where id = $1", [id]));
        expect(await bumped()).toBe(true);
        await asRole(db, user, (tx) => tx.query("update public.items set deleted_at = now() where id = $1", [id]));
        expect(await bumped()).toBe(true);
        await asRole(db, user, (tx) => tx.query("update public.ranking_profiles set display_name = 'Pulse 2' where user_id = $1", [user]));
        expect(await bumped()).toBe(true);
    });

    it("ne bouge pas pour un non-inscrit, ni pour un devoir ou un réglage", async () => {
        const outsider = await createUser(db, "dehors@example.com");
        const member = await createUser(db, "dedans@example.com");
        await join(db, member);
        const v = await pulseVersion(db);
        await addGrade(db, outsider, { subjectCode: "R1.03", score: 10, max: 20, coeff: 1 });
        await asRole(db, member, (tx) =>
            tx.query("insert into public.items (user_id, id, collection, data) values ($1, $2, 'homework', '{\"title\":\"x\"}'), ($1, $3, 'settings', '{\"value\":1}')", [member, crypto.randomUUID(), crypto.randomUUID()])
        );
        expect(await pulseVersion(db)).toBe(v);
    });

    it("une panne du signal ne fait jamais échouer l'enregistrement d'une note", async () => {
        const user = await createUser(db, "panne@example.com");
        await join(db, user);
        await db.exec("alter table public.ranking_pulse rename column version to version_cassee");
        try {
            const id = await addGrade(db, user, { subjectCode: "R1.04", score: 9, max: 20, coeff: 1 });
            const r = await db.query("select 1 from public.items where id = $1", [id]);
            expect(r.rows).toHaveLength(1);
        } finally {
            await db.exec("alter table public.ranking_pulse rename column version_cassee to version");
        }
    });
});

describe("robustesse", () => {
    it("des valeurs absurdes dans un compte ne cassent pas le classement des autres", async () => {
        const troll = await createUser(db, "troll@example.com");
        const honest = await createUser(db, "honnete@example.com");
        await join(db, troll, "Troll");
        await join(db, honest, "Honnête");
        await addGrade(db, honest, { subjectCode: "R1.06", score: 15, max: 20, coeff: 1, createdAt: 1 });
        const bad = [
            { subjectCode: "R1.06", score: 10, max: 0, coeff: 1 },
            { subjectCode: "R1.06", score: 10, max: -20, coeff: 1 },
            { subjectCode: "R1.06", score: "20", max: 20, coeff: 1 },
            { subjectCode: "R1.06", score: 10, max: 20, coeff: -3 },
            { subjectCode: "R1.06", score: null, max: 20, coeff: 1 },
            { subjectCode: "R1.06", score: [20], max: { a: 1 }, coeff: true },
            { subjectCode: 42, score: 10, max: 20, coeff: 1 },
            { score: 10, max: 20, coeff: 1 }
        ];
        for (const data of bad) await addGrade(db, troll, data);
        // Nombres trop grands pour un double : insérés en JSON brut
        await asRole(db, troll, (tx) =>
            tx.query(`insert into public.items (user_id, id, collection, data) values ($1, $2, 'grades', '{"subjectCode":"R1.06","score":1e400,"max":20,"coeff":1,"createdAt":1e500}'::jsonb)`, [troll, crypto.randomUUID()])
        );
        await addGrade(db, troll, { subjectCode: "R1.06", score: 1e300, max: 1e-300, coeff: 1 });

        const rows = await snapshot(db, honest);
        expect(rows.find((r) => r.is_me).general_average).toBe(15);
        expect(rows.map((r) => r.display_name)).not.toContain("Troll");
        for (const r of rows) expect(Number.isFinite(r.general_average)).toBe(true);
    });

    it("ranking.sql est idempotent : rejoué sans erreur ni perte", async () => {
        const before = await db.query("select count(*)::int as n from public.ranking_profiles");
        await db.exec(RANKING_SQL);
        await db.exec(RANKING_SQL);
        const after = await db.query("select count(*)::int as n from public.ranking_profiles");
        expect(after.rows[0].n).toBe(before.rows[0].n);
        expect(before.rows[0].n).toBeGreaterThan(40);
        const pulse = await db.query("select count(*)::int as n from public.ranking_pulse");
        expect(pulse.rows[0].n).toBe(1);
    });

    it("RLS activée sur toutes les tables publiques ; fonctions à search_path figé", async () => {
        const t = await db.query("select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'");
        expect(t.rows.map((x) => x.relname).sort()).toEqual(["items", "ranking_profiles", "ranking_pulse"]);
        for (const row of t.rows) expect(row.relrowsecurity, row.relname).toBe(true);
        const f = await db.query("select proname, proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname like 'ranking_%'");
        expect(f.rows).toHaveLength(3);
        for (const row of f.rows) expect(row.proconfig, row.proname).toContain('search_path=""');
    });

    it("refuse de s'installer sans la table de l'application", async () => {
        const { PGlite } = await import("@electric-sql/pglite");
        const empty = new PGlite();
        await expect(empty.exec(RANKING_SQL)).rejects.toThrow(/public\.items introuvable/);
        await empty.close();
    });

    it("uninstall.sql retire tout sans toucher aux notes", async () => {
        const fresh = await createDatabase();
        const user = await createUser(fresh, "desinstall@example.com");
        await join(fresh, user);
        await addGrade(fresh, user, { subjectCode: "R1.01", score: 10, max: 20, coeff: 1 });
        await fresh.exec(UNINSTALL_SQL);
        await fresh.exec(UNINSTALL_SQL);
        const left = await fresh.query("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relname like 'ranking%'");
        expect(left.rows).toEqual([]);
        const trig = await fresh.query("select tgname from pg_trigger where tgname like 'ranking%'");
        expect(trig.rows).toEqual([]);
        const items = await fresh.query("select count(*)::int as n from public.items");
        expect(items.rows[0].n).toBe(1);
        await addGrade(fresh, user, { subjectCode: "R1.01", score: 12, max: 20, coeff: 1 });
        await fresh.close();
    });
});
