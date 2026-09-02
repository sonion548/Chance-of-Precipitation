import { RARITY, RARITY_ORDER } from '../core/config.js';
import { itemIconDataURL } from '../data/itemArt.js';
import { itemDescription } from '../data/items.js';
import { availableItemPool } from '../meta/progression.js';
import { settings } from '../core/settings.js';
import { audio } from '../core/audio.js';

const $ = (id) => document.getElementById(id);

/* Reel geometry, as a fallback only. The real tile width and stride are measured
   off the built strip — the stylesheet owns how wide a tile is, and a reel that
   disagreed with it by a pixel would land visibly off the marker. */
const TILE = 118;
const STRIDE = 126;
/** Tiles built per roll, and which one is the real drop. */
const REEL_LENGTH = 58;
const WIN_INDEX = 47;
/** How long the reel runs before it stops, in seconds. */
const SPIN_TIME = 5.0;
/**
 * How hard the reel decelerates. Higher is a longer, slower tail — the number
 * that decides whether the last two tiles feel like a result or an afterthought.
 */
const EASE_POWER = 4.2;
/** Fraction of a tile the landing may be off-centre, either way. */
const JITTER = 0.33;
/**
 * Seconds the result sits on screen before it takes itself away.
 *
 * Only a safety valve — any key and any click take it — so it is set long
 * enough to read the longest item description twice without being hurried.
 */
const AUTO_TAKE = 15;

/**
 * What the filler tiles look like.
 *
 * Not the chest's own table: a Legendary chest's table never rolls a Common, so
 * a reel built from it would be a wall of gold with one gold winner and no
 * tension at all. The strip is meant to look like the *pool*, so that the good
 * tiles going past are the ones you were hoping it would stop on.
 */
const FILLER_WEIGHTS = { common: 52, uncommon: 30, rare: 12, epic: 5, legendary: 1 };

/**
 * The case-opening reveal: a strip of items scrolling past a marker, slowing
 * down, and stopping on the one the chest actually rolled.
 *
 * It is cosmetic and it is a liar only about *order*, never about outcome — the
 * item is rolled by `systems/loot.js` exactly as it always was, before a single
 * tile is built, and the reel is then constructed around that answer. Nothing
 * here can change what you get, which is the only way an animation like this is
 * allowed to exist in a game with a real drop table.
 *
 * Solo only, and not negotiable: the reel stops the world for five seconds, and
 * in co-op that would either desync you from the party or park your body in a
 * fight while you watched a slot machine. The setting says so, `enabled` checks
 * it again at the moment of the drop, and a chest opened in a lobby falls
 * straight through to the ordinary spawn.
 */
export class CaseRoll {
  constructor(game) {
    this.game = game;
    this.el = {
      root: $('case-roll'),
      source: $('cr-source'),
      window: $('cr-window'),
      reel: $('cr-reel'),
      result: $('cr-result'),
      hint: $('cr-hint'),
    };
    this.active = false;
    this.phase = 'idle';        // idle | spin | landed
    this._raf = 0;
    this._done = null;
    this._winner = null;

    // The overlay owns the pointer while it is up: a click anywhere on it skips
    // or takes, which is the only thing there is to do.
    this.el.root?.addEventListener('click', () => this.advance());
  }

  /** Would a drop reveal itself right now? Checked again at every drop. */
  get enabled() {
    return !!settings.data.caseOpening && !this.game.coop?.active;
  }

  /**
   * Runs the reveal for an already-rolled `item`, calling `onDone` when the
   * player takes it. Returns false if it did not play, in which case the caller
   * is responsible for the drop as usual — so a chest opened with the setting
   * off, or in co-op, or mid-teardown, behaves exactly as it did before.
   */
  play(item, onDone, label = 'Chest') {
    if (!item || !this.enabled || this.active || !this.el.root) return false;
    if (!this.game.freezeForReveal()) return false;

    this.active = true;
    this.phase = 'spin';
    this._done = onDone;
    this._winner = item;

    this.el.source.textContent = label;
    this.el.result.innerHTML = '';
    this.el.result.classList.remove('show');
    this.el.hint.textContent = 'Unsealing…';
    this.el.root.classList.remove('hidden');
    this._buildReel(item);

    // Measured after the overlay is visible: a hidden element has no width, and
    // the landing offset is nothing but width arithmetic.
    this._measure();
    const centre = this._view / 2;
    this._from = centre - this._tile / 2;    // first tile parked under the marker
    const jitter = (Math.random() * 2 - 1) * JITTER * this._stride;
    this._to = centre + jitter - (WIN_INDEX * this._stride + this._tile / 2);
    this._lastTile = -1;
    this._offset(this._from);

    this._startAt = performance.now();
    this._raf = requestAnimationFrame(this._step);
    return true;
  }

  /** Skips to the result, or takes it if it is already showing. */
  advance() {
    if (!this.active) return;
    if (this.phase === 'spin') this._land();
    else this._take();
  }

  /**
   * Key handling while the overlay is up. The game hands every key here first,
   * so nothing else in the run can hear them — Escape must not resume a run out
   * from under a reveal that is still on screen.
   */
  onKey(e) {
    e.preventDefault();
    if (e.repeat) return;
    // Any key advances. There is exactly one thing to do at each phase, and
    // making the player find the right key to dismiss a box is a small cruelty.
    this.advance();
  }

  /** Tears the reveal down without granting anything — for a run ending under it. */
  cancel() {
    if (!this.active) return;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    clearTimeout(this._autoTimer);
    this.active = false;
    this.phase = 'idle';
    this._done = null;
    this._winner = null;
    this.el.root?.classList.add('hidden');
  }

  // ------------------------------------------------------------------ internals
  /**
   * Builds the strip around the winner.
   *
   * The two tiles either side of the win are never the winning item: a reel that
   * stops between two copies of what you got reads as a bug, not as luck.
   */
  _buildReel(winner) {
    const pool = availableItemPool(this.game.profile.data);
    const tiles = [];
    for (let i = 0; i < REEL_LENGTH; i++) {
      if (i === WIN_INDEX) { tiles.push(winner); continue; }
      const near = Math.abs(i - WIN_INDEX) <= 2;
      let pick = this._filler(pool);
      if (near && pick === winner) pick = this._filler(pool, winner);
      tiles.push(pick || winner);
    }
    this.el.reel.innerHTML = tiles.map((item, i) => {
      const r = RARITY[item.rarity];
      return `<div class="cr-tile${i === WIN_INDEX ? ' win' : ''}" style="--rar:${r.color}">
        <img src="${itemIconDataURL(item, 96)}" alt="" />
        <span>${item.name}</span>
      </div>`;
    }).join('');
    this._winTile = this.el.reel.children[WIN_INDEX];
  }

  /**
   * Reads the strip's real dimensions back out of the DOM.
   *
   * The stylesheet decides how wide a tile is, and it changes that on a narrow
   * screen. Measuring rather than assuming is what keeps the reel landing on the
   * marker instead of a few pixels past it.
   */
  _measure() {
    this._view = this.el.window.clientWidth || 900;
    const first = this.el.reel.children[0];
    const second = this.el.reel.children[1];
    this._tile = first?.offsetWidth || TILE;
    this._stride = (first && second) ? (second.offsetLeft - first.offsetLeft) : STRIDE;
    if (!(this._stride > 1)) this._stride = STRIDE;
  }

  /** One filler item, weighted to look like a pool rather than like a table. */
  _filler(pool, avoid = null) {
    let total = 0;
    for (const r of RARITY_ORDER) total += FILLER_WEIGHTS[r] ?? 0;
    let roll = Math.random() * total;
    let rarity = RARITY_ORDER[0];
    for (const r of RARITY_ORDER) {
      roll -= FILLER_WEIGHTS[r] ?? 0;
      if (roll <= 0) { rarity = r; break; }
    }
    // Early on, whole tiers are still locked. Widening to the entire pool beats
    // an empty tile, and the strip is scenery either way.
    let candidates = pool.filter((i) => i.rarity === rarity && i !== avoid);
    if (!candidates.length) candidates = pool.filter((i) => i !== avoid);
    if (!candidates.length) return null;
    return candidates[(Math.random() * candidates.length) | 0];
  }

  _offset(x) {
    this.el.reel.style.transform = `translate3d(${x.toFixed(2)}px,0,0)`;
  }

  /**
   * Driven by the wall clock rather than by accumulated frame deltas.
   *
   * The reel is a five-second promise to the player, and it has to be five
   * seconds on a machine dropping frames as much as on one that is not.
   * Summing dt would make a slow machine's roll visibly longer, and clamping
   * that dt — which any simulation must — would make it longer still.
   */
  _step = (now) => {
    if (!this.active || this.phase !== 'spin') return;
    const t = Math.min(1, (now - this._startAt) / (SPIN_TIME * 1000));
    const eased = 1 - Math.pow(1 - t, EASE_POWER);
    const x = this._from + (this._to - this._from) * eased;
    this._offset(x);

    // One tick per tile that crosses the marker. At the start that is thirty a
    // second and at the end it is one every half second, and that thinning out
    // is the entire sound design of the thing.
    const tile = Math.floor((this._view / 2 - x) / this._stride);
    if (tile !== this._lastTile) {
      if (this._lastTile >= 0) audio.reelTick();
      this._lastTile = tile;
    }

    if (t >= 1) { this._land(); return; }
    this._raf = requestAnimationFrame(this._step);
  };

  /** Stops the reel dead on the winner and shows what it is. */
  _land() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.phase = 'landed';
    this._offset(this._to);
    this._winTile?.classList.add('hit');

    const item = this._winner;
    const r = RARITY[item.rarity];
    audio.caseLand(r.order);
    if (r.order >= 3) this.game.engine.addShake(0.25);

    this.el.result.style.setProperty('--rar', r.color);
    this.el.result.innerHTML = `
      <img class="cr-res-art" src="${itemIconDataURL(item, 128)}" alt="" />
      <div class="cr-res-body">
        <div class="cr-res-head">
          <b style="color:${r.color}">${escapeHtml(item.name)}</b>
          <span style="color:${r.color}">${r.name}${item.tag ? ` · ${escapeHtml(item.tag)}` : ''}</span>
        </div>
        <p>${itemDescription(item, 1, this.game.run).replace(/</g, '&lt;')}</p>
      </div>`;
    this.el.result.classList.add('show');
    this.el.hint.textContent = 'Click or press any key to take it';

    // It lets itself go eventually, so walking away from the keyboard mid-roll
    // does not leave the run frozen forever.
    clearTimeout(this._autoTimer);
    this._autoTimer = setTimeout(() => this._take(), AUTO_TAKE * 1000);
  }

  /** Dismisses the overlay, drops the item into the world, and unfreezes. */
  _take() {
    if (!this.active) return;
    clearTimeout(this._autoTimer);
    const done = this._done;
    this.active = false;
    this.phase = 'idle';
    this._done = null;
    this._winner = null;
    this.el.root.classList.add('hidden');
    this.el.reel.innerHTML = '';
    // Unfreeze first: the drop spawns a pickup and plays effects, and those
    // belong to a running world.
    this.game.unfreezeFromReveal();
    done?.();
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
