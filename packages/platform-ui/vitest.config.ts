import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/platform-ui/test/**/*.test.tsx"],
    environment: "node",
    passWithNoTests: false,
  },
});
