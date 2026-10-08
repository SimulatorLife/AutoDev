import net from "node:net";

/**
 * A minimal PostgreSQL wire-protocol server, just complete enough to answer a
 * query through the real `pg` driver.
 *
 * This exists because `pg-pool.ts` is the only module in this package that
 * talks to the real driver, and `FakeMemoryPool` satisfies the same interface
 * without ever exercising it: `runQuery` and the success path of `connect()`
 * had no coverage at all, so the row mapping, the parameter hand-off and the
 * pool's own concurrency policy were all untested against the code that ships.
 *
 * It is not a database. There is no SQL parsing, no planner and no storage --
 * a statement is matched against the caller's table and answered with rows the
 * caller supplied. What it does prove is that the real driver completes a
 * handshake, that our bytes arrive in the shape the driver expects, and that
 * the pool hands out and reclaims connections the way `createPgMemoryPool`
 * configures it to.
 *
 * The messages implemented are the ones a query needs: startup (including a
 * declined SSLRequest, which `pg` sends only when TLS is configured), simple
 * query, the extended query protocol for parameterised statements, and
 * terminate.
 */

/** What a statement is answered with. */
export interface FakeQueryResult {
  /** Column names, in order. Values are returned as text, as text-typed OIDs are. */
  readonly columns: readonly string[];
  /** One row per entry; a `null` renders as SQL NULL. */
  readonly rows: readonly (readonly (string | number | boolean | null)[])[];
  /** CommandComplete tag driving `rowCount`. Defaults to `SELECT <rows>`. */
  readonly commandComplete?: string;
}

export interface FakePostgresServer {
  readonly url: string;
  /** Statements the driver actually sent, in order, with their bound parameters. */
  readonly statements: readonly { readonly sql: string; readonly params: readonly string[] }[];
  /** How many connections are currently open, for the pool-concurrency tests. */
  readonly openConnections: () => number;
  /** How many connections have been opened in total. */
  readonly totalConnections: () => number;
  close: () => Promise<void>;
}

function framed(tag: string, body: Buffer): Buffer {
  const header = Buffer.alloc(tag ? 5 : 4);
  if (tag) header.write(tag, 0, "ascii");
  header.writeUInt32BE(body.length + 4, tag ? 1 : 0);
  return Buffer.concat([header, body]);
}

function cstring(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])]);
}

function int16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value);
  return buffer;
}

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

const TEXT_OID = 25;

function rowDescription(columns: readonly string[]): Buffer {
  return framed(
    "T",
    Buffer.concat([
      int16(columns.length),
      ...columns.map((name) =>
        Buffer.concat([
          cstring(name),
          int32(0), // table oid
          int16(0), // column attribute number
          int32(TEXT_OID),
          int16(-1), // variable length
          int32(-1), // type modifier
          int16(0) // text format
        ])
      )
    ])
  );
}

function dataRow(values: readonly (string | number | boolean | null)[]): Buffer {
  return framed(
    "D",
    Buffer.concat([
      int16(values.length),
      ...values.map((value) =>
        value === null ? int32(-1) : Buffer.concat([int32(Buffer.byteLength(String(value))), Buffer.from(String(value), "utf8")])
      )
    ])
  );
}

function errorResponse(message: string): Buffer {
  // Severity, then the two fields a client reads before giving up, then the
  // terminating zero.
  return framed(
    "E",
    Buffer.concat([
      cstring("S"),
      cstring("ERROR"),
      cstring("C"),
      cstring("XX000"),
      cstring("M"),
      cstring(message),
      Buffer.from([0])
    ])
  );
}

/**
 * Match a statement against the caller's answers.
 *
 * Keyed on a substring of the normalised SQL, because these tests care that a
 * given statement produced a given answer -- not that the server understands
 * Postgres. An unmatched statement is an error, so a typo in a test surfaces as
 * a failure rather than as an empty result.
 *
 * The longest matching key wins rather than the first. Insertion order would
 * otherwise decide the answer: with keys `FROM memory_records` and
 * `DELETE FROM`, a `DELETE FROM memory_records WHERE ...` would be answered by
 * whichever was registered first, and a test asserting only the statement's
 * text would never notice it had been given the wrong rows.
 */
function buildResponder(
  answers: ReadonlyMap<string, FakeQueryResult>
): (sql: string) => FakeQueryResult {
  const normalised = [...answers].map(
    ([key, value]) => [key.replace(/\s+/gu, " ").trim(), value] as const
  );

  return (sql: string) => {
    const flat = sql.replace(/\s+/gu, " ").trim();
    let best: FakeQueryResult | undefined;
    let bestLength = -1;
    for (const [key, value] of normalised) {
      if (flat.includes(key) && key.length > bestLength) {
        best = value;
        bestLength = key.length;
      }
    }
    if (!best) {
      throw new Error(`FakePostgresServer received an unexpected statement: ${flat}`);
    }
    return best;
  };
}

/** The handshake a fresh connection completes before any statement runs. */
function startupResponse(): Buffer {
  return Buffer.concat([
    framed("R", int32(0)), // AuthenticationOk
    framed("S", Buffer.concat([cstring("server_version"), cstring("15.0")])),
    framed("S", Buffer.concat([cstring("server_encoding"), cstring("UTF8")])),
    framed("S", Buffer.concat([cstring("client_encoding"), cstring("UTF8")])),
    framed("S", Buffer.concat([cstring("DateStyle"), cstring("ISO, MDY")])),
    framed("S", Buffer.concat([cstring("TimeZone"), cstring("UTC")])),
    framed("S", Buffer.concat([cstring("integer_datetimes"), cstring("on")])),
    framed("S", Buffer.concat([cstring("standard_conforming_strings"), cstring("on")])),
    framed("K", Buffer.concat([int32(1), int32(2)])), // BackendKeyData
    framed("Z", Buffer.from("I", "ascii")) // ReadyForQuery, idle
  ]);
}

export async function startFakePostgresServer(
  answers: ReadonlyMap<string, FakeQueryResult>
): Promise<FakePostgresServer> {
  const respond = buildResponder(answers);
  const statements: { sql: string; params: string[] }[] = [];
  const sockets = new Set<net.Socket>();
  let opened = 0;

  const server = net.createServer((socket) => {
    opened += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());

    let buffer = Buffer.alloc(0);
    let started = false;
    // State for the extended query protocol: the statement being prepared and
    // the parameters bound to it, replayed when Execute arrives.
    let preparedSql: string | null = null;
    let boundParams: string[] = [];

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        for (;;) {
          if (!started) {
            if (buffer.length < 4) return;
            const length = buffer.readUInt32BE(0);
            if (buffer.length < length) return;
            const version = buffer.readUInt32BE(4);
            if (version === 80877103) {
              // SSLRequest: decline, and read the startup packet that follows.
              socket.write(Buffer.from("N", "ascii"));
              buffer = buffer.subarray(length);
              continue;
            }
            started = true;
            buffer = buffer.subarray(length);
            socket.write(startupResponse());
            continue;
          }
          if (buffer.length < 5) return;
          const tagByte = buffer.at(0);
          if (tagByte === undefined) return;
          const tag = String.fromCharCode(tagByte);
          const length = buffer.readUInt32BE(1);
          if (buffer.length < length + 1) return;
          const body = buffer.subarray(5, length + 1);
          buffer = buffer.subarray(length + 1);

          if (tag === "Q") {
            // Simple query: every semicolon-separated statement, each followed
            // by its own result and a ReadyForQuery.
            const sql = body.subarray(0, body.length - 1).toString("utf8");
            const pieces = sql.split(";").filter((piece) => piece.trim() !== "");
            for (const piece of pieces) {
              statements.push({ sql: piece, params: [] });
              const result = respond(piece);
              socket.write(
                Buffer.concat([
                  rowDescription(result.columns),
                  ...result.rows.map(dataRow),
                  framed("C", cstring(result.commandComplete ?? `SELECT ${result.rows.length}`)),
                  framed("Z", Buffer.from("I", "ascii"))
                ])
              );
            }
            continue;
          }

          if (tag === "P") {
            // Parse: statement name, query text, then an int16 count followed
            // by that many int32 parameter type OIDs. The query runs from
            // after the name's terminator to its own terminator; the type
            // list starts immediately after that.
            const nul = body.indexOf(0);
            const second = body.indexOf(0, nul + 1);
            preparedSql = body.subarray(nul + 1, second).toString("utf8");
            boundParams = [];
            socket.write(framed("1", Buffer.alloc(0))); // ParseComplete
            continue;
          }

          if (tag === "B") {
            // Bind: skip the portal and statement names and the format codes,
            // then read each parameter as text.
            let offset = 0;
            offset = body.indexOf(0, offset) + 1;
            offset = body.indexOf(0, offset) + 1;
            const formatCount = body.readInt16BE(offset);
            offset += 2 + formatCount * 2;
            const paramCount = body.readInt16BE(offset);
            offset += 2;
            boundParams = [];
            for (let index = 0; index < paramCount; index += 1) {
              const size = body.readInt32BE(offset);
              offset += 4;
              if (size === -1) {
                boundParams.push("NULL");
              } else {
                boundParams.push(body.subarray(offset, offset + size).toString("utf8"));
                offset += size;
              }
            }
            socket.write(framed("2", Buffer.alloc(0))); // BindComplete
            continue;
          }

          if (tag === "D") {
            // Describe: answered on Execute, once the statement is known.
            continue;
          }

          if (tag === "E") {
            const sql = preparedSql ?? "";
            statements.push({ sql, params: boundParams });
            preparedSql = null;
            const result = respond(sql);
            socket.write(
              Buffer.concat([
                rowDescription(result.columns),
                ...result.rows.map(dataRow),
                framed("C", cstring(result.commandComplete ?? `SELECT ${result.rows.length}`)),
                framed("Z", Buffer.from("I", "ascii"))
              ])
            );
            continue;
          }

          if (tag === "C") {
            socket.write(framed("3", Buffer.alloc(0))); // CloseComplete
            continue;
          }

          if (tag === "X") {
            socket.end();
            return;
          }
        }
      } catch (error) {
        socket.write(errorResponse((error as Error).message));
        socket.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("FakePostgresServer did not bind a TCP port.");
  }

  return {
    url: `postgres://autodev:autodev@127.0.0.1:${address.port}/autodev`,
    statements,
    openConnections: () => sockets.size,
    totalConnections: () => opened,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}