/**
 * Item catalogue.
 *
 * Every item is a plain descriptor. Behaviour is expressed through two optional
 * channels:
 *
 *   stats(stacks, acc)  — fold passive modifiers into the stat accumulator.
 *   hooks.<event>(ctx, stacks, ev) — react to gameplay events.
 *
 * `ctx` is the item API surface built by systems/itemRuntime.js. `ev.proc` is the
 * proc coefficient of the triggering hit: fast weapons carry a lower coefficient so
 * on-hit items stay balanced across the arsenal.
 */
import { hyperbolic, rollProc } from '../core/mathx.js';

const pct = (v) => `${Math.round(v * 1000) / 10}%`;

export const ITEMS = [
  /* ==========================================================
     COMMON
     ========================================================== */
  {
    id: 'stim_injector', name: 'Stim Injector', rarity: 'common', icon: '💉', tag: 'Offense',
    unlocked: true,
    desc: (s) => `Increases attack speed by ${pct(0.15 * s)}.`,
    stackText: '+15% attack speed per stack',
    stats: (s, a) => { a.multAttackSpeed *= 1 + 0.15 * s; },
  },
  {
    id: 'glass_shard', name: 'Glass Shard', rarity: 'common', icon: '🔷', tag: 'Offense',
    unlocked: true,
    desc: (s) => `Increases critical strike chance by ${pct(0.08 * s)}.`,
    stackText: '+8% crit chance per stack',
    stats: (s, a) => { a.addCrit += 0.08 * s; },
  },
  {
    id: 'tungsten_plate', name: 'Tungsten Plating', rarity: 'common', icon: '🛡️', tag: 'Defense',
    unlocked: true,
    desc: (s) => `Gain ${5 * s} armor. Armor has diminishing returns.`,
    stackText: '+5 armor per stack',
    stats: (s, a) => { a.addArmor += 5 * s; },
  },
  {
    id: 'sprint_servos', name: 'Sprint Servos', rarity: 'common', icon: '👟', tag: 'Mobility',
    unlocked: true,
    desc: (s) => `Increases movement speed by ${pct(0.14 * s)}.`,
    stackText: '+14% movement speed per stack',
    stats: (s, a) => { a.multMoveSpeed *= 1 + 0.14 * s; },
  },
  {
    id: 'bitterroot', name: 'Bitterroot', rarity: 'common', icon: '🌿', tag: 'Healing',
    unlocked: true,
    desc: (s) => `Increases maximum health by ${pct(0.09 * s)}.`,
    stackText: '+9% max health per stack',
    stats: (s, a) => { a.multMaxHealth *= 1 + 0.09 * s; },
  },
  {
    id: 'field_dressing', name: 'Field Dressing', rarity: 'common', icon: '🩹', tag: 'Healing',
    unlocked: true,
    desc: (s) => `${1.2}s after taking damage, heal for ${12 + 8 * (s - 1)} health.`,
    stackText: '+8 healing per stack',
    hooks: {
      onDamaged(ctx, s) {
        ctx.schedule(1.2, () => ctx.heal(12 + 8 * (s - 1), 'Field Dressing'));
      },
    },
  },
  {
    id: 'spore_bloom', name: 'Spore Bloom', rarity: 'common', icon: '🍄', tag: 'Healing',
    unlocked: true,
    desc: (s) => `While standing still, regenerate ${(2.2 * s).toFixed(1)} health per second in a small radius.`,
    stackText: '+2.2 hp/s per stack',
    hooks: {
      onTick(ctx, s, ev) {
        if (ctx.player.speedXZ < 1.2 && ctx.player.grounded) {
          ctx.heal(2.2 * s * ev.dt, null, true);
          if (ctx.frame % 12 === 0) ctx.fx.sporeRing(ctx.player.position);
        }
      },
    },
  },
  {
    id: 'prospectors_lens', name: "Prospector's Lens", rarity: 'common', icon: '🔍', tag: 'Utility',
    unlocked: true,
    desc: (s) => `Enemies drop ${pct(0.16 * s)} more gold.`,
    stackText: '+16% gold per stack',
    stats: (s, a) => { a.multGold *= 1 + 0.16 * s; },
  },
  {
    id: 'capacitor_cell', name: 'Capacitor Cell', rarity: 'common', icon: '🔋', tag: 'Utility',
    unlocked: true,
    desc: (s) => `Reduces all cooldowns by ${pct(hyperbolic(0.16, s))}.`,
    stackText: '-16% cooldowns per stack (diminishing)',
    stats: (s, a) => { a.multCooldown *= 1 - hyperbolic(0.16, s); },
  },
  {
    id: 'hollowpoint', name: 'Hollowpoint Rounds', rarity: 'common', icon: '🔩', tag: 'Offense',
    unlocked: true,
    desc: (s) => `Deal ${pct(0.20 * s)} bonus damage to enemies above 90% health.`,
    stackText: '+20% execute-from-full damage per stack',
    hooks: {
      modifyDamage(ctx, s, ev) {
        if (ev.enemy.health / ev.enemy.maxHealth > 0.9) return ev.damage * (1 + 0.20 * s);
        return ev.damage;
      },
    },
  },
  {
    id: 'scholars_tab', name: "Scholar's Tab", rarity: 'common', icon: '📘', tag: 'Utility',
    unlocked: true,
    desc: (s) => `Gain ${pct(0.15 * s)} more experience.`,
    stackText: '+15% experience per stack',
    stats: (s, a) => { a.multXp *= 1 + 0.15 * s; },
  },

  {
    id: 'hatchling_charm', name: 'Hatchling Charm', rarity: 'common', icon: '🥚', tag: 'Utility',
    unlocked: true,
    desc: (s) => `Brood lizards deal ${pct(0.2 * s)} more damage.`,
    stackText: '+20% brood damage per stack',
    stats: (s, a) => { a.multPetDamage *= 1 + 0.2 * s; },
  },
  {
    id: 'whetstone', name: 'Whetstone', rarity: 'common', icon: '🪨', tag: 'Offense',
    unlocked: true,
    desc: (s) => `Deal ${pct(0.18 * s)} bonus damage to enemies below 35% health.`,
    stackText: '+18% finishing damage per stack',
    hooks: {
      modifyDamage(ctx, s, ev) {
        if (ev.enemy.health / ev.enemy.maxHealth < 0.35) return ev.damage * (1 + 0.18 * s);
        return ev.damage;
      },
    },
  },
  {
    id: 'ration_tin', name: 'Ration Tin', rarity: 'common', icon: '🥫', tag: 'Healing',
    unlocked: true,
    desc: (s) => `Killing an enemy restores ${(2 + 1.5 * (s - 1)).toFixed(1)} health.`,
    stackText: '+1.5 healing per stack',
    hooks: {
      onKill(ctx, s) { ctx.heal(2 + 1.5 * (s - 1), 'Ration Tin', true); },
    },
  },
  {
    id: 'ballast_rig', name: 'Ballast Rig', rarity: 'common', icon: '⚓', tag: 'Defense',
    unlocked: true,
    desc: (s) => `Increases maximum health by ${pct(0.06 * s)} and grants ${4 * s} armor.`,
    stackText: '+6% health, +4 armor per stack',
    stats: (s, a) => { a.multMaxHealth *= 1 + 0.06 * s; a.addArmor += 4 * s; },
  },


  {
    id: 'trail_marker', name: 'Trail Marker', rarity: 'common', icon: '🧭', tag: 'Utility',
    unlocked: true,
    desc: (s) => `Increases pickup radius by ${(2.4 * s).toFixed(1)}m and movement speed by ${pct(0.04 * s)}.`,
    stackText: '+2.4m pickup radius per stack',
    stats: (s, a) => { a.addPickupRadius += 2.4 * s; a.multMoveSpeed *= 1 + 0.04 * s; },
  },
  {
    id: 'chalk_dust', name: 'Chalk Dust', rarity: 'common', icon: '🥋', tag: 'Offense',
    unlocked: true,
    desc: (s) => `Deal ${pct(0.1 * s)} more damage to enemies within 8m.`,
    stackText: '+10% close-range damage per stack',
    hooks: {
      modifyDamage(ctx, s, ev) {
        const d = ev.enemy.position.distanceTo(ctx.player.position);
        return d < 8 ? ev.damage * (1 + 0.1 * s) : ev.damage;
      },
    },
  },
  {
    id: 'tallow_candle', name: 'Tallow Candle', rarity: 'common', icon: '🕯️', tag: 'Healing',
    unlocked: true,
    desc: (s) => `Every 6 seconds out of combat, heal for ${pct(0.03 * s)} of maximum health.`,
    stackText: '+3% max health per stack',
    hooks: {
      onTick(ctx, s, ev) {
        if (ctx.player.combatTimer > 0) return;
        ctx.timer('tallow', ev.dt, 6, () => {
          ctx.heal(ctx.player.stats.maxHealth * 0.03 * s, 'Tallow Candle');
        });
      },
    },
  },
  {
    id: 'counterweight', name: 'Counterweight', rarity: 'common', icon: '⚖️', tag: 'Mobility',
    unlocked: true,
    desc: (s) => `While airborne, gain ${pct(0.18 * s)} damage. Landing is when you stop being interesting.`,
    stackText: '+18% airborne damage per stack',
    hooks: {
      modifyDamage(ctx, s, ev) {
        return ctx.player.grounded ? ev.damage : ev.damage * (1 + 0.18 * s);
      },
    },
  },
  /* ==========================================================
     UNCOMMON
     ========================================================== */
  {
    id: 'infusion_core', name: 'Infusion Core', rarity: 'uncommon', icon: '🧬', tag: 'Healing',
    unlocked: true,
    desc: (s) => `Killing an enemy permanently grants +1 max health, up to ${100 * s}.`,
    stackText: '+100 health cap per stack',
    stats: (s, a, run) => { a.addMaxHealth += Math.min(run.infusion || 0, 100 * s); },
    hooks: {
      onKill(ctx, s) {
        ctx.run.infusion = Math.min((ctx.run.infusion || 0) + 1, 100 * s);
        ctx.player.markStatsDirty();
      },
    },
  },
  {
    id: 'resonant_chime', name: 'Resonant Chime', rarity: 'uncommon', icon: '🎐', tag: 'Offense',
    unlocked: true,
    desc: (s) => `${pct(hyperbolic(0.28, s))} chance on hit to arc lightning through 3 enemies for ${pct(0.8)} damage.`,
    stackText: '+28% chance per stack (diminishing)',
    hooks: {
      onHit(ctx, s, ev) {
        if (!ctx.procRoll(hyperbolic(0.28, s), ev.proc)) return;
        ctx.chainLightning(ev.enemy, 3, ctx.player.stats.damage * 0.8, 13, 0x8fd8ff);
      },
    },
  },
  {
    id: 'grav_boots', name: 'Gravity Boots', rarity: 'uncommon', icon: '🪶', tag: 'Mobility',
    unlocked: true,
    desc: (s) => `Gain ${s} extra jump${s > 1 ? 's' : ''} and reduce fall damage.`,
    stackText: '+1 jump per stack',
    stats: (s, a) => { a.addJumps += s; },
  },
  {
    id: 'predatory_instinct', name: 'Predatory Instinct', rarity: 'uncommon', icon: '🐾', tag: 'Offense',
    unlocked: true,
    desc: (s) => `Critical strikes grant ${pct(0.12 * s)} attack speed for 3s, stacking 4 times.`,
    stackText: '+12% attack speed per stack',
    hooks: {
      onCrit(ctx, s) { ctx.addBuff('frenzy', 3, 0.12 * s, 4, '🐾 Frenzy'); },
    },
  },
  {
    id: 'battle_horn', name: 'Battle Horn', rarity: 'uncommon', icon: '📯', tag: 'Offense',
    unlocked: true,
    desc: (s) => `Using your secondary grants ${pct(0.35 * s)} attack speed and ${pct(0.15 * s)} movement speed for 6s.`,
    stackText: '+35% attack speed per stack',
    hooks: {
      onSecondary(ctx, s) { ctx.addBuff('warcry', 6, 0.35 * s, 1, '📯 War Cry', { move: 0.15 * s }); },
    },
  },
  {
    id: 'reaper_lens', name: 'Reaper Lens', rarity: 'uncommon', icon: '👁️', tag: 'Healing',
    unlocked: true,
    desc: (s) => `Critical strikes heal you for ${8 * s} health.`,
    stackText: '+8 healing per stack',
    hooks: {
      onCrit(ctx, s) { ctx.heal(8 * s, null, true); },
    },
  },
  {
    id: 'fuel_cell', name: 'Fuel Cell', rarity: 'uncommon', icon: '⚗️', tag: 'Utility',
    unlocked: true,
    desc: (s) => `Reduces your utility cooldown by ${pct(hyperbolic(0.3, s))} and grants ${s} extra charge${s > 1 ? 's' : ''}.`,
    stackText: '+1 utility charge per stack',
    stats: (s, a) => { a.multDashCooldown *= 1 - hyperbolic(0.3, s); a.addDashCharges += s; },
  },
  {
    id: 'ignition_core', name: 'Ignition Core', rarity: 'uncommon', icon: '🔥', tag: 'Offense',
    unlocked: true,
    desc: (s) => `Killing an enemy detonates it for ${pct(1.4 * s)} of your damage in a 7m radius.`,
    stackText: '+140% blast damage per stack',
    hooks: {
      onKill(ctx, s, ev) {
        ctx.areaDamage(ev.enemy.position, 7, ctx.player.stats.damage * 1.4 * s, { proc: 0, source: 'Ignition Core' });
        ctx.fx.explosion(ev.enemy.position, 7, 0xff8a3d);
      },
    },
  },
  {
    id: 'phase_cloak', name: 'Phase Cloak', rarity: 'uncommon', icon: '🌫️', tag: 'Defense',
    unlocked: true,
    desc: (s) => `Falling below 25% health cloaks you for ${(2 + s).toFixed(0)}s: +40% speed and 70% damage reduction. Recharges in ${Math.max(8, 24 - 4 * (s - 1))}s.`,
    stackText: '+1s duration, -4s recharge per stack',
    hooks: {
      onLowHealth(ctx, s) {
        if (ctx.isOnInternalCooldown('phase_cloak')) return;
        ctx.setInternalCooldown('phase_cloak', Math.max(8, 24 - 4 * (s - 1)));
        ctx.addBuff('cloak', 2 + s, 1, 1, '🌫️ Phased');
        ctx.fx.cloakBurst(ctx.player.position);
      },
    },
  },
  {
    id: 'seeker_missile', name: 'Seeker Missile', rarity: 'uncommon', icon: '🚀', tag: 'Offense',
    unlocked: true,
    desc: (s) => `${pct(0.1)} chance on hit to fire a homing missile for ${pct(2.8 * s)} damage.`,
    stackText: '+280% missile damage per stack',
    hooks: {
      onHit(ctx, s, ev) {
        if (!ctx.procRoll(0.1, ev.proc)) return;
        ctx.fireMissile(ev.enemy, ctx.player.stats.damage * 2.8 * s);
      },
    },
  },

  {
    id: 'brood_totem', name: 'Brood Totem', rarity: 'uncommon', icon: '🗿', tag: 'Utility',
    unlocked: true,
    desc: (s) => `${s} more egg${s > 1 ? 's' : ''} hatch on every stage, and pets have ${pct(0.25 * s)} more health.`,
    stackText: '+1 egg per stage, +25% pet health per stack',
    stats: (s, a) => { a.addEggs += s; a.multPetHealth *= 1 + 0.25 * s; },
  },
  {
    id: 'kinetic_dampener', name: 'Kinetic Dampener', rarity: 'uncommon', icon: '🪂', tag: 'Defense',
    unlocked: true,
    desc: (s) => `Single hits that would take more than 14% of your health are reduced by ${pct(hyperbolic(0.3, s))}.`,
    stackText: '-30% from heavy hits per stack (diminishing)',
    hooks: {
      // Deliberately only touches the big hits: chip damage is survivable, and
      // an item that blunts everything makes armour redundant.
      modifyIncoming(ctx, s, ev) {
        if (ev.amount < ctx.player.stats.maxHealth * 0.14) return ev.amount;
        return ev.amount * (1 - hyperbolic(0.3, s));
      },
    },
  },
  {
    id: 'ember_cache', name: 'Ember Cache', rarity: 'uncommon', icon: '🔥', tag: 'Offense',
    unlocked: true,
    desc: (s) => `${pct(hyperbolic(0.22, s))} chance on hit to ignite for ${pct(1.1 * s)} damage over 3s.`,
    stackText: '+22% chance and +110% burn per stack (diminishing chance)',
    hooks: {
      onHit(ctx, s, ev) {
        if (!ctx.procRoll(hyperbolic(0.22, s), ev.proc)) return;
        ctx.applyStatus(ev.enemy, 'burn', 3, { dps: ctx.player.stats.damage * 1.1 * s / 3 });
        ctx.fx.glow(ev.enemy.center, { color: 0xff6a2a, size: 1.1, life: 0.3, grow: 0.9 });
      },
    },
  },
  {
    id: 'slipstream', name: 'Slipstream', rarity: 'uncommon', icon: '🌬️', tag: 'Mobility',
    unlocked: true,
    desc: (s) => `After 4s without taking damage, gain ${pct(0.18 * s)} movement speed and ${pct(0.08 * s)} attack speed.`,
    stackText: '+18% move, +8% attack speed per stack',
    stats: (s, a, run) => {
      if (!run._slipstream) return;
      a.multMoveSpeed *= 1 + 0.18 * s;
      a.multAttackSpeed *= 1 + 0.08 * s;
    },
    hooks: {
      onTick(ctx, s) {
        const on = ctx.player.timeSinceDamage > 4;
        if (on === !!ctx.run._slipstream) return;
        ctx.run._slipstream = on;
        ctx.player.markStatsDirty();
        if (on) ctx.fx.ring(ctx.player.position, 0.5, 2.4, 0x8fd8ff, 0.35, 0.5);
      },
    },
  },


  {
    id: 'shatter_charge', name: 'Shatter Charge', rarity: 'uncommon', icon: '💣', tag: 'Offense',
    unlocked: true,
    desc: (s) => `${pct(0.1)} chance on hit to detonate for ${pct(1.4 * s)} damage in 6m.`,
    stackText: '+140% blast damage per stack',
    hooks: {
      onHit(ctx, s, ev) {
        if (!ctx.procRoll(0.1, ev.proc)) return;
        ctx.areaDamage(ev.enemy.center, 6, ctx.player.stats.damage * 1.4 * s, {
          proc: 0.3, source: 'Shatter Charge', force: 6,
        });
        ctx.fx.explosion(ev.enemy.center, 6, 0xffa050, 0.7);
      },
    },
  },
  {
    id: 'thorn_harness', name: 'Thorn Harness', rarity: 'uncommon', icon: '🌵', tag: 'Defense',
    unlocked: true,
    desc: (s) => `Taking damage returns ${pct(0.55 * s)} of it to every enemy within 9m.`,
    stackText: '+55% reflected per stack',
    hooks: {
      onDamaged(ctx, s, ev) {
        if (ev.amount <= 0) return;
        ctx.areaDamage(ctx.player.position, 9, ev.amount * 0.55 * s, {
          proc: 0.2, source: 'Thorn Harness',
        });
        ctx.fx.ring(ctx.player.position, 0.5, 9, 0x8fd86a, 0.32, 0.6);
      },
    },
  },
  {
    id: 'quickstep_tabi', name: 'Quickstep Tabi', rarity: 'uncommon', icon: '🥾', tag: 'Mobility',
    unlocked: true,
    desc: (s) => `Using a secondary ability grants ${pct(0.35 * s)} movement speed for 3 seconds.`,
    stackText: '+35% burst speed per stack',
    hooks: {
      onSecondary(ctx, s) {
        ctx.addBuff('quickstep', 3, 0.35 * s, 1, '🥾 Quickstep', { stat: 'moveSpeed' });
      },
    },
  },
  {
    id: 'marrow_tithe', name: 'Marrow Tithe', rarity: 'uncommon', icon: '🦴', tag: 'Healing',
    unlocked: true,
    desc: (s) => `Every 8 kills, heal for ${pct(0.06 * s)} of maximum health and gain a barrier.`,
    stackText: '+6% max health per stack',
    hooks: {
      onKill(ctx, s) {
        ctx.run.marrow = (ctx.run.marrow || 0) + 1;
        if (ctx.run.marrow < 8) return;
        ctx.run.marrow = 0;
        ctx.heal(ctx.player.stats.maxHealth * 0.06 * s, 'Marrow Tithe');
        ctx.grantBarrier(ctx.player.stats.maxHealth * 0.04 * s);
      },
    },
  },
  /* ==========================================================
     RARE
     ========================================================== */
  {
    id: 'brilliant_behemoth', name: 'Brilliant Behemoth', rarity: 'rare', icon: '💥', tag: 'Offense',
    unlocked: true,
    desc: (s) => `All your attacks explode in a ${(3.5 + 1.5 * s).toFixed(1)}m radius for ${pct(0.6)} damage.`,
    stackText: '+1.5m blast radius per stack',
    hooks: {
      onHit(ctx, s, ev) {
        if (ev.noSplash || ev.proc <= 0) return;
        ctx.areaDamage(ev.enemy.position, 3.5 + 1.5 * s, ev.damage * 0.6, {
          proc: 0, source: 'Behemoth', exclude: ev.enemy, noSplash: true,
        });
        ctx.fx.explosion(ev.enemy.position, 3.5 + 1.5 * s, 0xffa64b, 0.5);
      },
    },
  },
  {
    id: 'spirit_dagger', name: 'Spirit Daggers', rarity: 'rare', icon: '🗡️', tag: 'Offense',
    unlocked: false,
    desc: (s) => `Killing an enemy releases ${2 + s} homing daggers dealing ${pct(1.5)} damage each.`,
    stackText: '+1 dagger per stack',
    hooks: {
      onKill(ctx, s, ev) {
        ctx.spawnDaggers(ev.enemy.position, 2 + s, ctx.player.stats.damage * 1.5);
      },
    },
  },
  {
    id: 'chrono_shard', name: 'Chrono Shard', rarity: 'rare', icon: '⏳', tag: 'Utility',
    unlocked: false,
    desc: (s) => `Reduces all cooldowns by an additional ${pct(hyperbolic(0.28, s))}.`,
    stackText: '-28% cooldowns per stack (diminishing)',
    stats: (s, a) => { a.multCooldown *= 1 - hyperbolic(0.28, s); },
  },
  {
    id: 'carrion_mantle', name: 'Carrion Mantle', rarity: 'rare', icon: '🦅', tag: 'Offense',
    unlocked: false,
    desc: (s) => `Killing an elite steals its affix for ${(8 * s).toFixed(0)}s.`,
    stackText: '+8s duration per stack',
    hooks: {
      onKill(ctx, s, ev) {
        if (!ev.enemy.elite) return;
        ctx.stealAffix(ev.enemy.elite.id, 8 * s);
      },
    },
  },
  {
    id: 'vampiric_edge', name: 'Vampiric Edge', rarity: 'rare', icon: '🩸', tag: 'Healing',
    unlocked: true,
    desc: (s) => `Heal for ${pct(0.035 * s)} of all damage you deal.`,
    stackText: '+3.5% lifesteal per stack',
    stats: (s, a) => { a.lifesteal += 0.035 * s; },
  },
  {
    id: 'fortune_clover', name: 'Fortune Clover', rarity: 'rare', icon: '🍀', tag: 'Utility',
    unlocked: false,
    desc: (s) => `Luck-based effects get ${s} extra roll${s > 1 ? 's' : ''}. Chests roll rarity twice and keep the best.`,
    stackText: '+1 reroll per stack',
    stats: (s, a) => { a.luck += s; },
  },
  {
    id: 'razorwire', name: 'Razorwire', rarity: 'rare', icon: '🪤', tag: 'Defense',
    unlocked: false,
    desc: (s) => `Taking damage fires razors at up to ${3 + 2 * s} enemies within 22m for ${pct(1.6)} damage.`,
    stackText: '+2 targets per stack',
    hooks: {
      onDamaged(ctx, s) {
        if (ctx.isOnInternalCooldown('razorwire')) return;
        ctx.setInternalCooldown('razorwire', 0.35);
        ctx.razorBurst(3 + 2 * s, 22, ctx.player.stats.damage * 1.6);
      },
    },
  },
  {
    id: 'soul_catalyst', name: 'Soul Catalyst', rarity: 'rare', icon: '💠', tag: 'Utility',
    unlocked: false,
    desc: (s) => `Each kill reduces your cooldowns by ${(0.9 * s).toFixed(1)}s.`,
    stackText: '+0.9s per stack',
    hooks: {
      onKill(ctx, s) { ctx.reduceCooldowns(0.9 * s); },
    },
  },
  {
    id: 'tesla_coil', name: 'Unstable Tesla Coil', rarity: 'rare', icon: '⚡', tag: 'Offense',
    unlocked: false,
    desc: (s) => `Zaps ${2 + s} nearby enemies every 0.5s for ${pct(0.55)} damage.`,
    stackText: '+1 target per stack',
    hooks: {
      onTick(ctx, s, ev) {
        ctx.timer('tesla', ev.dt, 0.5, () => {
          const targets = ctx.nearestEnemies(ctx.player.position, 24, 2 + s);
          for (const t of targets) {
            ctx.damageEnemy(t, ctx.player.stats.damage * 0.55, { proc: 0.2, source: 'Tesla Coil' });
            ctx.fx.beam(ctx.player.chestPosition, t.position, 0x9fd0ff, 0.14);
          }
        });
      },
    },
  },

  {
    id: 'clutch_incubator', name: 'Clutch Incubator', rarity: 'rare', icon: '🐣', tag: 'Utility',
    unlocked: false,
    desc: (s) => `A downed brood lizard hatches again immediately. Recharges in ${Math.max(8, 26 - 6 * (s - 1))}s.`,
    stackText: '-6s recharge per stack',
    hooks: {
      onPetDown(ctx, s, ev) {
        if (ctx.isOnInternalCooldown('clutch_incubator')) return;
        ctx.setInternalCooldown('clutch_incubator', Math.max(8, 26 - 6 * (s - 1)));
        // A beat later, so the death still reads before the rebirth.
        ctx.schedule(0.7, () => {
          if (!ev.pet || ev.pet.alive) return;
          ev.pet.revive(true);
          ev.pet.health = ev.pet.maxHealth * 0.6;
          ctx.toast('The clutch stirs', '#ff8a3d');
        });
      },
    },
  },
  {
    id: 'splinter_rounds', name: 'Splinter Rounds', rarity: 'rare', icon: '🪡', tag: 'Offense',
    unlocked: false,
    desc: (s) => `Critical hits throw ${1 + s} seeking splinters for ${pct(0.4)} damage each.`,
    stackText: '+1 splinter per stack',
    hooks: {
      onCrit(ctx, s, ev) {
        if (ctx.isOnInternalCooldown('splinter_rounds')) return;
        ctx.setInternalCooldown('splinter_rounds', 0.35);
        ctx.spawnDaggers(ev.enemy.center, 1 + s, ctx.player.stats.damage * 0.4);
      },
    },
  },
  {
    id: 'warded_plating', name: 'Warded Plating', rarity: 'rare', icon: '🔰', tag: 'Defense',
    unlocked: false,
    desc: (s) => `Every 6s out of combat, gain a barrier worth ${pct(0.08 * s)} of your health. Overhealing becomes barrier.`,
    stackText: '+8% barrier per stack',
    stats: (s, a) => { a.barrierCap = Math.max(a.barrierCap, 0.3 + 0.1 * s); a.overhealToBarrier = true; },
    hooks: {
      onTick(ctx, s, ev) {
        ctx.timer('warded_plating', ev.dt, 6, () => {
          if (ctx.player.combatTimer > 0) return;
          ctx.grantBarrier(ctx.player.stats.maxHealth * 0.08 * s);
          ctx.fx.ring(ctx.player.position, 0.6, 2.2, 0x8fd8ff, 0.4, 0.4);
        });
      },
    },
  },
  {
    id: 'killers_eye', name: "Killer's Eye", rarity: 'rare', icon: '👁️', tag: 'Offense',
    unlocked: false,
    desc: (s) => `Increases critical damage by ${pct(0.3 * s)}. Critical hits cut ${(0.4 * s).toFixed(1)}s from your cooldowns.`,
    stackText: '+30% crit damage, +0.4s cooldown refund per stack',
    stats: (s, a) => { a.addCritDamage += 0.3 * s; },
    hooks: {
      onCrit(ctx, s) {
        if (ctx.isOnInternalCooldown('killers_eye')) return;
        ctx.setInternalCooldown('killers_eye', 1);
        ctx.reduceCooldowns(0.4 * s);
      },
    },
  },


  {
    id: 'gravemarker', name: 'Gravemarker', rarity: 'rare', icon: '🪦', tag: 'Offense',
    unlocked: true,
    desc: (s) => `Enemies leave a scorched patch on death, dealing ${pct(0.5 * s)} damage per second for 5s.`,
    stackText: '+50% patch damage per stack',
    hooks: {
      onKill(ctx, s, ev) {
        // One patch every half second at most. Without the gate, a build that
        // clears twenty husks at once schedules a hundred area queries in the
        // same frame, and the frame notices.
        if (ctx.isOnInternalCooldown('gravemarker')) return;
        ctx.setInternalCooldown('gravemarker', 0.5);
        const at = ev.enemy.position.clone();
        const dps = ctx.player.stats.damage * 0.5 * s;
        ctx.fx.ring(at, 0.5, 4.5, 0x9a6ada, 0.6, 0.7);
        for (let i = 0; i < 5; i++) {
          ctx.schedule(i, () => {
            ctx.areaDamage(at, 4.5, dps, { proc: 0.15, source: 'Gravemarker' });
            ctx.fx.ring(at, 3.6, 4.5, 0x9a6ada, 0.5, 0.28);
          });
        }
      },
    },
  },
  {
    id: 'siege_battery', name: 'Siege Battery', rarity: 'rare', icon: '🔌', tag: 'Offense',
    unlocked: true,
    desc: (s) => `Standing still charges up to ${pct(0.45 * s)} bonus damage over a second. Moving spends it. Currently {charge}%.`,
    stackText: '+45% charged damage per stack',
    hooks: {
      onTick(ctx, s, ev) {
        const still = ctx.player.speedXZ < 1.4;
        const cur = ctx.run.siegeCharge || 0;
        ctx.run.siegeCharge = still
          ? Math.min(1, cur + ev.dt * 0.9)
          : Math.max(0, cur - ev.dt * 2.4);
      },
      modifyDamage(ctx, s, ev) {
        return ev.damage * (1 + (ctx.run.siegeCharge || 0) * 0.45 * s);
      },
    },
    dynamic: (run) => ({ charge: Math.round((run.siegeCharge || 0) * 100) }),
  },
  {
    id: 'cinder_wake', name: 'Cinder Wake', rarity: 'rare', icon: '🔥', tag: 'Offense',
    unlocked: true,
    desc: (s) => `Running leaves a burning trail that deals ${pct(0.35 * s)} damage per tick for two seconds.`,
    stackText: '+35% trail damage per stack',
    hooks: {
      onTick(ctx, s, ev) {
        if (ctx.player.speedXZ < 6 || !ctx.player.grounded) return;
        ctx.timer('cinderWake', ev.dt, 0.28, () => {
          const at = ctx.player.position.clone();
          ctx.fx.glow(at, { color: 0xff7a3a, size: 1.5, life: 0.9, grow: 1.4 });
          for (let i = 0; i < 4; i++) {
            ctx.schedule(i * 0.5, () => {
              ctx.areaDamage(at, 2.6, ctx.player.stats.damage * 0.35 * s, {
                proc: 0.1, source: 'Cinder Wake',
              });
            });
          }
        });
      },
    },
  },
  {
    id: 'tacticians_ledger', name: "Tactician's Ledger", rarity: 'rare', icon: '📕', tag: 'Utility',
    unlocked: true,
    desc: (s) => `Each enemy within 14m grants ${pct(0.035 * s)} attack speed, up to eight of them.`,
    stackText: '+3.5% per nearby enemy per stack',
    hooks: {
      onTick(ctx, s, ev) {
        ctx.timer('ledger', ev.dt, 0.4, () => {
          const near = Math.min(8, ctx.nearestEnemies(ctx.player.position, 14, 8).length);
          if (near > 0) ctx.addBuff('ledger', 0.9, 0.035 * s * near, 1, '📕 Outnumbered', { stat: 'attackSpeed' });
        });
      },
    },
  },
  /* ==========================================================
     EPIC
     ========================================================== */
  {
    id: 'sunder_rounds', name: 'Sunder Rounds', rarity: 'epic', icon: '🔨', tag: 'Offense',
    unlocked: false,
    desc: (s) => `Every 3rd hit on an enemy shatters ${(45 * s).toFixed(0)} of its armor and applies a ${pct(0.2 * s)} damage-taken debuff for 8s.`,
    stackText: '+45 armor shred, +20% vulnerability per stack',
    hooks: {
      onHit(ctx, s, ev) {
        const e = ev.enemy;
        e.sunderCount = (e.sunderCount || 0) + 1;
        if (e.sunderCount % 3 !== 0) return;
        ctx.applyStatus(e, 'sunder', 8, { armor: 45 * s, vuln: 0.2 * s });
        ctx.fx.shatter(e.position);
      },
    },
  },
  {
    id: 'frost_relic', name: 'Frost Relic', rarity: 'epic', icon: '❄️', tag: 'Offense',
    unlocked: false,
    desc: (s) => `Kills grow a frozen aura dealing ${pct(0.28)} damage per second, up to ${(6 + 4 * s).toFixed(0)}m. Decays out of combat.`,
    stackText: '+4m max radius per stack',
    hooks: {
      onKill(ctx, s) {
        ctx.run.frostStacks = Math.min((ctx.run.frostStacks || 0) + 1, 20);
      },
      onTick(ctx, s, ev) {
        const st = ctx.run.frostStacks || 0;
        if (st <= 0) return;
        ctx.run.frostStacks = Math.max(0, st - ev.dt * 0.55);
        const radius = Math.min(6 + 4 * s, 2 + st * 0.9);
        ctx.timer('frost', ev.dt, 0.5, () => {
          ctx.areaDamage(ctx.player.position, radius, ctx.player.stats.damage * 0.14, {
            proc: 0.1, source: 'Frost Relic', chill: 2,
          });
          ctx.fx.frostRing(ctx.player.position, radius);
        });
      },
    },
  },
  {
    id: 'vital_rack', name: 'Rejuvenation Rack', rarity: 'epic', icon: '💚', tag: 'Healing',
    unlocked: false,
    desc: (s) => `Increases all healing by ${pct(1.0 * s)} and health regeneration by ${pct(0.8 * s)}.`,
    stackText: '+100% healing per stack',
    stats: (s, a) => { a.multHealing *= 1 + 1.0 * s; a.multRegen *= 1 + 0.8 * s; },
  },
  {
    id: 'ember_band', name: "Ember Band", rarity: 'epic', icon: '🟠', tag: 'Offense',
    unlocked: true,
    desc: (s) => `Hits that deal more than 400% damage ignite for ${pct(3.0 * s)} damage over 4s. 6s cooldown.`,
    stackText: '+300% burn damage per stack',
    hooks: {
      onHit(ctx, s, ev) {
        if (ev.damage < ctx.player.stats.damage * 4) return;
        if (ctx.isOnInternalCooldown('ember_band')) return;
        ctx.setInternalCooldown('ember_band', 6 * ctx.player.stats.cooldownMult);
        ctx.applyStatus(ev.enemy, 'burn', 4, { dps: ctx.player.stats.damage * 3.0 * s / 4 });
        ctx.fx.explosion(ev.enemy.position, 5, 0xff6a2a, 0.7);
      },
    },
  },
  {
    id: 'cryo_band', name: 'Cryo Band', rarity: 'epic', icon: '🔵', tag: 'Offense',
    unlocked: false,
    desc: (s) => `Hits that deal more than 400% damage freeze and blast for ${pct(2.5 * s)} damage. 6s cooldown.`,
    stackText: '+250% blast damage per stack',
    hooks: {
      onHit(ctx, s, ev) {
        if (ev.damage < ctx.player.stats.damage * 4) return;
        if (ctx.isOnInternalCooldown('cryo_band')) return;
        ctx.setInternalCooldown('cryo_band', 6 * ctx.player.stats.cooldownMult);
        ctx.areaDamage(ev.enemy.position, 9, ctx.player.stats.damage * 2.5 * s, {
          proc: 0, source: 'Cryo Band', freeze: 2.5,
        });
        ctx.fx.explosion(ev.enemy.position, 9, 0x6ad0ff, 0.9);
      },
    },
  },
  {
    id: 'neural_spike', name: 'Neural Spike', rarity: 'epic', icon: '🧠', tag: 'Utility',
    unlocked: false,
    desc: (s) => `Killing an elite removes all cooldowns for ${(3 + 2 * s).toFixed(0)}s.`,
    stackText: '+2s duration per stack',
    hooks: {
      onKill(ctx, s, ev) {
        if (!ev.enemy.elite) return;
        ctx.addBuff('overclock', 3 + 2 * s, 1, 1, '🧠 Overclocked');
        ctx.toast('Neural Spike — cooldowns purged', '#b473ff');
      },
    },
  },
  {
    id: 'aegis', name: 'Aegis', rarity: 'epic', icon: '🔰', tag: 'Defense',
    unlocked: false,
    desc: (s) => `Healing above full health becomes a temporary barrier, up to ${pct(0.5 * s)} of your max health.`,
    stackText: '+50% barrier cap per stack',
    stats: (s, a) => { a.barrierCap += 0.5 * s; a.overhealToBarrier = true; },
  },
  {
    id: 'laser_scope', name: 'Laser Scope', rarity: 'epic', icon: '🎯', tag: 'Offense',
    unlocked: true,
    desc: (s) => `Increases critical strike damage by ${pct(1.0 * s)}.`,
    stackText: '+100% crit damage per stack',
    stats: (s, a) => { a.addCritDamage += 1.0 * s; },
  },

  {
    id: 'alpha_bond', name: 'Alpha Bond', rarity: 'epic', icon: '🜛', tag: 'Utility',
    unlocked: false,
    desc: (s) => `One more egg per stage. Your pets' attacks arc lightning through ${1 + s} enemies for ${pct(0.7 * s)} damage.`,
    stackText: '+1 chain jump, +70% chain damage per stack',
    stats: (s, a) => { a.addEggs += 1; },
    hooks: {
      onHit(ctx, s, ev) {
        if (!ev.source || !ev.source.startsWith('Pet:')) return;
        if (ctx.isOnInternalCooldown('alpha_bond')) return;
        ctx.setInternalCooldown('alpha_bond', 0.45);
        ctx.chainLightning(ev.enemy, 1 + s, ctx.player.stats.damage * 0.7 * s, 12, 0xff8a3d);
      },
    },
  },
  {
    id: 'molten_core', name: 'Molten Core', rarity: 'epic', icon: '🌋', tag: 'Offense',
    unlocked: false,
    desc: (s) => `Burning enemies take ${pct(0.22 * s)} more damage from everything.`,
    stackText: '+22% damage to burning targets per stack',
    hooks: {
      modifyDamage(ctx, s, ev) {
        if (!ev.enemy.statuses?.has('burn')) return ev.damage;
        return ev.damage * (1 + 0.22 * s);
      },
    },
  },
  {
    id: 'second_wind', name: 'Second Wind', rarity: 'epic', icon: '💨', tag: 'Healing',
    unlocked: false,
    desc: (s) => `Dropping below 30% health grants a barrier worth ${pct(0.35 * s)} of your health and 4s of haste. Recharges in ${Math.max(20, 50 - 8 * (s - 1))}s.`,
    stackText: '+35% barrier, -8s recharge per stack',
    hooks: {
      onLowHealth(ctx, s) {
        if (ctx.isOnInternalCooldown('second_wind')) return;
        ctx.setInternalCooldown('second_wind', Math.max(20, 50 - 8 * (s - 1)));
        ctx.grantBarrier(ctx.player.stats.maxHealth * 0.35 * s);
        ctx.addBuff('warcry', 4, 0.25, 1, '⟿ Second Wind', { move: 0.3 });
        ctx.fx.ring(ctx.player.position, 1, 7, 0x8fd8ff, 0.5, 0.9);
        ctx.toast('SECOND WIND', '#8fd8ff');
      },
    },
  },


  {
    id: 'echo_chamber', name: 'Echo Chamber', rarity: 'epic', icon: '🔊', tag: 'Offense',
    unlocked: true,
    desc: (s) => `${pct(0.18)} chance on hit to repeat the hit for ${pct(0.85 * s)} of its damage.`,
    stackText: '+85% echoed damage per stack',
    hooks: {
      onHit(ctx, s, ev) {
        if (ev.enemy.dead || !ctx.procRoll(0.18, ev.proc)) return;
        // The echo carries a proc coefficient of zero, deliberately: an echo
        // that can itself echo is a recursion, and a recursion with enough
        // stacks is a hang rather than a build.
        ctx.schedule(0.14, () => {
          if (ev.enemy.dead) return;
          ctx.damageEnemy(ev.enemy, ev.damage * 0.85 * s, { proc: 0, source: 'Echo Chamber' });
          ctx.fx.ring(ev.enemy.center, 0.3, 2.2, 0xb473ff, 0.28, 0.7);
        });
      },
    },
  },
  {
    id: 'bulwark_anchor', name: 'Bulwark Anchor', rarity: 'epic', icon: '⛓️', tag: 'Defense',
    unlocked: true,
    desc: (s) => `Barriers decay half as fast, and while one holds you deal ${pct(0.2 * s)} more damage.`,
    stackText: '+20% damage while barriered per stack',
    hooks: {
      onTick(ctx, s, ev) {
        if (ctx.player.barrier <= 0) return;
        ctx.addBuff('anchored', 0.4, 0.2 * s, 1, '⛓️ Anchored', { stat: 'damage' });
        // The player drains barrier at 3.5% of max health a second. Paying half
        // of that back here halves the drain without the player having to know
        // this item exists.
        ctx.player.barrier += ctx.player.stats.maxHealth * 0.0175 * ev.dt;
      },
    },
  },
  {
    id: 'harvest_scythe', name: 'Harvest Scythe', rarity: 'epic', icon: '🌾', tag: 'Utility',
    unlocked: false,
    desc: (s) => `Every kill refunds ${(0.35 * s).toFixed(2)}s of ability cooldowns and 8 gold.`,
    stackText: '+0.35s refunded per stack',
    hooks: {
      onKill(ctx, s) {
        ctx.reduceCooldowns(0.35 * s);
        ctx.player.addGold(8);
      },
    },
  },
  {
    id: 'starve_the_flame', name: 'Starve the Flame', rarity: 'epic', icon: '🫙', tag: 'Defense',
    unlocked: false,
    desc: (s) => `No single hit can take more than ${pct(Math.max(0.06, 0.14 - 0.03 * (s - 1)))} of your maximum health.`,
    stackText: '-3% cap per stack, down to 6%',
    hooks: {
      modifyIncoming(ctx, s, ev) {
        const cap = ctx.player.stats.maxHealth * Math.max(0.06, 0.14 - 0.03 * (s - 1));
        return Math.min(ev.amount, cap);
      },
    },
  },
  /* ==========================================================
     LEGENDARY
     ========================================================== */
  {
    id: 'phoenix_charm', name: 'Phoenix Charm', rarity: 'legendary', icon: '🪽', tag: 'Defense',
    unlocked: true,
    desc: (s) => `Lethal damage instead revives you at full health with 4s of invulnerability. Consumes one stack. (${s} charge${s > 1 ? 's' : ''})`,
    stackText: '+1 revive per stack',
    consumable: true,
    hooks: {
      onFatal(ctx, s) {
        ctx.consumeItem('phoenix_charm', 1);
        ctx.player.health = ctx.player.stats.maxHealth;
        ctx.player.invulnerable = 4;
        ctx.fx.explosion(ctx.player.position, 22, 0xffb347, 1.6);
        ctx.areaDamage(ctx.player.position, 22, ctx.player.stats.damage * 8, { proc: 0, source: 'Phoenix Charm' });
        ctx.toast('PHOENIX CHARM CONSUMED', '#ff8a3d');
        return true; // damage prevented
      },
    },
  },
  {
    id: 'prismatic_glass', name: 'Prismatic Glass', rarity: 'legendary', icon: '💎', tag: 'Offense',
    unlocked: false,
    desc: (s) => `Deal ${pct(Math.pow(2, s) - 1)} more damage. Your maximum health is reduced by ${pct(1 - Math.pow(0.5, s))}.`,
    stackText: 'Doubles damage, halves health, per stack',
    stats: (s, a) => { a.multDamage *= Math.pow(2, s); a.multMaxHealth *= Math.pow(0.5, s); },
  },
  {
    id: 'singularity_core', name: 'Singularity Core', rarity: 'legendary', icon: '🕳️', tag: 'Offense',
    unlocked: false,
    desc: (s) => `Every ${Math.max(4, 9 - s).toFixed(0)}s, collapse a singularity that pulls enemies in and deals ${pct(4.0 * s)} damage.`,
    stackText: '-1s interval, +400% damage per stack',
    hooks: {
      onTick(ctx, s, ev) {
        ctx.timer('singularity', ev.dt, Math.max(4, 9 - s), () => {
          const target = ctx.nearestEnemies(ctx.player.position, 44, 1)[0];
          if (!target) return;
          ctx.spawnSingularity(target.position, 13, ctx.player.stats.damage * 4.0 * s);
        });
      },
    },
  },
  {
    id: 'genesis_loop', name: 'Genesis Loop', rarity: 'legendary', icon: '🌀', tag: 'Defense',
    unlocked: false,
    desc: (s) => `Falling below 25% health erupts for ${pct(20 * s)} damage in 26m and heals you for 40%. Recharges in ${Math.max(12, 30 - 6 * (s - 1))}s.`,
    stackText: '+2000% damage, -6s recharge per stack',
    hooks: {
      onLowHealth(ctx, s) {
        if (ctx.isOnInternalCooldown('genesis_loop')) return;
        ctx.setInternalCooldown('genesis_loop', Math.max(12, 30 - 6 * (s - 1)));
        ctx.areaDamage(ctx.player.position, 26, ctx.player.stats.damage * 20 * s, { proc: 0, source: 'Genesis Loop' });
        ctx.heal(ctx.player.stats.maxHealth * 0.4, 'Genesis Loop');
        ctx.fx.explosion(ctx.player.position, 26, 0x9a5bff, 2.0);
        ctx.shake(1.2);
        ctx.toast('GENESIS LOOP', '#b473ff');
      },
    },
  },
  {
    id: 'eclipse_crown', name: 'Eclipse Crown', rarity: 'legendary', icon: '👑', tag: 'Offense',
    unlocked: false,
    desc: (s) => `Elite kills permanently grant +${(2.5 * s).toFixed(1)} base damage. Currently +${'{crown}'}.`,
    stackText: '+2.5 damage per elite per stack',
    stats: (s, a, run) => { a.addDamage += (run.crown || 0); },
    hooks: {
      onKill(ctx, s, ev) {
        if (!ev.enemy.elite) return;
        ctx.run.crown = (ctx.run.crown || 0) + 2.5 * s;
        ctx.player.markStatsDirty();
        ctx.toast(`Eclipse Crown +${(2.5 * s).toFixed(1)} damage`, '#ff8a3d');
      },
    },
    dynamic: (run) => ({ crown: (run.crown || 0).toFixed(1) }),
  },
  {
    id: 'resonance_disc', name: 'Resonance Disc', rarity: 'legendary', icon: '📀', tag: 'Offense',
    unlocked: false,
    desc: (s) => `Store ${pct(0.12)} of damage dealt. At ${(320 * s).toFixed(0)}% of your damage, launch a piercing disc that unloads it.`,
    stackText: 'Fires more often and hits harder per stack',
    hooks: {
      onHit(ctx, s, ev) {
        const threshold = ctx.player.stats.damage * 3.2 * s;
        ctx.run.discCharge = (ctx.run.discCharge || 0) + ev.damage * 0.12;
        if (ctx.run.discCharge < threshold) return;
        const payload = ctx.run.discCharge;
        ctx.run.discCharge = 0;
        ctx.spawnDisc(payload);
      },
    },
  },
  {
    id: 'dracoform_sigil', name: 'Dracoform Sigil', rarity: 'legendary', icon: '🐉', tag: 'Utility',
    unlocked: false,
    desc: (s) => `Your brood grows. +${2 * s} eggs per stage, +${s} shot per volley, ${pct(0.5 * s)} pet damage and ${pct(0.6 * s)} pet health.`,
    stackText: '+2 eggs per stage, +1 volley shot per stack',
    stats: (s, a) => {
      a.addEggs += 2 * s;
      a.addPetVolley += s;
      a.multPetDamage *= 1 + 0.5 * s;
      a.multPetHealth *= 1 + 0.6 * s;
    },
  },
  {
    id: 'ouroboros_coil', name: 'Ouroboros Coil', rarity: 'legendary', icon: '🐍', tag: 'Healing',
    unlocked: false,
    desc: (s) => `Every 11s, spend 12% of your current health to erupt for ${pct(7 * s)} damage in 16m, healing double what it cost per enemy struck.`,
    stackText: '+700% eruption damage per stack',
    hooks: {
      onTick(ctx, s, ev) {
        ctx.timer('ouroboros_coil', ev.dt, 11, () => {
          const p = ctx.player;
          const cost = p.health * 0.12;
          if (p.health - cost < 1) return;
          const struck = ctx.areaDamage(p.position, 16, p.stats.damage * 7 * s, {
            proc: 0.3, source: 'Ouroboros Coil',
          });
          if (struck <= 0) return;
          p.health -= cost;
          const hit = ctx.nearestEnemies(p.position, 16, 12).length;
          ctx.heal(cost * 2 * Math.min(1, hit / 3), 'Ouroboros Coil');
          ctx.fx.explosion(p.position, 16, 0x9a5bff, 1.4);
          ctx.shake(0.4);
        });
      },
    },
  },
  {
    id: 'zero_hour', name: 'Zero Hour', rarity: 'legendary', icon: '⏱️', tag: 'Offense',
    unlocked: false,
    desc: (s) => `Every 18th hit detonates for ${pct(11 * s)} damage and freezes everything within 13m for 1.6s. Currently ${'{count}'}/18.`,
    stackText: '+1100% detonation damage per stack',
    hooks: {
      onHit(ctx, s, ev) {
        if (ev.proc <= 0) return;
        ctx.run.zeroHour = (ctx.run.zeroHour || 0) + 1;
        if (ctx.run.zeroHour < 18) return;
        ctx.run.zeroHour = 0;
        const at = ev.enemy.center.clone();
        ctx.areaDamage(at, 13, ctx.player.stats.damage * 11 * s, {
          proc: 0, source: 'Zero Hour', freeze: 1.6, force: 14,
        });
        ctx.fx.explosion(at, 13, 0x9fe0ff, 1.8);
        ctx.fx.frostRing(at, 13);
        ctx.shake(0.7);
        ctx.toast('ZERO HOUR', '#9fe0ff');
      },
    },
    dynamic: (run) => ({ count: run.zeroHour || 0 }),
  },

  {
    id: 'gauntlet_of_ruin', name: 'Gauntlet of Ruin', rarity: 'legendary', icon: '🤜', tag: 'Offense',
    unlocked: true,
    desc: (s) => `Every twelfth hit detonates for ${pct(6 * s)} damage in 10m. {charge} of 12 charged.`,
    stackText: '+600% detonation per stack',
    hooks: {
      onHit(ctx, s, ev) {
        ctx.run.ruinStacks = (ctx.run.ruinStacks || 0) + 1;
        if (ctx.run.ruinStacks < 12) return;
        ctx.run.ruinStacks = 0;
        const at = ev.enemy.center.clone();
        ctx.areaDamage(at, 10, ctx.player.stats.damage * 6 * s, {
          proc: 0.4, source: 'Gauntlet of Ruin', force: 22,
        });
        ctx.fx.explosion(at, 10, 0xff5a2a, 1.6);
        ctx.shake(0.4);
      },
    },
    dynamic: (run) => ({ charge: run.ruinStacks || 0 }),
  },
  {
    id: 'tectonic_heart', name: 'Tectonic Heart', rarity: 'legendary', icon: '🪨', tag: 'Offense',
    unlocked: false,
    desc: (s) => `Landing from four metres or more slams the ground for up to ${pct(10.5 * s)} damage. The further you fell, the wider it goes.`,
    stackText: '+350% slam damage per stack',
    hooks: {
      onTick(ctx, s) {
        const p = ctx.player;
        const peak = ctx.run.tectonicPeak || 0;
        if (!p.grounded) {
          ctx.run.tectonicPeak = Math.max(peak, p.position.y);
          return;
        }
        ctx.run.tectonicPeak = 0;
        const drop = peak - p.position.y;
        if (drop < 4) return;
        const scale = Math.min(3, drop / 6);
        const radius = 6 + scale * 4;
        ctx.areaDamage(p.position, radius, p.stats.damage * 3.5 * s * scale, {
          proc: 0.5, source: 'Tectonic Heart', force: 18,
        });
        ctx.fx.explosion(p.position, radius, 0x8a7060, 1.1 * scale);
        ctx.fx.ring(p.position, 0.5, radius, 0xffb347, 0.45, 0.8);
        ctx.shake(0.3 * scale);
      },
    },
  },
  {
    id: 'covenant_of_debt', name: 'Covenant of Debt', rarity: 'legendary', icon: '📜', tag: 'Utility',
    unlocked: false,
    desc: (s) => `Everything on the stage costs ${pct(Math.min(0.6, 0.25 * s))} less. Everything on the stage hits you ${pct(0.14)} harder.`,
    stackText: '-25% prices per stack, capped at 60%',
    stats: (s, a) => { a.multDamageTaken *= 1.14; a.priceMult = Math.min(0.6, 0.25 * s); },
  },
];

export const ITEMS_BY_ID = Object.fromEntries(ITEMS.map((i) => [i.id, i]));

export const ITEMS_BY_RARITY = ITEMS.reduce((acc, item) => {
  (acc[item.rarity] ||= []).push(item);
  return acc;
}, {});

export function itemById(id) { return ITEMS_BY_ID[id]; }

/** Items that start unlocked without spending Echoes. */
export const DEFAULT_UNLOCKED_ITEMS = ITEMS.filter((i) => i.unlocked).map((i) => i.id);

/** Convenience for UI: description with dynamic run values substituted. */
export function itemDescription(item, stacks = 1, run = null) {
  let text = item.desc(stacks);
  if (item.dynamic && run) {
    const vals = item.dynamic(run);
    for (const k in vals) text = text.replace(`{${k}}`, vals[k]);
  }
  return text.replace(/\{\w+\}/g, '0');
}

export { rollProc };
