/**
 * Tests de bout en bout dans un vrai navigateur. Le client Supabase est remplacé par
 * tests/e2e/fake-supabase.js (le SQL réel est testé à part, dans tests/sql).
 */
import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-supabase.js");

const USERS = {
    "tom@example.com": { id: "tom", password: "secret-tom" },
    "lea@example.com": { id: "lea", password: "secret-lea" },
    "new@example.com": { id: "newbie", password: "secret-new" }
};

const STUDENTS = [
    { owner: "tom", general: 13.456, ues: { "UE 1.1": 14.2, "UE 1.2": 12.712 }, subjects: { "R1.01": 15.5, "SAE 1.01": 12 } },
    { owner: "lea", general: 15.1, ues: { "UE 1.1": 13 }, subjects: { "R1.01": 15.5 } },
    { owner: "max", general: 9.75, ues: { "UE 1.1": 9.75 }, subjects: { "R1.01": 8 } },
    { owner: "zoe", general: 18.2, ues: { "UE 1.3": 18.2 }, subjects: { "R1.03": 18.2 } }
];

const PROFILES = { tom: "Tom", lea: "Léa", max: null, zoe: "Zoé" };

async function open(page, { session = null, ...init } = {}) {
    await page.route("**/assets/vendor/supabase/supabase.js", (route) => route.fulfill({ path: FAKE, contentType: "text/javascript" }));
    await page.addInitScript(
        ({ init, session }) => {
            window.__FAKE_INIT = init;
            if (session && !sessionStorage.getItem("seeded")) {
                localStorage.setItem("gdn-supabase-auth", JSON.stringify(session));
                sessionStorage.setItem("seeded", "1");
            }
        },
        { init: { users: USERS, students: STUDENTS, profiles: PROFILES, ...init }, session }
    );
    await page.goto("./");
}

const asTom = { access_token: "t", user: { id: "tom", email: "tom@example.com" } };
const rows = (page) => page.locator(".board .row");
const rowTexts = async (page) => (await rows(page).allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());

test("connexion, puis classement général avec ma place", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("heading", { name: "Connexion" })).toBeVisible();

    await page.getByLabel("Adresse e-mail").fill("tom@example.com");
    await page.getByLabel("Mot de passe").fill("mauvais");
    await page.getByRole("button", { name: "Se connecter" }).click();
    await expect(page.getByRole("alert")).toHaveText("Adresse e-mail ou mot de passe incorrect.");

    await page.getByLabel("Mot de passe").fill("secret-tom");
    await page.getByRole("button", { name: "Se connecter" }).click();

    await expect(page.getByRole("heading", { name: "Moyenne générale" })).toBeVisible();
    await expect(rows(page)).toHaveCount(4);
    expect(await rowTexts(page)).toEqual(["1 Zoé 18.20", "2 Léa 15.10", "3 Tom MOI 13.46", "4 Étudiant MAX 9.75"]);
    await expect(page.getByTestId("my-rank")).toHaveText("3e / 4");
    await expect(page.getByTestId("count")).toContainText("4 étudiants classés");
    await expect(page.locator("#live")).toHaveText("En direct");
});

test("la session du gestionnaire de scolarité est reprise sans se reconnecter", async ({ page }) => {
    await open(page, { session: asTom });
    await expect(page.getByTestId("my-rank")).toHaveText("3e / 4");
    await expect(page.getByRole("heading", { name: "Connexion" })).toHaveCount(0);
});

test("classement par UE et par matière : seuls ceux qui ont la moyenne, ex æquo", async ({ page }) => {
    await open(page, { session: asTom });
    await page.getByRole("button", { name: "UE", exact: true }).click();
    await expect(page.getByRole("heading", { name: /UE 1\.1 — Réaliser un développement/ })).toBeVisible();
    expect(await rowTexts(page)).toEqual(["1 Tom MOI 14.20", "2 Léa 13.00", "3 Étudiant MAX 9.75"]);

    await page.getByRole("button", { name: "UE 1.3" }).click();
    expect(await rowTexts(page)).toEqual(["1 Zoé 18.20"]);
    await expect(page.getByText("Vous n'avez pas encore de moyenne ici")).toBeVisible();

    await page.getByRole("button", { name: "UE 1.6" }).click();
    await expect(page.getByText("Personne n'a encore de moyenne dans cette catégorie.")).toBeVisible();

    await page.getByRole("button", { name: "Matières" }).click();
    await expect(page.getByRole("heading", { name: /R1\.01 — Initiation au développement/ })).toBeVisible();
    expect(await rowTexts(page)).toEqual(["1 Léa 15.50", "1 Tom MOI 15.50", "3 Étudiant MAX 8.00"]);
    await expect(page.getByTestId("my-rank")).toHaveText("1er / 3");
    await expect(page.getByText("ex æquo")).toBeVisible();

    // La catégorie choisie est mémorisée
    await page.reload();
    await expect(page.getByRole("heading", { name: /R1\.01 — Initiation au développement/ })).toBeVisible();
});

test("temps réel : une note modifiée ailleurs met le classement à jour sans recharger", async ({ page }) => {
    await open(page, { session: asTom });
    await expect(page.getByTestId("my-rank")).toHaveText("3e / 4");

    await page.evaluate(() => {
        window.__fake.students.find((s) => s.owner === "tom").general = 16.8;
        window.__fake.students.push({ owner: "ines", general: 17, ues: {}, subjects: {} });
        window.__fake.setProfile("ines", { display_name: "Inès" });
        window.__fake.pulse();
    });

    await expect(page.getByTestId("my-rank")).toHaveText("3e / 5");
    expect(await rowTexts(page)).toEqual(["1 Zoé 18.20", "2 Inès 17.00", "3 Tom MOI 16.80", "4 Léa 15.10", "5 Étudiant MAX 9.75"]);
    await expect(page.locator(".row.me.changed")).toHaveCount(1);
});

test("temps réel : une rafale de signaux ne déclenche qu'un rechargement", async ({ page }) => {
    await open(page, { session: asTom });
    await expect(rows(page)).toHaveCount(4);
    await page.waitForTimeout(400);
    const before = await page.evaluate(() => window.__fake.calls.snapshot);
    await page.evaluate(() => {
        for (let i = 0; i < 25; i++) window.__fake.pulse();
    });
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => window.__fake.calls.snapshot)).toBe(before + 1);
});

test("direct coupé : indicateur, données conservées, rattrapage à la reconnexion", async ({ page }) => {
    await open(page, { session: asTom });
    await expect(page.locator("#live")).toHaveText("En direct");
    await page.evaluate(() => {
        window.__fake.failSnapshot = true;
        window.__fake.setStatus("CHANNEL_ERROR");
        window.__fake.pulse();
    });
    await expect(page.locator("#live")).toHaveText("Hors direct");
    await expect(page.getByText(/Mise à jour impossible pour l'instant/)).toBeVisible();
    await expect(rows(page)).toHaveCount(4);

    await page.evaluate(() => {
        window.__fake.failSnapshot = false;
        window.__fake.students.find((s) => s.owner === "tom").general = 19;
        window.__fake.setStatus("SUBSCRIBED");
    });
    await expect(page.locator("#live")).toHaveText("En direct");
    await expect(page.getByTestId("my-rank")).toHaveText("1er / 4");
    await expect(page.getByText(/Mise à jour impossible/)).toHaveCount(0);
});

test("premier passage : rejoindre le classement avec un pseudo, puis le changer", async ({ page }) => {
    await open(page, { students: [...STUDENTS, { owner: "newbie", general: 12, ues: {}, subjects: {} }] });
    await page.getByLabel("Adresse e-mail").fill("new@example.com");
    await page.getByLabel("Mot de passe").fill("secret-new");
    await page.getByRole("button", { name: "Se connecter" }).click();

    await expect(page.getByRole("heading", { name: "Rejoindre le classement" })).toBeVisible();
    await page.getByLabel("Pseudo (facultatif)").fill("tom");
    await page.getByRole("button", { name: "Rejoindre le classement" }).click();
    await expect(page.getByRole("alert")).toHaveText("Ce pseudo est déjà pris.");
    await page.getByLabel("Pseudo (facultatif)").fill("X");
    await page.getByRole("button", { name: "Rejoindre le classement" }).click();
    await expect(page.getByRole("alert")).toHaveText("Pseudo trop court (2 caractères minimum).");

    await page.getByLabel("Pseudo (facultatif)").fill("");
    await page.getByRole("button", { name: "Rejoindre le classement" }).click();
    await expect(page.locator(".row.me")).toContainText("Étudiant NEWB");
    await expect(page.getByTestId("my-rank")).toHaveText("4e / 5");

    await page.getByText("Mon profil", { exact: true }).click();
    await page.getByLabel("Pseudo", { exact: true }).fill("Nouvelle");
    await page.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.locator(".row.me")).toContainText("Nouvelle");
});

test("une mise à jour en direct n'efface pas le pseudo en cours de saisie", async ({ page }) => {
    await open(page, { session: asTom });
    await page.getByText("Mon profil", { exact: true }).click();
    await page.getByLabel("Pseudo", { exact: true }).fill("En cours de frappe");
    await page.evaluate(() => {
        window.__fake.students.find((s) => s.owner === "tom").general = 19.5;
        window.__fake.pulse();
    });
    await expect(page.getByTestId("my-rank")).toHaveText("1er / 4");
    await expect(page.getByLabel("Pseudo", { exact: true })).toHaveValue("En cours de frappe");
    await expect(page.getByLabel("Pseudo", { exact: true })).toBeFocused();
    await expect(page.locator(".tabs")).toHaveCount(1);
    await expect(page.locator(".board")).toHaveCount(1);
});

test("quitter le classement, puis se déconnecter", async ({ page }) => {
    await open(page, { session: asTom });
    await page.getByText("Mon profil", { exact: true }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Quitter le classement" }).click();
    await expect(page.getByRole("heading", { name: "Rejoindre le classement" })).toBeVisible();
    expect(await page.evaluate(() => window.__fake.profiles.has("tom"))).toBe(false);
    await expect(page.locator("#live")).toBeHidden();

    await page.getByRole("button", { name: "Se déconnecter" }).click();
    await expect(page.getByRole("heading", { name: "Connexion" })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("gdn-supabase-auth"))).toBeNull();
});

test("« Mes classements » récapitule mes rangs et sert de raccourci", async ({ page }) => {
    await open(page, { session: asTom });
    const summary = page.locator(".summary-row");
    await expect(summary).toHaveCount(5);
    await expect(summary.nth(0)).toContainText("Général");
    await expect(summary.nth(0)).toContainText("3e / 4");
    await expect(summary.nth(2)).toContainText("UE 1.2");
    await expect(summary.nth(2)).toContainText("12.71");
    await expect(summary.nth(2)).toContainText("1er / 1");
    await summary.nth(4).click();
    await expect(page.getByRole("heading", { name: /SAE 1\.01 — Implémentation/ })).toBeVisible();
});

test("SQL non installé : message explicite", async ({ page }) => {
    await open(page, { session: asTom, installed: false });
    await expect(page.getByRole("alert")).toContainText("Le classement n'est pas encore installé sur ce projet Supabase");
});

test("un pseudo ne peut pas injecter de HTML ; aucune erreur ni violation CSP", async ({ page }) => {
    const problems = [];
    page.on("console", (m) => {
        if (m.type() === "error") problems.push(m.text());
    });
    page.on("pageerror", (e) => problems.push(String(e)));
    await open(page, { session: asTom, profiles: { ...PROFILES, lea: "<img src=x onerror=alert(1)>" } });
    await expect(rows(page)).toHaveCount(4);
    await expect(rows(page).nth(1)).toContainText("<img src=x onerror=alert(1)>");
    await expect(page.locator(".board img")).toHaveCount(0);
    await page.getByRole("button", { name: "Matières" }).click();
    await page.getByText("Mon profil", { exact: true }).click();
    expect(problems).toEqual([]);
});

test("pas de défilement horizontal de la page", async ({ page }) => {
    await open(page, { session: asTom, profiles: { ...PROFILES, zoe: "Un pseudo vraiment long !!" } });
    await expect(rows(page)).toHaveCount(4);
    await page.getByRole("button", { name: "Matières" }).click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
});

test("déjà inscrit depuis un autre appareil : rejoindre met simplement le pseudo à jour", async ({ page }) => {
    await open(page, { students: [...STUDENTS, { owner: "newbie", general: 12, ues: {}, subjects: {} }] });
    await page.getByLabel("Adresse e-mail").fill("new@example.com");
    await page.getByLabel("Mot de passe").fill("secret-new");
    await page.getByRole("button", { name: "Se connecter" }).click();
    await expect(page.getByRole("heading", { name: "Rejoindre le classement" })).toBeVisible();
    await page.evaluate(() => window.__fake.setProfile("newbie", {}));
    await page.getByLabel("Pseudo (facultatif)").fill("Depuis ailleurs");
    await page.getByRole("button", { name: "Rejoindre le classement" }).click();
    await expect(page.locator(".row.me")).toContainText("Depuis ailleurs");
});

// ---------------------------------------------------------------------------
// v1.1 : profil personnalisable, filtres, fiche d'un étudiant
// ---------------------------------------------------------------------------
const RICH_PROFILES = {
    tom: { display_name: "Tom", origin: "sti2d", class_name: "S3", td_group: "TD2", track: "racdv" },
    lea: { display_name: "Léa", origin: "general", class_name: "S3", td_group: "TD1", track: "dacs", show_grades: true, student_number: "22104567", show_student_number: true },
    max: null,
    zoe: { display_name: "Zoé", origin: "general", class_name: "S5", td_group: "TD1", show_origin: false }
};
const RICH_STUDENTS = STUDENTS.map((s) =>
    s.owner === "lea"
        ? { ...s, grades: [{ subject_code: "R1.01", name: "Partiel", score: 15.5, max: 20, coeff: 2 }, { subject_code: "R1.01", name: "TP noté", score: 7.75, max: 10, coeff: 1 }] }
        : s.owner === "tom"
          ? { ...s, grades: [{ subject_code: "SAE 1.01", name: "Soutenance", score: 12, max: 20, coeff: 1 }] }
          : s
);
const rich = { session: asTom, profiles: RICH_PROFILES, students: RICH_STUDENTS };

test("un profil non renseigné s'affiche exactement comme avant (aucune étiquette, aucun filtre)", async ({ page }) => {
    await open(page, { session: asTom });
    await expect(rows(page)).toHaveCount(4);
    await expect(page.locator(".tags")).toHaveCount(0);
    await expect(page.locator(".filters")).toHaveCount(0);
});

test("les informations de profil affichées apparaissent sous le nom", async ({ page }) => {
    await open(page, rich);
    await expect(rows(page)).toHaveCount(4);
    await expect(rows(page).nth(1).locator(".tags")).toHaveText("S3 · TD1 · Bac général · DACS");
    await expect(rows(page).nth(0).locator(".tags")).toHaveText("S5 · TD1"); // provenance masquée
    await expect(rows(page).nth(3).locator(".tags")).toHaveCount(0);
});

test("filtrer par classe et par provenance : rangs recalculés dans la sélection", async ({ page }) => {
    await open(page, rich);
    await expect(page.getByTestId("my-rank")).toHaveText("3e / 4");

    await page.locator("#filter-className").selectOption("S3");
    expect((await rowTexts(page)).map((t) => t.split(" ").slice(0, 2).join(" "))).toEqual(["1 Léa", "2 Tom"]);
    await expect(page.getByTestId("my-rank")).toHaveText("2e / 2");
    await expect(page.getByTestId("count")).toContainText("2 étudiants classés dans la sélection");
    await expect(page.locator(".summary-row").first()).toContainText("2e / 2");

    await page.locator("#filter-origin").selectOption("general");
    expect((await rowTexts(page)).map((t) => t.split(" ").slice(0, 2).join(" "))).toEqual(["1 Léa"]);
    await expect(page.getByText("Vous ne faites pas partie de la sélection affichée")).toBeVisible();

    // Zoé masque sa provenance : elle n'est pas proposée par ce filtre
    await expect(page.locator("#filter-origin option")).toHaveText(["Toutes les provenances", "Bac général (1)", "STI2D (1)"]);

    // Le choix est mémorisé, puis effaçable
    await page.reload();
    await expect(rows(page)).toHaveCount(1);
    await page.getByRole("button", { name: "Tout afficher" }).click();
    await expect(rows(page)).toHaveCount(4);
    await expect(page.getByTestId("my-rank")).toHaveText("3e / 4");
});

test("un filtre dont la valeur disparaît est abandonné tout seul", async ({ page }) => {
    await open(page, rich);
    await page.locator("#filter-className").selectOption("S5");
    await expect(rows(page)).toHaveCount(1);
    await page.locator("#filter-className").blur();
    await page.evaluate(() => {
        window.__fake.setProfile("zoe", { show_class: false });
        window.__fake.pulse();
    });
    await expect(rows(page)).toHaveCount(4);
    await expect(page.locator("#filter-className")).toHaveValue("");
});

test("compléter son profil et choisir ce qui est affiché", async ({ page }) => {
    await open(page, { session: asTom });
    await page.getByText("Mon profil", { exact: true }).click();
    await page.locator("#first-name").fill("Tom");
    await page.locator("#last-name").fill("Durand");
    await page.getByLabel("Mon prénom et mon nom").check();
    await expect(page.locator("#class-name option")).toHaveText(["Non renseigné", "S1", "S2", "S3", "S4", "S5", "S6", "S7"]);
    await expect(page.locator("#td-group option")).toHaveText(["Non renseigné", "TD1", "TD2"]);
    await page.locator("#class-name").selectOption("S3");
    await page.locator("#td-group").selectOption("TD2");
    await page.locator("#origin").selectOption("sti2d");
    await page.locator("#track").selectOption("racdv");
    await page.locator("#student-number").fill("22 10 45 67");
    await page.locator("input[name=showTdGroup]").uncheck();
    await page.getByLabel("Le détail de mes notes").check();
    await page.getByRole("button", { name: "Enregistrer" }).click();

    await expect(page.getByText("Profil enregistré")).toBeVisible();
    await expect(page.locator(".row.me")).toContainText("Tom Durand");
    await expect(page.locator(".row.me .tags")).toHaveText("S3 · STI2D · RACDV");
    const saved = await page.evaluate(() => window.__fake.profiles.get("tom"));
    expect(saved).toMatchObject({
        first_name: "Tom", last_name: "Durand", name_mode: "real", class_name: "S3", td_group: "TD2", origin: "sti2d", track: "racdv",
        student_number: "22104567", show_td_group: false, show_student_number: false, show_grades: true, show_class: true
    });
    // Le formulaire reste ouvert et reflète ce qui est enregistré
    await expect(page.locator("#class-name")).toHaveValue("S3");
    await expect(page.locator("input[name=showTdGroup]")).not.toBeChecked();

    // Erreur de saisie : rien n'est envoyé
    await page.locator("#student-number").fill("12-34");
    await page.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.locator("#account").getByRole("alert")).toHaveText("N° étudiant invalide (lettres et chiffres, 20 maximum).");
});

test("une mise à jour en direct ne touche ni au profil en cours de saisie ni au focus", async ({ page }) => {
    await open(page, rich);
    await page.getByText("Mon profil", { exact: true }).click();
    await page.locator("#first-name").fill("Pas encore enregistré");
    await page.getByLabel("Le détail de mes notes").check();
    await page.locator("#last-name").focus();
    await page.evaluate(() => {
        window.__fake.students.find((s) => s.owner === "tom").general = 19.5;
        window.__fake.pulse();
    });
    await expect(page.getByTestId("my-rank")).toHaveText("1er / 4");
    await expect(page.locator("#first-name")).toHaveValue("Pas encore enregistré");
    await expect(page.getByLabel("Le détail de mes notes")).toBeChecked();
    await expect(page.locator("#last-name")).toBeFocused();
    await expect(page.locator("#account")).toHaveCount(1);

    // Focus au clavier dans le classement : conservé après une mise à jour
    await rows(page).nth(2).focus();
    await page.evaluate(() => window.__fake.pulse());
    await page.waitForTimeout(600);
    await expect(rows(page).nth(2)).toBeFocused();
});

test("fiche d'un étudiant : profil affiché, moyennes et rangs, détail des notes s'il est partagé", async ({ page }) => {
    await open(page, rich);
    await rows(page).nth(1).click();
    const sheet = page.locator("dialog[aria-labelledby=sheet-title]");
    await expect(sheet.getByRole("heading", { name: "Léa" })).toBeVisible();
    await expect(sheet.locator(".facts")).toContainText("ClasseS3");
    await expect(sheet.locator(".facts")).toContainText("N° étudiant22104567");
    await expect(sheet.locator(".summary.static li")).toHaveCount(3);
    await expect(sheet.locator(".summary.static li").first()).toContainText("2e / 4");
    await expect(sheet.locator(".grades li")).toHaveText(["Partielcoeff. 215,5 / 20", "TP notécoeff. 17,75 / 10"]);

    // Mise à jour en direct pendant que la fiche est ouverte
    await page.evaluate(() => {
        window.__fake.students.find((s) => s.owner === "lea").grades.push({ subject_code: "R1.02", name: "Maquette", score: 18, max: 20, coeff: 1 });
        window.__fake.pulse();
    });
    await expect(sheet.locator(".grades li")).toHaveCount(3);

    // Elle cesse de partager : le détail disparaît
    await page.evaluate(() => {
        window.__fake.setProfile("lea", { show_grades: false });
        window.__fake.pulse();
    });
    await expect(sheet.getByText("Cet étudiant ne partage pas le détail de ses notes.")).toBeVisible();
    await expect(sheet.locator(".grades")).toHaveCount(0);
    await sheet.getByRole("button", { name: "Fermer la fiche" }).click();
    await expect(sheet).toBeHidden();
});

test("fiche : sans partage, aucune note n'est demandée ; ma propre fiche montre mes notes à moi seul", async ({ page }) => {
    await open(page, rich);
    await rows(page).nth(0).click();
    const sheet = page.locator("dialog[aria-labelledby=sheet-title]");
    await expect(sheet.getByText("Cet étudiant ne partage pas le détail de ses notes.")).toBeVisible();
    await expect(sheet.locator(".facts")).not.toContainText("Provenance");
    expect(await page.evaluate(() => window.__fake.calls.grades)).toBe(0);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    await page.locator(".row.me").click();
    await expect(sheet.getByText("Visible par vous seul")).toBeVisible();
    await expect(sheet.locator(".grades li")).toHaveText(["Soutenancecoeff. 112 / 20"]);
});

test("nouveautés : pas de défilement horizontal, aucune erreur ni violation CSP", async ({ page }) => {
    const problems = [];
    page.on("console", (m) => {
        if (m.type() === "error") problems.push(m.text());
    });
    page.on("pageerror", (e) => problems.push(String(e)));
    await open(page, rich);
    await page.locator("#filter-className").selectOption("S3");
    await page.getByText("Mon profil", { exact: true }).click();
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await rows(page).nth(0).click();
    await expect(page.locator("dialog[aria-labelledby=sheet-title]")).toBeVisible();
    const sheetOverflow = await page.locator("dialog[aria-labelledby=sheet-title]").evaluate((d) => d.scrollWidth - d.clientWidth);
    expect(sheetOverflow).toBeLessThanOrEqual(0);
    expect(problems).toEqual([]);
});

// ---------------------------------------------------------------------------
// v1.2 : suppression du compte avec sauvegarde JSON automatique
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";

const TOM_ITEMS = [
    { user_id: "tom", id: "7f8da7d3-7156-45ab-a8ff-3f9c54225ce2", collection: "grades", data: { name: "Partiel", subjectCode: "R1.01", score: 15.5, max: 20, coeff: 2, createdAt: 2 } },
    { user_id: "tom", id: "1feceb4f-66d2-48ac-bdc9-7106b98272ed", collection: "grades", data: { name: "Soutenance", subjectCode: "SAE 1.01", score: 12, max: 20, coeff: 1, createdAt: 3 } },
    { user_id: "tom", id: "9c62d660-f3d5-4b4e-a7ca-d2b8fed63d8c", collection: "grades", data: { name: "Supprimée", subjectCode: "R1.02", score: 1, max: 20, coeff: 1 }, deleted_at: "2026-11-01T00:00:00Z" },
    { user_id: "tom", id: "b278a795-e688-4357-ac31-f8ad1830d9b1", collection: "homework", data: { title: "DM de maths", dueDate: "2026-11-20" } },
    { user_id: "tom", id: "c751f768-ac6a-4d70-8563-932a0ccede42", collection: "settings", data: { key: "edtUrl", value: "https://exemple.invalid/?data=jeton-personnel" } },
    { user_id: "tom", id: "75437c06-238b-4c9c-871d-0152b5046592", collection: "settings", data: { key: "lastSubject", value: "R1.01" } },
    { user_id: "lea", id: "72efeb5a-197d-4162-89aa-34d9f70d2d91", collection: "grades", data: { name: "Note de Léa", subjectCode: "R1.01", score: 19, max: 20, coeff: 1 } }
];
const withItems = { session: asTom, profiles: RICH_PROFILES, students: RICH_STUDENTS, items: TOM_ITEMS, users: USERS };

async function openDelete(page) {
    await page.getByText("Mon profil", { exact: true }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Supprimer mon compte…" }).click();
    return download;
}

test("supprimer son compte : sauvegarde JSON téléchargée automatiquement, puis suppression après confirmation", async ({ page }) => {
    await open(page, withItems);
    const download = await openDelete(page);
    const dialog = page.locator("dialog[aria-labelledby=delete-title]");
    await expect(dialog.getByText("Sauvegarde téléchargée")).toBeVisible();
    await expect(dialog).toContainText("2 notes, 1 devoir, 1 réglage et votre profil");

    // Le fichier : uniquement mes données vivantes, au format du gestionnaire, sans le lien d'emploi du temps
    expect(download.suggestedFilename()).toMatch(/^notes_BUT1_sauvegarde_\d{4}-\d{2}-\d{2}\.json$/);
    const backup = JSON.parse(readFileSync(await download.path(), "utf8"));
    expect(backup.format).toBe("gestionnaire-de-notes");
    expect(backup.version).toBe(2);
    expect(backup.collections.grades.map((g) => g.name)).toEqual(["Partiel", "Soutenance"]);
    expect(backup.collections.grades[0]).toEqual({ id: "7f8da7d3-7156-45ab-a8ff-3f9c54225ce2", name: "Partiel", subjectCode: "R1.01", score: 15.5, max: 20, coeff: 2, createdAt: 2 });
    expect(backup.collections.homework).toEqual([{ id: "b278a795-e688-4357-ac31-f8ad1830d9b1", title: "DM de maths", dueDate: "2026-11-20" }]);
    expect(backup.collections.settings).toEqual([{ key: "lastSubject", value: "R1.01" }]);
    expect(backup.classement.profil).toMatchObject({ displayName: "Tom", className: "S3", tdGroup: "TD2", origin: "sti2d", track: "racdv" });
    const text = JSON.stringify(backup);
    expect(text).not.toContain("jeton-personnel");
    expect(text).not.toContain("Note de Léa");
    expect(text).not.toContain("Supprimée");

    // Rien n'est supprimé tant que le mot n'est pas écrit
    const confirm = dialog.getByRole("button", { name: "Supprimer définitivement" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Pour confirmer, écrivez SUPPRIMER").fill("supprime");
    await expect(confirm).toBeDisabled();
    expect(await page.evaluate(() => window.__fake.deleted)).toEqual([]);
    await dialog.getByLabel("Pour confirmer, écrivez SUPPRIMER").fill("supprimer");
    await confirm.click();

    await expect(page.getByText("Votre compte et toutes ses données ont été supprimés de la base.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Connexion" })).toBeVisible();
    const after = await page.evaluate(() => ({
        deleted: window.__fake.deleted,
        mine: window.__fake.items.filter((r) => r.user_id === "tom").length,
        others: window.__fake.items.filter((r) => r.user_id === "lea").length,
        profile: window.__fake.profiles.has("tom"),
        session: localStorage.getItem("gdn-supabase-auth")
    }));
    expect(after).toEqual({ deleted: ["tom"], mine: 0, others: 1, profile: false, session: null });

    // Le compte n'existe plus
    await page.getByLabel("Adresse e-mail").fill("tom@example.com");
    await page.getByLabel("Mot de passe").fill("secret-tom");
    await page.getByRole("button", { name: "Se connecter" }).click();
    await expect(page.getByRole("alert")).toHaveText("Adresse e-mail ou mot de passe incorrect.");
});

test("suppression : annuler ne supprime rien ; « Télécharger à nouveau » redonne le fichier", async ({ page }) => {
    await open(page, withItems);
    await openDelete(page);
    const dialog = page.locator("dialog[aria-labelledby=delete-title]");
    const again = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Télécharger à nouveau" }).click();
    expect((await again).suggestedFilename()).toMatch(/^notes_BUT1_sauvegarde_/);
    await dialog.getByRole("button", { name: "Annuler" }).click();
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => ({ deleted: window.__fake.deleted, items: window.__fake.items.length, profile: window.__fake.profiles.has("tom") }))).toEqual({ deleted: [], items: 7, profile: true });
    await expect(rows(page)).toHaveCount(4);
});

test("suppression bloquée si la sauvegarde échoue, puis possible après un nouvel essai", async ({ page }) => {
    await open(page, withItems);
    await page.evaluate(() => {
        window.__fake.failExport = true;
    });
    await page.getByText("Mon profil", { exact: true }).click();
    await page.getByRole("button", { name: "Supprimer mon compte…" }).click();
    const dialog = page.locator("dialog[aria-labelledby=delete-title]");
    await expect(dialog.getByText(/Sauvegarde impossible/)).toBeVisible();
    await expect(dialog.getByLabel("Pour confirmer, écrivez SUPPRIMER")).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Supprimer définitivement" })).toBeDisabled();
    expect(await page.evaluate(() => window.__fake.deleted)).toEqual([]);

    await page.evaluate(() => {
        window.__fake.failExport = false;
    });
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Réessayer" }).click();
    await download;
    await expect(dialog.getByText("Sauvegarde téléchargée")).toBeVisible();
    await expect(dialog.getByLabel("Pour confirmer, écrivez SUPPRIMER")).toBeEnabled();
});

test("suppression : si la base refuse, le compte reste intact et l'erreur est affichée", async ({ page }) => {
    await open(page, withItems);
    await page.evaluate(() => {
        window.__fake.failDelete = true;
    });
    await openDelete(page);
    const dialog = page.locator("dialog[aria-labelledby=delete-title]");
    await dialog.getByLabel("Pour confirmer, écrivez SUPPRIMER").fill("SUPPRIMER");
    await dialog.getByRole("button", { name: "Supprimer définitivement" }).click();
    await expect(dialog.getByRole("alert")).toContainText("plus ancien que ce site");
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => ({ items: window.__fake.items.length, profile: window.__fake.profiles.has("tom"), session: !!localStorage.getItem("gdn-supabase-auth") }))).toEqual({ items: 7, profile: true, session: true });
});
