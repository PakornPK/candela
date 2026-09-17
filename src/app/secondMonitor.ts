// Second Monitor support: a controls window that mirrors the Develop panel.
//
// The popup is opened with window.open('') and inherits the opener's origin, so
// it is driven directly from the panel's own slider configs -- track range,
// label, and formatted readout all come from the main window. Nothing about a
// control is re-declared here, so the window can't drift from the panel it
// mirrors. (The previous hand-written copy had its own list: it showed the WB
// slider's mired value with a "K" suffix -- "339.0801545268772K" instead of the
// panel's "2949K" -- and its 2000..12000 K track clamped every Kelvin value the
// panel is not actually in.)

export interface MirrorControl {
  /** The real Develop-panel slider this row mirrors. */
  slider: HTMLInputElement;
  /** The panel's own label text for that slider. */
  label: string;
  /** The panel section the slider lives in (rows are grouped by this). */
  group: string;
  /** The panel's own formatted readout for the slider's current value. */
  readout: () => string;
}

export interface ControlsWindowOptions {
  controls: MirrorControl[];
  /** Panel actions, wired to the same handlers the panel's own buttons use. */
  onAction: (action: 'reset' | 'copy' | 'paste') => void;
}

export interface ControlsWindow {
  window: Window;
  /** Repaint every row from the panel (called whenever the panel repaints). */
  sync: () => void;
}

/** Where the controls window opens.
 *
 * Beside the main window is the point of a second monitor; on a single display
 * there is no room there and the window would open past the right edge, so it is
 * centred over the main window instead. `Screen.isExtended` (Chromium) is the
 * only reliable way to tell -- `availWidth` describes the current display only,
 * so it can't answer this.
 */
export function controlsWindowPlacement(view: {
  /** Main window's screen position and size. */
  screenX: number;
  screenY: number;
  outerWidth: number;
  /** True when more than one display is attached. */
  extended: boolean;
  /** Height of the display the main window is on. */
  availHeight: number;
  width: number;
  height: number;
}): { left: number; top: number } {
  return {
    left: view.extended
      ? view.screenX + view.outerWidth
      : Math.max(0, view.screenX + (view.outerWidth - view.width) / 2),
    top: Math.max(0, Math.min(view.screenY, view.availHeight - view.height)),
  };
}

export function openControlsWindow(options: ControlsWindowOptions): ControlsWindow | null {
  const width = 420;
  const height = 860;
  const { left, top } = controlsWindowPlacement({
    screenX,
    screenY,
    outerWidth,
    extended: (screen as Screen & { isExtended?: boolean }).isExtended === true,
    availHeight: screen.availHeight,
    width,
    height,
  });

  const win = window.open(
    '',
    'candela-controls',
    `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
  );
  if (!win) {
    console.error('Failed to open controls window - popup blocked?');
    return null;
  }

  // No <script> in the shell: every listener below is attached from this
  // window, so there is no second copy of the panel's behaviour to keep in sync.
  win.document.write(`<!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Candela Controls</title>
      <style>
        body {
          font-family: system-ui, -apple-system, sans-serif;
          background: #1e1e1e;
          color: #e0e0e0;
          margin: 0;
          padding: 12px;
          font-size: 13px;
        }
        h1 {
          font-size: 13px;
          font-weight: 600;
          color: #7db2ff;
          margin: 0 0 10px;
        }
        .control-group {
          margin-bottom: 12px;
          padding: 10px;
          background: #2a2a2a;
          border-radius: 6px;
        }
        .control-group h3 {
          margin: 0 0 10px;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: #7db2ff;
        }
        .slider-row {
          display: flex;
          align-items: center;
          margin-bottom: 6px;
        }
        .slider-row label {
          flex: 0 0 96px;
          font-size: 12px;
          color: #b8b8b8;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .slider-row input[type="range"] {
          flex: 1;
          min-width: 0;
          margin: 0 8px;
          accent-color: #4a90e2;
        }
        .slider-row output {
          flex: 0 0 62px;
          text-align: right;
          font-family: ui-monospace, monospace;
          font-size: 12px;
          color: #e0e0e0;
        }
        .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
        .actions button:first-child { grid-column: 1 / -1; }
        button {
          background: #3a3a3a;
          color: #e0e0e0;
          border: 1px solid #4a4a4a;
          padding: 6px 10px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
        }
        button:hover { background: #4a4a4a; }
        button:active { background: #5a5a5a; }
        footer {
          margin-top: 4px;
          padding: 8px;
          background: #2a2a2a;
          border-radius: 4px;
          font-size: 11px;
          color: #888;
        }
      </style>
    </head>
    <body>
      <h1>Candela Controls</h1>
      <div id="controls"></div>
      <div class="control-group">
        <h3>Actions</h3>
        <div class="actions">
          <button id="reset-btn">Reset Photo</button>
          <button id="copy-btn">Copy Settings</button>
          <button id="paste-btn">Paste Settings</button>
        </div>
      </div>
      <footer id="status"></footer>
    </body>
    </html>`);
  win.document.close();

  const doc = win.document;
  const controlsRoot = doc.querySelector<HTMLElement>('#controls')!;
  const rows = new Map<HTMLInputElement, { input: HTMLInputElement; output: HTMLOutputElement }>();

  // Rows are grouped like the panel's sections, in ALL_SLIDERS order.
  const groups = new Map<string, MirrorControl[]>();
  for (const control of options.controls) {
    const list = groups.get(control.group);
    if (list) list.push(control);
    else groups.set(control.group, [control]);
  }

  for (const [group, controls] of groups) {
    const section = doc.createElement('div');
    section.className = 'control-group';
    const heading = doc.createElement('h3');
    heading.textContent = group;
    section.appendChild(heading);

    for (const control of controls) {
      const row = doc.createElement('div');
      row.className = 'slider-row';
      const label = doc.createElement('label');
      label.textContent = control.label;
      label.htmlFor = `mirror-${control.slider.id}`;

      const input = doc.createElement('input');
      input.type = 'range';
      input.id = `mirror-${control.slider.id}`;
      // Same track as the panel, so a position in this window means the same
      // thing as that position in the panel.
      input.min = control.slider.min;
      input.max = control.slider.max;
      input.step = control.slider.step;
      input.value = control.slider.value;

      const output = doc.createElement('output');
      output.textContent = control.readout();

      row.append(label, input, output);
      section.appendChild(row);
      rows.set(control.slider, { input, output });

      // Mirror -> panel: move the real slider and let the panel's own wiring do
      // the work (readout, GPU render, undo commit) -- one code path, so the two
      // windows can never disagree.
      input.addEventListener('input', () => {
        control.slider.value = input.value;
        control.slider.dispatchEvent(new Event('input', { bubbles: true }));
      });
      input.addEventListener('change', () => {
        control.slider.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    controlsRoot.appendChild(section);
  }

  doc.querySelector('#reset-btn')!.addEventListener('click', () => options.onAction('reset'));
  doc.querySelector('#copy-btn')!.addEventListener('click', () => options.onAction('copy'));
  doc.querySelector('#paste-btn')!.addEventListener('click', () => options.onAction('paste'));

  const sync = (): void => {
    for (const control of options.controls) {
      const row = rows.get(control.slider);
      if (!row) continue;
      if (row.input.value !== control.slider.value) row.input.value = control.slider.value;
      row.output.textContent = control.readout();
    }
  };
  sync();

  doc.querySelector<HTMLElement>('#status')!.textContent =
    `Mirrors the Develop panel — ${options.controls.length} controls. Edits here and there are the same edit.`;

  return { window: win, sync };
}