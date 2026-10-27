/**
 * Merge reusable bullets from data/pending-skill-lessons.jsonl into
 * docs/trade-learnings.md (YOLO / paper section) and clear processed lines
 * into data/lesson-archive/.
 *
 * Usage: npx tsx scripts/merge-skill-lessons.ts [--dry]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PENDING = path.join(ROOT, "data", "pending-skill-lessons.jsonl");
const DOCS = path.join(ROOT, "docs", "trade-learnings.md");
const ARCHIVE_DIR = path.join(ROOT, "data", "lesson-archive");

interface Pending {
  id: string;
  at?: string;
  outcome?: string;
  symbol?: string;
  mint?: string;
  pnlPct?: number;
  holdSeconds?: number;
  lesson?: string;
  tags?: string[];
}

function loadPending(): Pending[] {
  if (!fs.existsSync(PENDING)) return [];
  return fs
    .readFileSync(PENDING, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Pending;
      } catch {
        return null;
      }
    })
    .filter((x): x is Pending => !!x && !!x.lesson);
}

function bullet(p: Pending): string {
  const tags = (p.tags ?? []).slice(0, 6).join(", ");
  const pnl =
    typeof p.pnlPct === "number"
      ? `${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct.toFixed(1)}%`
      : "?";
  const hold = p.holdSeconds != null ? `${p.holdSeconds}s` : "?";
  return `- **${p.symbol ?? p.id}** (${p.outcome ?? "?"}, ${pnl}, hold ${hold}${
    tags ? `; tags: ${tags}` : ""
  }): ${p.lesson}`;
}

function main(): void {
  const dry = process.argv.includes("--dry");
  const pending = loadPending();
  if (!pending.length) {
    console.log("No pending skill lessons to merge.");
    return;
  }

  const yoloish = pending.filter(
    (p) =>
      /YOLO|PAPER/i.test(p.symbol ?? "") ||
      /YOLO|PAPER/i.test(p.mint ?? "") ||
      (p.tags ?? []).some((t) => /paper|long|short/i.test(t))
  );
  const rest = pending.filter((p) => !yoloish.includes(p));

  const sectionLines = [
    "",
    `## YOLO / paper closes (merged ${new Date().toISOString().slice(0, 10)})`,
    "",
    "Auto-merged from `data/pending-skill-lessons.jsonl` via `npm run lessons:merge`.",
    "",
    ...yoloish.map(bullet),
    ...(rest.length
      ? ["", "### Other pending", "", ...rest.map(bullet)]
      : []),
    "",
  ];

  console.log(`Merging ${pending.length} lesson(s) → ${DOCS}`);
  for (const b of sectionLines) if (b.startsWith("-")) console.log(b);

  if (dry) {
    console.log("(dry run — docs not written, pending not archived)");
    return;
  }

  let docs = fs.existsSync(DOCS) ? fs.readFileSync(DOCS, "utf8") : "# Trade learnings\n";
  if (!docs.endsWith("\n")) docs += "\n";
  docs += sectionLines.join("\n");
  fs.writeFileSync(DOCS, docs, "utf8");

  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const archiveFile = path.join(
    ARCHIVE_DIR,
    `merged-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`
  );
  fs.writeFileSync(
    archiveFile,
    pending.map((p) => JSON.stringify(p)).join("\n") + "\n",
    "utf8"
  );
  fs.writeFileSync(PENDING, "", "utf8");
  console.log(`Wrote ${DOCS}`);
  console.log(`Archived → ${archiveFile}`);
  console.log("Cleared pending-skill-lessons.jsonl");
}

main();
