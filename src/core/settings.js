/**
 * Player settings: volumes, mouse feel, and key bindings.
 *
 * Kept apart from the profile on purpose. A profile is a record of what you
 * have earned; settings are how the machine in front of you is set up. Wiping
 * your progress should not reset your mouse sensitivity, and importing a
 * profile from another browser should not drag someone else's controls along.
 */

const KEY = 'chance-of-precipitation.settings.v1';

/**
 * Everything the game asks the input layer about, and what it is bound to out
 * of the box. `Mouse0/1/2` are the left, middle and right buttons — they sit in
 * the same namespace as key codes so any action can be bound to either.
 */
export const ACTIONS = [
  { id: 'moveForward', name: 'Move Forward', group: 'Movement' },
  { id: 'moveBack', name: 'Move Back', group: 'Movement' },
  { id: 'moveLeft', name: 'Strafe Left', group: 'Movement' },
  { id: 'moveRight', name: 'Strafe Right', group: 'Movement' },
  { id: 'jump', name: 'Jump', group: 'Movement' },
  { id: 'primary', name: 'Primary Attack', group: 'Combat' },
  { id: 'aim', name: 'Aim', group: 'Combat' },
  { id: 'secondary', name: 'Secondary Ability', group: 'Combat' },
  { id: 'utility', name: 'Utility Ability', group: 'Combat' },
  { id: 'special', name: 'Special Ability', group: 'Combat' },
  { id: 'ultimate', name: 'Ultimate', group: 'Combat' },
  { id: 'interact', name: 'Interact', group: 'World' },
  { id: 'chat', name: 'Chat', group: 'World' },
];

export const DEFAULT_BINDINGS = {
  moveForward: ['KeyW', 'ArrowUp'],
  moveBack: ['KeyS', 'ArrowDown'],
  moveLeft: ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  primary: ['Mouse0'],
  aim: ['Mouse2'],
  secondary: ['KeyQ'],
  utility: ['ShiftLeft', 'ShiftRight'],
  special: ['KeyR'],
  ultimate: ['KeyF'],
  interact: ['KeyE'],
  chat: ['Enter', 'NumpadEnter'],
};

/** Codes the game needs for itself and will not hand out to a rebind. */
export const RESERVED_CODES = ['Escape', 'Tab', 'F5', 'F11', 'F12'];

function freshSettings() {
  return {
    masterVolume: 0.85,
    sfxVolume: 0.9,
    musicVolume: 0.45,
    muted: false,
    sensitivity: 1.0,
    aimSensitivity: 0.7,     // multiplier applied while aiming down sights
    invertY: false,
    cameraShake: 1.0,
    damageNumbers: true,
    /* The case-opening reveal. Off by default, and solo only — see ui/caseRoll.js
       for why it cannot be a co-op setting: it stops the world, and the world is
       not yours to stop when other people are standing in it. */
    caseOpening: false,
    // Camera yaw is independent of the body; this is how hard the body snaps
    // back to the camera when you start shooting.
    turnSnap: 1.0,
    bindings: { ...DEFAULT_BINDINGS },
  };
}

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Pretty name for a binding code, for the controls list. */
export function codeLabel(code) {
  if (!code) return '—';
  if (code === 'Mouse0') return 'Left Mouse';
  if (code === 'Mouse1') return 'Middle Mouse';
  if (code === 'Mouse2') return 'Right Mouse';
  if (code.startsWith('Mouse')) return `Mouse ${Number(code.slice(5)) + 1}`;
  if (code === 'WheelUp') return 'Wheel Up';
  if (code === 'WheelDown') return 'Wheel Down';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return `${code.slice(5)} Arrow`;
  if (code === 'Space') return 'Space';
  if (code.endsWith('Left')) return `L ${code.slice(0, -4)}`;
  if (code.endsWith('Right')) return `R ${code.slice(0, -5)}`;
  return code;
}

/**
 * Very short label for a binding — for the ability badges on the HUD, where
 * there is room for three characters and "Left Mouse" is nine.
 */
export function codeShort(code) {
  if (!code) return '—';
  if (code === 'Mouse0') return 'M1';
  if (code === 'Mouse1') return 'M3';
  if (code === 'Mouse2') return 'M2';
  if (code.startsWith('Mouse')) return `M${Number(code.slice(5)) + 1}`;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'Space') return 'SPC';
  if (code.startsWith('Arrow')) return code.slice(5, 8).toUpperCase();
  if (code.endsWith('Left') || code.endsWith('Right')) return code.replace(/(Left|Right)$/, '').slice(0, 5).toUpperCase();
  return code.slice(0, 5).toUpperCase();
}

class SettingsStore {
  constructor() {
    const base = freshSettings();
    const saved = read() || {};
    this.data = { ...base, ...saved };
    // Bindings are merged per action so a version that adds a new action does
    // not leave old saves without one. An action the player has deliberately
    // emptied stays empty, though — silently handing a key back on the next
    // load would make the controls screen a liar.
    const savedBinds = saved.bindings || {};
    this.data.bindings = {};
    for (const a of ACTIONS) {
      this.data.bindings[a.id] = Array.isArray(savedBinds[a.id])
        ? savedBinds[a.id].filter(Boolean)
        : [...(DEFAULT_BINDINGS[a.id] || [])];
    }
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* private mode */ }
    this.listeners.forEach((fn) => fn(this.data));
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  bindingsFor(action) { return this.data.bindings[action] || []; }

  /**
   * Binds `code` to `action` in `slot`, taking it away from wherever else it was.
   *
   * Two actions on one key is never what anyone meant, and the failure mode —
   * jumping every time you try to open a chest — is baffling from the inside,
   * so the steal is unconditional. It can leave the robbed action with nothing
   * bound at all; that is allowed, and the controls list calls it out in red so
   * it is a visible consequence rather than a silent one.
   */
  rebind(action, slot, code) {
    if (!code || RESERVED_CODES.includes(code)) return false;
    for (const [id, list] of Object.entries(this.data.bindings)) {
      this.data.bindings[id] = list.filter((c, i) => c !== code || (id === action && i === slot));
    }
    const list = this.data.bindings[action] || (this.data.bindings[action] = []);
    list[slot] = code;
    // Slot 1 can be written while slot 0 is empty, which leaves a hole. Compact
    // it so "first binding" always means something.
    this.data.bindings[action] = list.filter(Boolean);
    this.save();
    return true;
  }

  clearBinding(action, slot) {
    const list = this.data.bindings[action] || [];
    list.splice(slot, 1);
    this.data.bindings[action] = list;
    this.save();
  }

  resetBindings() {
    this.data.bindings = { ...DEFAULT_BINDINGS };
    for (const k of Object.keys(this.data.bindings)) this.data.bindings[k] = [...this.data.bindings[k]];
    this.save();
  }

  resetAll() {
    this.data = freshSettings();
    this.save();
  }
}

export const settings = new SettingsStore();
