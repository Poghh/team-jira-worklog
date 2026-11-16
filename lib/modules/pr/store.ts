import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { prChecks } from "@/lib/db/schema";

/** Một PR theo cặp nhánh — khoá của tick tay. */
export interface PrPair {
  repo: string;
  head: string;
  base: string;
}

const match = (p: PrPair) =>
  and(eq(prChecks.repo, p.repo), eq(prChecks.head, p.head), eq(prChecks.base, p.base));

/** Mục checklist đã tick tay của một cặp `head → base`. */
export function getPrChecks(p: PrPair): string[] {
  return db
    .select({ item: prChecks.item })
    .from(prChecks)
    .where(match(p))
    .all()
    .map((r) => r.item);
}

/** Tick hoặc bỏ tick một mục. Trả lại danh sách sau khi đổi. */
export function setPrCheck(p: PrPair, item: string, done: boolean): string[] {
  if (done)
    db.insert(prChecks)
      .values({ ...p, item })
      .onConflictDoNothing()
      .run();
  else db.delete(prChecks).where(and(match(p), eq(prChecks.item, item))).run();
  return getPrChecks(p);
}
