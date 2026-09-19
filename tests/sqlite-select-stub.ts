// Parses the bounded table read the Codex state collector issues, for the
// in-memory SQLite stubs the collector tests stand in for node:sqlite with:
//
//   SELECT <columns> FROM <table>
//     [WHERE COALESCE(<column>, 0) >= ?]
//     [ORDER BY <column> DESC]
//     LIMIT <n>
//
// `statement` must already be whitespace-normalized (runs collapsed to one
// space, trimmed). Each clause is matched on its own so no pattern nests a
// quantifier inside another.

export interface LimitedTableSelect {
  columns: string[];
  table: string;
  filterColumn: string | undefined;
  orderColumn: string | undefined;
}

const HEAD = /^SELECT (.+?) FROM (\w+)/;
const WHERE_CLAUSE = /^ WHERE COALESCE\("?(\w+)"?, 0\) >= \?/;
const ORDER_CLAUSE = /^ ORDER BY "?(\w+)"? DESC/;
const LIMIT_CLAUSE = /^ LIMIT \d+$/;

export function parseLimitedTableSelect(
  statement: string
): LimitedTableSelect | undefined {
  const head = HEAD.exec(statement);
  if (!head) return undefined;
  let rest = statement.slice(head[0].length);
  const where = WHERE_CLAUSE.exec(rest);
  if (where) rest = rest.slice(where[0].length);
  const order = ORDER_CLAUSE.exec(rest);
  if (order) rest = rest.slice(order[0].length);
  if (!LIMIT_CLAUSE.test(rest)) return undefined;
  return {
    columns: head[1]!.split(/,\s*/).map((col) => col.replaceAll(/^"|"$/g, "")),
    table: head[2]!,
    filterColumn: where?.[1],
    orderColumn: order?.[1]
  };
}
