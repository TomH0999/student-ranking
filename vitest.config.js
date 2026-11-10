import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/unit/**/*.test.js", "tests/sql/**/*.test.js"],
        environment: "node",
        testTimeout: 60000,
        hookTimeout: 60000
    }
});
