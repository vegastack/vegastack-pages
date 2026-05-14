import { getCollection, type CollectionEntry } from "astro:content";

export type DocEntry = CollectionEntry<"docs">;

export const CATEGORY_ORDER = [
  "Getting started",
  "Pages",
  "Sharing",
  "Agents",
  "Self-host",
] as const;

export interface DocCategory {
  name: string;
  entries: DocEntry[];
}

export async function loadDocs(): Promise<DocEntry[]> {
  const entries = await getCollection("docs");
  return entries.sort((a, b) => {
    const ca = CATEGORY_ORDER.indexOf(
      a.data.category as (typeof CATEGORY_ORDER)[number],
    );
    const cb = CATEGORY_ORDER.indexOf(
      b.data.category as (typeof CATEGORY_ORDER)[number],
    );
    if (ca !== cb) return ca - cb;
    if (a.data.order !== b.data.order) return a.data.order - b.data.order;
    return a.data.title.localeCompare(b.data.title);
  });
}

export function groupByCategory(entries: DocEntry[]): DocCategory[] {
  const grouped = new Map<string, DocEntry[]>();
  for (const entry of entries) {
    const bucket = grouped.get(entry.data.category) ?? [];
    bucket.push(entry);
    grouped.set(entry.data.category, bucket);
  }
  return CATEGORY_ORDER.filter((name) => grouped.has(name)).map((name) => ({
    name,
    entries: grouped.get(name) ?? [],
  }));
}

export function findAdjacent(entries: DocEntry[], currentId: string) {
  const idx = entries.findIndex((entry) => entry.id === currentId);
  return {
    prev: idx > 0 ? entries[idx - 1] : null,
    next: idx >= 0 && idx < entries.length - 1 ? entries[idx + 1] : null,
  };
}

export function docHref(entry: DocEntry): string {
  return `/docs/${entry.id}`;
}
