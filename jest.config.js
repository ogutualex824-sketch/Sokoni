/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  testMatch: [
    "**/functions/test/**/*.test.js",
  ],
  testPathIgnorePatterns: [
    "/node_modules/",
    "/.claude/",
    "/tests/e2e/",
    /* Self-contained Node.js test scripts — run directly with `node`, not Jest */
    "functions/test/algolia-sync.test.js",
    "functions/test/search-worker.test.js",
    "functions/test/search-monitor.test.js",
  ],
  collectCoverageFrom: [
    "functions/index.js",
  ],
};
