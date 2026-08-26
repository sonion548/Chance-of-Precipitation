import * as THREE from 'three';
import { RARITY } from '../core/config.js';
import { formatTime, formatNumber, clamp01 } from '../core/mathx.js';
import { itemDescription } from '../data/items.js';
import { itemIconDataURL } from '../data/itemArt.js';
import { settings, codeShort } from '../core/settings.js';

const _v = new THREE.Vector3();

const $ = (id) => document.getElementById(id);

/**
 * DOM-backed HUD. Floating combat text is projected from world space each frame,
 * which keeps it crisp and costs nothing on the GPU.
 */
export class HUD {
  constructor(game) {
    this.game = game;
    this.el = {
      hud: $('hud'),
      clock: $('run-clock'),
      diffLabel: $('diff-label'),
      diffFill: $('diff-fill'),
      stageName: $('stage-name'),
      stageNum: $('stage-num'),
      hpBar: $('hp-bar'),
      hpFill: $('hp-fill'),
      barrierFill: $('barrier-fill'),
      hpText: $('hp-text'),
      xpFill: $('xp-fill'),
      lvlNum: $('lvl-num'),
      gold: $('gold-num'),
      goldWrap: $('gold-wrap'),
      brood: $('brood'),
      party: $('party'),
      abilities: $('abilities'),
      inventory: $('inventory'),
      buffs: $('buffs'),
      prompt: $('prompt'),
      promptKey: $('prompt-key'),
      promptText: $('prompt-text'),
      toasts: $('toasts'),
      dmgLayer: $('dmg-layer'),
      crosshair: $('crosshair'),
      scope: $('scope'),
      reload: $('reload'),
      reloadZone: document.querySelector('#reload .rl-zone'),
      reloadMarker: document.querySelector('#reload .rl-marker'),
      reloadLabel: document.querySelector('#reload .rl-label'),
      hurt: $('hurt-vignette'),
      heal: $('heal-vignette'),
      objective: $('objective'),
      objectiveText: $('objective-text'),
      objectiveFill: $('objective-fill'),
      objectiveSub: $('objective-sub'),
      bossBar: $('boss-bar'),
      bossName: $('boss-name'),
      bossAffix: $('boss-affix'),
      bossHpText: $('boss-hp-text'),
      bossFill: $('boss-fill'),
      bossLag: $('boss-lag'),
      bossPhases: $('boss-phases'),
      pickupCard: $('pickup-card'),
      pcGlyph: $('pc-glyph'),
      pcName: $('pc-name'),
      pcRarity: $('pc-rarity'),
      pcStack: $('pc-stack'),
      pcDesc: $('pc-desc'),
      pcStackLine: $('pc-stackline'),
    };

    this.floaters = [];
    this.pool = [];
    this.hurtTimer = 0;
    this.healTimer = 0;
    this.crossTimer = 0;
    this.promptTimer = 0;
    this.lockedTimer = 0;
    this.abilityEls = null;
    this.lastInventorySignature = '';
    this.pickupTimer = 0;
    this.bossTarget = null;
    this.bossLagValue = 1;
    this.scopeOn = null;
    this.reloadOn = false;
  }

  show() { this.el.hud.classList.remove('hidden'); }
  hide() {
    this.el.hud.classList.add('hidden');
    this._setScope(false);
    this._setReload(false);
    this.setBoss(null);
    this.el.pickupCard.classList.add('hidden');
    this.pickupTimer = 0;
    this.bossTarget = null;
    this.bossLagValue = 1;
    this.clearFloaters();
  }

  // ------------------------------------------------------------------ setup
  buildAbilities(weapon, character) {
    this.el.abilities.innerHTML = '';
    // Read the actual bindings rather than printing the defaults. Somebody who
    // moved their special onto a thumb button should see the thumb button.
    const shown = (action, fallback) => {
      const code = settings.bindingsFor(action)[0];
      return code ? codeShort(code) : fallback;
    };
    const defs = [
      { key: shown('primary', 'M1'), icon: weapon.primary.icon, name: weapon.primary.name, kind: 'primary' },
      { key: shown('secondary', 'Q'), icon: weapon.secondary.icon, name: weapon.secondary.name, kind: 'secondary' },
      { key: shown('utility', 'SHIFT'), icon: character?.utility.icon ?? '⇢', name: character?.utility.name ?? 'Dash', kind: 'utility' },
      { key: shown('special', 'R'), icon: character?.special.icon ?? '★', name: character?.special.name ?? 'Special', kind: 'special' },
    ];
    // The ultimate reads differently from the other four: its mask is a meter
    // filling up, not a cooldown draining, so it gets its own slot styling.
    if (character?.ultimate) {
      defs.push({
        key: 'F', icon: character.ultimate.icon ?? '★',
        name: character.ultimate.name, kind: 'ultimate',
      });
    }
    this.abilityEls = defs.map((d) => {
      const el = document.createElement('div');
      el.className = `ability ready${d.kind === 'ultimate' ? ' ult' : ''}`;
      el.title = d.name;
      el.innerHTML = `
        <span class="ico">${d.icon}</span>
        <span class="key">${d.key}</span>
        <div class="cd-mask" style="height:0%"></div>
        <div class="cd-num"></div>
        <div class="charge-bar"></div>
        <div class="stacks"></div>`;
      this.el.abilities.appendChild(el);
      return {
        el, kind: d.kind,
        mask: el.querySelector('.cd-mask'),
        num: el.querySelector('.cd-num'),
        charge: el.querySelector('.charge-bar'),
        stacks: el.querySelector('.stacks'),
      };
    });
  }

  // ------------------------------------------------------------------ per-frame
  update(dt) {
    const game = this.game;
    const p = game.player;
    const el = this.el;

    el.clock.textContent = formatTime(game.run.time);

    const tier = game.director.tier;
    el.diffLabel.textContent = tier.name;
    el.diffLabel.style.color = tier.color;
    el.diffFill.style.width = `${game.director.tierProgress * 100}%`;

    el.stageName.textContent = game.arena.theme.name;
    el.stageNum.textContent = `Stage ${game.run.stage}`;

    // Vitals
    const hpFrac = clamp01(p.health / p.stats.maxHealth);
    el.hpFill.style.width = `${hpFrac * 100}%`;
    el.hpText.textContent = `${Math.ceil(p.health)} / ${Math.round(p.stats.maxHealth)}`;
    el.hpBar.classList.toggle('low', hpFrac < 0.3);
    const barrierFrac = clamp01(p.barrier / p.stats.maxHealth);
    el.barrierFill.style.width = `${Math.min(100, barrierFrac * 100)}%`;

    el.xpFill.style.width = `${clamp01(p.xp / p.xpToNext) * 100}%`;
    el.lvlNum.textContent = p.level;
    el.gold.textContent = formatNumber(p.gold);

    this._updateBossBar(dt);
    this._updateScope();
    this._updateReload();
    this._updateAbilities(p);
    this._updateParty();
    this._updateBrood(p);
    this._updateBuffs(p);
    this._updateInventory();
    this._updateFloaters(dt);
    this._updateVignettes(dt);

    if (this.crossTimer > 0) {
      this.crossTimer -= dt;
      if (this.crossTimer <= 0) el.crosshair.className = '';
    }
    if (this.promptTimer > 0) {
      this.promptTimer -= dt;
      if (this.promptTimer <= 0) el.prompt.classList.add('hidden');
    }
    if (this.pickupTimer > 0) {
      this.pickupTimer -= dt;
      if (this.pickupTimer <= 0) {
        el.pickupCard.classList.add('out');
        setTimeout(() => {
          if (this.pickupTimer <= 0) el.pickupCard.classList.add('hidden');
        }, 420);
      }
    }
    if (this.lockedTimer > 0) {
      this.lockedTimer -= dt;
      if (this.lockedTimer <= 0) el.prompt.classList.remove('locked');
    }
  }

  /**
   * The optic overlay follows the one boolean the camera follows.
   *
   * Toggled on change rather than written every frame: this is two class
   * flips a second at most, and the alternative is touching the DOM sixty
   * times a second to say nothing.
   */
  _updateScope() {
    const on = !!this.game.combat?.scoped;
    if (on === this.scopeOn) return;
    this.scopeOn = on;
    this._setScope(on);
  }

  _setScope(on) {
    this.el.scope.classList.toggle('hidden', !on);
    this.el.scope.classList.toggle('on', on);
    // The world crosshair is the wrong instrument behind a reticle.
    this.el.crosshair.classList.toggle('scoped', on);
  }

  /**
   * The reload bar, while a weapon is working its action.
   *
   * The panel outlives the result by a fraction of a second — combat holds the
   * state open — so a miss reads as a miss rather than as the bar vanishing on
   * the frame the player got it wrong.
   */
  _updateReload() {
    const r = this.game.combat?.reload;
    if (!r) { if (this.reloadOn) this._setReload(false); return; }
    if (!this.reloadOn) this._setReload(true);
    const el = this.el;
    const frac = clamp01(r.t / r.time);
    el.reload.classList.toggle('timed', !!r.timed);
    if (r.timed) {
      /* A magazine has nothing to aim at, so the bar is a bar: the zone fills
         left to right as the hands work and there is no marker to chase. */
      el.reload.classList.remove('good', 'bad');
      el.reloadZone.style.left = '0%';
      el.reloadZone.style.width = `${frac * 100}%`;
      el.reloadLabel.textContent = 'RELOADING';
      return;
    }
    el.reload.classList.toggle('good', r.result === 'good');
    el.reload.classList.toggle('bad', r.result === 'bad');
    el.reloadZone.style.left = `${r.zoneStart * 100}%`;
    el.reloadZone.style.width = `${(r.zoneEnd - r.zoneStart) * 100}%`;
    el.reloadMarker.style.left = `${frac * 100}%`;
    el.reloadLabel.textContent = r.result === 'good' ? 'CHAMBERED'
      : r.result === 'bad' ? 'JAMMED' : 'RELOAD';
  }

  _setReload(on) {
    this.reloadOn = on;
    this.el.reload.classList.toggle('hidden', !on);
    if (!on) this.el.reload.classList.remove('good', 'bad', 'timed');
  }

  _updateAbilities(p) {
    if (!this.abilityEls) return;
    const combat = this.game.combat;
    const w = combat.weapon;
    for (const a of this.abilityEls) {
      let frac = 0;
      let remaining = 0;
      let total = 1;
      let chargeFrac = 0;
      let stackText = '';

      if (a.kind === 'primary') {
        total = w.primary.cooldown / Math.max(0.05, p.stats.attackSpeed);
        remaining = combat.primaryTimer;
        if (w.primary.beam) chargeFrac = combat.heat;
        // Rounds left, for a weapon that counts them. The badge is the only
        // warning you get before the two seconds land, so it is always on.
        if (combat.ammo !== null) stackText = `${combat.ammo}`;
      } else if (a.kind === 'secondary') {
        total = w.secondary.cooldown * p.stats.cooldownMult;
        remaining = combat.secondaryTimer;
        if (combat.charging) chargeFrac = combat.chargeTime / (w.secondary.charge || 1);
      } else if (a.kind === 'utility') {
        const util = combat.character?.utility;
        total = Math.max(0.01, (util?.cooldown ?? 3) * p.stats.cooldownMult * p.stats.dashCooldownMult);
        remaining = combat.utilityCharges > 0 || combat.dashResets > 0 ? 0 : Math.max(0, combat.utilityTimer);
        // Banked resets read as what they are: dashes you already own, sat in
        // front of the charge that is still regenerating behind them.
        if (combat.maxUtilityCharges > 1 || combat.dashResets > 0) {
          stackText = combat.dashResets > 0
            ? `${combat.utilityCharges}+${combat.dashResets}`
            : `${combat.utilityCharges}`;
        }
      } else if (a.kind === 'special') {
        total = combat.specialCooldown(p);
        remaining = combat.specialCharges > 0 ? 0 : Math.max(0, combat.specialTimer);
        if (combat.maxSpecialCharges > 1) stackText = `${combat.specialCharges}`;
      } else {
        // Ultimate: the mask is the part still to earn, so a full meter is an
        // empty mask — the same shape as "off cooldown" on every other slot.
        const charged = combat.ultimateFraction;
        a.mask.style.height = `${(1 - charged) * 100}%`;
        a.num.textContent = charged >= 1 ? '' : `${Math.floor(charged * 100)}`;
        a.charge.style.width = `${charged * 100}%`;
        a.stacks.textContent = '';
        a.el.classList.toggle('ready', charged >= 1);
        a.el.classList.toggle('charging', charged > 0 && charged < 1);
        continue;
      }
      frac = total > 0 ? clamp01(remaining / total) : 0;

      a.mask.style.height = `${frac * 100}%`;
      a.num.textContent = remaining > 0.25 && a.kind !== 'primary' ? remaining.toFixed(1) : '';
      a.charge.style.width = `${chargeFrac * 100}%`;
      a.stacks.textContent = stackText;
      a.el.classList.toggle('ready', frac <= 0);
      a.el.classList.toggle('charging', chargeFrac > 0.02);
    }
  }

  /**
   * Boss health across the top of the screen.
   *
   * The lag bar behind the fill drains slowly, so a big hit reads as a visible
   * chunk rather than a number that has already moved on.
   */
  setBoss(enemy, remaining = 1) {
    this.bossTarget = enemy || null;
    const el = this.el;
    if (!enemy) {
      el.bossBar.classList.add('hidden');
      el.bossBar.classList.remove('show', 'armoured');
      el.bossPhases.innerHTML = '';
      return;
    }
    this.bossLagValue = 1;
    el.bossBar.classList.remove('hidden');
    void el.bossBar.offsetWidth;
    el.bossBar.classList.add('show');
    // With a Shrine of Ruin up, the bar tracks one guardian at a time — say how
    // many more are behind it so the party can count what is left.
    el.bossName.textContent = remaining > 1 ? `${enemy.def.name}  ×${remaining}` : enemy.def.name;
    if (enemy.elite) {
      el.bossAffix.textContent = enemy.elite.name;
      el.bossAffix.style.color = `#${enemy.elite.color.toString(16).padStart(6, '0')}`;
    } else {
      el.bossAffix.textContent = '';
    }
    /* Threshold ticks, for a boss that changes form at one. The first row is
       where the fight opens, so it is not a threshold and gets no mark. */
    el.bossPhases.innerHTML = '';
    for (const phase of (enemy.def.phases || []).slice(1)) {
      const tick = document.createElement('div');
      tick.className = 'bb-tick';
      tick.style.left = `${clamp01(phase.at) * 100}%`;
      tick.title = phase.name || '';
      el.bossPhases.appendChild(tick);
    }
  }

  _updateBossBar(dt) {
    const boss = this.bossTarget;
    if (!boss) return;
    // A dead guardian drops off the bar; if another is still standing, the
    // beacon event puts it back up on the same frame.
    if (boss.dead) { this.setBoss(null); return; }
    const f = clamp01(boss.health / boss.maxHealth);
    this.el.bossFill.style.width = `${f * 100}%`;
    this.bossLagValue = Math.max(f, this.bossLagValue - dt * 0.22);
    this.el.bossLag.style.width = `${this.bossLagValue * 100}%`;
    // Mid-shed the bar goes cold and the name says what it is doing, so the
    // seconds your damage does nothing are seconds you can see a reason for.
    const shedding = boss.shellTimer > 0;
    this.el.bossBar.classList.toggle('armoured', shedding);
    this.el.bossHpText.textContent = shedding
      ? 'IMMUNE'
      : `${formatNumber(Math.ceil(boss.health))} / ${formatNumber(Math.round(boss.maxHealth))}`;
  }

  /**
   * Teammate strip: who is with you, how they are doing, and how far along
   * their revival is if they are down.
   */
  _updateParty() {
    const coop = this.game.coop;
    const el = this.el.party;
    if (!el) return;
    const mates = coop?.active ? [...coop.remotes.values()] : [];
    if (!mates.length) {
      if (!el.classList.contains('hidden')) { el.classList.add('hidden'); el.innerHTML = ''; this._partyIds = ''; }
      return;
    }
    el.classList.remove('hidden');
    const ids = mates.map((m) => m.id).join(',');
    if (this._partyIds !== ids) {
      this._partyIds = ids;
      el.innerHTML = mates.map((m) => `
        <div class="mate" data-id="${m.id}" style="--mc:#${m.char.accent.toString(16).padStart(6, '0')}">
          <span class="m-ico">${m.char.icon}</span>
          <span class="m-body">
            <span class="m-name"></span>
            <span class="m-bar"><i></i></span>
          </span>
        </div>`).join('');
    }
    for (let i = 0; i < mates.length; i++) {
      const m = mates[i];
      const node = el.children[i];
      if (!node) continue;
      const nameEl = node.querySelector('.m-name');
      const barEl = node.querySelector('.m-bar i');
      const dist = Math.round(m.position.distanceTo(this.game.player.position));
      nameEl.textContent = m.dead ? `${m.name} — DOWN` : `${m.name}  ${dist}m`;
      barEl.style.width = `${clamp01(m.health / Math.max(1, m.maxHealth)) * 100}%`;
      node.classList.toggle('down', m.dead);
    }
  }

  /**
   * One pip per lizard, filled by its health.
   *
   * Rebuilt only when the roster changes; the fills are cheap style writes on
   * existing nodes, because this runs every frame.
   */
  _updateBrood(p) {
    const mine = this.game.pets?.ownedBy(p) || [];
    const el = this.el.brood;
    if (!mine.length) {
      if (!el.classList.contains('hidden')) { el.classList.add('hidden'); el.innerHTML = ''; this._broodCount = 0; }
      return;
    }
    el.classList.remove('hidden');
    if (this._broodCount !== mine.length) {
      this._broodCount = mine.length;
      el.innerHTML = mine.map(() => '<div class="pip"><i></i><b></b></div>').join('');
    }
    const nodes = el.children;
    for (let i = 0; i < mine.length; i++) {
      const m = mine[i];
      const node = nodes[i];
      if (!node) continue;
      const frac = m.alive ? clamp01(m.health / m.maxHealth) : 0;
      node.firstChild.style.height = `${frac * 100}%`;
      node.classList.toggle('down', !m.alive);
      node.lastChild.textContent = m.alive ? '' : Math.ceil(m.dormantTimer);
    }
  }

  _updateBuffs(p) {
    const parts = [];
    for (const [id, b] of p.buffs) {
      parts.push(`<div class="buff">${b.label || id}${b.stacks > 1 ? ` ×${b.stacks}` : ''}<span class="bt">${b.time.toFixed(1)}</span></div>`);
    }
    for (const [id, s] of p.statuses) {
      const label = { burn: '🔥 Burning', chill: '❄️ Chilled', suppress: '🌑 Suppressed' }[id] || id;
      parts.push(`<div class="buff" style="border-color:#5a2a2a">${label}<span class="bt">${s.time.toFixed(1)}</span></div>`);
    }
    if (p.invulnerable > 0) parts.push(`<div class="buff" style="border-color:#6b5326">✨ Invulnerable<span class="bt">${p.invulnerable.toFixed(1)}</span></div>`);
    const html = parts.join('');
    if (html !== this._buffHtml) { this.el.buffs.innerHTML = html; this._buffHtml = html; }
  }

  _updateInventory() {
    const inv = this.game.inventory;
    const sig = inv.order.map((id) => `${id}:${inv.stacks.get(id)}`).join(',');
    if (sig === this.lastInventorySignature) return;
    const isNew = sig.length > this.lastInventorySignature.length;
    this.lastInventorySignature = sig;

    this.el.inventory.innerHTML = inv.entries().map(({ item, stacks }, i) => {
      const r = RARITY[item.rarity];
      const desc = itemDescription(item, stacks, this.game.run).replace(/</g, '&lt;');
      return `<div class="inv-item" style="border-color:${r.color}66">
        <img class="inv-art" src="${itemIconDataURL(item, 72)}" alt="" />
        <span class="cnt" style="color:${r.color}">${stacks}</span>
        <div class="inv-tip">
          <h5 style="color:${r.color}">${item.name}</h5>
          ${desc}
          <div class="stack-line">${item.stackText || ''}</div>
        </div>
      </div>`;
    }).join('');

    if (isNew) {
      const last = this.el.inventory.lastElementChild;
      last?.classList.add('new');
    }
  }

  // ------------------------------------------------------------------ floating text
  _floater() {
    const el = this.pool.pop() || document.createElement('div');
    el.className = 'dmg';
    this.el.dmgLayer.appendChild(el);
    return el;
  }

  _addFloater(worldPos, text, cls, color, opts = {}) {
    if (this.floaters.length > 70) return;
    const el = this._floater();
    el.textContent = text;
    if (cls) el.className = `dmg ${cls}`;
    el.style.color = color;
    this.floaters.push({
      el,
      pos: worldPos.clone(),
      vel: new THREE.Vector3(
        (Math.random() - 0.5) * 1.6, opts.rise ?? 2.6, (Math.random() - 0.5) * 1.6,
      ),
      life: opts.life ?? 0.85,
      maxLife: opts.life ?? 0.85,
      scale: opts.scale ?? 1,
    });
  }

  damageNumber(worldPos, amount, isCrit) {
    if (amount < 0.5 || settings.data.damageNumbers === false) return;
    this._addFloater(worldPos, formatNumber(amount), isCrit ? 'crit' : '', isCrit ? '#ffb347' : '#ffffff', {
      rise: isCrit ? 3.4 : 2.6, life: isCrit ? 1.0 : 0.8,
    });
  }

  healNumber(worldPos, amount) {
    this._addFloater(_v.copy(worldPos).setY(worldPos.y + 1.6), `+${Math.round(amount)}`, 'heal', '#4be08a', { rise: 2.2 });
  }

  goldNumber(worldPos, amount) {
    this._addFloater(worldPos, `+${Math.round(amount)}`, '', '#ffcf5c', { rise: 2.4, life: 0.7 });
  }

  playerDamageNumber(amount) {
    if (amount < 0.5) return;
    const p = this.game.player;
    this._addFloater(_v.copy(p.position).setY(p.position.y + 2.4), `-${Math.round(amount)}`, 'player', '#ff4d5e', { rise: 3 });
  }

  _updateFloaters(dt) {
    const cam = this.game.engine.camera;
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.life -= dt;
      if (f.life <= 0) {
        this.el.dmgLayer.removeChild(f.el);
        this.pool.push(f.el);
        this.floaters.splice(i, 1);
        continue;
      }
      f.vel.y -= 5.5 * dt;
      f.pos.addScaledVector(f.vel, dt);
      _v.copy(f.pos).project(cam);
      if (_v.z > 1) { f.el.style.opacity = '0'; continue; }
      const k = f.life / f.maxLife;
      f.el.style.left = `${(_v.x * 0.5 + 0.5) * w}px`;
      f.el.style.top = `${(-_v.y * 0.5 + 0.5) * h}px`;
      f.el.style.opacity = String(Math.min(1, k * 2));
      f.el.style.transform = `translate(-50%,-50%) scale(${f.scale * (0.8 + k * 0.35)})`;
    }
  }

  clearFloaters() {
    for (const f of this.floaters) this.el.dmgLayer.removeChild(f.el);
    this.floaters.length = 0;
  }

  // ------------------------------------------------------------------ feedback
  flashCrosshair(kind) {
    this.el.crosshair.className = `${kind} pulse`;
    this.crossTimer = kind === 'kill' ? 0.22 : 0.12;
  }

  flashHurt(intensity = 0.5) { this.hurtTimer = Math.max(this.hurtTimer, 0.15 + intensity * 0.3); this._hurtPeak = Math.min(1, intensity); }
  flashHeal() { this.healTimer = Math.max(this.healTimer, 0.2); }

  _updateVignettes(dt) {
    if (this.hurtTimer > 0) {
      this.hurtTimer -= dt;
      this.el.hurt.style.opacity = String(Math.max(0, this.hurtTimer) * (this._hurtPeak ?? 0.6));
    } else this.el.hurt.style.opacity = '0';

    // Persistent low-health warning pulse
    const p = this.game.player;
    if (p && !p.dead && p.health / p.stats.maxHealth < 0.28) {
      const pulse = 0.18 + Math.sin(this.game.time * 6) * 0.09;
      this.el.hurt.style.opacity = String(Math.max(Number(this.el.hurt.style.opacity) || 0, pulse));
    }

    if (this.healTimer > 0) {
      this.healTimer -= dt;
      this.el.heal.style.opacity = String(Math.max(0, this.healTimer) * 0.8);
    } else this.el.heal.style.opacity = '0';
  }

  pulseGold() {
    this.el.goldWrap.classList.remove('gain');
    void this.el.goldWrap.offsetWidth;
    this.el.goldWrap.classList.add('gain');
  }

  showPrompt(text, key = 'E') {
    this.el.promptKey.textContent = key;
    this.el.promptText.textContent = text;
    this.el.prompt.classList.remove('hidden');
    this.promptTimer = 0.2;
  }

  showPromptLocked() {
    this.el.prompt.classList.add('locked');
    this.lockedTimer = 0.6;
  }

  hidePrompt() { this.el.prompt.classList.add('hidden'); this.promptTimer = 0; }

  /**
   * Shows what an item actually does the moment it is collected.
   * The description is rendered at the item's *new* stack count, so a second copy
   * reads as the upgrade it is rather than repeating the first pickup's numbers.
   */
  showPickup(item, stacks) {
    const el = this.el;
    const r = RARITY[item.rarity];
    el.pickupCard.classList.remove('hidden', 'out', 'show');
    void el.pickupCard.offsetWidth;              // restart the entry animation
    el.pickupCard.classList.add('show');
    el.pickupCard.style.borderLeftColor = r.color;

    el.pcGlyph.innerHTML = `<img class="pc-art" src="${itemIconDataURL(item, 96)}" alt="" />`;
    el.pcName.textContent = item.name;
    el.pcName.style.color = r.color;
    el.pcRarity.textContent = `${r.name}${item.tag ? ` · ${item.tag}` : ''}`;
    el.pcRarity.style.color = r.color;
    el.pcDesc.textContent = itemDescription(item, stacks, this.game.run);

    if (stacks > 1) {
      el.pcStack.classList.remove('hidden');
      el.pcStack.textContent = `×${stacks}`;
      el.pcStack.style.color = r.color;
      el.pcStackLine.textContent = item.stackText ? `Stacking: ${item.stackText}` : '';
    } else {
      el.pcStack.classList.add('hidden');
      el.pcStackLine.textContent = item.stackText || '';
    }

    this.pickupTimer = 5.5;
  }

  toast(text, color = '#dfe6f5') {
    const el = document.createElement('div');
    el.className = 'toast';
    el.style.borderLeftColor = color;
    el.innerHTML = `<b style="color:${color}">${text}</b>`;
    this.el.toasts.appendChild(el);
    setTimeout(() => el.remove(), 2600);
    while (this.el.toasts.children.length > 5) this.el.toasts.firstChild.remove();
  }

  /** While you are down, the objective panel becomes the revive bar. */
  downedObjective(progress) {
    this.setObjective('DOWNED', progress,
      progress > 0 ? 'Hold still — a teammate is bringing you back'
        : 'A teammate must reach you');
  }

  setObjective(text, fraction, sub) {
    if (text === null) { this.el.objective.classList.add('hidden'); return; }
    this.el.objective.classList.remove('hidden');
    this.el.objectiveText.textContent = text;
    this.el.objectiveFill.style.width = `${clamp01(fraction) * 100}%`;
    this.el.objectiveSub.textContent = sub || '';
  }
}
