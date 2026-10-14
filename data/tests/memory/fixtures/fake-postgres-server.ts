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
  readonly statements: readonly {
    readonly sql: string;
    readonly params: readonly string[];
  }[];
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

function dataRow(
  values: readonly (string | number | boolean | null)[]
): Buffer {
  return framed(
    "D",
    Buffer.concat([
      int16(values.length),
      ...values.map((value) =>
        value === null
          ? int32(-1)
          : Buffer.concat([
              int32(Buffer.byteLength(String(value))),
              Buffer.from(String(value), "utf8")
            ])
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
  const normalised = Array.from(
    answers,
    ([key, value]) => [key.replaceAll(/\s+/gu, " ").trim(), value] as const
  );

  return (sql: string) => {
    const flat = sql.replaceAll(/\s+/gu, " ").trim();
    let best: FakeQueryResult | undefined;
    let bestLength = -1;
    for (const [key, value] of normalised) {
      if (flat.includes(key) && key.length > bestLength) {
        best = value;
        bestLength = key.length;
      }
    }
    if (!best) {
      throw new Error(
        `FakePostgresServer received an unexpected statement: ${flat}`
      );
    }
    return best;
  };
}

/** The handshake a fresh connection completes before any statement runs. */
function startupResponse(): Buffer {
  return Buffer.concat([
    framed("R", int32(0)), // AuthenticationOk
    framed("S", Buffer.concat([cstring("server_version"), cstring("15.0")])),
    framed("S", Buffer.concat([cstring("server_encoding"), cstring("utf8")])),
    framed("S", Buffer.concat([cstring("client_encoding"), cstring("utf8")])),
    framed("S", Buffer.concat([cstring("DateStyle"), cstring("ISO, MDY")])),
    framed("S", Buffer.concat([cstring("TimeZone"), cstring("UTC")])),
    framed("S", Buffer.concat([cstring("integer_datetimes"), cstring("on")])),
    framed(
      "S",
      Buffer.concat([cstring("standard_conforming_strings"), cstring("on")])
    ),
    framed("K", Buffer.concat([int32(1), int32(2)])), // BackendKeyData
    framed("Z", Buffer.from("I", "ascii")) // ReadyForQuery, idle
  ]);
}

interface ProtocolState {
  buffer: Buffer;
  started: boolean;
  preparedSql: string | null;
  boundParams: string[];
}

interface ProtocolMessage {
  readonly tag: string;
  readonly body: Buffer;
}

type StatementList = { sql: string; params: string[] }[];
type QueryResponder = (sql: string) => FakeQueryResult;

function consumeStartupPacket(
  state: ProtocolState,
  socket: net.Socket
): boolean {
  if (state.buffer.length < 4) return false;
  const length = state.buffer.readUInt32BE(0);
  if (state.buffer.length < length) return false;
  const version = state.buffer.readUInt32BE(4);
  if (version === 80_877_103) {
    // SSLRequest: decline, and read the startup packet that follows.
    socket.write(Buffer.from("N", "ascii"));
  } else {
    state.started = true;
    socket.write(startupResponse());
  }
  state.buffer = state.buffer.subarray(length);
  return true;
}

function readProtocolMessage(state: ProtocolState): ProtocolMessage | null {
  if (state.buffer.length < 5) return null;
  const tagByte = state.buffer.at(0);
  if (tagByte === undefined) return null;
  const length = state.buffer.readUInt32BE(1);
  if (state.buffer.length < length + 1) return null;
  const message = {
    tag: String.fromCharCode(tagByte),
    body: state.buffer.subarray(5, length + 1)
  };
  state.buffer = state.buffer.subarray(length + 1);
  return message;
}

function writeQueryResult(
  sql: string,
  params: string[],
  socket: net.Socket,
  statements: StatementList,
  respond: QueryResponder
): void {
  statements.push({ sql, params });
  const result = respond(sql);
  socket.write(
    Buffer.concat([
      rowDescription(result.columns),
      ...result.rows.map(dataRow),
      framed(
        "C",
        cstring(result.commandComplete ?? `SELECT ${result.rows.length}`)
      ),
      framed("Z", Buffer.from("I", "ascii"))
    ])
  );
}

function handleSimpleQuery(
  body: Buffer,
  socket: net.Socket,
  statements: StatementList,
  respond: QueryResponder
): void {
  // Each semicolon-separated statement receives its own completion and ready message.
  const sql = body.subarray(0, -1).toString("utf8");
  for (const statement of sql
    .split(";")
    .filter((piece) => piece.trim() !== "")) {
    writeQueryResult(statement, [], socket, statements, respond);
  }
}

function handleParseMessage(
  body: Buffer,
  state: ProtocolState,
  socket: net.Socket
): void {
  // Parse carries a statement name, query text, and then parameter type OIDs.
  const nameEnd = body.indexOf(0);
  const queryEnd = body.indexOf(0, nameEnd + 1);
  state.preparedSql = body.subarray(nameEnd + 1, queryEnd).toString("utf8");
  state.boundParams = [];
  socket.write(framed("1", Buffer.alloc(0))); // ParseComplete
}

function handleBindMessage(
  body: Buffer,
  state: ProtocolState,
  socket: net.Socket
): void {
  // Bind carries portal and statement names, format codes, then text parameters.
  let offset = 0;
  offset = body.indexOf(0, offset) + 1;
  offset = body.indexOf(0, offset) + 1;
  const formatCount = body.readInt16BE(offset);
  offset += 2 + formatCount * 2;
  const paramCount = body.readInt16BE(offset);
  offset += 2;
  state.boundParams = [];
  for (let index = 0; index < paramCount; index += 1) {
    const size = body.readInt32BE(offset);
    offset += 4;
    if (size === -1) {
      state.boundParams.push("NULL");
    } else {
      state.boundParams.push(
        body.subarray(offset, offset + size).toString("utf8")
      );
      offset += size;
    }
  }
  socket.write(framed("2", Buffer.alloc(0))); // BindComplete
}

function handleExecuteMessage(
  state: ProtocolState,
  socket: net.Socket,
  statements: StatementList,
  respond: QueryResponder
): void {
  const sql = state.preparedSql ?? "";
  writeQueryResult(sql, state.boundParams, socket, statements, respond);
  state.preparedSql = null;
}

function handleProtocolMessage(
  message: ProtocolMessage,
  state: ProtocolState,
  socket: net.Socket,
  statements: StatementList,
  respond: QueryResponder
): boolean {
  switch (message.tag) {
    case "Q": {
      handleSimpleQuery(message.body, socket, statements, respond);
      return true;
    }
    case "P": {
      handleParseMessage(message.body, state, socket);
      return true;
    }
    case "B": {
      handleBindMessage(message.body, state, socket);
      return true;
    }
    case "D": {
      // Describe is answered on Execute, once the statement is known.
      return true;
    }
    case "E": {
      handleExecuteMessage(state, socket, statements, respond);
      return true;
    }
    case "C": {
      socket.write(framed("3", Buffer.alloc(0))); // CloseComplete
      return true;
    }
    case "X": {
      socket.end();
      return false;
    }
    default: {
      return true;
    }
  }
}

function receiveProtocolData(
  chunk: Buffer,
  state: ProtocolState,
  socket: net.Socket,
  statements: StatementList,
  respond: QueryResponder
): void {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  try {
    for (;;) {
      if (!state.started) {
        if (!consumeStartupPacket(state, socket)) return;
        continue;
      }
      const message = readProtocolMessage(state);
      if (message === null) return;
      if (!handleProtocolMessage(message, state, socket, statements, respond)) {
        return;
      }
    }
  } catch (error) {
    socket.write(errorResponse((error as Error).message));
    socket.end();
  }
}

export async function startFakePostgresServer(
  answers: ReadonlyMap<string, FakeQueryResult>
): Promise<FakePostgresServer> {
  const respond = buildResponder(answers);
  const statements: StatementList = [];
  const sockets = new Set<net.Socket>();
  let opened = 0;

  const server = net.createServer((socket) => {
    opened += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());

    const state: ProtocolState = {
      buffer: Buffer.alloc(0),
      started: false,
      preparedSql: null,
      boundParams: []
    };
    socket.on("data", (chunk) =>
      receiveProtocolData(chunk, state, socket, statements, respond)
    );
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
