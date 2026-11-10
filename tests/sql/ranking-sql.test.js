/**
 * Tests de supabase/ranking.sql sur un vrai Postgres (PGlite) :
 *  - parité AU BIT PRÈS avec le calcul de l'application (tests/reference/grades-calc.js,
 *    copie conforme de js/core/grades-calc.js du gestionnaire de scolarité) ;
 *  - confidentialité (RLS, inscrits seulement, aucun accès anonyme) ;
 *  - signal temps réel ; robustesse face aux données absurdes ; idempotence ; désinstallation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabase, asRole, createUser, addGrade, join, snapshot, pulseVersion, RANKING_SQL, RANKING_SQL_V1_0_1, RANKING_SQL_V1_1_0, UNINSTALL_SQL } from "./pglite-env.js";
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
        expect(Object.keys(rows[0]).sort()).toEqual([
            "class_name", "display_name", "general_average", "is_me", "origin", "shares_grades",
            "student_key", "student_number", "subject_averages", "td_group", "track", "ue_averages"
        ]);
        // Profil non renseigné : rien de plus qu'en v1.0
        expect(mine[0]).toMatchObject({ origin: null, class_name: null, td_group: null, track: null, student_number: null, shares_grades: false });
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

    it("inscription par insertion simple ; l'upsert de PostgREST est refusé (seul le pseudo est modifiable)", async () => {
        const frank = await createUser(db, "frank@example.com");
        const upsert = "insert into public.ranking_profiles (user_id, display_name) values ($1, $2) on conflict (user_id) do update set user_id = excluded.user_id, display_name = excluded.display_name";
        await expect(asRole(db, frank, (tx) => tx.query(upsert, [frank, "Frank"]))).rejects.toThrow(/permission denied/);
        await join(db, frank, "Frank");
        await expect(join(db, frank, "Frank")).rejects.toThrow(/ranking_profiles_pkey/);
        await asRole(db, frank, (tx) => tx.query("delete from public.ranking_profiles where user_id = $1", [frank]));
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

describe("profil personnalisable et visibilité", () => {
    let nina, omar, paul, outsider;
    const setProfile = (user, patch) => {
        const keys = Object.keys(patch);
        return asRole(db, user, (tx) =>
            tx.query(`update public.ranking_profiles set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} where user_id = $1`, [user, ...keys.map((k) => patch[k])])
        );
    };
    const rowOf = async (viewer, name) => (await snapshot(db, viewer)).find((r) => r.display_name === name);
    const gradesOf = async (viewer, key) => (await asRole(db, viewer, (tx) => tx.query("select * from public.ranking_student_grades($1)", [key]))).rows;

    beforeAll(async () => {
        nina = await createUser(db, "nina@example.com");
        omar = await createUser(db, "omar@example.com");
        paul = await createUser(db, "paul@example.com");
        outsider = await createUser(db, "outsider@example.com");
        await join(db, nina, "Nina");
        await join(db, omar, "Omar");
        await join(db, paul, "Paul");
        await addGrade(db, nina, { name: "TP noté", subjectCode: "R1.01", score: 14.5, max: 20, coeff: 2, createdAt: 2 });
        await addGrade(db, nina, { name: "Partiel", subjectCode: "R1.01", score: 8, max: 10, coeff: 1, createdAt: 1 });
        await addGrade(db, nina, { name: "Matière inconnue", subjectCode: "X9.99", score: 1, max: 20, coeff: 1, createdAt: 3 });
        await addGrade(db, nina, { name: "Barème nul", subjectCode: "R1.02", score: 1, max: 0, coeff: 1, createdAt: 4 });
        await addGrade(db, omar, { name: "Oral", subjectCode: "R1.10", score: 12, max: 20, coeff: 1, createdAt: 1 });
        await addGrade(db, paul, { name: "Projet", subjectCode: "SAE 1.01", score: 16, max: 20, coeff: 1, createdAt: 1 });
    });

    it("les informations renseignées sont visibles par défaut, sauf le n° étudiant et le détail des notes", async () => {
        await setProfile(nina, { origin: "sti2d", class_name: "S3", td_group: "TD2", track: "racdv", student_number: "22104567" });
        expect(await rowOf(omar, "Nina")).toMatchObject({ origin: "sti2d", class_name: "S3", td_group: "TD2", track: "racdv", student_number: null, shares_grades: false });
    });

    it("chaque information masquée n'est plus transmise, y compris à soi-même", async () => {
        await setProfile(nina, { show_origin: false, show_td_group: false, show_student_number: true });
        expect(await rowOf(omar, "Nina")).toMatchObject({ origin: null, class_name: "S3", td_group: null, track: "racdv", student_number: "22104567" });
        expect(await rowOf(nina, "Nina")).toMatchObject({ origin: null, td_group: null, is_me: true });
        await setProfile(nina, { show_class: false, show_track: false, show_student_number: false });
        const row = await rowOf(omar, "Nina");
        expect(row).toMatchObject({ origin: null, class_name: null, td_group: null, track: null, student_number: null });
        expect(JSON.stringify(await snapshot(db, omar))).not.toContain("22104567");
        // Le propriétaire, lui, relit tout dans son profil
        const own = await asRole(db, nina, (tx) => tx.query("select origin, class_name, student_number from public.ranking_profiles"));
        expect(own.rows).toEqual([{ origin: "sti2d", class_name: "S3", student_number: "22104567" }]);
    });

    it("nom affiché : pseudo par défaut, prénom et nom sur demande, repli si rien n'est renseigné", async () => {
        await setProfile(omar, { first_name: "Omar", last_name: "Benali" });
        expect(await rowOf(nina, "Omar")).toBeTruthy();
        await setProfile(omar, { name_mode: "real" });
        expect(await rowOf(nina, "Omar Benali")).toBeTruthy();
        expect(await rowOf(nina, "Omar")).toBeUndefined();
        await setProfile(omar, { last_name: null });
        expect(await rowOf(nina, "Omar")).toBeTruthy();
        await setProfile(omar, { first_name: null });
        expect(await rowOf(nina, "Omar")).toBeTruthy(); // mode « real » sans nom : retour au pseudo
        await setProfile(omar, { display_name: null });
        expect((await snapshot(db, omar)).find((r) => r.is_me).display_name).toMatch(/^Étudiant [0-9A-F]{4}$/);
        await setProfile(omar, { display_name: "Omar", name_mode: "pseudo" });
    });

    it("détail des notes : seulement si l'étudiant le partage, ou pour soi-même", async () => {
        const ninaKey = (await rowOf(omar, "Nina")).student_key;
        expect(await gradesOf(omar, ninaKey)).toEqual([]);
        expect(await gradesOf(outsider, ninaKey)).toEqual([]);
        const own = await gradesOf(nina, ninaKey);
        expect(own).toEqual([
            { subject_code: "R1.01", name: "Partiel", score: 8, max: 10, coeff: 1 },
            { subject_code: "R1.01", name: "TP noté", score: 14.5, max: 20, coeff: 2 }
        ]);

        await setProfile(nina, { show_grades: true });
        expect((await rowOf(omar, "Nina")).shares_grades).toBe(true);
        expect(await gradesOf(omar, ninaKey)).toEqual(own);
        // Un compte non inscrit ne voit rien, même si le détail est partagé
        expect(await gradesOf(outsider, ninaKey)).toEqual([]);
        expect(await gradesOf(omar, "cle-inexistante")).toEqual([]);
        await expect(asRole(db, null, (tx) => tx.query("select * from public.ranking_student_grades($1)", [ninaKey]))).rejects.toThrow(/permission denied/);

        await setProfile(nina, { show_grades: false });
        expect(await gradesOf(omar, ninaKey)).toEqual([]);
    });

    it("valeurs refusées par la base", async () => {
        const bad = [
            { origin: "inconnu" }, { track: "pirate" }, { name_mode: "autre" }, { class_name: "s1" }, { class_name: " S1" },
            { class_name: "S8" }, { class_name: "S1A" }, { td_group: "" }, { td_group: "TD3" }, { td_group: "td1" }, { student_number: "12 34" }, { student_number: "1".repeat(21) },
            { first_name: "Étudiant" }, { first_name: "x".repeat(31) }, { last_name: " Dupont" }
        ];
        for (const patch of bad) await expect(setProfile(paul, patch), JSON.stringify(patch)).rejects.toThrow(/ranking_profiles_details_check/);
        await setProfile(paul, { origin: "general", track: "indecis", class_name: "S7", td_group: "TD1", student_number: "A1234", first_name: "Paul", last_name: "Martin" });
        for (const c of ["S1", "S2", "S3", "S4", "S5", "S6", "S7"]) await setProfile(paul, { class_name: c });
        for (const g of ["TD1", "TD2"]) await setProfile(paul, { td_group: g });
    });

    it("on ne peut toujours modifier que son propre profil, et pas sa date ni son identifiant", async () => {
        const r = await asRole(db, omar, (tx) => tx.query("update public.ranking_profiles set show_grades = true, class_name = 'PIRATE' where user_id = $1", [nina]));
        expect(r.affectedRows).toBe(0);
        await expect(asRole(db, omar, (tx) => tx.query("update public.ranking_profiles set joined_at = now() where user_id = $1", [omar]))).rejects.toThrow(/permission denied/);
        await expect(asRole(db, omar, (tx) => tx.query("update public.ranking_profiles set user_id = $2 where user_id = $1", [omar, outsider]))).rejects.toThrow(/permission denied/);
    });

    it("modifier son profil déclenche le signal temps réel", async () => {
        const before = await pulseVersion(db);
        await setProfile(paul, { show_class: false });
        expect(await pulseVersion(db)).toBeGreaterThan(before);
    });
});

describe("mise à jour depuis la v1.0.1", () => {
    it("les inscrits existants gardent leur affichage ; l'ancien site continue de fonctionner", async () => {
        const old = await createDatabase({ ranking: false });
        await old.exec(RANKING_SQL_V1_0_1);
        const a = await createUser(old, "ancien-a@example.com");
        const b = await createUser(old, "ancien-b@example.com");
        await join(old, a, "Ancienne");
        await join(old, b);
        await addGrade(old, a, { subjectCode: "R1.01", score: 13.37, max: 20, coeff: 3, createdAt: 1 });
        await addGrade(old, a, { subjectCode: "SAE 1.02", score: 7.1, max: 10, coeff: 1, createdAt: 2 });
        await addGrade(old, b, { subjectCode: "R1.01", score: 9, max: 20, coeff: 1, createdAt: 1 });
        const before = await snapshot(old, a);

        await old.exec(RANKING_SQL);
        await old.exec(RANKING_SQL);

        const after = await snapshot(old, a);
        expect(after).toHaveLength(2);
        // Toutes les colonnes lues par le site v1.0.1 sont identiques
        const v1 = (rows) => rows.map(({ student_key, display_name, is_me, subject_averages, ue_averages, general_average }) => ({ student_key, display_name, is_me, subject_averages, ue_averages, general_average }));
        expect(v1(after)).toEqual(v1(before));
        for (const row of after) expect(row).toMatchObject({ origin: null, class_name: null, td_group: null, track: null, student_number: null, shares_grades: false });

        // Requêtes du site v1.0.1 : inscription (deux colonnes) et changement de pseudo
        const c = await createUser(old, "ancien-c@example.com");
        await join(old, c, "Arrivée après");
        await asRole(old, a, (tx) => tx.query("update public.ranking_profiles set display_name = 'Renommée' where user_id = $1", [a]));
        expect((await snapshot(old, a)).find((r) => r.is_me).display_name).toBe("Renommée");
        const profiles = await old.query("select count(*)::int as n from public.ranking_profiles");
        expect(profiles.rows[0].n).toBe(3);
        await old.close();
    });
});

describe("mise à jour depuis la v1.1.0", () => {
    it("les valeurs de la liste sont conservées, les saisies libres hors liste sont effacées, le reste ne bouge pas", async () => {
        const old = await createDatabase({ ranking: false });
        await old.exec(RANKING_SQL_V1_1_0);
        const a = await createUser(old, "v11-a@example.com");
        const b = await createUser(old, "v11-b@example.com");
        await join(old, a, "Dans la liste");
        await join(old, b, "Hors liste");
        await addGrade(old, a, { subjectCode: "R1.01", score: 13, max: 20, coeff: 1, createdAt: 1 });
        await addGrade(old, b, { subjectCode: "R1.01", score: 9, max: 20, coeff: 1, createdAt: 1 });
        await asRole(old, a, (tx) => tx.query("update public.ranking_profiles set class_name = 'S7', td_group = 'TD2', origin = 'sti2d', show_grades = true where user_id = $1", [a]));
        await asRole(old, b, (tx) => tx.query("update public.ranking_profiles set class_name = 'S1A', td_group = 'TD GROUPE 3', track = 'dacs', first_name = 'Bea' where user_id = $1", [b]));

        await old.exec(RANKING_SQL);
        await old.exec(RANKING_SQL);

        const rows = await old.query("select display_name, class_name, td_group, origin, track, first_name, show_grades from public.ranking_profiles order by display_name");
        expect(rows.rows).toEqual([
            { display_name: "Dans la liste", class_name: "S7", td_group: "TD2", origin: "sti2d", track: null, first_name: null, show_grades: true },
            { display_name: "Hors liste", class_name: null, td_group: null, origin: null, track: "dacs", first_name: "Bea", show_grades: false }
        ]);
        expect((await snapshot(old, a)).map((r) => [r.display_name, r.general_average])).toEqual([["Dans la liste", 13], ["Hors liste", 9]]);
        await old.close();
    });
});

describe("suppression de son compte", () => {
    it("supprime le compte, ses notes, devoirs, réglages et son profil ; les autres comptes sont intacts", async () => {
        const quitter = await createUser(db, "partant@example.com");
        const stayer = await createUser(db, "restant@example.com");
        await join(db, quitter, "Partant");
        await join(db, stayer, "Restant");
        await addGrade(db, quitter, { subjectCode: "R1.01", score: 12, max: 20, coeff: 1, createdAt: 1 });
        await addGrade(db, stayer, { subjectCode: "R1.01", score: 14, max: 20, coeff: 1, createdAt: 1 });
        await asRole(db, quitter, (tx) =>
            tx.query("insert into public.items (user_id, id, collection, data) values ($1, $2, 'homework', '{\"title\":\"DM\"}'), ($1, $3, 'settings', '{\"key\":\"k\",\"value\":1}')", [quitter, crypto.randomUUID(), crypto.randomUUID()])
        );
        const count = async (sql, user) => (await db.query(sql, [user])).rows[0].n;
        expect(await count("select count(*)::int as n from public.items where user_id = $1", quitter)).toBe(3);
        const pulse = await pulseVersion(db);

        await asRole(db, quitter, (tx) => tx.query("select public.ranking_delete_account()"));

        expect(await count("select count(*)::int as n from auth.users where id = $1", quitter)).toBe(0);
        expect(await count("select count(*)::int as n from public.items where user_id = $1", quitter)).toBe(0);
        expect(await count("select count(*)::int as n from public.ranking_profiles where user_id = $1", quitter)).toBe(0);
        expect(await count("select count(*)::int as n from auth.users where id = $1", stayer)).toBe(1);
        expect(await count("select count(*)::int as n from public.items where user_id = $1", stayer)).toBe(1);
        const names = (await snapshot(db, stayer)).map((r) => r.display_name);
        expect(names).toContain("Restant");
        expect(names).not.toContain("Partant");
        // Les autres écrans sont prévenus en direct
        expect(await pulseVersion(db)).toBeGreaterThan(pulse);
        // Le pseudo est de nouveau disponible
        await asRole(db, stayer, (tx) => tx.query("update public.ranking_profiles set display_name = 'Partant' where user_id = $1", [stayer]));
    });

    it("fonctionne aussi pour un compte non inscrit au classement ; refusé sans connexion", async () => {
        const lone = await createUser(db, "jamais-inscrit@example.com");
        await addGrade(db, lone, { subjectCode: "R1.02", score: 10, max: 20, coeff: 1 });
        const before = (await db.query("select count(*)::int as n from auth.users")).rows[0].n;
        await expect(asRole(db, null, (tx) => tx.query("select public.ranking_delete_account()"))).rejects.toThrow(/permission denied/);
        await asRole(db, lone, (tx) => tx.query("select public.ranking_delete_account()"));
        expect((await db.query("select count(*)::int as n from auth.users")).rows[0].n).toBe(before - 1);
        expect((await db.query("select count(*)::int as n from public.items where user_id = $1", [lone])).rows[0].n).toBe(0);
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
        expect(f.rows).toHaveLength(5);
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
