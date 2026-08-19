/**
 * Uniform pagination for every list surface. Parses `page`/`pageSize` from
 * a searchParams-like object, clamps to sane bounds, and computes
 * skip/limit. `buildPageResult` wraps rows with the total + page metadata
 * the tables render.
 */
export interface Pagination {
  page: number;
  pageSize: number;
  skip: number;
  limit: number;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function toInt(value: string | string[] | undefined, fallback: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parsePagination(searchParams: {
  page?: string | string[];
  pageSize?: string | string[];
}): Pagination {
  const page = toInt(searchParams.page, 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    toInt(searchParams.pageSize, DEFAULT_PAGE_SIZE),
  );
  return { page, pageSize, skip: (page - 1) * pageSize, limit: pageSize };
}

export function buildPageResult<T>(
  items: T[],
  total: number,
  p: Pagination,
): PageResult<T> {
  return {
    items,
    total,
    page: p.page,
    pageSize: p.pageSize,
    totalPages: Math.max(1, Math.ceil(total / p.pageSize)),
  };
}
