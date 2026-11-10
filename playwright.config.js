import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "tests/e2e",
    testMatch: "**/*.spec.js",
    fullyParallel: true,
    reporter: [["list"]],
    use: { baseURL: "http://127.0.0.1:4174/student-ranking/", locale: "fr-FR" },
    webServer: { command: "node tests/serve.mjs", url: "http://127.0.0.1:4174/student-ranking/", reuseExistingServer: true },
    projects: [
        { name: "desktop", use: { ...devices["Desktop Chrome"] } },
        { name: "mobile", use: { ...devices["Pixel 7"] } }
    ]
});
