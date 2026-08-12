import fs from "node:fs";
import { parse } from "csv-parse/sync";
import { importGames } from "../database/db.js";

export function importGamesFromCsv(filePath: string): { inserted: number; skipped: number } {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Array<Record<string, string>>;

  const rows = records.map((row) => {
    const name =
      row.name ||
      row.Name ||
      row.game ||
      row.Game ||
      row.title ||
      row.Title ||
      Object.values(row)[0] ||
      "";
    const provider =
      row.provider || row.Provider || row.studio || row.Studio || row.vendor || row.Vendor || "";
    return { name: String(name), provider: provider ? String(provider) : null };
  });

  return importGames(rows);
}
