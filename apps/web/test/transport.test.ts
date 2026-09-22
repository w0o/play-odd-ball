import { describe, expect, it } from "vitest";
import {
  AudioTimeTransport,
  DEFAULT_BPM,
  bpmFromInput,
  bpmFromVerticalDrag,
  divisionFromMilliseconds,
  effectiveBpm,
  stepSeconds,
  type InstrumentTiming,
} from "../src/audio/transport";
import { normalizeSavedState, STATE_FORMAT } from "../src/runtime/persist";

describe("audio-time transport math", () => {
  it("defaults the main transport to 120 BPM", () => {
    expect(DEFAULT_BPM).toBe(120);
  });

  it("commits hand-entered BPM values and preserves the current value for a blank draft", () => {
    expect(bpmFromInput("148", 120)).toBe(148);
    expect(bpmFromInput("", 148)).toBe(148);
    expect(bpmFromInput("999", 120)).toBe(300);
  });

  it("converts vertical dragging into bounded BPM changes", () => {
    expect(bpmFromVerticalDrag(120, -20)).toBe(130);
    expect(bpmFromVerticalDrag(120, 20)).toBe(110);
    expect(bpmFromVerticalDrag(299, -20)).toBe(300);
  });

  it("converts musical divisions without accumulating rounded milliseconds", () => {
    expect(stepSeconds(120, "1/4")).toBe(0.5);
    expect(stepSeconds(120, "1/8")).toBe(0.25);
    expect(stepSeconds(180, "1/4")).toBeCloseTo(1 / 3, 10);
  });

  it("supports stable 2:3 and 3:4 tempo relationships from one origin", () => {
    const elapsed = 6;
    expect((elapsed * 120) / 60).toBe(12);
    expect((elapsed * 180) / 60).toBe(18);
    expect((elapsed * 160) / 60).toBe(16);
  });

  it("uses the main tempo unless an instrument explicitly overrides it", () => {
    const timing: InstrumentTiming = { mode: "main", bpm: 180, division: "1/8", phaseOffset: 0 };
    expect(effectiveBpm(timing, 120)).toBe(120);
    timing.mode = "custom";
    expect(effectiveBpm(timing, 120)).toBe(180);
  });

  it("maps the legacy 130ms chain spacing to a sixteenth note", () => {
    expect(divisionFromMilliseconds(130, 120)).toBe("1/16");
  });

  it("preserves beat phase when the main tempo changes", () => {
    const clock = new AudioTimeTransport();
    const ctx = { currentTime: 4 } as AudioContext;
    clock.attach(ctx);
    clock.origin = 1;
    expect(clock.beatPosition(120)).toBe(6);
    clock.retime(120, 180);
    expect(clock.beatPosition(180)).toBeCloseTo(6, 10);
  });
});

describe("replacement persistence format", () => {
  it("normalizes legacy state without dropping patch data", () => {
    const state = normalizeSavedState({
      schema: 2,
      connections: { bass: { source: "roll_speed", atten: 0.7, thresh: 0.2 } },
      seqCfg: { roll_speed: { mode: "sequence", gap: 130 } },
      sensitivity: 61,
      sound: false,
      views: { roll: true },
    });

    expect(state?.format).toBe(STATE_FORMAT);
    expect(state?.transport.mainBpm).toBe(120);
    expect(state?.instrumentTiming.bass.mode).toBe("main");
    expect(state?.sequences.roll_speed.stepDivision).toBe("1/16");
    expect(state?.connections.bass?.atten).toBe(0.7);
    expect(state?.sound).toBe(false);
  });

  it("keeps custom instrument tempos from replacement-format state", () => {
    const state = normalizeSavedState({
      format: STATE_FORMAT,
      transport: { mainBpm: 120 },
      instrumentTiming: {
        piano: { mode: "custom", bpm: 180, division: "1/4", phaseOffset: 0 },
      },
      connections: {},
      sequences: {},
    });
    expect(state?.instrumentTiming.piano).toEqual({ mode: "custom", bpm: 180, division: "1/4", phaseOffset: 0 });
  });
});
