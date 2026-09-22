export const BPM_MIN = 30;
export const BPM_MAX = 300;

export const DIVISIONS = ["1/1", "1/2", "1/4", "1/8", "1/8T", "1/16"] as const;
export type BeatDivision = (typeof DIVISIONS)[number];

/** Length of a division in quarter-note beats. */
export const DIVISION_BEATS: Record<BeatDivision, number> = {
  "1/1": 4,
  "1/2": 2,
  "1/4": 1,
  "1/8": 0.5,
  "1/8T": 1 / 3,
  "1/16": 0.25,
};

export interface InstrumentTiming {
  mode: "main" | "custom";
  bpm: number;
  division: BeatDivision;
  /** Offset in local quarter-note beats from the shared transport origin. */
  phaseOffset: number;
}

export const DEFAULT_BPM = 120;
export const DEFAULT_DIVISION: BeatDivision = "1/8";

export function clampBpm(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BPM;
  return Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(value)));
}

/** Resolve an editable BPM field without replacing a temporary blank value. */
export function bpmFromInput(value: string, fallback: number): number {
  if (!value.trim()) return clampBpm(fallback);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clampBpm(parsed) : clampBpm(fallback);
}

/** Two vertical pixels equal one BPM; dragging upward increases the tempo. */
export function bpmFromVerticalDrag(startBpm: number, deltaY: number): number {
  return clampBpm(startBpm - Math.round(deltaY / 2));
}

export function isDivision(value: unknown): value is BeatDivision {
  return typeof value === "string" && (DIVISIONS as readonly string[]).includes(value);
}

export function effectiveBpm(timing: InstrumentTiming, mainBpm: number): number {
  return timing.mode === "custom" ? clampBpm(timing.bpm) : clampBpm(mainBpm);
}

export function stepSeconds(bpm: number, division: BeatDivision): number {
  return (60 / clampBpm(bpm)) * DIVISION_BEATS[division];
}

/** Closest supported musical division for a legacy millisecond gap. */
export function divisionFromMilliseconds(ms: number, bpm = DEFAULT_BPM): BeatDivision {
  if (!Number.isFinite(ms) || ms <= 0) return "1/16";
  let best: BeatDivision = DEFAULT_DIVISION;
  let bestDistance = Infinity;
  for (const division of DIVISIONS) {
    const distance = Math.abs(stepSeconds(bpm, division) * 1000 - ms);
    if (distance < bestDistance) {
      best = division;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * One origin for every tempo lane. The lanes may use different BPM values,
 * but deriving them from this shared AudioContext timestamp prevents drift.
 */
export class AudioTimeTransport {
  private ctx: AudioContext | null = null;
  origin = 0;
  revision = 0;

  attach(ctx: AudioContext): void {
    this.ctx = ctx;
    if (!this.origin) this.resync();
  }

  now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  resync(): void {
    this.origin = (this.ctx?.currentTime ?? 0) + 0.06;
    this.revision++;
  }

  /** Preserve the current main-beat phase when its BPM changes. */
  retime(oldBpm: number, newBpm: number): void {
    if (!this.ctx || !this.origin) return;
    const now = this.ctx.currentTime;
    const beats = ((now - this.origin) * clampBpm(oldBpm)) / 60;
    this.origin = now - (beats * 60) / clampBpm(newBpm);
    this.revision++;
  }

  beatPosition(bpm: number): number {
    if (!this.ctx || !this.origin) return 0;
    return ((this.ctx.currentTime - this.origin) * clampBpm(bpm)) / 60;
  }
}

export const transport = new AudioTimeTransport();
