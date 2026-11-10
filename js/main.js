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
    KINDS, GENERAL, categoryById, categoriesOfKind, normalizeSnapshot, buildLeaderboard, mySummary,
    formatAverage, ordinal, validateDisplayName
} from "./ranking.js";

const CATEGORY_KEY = "student-ranking:category";
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

const config = readConfig();
const state = {
    session: null,
    profile: null,
    students: [],
    loaded: false,
    category: loadCategory(),
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
function selectCategory(category) {
    state.category = category;
    try {
        localStorage.setItem(CATEGORY_KEY, category.id);
    } catch {
        /* stockage indisponible : le choix n'est simplement pas mémorisé */
    }
    renderBoard();
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

function categoryChips() {
    if (state.category.kind === "general") return null;
    return h(
        "div",
        { class: "chips", role: "group", "aria-label": state.category.kind === "ue" ? "Unité d'enseignement" : "Matière" },
        categoriesOfKind(state.category.kind).map((category) => {
            const count = buildLeaderboard(state.students, category).count;
            return h(
                "button",
                {
                    type: "button",
                    class: `chip${count === 0 ? " empty" : ""}`,
                    "aria-pressed": String(category.id === state.category.id),
                    title: `${category.name} — ${count} classé${count > 1 ? "s" : ""}`,
                    onclick: () => selectCategory(category)
                },
                category.code
            );
        })
    );
}

function positionCard(board) {
    if (!board.mine) {
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

function boardList(board) {
    if (board.count === 0) {
        return h("p", { class: "empty-board" }, "Personne n'a encore de moyenne dans cette catégorie.");
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
            return h(
                "li",
                { class: `row${row.student.isMe ? " me" : ""}${changed ? " changed" : ""}`, dataset: { rank: String(row.rank) } },
                h("span", { class: `rank${row.rank <= 3 ? ` podium p${row.rank}` : ""}`, "aria-label": `${ordinal(row.rank)}${row.tied ? " ex æquo" : ""}` }, String(row.rank)),
                h("span", { class: "name" }, h("span", { class: "name-text" }, row.student.name), row.student.isMe ? h("span", { class: "badge" }, "Moi") : null),
                h("span", { class: "bar", "aria-hidden": "true" }, h("span", { style: `width:${Math.max(0, Math.min(100, (row.value / 20) * 100)).toFixed(1)}%` })),
                h("span", { class: "avg" }, display)
            );
        })
    );
    // Les autres catégories gardent leur dernière valeur connue
    for (const [id, value] of shown) if (!next.has(id) && !id.startsWith(`${board.category.id}|`)) next.set(id, value);
    shown = next;
    return list;
}

function summarySection() {
    const summary = mySummary(state.students);
    if (summary.length === 0) return null;
    return h(
        "details",
        { class: "card fold", open: true },
        h("summary", null, "Mes classements"),
        h(
            "ul",
            { class: "summary" },
            summary.map((item) =>
                h(
                    "li",
                    null,
                    h(
                        "button",
                        { type: "button", class: "summary-row", "aria-current": item.category.id === state.category.id ? "true" : null, onclick: () => selectCategory(item.category) },
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

function accountSection() {
    const error = errorBox();
    const save = h("button", { class: "btn", type: "submit" }, "Enregistrer");
    const form = h(
        "form",
        {
            class: "form inline",
            novalidate: true,
            onsubmit: async (event) => {
                event.preventDefault();
                const name = validateDisplayName(form.elements.pseudo.value);
                if (!name.ok) return showError(error, name.error);
                showError(error, "");
                try {
                    state.profile = await withBusy(save, () => api.rename(state.session.userId, name.value));
                    await refresh();
                } catch (e) {
                    showError(error, e.message);
                }
            }
        },
        field("pseudo", "Pseudo affiché", { name: "pseudo", type: "text", maxlength: 24, autocomplete: "nickname", value: state.profile.displayName || "", placeholder: "Vide = nom anonyme" }),
        save
    );
    return h(
        "details",
        { class: "card fold", id: "account" },
        h("summary", null, "Mon compte"),
        h("p", { class: "hint" }, `Connecté : ${state.session.email}`),
        form,
        error,
        h(
            "div",
            { class: "actions" },
            h(
                "button",
                {
                    class: "btn danger",
                    type: "button",
                    onclick: async () => {
                        if (!window.confirm("Quitter le classement ? Vos moyennes ne seront plus visibles des autres (vos notes ne sont pas touchées).")) return;
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
}

function renderBoard() {
    if (!state.loaded) {
        if (state.loadError) return renderFatal(state.loadError);
        return renderLoading("Chargement du classement…");
    }
    const board = buildLeaderboard(state.students, state.category);
    const accountOpen = !!(document.getElementById("account") && document.getElementById("account").open);
    const account = document.getElementById("account");
    const typing = account && account.contains(document.activeElement) && document.activeElement.tagName === "INPUT";
    const main = [
        state.loadError ? h("p", { class: "banner", role: "status" }, `Mise à jour impossible pour l'instant (${state.loadError}) — dernières données affichées.`) : null,
        kindTabs(),
        categoryChips(),
        h(
            "section",
            { class: "card" },
            h(
                "div",
                { class: "board-head" },
                h("div", null, h("h2", null, state.category.kind === "general" ? state.category.name : `${state.category.code} — ${state.category.name}`), h("p", { class: "hint", dataset: { testid: "count" } }, `${board.count} étudiant${board.count > 1 ? "s" : ""} classé${board.count > 1 ? "s" : ""} · mis à jour à ${state.lastUpdate.toLocaleTimeString("fr-FR")}`))
            ),
            positionCard(board),
            boardList(board)
        ),
        summarySection()
    ];
    if (typing) {
        // Ne pas remplacer le formulaire en cours de saisie : on ne met à jour que le classement
        while (root.firstChild && root.firstChild !== account) root.firstChild.remove();
        account.before(...main.filter(Boolean));
        return;
    }
    const nextAccount = accountSection();
    nextAccount.open = accountOpen;
    replace(root, main, nextAccount);
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
