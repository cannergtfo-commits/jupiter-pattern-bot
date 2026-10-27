/**
 * Backfill trade lessons for closed TP/SL positions missing from
 * data/trade-learnings.json and data/pending-skill-lessons.jsonl.
 * Idempotent by position id.
 *
 * Usage: npx tsx scripts/replay-learnings.ts
 */
import { backfillMissingLessons, LEARNINGS_PATH, PENDING_SKILL_LESSONS_PATH } from "../src/learning.js";

const result = backfillMissingLessons();
console.log(
  `Replay done: added=${result.added} skipped=${result.skipped} totalClosedTpSl=${result.totalClosed}`
);
console.log(`Learnings: ${LEARNINGS_PATH}`);
console.log(`Pending skill lessons: ${PENDING_SKILL_LESSONS_PATH}`);
