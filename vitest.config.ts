import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // All test files share one Postgres DB and global rows (llm_usage day-row,
    // the jobs queue). Run files sequentially so a tick in one file can't claim
    // another's jobs or race its spend-cap accounting.
    fileParallelism: false,
  },
});
