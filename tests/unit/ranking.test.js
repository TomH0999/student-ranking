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
        expect(normalizeSnapshot(rows)).toEqual([
            { key: "a", name: "Alice", isMe: true, general: 12.5, ues: { "UE 1.1": 12.5 }, subjects: { "R1.01": 12.5 } },
            { key: "b", name: "Étudiant", isMe: false, general: 9, ues: {}, subjects: {} }
        ]);
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
