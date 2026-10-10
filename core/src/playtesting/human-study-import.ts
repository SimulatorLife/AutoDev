/**
 * Core-owned, infrastructure-free consented human-study CSV/JSON import.
 *
 * Authorized export parsing, strict manifest/item mapping, and every policy
 * decision that Core cannot answer on its own (study approval, instrument
 * trust, consent validity, workspace/build linkage, episode linkage,
 * exposure sufficiency and response-window timing) are delegated to
 * explicit trusted callbacks supplied by the caller. This module never
 * touches the network or a datastore, and it never silently resolves a
 * duplicate participant\u00d7episode\u00d7instrument submission -- those are
 * always quarantined for an operator to resolve.
 *
 * See docs/playtesting-measurement-contract.md#7-human-labels-and-change-sensitivity
 * and docs/playtesting-target-state.md Human-calibrated quality scoring.
 */

import {
  type HumanExperienceResponse,
  type HumanPlaytestStudy,
  PLAYTESTS_HUMAN_INSTRUMENTS
} from "./artifacts.ts";
import {
  type PlaytestMiniPxiItem,
  type PlaytestMissingReason,
  PLAYTESTS_HUMAN_STUDY_SCHEMA,
  PLAYTESTS_MINIPXI_ITEMS,
  PLAYTESTS_MISSING_REASONS,
  type PlaytestVersionedRef
} from "./types.ts";

const MAX_HUMAN_EXPORT_CHARACTERS = 2_000_000;
const MAX_HUMAN_EXPORT_ROWS = 10_000;
const MAX_HUMAN_EXPORT_COLUMNS = 256;
const MAX_HUMAN_EXPORT_FIELD_CHARACTERS = 16_384;
const TOO_MANY_ROWS_ERROR =
  "Human-study export exceeds the maximum allowed row count.";
const REJECT_MALFORMED = "malformed-row" as const;
const REJECT_BAD_ITEM_RANGE = "bad-item-range" as const;
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const JSON_STRING_ERROR = "Human-study JSON contains an invalid string.";
const SINGLE_BUILD_ORDER = "single-build" as const;
const HUMAN_STUDY_ORDERS = ["A-first", "B-first", SINGLE_BUILD_ORDER] as const;

export const HUMAN_STUDY_COMPLETION_STATUSES = [
  "completed",
  "partial",
  "incomplete"
] as const;
export type HumanStudyCompletionStatus =
  (typeof HUMAN_STUDY_COMPLETION_STATUSES)[number];

/** Published PXI construct IDs; each full-PXI construct has three items. */
export const PLAYTESTS_PXI_CONSTRUCTS = [
  "AA",
  "CH",
  "EC",
  "GR",
  "PF",
  "AUT",
  "CUR",
  "IMM",
  "MAS",
  "MEA"
] as const satisfies readonly Exclude<PlaytestMiniPxiItem, "ENJ">[];
export type PlaytestPxiConstructId = (typeof PLAYTESTS_PXI_CONSTRUCTS)[number];

export interface HumanStudyPxiItemConstructMapping {
  readonly instrumentHash: string;
  readonly items: readonly {
    readonly itemId: string;
    readonly constructId: PlaytestPxiConstructId;
  }[];
}

/** Restricted-store response with completion and native scale provenance. */
export interface HumanStudyResponse extends HumanExperienceResponse {
  readonly completionStatus: HumanStudyCompletionStatus;
  readonly nativeMinimum: number;
  readonly nativeMaximum: number;
  readonly nativeUnit: string;
  readonly constructId?: PlaytestPxiConstructId;
}

/** Supported authorized export encodings for a human-study submission batch. */
export type HumanStudyExportFormat = "csv" | "json";

/** One native item column mapped from the export to a declared item id. */
export interface HumanStudyExportItemColumn {
  readonly itemId: string;
  readonly valueColumn: string;
  readonly missingReasonColumn?: string;
}

/**
 * Explicit export-to-item mapping. There is no universal survey-export
 * schema; every column must be named here or the row is rejected as
 * malformed rather than guessed at.
 */
export interface HumanStudyExportManifest {
  readonly studyIdColumn: string;
  readonly responseIdColumn: string;
  readonly revisionColumn: string;
  readonly supersedesColumn: string;
  readonly participantIdColumn: string;
  readonly consentVersionColumn: string;
  readonly consentScopeColumn: string;
  readonly instrumentColumn: string;
  readonly instrumentVersionColumn: string;
  readonly instrumentHashColumn: string;
  readonly workspaceIdColumn: string;
  readonly buildIdColumn: string;
  readonly buildVersionColumn: string;
  readonly buildHashColumn: string;
  readonly episodeIdColumn: string;
  readonly exposureStartedAtColumn: string;
  readonly exposureEndedAtColumn: string;
  readonly orderColumn: string;
  readonly submittedAtColumn: string;
  readonly completionStatusColumn: string;
  /** Required for project-authored instruments; their scale is never guessed. */
  readonly nativeScale?: {
    readonly minimum: number;
    readonly maximum: number;
    readonly unit: string;
  };
  /** Full PXI mappings must be explicit and bound to the trusted instrument content hash. */
  readonly pxiItemConstructMapping?: HumanStudyPxiItemConstructMapping;
  readonly items: readonly HumanStudyExportItemColumn[];
}

/** One raw export row after format-specific parsing, before manifest mapping. */
export type HumanStudyRawRow = Readonly<Record<string, string>>;

/** Trusted operator/consent-system callbacks Core cannot answer itself. */
export interface HumanStudyImportValidators {
  readonly isApprovedStudy: (study: HumanPlaytestStudy) => boolean;
  readonly isWorkspaceAllowed: (
    study: HumanPlaytestStudy,
    workspaceId: string
  ) => boolean;
  readonly isBuildAllowed: (
    study: HumanPlaytestStudy,
    build: PlaytestVersionedRef
  ) => boolean;
  readonly isTrustedInstrumentVersion: (
    study: HumanPlaytestStudy,
    instrument: string,
    instrumentVersion: string,
    instrumentHash: string
  ) => boolean;
  /** Confirms that the explicit item/construct mapping belongs to this exact published full-PXI hash. */
  readonly isTrustedPxiItemConstructMapping: (
    study: HumanPlaytestStudy,
    mapping: HumanStudyPxiItemConstructMapping
  ) => boolean;
  readonly isValidEpisodeLink: (
    study: HumanPlaytestStudy,
    episodeId: string,
    build: PlaytestVersionedRef
  ) => boolean;
  readonly isConsentValid: (
    study: HumanPlaytestStudy,
    participantId: string,
    consentVersion: string,
    consentScope: string
  ) => boolean;
  readonly isParticipantWithdrawn: (
    study: HumanPlaytestStudy,
    participantId: string
  ) => boolean;
  readonly isExposureSufficient: (
    study: HumanPlaytestStudy,
    exposureStartedAt: string,
    exposureEndedAt: string
  ) => boolean;
  readonly isWithinResponseWindow: (
    study: HumanPlaytestStudy,
    exposureEndedAt: string,
    submittedAt: string
  ) => boolean;
}

/** Closed rejection vocabulary; never a free-form string a caller must parse. */
export const HUMAN_STUDY_IMPORT_REJECTION_REASONS = [
  REJECT_MALFORMED,
  "unapproved-study",
  "wrong-workspace",
  "wrong-build",
  "untrusted-instrument-version",
  "bad-item-id",
  REJECT_BAD_ITEM_RANGE,
  "bad-missing-reason",
  "invalid-episode-link",
  "invalid-exposure",
  "wrong-timing",
  "consent-mismatch",
  "withdrawn-participant"
] as const;

export type HumanStudyImportRejectionReason =
  (typeof HUMAN_STUDY_IMPORT_REJECTION_REASONS)[number];

export interface HumanStudyImportRejection {
  readonly rowIndex: number;
  readonly studyId: string | null;
  readonly responseId: string | null;
  readonly reason: HumanStudyImportRejectionReason;
  readonly detail: string;
}

/** A duplicate participant\u00d7episode\u00d7instrument submission, held for operator choice. */
export interface HumanStudyDuplicateQuarantine {
  readonly studyId: string;
  readonly participantId: string;
  readonly episodeId: string;
  readonly instrument: string;
  readonly responseIds: readonly string[];
  readonly reason: "duplicate-participant-episode-instrument";
}

export interface HumanStudyImportOutcome {
  readonly accepted: readonly HumanStudyResponse[];
  /** Re-imported (studyId, responseId) pairs whose content exactly matched; no new rows were produced. */
  readonly unchanged: readonly HumanStudyResponse[];
  /** responseIds a newly accepted amendment supersedes. */
  readonly superseded: readonly string[];
  readonly rejected: readonly HumanStudyImportRejection[];
  readonly quarantined: readonly HumanStudyDuplicateQuarantine[];
  /** Raw duplicate candidates for the restricted Data owner to retain privately until operator resolution. */
  readonly quarantinedResponses: readonly HumanStudyResponse[];
}

/** Parse an authorized export into uniform string-keyed rows. No schema is assumed beyond the manifest. */
export function parseHumanStudyExportRows(
  raw: string,
  format: HumanStudyExportFormat
): readonly HumanStudyRawRow[] {
  if (raw.length > MAX_HUMAN_EXPORT_CHARACTERS) {
    throw new TypeError("Human-study export exceeds the maximum allowed size.");
  }
  return format === "json" ? parseJsonExportRows(raw) : parseCsvExportRows(raw);
}

function parseJsonExportRows(raw: string): readonly HumanStudyRawRow[] {
  return new StrictHumanJsonRowsParser(raw).parse();
}

function parseCsvExportRows(raw: string): readonly HumanStudyRawRow[] {
  const lines = splitCsvLines(raw);
  if (lines.length === 0) return [];
  const header = lines[0]!;
  if (header.length === 0 || header.length > MAX_HUMAN_EXPORT_COLUMNS) {
    throw new TypeError("Human-study CSV has an invalid column count.");
  }
  if (
    header.some((name) => name.length === 0) ||
    new Set(header).size !== header.length
  ) {
    throw new TypeError(
      "Human-study CSV headers must be non-empty and unique."
    );
  }
  if (lines.length - 1 > MAX_HUMAN_EXPORT_ROWS) {
    throw new TypeError(TOO_MANY_ROWS_ERROR);
  }
  return lines.slice(1).map((line) => {
    if (line.length !== header.length) {
      throw new TypeError(
        "Human-study CSV row has a different column count than its header."
      );
    }
    const row = Object.create(null) as Record<string, string>;
    header.forEach((key, index) => {
      row[key] = line[index] ?? "";
    });
    return row;
  });
}

interface CsvParseState {
  readonly rows: string[][];
  row: string[];
  field: string;
  inQuotes: boolean;
  afterQuote: boolean;
}

function appendCsvField(state: CsvParseState, value: string): void {
  state.field += value;
  if (state.field.length > MAX_HUMAN_EXPORT_FIELD_CHARACTERS) {
    throw new TypeError(
      "Human-study CSV field exceeds the maximum allowed size."
    );
  }
}

function finishCsvField(state: CsvParseState): void {
  state.row.push(state.field);
  if (state.row.length > MAX_HUMAN_EXPORT_COLUMNS) {
    throw new TypeError("Human-study CSV has too many columns.");
  }
  state.field = "";
  state.afterQuote = false;
}

function finishCsvRow(state: CsvParseState): void {
  state.rows.push(state.row);
  if (state.rows.length > MAX_HUMAN_EXPORT_ROWS + 1) {
    throw new TypeError(TOO_MANY_ROWS_ERROR);
  }
  state.row = [];
  state.field = "";
  state.afterQuote = false;
}

function consumeQuotedCsvCharacter(
  state: CsvParseState,
  raw: string,
  index: number
): number {
  if (raw[index] !== '"') {
    appendCsvField(state, raw[index]!);
    return index + 1;
  }
  if (raw[index + 1] === '"') {
    appendCsvField(state, '"');
    return index + 2;
  }
  state.inQuotes = false;
  state.afterQuote = true;
  return index + 1;
}

function consumeCsvCharacter(
  state: CsvParseState,
  raw: string,
  index: number
): number {
  const char = raw[index]!;
  if (state.inQuotes) return consumeQuotedCsvCharacter(state, raw, index);
  if (char === '"') {
    if (state.field.length > 0 || state.afterQuote) {
      throw new TypeError("Human-study CSV contains an invalid quote.");
    }
    state.inQuotes = true;
    return index + 1;
  }
  if (char === ",") {
    finishCsvField(state);
    return index + 1;
  }
  if (char === "\r" || char === "\n") {
    if (char === "\r" && raw[index + 1] !== "\n") {
      throw new TypeError("Human-study CSV contains a bare carriage return.");
    }
    finishCsvField(state);
    finishCsvRow(state);
    return index + (char === "\r" ? 2 : 1);
  }
  if (state.afterQuote) {
    throw new TypeError(
      "Human-study CSV contains characters after a quoted field."
    );
  }
  appendCsvField(state, char);
  return index + 1;
}

function splitCsvLines(raw: string): readonly (readonly string[])[] {
  const state: CsvParseState = {
    rows: [],
    row: [],
    field: "",
    inQuotes: false,
    afterQuote: false
  };
  let index = 0;
  while (index < raw.length) index = consumeCsvCharacter(state, raw, index);
  if (state.inQuotes) {
    throw new TypeError(
      "Human-study CSV contains an unterminated quoted field."
    );
  }
  if (state.field.length > 0 || state.row.length > 0 || state.afterQuote) {
    finishCsvField(state);
    finishCsvRow(state);
  }
  return state.rows;
}

/** Strict reader for a flat array of objects with unique string-keyed scalar fields. */
class StrictHumanJsonRowsParser {
  private offset = 0;
  private readonly input: string;

  constructor(input: string) {
    this.input = input;
  }

  parse(): readonly HumanStudyRawRow[] {
    this.skipWhitespace();
    this.expect("[");
    this.skipWhitespace();
    const rows: HumanStudyRawRow[] = [];
    if (this.consume("]")) {
      this.skipWhitespace();
      if (this.offset !== this.input.length)
        throw new TypeError("Human-study JSON has trailing data.");
      return rows;
    }
    while (true) {
      if (rows.length >= MAX_HUMAN_EXPORT_ROWS) {
        throw new TypeError(TOO_MANY_ROWS_ERROR);
      }
      rows.push(this.parseObject());
      this.skipWhitespace();
      if (this.consume("]")) break;
      this.expect(",");
      this.skipWhitespace();
    }
    this.skipWhitespace();
    if (this.offset !== this.input.length)
      throw new TypeError("Human-study JSON has trailing data.");
    return rows;
  }

  private parseObject(): HumanStudyRawRow {
    this.expect("{");
    this.skipWhitespace();
    const row = Object.create(null) as Record<string, string>;
    const keys = new Set<string>();
    if (this.consume("}")) return row;
    while (true) {
      const key = this.parseString();
      if (key.length === 0 || keys.has(key)) {
        throw new TypeError(
          "Human-study JSON row keys must be non-empty and unique."
        );
      }
      keys.add(key);
      if (keys.size > MAX_HUMAN_EXPORT_COLUMNS) {
        throw new TypeError("Human-study JSON row has too many columns.");
      }
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      row[key] = this.parseScalar();
      this.skipWhitespace();
      if (this.consume("}")) return row;
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private parseScalar(): string {
    if (this.input[this.offset] === '"') return this.parseString();
    for (const literal of ["true", "false", "null"] as const) {
      if (this.input.startsWith(literal, this.offset)) {
        this.offset += literal.length;
        return literal === "null" ? "" : literal;
      }
    }
    const end = scanNumericText(this.input, this.offset);
    if (end !== null) {
      const number = this.input.slice(this.offset, end);
      this.offset = end;
      return number;
    }
    throw new TypeError(
      "Human-study JSON values must be scalar strings, numbers, booleans, or null."
    );
  }

  private parseString(): string {
    if (this.input[this.offset] !== '"')
      throw new TypeError("Human-study JSON object keys must be strings.");
    const start = this.offset++;
    let escaped = false;
    while (this.offset < this.input.length) {
      const char = this.input[this.offset++]!;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') {
        try {
          const parsed: unknown = JSON.parse(
            this.input.slice(start, this.offset)
          );
          if (typeof parsed !== "string")
            throw new TypeError("Expected JSON string.");
          return parsed;
        } catch (error) {
          throw new TypeError(JSON_STRING_ERROR, { cause: error });
        }
      }
    }
    throw new TypeError("Human-study JSON contains an unterminated string.");
  }

  private skipWhitespace(): void {
    while (isJsonWhitespace(this.input.charCodeAt(this.offset)))
      this.offset += 1;
  }

  private consume(char: string): boolean {
    if (this.input[this.offset] !== char) return false;
    this.offset += 1;
    return true;
  }

  private expect(char: string): void {
    if (!this.consume(char))
      throw new TypeError(`Human-study JSON expected "${char}".`);
  }
}

function readColumn(row: HumanStudyRawRow, column: string): string {
  return row[column] ?? "";
}

function lineageKey(
  response: Pick<
    HumanExperienceResponse,
    "studyId" | "pseudonymousParticipantId" | "episodeId" | "instrument"
  >
): string {
  return JSON.stringify([
    response.studyId,
    response.pseudonymousParticipantId,
    response.episodeId,
    response.instrument
  ]);
}

function responseSignature(items: readonly HumanStudyResponse[]): string {
  return JSON.stringify(
    Array.from(items, (item) => ({
      studyId: item.studyId,
      responseId: item.responseId,
      revision: item.revision,
      supersedes: item.supersedes,
      pseudonymousParticipantId: item.pseudonymousParticipantId,
      consentVersion: item.consentVersion,
      consentScope: item.consentScope,
      instrument: item.instrument,
      instrumentVersion: item.instrumentVersion,
      instrumentHash: item.instrumentHash,
      build: item.build,
      episodeId: item.episodeId,
      exposureStartedAt: item.exposureStartedAt,
      exposureEndedAt: item.exposureEndedAt,
      order: item.order,
      submittedAt: item.submittedAt,
      completionStatus: item.completionStatus,
      nativeMinimum: item.nativeMinimum,
      nativeMaximum: item.nativeMaximum,
      nativeUnit: item.nativeUnit,
      constructId: item.constructId ?? null,
      itemId: item.itemId,
      nativeValue: item.nativeValue,
      missingReason: item.missingReason ?? null,
      withdrawn: item.withdrawn
    })).sort((a, b) => compareStrings(a.itemId, b.itemId))
  );
}

function manifestColumns(
  manifest: HumanStudyExportManifest
): readonly string[] {
  const columns = [
    manifest.studyIdColumn,
    manifest.responseIdColumn,
    manifest.revisionColumn,
    manifest.supersedesColumn,
    manifest.participantIdColumn,
    manifest.consentVersionColumn,
    manifest.consentScopeColumn,
    manifest.instrumentColumn,
    manifest.instrumentVersionColumn,
    manifest.instrumentHashColumn,
    manifest.workspaceIdColumn,
    manifest.buildIdColumn,
    manifest.buildVersionColumn,
    manifest.buildHashColumn,
    manifest.episodeIdColumn,
    manifest.exposureStartedAtColumn,
    manifest.exposureEndedAtColumn,
    manifest.orderColumn,
    manifest.submittedAtColumn,
    manifest.completionStatusColumn
  ];
  for (const item of manifest.items) {
    columns.push(item.valueColumn);
    if (item.missingReasonColumn) columns.push(item.missingReasonColumn);
  }
  if (
    columns.some(
      (column) => typeof column !== "string" || column.length === 0
    ) ||
    columns.length > MAX_HUMAN_EXPORT_COLUMNS ||
    new Set(columns).size !== columns.length
  ) {
    throw new TypeError(
      "Human-study manifest columns must be non-empty, unique, and bounded."
    );
  }
  if (
    manifest.items.length === 0 ||
    new Set(manifest.items.map((item) => item.itemId)).size !==
      manifest.items.length
  ) {
    throw new TypeError(
      "Human-study manifest must map at least one unique item ID."
    );
  }
  for (const item of manifest.items) {
    if (!ITEM_ID_PATTERN.test(item.itemId)) {
      throw new TypeError("Human-study manifest contains an invalid item ID.");
    }
  }
  return columns;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isJsonWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 13 || code === 32;
}

function scanDigits(input: string, index: number): number {
  while (isDigit(input.charCodeAt(index))) index += 1;
  return index;
}

function scanInteger(input: string, index: number): number | null {
  if (input[index] === "0") {
    return isDigit(input.charCodeAt(index + 1)) ? null : index + 1;
  }
  const first = input.charCodeAt(index);
  return isDigit(first) && first !== 48 ? scanDigits(input, index + 1) : null;
}

function scanFraction(input: string, index: number): number | null {
  if (input[index] !== ".") return index;
  const firstDigit = index + 1;
  return isDigit(input.charCodeAt(firstDigit))
    ? scanDigits(input, firstDigit)
    : null;
}

function scanExponent(input: string, index: number): number | null {
  if (input[index] !== "e" && input[index] !== "E") return index;
  let firstDigit = index + 1;
  if (input[firstDigit] === "+" || input[firstDigit] === "-") firstDigit += 1;
  return isDigit(input.charCodeAt(firstDigit))
    ? scanDigits(input, firstDigit)
    : null;
}

/** Scan the JSON/decimal numeric grammar without coercive parsing or backtracking regexes. */
function scanNumericText(input: string, start: number): number | null {
  let index = start;
  if (input[index] === "-") index += 1;
  const integerEnd = scanInteger(input, index);
  if (integerEnd === null) return null;
  const fractionEnd = scanFraction(input, integerEnd);
  if (fractionEnd === null) return null;
  return scanExponent(input, fractionEnd);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function finiteTimestamp(value: string): number | null {
  if (!isIsoTimestamp(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasDigits(value: string, start: number, count: number): boolean {
  for (let index = start; index < start + count; index += 1) {
    if (!isDigit(value.charCodeAt(index))) return false;
  }
  return true;
}

function isIsoTimestamp(value: string): boolean {
  if (
    value.length < 20 ||
    !hasDigits(value, 0, 4) ||
    value[4] !== "-" ||
    !hasDigits(value, 5, 2) ||
    value[7] !== "-" ||
    !hasDigits(value, 8, 2) ||
    value[10] !== "T" ||
    !hasDigits(value, 11, 2) ||
    value[13] !== ":" ||
    !hasDigits(value, 14, 2) ||
    value[16] !== ":" ||
    !hasDigits(value, 17, 2)
  )
    return false;
  let index = 19;
  if (value[index] === ".") {
    index += 1;
    const fractionStart = index;
    while (isDigit(value.charCodeAt(index))) index += 1;
    if (index === fractionStart || index - fractionStart > 9) return false;
  }
  if (value[index] === "Z") return index + 1 === value.length;
  if (value[index] !== "+" && value[index] !== "-") return false;
  return (
    hasDigits(value, index + 1, 2) &&
    value[index + 3] === ":" &&
    hasDigits(value, index + 4, 2) &&
    index + 6 === value.length
  );
}

function positiveInteger(value: string): number | null {
  if (value.length === 0 || value[0] === "0") return null;
  for (const char of value) if (char < "0" || char > "9") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Strict finite decimal text; hex, whitespace, Infinity and empty strings never coerce. */
export function parseStrictHumanNumber(value: string): number | null {
  const end = scanNumericText(value, 0);
  if (end === null || end !== value.length) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface NativeScale {
  readonly minimum: number;
  readonly maximum: number;
  readonly unit: string;
}

const LIKERT_SCALE: NativeScale = {
  minimum: -3,
  maximum: 3,
  unit: "native-Likert-minus3-plus3"
};

function resolveNativeScale(
  study: HumanPlaytestStudy,
  manifest: HumanStudyExportManifest
): NativeScale {
  if (
    study.instrument !== "project-authored" &&
    manifest.nativeScale !== undefined
  ) {
    throw new TypeError(
      "Only project-authored instruments may declare a custom native scale."
    );
  }
  const scale =
    study.instrument === "project-authored"
      ? manifest.nativeScale
      : LIKERT_SCALE;
  if (
    scale === undefined ||
    !Number.isFinite(scale.minimum) ||
    !Number.isFinite(scale.maximum) ||
    scale.minimum >= scale.maximum ||
    typeof scale.unit !== "string" ||
    scale.unit.trim().length === 0 ||
    scale.unit.length > 128
  ) {
    throw new TypeError(
      "Human-study manifest must declare a valid native scale for this instrument."
    );
  }
  return scale;
}

function validatePxiItemConstructMapping(
  study: HumanPlaytestStudy,
  manifest: HumanStudyExportManifest
): ReadonlyMap<string, PlaytestPxiConstructId> {
  const mapping = manifest.pxiItemConstructMapping;
  if (study.instrument !== "PXI") {
    if (mapping !== undefined) {
      throw new TypeError(
        "Only full-PXI manifests may declare PXI item-to-construct mappings."
      );
    }
    return new Map();
  }
  if (
    mapping === undefined ||
    mapping.instrumentHash !== study.instrumentHash ||
    manifest.items.length !== 30 ||
    mapping.items.length !== 30
  ) {
    throw new TypeError(
      "Full PXI requires 30 item mappings bound to the approved instrument hash."
    );
  }
  const constructByItem = new Map<string, PlaytestPxiConstructId>();
  const itemIds = new Set(manifest.items.map((item) => item.itemId));
  for (const entry of mapping.items) {
    if (
      !itemIds.has(entry.itemId) ||
      constructByItem.has(entry.itemId) ||
      !(PLAYTESTS_PXI_CONSTRUCTS as readonly string[]).includes(
        entry.constructId
      )
    ) {
      throw new TypeError(
        "Full PXI mapping contains an unknown, duplicate, or unmapped item."
      );
    }
    constructByItem.set(entry.itemId, entry.constructId);
  }
  if (
    constructByItem.size !== itemIds.size ||
    [...itemIds].some((itemId) => !constructByItem.has(itemId)) ||
    PLAYTESTS_PXI_CONSTRUCTS.some(
      (constructId) =>
        [...constructByItem.values()].filter((value) => value === constructId)
          .length !== 3
    )
  ) {
    throw new TypeError(
      "Full PXI must map exactly three published items to each of its ten constructs."
    );
  }
  return constructByItem;
}

interface RowFields {
  readonly studyId: string;
  readonly responseId: string;
  readonly participantId: string;
  readonly consentVersion: string;
  readonly consentScope: string;
  readonly instrument: string;
  readonly instrumentVersion: string;
  readonly instrumentHash: string;
  readonly workspaceId: string;
  readonly build: PlaytestVersionedRef;
  readonly episodeId: string;
  readonly exposureStartedAt: string;
  readonly exposureEndedAt: string;
  readonly order: string;
  readonly submittedAt: string;
  readonly completionStatus: string;
  readonly revisionRaw: string;
  readonly supersedes: string | null;
}

function readRowFields(
  row: HumanStudyRawRow,
  manifest: HumanStudyExportManifest
): RowFields {
  const read = (column: string): string => readColumn(row, column);
  const buildHash = read(manifest.buildHashColumn);
  const supersedes = read(manifest.supersedesColumn);
  return {
    studyId: read(manifest.studyIdColumn),
    responseId: read(manifest.responseIdColumn),
    participantId: read(manifest.participantIdColumn),
    consentVersion: read(manifest.consentVersionColumn),
    consentScope: read(manifest.consentScopeColumn),
    instrument: read(manifest.instrumentColumn),
    instrumentVersion: read(manifest.instrumentVersionColumn),
    instrumentHash: read(manifest.instrumentHashColumn),
    workspaceId: read(manifest.workspaceIdColumn),
    build: {
      id: read(manifest.buildIdColumn),
      version: read(manifest.buildVersionColumn),
      ...(buildHash ? { contentHash: buildHash } : {})
    },
    episodeId: read(manifest.episodeIdColumn),
    exposureStartedAt: read(manifest.exposureStartedAtColumn),
    exposureEndedAt: read(manifest.exposureEndedAtColumn),
    order: read(manifest.orderColumn),
    submittedAt: read(manifest.submittedAtColumn),
    completionStatus: read(manifest.completionStatusColumn),
    revisionRaw: read(manifest.revisionColumn),
    supersedes: supersedes || null
  };
}

interface RowProblem {
  readonly reason: HumanStudyImportRejectionReason;
  readonly detail: string;
}

type RowCheck = readonly [
  failed: () => boolean,
  reason: HumanStudyImportRejectionReason,
  detail: string
];

function firstFailure(checks: readonly RowCheck[]): RowProblem | null {
  for (const [failed, reason, detail] of checks) {
    if (failed()) return { reason, detail };
  }
  return null;
}

function hasExactManifestShape(
  row: HumanStudyRawRow,
  expectedColumns: ReadonlySet<string>
): boolean {
  if (typeof row !== "object" || row === null || Array.isArray(row))
    return false;
  const keys = Object.keys(row);
  return (
    keys.length === expectedColumns.size &&
    keys.every((key) => expectedColumns.has(key)) &&
    Object.values(row).every(
      (value) =>
        typeof value === "string" &&
        value.length <= MAX_HUMAN_EXPORT_FIELD_CHARACTERS
    )
  );
}

function hasEveryRequiredField(fields: RowFields): boolean {
  return [
    fields.studyId,
    fields.responseId,
    fields.participantId,
    fields.consentVersion,
    fields.consentScope,
    fields.instrument,
    fields.instrumentVersion,
    fields.instrumentHash,
    fields.workspaceId,
    fields.build.id,
    String(fields.build.version),
    fields.episodeId,
    fields.exposureStartedAt,
    fields.exposureEndedAt,
    fields.order,
    fields.submittedAt,
    fields.completionStatus
  ].every((value) => value.length > 0);
}

function hasOrderedTimestamps(fields: RowFields): boolean {
  const started = finiteTimestamp(fields.exposureStartedAt);
  const ended = finiteTimestamp(fields.exposureEndedAt);
  const submitted = finiteTimestamp(fields.submittedAt);
  return (
    started !== null &&
    ended !== null &&
    submitted !== null &&
    started <= ended &&
    ended <= submitted
  );
}

function orderMatchesDesign(study: HumanPlaytestStudy, order: string): boolean {
  if (study.orderDesign === SINGLE_BUILD_ORDER)
    return order === SINGLE_BUILD_ORDER;
  if (order === SINGLE_BUILD_ORDER) return false;
  return study.orderDesign === "A/B" ? order === "A-first" : true;
}

/** Structural checks, then authoritative study identity, then trusted callbacks (which can only restrict). */
function validateRow(
  study: HumanPlaytestStudy,
  fields: RowFields,
  validators: HumanStudyImportValidators
): RowProblem | null {
  return (
    validateRowShape(study, fields) ??
    validateTrustedRow(study, fields, validators)
  );
}

function validateRowShape(
  study: HumanPlaytestStudy,
  fields: RowFields
): RowProblem | null {
  return firstFailure([
    [
      () =>
        !hasEveryRequiredField(fields) ||
        positiveInteger(fields.revisionRaw) === null,
      REJECT_MALFORMED,
      "A required field is empty or the revision is not a positive integer."
    ],
    [
      () =>
        fields.studyId !== study.studyId ||
        !(PLAYTESTS_HUMAN_INSTRUMENTS as readonly string[]).includes(
          fields.instrument
        ) ||
        !(HUMAN_STUDY_COMPLETION_STATUSES as readonly string[]).includes(
          fields.completionStatus
        ) ||
        !(HUMAN_STUDY_ORDERS as readonly string[]).includes(fields.order) ||
        !orderMatchesDesign(study, fields.order) ||
        !hasOrderedTimestamps(fields),
      REJECT_MALFORMED,
      "Study identity, completion status, order, or timestamp sequence is invalid."
    ]
  ]);
}

function studyAllowsBuild(
  study: HumanPlaytestStudy,
  build: PlaytestVersionedRef
): boolean {
  return study.allowedBuilds.some(
    (allowed) =>
      allowed.id === build.id &&
      allowed.version === build.version &&
      (allowed.contentHash ?? null) === (build.contentHash ?? null)
  );
}

function validateTrustedRow(
  study: HumanPlaytestStudy,
  fields: RowFields,
  validators: HumanStudyImportValidators
): RowProblem | null {
  return firstFailure([
    [
      () =>
        fields.workspaceId !== study.workspaceId ||
        !validators.isWorkspaceAllowed(study, fields.workspaceId),
      "wrong-workspace",
      "Response workspace does not match the approved study workspace."
    ],
    [
      () =>
        !studyAllowsBuild(study, fields.build) ||
        !validators.isBuildAllowed(study, fields.build),
      "wrong-build",
      "Response build is not approved for this study."
    ],
    [
      () =>
        fields.instrument !== study.instrument ||
        fields.instrumentVersion !== study.instrumentVersion ||
        fields.instrumentHash !== study.instrumentHash ||
        !validators.isTrustedInstrumentVersion(
          study,
          fields.instrument,
          fields.instrumentVersion,
          fields.instrumentHash
        ),
      "untrusted-instrument-version",
      "Instrument version/hash does not match the approved study."
    ],
    [
      () =>
        !validators.isValidEpisodeLink(study, fields.episodeId, fields.build),
      "invalid-episode-link",
      "Episode is not linked to the approved workspace/build exposure."
    ],
    [
      () => validators.isParticipantWithdrawn(study, fields.participantId),
      "withdrawn-participant",
      "Participant is withdrawn from this study."
    ],
    [
      () =>
        fields.consentVersion !== study.consentVersion ||
        fields.consentScope !== study.consentScope ||
        !validators.isConsentValid(
          study,
          fields.participantId,
          fields.consentVersion,
          fields.consentScope
        ),
      "consent-mismatch",
      "Consent version/scope does not authorize this response."
    ],
    [
      () =>
        !validators.isExposureSufficient(
          study,
          fields.exposureStartedAt,
          fields.exposureEndedAt
        ),
      "invalid-exposure",
      "Exposure window does not meet the study minimum exposure."
    ],
    [
      () =>
        !validators.isWithinResponseWindow(
          study,
          fields.exposureEndedAt,
          fields.submittedAt
        ),
      "wrong-timing",
      "Response is outside the approved response timing window."
    ]
  ]);
}

type ItemResult =
  | {
      readonly nativeValue: number | null;
      readonly missingReason?: PlaytestMissingReason;
    }
  | { readonly problem: RowProblem };

function readMissingItem(itemId: string, rawReason: string): ItemResult {
  if (!rawReason) {
    return {
      nativeValue: null,
      missingReason: itemId === "ENJ" ? "missing-ENJ" : "unobserved"
    };
  }
  if (!(PLAYTESTS_MISSING_REASONS as readonly string[]).includes(rawReason)) {
    return {
      problem: {
        reason: "bad-missing-reason",
        detail:
          "Missing-item reason is not in the closed missingness vocabulary."
      }
    };
  }
  return {
    nativeValue: null,
    missingReason: rawReason as PlaytestMissingReason
  };
}

function readPresentItem(
  rawValue: string,
  rawReason: string,
  instrument: string,
  scale: NativeScale
): ItemResult {
  if (rawReason !== "") {
    return {
      problem: {
        reason: REJECT_MALFORMED,
        detail: "A present native value cannot also carry a missing reason."
      }
    };
  }
  const parsed = parseStrictHumanNumber(rawValue);
  const requiresInteger = instrument === "miniPXI" || instrument === "PXI";
  if (
    parsed === null ||
    parsed < scale.minimum ||
    parsed > scale.maximum ||
    (requiresInteger && !Number.isInteger(parsed))
  ) {
    return {
      problem: {
        reason: REJECT_BAD_ITEM_RANGE,
        detail:
          "Native item value is not a strict number within the approved instrument scale."
      }
    };
  }
  return { nativeValue: parsed };
}

function readItem(
  row: HumanStudyRawRow,
  itemColumn: HumanStudyExportItemColumn,
  instrument: string,
  scale: NativeScale
): ItemResult {
  if (
    instrument === "miniPXI" &&
    !(PLAYTESTS_MINIPXI_ITEMS as readonly string[]).includes(itemColumn.itemId)
  ) {
    return {
      problem: {
        reason: "bad-item-id",
        detail: "Item ID is not a published miniPXI item."
      }
    };
  }
  const rawValue = readColumn(row, itemColumn.valueColumn);
  const rawReason = itemColumn.missingReasonColumn
    ? readColumn(row, itemColumn.missingReasonColumn)
    : "";
  return rawValue === ""
    ? readMissingItem(itemColumn.itemId, rawReason)
    : readPresentItem(rawValue, rawReason, instrument, scale);
}

function mapRowItems(
  row: HumanStudyRawRow,
  fields: RowFields,
  manifest: HumanStudyExportManifest,
  scale: NativeScale,
  constructByItem: ReadonlyMap<string, PlaytestPxiConstructId>
): HumanStudyResponse[] | RowProblem {
  const items: HumanStudyResponse[] = [];
  for (const itemColumn of manifest.items) {
    const result = readItem(row, itemColumn, fields.instrument, scale);
    if ("problem" in result) return result.problem;
    items.push({
      studyId: fields.studyId,
      responseId: fields.responseId,
      revision: positiveInteger(fields.revisionRaw)!,
      supersedes: fields.supersedes,
      pseudonymousParticipantId: fields.participantId,
      consentVersion: fields.consentVersion,
      consentScope: fields.consentScope,
      instrument: fields.instrument as HumanExperienceResponse["instrument"],
      instrumentVersion: fields.instrumentVersion,
      instrumentHash: fields.instrumentHash,
      build: fields.build,
      episodeId: fields.episodeId,
      exposureStartedAt: fields.exposureStartedAt,
      exposureEndedAt: fields.exposureEndedAt,
      order: fields.order as HumanExperienceResponse["order"],
      submittedAt: fields.submittedAt,
      completionStatus: fields.completionStatus as HumanStudyCompletionStatus,
      nativeMinimum: scale.minimum,
      nativeMaximum: scale.maximum,
      nativeUnit: scale.unit,
      ...(constructByItem.has(itemColumn.itemId)
        ? { constructId: constructByItem.get(itemColumn.itemId)! }
        : {}),
      itemId: itemColumn.itemId,
      nativeValue: result.nativeValue,
      ...(result.missingReason === undefined
        ? {}
        : { missingReason: result.missingReason }),
      withdrawn: false
    });
  }
  return items;
}

interface Candidate {
  readonly rowIndex: number;
  readonly items: readonly HumanStudyResponse[];
}

interface ExistingIndex {
  readonly byResponseId: ReadonlyMap<string, readonly HumanStudyResponse[]>;
  readonly supersededIds: ReadonlySet<string>;
}

function indexExisting(existing: readonly HumanStudyResponse[]): ExistingIndex {
  const byResponseId = new Map<string, HumanStudyResponse[]>();
  for (const response of existing) {
    const group = byResponseId.get(response.responseId) ?? [];
    group.push(response);
    byResponseId.set(response.responseId, group);
  }
  const supersededIds = new Set<string>();
  for (const response of existing) {
    if (response.supersedes !== null) supersededIds.add(response.supersedes);
  }
  return { byResponseId, supersededIds };
}

function rejection(
  study: HumanPlaytestStudy,
  rowIndex: number,
  responseId: string | null,
  problem: RowProblem
): HumanStudyImportRejection {
  return { rowIndex, studyId: study.studyId, responseId, ...problem };
}

/** Parse and validate each row into candidate response groups. */
function collectCandidates(
  study: HumanPlaytestStudy,
  rows: readonly HumanStudyRawRow[],
  manifest: HumanStudyExportManifest,
  validators: HumanStudyImportValidators,
  rejected: HumanStudyImportRejection[],
  constructByItem: ReadonlyMap<string, PlaytestPxiConstructId>
): Map<string, Candidate> {
  const expectedColumns = new Set(manifestColumns(manifest));
  const scale = resolveNativeScale(study, manifest);
  const candidates = new Map<string, Candidate>();
  const seenIds = new Set<string>();
  rows.forEach((row, rowIndex) => {
    if (!hasExactManifestShape(row, expectedColumns)) {
      rejected.push(
        rejection(study, rowIndex, null, {
          reason: REJECT_MALFORMED,
          detail:
            "Row columns do not exactly match the bounded export manifest."
        })
      );
      return;
    }
    const fields = readRowFields(row, manifest);
    const responseId = fields.responseId || null;
    if (responseId !== null && seenIds.has(responseId)) {
      rejected.push(
        rejection(study, rowIndex, responseId, {
          reason: REJECT_MALFORMED,
          detail: "Each export row must have a unique responseId."
        })
      );
      return;
    }
    if (responseId !== null) seenIds.add(responseId);
    const problem = validateRow(study, fields, validators);
    if (problem) {
      rejected.push(rejection(study, rowIndex, responseId, problem));
      return;
    }
    const items = mapRowItems(row, fields, manifest, scale, constructByItem);
    if (!Array.isArray(items)) {
      rejected.push(
        rejection(study, rowIndex, responseId, items as RowProblem)
      );
      return;
    }
    candidates.set(fields.responseId, { rowIndex, items });
  });
  return candidates;
}

/** (studyId,responseId) is idempotent only when the full response provenance matches. */
function splitIdempotentReplays(
  study: HumanPlaytestStudy,
  candidates: Map<string, Candidate>,
  existing: ExistingIndex,
  unchanged: HumanStudyResponse[],
  rejected: HumanStudyImportRejection[]
): void {
  for (const [responseId, candidate] of candidates) {
    const prior = existing.byResponseId.get(responseId);
    if (!prior) continue;
    candidates.delete(responseId);
    if (responseSignature(prior) === responseSignature(candidate.items)) {
      unchanged.push(...candidate.items);
    } else {
      rejected.push(
        rejection(study, candidate.rowIndex, responseId, {
          reason: REJECT_MALFORMED,
          detail:
            "Idempotency key already exists with different response provenance."
        })
      );
    }
  }
}

function supersedesProblem(
  response: HumanStudyResponse,
  existing: ExistingIndex,
  claimed: ReadonlySet<string>
): string | null {
  const targetId = response.supersedes;
  if (response.revision === 1) {
    return targetId === null
      ? null
      : "Revision 1 cannot supersede another response.";
  }
  if (targetId === null)
    return "Revisions after 1 must name the response they supersede.";
  const target = existing.byResponseId.get(targetId)?.[0];
  if (
    target === undefined ||
    existing.supersededIds.has(targetId) ||
    claimed.has(targetId) ||
    lineageKey(target) !== lineageKey(response) ||
    response.revision !== target.revision + 1
  ) {
    return "supersedes must reference the current same-lineage response at exactly revision+1.";
  }
  return null;
}

function applySupersedes(
  study: HumanPlaytestStudy,
  candidates: Map<string, Candidate>,
  existing: ExistingIndex,
  rejected: HumanStudyImportRejection[]
): Set<string> {
  const superseded = new Set<string>();
  for (const [responseId, candidate] of candidates) {
    const response = candidate.items[0]!;
    const detail = supersedesProblem(response, existing, superseded);
    if (detail !== null) {
      candidates.delete(responseId);
      rejected.push(
        rejection(study, candidate.rowIndex, responseId, {
          reason: REJECT_MALFORMED,
          detail
        })
      );
      continue;
    }
    if (response.supersedes !== null) superseded.add(response.supersedes);
  }
  return superseded;
}

function addToLineage(
  lineages: Map<string, Set<string>>,
  response: HumanStudyResponse
): void {
  const key = lineageKey(response);
  const ids = lineages.get(key) ?? new Set<string>();
  ids.add(response.responseId);
  lineages.set(key, ids);
}

/** Duplicate participant x episode x instrument submissions are never silently counted twice. */
function detectDuplicates(
  candidates: ReadonlyMap<string, Candidate>,
  existing: ExistingIndex,
  superseded: ReadonlySet<string>
): readonly HumanStudyDuplicateQuarantine[] {
  const lineages = new Map<string, Set<string>>();
  for (const [responseId, group] of existing.byResponseId) {
    if (existing.supersededIds.has(responseId) || superseded.has(responseId))
      continue;
    addToLineage(lineages, group[0]!);
  }
  for (const candidate of candidates.values())
    addToLineage(lineages, candidate.items[0]!);
  const quarantined: HumanStudyDuplicateQuarantine[] = [];
  for (const ids of lineages.values()) {
    const firstNewId = [...ids].find((id) => candidates.has(id));
    if (ids.size < 2 || firstNewId === undefined) continue;
    const first = candidates.get(firstNewId)!.items[0]!;
    quarantined.push({
      studyId: first.studyId,
      participantId: first.pseudonymousParticipantId,
      episodeId: first.episodeId,
      instrument: first.instrument,
      responseIds: [...ids],
      reason: "duplicate-participant-episode-instrument"
    });
  }
  return quarantined;
}

function unapprovedOutcome(
  study: HumanPlaytestStudy,
  rows: readonly HumanStudyRawRow[]
): HumanStudyImportOutcome {
  return rejectedOutcome(
    study,
    rows,
    "unapproved-study",
    "Study is not approved for import."
  );
}

function rejectedOutcome(
  study: HumanPlaytestStudy,
  rows: readonly HumanStudyRawRow[],
  reason: HumanStudyImportRejectionReason,
  detail: string
): HumanStudyImportOutcome {
  return {
    accepted: [],
    unchanged: [],
    superseded: [],
    quarantined: [],
    quarantinedResponses: [],
    rejected: rows.map((_, rowIndex) =>
      rejection(study, rowIndex, null, {
        reason,
        detail
      })
    )
  };
}

/** Validate and map an authorized export. Re-imports are full-provenance idempotent. */
export function importHumanStudyResponses(
  study: HumanPlaytestStudy,
  rows: readonly HumanStudyRawRow[],
  manifest: HumanStudyExportManifest,
  validators: HumanStudyImportValidators,
  existing: readonly HumanStudyResponse[] = []
): HumanStudyImportOutcome {
  if (existing.some((response) => response.studyId !== study.studyId)) {
    throw new TypeError("Existing responses must belong to the target study.");
  }
  resolveNativeScale(study, manifest);
  manifestColumns(manifest);
  const constructByItem = validatePxiItemConstructMapping(study, manifest);
  if (
    study.schema !== PLAYTESTS_HUMAN_STUDY_SCHEMA ||
    study.approved !== true ||
    !validators.isApprovedStudy(study)
  ) {
    return unapprovedOutcome(study, rows);
  }
  if (
    study.instrument === "PXI" &&
    !validators.isTrustedPxiItemConstructMapping(
      study,
      manifest.pxiItemConstructMapping!
    )
  ) {
    return rejectedOutcome(
      study,
      rows,
      "untrusted-instrument-version",
      "Full-PXI item/construct mapping is not trusted for the approved instrument hash."
    );
  }
  if (rows.length > MAX_HUMAN_EXPORT_ROWS)
    throw new TypeError(TOO_MANY_ROWS_ERROR);
  const rejected: HumanStudyImportRejection[] = [];
  const unchanged: HumanStudyResponse[] = [];
  const index = indexExisting(existing);
  const candidates = collectCandidates(
    study,
    rows,
    manifest,
    validators,
    rejected,
    constructByItem
  );
  splitIdempotentReplays(study, candidates, index, unchanged, rejected);
  const superseded = applySupersedes(study, candidates, index, rejected);
  const quarantined = detectDuplicates(candidates, index, superseded);
  const quarantinedIds = new Set(
    quarantined.flatMap((entry) => entry.responseIds)
  );
  const accepted: HumanStudyResponse[] = [];
  const quarantinedResponses: HumanStudyResponse[] = [];
  for (const [responseId, candidate] of candidates) {
    const target = quarantinedIds.has(responseId)
      ? quarantinedResponses
      : accepted;
    target.push(...candidate.items);
  }
  return {
    accepted,
    unchanged,
    superseded: [...superseded],
    rejected,
    quarantined,
    quarantinedResponses
  };
}
