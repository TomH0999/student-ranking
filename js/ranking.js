/**
 * Logique pure du classement (aucun accès au DOM ni au réseau) : catégories,
 * tri, rangs avec ex æquo, récapitulatif personnel.
 */
import { PROGRAM_S1, ALL_SUBJECTS, isSae } from "./program.js";

/** Affichage d'une moyenne, identique à l'application (2 décimales, point). */
export function formatAverage(value) {
    return value === null || value === undefined ? "--" : value.toFixed(2);
}

export const GENERAL = { id: "general", kind: "general", code: "Général", name: "Moyenne générale" };

export const CATEGORIES = [
    GENERAL,
    ...PROGRAM_S1.ues.map((u) => ({ id: `ue:${u.code}`, kind: "ue", code: u.code, name: u.name })),
    ...ALL_SUBJECTS.map((s) => ({ id: `subject:${s.code}`, kind: "subject", code: s.code, name: s.name, sae: isSae(s.code) }))
];

export const KINDS = [
    { id: "general", label: "Générale" },
    { id: "ue", label: "UE" },
    { id: "subject", label: "Matières" }
];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export function categoryById(id) {
    return BY_ID.get(id) || GENERAL;
}

export function categoriesOfKind(kind) {
    return CATEGORIES.filter((c) => c.kind === kind);
}

const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function numberMap(obj) {
    const out = {};
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj)) {
            const n = finite(v);
            if (n !== null) out[k] = n;
        }
    }
    return out;
}

/** Assainit la réponse de ranking_snapshot() (jamais de confiance aveugle dans le réseau). */
export function normalizeSnapshot(rows) {
    if (!Array.isArray(rows)) return [];
    const students = [];
    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const general = finite(row.general_average);
        if (general === null) continue;
        students.push({
            key: String(row.student_key ?? students.length),
            name: typeof row.display_name === "string" && row.display_name.trim() ? row.display_name.trim() : "Étudiant",
            isMe: row.is_me === true,
            general,
            ues: numberMap(row.ue_averages),
            subjects: numberMap(row.subject_averages)
        });
    }
    return students;
}

/** Moyenne d'un étudiant dans une catégorie, ou null s'il n'en a pas. */
export function valueFor(student, category) {
    if (category.kind === "general") return student.general;
    const v = (category.kind === "ue" ? student.ues : student.subjects)[category.code];
    return v === undefined ? null : v;
}

/**
 * Clé de classement : la moyenne telle qu'elle est AFFICHÉE (2 décimales). Deux étudiants
 * qui voient la même moyenne à l'écran sont ex æquo, jamais départagés par une décimale invisible.
 */
export function rankKey(value) {
    return Number(value.toFixed(2));
}

/**
 * Classement d'une catégorie : seuls les étudiants qui ont cette moyenne y figurent.
 * Rangs « de compétition » : 1, 2, 2, 4.
 */
export function buildLeaderboard(students, category) {
    const rows = [];
    for (const student of students) {
        const value = valueFor(student, category);
        if (value !== null) rows.push({ student, value, key: rankKey(value) });
    }
    rows.sort((a, b) => b.key - a.key || a.student.name.localeCompare(b.student.name, "fr") || (a.student.key < b.student.key ? -1 : 1));
    let rank = 0;
    rows.forEach((row, i) => {
        if (i === 0 || row.key !== rows[i - 1].key) rank = i + 1;
        row.rank = rank;
    });
    rows.forEach((row, i) => {
        row.tied = (i > 0 && rows[i - 1].rank === row.rank) || (i < rows.length - 1 && rows[i + 1].rank === row.rank);
    });
    const count = rows.length;
    const mean = count ? rows.reduce((sum, r) => sum + r.value, 0) / count : null;
    return {
        category,
        rows,
        count,
        mean,
        best: count ? rows[0].value : null,
        mine: rows.find((r) => r.student.isMe) || null
    };
}

/** Mes rangs dans toutes les catégories où j'ai une moyenne. */
export function mySummary(students) {
    const out = [];
    for (const category of CATEGORIES) {
        const board = buildLeaderboard(students, category);
        if (board.mine) out.push({ category, value: board.mine.value, rank: board.mine.rank, tied: board.mine.tied, count: board.count });
    }
    return out;
}

/** « 1er », « 2e », … */
export function ordinal(rank) {
    return rank === 1 ? "1er" : `${rank}e`;
}

/** Valide un pseudo côté client (mêmes règles que la contrainte SQL). Renvoie { ok, value, error }. */
export function validateDisplayName(input) {
    const value = typeof input === "string" ? input.trim().replace(/\s+/g, " ") : "";
    if (!value) return { ok: true, value: null };
    if (value.length < 2) return { ok: false, error: "Pseudo trop court (2 caractères minimum)." };
    if (value.length > 24) return { ok: false, error: "Pseudo trop long (24 caractères maximum)." };
    if (/^[ée]tudiant/i.test(value)) return { ok: false, error: "Les pseudos commençant par « Étudiant » sont réservés." };
    return { ok: true, value };
}
