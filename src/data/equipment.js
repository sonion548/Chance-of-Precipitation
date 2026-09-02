/**
 * Equipment.
 *
 * One slot, one thing in it, on a long cooldown, fired with a key of its own.
 * That is the whole shape and every part of it is deliberate.
 *
 * Items are *passive and cumulative*: you take everything you find, they stack,
 * and a run is the pile you ended up with. Nothing you pick up is ever a
 * decision — a second Stim Injector is strictly better than no second Stim
 * Injector, so the only question a chest asks is "what did it roll".
 *
 * Equipment is the opposite of all three of those things. You carry exactly
 * one, taking a new one throws the old one away, and it does nothing at all
 * until you press the button. So it is the one thing in the game you have to
 * *decide* about, twice: once at the pod, and again every time the cooldown
 * comes back and you have to judge whether this is the moment.
 *
 * Which means the numbers here are enormous on purpose. A 60-second cooldown
 * that does what an item does is not an interesting decision; a 60-second
 * cooldown that deletes an elite pack is. If a piece of equipment ever reads as
 * "a slightly better item", it is priced wrong.
 *
 * A definition:
 *
 *   id, name, icon, tag, desc      what it is, for the pod and the HUD
 *   cooldown                       seconds, before item cooldown reduction
 *   use(ctx)                       fire it; return false to refuse and refund
 *
 * `ctx` is the same façade items get (systems/inventory.js), plus `combat` and
 * `aimPoint`. Returning false is how a piece of equipment declines to go off —
 * a recall beacon with nowhere to recall to gives you the press back rather
 * than eating a forty-second cooldown for nothing.
 */

export const EQUIPMENT = [
  {
    id: 'ionic_lance',
    name: 'Ionic Lance',
    icon: '⚡',
    tag: 'Offense',
    cooldown: 12,
    desc: 'Fire a beam down your line of sight for 1500% damage, piercing everything, and strip 40 armour from every body it crosses for 10s.',
    use(ctx) {
      const hits = ctx.beamLine({
        damage: ctx.damage * 15, range: 160, radius: 2.6,
        color: 0x8fd8ff, source: 'Ionic Lance',
        onHit: (e) => e.applyStatus('sunder', 10, { armor: 40, vuln: 0.15 }),
      });
      ctx.shake(0.5);
      ctx.toast(hits ? `IONIC LANCE — ${hits} struck` : 'IONIC LANCE', '#8fd8ff');
    },
  },
  {
    id: 'recall_beacon',
    name: 'Recall Beacon',
    icon: '📍',
    tag: 'Mobility',
    cooldown: 30,
    /* The only equipment with two presses, and the reason it is worth the
       complication: the first press costs nothing and commits you to nothing,
       so the decision is not "use it now" but "was that spot worth marking".
       Nothing else in the game asks that. */
    desc: 'Plant a beacon. Press again within 20s to return to it, healing 25% of your health and shrugging off everything for a moment. The cooldown starts when you come back.',
    use(ctx) {
      if (ctx.equipState.beacon) {
        const to = ctx.equipState.beacon;
        ctx.equipState.beacon = null;
        ctx.teleportTo(to);
        ctx.heal(ctx.player.stats.maxHealth * 0.25, 'Recall Beacon');
        ctx.player.invulnerable = Math.max(ctx.player.invulnerable, 1.2);
        ctx.fx.ring(ctx.player.position, 0.5, 6, 0x46e0c0, 0.6, 1);
        ctx.toast('RECALLED', '#46e0c0');
        return true;
      }
      ctx.equipState.beacon = ctx.player.position.clone();
      ctx.equipState.beaconTime = 20;
      ctx.fx.ring(ctx.player.position, 0.4, 3.2, 0x46e0c0, 0.5, 0.9);
      ctx.toast('BEACON PLANTED — X TO RETURN', '#46e0c0');
      // No cooldown on the outbound trip: what you are buying is the return.
      return false;
    },
  },
  {
    id: 'effigy_of_spite',
    name: 'Effigy of Spite',
    icon: '🗿',
    tag: 'Utility',
    cooldown: 45,
    desc: 'Plant an effigy for 14s. Everything within 20m of it is chilled to a crawl and takes 130% damage a second — and it pulls every eye in the arena onto itself rather than onto you.',
    use(ctx) {
      ctx.plantEffigy({
        duration: 14, radius: 20, dps: ctx.damage * 1.3, color: 0xff6ad0,
      });
      ctx.toast('EFFIGY OF SPITE', '#ff6ad0');
    },
  },
  {
    id: 'collapse_charge',
    name: 'Collapse Charge',
    icon: '🕳️',
    tag: 'Offense',
    cooldown: 75,
    /* The longest cooldown in the game and the largest single number. It exists
       so that one of the nine answers is "wait, and then delete the problem". */
    desc: 'Lob a charge that falls slowly and then implodes: everything within 22m is dragged in and takes 4000% damage.',
    use(ctx) {
      ctx.lobCharge({
        speed: 26, gravity: -9, radius: 22, damage: ctx.damage * 40, color: 0x9a5bff,
        source: 'Collapse Charge',
      });
      ctx.toast('COLLAPSE CHARGE', '#b473ff');
    },
  },
  {
    id: 'volatile_serum',
    name: 'Volatile Serum',
    icon: '🧪',
    tag: 'Offense',
    cooldown: 28,
    desc: 'For 9s deal 70% more damage and attack 40% faster — and take 45% more damage. There is no way to end it early.',
    use(ctx) {
      // One buff carrying all three effects rather than three carrying one
      // each: the HUD shows a buff per entry, and a player should see "Volatile
      // Serum" once, not a stack of three internal ids. Read in
      // `recomputeStats` beside the other named ability buffs.
      ctx.addBuff('serum', 9, 1, 1, '🧪 Volatile Serum');
      ctx.fx.ring(ctx.player.position, 0.4, 5, 0xff4d5e, 0.5, 0.9);
      ctx.toast('VOLATILE SERUM', '#ff4d5e');
    },
  },
  {
    id: 'gravity_well',
    name: 'Gravity Well',
    icon: '🌀',
    tag: 'Utility',
    cooldown: 40,
    desc: 'Open a well at your aim point that hauls everything within 15m into its centre and grinds them for 900%.',
    use(ctx) {
      ctx.spawnSingularity(ctx.aimPoint.clone(), 15, ctx.damage * 9);
      ctx.shake(0.4);
      ctx.toast('GRAVITY WELL', '#b473ff');
    },
  },
  {
    id: 'field_medkit',
    name: 'Field Medkit',
    icon: '🧰',
    tag: 'Healing',
    cooldown: 32,
    desc: 'Heal 55% of your maximum health at once, and turn whatever it overheals into barrier. Everyone standing near you gets half.',
    use(ctx) {
      const p = ctx.player;
      const amount = p.stats.maxHealth * 0.55;
      const before = p.health;
      ctx.heal(amount, 'Field Medkit');
      // Whatever the bar could not take becomes barrier, so a medkit at full
      // health is a shield rather than a wasted press.
      const spare = amount - (p.health - before);
      if (spare > 0) ctx.grantBarrier(spare * 0.7);
      ctx.healAllies(amount * 0.5);
      ctx.fx.ring(p.position, 0.4, 7, 0x4be08a, 0.55, 0.9);
      ctx.toast('FIELD MEDKIT', '#4be08a');
    },
  },
  {
    id: 'chrono_anchor',
    name: 'Chrono Anchor',
    icon: '⏳',
    tag: 'Utility',
    cooldown: 50,
    desc: 'Stop every enemy within 26m dead for 4.5s. They take 25% more damage while frozen, and nothing wakes them early.',
    use(ctx) {
      const caught = ctx.nearestEnemies(ctx.player.position, 26, 60);
      for (const e of caught) {
        e.applyStatus('freeze', 4.5, {});
        e.applyStatus('sunder', 4.5, { armor: 0, vuln: 0.25 });
        ctx.fx.glow(e.center, { color: 0x8fd8ff, size: 1.4, life: 0.4, grow: 1.6 });
      }
      ctx.fx.ring(ctx.player.position, 1, 26, 0x8fd8ff, 0.7, 0.9);
      ctx.toast(`CHRONO ANCHOR — ${caught.length} held`, '#8fd8ff');
    },
  },
  {
    id: 'prospectors_charge',
    name: "Prospector's Charge",
    icon: '💰',
    tag: 'Utility',
    cooldown: 55,
    /* Equipment that does no damage at all, on purpose. Gold is the only
       resource in the game you can convert into anything else, so the piece of
       equipment that buys chests is competing with the one that deletes a boss
       — and on a stage with four Large chests on it, it wins. */
    desc: 'Shake 45 gold out of every enemy within 40m, and 4× that out of every elite and boss.',
    use(ctx) {
      const caught = ctx.nearestEnemies(ctx.player.position, 40, 80);
      let total = 0;
      for (const e of caught) {
        const worth = Math.round(45 * (e.boss ? 4 : e.elite ? 4 : 1));
        total += worth;
        ctx.fx.beam(e.center, ctx.player.chestPosition, 0xffcf5c, 0.25, 0.05);
      }
      if (total > 0) ctx.grantGold(total);
      ctx.toast(total ? `PROSPECTOR'S CHARGE — ${total} gold` : 'Nothing to shake down', '#ffcf5c');
    },
  },
];

export const EQUIPMENT_BY_ID = Object.fromEntries(EQUIPMENT.map((e) => [e.id, e]));
export function equipmentById(id) { return EQUIPMENT_BY_ID[id] || null; }
