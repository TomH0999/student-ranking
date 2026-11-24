/**
 * Logique pure du classement (aucun accès au DOM ni au réseau) : catégories,
 * tri, rangs avec ex æquo, récapitulatif personnel.
 *
 * Vues : « tous les semestres » (moyenne globale, compétences) ou un semestre S1 à S6
 * (moyenne générale, UE, matières).
 */
import { SUBJECTS, UE_TABLES } from "./curriculum-data.js";
import { COMPETENCES, PARCOURS, subjectInfo } from "./curriculum.js";

/** Affichage d'une moyenne, identique à l'application (2 décimales, point). */
export function formatAverage(value) {
    return value === null || value === undefined ? "--" : value.toFixed(2);
}

export const SEMESTERS = [1, 2, 3, 4, 5, 6];
/** Vues du classement : "all" (tous les semestres) ou un numéro de semestre. */
export const VIEWS = ["all", ...SEMESTERS];

export const GLOBAL = { id: "global", view: "all", kind: "general", code: "Global", name: "Moyenne globale (tous les semestres)" };

const competenceName = (id) => COMPETENCES.find((c) => c.id === id).name;

function semesterCategories(sem) {
    const general = { id: `general:${sem}`, view: sem, kind: "general", code: `S${sem}`, name: `Moyenne générale du semestre ${sem}` };
    // UE : à partir du S4, réunion des UE de tous les parcours (même code = même compétence)
    const t = UE_TABLES[sem];
    const lists = t.common ? [t.common] : Object.values(t.parcours);
    const ueCodes = [...new Set(lists.flatMap((l) => l.map((u) => u.code)))].sort();
    const ues = ueCodes.map((code) => ({ id: `ue:${code}`, view: sem, kind: "ue", code, name: competenceName(Number(code.split(".")[1])) }));
    const subjects = SUBJECTS.filter((x) => x.semester === sem)
        .sort((a, b) => (a.code.startsWith("R") === b.code.startsWith("R") ? 0 : a.code.startsWith("R") ? -1 : 1))
        .map((x) => ({ id: `subject:${x.code}`, view: sem, kind: "subject", code: x.code, name: x.name }));
    return [general, ...ues, ...subjects];
}

export const CATEGORIES = [
    GLOBAL,
    ...COMPETENCES.map((c) => ({ id: `competence:${c.id}`, view: "all", kind: "ue", code: `C${c.id}`, name: c.name, competence: c.id })),
    ...SEMESTERS.flatMap(semesterCategories)
];

/** Rétrocompatibilité : la moyenne générale du S1 s'appelait « general ». */
export const GENERAL = CATEGORIES.find((c) => c.id === "general:1");

export function kindsForView(view) {
    return view === "all"
        ? [
              { id: "general", label: "Globale" },
              { id: "ue", label: "Compétences" }
          ]
        : [
              { id: "general", label: "Générale" },
              { id: "ue", label: "UE" },
              { id: "subject", label: "Matières" }
          ];
}

/** Anciennes constantes (vue d'un semestre). */
export const KINDS = kindsForView(1);

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export function categoryById(id) {
    if (id === "general") return GENERAL;
    return BY_ID.get(id) || GLOBAL;
}

export function categoriesOfKind(kind, view = 1) {
    return CATEGORIES.filter((c) => c.kind === kind && c.view === view);
}

export function categoriesOfView(view) {
    return CATEGORIES.filter((c) => c.view === view);
}

export function viewLabel(view) {
    return view === "all" ? "Tous" : `S${view}`;
}

export function parcoursLabel(id) {
    const p = PARCOURS.find((x) => x.id === id);
    return p ? p.label : null;
}

/** Provenance (bac) et parcours visé en 2e année : identifiants stockés → libellés. */
export const ORIGINS = [
    { id: "general", label: "Bac général" },
    { id: "sti2d", label: "STI2D" },
    { id: "autre", label: "Autre" }
];

export const TRACKS = [
    { id: "racdv", label: "RACDV", name: "Réalisation d'applications : conception, développement, validation" },
    { id: "dacs", label: "DACS", name: "Déploiement d'applications communicantes et sécurisées" },
    { id: "aged", label: "AGED", name: "Administration, gestion et exploitation des données" },
    { id: "iamsi", label: "IAMSI", name: "Intégration d'applications et management du système d'information" },
    { id: "indecis", label: "Indécis", name: "Pas encore décidé" },
    { id: "autre", label: "Autre", name: "Autre projet" }
];

/** Classes et groupes TD : listes fermées (mêmes valeurs que la contrainte SQL). */
export const CLASSES = ["S1", "S2", "S3", "S4", "S5", "S6", "S7"];
export const TD_GROUPS = ["TD1", "TD2"];

const labelOf = (list, id) => {
    const item = list.find((x) => x.id === id);
    return item ? item.label : null;
};
export const originLabel = (id) => labelOf(ORIGINS, id);
export const trackLabel = (id) => labelOf(TRACKS, id);

const textOrNull = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const knownOrNull = (v, list) => (list.some((x) => x.id === v) ? v : null);

/**
 * Filtres du classement. Chaque filtre porte sur une information de profil ; un étudiant
 * qui masque cette information ne correspond à aucune valeur (il n'apparaît que sans filtre).
 */
export const FILTERS = [
    { id: "className", label: "Classe", all: "Toutes les classes", text: (v) => v },
    { id: "tdGroup", label: "Groupe TD", all: "Tous les groupes", text: (v) => v },
    { id: "origin", label: "Provenance", all: "Toutes les provenances", text: originLabel },
    { id: "track", label: "Parcours visé", all: "Tous les parcours", text: trackLabel }
];

/** Valeurs proposées pour un filtre : celles réellement présentes, avec leur effectif. */
export function filterOptions(students, filter) {
    const counts = new Map();
    for (const s of students) {
        const v = s[filter.id];
        if (v) counts.set(v, (counts.get(v) || 0) + 1);
    }
    return [...counts.entries()]
        .map(([value, count]) => ({ value, count, label: filter.text(value) || value }))
        .sort((a, b) => a.label.localeCompare(b.label, "fr", { numeric: true }));
}

/** Ne garde que les filtres dont la valeur existe encore (un profil a pu changer entre-temps). */
export function sanitizeFilters(students, selected) {
    const out = {};
    for (const filter of FILTERS) {
        const value = selected && selected[filter.id];
        if (value && students.some((s) => s[filter.id] === value)) out[filter.id] = value;
    }
    return out;
}

export function applyFilters(students, selected) {
    const active = FILTERS.filter((f) => selected && selected[f.id]);
    if (active.length === 0) return students;
    return students.filter((s) => active.every((f) => s[f.id] === selected[f.id]));
}

/** Étiquettes de profil affichées sous le nom, dans l'ordre : classe, groupe, provenance, parcours. */
export function profileTags(student) {
    return [student.className, student.tdGroup, originLabel(student.origin), trackLabel(student.track)].filter(Boolean);
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

function semesterMap(row) {
    const out = {};
    const src = row.semesters && typeof row.semesters === "object" && !Array.isArray(row.semesters) ? row.semesters : null;
    if (src) {
        for (const sem of SEMESTERS) {
            const v = src[String(sem)];
            if (!v || typeof v !== "object") continue;
            const general = finite(v.general);
            if (general === null) continue;
            out[sem] = { general, ues: numberMap(v.ues), subjects: numberMap(v.subjects) };
        }
    } else {
        // Base d'avant la v1.3 : seulement le S1, dans les colonnes historiques
        const general = finite(row.general_average);
        if (general !== null) out[1] = { general, ues: numberMap(row.ue_averages), subjects: numberMap(row.subject_averages) };
    }
    return out;
}

/** Moyenne simple, dans l'ordre donné (même calcul que le tableau de bord de l'application). */
function mean(values) {
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Assainit la réponse de ranking_snapshot() (jamais de confiance aveugle dans le réseau). */
export function normalizeSnapshot(rows) {
    if (!Array.isArray(rows)) return [];
    const students = [];
    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const semesters = semesterMap(row);
        const generals = SEMESTERS.filter((s) => semesters[s]).map((s) => semesters[s].general);
        if (generals.length === 0) continue;
        const competences = {};
        for (const c of COMPETENCES) {
            const values = [];
            for (const sem of SEMESTERS) {
                if (!semesters[sem]) continue;
                for (const [code, v] of Object.entries(semesters[sem].ues)) if (Number(code.split(".")[1]) === c.id) values.push(v);
            }
            const m = mean(values);
            if (m !== null) competences[c.id] = m;
        }
        const s1 = semesters[1] || { general: null, ues: {}, subjects: {} };
        students.push({
            key: String(row.student_key ?? students.length),
            name: typeof row.display_name === "string" && row.display_name.trim() ? row.display_name.trim() : "Étudiant",
            isMe: row.is_me === true,
            semesters,
            global: mean(generals),
            competences,
            parcours: row.is_me === true && PARCOURS.some((p) => p.id === row.parcours) ? row.parcours : null,
            // Raccourcis du S1 (anciennes versions)
            general: s1.general,
            ues: s1.ues,
            subjects: s1.subjects,
            // Profil : uniquement ce que l'étudiant a choisi d'afficher (le reste arrive à null)
            origin: knownOrNull(row.origin, ORIGINS),
            track: knownOrNull(row.track, TRACKS),
            className: textOrNull(row.class_name),
            tdGroup: textOrNull(row.td_group),
            studentNumber: textOrNull(row.student_number),
            sharesGrades: row.shares_grades === true
        });
    }
    return students;
}

/** Moyenne d'un étudiant dans une catégorie, ou null s'il n'en a pas. */
export function valueFor(student, category) {
    let v;
    if (category.id === "global") v = student.global;
    else if (category.competence) v = student.competences[category.competence];
    else {
        const sem = student.semesters[category.view];
        if (!sem) return null;
        v = category.kind === "general" ? sem.general : (category.kind === "ue" ? sem.ues : sem.subjects)[category.code];
    }
    return v === undefined || v === null ? null : v;
}

/** Semestres (1 à 6) où au moins un étudiant a une moyenne. */
export function semestersWithData(students) {
    return SEMESTERS.filter((s) => students.some((st) => st.semesters[s]));
}

/** Nom complet d'une matière, quel que soit son semestre. */
export function subjectLabel(code) {
    const info = subjectInfo(code);
    return info ? info.name : code;
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

/** Mes rangs dans les catégories d'une vue (par défaut : toutes) où j'ai une moyenne. */
export function mySummary(students, view = null) {
    const out = [];
    for (const category of view === null ? CATEGORIES : categoriesOfView(view)) {
        const board = buildLeaderboard(students, category);
        if (board.mine) out.push({ category, value: board.mine.value, rank: board.mine.rank, tied: board.mine.tied, count: board.count });
    }
    return out;
}

/** « 1er », « 2e », … */
export function ordinal(rank) {
    return rank === 1 ? "1er" : `${rank}e`;
}

const cleanText = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");

/**
 * Valide le formulaire de profil (mêmes règles que la base). Renvoie { ok, value, errors } ;
 * value est prêt à être enregistré (champs vides ou valeurs hors liste → null).
 */
export function validateProfile(input) {
    const errors = {};
    const pseudo = validateDisplayName(input.displayName);
    if (!pseudo.ok) errors.displayName = pseudo.error;

    const firstName = cleanText(input.firstName);
    const lastName = cleanText(input.lastName);
    if (firstName.length > 30) errors.firstName = "Prénom trop long (30 caractères maximum).";
    else if (/^[ée]tudiant/i.test(firstName)) errors.firstName = "Ce prénom est réservé.";
    if (lastName.length > 30) errors.lastName = "Nom trop long (30 caractères maximum).";

    const nameMode = input.nameMode === "real" ? "real" : "pseudo";
    if (nameMode === "real" && !firstName && !lastName) errors.nameMode = "Indiquez votre prénom ou votre nom pour l'afficher.";

    const studentNumber = cleanText(input.studentNumber).replace(/\s/g, "");
    if (studentNumber && !/^[0-9A-Za-z]{1,20}$/.test(studentNumber)) errors.studentNumber = "N° étudiant invalide (lettres et chiffres, 20 maximum).";

    const className = CLASSES.includes(input.className) ? input.className : null;
    const tdGroup = TD_GROUPS.includes(input.tdGroup) ? input.tdGroup : null;

    const ok = Object.keys(errors).length === 0;
    return {
        ok,
        errors,
        value: ok
            ? {
                  displayName: pseudo.value,
                  firstName: firstName || null,
                  lastName: lastName || null,
                  nameMode,
                  studentNumber: studentNumber || null,
                  origin: knownOrNull(input.origin, ORIGINS),
                  className,
                  tdGroup,
                  track: knownOrNull(input.track, TRACKS),
                  showOrigin: input.showOrigin !== false,
                  showClass: input.showClass !== false,
                  showTdGroup: input.showTdGroup !== false,
                  showTrack: input.showTrack !== false,
                  showStudentNumber: input.showStudentNumber === true,
                  showGrades: input.showGrades === true
              }
            : null
    };
}

/** Détail des notes partagées : assaini puis regroupé par matière, dans l'ordre du programme. */
export function groupGrades(rows) {
    const bySubject = new Map();
    if (Array.isArray(rows)) {
        for (const row of rows) {
            if (!row || typeof row !== "object") continue;
            const score = finite(row.score);
            const max = finite(row.max);
            const coeff = finite(row.coeff);
            if (score === null || max === null || coeff === null || max <= 0) continue;
            const code = String(row.subject_code);
            if (!bySubject.has(code)) bySubject.set(code, []);
            bySubject.get(code).push({ name: textOrNull(row.name) || "Évaluation", score, max, coeff });
        }
    }
    return SUBJECTS.filter((s) => bySubject.has(s.code)).map((s) => ({ code: s.code, name: s.name, semester: s.semester, grades: bySubject.get(s.code) }));
}

/** Même format que l'export du gestionnaire de scolarité : le fichier peut y être réimporté. */
export const BACKUP_FORMAT = "gestionnaire-de-notes";
/** Réglages jamais sauvegardés (lien d'emploi du temps : jeton personnel), comme dans l'application. */
const PRIVATE_SETTINGS = new Set(["edtUrl"]);

/**
 * Sauvegarde complète d'un compte avant suppression, à partir des lignes de la table `items`
 * ({ id, collection, data }) et du profil du classement. Notes, devoirs et réglages sont au
 * format d'export v2 du gestionnaire (Réglages → Importer) ; le profil est ajouté à part.
 */
export function buildBackup(rows, profile, { now = Date.now(), version = "" } = {}) {
    const collections = { grades: [], homework: [], settings: [] };
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row !== "object" || !row.data || typeof row.data !== "object") continue;
        if (row.collection === "grades" || row.collection === "homework") {
            collections[row.collection].push({ id: row.id, ...row.data });
        } else if (row.collection === "settings" && typeof row.data.key === "string" && !PRIVATE_SETTINGS.has(row.data.key)) {
            collections.settings.push({ key: row.data.key, value: row.data.value ?? null });
        }
    }
    return {
        format: BACKUP_FORMAT,
        version: 2,
        app: `classement-${version}`,
        exportedAt: new Date(now).toISOString(),
        collections,
        conflicts: [],
        classement: { profil: profile || null }
    };
}

export function backupFileName(now = Date.now()) {
    return `notes_BUT1_sauvegarde_${new Date(now).toISOString().slice(0, 10)}.json`;
}

/** Nombre affiché comme dans l'application : virgule française, sans zéros inutiles. */
export function formatNumber(value) {
    return String(Math.round(value * 100) / 100).replace(".", ",");
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
