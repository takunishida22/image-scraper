import fs from "node:fs";
import { parse } from "csv-parse/sync";
import { importGames } from "../database/db.js";
import type { ImportGameRow } from "../types.js";

function pick(row: Record<string, string>, keys: string[]): string {
  const normalized = new Map(
    Object.entries(row).map(([k, v]) => [k.replace(/^\uFEFF/, ""), v] as const),
  );
  for (const key of keys) {
    const value = normalized.get(key);
    if (value != null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) && !/^null$/i.test(value);
}

export function importGamesFromCsv(filePath: string): {
  inserted: number;
  skipped: number;
  updated: number;
} {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Array<Record<string, string>>;

  const rows: ImportGameRow[] = records.map((row) => {
    const name =
      pick(row, ["Name", "name", "game", "Game", "title", "Title"]) ||
      Object.values(row)[0] ||
      "";
    const provider = pick(row, [
      "ProviderId",
      "provider",
      "Provider",
      "studio",
      "Studio",
      "vendor",
      "Vendor",
    ]);
    const externalId = pick(row, ["Id", "id", "ExternalId", "external_id", "OriginalId"]);
    const imgUrl = pick(row, ["Img", "img", "Image", "image", "img_url"]);
    const imgVerticalUrl = pick(row, ["ImgVertical", "img_vertical", "ImgPortrait", "img_portrait"]);
    const imgWideUrl = pick(row, ["ImgWide", "img_wide", "ImgLandscape", "img_landscape"]);
    const imgSquareUrl = pick(row, ["ImgSquare", "img_square"]);

    return {
      name,
      provider: provider || null,
      externalId: externalId || null,
      imgUrl: isHttpUrl(imgUrl) ? imgUrl : null,
      imgVerticalUrl: isHttpUrl(imgVerticalUrl) ? imgVerticalUrl : null,
      imgWideUrl: isHttpUrl(imgWideUrl) ? imgWideUrl : null,
      imgSquareUrl: isHttpUrl(imgSquareUrl) ? imgSquareUrl : null,
    };
  });

  return importGames(rows);
}
