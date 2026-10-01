import {
  CANONICAL_NAVIGATION,
  type CanonicalNavSection
} from "@simulatorlife/autodev-core";

const LEADING_SLASHES = /^\/+/u;
const SECTION_BY_SLUG: ReadonlyMap<string, CanonicalNavSection> = new Map(
  CANONICAL_NAVIGATION.map((section) => [section.toLowerCase(), section])
);

export function canonicalNavPath(section: CanonicalNavSection): string {
  return `/${section.toLowerCase()}`;
}

export function canonicalSectionFromPath(
  pathname: string
): CanonicalNavSection | null {
  const route = pathname.replace(LEADING_SLASHES, "");
  const separator = route.indexOf("/");
  const slug = separator === -1 ? route : route.slice(0, separator);
  return SECTION_BY_SLUG.get(slug) ?? null;
}
