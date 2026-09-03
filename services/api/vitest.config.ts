import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * These suites share one PostgreSQL database and each opens with TRUNCATE,
     * so they cannot run concurrently.
     *
     * The failure this prevents was subtle: the API suite truncates
     * `discrepancies` with CASCADE, and TRUNCATE CASCADE also empties every
     * table holding a foreign key to it -- which includes `discord_reports`,
     * whatever its ON DELETE action says. Run in parallel, that wiped the
     * reporter suite's rows mid-test, intermittently and only ever in
     * multi-file runs.
     */
    fileParallelism: false,
  },
});
