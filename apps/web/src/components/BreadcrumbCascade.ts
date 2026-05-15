export type BreadcrumbSibling = {
  id: string;
  name: string;
  href: string;
  isCurrent: boolean;
  isFolder: boolean;
  children?: BreadcrumbSibling[];
};

export type BreadcrumbSegment = {
  id: string;
  name: string;
  href: string;
  isCurrent: boolean;
  siblings: BreadcrumbSibling[];
  allChildrenHref?: string;
};
