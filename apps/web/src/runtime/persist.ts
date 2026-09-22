// Persistence uses one canonical transport-aware format. Older bundles are
// normalized at the read boundary and stay untouched until the next ordinary
// save, which makes the format replacement backward compatible and recoverable.
import {
  clamp1,
  connections,
  histOpenSig,
  instrumentTiming,
  mainBpmSig,
  mkConn,
  paramByKey,
  patchViewSig,
  sensitivitySig,
  seqCfg,
  touchConnections,
  viewsSig,
  type Conn,
  type SeqCfg,
} from "./state";
import {
  DEFAULT_BPM,
  DEFAULT_DIVISION,
  clampBpm,
  divisionFromMilliseconds,
  isDivision,
  type InstrumentTiming,
} from "../audio/transport";
import { soundIntent } from "./sound";

export const STORAGE_KEY = "oddball.patchbay.v1";
export const GESTURE_KEY = "oddball.gestures.v1";
export const PROFILE_KEY = "oddball.profiles.v1";
export const STATE_FORMAT = "oddball-transport" as const;
export const STATE_FORMAT_VERSION = 1 as const;

export interface SavedState {
  format: typeof STATE_FORMAT;
  version: typeof STATE_FORMAT_VERSION;
  transport: { mainBpm: number };
  instrumentTiming: Record<string, InstrumentTiming>;
  connections: Record<string, Conn | null>;
  sequences: Record<string, SeqCfg>;
  sensitivity: number;
  sound: boolean;
  views: Record<string, boolean>;
  histOpen: boolean;
  patchView: "rack" | "orbit";
}

let loading = true;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function doneLoading(): void {
  loading = false;
}

const SOURCE_MIGRATION_V2: Record<string, string> = {
  tilt_x: "shake",
  tilt_y: "twist",
  tilt_z: "freefall",
  cc3: "tilt_x",
  cc4: "tilt_y",
  cc5: "tilt_z",
  cc6: "movement",
};
const migrateSource = (src: string) => SOURCE_MIGRATION_V2[src] || src;

/** Legacy helper retained for profile compatibility. */
export function migrateBundleV2<T extends { connections?: any; seqCfg?: any }>(bundle: T): T {
  if (!bundle || typeof bundle !== "object") return bundle;
  if (bundle.connections && typeof bundle.connections === "object") {
    for (const key in bundle.connections) {
      const conn = bundle.connections[key];
      if (conn && typeof conn.source === "string") conn.source = migrateSource(conn.source);
      if (conn && typeof conn.noteSource === "string") conn.noteSource = migrateSource(conn.noteSource);
    }
  }
  if (bundle.seqCfg && typeof bundle.seqCfg === "object") {
    const migrated: Record<string, unknown> = {};
    for (const src in bundle.seqCfg) migrated[migrateSource(src)] = bundle.seqCfg[src];
    bundle.seqCfg = migrated;
  }
  return bundle;
}

function normalizeTiming(value: any): InstrumentTiming {
  return {
    mode: value?.mode === "custom" ? "custom" : "main",
    bpm: clampBpm(typeof value?.bpm === "number" ? value.bpm : DEFAULT_BPM),
    division: isDivision(value?.division) ? value.division : DEFAULT_DIVISION,
    phaseOffset: Number.isFinite(value?.phaseOffset) ? value.phaseOffset : 0,
  };
}

function normalizeSequences(value: any, legacy = false): Record<string, SeqCfg> {
  const normalized: Record<string, SeqCfg> = {};
  if (!value || typeof value !== "object") return normalized;
  for (const source in value) {
    const config = value[source];
    if (!config || (config.mode !== "together" && config.mode !== "sequence")) continue;
    const gap = typeof config.gap === "number" ? Math.max(0, config.gap) : 130;
    normalized[legacy ? migrateSource(source) : source] = {
      mode: config.mode,
      gap,
      stepDivision: isDivision(config.stepDivision) ? config.stepDivision : divisionFromMilliseconds(gap),
    };
  }
  return normalized;
}

function normalizeConnections(value: any, legacy = false): Record<string, Conn | null> {
  const normalized: Record<string, Conn | null> = {};
  if (!value || typeof value !== "object") return normalized;
  for (const instKey in value) {
    const raw = value[instKey];
    if (raw === null) {
      normalized[instKey] = null;
      continue;
    }
    if (!raw || typeof raw.source !== "string") continue;
    const source = legacy ? migrateSource(raw.source) : raw.source;
    const conn = mkConn(source, typeof raw.atten === "number" ? raw.atten : 1, typeof raw.thresh === "number" ? raw.thresh : 0);
    if (typeof raw.order === "number") conn.order = raw.order;
    if (typeof raw.noteSource === "string") conn.noteSource = legacy ? migrateSource(raw.noteSource) : raw.noteSource;
    normalized[instKey] = conn;
  }
  return normalized;
}

/** Convert either persisted generation into the replacement in-memory shape. */
export function normalizeSavedState(raw: any): SavedState | null {
  if (!raw || typeof raw !== "object") return null;
  const modern = raw.format === STATE_FORMAT;
  const timings: Record<string, InstrumentTiming> = {};
  for (const instKey in instrumentTiming) timings[instKey] = normalizeTiming(modern ? raw.instrumentTiming?.[instKey] : null);
  const legacyV1 = !modern && (raw.schema || 1) < 2;

  return {
    format: STATE_FORMAT,
    version: STATE_FORMAT_VERSION,
    transport: { mainBpm: clampBpm(modern ? raw.transport?.mainBpm : DEFAULT_BPM) },
    instrumentTiming: timings,
    connections: normalizeConnections(raw.connections, legacyV1),
    sequences: normalizeSequences(modern ? raw.sequences : raw.seqCfg, legacyV1),
    sensitivity: typeof raw.sensitivity === "number" ? Math.max(0, Math.min(100, raw.sensitivity)) : 45,
    sound: typeof raw.sound === "boolean" ? raw.sound : true,
    views: raw.views && typeof raw.views === "object" ? { ...raw.views } : {},
    histOpen: !!raw.histOpen,
    patchView: raw.patchView === "orbit" ? "orbit" : "rack",
  };
}

function cloneTiming(): Record<string, InstrumentTiming> {
  const out: Record<string, InstrumentTiming> = {};
  for (const key in instrumentTiming) out[key] = { ...instrumentTiming[key] };
  return out;
}

export function serializeState(): SavedState {
  return {
    format: STATE_FORMAT,
    version: STATE_FORMAT_VERSION,
    transport: { mainBpm: mainBpmSig.peek() },
    instrumentTiming: cloneTiming(),
    connections,
    sequences: seqCfg,
    sensitivity: sensitivitySig.peek(),
    sound: soundIntent,
    views: viewsSig.peek(),
    histOpen: histOpenSig.peek(),
    patchView: patchViewSig.peek(),
  };
}

export function saveState(): void {
  if (loading) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeState()));
  } catch {
    /* storage unavailable (private mode / quota) */
  }
}

export function saveStateSoon(): void {
  if (loading) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 200);
}

export function loadState(): SavedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeSavedState(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function applySeqCfg(saved: Record<string, SeqCfg> | undefined, replace = false): void {
  if (replace) for (const key in seqCfg) delete seqCfg[key];
  const normalized = normalizeSequences(saved);
  for (const source in normalized) seqCfg[source] = normalized[source];
}

export function applyConnections(saved: Record<string, any> | undefined): void {
  if (!saved) return;
  for (const instKey in connections) {
    const raw = saved[instKey];
    if (raw && typeof raw.source === "string" && paramByKey(raw.source)) {
      connections[instKey] = mkConn(raw.source, typeof raw.atten === "number" ? clamp1(raw.atten) : 1, typeof raw.thresh === "number" ? clamp1(raw.thresh) : 0);
      if (typeof raw.order === "number") connections[instKey]!.order = raw.order;
      if (typeof raw.noteSource === "string" && paramByKey(raw.noteSource)) connections[instKey]!.noteSource = raw.noteSource;
    } else if (raw === null) connections[instKey] = null;
  }
  touchConnections();
}

export function applySavedState(saved: SavedState | null): void {
  if (!saved) return;
  applyConnections(saved.connections);
  applySeqCfg(saved.sequences);
  mainBpmSig.value = saved.transport.mainBpm;
  for (const instKey in instrumentTiming) instrumentTiming[instKey] = normalizeTiming(saved.instrumentTiming[instKey]);
  sensitivitySig.value = saved.sensitivity;
}
