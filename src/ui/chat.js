import { RARITY } from '../core/config.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const MAX_ENTRIES = 60;      // what the scrollback holds
const VISIBLE_LIFE = 14;     // seconds an entry stays up when the box is closed

/**
 * The run log: who picked up what, who said what, who went down.
 *
 * One panel for both, deliberately. A separate "loot feed" and "chat" would
 * double the furniture on screen and halve the chance of either being read,
 * and in practice the two are the same conversation — somebody takes the
 * Legendary and somebody else has an opinion about it.
 *
 * Closed, it shows the last few lines and fades them out. Open, it holds still
 * and shows the scrollback, because you are reading rather than glancing.
 */
export class Chat {
  constructor(game) {
    this.game = game;
    this.entries = [];
    this.open = false;
    this.el = {
      root: $('chat'),
      log: $('chat-log'),
      form: $('chat-form'),
      input: $('chat-input'),
    };
    this._bind();
  }

  _bind() {
    if (!this.el.input) return;
    // Keystrokes inside the box are for the box. Without this, typing "w"
    // walks you into a wall.
    this.el.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Escape') { this.close(); return; }
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        const text = this.el.input.value.trim();
        this.el.input.value = '';
        if (text) this.say(text);
        this.close();
      }
    });
    this.el.input.addEventListener('blur', () => { if (this.open) this.close(); });
  }

  /* ------------------------------------------------------------------ state */
  toggle() { if (this.open) this.close(); else this.openBox(); }

  openBox() {
    if (this.open || !this.el.input) return;
    if (this.game.state !== 'running') return;
    this.open = true;
    this.el.root.classList.add('typing');
    this.el.form.classList.remove('hidden');
    // Hand the keyboard to the text box and let go of the mouse, so the browser
    // is not fighting us over pointer lock while somebody types.
    this.game.input.enabled = false;
    this.game.input.keys.clear();
    this.game.input.exitLock();
    this.el.input.focus();
    this._render();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.el.root.classList.remove('typing');
    this.el.form.classList.add('hidden');
    this.el.input.blur();
    this.game.input.enabled = true;
    if (this.game.state === 'running' && !this.game.coopPaused) this.game.input.requestLock();
    this._render();
  }

  /* ---------------------------------------------------------------- entries */
  add(entry) {
    this.entries.push({ ...entry, life: VISIBLE_LIFE });
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this._render();
  }

  system(text, color = '#7d89a3') { this.add({ kind: 'system', text, color }); }

  /** `who` is a display name; `self` decides whether it reads as "You". */
  itemPickup(who, item, self = false) {
    const r = RARITY[item.rarity];
    this.add({
      kind: 'pickup',
      name: self ? 'You' : who,
      nameColor: self ? '#46e0c0' : '#dfe6f5',
      verb: self ? 'picked up' : 'picked up',
      text: item.name,
      color: r.color,
      rarity: r.name,
    });
  }

  chat(who, text, color = '#dfe6f5') {
    this.add({ kind: 'chat', name: who, nameColor: color, text });
  }

  /** Local player says something out loud. */
  say(text) {
    const name = this.game.coop?.active
      ? (this.game.coop.session.selfName || 'You')
      : (this.game.profile.data.playerName || 'You');
    const color = `#${(this.game.player?.char?.accent ?? 0x46e0c0).toString(16).padStart(6, '0')}`;
    this.chat(name, text, color);
    this.game.coop?.sendChat(text);
  }

  update(dt) {
    if (this.open) return;
    let dirty = false;
    for (const e of this.entries) {
      if (e.life <= 0) continue;
      e.life -= dt;
      if (e.life <= 0) dirty = true;
    }
    if (dirty) this._render();
  }

  clear() { this.entries.length = 0; this._render(); }

  _render() {
    const log = this.el.log;
    if (!log) return;
    const shown = this.open
      ? this.entries.slice(-14)
      : this.entries.filter((e) => e.life > 0).slice(-6);
    if (!shown.length) { log.innerHTML = ''; return; }
    log.innerHTML = shown.map((e) => {
      const fade = !this.open && e.life < 2 ? ` style="opacity:${(e.life / 2).toFixed(2)}"` : '';
      if (e.kind === 'system') {
        return `<div class="cl-row sys"${fade}><span style="color:${e.color}">${esc(e.text)}</span></div>`;
      }
      if (e.kind === 'pickup') {
        return `<div class="cl-row"${fade}>`
          + `<b style="color:${e.nameColor}">${esc(e.name)}</b> ${esc(e.verb)} `
          + `<span style="color:${e.color}">${esc(e.text)}</span>`
          + `<i>${esc(e.rarity)}</i></div>`;
      }
      return `<div class="cl-row"${fade}><b style="color:${e.nameColor}">${esc(e.name)}</b>: ${esc(e.text)}</div>`;
    }).join('');
    log.scrollTop = log.scrollHeight;
  }
}
