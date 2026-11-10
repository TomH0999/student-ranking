/**
 * Classement BUT1 — point d'entrée.
 *
 * États : non configuré → déconnecté → non inscrit → classement en direct.
 * Le classement est rechargé à chaque signal temps réel (table ranking_pulse), au retour
 * au premier plan, au retour du réseau, et toutes les 30 s tant que le direct est coupé.
 */
import { RANKING_VERSION } from "./version.js";
import { createApi } from "./api.js";
import { h, replace } from "./dom.js";
import {
    KINDS, GENERAL, CATEGORIES, ORIGINS, TRACKS, FILTERS, categoryById, categoriesOfKind, normalizeSnapshot,
    buildLeaderboard, mySummary, filterOptions, sanitizeFilters, applyFilters, profileTags, originLabel, trackLabel,
    groupGrades, formatAverage, formatNumber, ordinal, validateDisplayName, validateProfile
} from "./ranking.js";

const CATEGORY_KEY = "student-ranking:category";
const FILTERS_KEY = "student-ranking:filters";
const POLL_MS = 30000;
const DEBOUNCE_MS = 250;

const root = document.getElementById("app");
const liveEl = document.getElementById("live");
document.getElementById("version").textContent = `v${RANKING_VERSION}`;

function readConfig() {
    const c = window.RANKING_CONFIG || {};
    const text = (v) => (typeof v === "string" ? v.trim() : "");
    return { supabaseUrl: text(c.supabaseUrl), supabaseKey: text(c.supabaseKey), appUrl: text(c.appUrl) };
}

function loadCategory() {
    try {
        return categoryById(localStorage.getItem(CATEGORY_KEY));
    } catch {
        return GENERAL;
    }
}

function loadFilters() {
    try {
        const saved = JSON.parse(localStorage.getItem(FILTERS_KEY));
        return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    } catch {
        return {};
    }
}

const config = readConfig();
const state = {
    session: null,
    profile: null,
    students: [],
    loaded: false,
    category: loadCategory(),
    filters: loadFilters(),
    live: "connecting",
    lastUpdate: null,
    loadError: null
};
let api = null;
let refreshSeq = 0;
let refreshTimer = null;
let pollTimer = null;
let shown = new Map(); // « catégorie|étudiant » → moyenne affichée (pour signaler les changements)

// ---------------------------------------------------------------------------
// Petits composants
// ---------------------------------------------------------------------------
const card = (...children) => h("section", { class: "card" }, ...children);

function appLink(label = "Ouvrir le gestionnaire de scolarité") {
    return config.appUrl ? h("a", { class: "link", href: config.appUrl }, label) : null;
}

function field(id, label, attrs) {
    return h("label", { class: "field", for: id }, h("span", null, label), h("input", { id, ...attrs }));
}

function errorBox() {
    return h("p", { class: "form-error", role: "alert", hidden: true });
}

function showError(box, message) {
    box.textContent = message;
    box.hidden = !message;
}

async function withBusy(button, task) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Un instant…";
    try {
        return await task();
    } finally {
        button.disabled = false;
        button.textContent = label;
    }
}

function setLive(live) {
    state.live = live;
    const visible = !!(state.session && state.profile);
    liveEl.hidden = !visible;
    liveEl.dataset.state = live;
    liveEl.textContent = live === "live" ? "En direct" : live === "connecting" ? "Connexion…" : "Hors direct";
    liveEl.title =
        live === "live"
            ? "Le classement se met à jour tout seul, dès qu'une note change."
            : "Direct interrompu : le classement est rechargé toutes les 30 secondes.";
}

// ---------------------------------------------------------------------------
// Écrans hors classement
// ---------------------------------------------------------------------------
function renderUnconfigured() {
    replace(
        root,
        card(
            h("h2", null, "Configuration manquante"),
            h("p", null, "Renseignez l'adresse et la clé publique de votre projet Supabase dans ", h("code", null, "config.js"), " (les mêmes que dans le gestionnaire de scolarité), puis rechargez la page.")
        )
    );
}

function renderFatal(message) {
    replace(
        root,
        card(
            h("h2", null, "Classement indisponible"),
            h("p", { role: "alert" }, message),
            h("button", { class: "btn", type: "button", onclick: () => window.location.reload() }, "Réessayer")
        )
    );
}

function renderLoading(message = "Chargement…") {
    replace(root, h("p", { class: "loading", role: "status" }, message));
}

function renderSignIn() {
    const error = errorBox();
    const submit = h("button", { class: "btn primary", type: "submit" }, "Se connecter");
    const form = h(
        "form",
        {
            class: "form",
            novalidate: true,
            onsubmit: async (event) => {
                event.preventDefault();
                const email = form.elements.email.value.trim();
                const password = form.elements.password.value;
                if (!email || !password) return showError(error, "Indiquez votre adresse e-mail et votre mot de passe.");
                showError(error, "");
                try {
                    const session = await withBusy(submit, () => api.signIn(email, password));
                    await enter(session);
                } catch (e) {
                    showError(error, e.message);
                }
            }
        },
        field("email", "Adresse e-mail", { name: "email", type: "email", autocomplete: "username", required: true, inputmode: "email" }),
        field("password", "Mot de passe", { name: "password", type: "password", autocomplete: "current-password", required: true }),
        error,
        submit
    );
    replace(
        root,
        card(
            h("h2", null, "Connexion"),
            h("p", null, "Connectez-vous avec le compte de votre gestionnaire de scolarité : le classement utilise les notes que vous y avez saisies."),
            form,
            h("p", { class: "hint" }, "Pas encore de compte ? Créez-le dans le gestionnaire de scolarité (Réglages → Compte et synchronisation). ", appLink("Ouvrir l'application"))
        )
    );
}

function renderJoin() {
    const error = errorBox();
    const submit = h("button", { class: "btn primary", type: "submit" }, "Rejoindre le classement");
    const form = h(
        "form",
        {
            class: "form",
            novalidate: true,
            onsubmit: async (event) => {
                event.preventDefault();
                const name = validateDisplayName(form.elements.pseudo.value);
                if (!name.ok) return showError(error, name.error);
                showError(error, "");
                try {
                    state.profile = await withBusy(submit, () => api.join(state.session.userId, name.value));
                    await startBoard();
                } catch (e) {
                    showError(error, e.message);
                }
            }
        },
        field("pseudo", "Pseudo (facultatif)", { name: "pseudo", type: "text", maxlength: 24, autocomplete: "nickname", placeholder: "Laissez vide pour rester anonyme" }),
        error,
        submit
    );
    replace(
        root,
        card(
            h("h2", null, "Rejoindre le classement"),
            h("p", null, "En rejoignant le classement, vos moyennes (matières, UE et générale) deviennent visibles des autres inscrits, sous votre pseudo."),
            h(
                "ul",
                { class: "bullets" },
                h("li", null, "Vos notes détaillées et votre adresse e-mail ne sont jamais partagées."),
                h("li", null, "Sans pseudo, vous apparaissez sous un nom anonyme du type « Étudiant 4F2A »."),
                h("li", null, "Vous pourrez ensuite compléter votre profil (classe, groupe TD, provenance, parcours visé…) et choisir ce qui est affiché."),
                h("li", null, "Vous pouvez quitter le classement à tout moment.")
            ),
            form,
            h("p", { class: "hint" }, `Connecté : ${state.session.email}. `, h("button", { class: "link", type: "button", onclick: signOut }, "Se déconnecter"))
        )
    );
}

// ---------------------------------------------------------------------------
// Classement
// ---------------------------------------------------------------------------
function remember(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        /* stockage indisponible : le choix n'est simplement pas mémorisé */
    }
}

function selectCategory(category) {
    state.category = category;
    remember(CATEGORY_KEY, category.id);
    renderBoard(true);
}

function setFilter(id, value) {
    state.filters = { ...state.filters, [id]: value || undefined };
    remember(FILTERS_KEY, JSON.stringify(state.filters));
    renderBoard(true);
}

function kindTabs() {
    return h(
        "div",
        { class: "tabs", role: "group", "aria-label": "Type de moyenne" },
        KINDS.map((kind) =>
            h(
                "button",
                {
                    type: "button",
                    class: "tab",
                    dataset: { fid: `kind:${kind.id}` },
                    "aria-pressed": String(state.category.kind === kind.id),
                    onclick: () => {
                        if (state.category.kind !== kind.id) selectCategory(categoriesOfKind(kind.id)[0]);
                    }
                },
                kind.label
            )
        )
    );
}

function categoryChips(students) {
    if (state.category.kind === "general") return null;
    return h(
        "div",
        { class: "chips", role: "group", "aria-label": state.category.kind === "ue" ? "Unité d'enseignement" : "Matière" },
        categoriesOfKind(state.category.kind).map((category) => {
            const count = buildLeaderboard(students, category).count;
            return h(
                "button",
                {
                    type: "button",
                    class: `chip${count === 0 ? " empty" : ""}`,
                    dataset: { fid: `cat:${category.id}` },
                    "aria-pressed": String(category.id === state.category.id),
                    title: `${category.name} — ${count} classé${count > 1 ? "s" : ""}`,
                    onclick: () => selectCategory(category)
                },
                category.code
            );
        })
    );
}

/** Filtres par classe, groupe, provenance, parcours : seuls ceux qui ont des valeurs sont proposés. */
function filterBar() {
    const controls = [];
    for (const filter of FILTERS) {
        const options = filterOptions(state.students, filter);
        if (options.length === 0) continue;
        const id = `filter-${filter.id}`;
        controls.push(
            h(
                "label",
                { class: "filter", for: id },
                h("span", null, filter.label),
                h(
                    "select",
                    {
                        id,
                        dataset: { fid: id },
                        onchange: (event) => setFilter(filter.id, event.target.value),
                        onblur: () => {
                            if (pendingRender) renderBoard(true);
                        }
                    },
                    h("option", { value: "" }, filter.all),
                    options.map((o) => h("option", { value: o.value, selected: state.filters[filter.id] === o.value }, `${o.label} (${o.count})`))
                )
            )
        );
    }
    if (controls.length === 0) return null;
    const active = FILTERS.some((f) => state.filters[f.id]);
    return h(
        "div",
        { class: "filters", role: "group", "aria-label": "Filtrer le classement" },
        controls,
        active
            ? h(
                  "button",
                  {
                      type: "button",
                      class: "link filter-reset",
                      dataset: { fid: "filter-reset" },
                      onclick: () => {
                          state.filters = {};
                          remember(FILTERS_KEY, "{}");
                          renderBoard(true);
                      }
                  },
                  "Tout afficher"
              )
            : null
    );
}

function positionCard(board, filtered) {
    if (!board.mine) {
        const me = state.students.find((s) => s.isMe);
        if (filtered && me && buildLeaderboard([me], board.category).mine) {
            return h("div", { class: "position none" }, h("p", null, "Vous ne faites pas partie de la sélection affichée (ou vous masquez l'information filtrée dans votre profil)."));
        }
        return h(
            "div",
            { class: "position none" },
            h("p", null, board.category.kind === "general" ? "Vous n'avez pas encore de moyenne : " : "Vous n'avez pas encore de moyenne ici : ", "ajoutez une note dans le gestionnaire de scolarité et vous apparaîtrez aussitôt."),
            appLink()
        );
    }
    const { rank, value, tied } = board.mine;
    const gap = board.best - value;
    return h(
        "div",
        { class: "position" },
        h("div", { class: "stat" }, h("span", { class: "stat-label" }, "Ma place"), h("span", { class: "stat-value", dataset: { testid: "my-rank" } }, ordinal(rank), h("small", null, ` / ${board.count}`)), tied ? h("span", { class: "stat-note" }, "ex æquo") : null),
        h("div", { class: "stat" }, h("span", { class: "stat-label" }, "Ma moyenne"), h("span", { class: "stat-value" }, formatAverage(value))),
        h("div", { class: "stat" }, h("span", { class: "stat-label" }, "Moyenne des classés"), h("span", { class: "stat-value" }, formatAverage(board.mean))),
        h("div", { class: "stat" }, h("span", { class: "stat-label" }, "Écart avec le 1er"), h("span", { class: "stat-value" }, rank === 1 ? "—" : `−${gap.toFixed(2)}`))
    );
}

function boardList(board, filtered) {
    if (board.count === 0) {
        return h("p", { class: "empty-board" }, filtered ? "Aucun étudiant de cette sélection n'a de moyenne ici." : "Personne n'a encore de moyenne dans cette catégorie.");
    }
    const next = new Map();
    const list = h(
        "ol",
        { class: "board", "aria-label": `Classement — ${board.category.name}` },
        board.rows.map((row) => {
            const display = formatAverage(row.value);
            const id = `${board.category.id}|${row.student.key}`;
            next.set(id, display);
            const changed = shown.has(id) && shown.get(id) !== display;
            const tags = profileTags(row.student);
            return h(
                "li",
                null,
                h(
                    "button",
                    {
                        type: "button",
                        class: `row${row.student.isMe ? " me" : ""}${changed ? " changed" : ""}`,
                        dataset: { rank: String(row.rank), fid: `row:${row.student.key}` },
                        title: "Voir la fiche",
                        onclick: () => openStudent(row.student.key)
                    },
                    h("span", { class: `rank${row.rank <= 3 ? ` podium p${row.rank}` : ""}`, "aria-label": `${ordinal(row.rank)}${row.tied ? " ex æquo" : ""}` }, String(row.rank)),
                    h(
                        "span",
                        { class: "who" },
                        h("span", { class: "name" }, h("span", { class: "name-text" }, row.student.name), row.student.isMe ? h("span", { class: "badge" }, "Moi") : null),
                        tags.length ? h("span", { class: "tags" }, tags.join(" · ")) : null
                    ),
                    h("span", { class: "bar", "aria-hidden": "true" }, h("span", { style: `width:${Math.max(0, Math.min(100, (row.value / 20) * 100)).toFixed(1)}%` })),
                    h("span", { class: "avg" }, display)
                )
            );
        })
    );
    // Les autres catégories gardent leur dernière valeur connue
    for (const [id, value] of shown) if (!next.has(id) && !id.startsWith(`${board.category.id}|`)) next.set(id, value);
    shown = next;
    return list;
}

function summarySection(students, filtered) {
    const summary = mySummary(students);
    if (summary.length === 0) return null;
    const open = !document.getElementById("summary") || document.getElementById("summary").open;
    return h(
        "details",
        { class: "card fold", id: "summary", open },
        h("summary", { dataset: { fid: "summary" } }, filtered ? "Mes classements (sélection affichée)" : "Mes classements"),
        h(
            "ul",
            { class: "summary" },
            summary.map((item) =>
                h(
                    "li",
                    null,
                    h(
                        "button",
                        { type: "button", class: "summary-row", dataset: { fid: `sum:${item.category.id}` }, "aria-current": item.category.id === state.category.id ? "true" : null, onclick: () => selectCategory(item.category) },
                        h("span", { class: "summary-code" }, item.category.code),
                        h("span", { class: "summary-name" }, item.category.name),
                        h("span", { class: "summary-avg" }, formatAverage(item.value)),
                        h("span", { class: "summary-rank" }, ordinal(item.rank), h("small", null, ` / ${item.count}`))
                    )
                )
            )
        )
    );
}

// ---------------------------------------------------------------------------
// Fiche d'un étudiant
// ---------------------------------------------------------------------------
const dialog = h("dialog", { class: "sheet", "aria-labelledby": "sheet-title" });
document.body.append(dialog);
dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
});
dialog.addEventListener("close", () => {
    sheet.key = null;
});
const sheet = { key: null, grades: null, gradesError: null, seq: 0 };

function openStudent(key) {
    sheet.key = key;
    sheet.grades = null;
    sheet.gradesError = null;
    renderSheet();
    if (!dialog.open) dialog.showModal();
    loadSheetGrades();
}

async function loadSheetGrades() {
    const student = state.students.find((s) => s.key === sheet.key);
    if (!student || !(student.sharesGrades || student.isMe)) return;
    const seq = ++sheet.seq;
    try {
        const rows = await api.studentGrades(student.key);
        if (seq !== sheet.seq || sheet.key !== student.key) return;
        sheet.grades = groupGrades(rows);
        sheet.gradesError = null;
    } catch (e) {
        if (seq !== sheet.seq || sheet.key !== student.key) return;
        sheet.gradesError = e.message;
    }
    renderSheet();
}

function sheetAverages(student) {
    const rows = [];
    for (const category of CATEGORIES) {
        const board = buildLeaderboard(state.students, category);
        const mine = board.rows.find((r) => r.student.key === student.key);
        if (mine) rows.push(h("li", null, h("span", { class: "summary-code" }, category.code), h("span", { class: "summary-name" }, category.name), h("span", { class: "summary-avg" }, formatAverage(mine.value)), h("span", { class: "summary-rank" }, ordinal(mine.rank), h("small", null, ` / ${board.count}`))));
    }
    return h("ul", { class: "summary static" }, rows);
}

function sheetGrades(student) {
    if (!student.sharesGrades && !student.isMe) return h("p", { class: "hint" }, "Cet étudiant ne partage pas le détail de ses notes.");
    if (sheet.gradesError) return h("p", { class: "form-error", role: "alert" }, sheet.gradesError);
    if (sheet.grades === null) return h("p", { class: "hint", role: "status" }, "Chargement des notes…");
    if (sheet.grades.length === 0) return h("p", { class: "hint" }, "Aucune note.");
    return [
        student.isMe && !student.sharesGrades ? h("p", { class: "hint" }, "Visible par vous seul : vous ne partagez pas le détail de vos notes.") : null,
        sheet.grades.map((subject) =>
            h(
                "div",
                { class: "grades" },
                h("h4", null, h("span", { class: "summary-code" }, subject.code), " ", subject.name),
                h(
                    "ul",
                    null,
                    subject.grades.map((g) => h("li", null, h("span", { class: "grade-name" }, g.name), h("span", { class: "grade-coeff" }, `coeff. ${formatNumber(g.coeff)}`), h("span", { class: "grade-score" }, `${formatNumber(g.score)} / ${formatNumber(g.max)}`)))
                )
            )
        )
    ];
}

function renderSheet() {
    const student = state.students.find((s) => s.key === sheet.key);
    if (!student) {
        if (dialog.open) dialog.close();
        return;
    }
    const facts = [
        ["Classe", student.className],
        ["Groupe TD", student.tdGroup],
        ["Provenance", originLabel(student.origin)],
        ["Parcours visé", trackLabel(student.track)],
        ["N° étudiant", student.studentNumber]
    ].filter(([, value]) => value);
    replace(
        dialog,
        h(
            "div",
            { class: "sheet-head" },
            h("h2", { id: "sheet-title" }, student.name, student.isMe ? h("span", { class: "badge" }, "Moi") : null),
            h("button", { type: "button", class: "btn close", "aria-label": "Fermer la fiche", onclick: () => dialog.close() }, "Fermer")
        ),
        facts.length
            ? h("dl", { class: "facts" }, facts.map(([label, value]) => h("div", null, h("dt", null, label), h("dd", null, value))))
            : h("p", { class: "hint" }, student.isMe ? "Vous n'affichez aucune information de profil." : "Cet étudiant n'affiche aucune information de profil."),
        h("h3", null, "Moyennes et rangs"),
        sheetAverages(student),
        h("h3", null, "Détail des notes"),
        sheetGrades(student)
    );
}

// ---------------------------------------------------------------------------
// Mon profil
// ---------------------------------------------------------------------------
let accountEl = null;

function selectField(id, label, name, options, value) {
    return h(
        "label",
        { class: "field", for: id },
        h("span", null, label),
        h("select", { id, name }, h("option", { value: "" }, "Non renseigné"), options.map((o) => h("option", { value: o.id, selected: o.id === value, title: o.name || null }, o.name && o.name !== o.label ? `${o.label} — ${o.name}` : o.label)))
    );
}

function checkField(name, label, checked, hint = null) {
    return h("label", { class: "check" }, h("input", { type: "checkbox", name, checked }), h("span", null, label, hint ? h("small", null, hint) : null));
}

function buildAccount() {
    const p = state.profile;
    const wasOpen = !!(accountEl && accountEl.open);
    const error = errorBox();
    const saved = h("span", { class: "saved", role: "status", hidden: true }, "Profil enregistré");
    const save = h("button", { class: "btn primary", type: "submit" }, "Enregistrer");
    const form = h(
        "form",
        {
            class: "form profile",
            novalidate: true,
            oninput: () => {
                saved.hidden = true;
            },
            onsubmit: async (event) => {
                event.preventDefault();
                const f = form.elements;
                const result = validateProfile({
                    displayName: f.pseudo.value,
                    firstName: f.firstName.value,
                    lastName: f.lastName.value,
                    nameMode: f.nameMode.value,
                    studentNumber: f.studentNumber.value,
                    origin: f.origin.value,
                    className: f.className.value,
                    tdGroup: f.tdGroup.value,
                    track: f.track.value,
                    showOrigin: f.showOrigin.checked,
                    showClass: f.showClass.checked,
                    showTdGroup: f.showTdGroup.checked,
                    showTrack: f.showTrack.checked,
                    showStudentNumber: f.showStudentNumber.checked,
                    showGrades: f.showGrades.checked
                });
                if (!result.ok) return showError(error, Object.values(result.errors)[0]);
                showError(error, "");
                try {
                    state.profile = await withBusy(save, () => api.saveProfile(state.session.userId, result.value));
                    buildAccount();
                    accountEl.querySelector(".saved").hidden = false;
                    await refresh();
                } catch (e) {
                    showError(error, e.message);
                }
            }
        },
        h(
            "fieldset",
            null,
            h("legend", null, "Identité"),
            h(
                "div",
                { class: "grid" },
                field("pseudo", "Pseudo", { name: "pseudo", type: "text", maxlength: 24, autocomplete: "nickname", value: p.displayName || "", placeholder: "Vide = nom anonyme" }),
                field("first-name", "Prénom", { name: "firstName", type: "text", maxlength: 30, autocomplete: "given-name", value: p.firstName || "" }),
                field("last-name", "Nom", { name: "lastName", type: "text", maxlength: 30, autocomplete: "family-name", value: p.lastName || "" })
            ),
            h(
                "div",
                { class: "radios", role: "radiogroup", "aria-label": "Nom affiché dans le classement" },
                h("span", { class: "radios-label" }, "Nom affiché dans le classement"),
                h("label", { class: "check" }, h("input", { type: "radio", name: "nameMode", value: "pseudo", checked: p.nameMode !== "real" }), h("span", null, "Mon pseudo")),
                h("label", { class: "check" }, h("input", { type: "radio", name: "nameMode", value: "real", checked: p.nameMode === "real" }), h("span", null, "Mon prénom et mon nom"))
            )
        ),
        h(
            "fieldset",
            null,
            h("legend", null, "Scolarité"),
            h(
                "div",
                { class: "grid" },
                field("class-name", "Classe", { name: "className", type: "text", maxlength: 16, list: "known-classes", autocapitalize: "characters", value: p.className || "", placeholder: "ex. S1A" }),
                field("td-group", "Groupe TD", { name: "tdGroup", type: "text", maxlength: 16, list: "known-groups", autocapitalize: "characters", value: p.tdGroup || "", placeholder: "ex. TD2" }),
                selectField("origin", "Provenance", "origin", ORIGINS, p.origin),
                selectField("track", "Parcours visé en 2e année", "track", TRACKS, p.track),
                field("student-number", "N° étudiant", { name: "studentNumber", type: "text", maxlength: 20, inputmode: "numeric", autocomplete: "off", value: p.studentNumber || "" })
            ),
            h("datalist", { id: "known-classes" }),
            h("datalist", { id: "known-groups" })
        ),
        h(
            "fieldset",
            null,
            h("legend", null, "Ce que les autres inscrits voient"),
            h("p", { class: "hint" }, "Vos moyennes et votre nom affiché sont toujours visibles. Une information masquée ne sert pas non plus aux filtres."),
            h(
                "div",
                { class: "checks" },
                checkField("showClass", "Ma classe", p.showClass !== false),
                checkField("showTdGroup", "Mon groupe TD", p.showTdGroup !== false),
                checkField("showOrigin", "Ma provenance", p.showOrigin !== false),
                checkField("showTrack", "Mon parcours visé", p.showTrack !== false),
                checkField("showStudentNumber", "Mon n° étudiant", p.showStudentNumber === true),
                checkField("showGrades", "Le détail de mes notes", p.showGrades === true, "Chaque évaluation avec sa note, son barème et son coefficient")
            )
        ),
        error,
        h("div", { class: "actions" }, save, saved)
    );
    const next = h(
        "details",
        { class: "card fold", id: "account", open: wasOpen },
        h("summary", null, "Mon profil"),
        h("p", { class: "hint" }, `Connecté : ${state.session.email}. Tout est facultatif.`),
        form,
        h(
            "div",
            { class: "actions end" },
            h(
                "button",
                {
                    class: "btn danger",
                    type: "button",
                    onclick: async () => {
                        if (!window.confirm("Quitter le classement ? Vos moyennes et votre profil ne seront plus visibles des autres (vos notes ne sont pas touchées).")) return;
                        try {
                            await api.leave(state.session.userId);
                            stopBoard();
                            state.profile = null;
                            renderJoin();
                        } catch (e) {
                            showError(error, e.message);
                        }
                    }
                },
                "Quitter le classement"
            ),
            h("button", { class: "btn", type: "button", onclick: signOut }, "Se déconnecter")
        ),
        h("p", { class: "hint" }, "Se déconnecter ici déconnecte aussi le gestionnaire de scolarité sur cet appareil lorsqu'ils sont hébergés sur le même site.")
    );
    if (accountEl && accountEl.parentNode) accountEl.replaceWith(next);
    accountEl = next;
    fillSuggestions();
}

/** Classes et groupes déjà utilisés par d'autres : proposés à la saisie pour éviter les variantes. */
function fillSuggestions() {
    if (!accountEl) return;
    for (const [id, key] of [["known-classes", "className"], ["known-groups", "tdGroup"]]) {
        const list = accountEl.querySelector(`#${id}`);
        const values = [...new Set(state.students.map((s) => s[key]).filter(Boolean))].sort();
        replace(list, values.map((value) => h("option", { value })));
    }
}

let pendingRender = false;

function renderBoard(force = false) {
    if (!state.loaded) {
        if (state.loadError) return renderFatal(state.loadError);
        return renderLoading("Chargement du classement…");
    }
    // Ne pas refermer une liste de filtre ouverte : la mise à jour attend la fin du choix
    const active = document.activeElement;
    if (!force && active && active.tagName === "SELECT" && active.closest(".filters")) {
        pendingRender = true;
        return;
    }
    pendingRender = false;
    const focusId = active && root.contains(active) && active.dataset ? active.dataset.fid : null;

    state.filters = sanitizeFilters(state.students, state.filters);
    const filtered = FILTERS.some((f) => state.filters[f.id]);
    const students = applyFilters(state.students, state.filters);
    const board = buildLeaderboard(students, state.category);
    const main = [
        state.loadError ? h("p", { class: "banner", role: "status" }, `Mise à jour impossible pour l'instant (${state.loadError}) — dernières données affichées.`) : null,
        kindTabs(),
        categoryChips(students),
        filterBar(),
        h(
            "section",
            { class: "card" },
            h(
                "div",
                { class: "board-head" },
                h("div", null, h("h2", null, state.category.kind === "general" ? state.category.name : `${state.category.code} — ${state.category.name}`), h("p", { class: "hint", dataset: { testid: "count" } }, `${board.count} étudiant${board.count > 1 ? "s" : ""} classé${board.count > 1 ? "s" : ""}${filtered ? " dans la sélection" : ""} · mis à jour à ${state.lastUpdate.toLocaleTimeString("fr-FR")}`))
            ),
            positionCard(board, filtered),
            boardList(board, filtered)
        ),
        summarySection(students, filtered)
    ].filter(Boolean);

    // Le profil reste en place (saisie en cours, focus) : seul le classement est remplacé
    if (!accountEl) buildAccount();
    if (accountEl.parentNode !== root) replace(root, main, accountEl);
    else {
        while (root.firstChild !== accountEl) root.firstChild.remove();
        accountEl.before(...main);
    }
    fillSuggestions();
    if (focusId) {
        const target = root.querySelector(`[data-fid="${CSS.escape(focusId)}"]`);
        if (target) target.focus({ preventScroll: true });
    }
    if (dialog.open) renderSheet();
}

// ---------------------------------------------------------------------------
// Données
// ---------------------------------------------------------------------------
async function refresh() {
    if (!api || !state.session || !state.profile) return;
    const seq = ++refreshSeq;
    try {
        const rows = await api.snapshot();
        if (seq !== refreshSeq) return;
        state.students = normalizeSnapshot(rows);
        state.loaded = true;
        state.loadError = null;
        state.lastUpdate = new Date();
        if (dialog.open) loadSheetGrades();
    } catch (e) {
        if (seq !== refreshSeq) return;
        if (e.kind === "auth") return signedOut();
        state.loadError = e.message;
    }
    renderBoard();
}

function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, DEBOUNCE_MS);
}

async function startBoard() {
    state.loaded = false;
    state.loadError = null;
    shown = new Map();
    setLive("connecting");
    renderBoard();
    api.subscribe(scheduleRefresh, (live) => {
        setLive(live);
        // À chaque (re)connexion : rattraper ce qui a pu changer entre-temps
        if (live === "live") scheduleRefresh();
    });
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
        if (state.live !== "live" && document.visibilityState === "visible") refresh();
    }, POLL_MS);
    await refresh();
}

function stopBoard() {
    refreshSeq++;
    clearTimeout(refreshTimer);
    clearInterval(pollTimer);
    if (api) api.unsubscribe();
    state.students = [];
    state.loaded = false;
    liveEl.hidden = true;
    accountEl = null;
    pendingRender = false;
    if (dialog.open) dialog.close();
}

async function enter(session) {
    if (state.session && state.session.userId === session.userId && state.profile) return;
    stopBoard();
    state.session = session;
    state.profile = null;
    renderLoading();
    try {
        state.profile = await api.fetchProfile(session.userId);
    } catch (e) {
        if (e.kind === "auth") return signedOut();
        return renderFatal(e.message);
    }
    if (state.session !== session) return;
    if (state.profile) await startBoard();
    else renderJoin();
}

function signedOut() {
    stopBoard();
    state.session = null;
    state.profile = null;
    renderSignIn();
}

async function signOut() {
    await api.signOut();
    signedOut();
}

async function boot() {
    if (!config.supabaseUrl || !config.supabaseKey) return renderUnconfigured();
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
        return renderFatal("La bibliothèque Supabase n'a pas pu être chargée. Rechargez la page.");
    }
    renderLoading();
    api = createApi(config);
    let session = null;
    try {
        session = await api.getSession();
    } catch {
        session = null;
    }
    if (session) await enter(session);
    else renderSignIn();

    // Connexion ou déconnexion faite ailleurs (autre onglet, gestionnaire de scolarité)
    api.onAuthChange((next, event) => {
        if (!next) {
            if (state.session && event === "SIGNED_OUT") signedOut();
        } else if (!state.session || state.session.userId !== next.userId) {
            enter(next);
        }
    });
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") scheduleRefresh();
    });
    window.addEventListener("online", scheduleRefresh);
}

boot();
