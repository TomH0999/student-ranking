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
        window.__fake.profiles.set("ines", "Inès");
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

    await page.getByText("Mon compte").click();
    await page.getByLabel("Pseudo affiché").fill("Nouvelle");
    await page.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.locator(".row.me")).toContainText("Nouvelle");
});

test("une mise à jour en direct n'efface pas le pseudo en cours de saisie", async ({ page }) => {
    await open(page, { session: asTom });
    await page.getByText("Mon compte").click();
    await page.getByLabel("Pseudo affiché").fill("En cours de frappe");
    await page.evaluate(() => {
        window.__fake.students.find((s) => s.owner === "tom").general = 19.5;
        window.__fake.pulse();
    });
    await expect(page.getByTestId("my-rank")).toHaveText("1er / 4");
    await expect(page.getByLabel("Pseudo affiché")).toHaveValue("En cours de frappe");
    await expect(page.getByLabel("Pseudo affiché")).toBeFocused();
    await expect(page.locator(".tabs")).toHaveCount(1);
    await expect(page.locator(".board")).toHaveCount(1);
});

test("quitter le classement, puis se déconnecter", async ({ page }) => {
    await open(page, { session: asTom });
    await page.getByText("Mon compte").click();
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
    await page.getByText("Mon compte").click();
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
    await page.evaluate(() => window.__fake.profiles.set("newbie", null));
    await page.getByLabel("Pseudo (facultatif)").fill("Depuis ailleurs");
    await page.getByRole("button", { name: "Rejoindre le classement" }).click();
    await expect(page.locator(".row.me")).toContainText("Depuis ailleurs");
});
