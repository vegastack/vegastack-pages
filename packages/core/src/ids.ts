export const idPrefixes = {
  user: "usr",
  authIdentity: "aid",
  workspace: "wks",
  folder: "fld",
  page: "pg",
  version: "ver",
  attachment: "att",
  thread: "thr",
  reply: "rpl",
  publication: "pub",
  agentSession: "agt",
  session: "ses",
  job: "job",
  auditLog: "aud",
  event: "evt",
  permission: "per",
  magicLink: "mlk",
  template: "tpl",
} as const;

export type IdPrefix = (typeof idPrefixes)[keyof typeof idPrefixes];

export function createId(
  prefix: IdPrefix,
  random = crypto.randomUUID(),
): string {
  const compact = random.replaceAll("-", "").slice(0, 32);
  return `${prefix}_${compact}`;
}

export function slugifyTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || "untitled";
}

export function makePageSlugId(title: string, pageId: string): string {
  const suffix = pageId.replace(/^pg_/, "").slice(0, 12);
  return `${slugifyTitle(title)}-${suffix}`;
}

export function makeFolderSlugId(title: string, folderId: string): string {
  const suffix = folderId.replace(/^fld_/, "").slice(0, 12);
  return `${slugifyTitle(title)}-${suffix}`;
}

export function parsePageSlugId(slugId: string): {
  titleSlug: string;
  shortId: string;
} {
  const lastDash = slugId.lastIndexOf("-");
  if (lastDash <= 0 || lastDash === slugId.length - 1) {
    throw new Error(`Invalid page slug id: ${slugId}`);
  }
  return {
    titleSlug: slugId.slice(0, lastDash),
    shortId: slugId.slice(lastDash + 1),
  };
}
