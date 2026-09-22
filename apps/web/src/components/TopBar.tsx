import {
  paramsList,
  mainBpmSig,
  patchViewSig,
  rateSig,
  soundOnSig,
  statusSig,
  transportBeatSig,
  viewsSig,
  resyncTransport,
  setMainBpm,
} from "../runtime/state";
import { clearPatch, randomizePatch } from "../runtime/patch";
import { toggleSound } from "../runtime/sound";
import { applySelection, connectBluetoothBall, portOptionsSig, portSelectionSig } from "../runtime/midi";
import { saveProfileAndReveal } from "./panels";
import { saveStateSoon } from "../runtime/persist";
import { bpmFromInput, bpmFromVerticalDrag } from "../audio/transport";
import { useEffect, useRef, useState } from "preact/hooks";

const VIEWS = [
  ["ball", "Ball"],
  ["roll", "Roll"],
  ["cc", "CCs"],
  ["log", "Log"],
  ["profiles", "Profiles"],
] as const;

export function setView(view: string, on: boolean): void {
  viewsSig.value = { ...viewsSig.peek(), [view]: on };
}

export function TopBar() {
  const views = viewsSig.value;
  const status = statusSig.value;
  const soundOn = soundOnSig.value;
  const bpm = mainBpmSig.value;
  const beat = transportBeatSig.value;
  const bpmInput = useRef<HTMLInputElement>(null);
  const drag = useRef<{ pointerId: number; startY: number; startBpm: number; active: boolean } | null>(null);
  const [bpmDraft, setBpmDraft] = useState(String(bpm));
  const changeBpm = (value: number) => {
    setMainBpm(value);
    saveStateSoon();
  };
  const commitBpmDraft = () => {
    const next = bpmFromInput(bpmDraft, mainBpmSig.peek());
    changeBpm(next);
    setBpmDraft(String(next));
  };

  useEffect(() => {
    if (document.activeElement !== bpmInput.current || drag.current?.active) setBpmDraft(String(bpm));
  }, [bpm]);

  const startBpmDrag = (event: PointerEvent) => {
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, startY: event.clientY, startBpm: bpm, active: false };
  };
  const moveBpmDrag = (event: PointerEvent) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const deltaY = event.clientY - current.startY;
    if (!current.active && Math.abs(deltaY) < 3) return;
    if (!current.active) {
      current.active = true;
      bpmInput.current?.setPointerCapture(event.pointerId);
    }
    const next = bpmFromVerticalDrag(current.startBpm, deltaY);
    setBpmDraft(String(next));
    changeBpm(next);
    event.preventDefault();
  };
  const endBpmDrag = (event: PointerEvent) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (bpmInput.current?.hasPointerCapture(event.pointerId)) bpmInput.current.releasePointerCapture(event.pointerId);
    drag.current = null;
  };
  return (
    <header class="topbar">
      <div class="brand">
        <span class="brand-dot"></span>
        <h1>
          ODD Ball <span>· patch bay</span>
        </h1>
      </div>
      <div class="controls">
        <div class="tempo" title="Main transport tempo">
          <span class={`tempo-pulse tempo-pulse--${Math.abs(beat) % 4}`} aria-hidden="true"></span>
          <button onClick={() => changeBpm(bpm - 1)} aria-label="Decrease BPM">−</button>
          <input
            ref={bpmInput}
            type="number"
            min="30"
            max="300"
            value={bpmDraft}
            aria-label="Main BPM"
            title="Type a BPM, or drag up and down to adjust"
            onInput={(e) => setBpmDraft((e.target as HTMLInputElement).value)}
            onBlur={commitBpmDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setBpmDraft(String(mainBpmSig.peek()));
                (e.target as HTMLInputElement).blur();
              }
            }}
            onPointerDown={startBpmDrag}
            onPointerMove={moveBpmDrag}
            onPointerUp={endBpmDrag}
            onPointerCancel={endBpmDrag}
          />
          <span>BPM</span>
          <button onClick={() => changeBpm(bpm + 1)} aria-label="Increase BPM">+</button>
          <button class="tempo-sync" onClick={resyncTransport} title="Restart every tempo lane from the shared downbeat">↻</button>
        </div>
        <div class="views">
          {VIEWS.map(([key, label]) => (
            <button
              key={key}
              class={`view-btn${views[key] ? " is-active" : ""}`}
              onClick={() => setView(key, !views[key])}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          class="tool-btn"
          title="Randomize the patch"
          onClick={() => randomizePatch(paramsList().map((p) => p.key))}
        >
          🎲 Random patch
        </button>
        <button class="tool-btn" title="Disconnect every instrument" onClick={clearPatch}>
          🧹 Clear patch
        </button>
        <button
          class="tool-btn"
          title="Save the current movement→sound layout as a profile"
          onClick={saveProfileAndReveal}
        >
          💾 Save profile
        </button>
        <button class={`sound-btn ${soundOn ? "sound-btn--on" : "sound-btn--off"}`} onClick={toggleSound}>
          {soundOn ? "🔊 Sound on" : "🔇 Sound off"}
        </button>
        <button
          class="tool-btn"
          title="Pair an ODD Ball directly over Bluetooth — no macOS MIDI setup needed"
          onClick={connectBluetoothBall}
        >
          🔵 Connect ball
        </button>
        <select
          id="portSelect"
          title="MIDI input port"
          value={portSelectionSig.value}
          onChange={(e) => applySelection((e.target as HTMLSelectElement).value)}
        >
          {portOptionsSig.value.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span class={`status ${status.on ? "status--on" : "status--off"}`}>{status.label}</span>
        <span class="rate">{rateSig.value} msg/s</span>
      </div>
    </header>
  );
}

export { patchViewSig };
