import { createHash } from "node:crypto";

const KST = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const SNAPSHOT_ID_RE = /^[0-9]{14}-[a-f0-9]{16}$/;
const SOURCE_SHA_RE = /^[a-f0-9]{40}$/;
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KST_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+09:00$/;

function kstParts(now) {
  return Object.fromEntries(KST.formatToParts(now)
    .filter(part => part.type !== "literal")
    .map(part => [part.type, part.value]));
}

function kstDate(now) {
  const parts = kstParts(now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function validateRunContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid run context");
  const expected = [
    "observedAtUtc",
    "observedAtKst",
    "statsDateKst",
    "snapshotId",
    "parentSnapshotId",
    "parentSourceSha",
  ];
  if (Object.keys(value).sort().join("\0") !== expected.sort().join("\0")) throw new Error("invalid run context");
  if (
    typeof value.observedAtUtc !== "string"
    || typeof value.observedAtKst !== "string"
    || typeof value.statsDateKst !== "string"
    || !UTC_RE.test(value.observedAtUtc)
    || !KST_RE.test(value.observedAtKst)
    || !SNAPSHOT_ID_RE.test(value.snapshotId)
  ) throw new Error("invalid run context");

  const observedAtUtc = new Date(value.observedAtUtc);
  const observedAtKst = new Date(value.observedAtKst);
  if (
    Number.isNaN(observedAtUtc.valueOf())
    || Number.isNaN(observedAtKst.valueOf())
    || observedAtUtc.toISOString() !== value.observedAtUtc
    || observedAtUtc.getTime() !== observedAtKst.getTime()
    || kstDate(observedAtUtc) !== value.statsDateKst
    || value.observedAtKst.slice(0, 10) !== value.statsDateKst
  ) throw new Error("invalid run context");

  const bootstrap = value.parentSnapshotId === null && value.parentSourceSha === null;
  const parent = typeof value.parentSnapshotId === "string"
    && SNAPSHOT_ID_RE.test(value.parentSnapshotId)
    && typeof value.parentSourceSha === "string"
    && SOURCE_SHA_RE.test(value.parentSourceSha);
  if (!bootstrap && !parent) throw new Error("invalid run context");
  return value;
}

export function createRunContext(now = new Date(), parent = { snapshotId: null, sourceSha: null }) {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("invalid run time");
  const parts = kstParts(now);
  const observedAtUtc = now.toISOString();
  const statsDateKst = `${parts.year}-${parts.month}-${parts.day}`;
  const milliseconds = String(now.getUTCMilliseconds()).padStart(3, "0");
  const observedAtKst = `${statsDateKst}T${parts.hour}:${parts.minute}:${parts.second}.${milliseconds}+09:00`;
  const digest = createHash("sha256").update(`${observedAtUtc}|run-context-v1`).digest("hex").slice(0, 16);
  return validateRunContext({
    observedAtUtc,
    observedAtKst,
    statsDateKst,
    snapshotId: `${observedAtUtc.replace(/\D/g, "").slice(0, 14)}-${digest}`,
    parentSnapshotId: parent?.snapshotId,
    parentSourceSha: parent?.sourceSha,
  });
}

export function readRunContext(env = process.env, now) {
  const encoded = env?.RUN_CONTEXT_JSON;
  if (encoded === undefined) return createRunContext(now ?? new Date());
  if (typeof encoded !== "string") throw new Error("invalid run context");
  try {
    return validateRunContext(JSON.parse(encoded));
  } catch {
    throw new Error("invalid run context");
  }
}
