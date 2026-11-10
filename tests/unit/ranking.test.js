import { describe, it, expect } from "vitest";
import {
    CATEGORIES, GENERAL, categoryById, categoriesOfKind, normalizeSnapshot, buildLeaderboard, mySummary,
    valueFor, rankKey, ordinal, formatAverage, validateDisplayName
} from "../../js/ranking.js";

const student = (name, general, { ues = {}, subjects = {}, isMe = false } = {}) => ({ key: name, name, isMe, general, ues, subjects });

describe("catégories", () => {
    it("1 générale, 6 UE, 18 matières (12 ressources + 6 SAÉ)", () => {
        expect(categoriesOfKind("general")).toHaveLength(1);
        expect(categoriesOfKind("ue")).toHaveLength(6);
        expect(categoriesOfKind("subject")).toHaveLength(18);
        expect(CATEGORIES).toHaveLength(25);
        expect(new Set(CATEGORIES.map((c) => c.id)).size).toBe(25);
    });

    it("categoryById retombe sur la moyenne générale", () => {
        expect(categoryById("ue:UE 1.3").code).toBe("UE 1.3");
        expect(categoryById("subject:SAE 1.02").name).toBe("Comparaison d'approches algorithmiques");
        expect(categoryById("n'existe pas")).toBe(GENERAL);
        expect(categoryById(null)).toBe(GENERAL);
    });
});

describe("normalizeSnapshot", () => {
    it("écarte les lignes invalides et les valeurs non numériques", () => {
        const rows = [
            { student_key: "a", display_name: " Alice ", is_me: true, general_average: 12.5, ue_averages: { "UE 1.1": 12.5, "UE 1.2": "x" }, subject_averages: { "R1.01": 12.5, "R1.02": null } },
            { student_key: "b", display_name: "", is_me: "true", general_average: 9, ue_averages: null, subject_averages: [] },
            { student_key: "c", display_name: "Sans moyenne", general_average: null },
            { student_key: "d", display_name: "NaN", general_average: NaN },
            null,
            "texte"
        ];
        const students = normalizeSnapshot(rows);
        expect(students).toHaveLength(2);
        expect(students[0]).toMatchObject({ key: "a", name: "Alice", isMe: true, general: 12.5, ues: { "UE 1.1": 12.5 }, subjects: { "R1.01": 12.5 } });
        expect(students[1]).toMatchObject({ key: "b", name: "Étudiant", isMe: false, general: 9, ues: {}, subjects: {} });
        expect(normalizeSnapshot(null)).toEqual([]);
        expect(normalizeSnapshot({})).toEqual([]);
    });
});

describe("buildLeaderboard", () => {
    const students = [
        student("Chloé", 11.2, { ues: { "UE 1.1": 14 } }),
        student("Bob", 15.004, { ues: { "UE 1.1": 9 }, subjects: { "R1.01": 10 } }),
        student("Alice", 15.001, { isMe: true, subjects: { "R1.01": 18 } }),
        student("David", 17.5),
        student("Emma", 11.2)
    ];

    it("tri décroissant, rangs de compétition, ex æquo sur la moyenne affichée", () => {
        const board = buildLeaderboard(students, GENERAL);
        expect(board.rows.map((r) => [r.rank, r.student.name, r.tied])).toEqual([
            [1, "David", false],
            [2, "Alice", true],
            [2, "Bob", true],
            [4, "Chloé", true],
            [4, "Emma", true]
        ]);
        expect(board.count).toBe(5);
        expect(board.best).toBe(17.5);
        expect(board.mine.rank).toBe(2);
        expect(board.mean).toBeCloseTo((11.2 + 15.004 + 15.001 + 17.5 + 11.2) / 5, 10);
    });

    it("ne classe que les étudiants ayant la moyenne demandée", () => {
        const ue = buildLeaderboard(students, categoryById("ue:UE 1.1"));
        expect(ue.rows.map((r) => r.student.name)).toEqual(["Chloé", "Bob"]);
        expect(ue.mine).toBeNull();
        const subject = buildLeaderboard(students, categoryById("subject:R1.01"));
        expect(subject.rows.map((r) => [r.rank, r.student.name])).toEqual([[1, "Alice"], [2, "Bob"]]);
        expect(subject.mine.rank).toBe(1);
    });

    it("catégorie vide", () => {
        const board = buildLeaderboard(students, categoryById("subject:R1.12"));
        expect(board).toMatchObject({ rows: [], count: 0, mean: null, best: null, mine: null });
        expect(buildLeaderboard([], GENERAL).count).toBe(0);
    });

    it("ne modifie pas la liste reçue", () => {
        const copy = students.map((s) => s.name);
        buildLeaderboard(students, GENERAL);
        expect(students.map((s) => s.name)).toEqual(copy);
    });
});

describe("mySummary", () => {
    it("liste mes rangs dans chaque catégorie où j'ai une moyenne, dans l'ordre du programme", () => {
        const students = [
            student("Moi", 12, { isMe: true, ues: { "UE 1.2": 12, "UE 1.1": 8 }, subjects: { "SAE 1.01": 8, "R1.06": 12 } }),
            student("Autre", 14, { ues: { "UE 1.1": 14 }, subjects: { "SAE 1.01": 14 } })
        ];
        expect(mySummary(students).map((s) => [s.category.code, s.rank, s.count])).toEqual([
            ["Général", 2, 2],
            ["UE 1.1", 2, 2],
            ["UE 1.2", 1, 1],
            ["R1.06", 1, 1],
            ["SAE 1.01", 2, 2]
        ]);
        expect(mySummary([student("Autre", 14)])).toEqual([]);
    });
});

describe("affichage et saisie", () => {
    it("formatAverage, rankKey, ordinal, valueFor", () => {
        expect(formatAverage(12)).toBe("12.00");
        expect(formatAverage(9.999)).toBe("10.00");
        expect(formatAverage(null)).toBe("--");
        expect(rankKey(15.004)).toBe(15);
        expect(rankKey(15.006)).toBe(15.01);
        expect(ordinal(1)).toBe("1er");
        expect(ordinal(2)).toBe("2e");
        expect(valueFor(student("x", 10), categoryById("ue:UE 1.1"))).toBeNull();
    });

    it("validateDisplayName", () => {
        expect(validateDisplayName("")).toEqual({ ok: true, value: null });
        expect(validateDisplayName("   ")).toEqual({ ok: true, value: null });
        expect(validateDisplayName("  Tom   H  ")).toEqual({ ok: true, value: "Tom H" });
        expect(validateDisplayName("A").ok).toBe(false);
        expect(validateDisplayName("x".repeat(25)).ok).toBe(false);
        expect(validateDisplayName("étudiant 1234").ok).toBe(false);
        expect(validateDisplayName("Etudiant").ok).toBe(false);
    });
});

describe("profil, filtres et détail des notes (v1.1)", () => {
    const rows = [
        { student_key: "a", display_name: "Alice", is_me: true, general_average: 12, origin: "sti2d", class_name: "S3", td_group: "TD2", track: "racdv", student_number: null, shares_grades: true },
        { student_key: "b", display_name: "Bob", general_average: 14, origin: "general", class_name: "S3", td_group: "TD10", track: null, student_number: "22104567", shares_grades: false },
        { student_key: "c", display_name: "Chloé", general_average: 16, origin: "inconnu", class_name: "S5", td_group: " ", track: "dacs" },
        { student_key: "d", display_name: "Ancien site", general_average: 9 }
    ];

    it("normalizeSnapshot lit le profil, écarte les valeurs inconnues et reste compatible avec la v1.0", async () => {
        const { normalizeSnapshot: norm } = await import("../../js/ranking.js");
        const s = norm(rows);
        expect(s[0]).toMatchObject({ origin: "sti2d", className: "S3", tdGroup: "TD2", track: "racdv", studentNumber: null, sharesGrades: true });
        expect(s[1]).toMatchObject({ studentNumber: "22104567", sharesGrades: false, track: null });
        expect(s[2]).toMatchObject({ origin: null, tdGroup: null, track: "dacs" });
        expect(s[3]).toMatchObject({ origin: null, className: null, tdGroup: null, track: null, studentNumber: null, sharesGrades: false });
    });

    it("filterOptions : valeurs présentes, effectifs, tri naturel et libellés", async () => {
        const m = await import("../../js/ranking.js");
        const s = m.normalizeSnapshot(rows);
        const byId = Object.fromEntries(m.FILTERS.map((f) => [f.id, f]));
        expect(m.filterOptions(s, byId.className)).toEqual([{ value: "S3", count: 2, label: "S3" }, { value: "S5", count: 1, label: "S5" }]);
        expect(m.filterOptions(s, byId.tdGroup).map((o) => o.value)).toEqual(["TD2", "TD10"]);
        expect(m.filterOptions(s, byId.origin).map((o) => o.label)).toEqual(["Bac général", "STI2D"]);
        expect(m.filterOptions(s, byId.track).map((o) => o.label)).toEqual(["DACS", "RACDV"]);
        expect(m.filterOptions([], byId.className)).toEqual([]);
    });

    it("applyFilters combine les filtres ; un profil masqué ne correspond à aucune valeur", async () => {
        const m = await import("../../js/ranking.js");
        const s = m.normalizeSnapshot(rows);
        expect(m.applyFilters(s, {})).toBe(s);
        expect(m.applyFilters(s, { className: "S3" }).map((x) => x.name)).toEqual(["Alice", "Bob"]);
        expect(m.applyFilters(s, { className: "S3", origin: "sti2d" }).map((x) => x.name)).toEqual(["Alice"]);
        expect(m.applyFilters(s, { track: "racdv", className: "S5" })).toEqual([]);
        const board = m.buildLeaderboard(m.applyFilters(s, { className: "S3" }), m.GENERAL);
        expect(board.rows.map((r) => [r.rank, r.student.name])).toEqual([[1, "Bob"], [2, "Alice"]]);
        expect(board.mine.rank).toBe(2);
    });

    it("sanitizeFilters oublie les valeurs qui n'existent plus", async () => {
        const m = await import("../../js/ranking.js");
        const s = m.normalizeSnapshot(rows);
        expect(m.sanitizeFilters(s, { className: "S3", origin: "autre", inconnu: "x", track: "" })).toEqual({ className: "S3" });
        expect(m.sanitizeFilters(s, null)).toEqual({});
    });

    it("profileTags et libellés", async () => {
        const m = await import("../../js/ranking.js");
        const s = m.normalizeSnapshot(rows);
        expect(m.profileTags(s[0])).toEqual(["S3", "TD2", "STI2D", "RACDV"]);
        expect(m.profileTags(s[3])).toEqual([]);
        expect(m.originLabel("autre")).toBe("Autre");
        expect(m.trackLabel("nimporte")).toBeNull();
    });

    it("validateProfile : normalise, met les vides à null, applique les règles de la base", async () => {
        const { validateProfile } = await import("../../js/ranking.js");
        const ok = validateProfile({ displayName: " Tom ", firstName: " Tom ", lastName: "", nameMode: "real", studentNumber: "22 10 45", origin: "sti2d", className: "S3", tdGroup: "TD2", track: "", showClass: false, showGrades: true });
        expect(ok.ok).toBe(true);
        expect(ok.value).toEqual({
            displayName: "Tom", firstName: "Tom", lastName: null, nameMode: "real", studentNumber: "221045", origin: "sti2d", className: "S3", tdGroup: "TD2", track: null,
            showOrigin: true, showClass: false, showTdGroup: true, showTrack: true, showStudentNumber: false, showGrades: true
        });
        expect(validateProfile({}).value).toMatchObject({ displayName: null, firstName: null, nameMode: "pseudo", origin: null, showStudentNumber: false, showGrades: false, showOrigin: true });
        expect(validateProfile({ nameMode: "real" }).errors.nameMode).toBeTruthy();
        expect(validateProfile({ displayName: "x" }).errors.displayName).toBeTruthy();
        expect(validateProfile({ studentNumber: "12-34" }).errors.studentNumber).toBeTruthy();
        // Listes fermées : une valeur hors liste n'est jamais enregistrée
        expect(validateProfile({ className: "S8", tdGroup: "TD3" }).value).toMatchObject({ className: null, tdGroup: null });
        expect(validateProfile({ className: "s1", tdGroup: "td1" }).value).toMatchObject({ className: null, tdGroup: null });
        expect(validateProfile({ className: "S7", tdGroup: "TD1" }).value).toMatchObject({ className: "S7", tdGroup: "TD1" });
        expect(validateProfile({ firstName: "Étudiant" }).errors.firstName).toBeTruthy();
        expect(validateProfile({ origin: "pirate", track: "pirate" }).value).toMatchObject({ origin: null, track: null });
    });

    it("groupGrades regroupe par matière dans l'ordre du programme et écarte l'invalide", async () => {
        const { groupGrades, formatNumber } = await import("../../js/ranking.js");
        const grouped = groupGrades([
            { subject_code: "SAE 1.01", name: "Projet", score: 16, max: 20, coeff: 1 },
            { subject_code: "R1.01", name: "", score: 8, max: 10, coeff: 0.5 },
            { subject_code: "R1.01", name: "TP", score: 14.5, max: 20, coeff: 2 },
            { subject_code: "R1.01", name: "Cassé", score: "x", max: 20, coeff: 1 },
            { subject_code: "X9.99", name: "Inconnue", score: 1, max: 20, coeff: 1 },
            null
        ]);
        expect(grouped.map((g) => [g.code, g.grades.map((x) => x.name)])).toEqual([["R1.01", ["Évaluation", "TP"]], ["SAE 1.01", ["Projet"]]]);
        expect(groupGrades(null)).toEqual([]);
        expect(formatNumber(14.5)).toBe("14,5");
        expect(formatNumber(20)).toBe("20");
        expect(formatNumber(0.25)).toBe("0,25");
    });
});

describe("sauvegarde avant suppression du compte (v1.2)", () => {
    const rows = [
        { id: "7f8da7d3-7156-45ab-a8ff-3f9c54225ce2", collection: "grades", data: { name: "Partiel", subjectCode: "R1.01", score: 15.5, max: 20, coeff: 2, createdAt: 1790697565329 } },
        { id: "1feceb4f-66d2-48ac-bdc9-7106b98272ed", collection: "homework", data: { title: "DM de maths", type: "homework", dueDate: "2026-11-20", status: "todo" } },
        { id: "b278a795-e688-4357-ac31-f8ad1830d9b1", collection: "settings", data: { key: "lastSubject", value: "R1.01" } },
        { id: "c751f768-ac6a-4d70-8563-932a0ccede42", collection: "settings", data: { key: "edtUrl", value: "https://exemple.invalid/direct/?data=jeton-personnel" } },
        { id: "x", collection: "inconnue", data: { a: 1 } },
        { id: "y", collection: "grades", data: null },
        null
    ];

    it("format d'export v2 du gestionnaire, profil ajouté à part, lien d'emploi du temps exclu", async () => {
        const { buildBackup, backupFileName, BACKUP_FORMAT, CLASSES, TD_GROUPS } = await import("../../js/ranking.js");
        const now = Date.UTC(2026, 10, 10, 14, 30);
        const backup = buildBackup(rows, { displayName: "Tom", className: "S7" }, { now, version: "1.2.0" });
        expect(backup).toEqual({
            format: "gestionnaire-de-notes",
            version: 2,
            app: "classement-1.2.0",
            exportedAt: "2026-11-10T14:30:00.000Z",
            collections: {
                grades: [{ id: "7f8da7d3-7156-45ab-a8ff-3f9c54225ce2", name: "Partiel", subjectCode: "R1.01", score: 15.5, max: 20, coeff: 2, createdAt: 1790697565329 }],
                homework: [{ id: "1feceb4f-66d2-48ac-bdc9-7106b98272ed", title: "DM de maths", type: "homework", dueDate: "2026-11-20", status: "todo" }],
                settings: [{ key: "lastSubject", value: "R1.01" }]
            },
            conflicts: [],
            classement: { profil: { displayName: "Tom", className: "S7" } }
        });
        expect(JSON.stringify(backup)).not.toContain("jeton-personnel");
        expect(BACKUP_FORMAT).toBe("gestionnaire-de-notes");
        expect(backupFileName(now)).toBe("notes_BUT1_sauvegarde_2026-11-10.json");
        expect(buildBackup(null, null).collections).toEqual({ grades: [], homework: [], settings: [] });
        expect(CLASSES).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S7"]);
        expect(TD_GROUPS).toEqual(["TD1", "TD2"]);
    });
});
