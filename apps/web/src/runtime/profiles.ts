// Saved profiles: snapshot the whole movement→sound layout. A profile bundles
// the patch connections, the moves themselves (self-contained: reloading it
// recreates the gesture triggers) and the roll sensitivity.
import { serializeGestures } from "@oddball/core";
import {
  audio,
  connections,
  connEditorSig,
  editingGestureSig,
  gesturesSig,
  instrumentTiming,
  logEvent,
  mainBpmSig,
  profilesSig,
  sensitivitySig,
  seqCfg,
  type Profile,
} from "./state";
import {
  applyConnections,
  applySeqCfg,
  migrateBundleV2,
  PROFILE_KEY,
  saveState,
  STATE_FORMAT,
  STATE_FORMAT_VERSION,
} from "./persist";
import { DEFAULT_BPM, DEFAULT_DIVISION, clampBpm, divisionFromMilliseconds, isDivision } from "../audio/transport";
import { disconnect, resetSeqRuntime } from "./patch";
import { INSTRUMENTS } from "./state";
import { replaceGestures } from "./gestures";

export function loadProfiles(): void {
  let rawProfiles: any[] = [];
  try {
    const data = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
    rawProfiles = Array.isArray(data) ? data.filter((p) => p && p.id) : [];
  } catch {
    rawProfiles = [];
  }
  profilesSig.value = rawProfiles.map(normalizeProfile);
}

function normalizeProfile(raw: any): Profile {
  const modern = raw.format === STATE_FORMAT;
  if (!modern && (raw.schema || 1) < 2) migrateBundleV2(raw);
  const timings: Profile["instrumentTiming"] = {};
  for (const inst of INSTRUMENTS) {
    const value = modern ? raw.instrumentTiming?.[inst.key] : null;
    timings[inst.key] = {
      mode: value?.mode === "custom" ? "custom" : "main",
      bpm: clampBpm(typeof value?.bpm === "number" ? value.bpm : DEFAULT_BPM),
      division: isDivision(value?.division) ? value.division : DEFAULT_DIVISION,
      phaseOffset: Number.isFinite(value?.phaseOffset) ? value.phaseOffset : 0,
    };
  }
  const sourceSequences = modern ? raw.sequences : raw.seqCfg;
  const sequences: Profile["sequences"] = {};
  if (sourceSequences && typeof sourceSequences === "object") {
    for (const source in sourceSequences) {
      const value = sourceSequences[source];
      if (!value || (value.mode !== "together" && value.mode !== "sequence")) continue;
      const gap = typeof value.gap === "number" ? Math.max(0, value.gap) : 130;
      sequences[source] = {
        mode: value.mode,
        gap,
        stepDivision: isDivision(value.stepDivision) ? value.stepDivision : divisionFromMilliseconds(gap),
      };
    }
  }
  return {
    id: String(raw.id),
    name: typeof raw.name === "string" ? raw.name : "Profile",
    created: typeof raw.created === "number" ? raw.created : Date.now(),
    format: STATE_FORMAT,
    version: STATE_FORMAT_VERSION,
    connections: raw.connections && typeof raw.connections === "object" ? raw.connections : {},
    sequences,
    gestures: Array.isArray(raw.gestures) ? raw.gestures : [],
    sensitivity: typeof raw.sensitivity === "number" ? raw.sensitivity : 45,
    transport: { mainBpm: clampBpm(modern ? raw.transport?.mainBpm : DEFAULT_BPM) },
    instrumentTiming: timings,
  };
}

export function writeProfiles(): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profilesSig.peek()));
  } catch {
    /* storage unavailable — ignore */
  }
}

/**
 * Save the current layout as a profile. No blocking prompt (the original used
 * window.prompt, which froze the MIDI/animation loop — see
 * docs/CONVERSION-NOTES.md): the profile is created with a default name and
 * the Profiles panel's inline rename field takes it from there.
 * Returns the new profile's id so the UI can focus its name field.
 */
export function saveCurrentProfile(): string {
  const profiles = profilesSig.peek();
  const p: Profile = {
    id: "p" + Date.now().toString(36),
    name: `Profile ${profiles.length + 1}`,
    created: Date.now(),
    format: STATE_FORMAT,
    version: STATE_FORMAT_VERSION,
    connections: serializeConnections(),
    sequences: JSON.parse(JSON.stringify(seqCfg)),
    gestures: serializeGestures(gesturesSig.peek()),
    sensitivity: sensitivitySig.peek(),
    transport: { mainBpm: mainBpmSig.peek() },
    instrumentTiming: JSON.parse(JSON.stringify(instrumentTiming)),
  };
  profilesSig.value = [...profiles, p];
  writeProfiles();
  logEvent("PROFILE", `saved “${p.name}” — rename it in the Profiles panel`, "note");
  return p.id;
}

function serializeConnections(): Profile["connections"] {
  const out: Profile["connections"] = {};
  for (const k in connections) {
    const c = connections[k];
    out[k] = c ? { source: c.source, atten: c.atten, thresh: c.thresh, order: c.order, noteSource: c.noteSource } : null;
  }
  return out;
}

export function applyProfile(id: string): void {
  const profile = profilesSig.peek().find((p) => p.id === id);
  if (!profile) return;
  connEditorSig.value = null;
  editingGestureSig.value = null;

  // Clear the current patch (removes cables) and swap the moves wholesale.
  for (const inst of INSTRUMENTS) if (connections[inst.key]) disconnect(inst.key);
  resetSeqRuntime();
  replaceGestures(profile.gestures as unknown[]);

  // Restore per-source playback config (together vs. in order).
  applySeqCfg(profile.sequences, true);
  mainBpmSig.value = profile.transport.mainBpm;
  for (const key in instrumentTiming) {
    instrumentTiming[key] = { ...profile.instrumentTiming[key] };
  }

  // Now that every source exists, apply the saved connections.
  audio.chimesOn = false;
  applyConnections(profile.connections || {});
  if (connections.chimes) audio.chimesOn = true;

  if (typeof profile.sensitivity === "number") {
    sensitivitySig.value = Math.max(0, Math.min(100, profile.sensitivity));
  }
  saveState();
  logEvent("PROFILE", `loaded “${profile.name}”`, "note");
}

export function deleteProfile(id: string): void {
  profilesSig.value = profilesSig.peek().filter((p) => p.id !== id);
  writeProfiles();
}

export function renameProfile(id: string, name: string): void {
  const p = profilesSig.peek().find((x) => x.id === id);
  if (!p) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === p.name) return;
  p.name = trimmed;
  profilesSig.value = [...profilesSig.peek()];
  writeProfiles();
}
