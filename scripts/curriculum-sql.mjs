/**
 * Génère les lignes SQL du programme (table public.ranking_curriculum) à partir de
 * js/curriculum-data.js (copie du gestionnaire de scolarité) et de js/program.js (S1).
 *
 *   node scripts/curriculum-sql.mjs            → affiche le bloc
 *   node scripts/curriculum-sql.mjs --write    → le remplace dans supabase/ranking.sql
 *
 * S1 : une seule « liste » par UE, dans l'ordre de COEFFICIENTS_UE (calcul d'origine).
 * S2 à S6 : modules et éléments dans l'ordre des MCCC.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { UE_TABLES } from "../js/curriculum-data.js";
import { PROGRAM_S1, COEFFICIENTS_UE } from "../js/program.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BEGIN = "-- BEGIN CURRICULUM (généré par scripts/curriculum-sql.mjs, ne pas modifier à la main)";
export const END = "-- END CURRICULUM";

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

export function curriculumRows() {
    const rows = [];
    PROGRAM_S1.ues.forEach((ue, u) => {
        Object.entries(COEFFICIENTS_UE[ue.code]).forEach(([subject, coef], i) => {
            rows.push([1, "*", ue.code, u + 1, u + 1, 1, 100, subject, i + 1, coef]);
        });
    });
    for (const sem of [2, 3, 4, 5, 6]) {
        const t = UE_TABLES[sem];
        const sets = t.common ? [["*", t.common]] : Object.entries(t.parcours);
        for (const [parcours, ues] of sets) {
            ues.forEach((ue, u) => {
                ue.modules.forEach((m, mi) => {
                    m.items.forEach(([subject, coef], i) => rows.push([sem, parcours, ue.code, u + 1, ue.competence, mi + 1, m.coef, subject, i + 1, coef]));
                });
            });
        }
    }
    return rows;
}

export function curriculumSql() {
    const values = curriculumRows().map((r) => `    (${r[0]}, ${q(r[1])}, ${q(r[2])}, ${r[3]}, ${r[4]}, ${r[5]}, ${r[6]}, ${q(r[7])}, ${r[8]}, ${r[9]})`);
    return `${BEGIN}
delete from public.ranking_curriculum;
insert into public.ranking_curriculum (semester, parcours, ue, ue_ord, competence, module_ord, module_coef, subject, item_ord, coef) values
${values.join(",\n")};
${END}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const block = curriculumSql();
    if (process.argv.includes("--write")) {
        const file = path.join(root, "supabase", "ranking.sql");
        const sql = readFileSync(file, "utf8");
        const a = sql.indexOf(BEGIN);
        const b = sql.indexOf(END);
        if (a < 0 || b < 0) throw new Error("Marqueurs BEGIN/END CURRICULUM introuvables dans ranking.sql");
        writeFileSync(file, sql.slice(0, a) + block + sql.slice(b + END.length));
        console.log(`ranking.sql : ${curriculumRows().length} lignes de programme`);
    } else console.log(block);
}
