import { AppError } from "@vegastack/pages-core";

const defaultPublicationPasswordMinLength = 8;

export function publicationPasswordMinLength() {
  const configured = Number(process.env.VPG_PUBLIC_LINK_PASSWORD_MIN_LENGTH);
  return Number.isFinite(configured) &&
    configured >= defaultPublicationPasswordMinLength
    ? Math.floor(configured)
    : defaultPublicationPasswordMinLength;
}

export function assertPublicationPasswordPolicy(password: string | null) {
  if (!password) return;
  const minLength = publicationPasswordMinLength();
  if (password.length < minLength) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Publication password must be at least ${minLength} characters.`,
      400,
    );
  }
}
