/**
 * Per-stage identity.
 *
 * Each theme carries its lighting rig, ground colours, the prop mix the
 * scatterer dresses the arena with, its size, and — the part that actually
 * changes how a stage plays — its `landform`.
 *
 * A theme used to be a palette swap. Six arenas, all of them a flat disc of the
 * same radius, differing in what colour the flat disc was and which trees stood
 * on it. The landform gives each one the shape of its own ground:
 *
 *   amplitude  metres of relief, peak to trough
 *   scale      wavelength of the main swell, in metres
 *   detail     how much fine chop rides on top of it
 *   ridged     0 rolls, 1 folds the field into crests with valleys between
 *   bowl       radial profile — positive walls the arena in, negative sinks it
 *   terrace    quantises the height into shelves this many metres apart
 *
 * The centre stays flat whatever the numbers say, because the plateau, the
 * Beacon fight and every spawn need level ground; so does the last few metres
 * before the wall, so the boundary still meets the floor.
 *
 * Stage 1 is deliberately the calmest of the set — open, green, high-key, and
 * the gentlest ground — so the opening minutes read as a place rather than a
 * threat. The palette darkens and the footing gets worse as you descend.
 */
export const THEMES = [
  {
    id: 'hollow', name: 'Verdant Hollow',
    depth: 1,
    bosses: ['thornmaw', 'colossus'],
    arenaRadius: 148,
    // Rolling and forgiving: long wavelengths, no ridging, a gentle lift toward
    // the rim. You can see across the whole of it, which is the point.
    landform: { amplitude: 5.2, scale: 82, detail: 0.26, ridged: 0, bowl: 3.0, terrace: 0 },
    sky: 0x9dc8e0, fog: 0xa8cfdd, fogNear: 96, fogFar: 520,
    hemiSky: 0xd8f0ff, hemiGround: 0x5a7048, hemiIntensity: 1.05,
    sunColor: 0xfff0d0, sunIntensity: 1.62, sunDir: [60, 92, 46],
    rimColor: 0x8fc4ff, rimIntensity: 0.4,
    ground: 0x6d9455, groundAccent: 0x86ac66, rock: 0x8a9a86, structure: 0xa8b09c,
    emissive: 0x7fe0c0, particle: 0xe8ffd8, particleCount: 190, particleDrift: [0.25, 0.18, 0.1],
    exposure: 1.02,
    palette: {
      grass: [0x7fae5a, 0x8fbf62, 0x6d9c4e, 0xa3c877],
      foliage: [0x4f8a44, 0x5f9b4e, 0x74ab5c, 0x437a3c],
      bark: [0x6b5442, 0x7a6350, 0x5c473a],
      rock: [0x6e7b6d, 0x7c8a79, 0x616e60],
      stone: [0x8f9887, 0x9ba492, 0x828b7b],
      crystal: [0x7fe0c0, 0x9fe8d4],
      accentProps: [0xd88a6a, 0xe8a878, 0xc47a5a],
    },
    terrain: {
      plateauSteps: 3, plateauRise: 0.58, plateauRadius: 15,
      pillars: [6, 9], pillarWidth: [2.2, 3.8], pillarHeight: [2.2, 5.5],
      decks: [2, 4], rubble: [14, 22], shards: 6,
    },
    particleOpacity: 0.28, beamOpacity: 0.06,
    props: [
      { type: 'grass', count: 2600, scale: [0.55, 1.05], wind: true },
      { type: 'fern', count: 210, scale: [0.6, 1.0], wind: true },
      { type: 'bush', count: 150, scale: [0.55, 1.0] },
      { type: 'tree', count: 46, scale: [0.85, 1.35] },
      { type: 'rockCluster', count: 30, scale: [0.7, 1.5] },
      { type: 'rock', count: 60, scale: [0.6, 1.8] },
      { type: 'mushrooms', count: 34, scale: [0.8, 1.4] },
      { type: 'ruinColumn', count: 14, scale: [0.8, 1.2] },
      { type: 'ruinArch', count: 5, scale: [0.9, 1.3] },
      { type: 'brokenWall', count: 8, scale: [0.8, 1.2] },
    ],
    lore: 'Wide, green, and quiet. It will not stay quiet.',
  },
  {
    id: 'mire', name: 'Sunken Mire',
    depth: 1,
    bosses: ['thornmaw', 'choir'],
    arenaRadius: 158,
    // Shallow terraced water: broad flat pans separated by low banks, draining
    // toward the middle. Almost nothing to hide behind, and what there is grows.
    landform: { amplitude: 3.6, scale: 56, detail: 0.3, ridged: 0.1, bowl: -3.4, terrace: 0.85 },
    sky: 0x5c6a58, fog: 0x6d7a62, fogNear: 52, fogFar: 340,
    hemiSky: 0xc8d8b0, hemiGround: 0x3a4230, hemiIntensity: 0.9,
    sunColor: 0xe8f0c0, sunIntensity: 1.28, sunDir: [-52, 68, 40],
    rimColor: 0x9fe07a, rimIntensity: 0.42,
    ground: 0x4d5c3e, groundAccent: 0x63744e, rock: 0x5a6250, structure: 0x7a8268,
    emissive: 0x9fe04b, particle: 0xc8e08a, particleCount: 300, particleDrift: [0.12, 0.08, 0.1],
    exposure: 1.0,
    palette: {
      grass: [0x5f8a46, 0x6f9a52, 0x4f7a3c, 0x7faa5e],
      foliage: [0x3f6a34, 0x4d7a40, 0x33592c],
      bark: [0x4a4030, 0x59503c],
      rock: [0x555f4a, 0x646e58, 0x474f3e],
      stone: [0x6f7a60, 0x7d886e, 0x616c54],
      crystal: [0x9fe04b, 0xc0f070],
      accentProps: [0xc8a05a, 0xb08a48],
    },
    terrain: {
      plateauSteps: 3, plateauRise: 0.5, plateauRadius: 15,
      pillars: [8, 12], pillarWidth: [2.0, 3.6], pillarHeight: [2.0, 5.0],
      decks: [4, 7], rubble: [16, 26], shards: 10,
    },
    particleOpacity: 0.34, beamOpacity: 0.07,
    props: [
      { type: 'grass', count: 2400, scale: [0.6, 1.15], wind: true },
      { type: 'reeds', count: 620, scale: [0.9, 1.9], wind: true },
      { type: 'fern', count: 300, scale: [0.7, 1.3], wind: true },
      { type: 'bush', count: 180, scale: [0.6, 1.2] },
      { type: 'deadTree', count: 60, scale: [0.9, 1.6] },
      { type: 'tree', count: 26, scale: [0.8, 1.2] },
      { type: 'mushrooms', count: 120, scale: [1.0, 2.0] },
      { type: 'rock', count: 70, scale: [0.5, 1.6] },
      { type: 'brokenWall', count: 10, scale: [0.8, 1.2] },
      { type: 'ruinColumn', count: 10, scale: [0.7, 1.1] },
    ],
    lore: 'Everything here is either water or waiting to be.',
  },
  {
    id: 'spire', name: 'Shattered Spires',
    depth: 3,
    bosses: ['fulgurant', 'harbinger'],
    arenaRadius: 168,
    // The most vertical ground in the game: tall narrow plates with real drops
    // between them. Height is cover, and also a commitment.
    landform: { amplitude: 11.0, scale: 66, detail: 0.34, ridged: 0.55, bowl: 1.0, terrace: 2.4 },
    sky: 0x3a4a70, fog: 0x4a5a80, fogNear: 62, fogFar: 400,
    hemiSky: 0xcfd8ff, hemiGround: 0x2e3448, hemiIntensity: 0.95,
    sunColor: 0xf0f0ff, sunIntensity: 1.7, sunDir: [56, 88, -40],
    rimColor: 0xb08aff, rimIntensity: 0.6,
    ground: 0x60688a, groundAccent: 0x7a82a4, rock: 0x555c7e, structure: 0x8a92b4,
    emissive: 0xb08aff, particle: 0xd8d0ff, particleCount: 280, particleDrift: [0.2, 0.3, 0.16],
    exposure: 1.06,
    palette: {
      grass: [0x76809c, 0x8690ac],
      foliage: [0x5a6488, 0x6a7498],
      bark: [0x4a4658, 0x585468],
      rock: [0x5a628a, 0x6a729a, 0x4a5278],
      stone: [0x8a92b4, 0x9aa2c4, 0x7a82a4],
      crystal: [0xb08aff, 0xd8b0ff],
      accentProps: [0x7fd8ff, 0xb08aff],
    },
    terrain: {
      plateauSteps: 4, plateauRise: 0.7, plateauRadius: 17,
      pillars: [22, 30], pillarWidth: [2.0, 4.2], pillarHeight: [6, 18],
      decks: [6, 10], rubble: [24, 36], shards: 34,
    },
    particleOpacity: 0.4, beamOpacity: 0.1,
    props: [
      { type: 'grass', count: 700, scale: [0.4, 0.8], wind: true },
      { type: 'crystal', count: 130, scale: [0.9, 2.6] },
      { type: 'rock', count: 130, scale: [0.6, 2.2] },
      { type: 'rockCluster', count: 50, scale: [0.8, 1.8] },
      { type: 'monolith', count: 22, scale: [1.0, 1.8] },
      { type: 'ruinColumn', count: 24, scale: [0.9, 1.5] },
      { type: 'ruinArch', count: 10, scale: [1.0, 1.5] },
    ],
    lore: 'Something broke here, upward, and then stopped.',
  },
  {
    id: 'ossuary', name: 'Ossuary Flats',
    depth: 4,
    bosses: ['choir', 'colossus'],
    arenaRadius: 172,
    // Almost flat, and deliberately: the widest sightlines in the game, so the
    // things walking toward you are visible for a very long time first.
    landform: { amplitude: 3.0, scale: 96, detail: 0.16, ridged: 0.2, bowl: 1.4, terrace: 0 },
    sky: 0xd8c8a8, fog: 0xcfbe9e, fogNear: 88, fogFar: 500,
    hemiSky: 0xfff0d8, hemiGround: 0x6a6048, hemiIntensity: 1.1,
    sunColor: 0xfff0cc, sunIntensity: 1.72, sunDir: [40, 96, 56],
    rimColor: 0xff9ac0, rimIntensity: 0.38,
    ground: 0xb0a184, groundAccent: 0xc4b69a, rock: 0xa1937a, structure: 0xcfc4ae,
    emissive: 0xff6a9a, particle: 0xf0e0c8, particleCount: 220, particleDrift: [0.4, 0.05, 0.3],
    exposure: 1.0,
    palette: {
      grass: [0xa89a7c, 0xb8aa8c],
      foliage: [0x8a8064, 0x9a9074],
      bark: [0x8a7c60, 0x9a8c70],
      rock: [0xa1937a, 0xb1a38a, 0x91836a],
      stone: [0xd8cdb6, 0xe4d9c2, 0xccc1aa],
      crystal: [0xff6a9a, 0xffa0c0],
      accentProps: [0xff6a9a, 0xd8a0b0],
    },
    terrain: {
      plateauSteps: 2, plateauRise: 0.55, plateauRadius: 18,
      pillars: [14, 20], pillarWidth: [2.4, 5.0], pillarHeight: [3, 9],
      decks: [3, 6], rubble: [30, 46], shards: 18,
    },
    particleOpacity: 0.3, beamOpacity: 0.06,
    props: [
      { type: 'grass', count: 900, scale: [0.4, 0.9], wind: true },
      { type: 'deadTree', count: 70, scale: [0.9, 1.7] },
      { type: 'rock', count: 150, scale: [0.5, 2.0] },
      { type: 'rockCluster', count: 60, scale: [0.7, 1.6] },
      { type: 'ruinArch', count: 16, scale: [1.1, 1.9] },
      { type: 'ruinColumn', count: 20, scale: [0.8, 1.3] },
      { type: 'monolith', count: 12, scale: [0.9, 1.4] },
      { type: 'brokenWall', count: 16, scale: [0.9, 1.4] },
    ],
    lore: 'Wide, bright, and made almost entirely of what used to walk on it.',
  },
  {
    id: 'tidal', name: 'Tidal Shelf',
    depth: 2,
    bosses: ['leviathan', 'choir'],
    arenaRadius: 162,
    // Terraced: flat wet shelves with about a metre of drop between them,
    // falling away toward the water. Cover here is the ground itself.
    landform: { amplitude: 4.6, scale: 64, detail: 0.2, ridged: 0.15, bowl: -4.0, terrace: 1.15 },
    sky: 0x6f9fc0, fog: 0x7fa8bf, fogNear: 84, fogFar: 490,
    hemiSky: 0xcfeaff, hemiGround: 0x3f5a60, hemiIntensity: 0.95,
    sunColor: 0xf0f6ff, sunIntensity: 1.75, sunDir: [-46, 84, 52],
    rimColor: 0x6fd0ff, rimIntensity: 0.5,
    ground: 0x5d7f80, groundAccent: 0x729597, rock: 0x6f8288, structure: 0x93a5a8,
    emissive: 0x6fe0ff, particle: 0xd8f4ff, particleCount: 240, particleDrift: [0.3, 0.22, 0.14],
    exposure: 1.03,
    palette: {
      grass: [0x6f9e78, 0x7fae86, 0x5d8c68],
      foliage: [0x3f7a6a, 0x4d8a76, 0x35695c],
      bark: [0x5f5a52, 0x6e6960],
      rock: [0x5f7076, 0x6d7e84, 0x536369],
      stone: [0x7e9094, 0x8a9ca0, 0x718386],
      crystal: [0x6fe0ff, 0x9ff0ff],
      accentProps: [0xe0c078, 0xd8b068],
    },
    terrain: {
      plateauSteps: 3, plateauRise: 0.6, plateauRadius: 15,
      pillars: [9, 13], pillarWidth: [2.2, 4.4], pillarHeight: [2.5, 7.5],
      decks: [3, 5], rubble: [20, 30], shards: 12,
    },
    particleOpacity: 0.34, beamOpacity: 0.08,
    props: [
      { type: 'grass', count: 1700, scale: [0.5, 0.95], wind: true },
      { type: 'reeds', count: 220, scale: [0.8, 1.5], wind: true },
      { type: 'bush', count: 60, scale: [0.5, 0.9] },
      { type: 'rockCluster', count: 60, scale: [0.8, 2.0] },
      { type: 'rock', count: 110, scale: [0.6, 2.2] },
      { type: 'crystal', count: 26, scale: [0.7, 1.4] },
      { type: 'ruinColumn', count: 18, scale: [0.8, 1.3] },
      { type: 'brokenWall', count: 10, scale: [0.9, 1.3] },
      { type: 'monolith', count: 6, scale: [0.8, 1.2] },
    ],
    lore: 'A shelf of wet stone over an ocean nobody has measured.',
  },
  {
    id: 'frozen', name: 'Frozen Shelf',
    depth: 3,
    bosses: ['fulgurant', 'leviathan'],
    arenaRadius: 170,
    // The biggest, smoothest relief in the game: long drifts you run over
    // rather than around, walled in by a high rim.
    landform: { amplitude: 8.6, scale: 108, detail: 0.13, ridged: 0, bowl: 6.2, terrace: 0 },
    sky: 0x2a3c52, fog: 0x3c5068, fogNear: 78, fogFar: 470,
    hemiSky: 0xcfe6ff, hemiGround: 0x2a3444, hemiIntensity: 0.85,
    sunColor: 0xe4f0ff, sunIntensity: 1.6, sunDir: [40, 80, -46],
    rimColor: 0x6fd0ff, rimIntensity: 0.55,
    ground: 0x6b7f96, groundAccent: 0x8398ae, rock: 0x5c7086, structure: 0x93a8c0,
    emissive: 0x9fe0ff, particle: 0xe8f6ff, particleCount: 360, particleDrift: [0.34, -0.6, 0.18],
    exposure: 1.08,
    palette: {
      grass: [0x8fa4b4, 0x9fb4c4],
      foliage: [0x5c7a86, 0x6b8a96, 0x4d6a76],
      bark: [0x4a4640, 0x59554e],
      rock: [0x6d8296, 0x7d92a6, 0x5d7286],
      stone: [0xa8bccc, 0xb8ccdc, 0x98acbc],
      crystal: [0x9fe0ff, 0xcaf0ff],
      accentProps: [0xd8e8f4, 0xc0d8ea],
    },
    terrain: {
      plateauSteps: 4, plateauRise: 0.62, plateauRadius: 16,
      pillars: [12, 17], pillarWidth: [2.4, 5.0], pillarHeight: [3, 9.5],
      decks: [3, 6], rubble: [24, 34], shards: 20,
    },
    particleOpacity: 0.42, beamOpacity: 0.10,
    props: [
      { type: 'grass', count: 900, scale: [0.45, 0.85], wind: true },
      { type: 'conifer', count: 44, scale: [0.85, 1.4] },
      { type: 'deadTree', count: 26, scale: [0.8, 1.3] },
      { type: 'rockCluster', count: 55, scale: [0.8, 2.2] },
      { type: 'rock', count: 120, scale: [0.6, 2.4] },
      { type: 'crystal', count: 46, scale: [0.8, 1.8] },
      { type: 'monolith', count: 10, scale: [0.9, 1.4] },
      { type: 'brokenWall', count: 8, scale: [0.9, 1.2] },
    ],
    lore: 'Ice over an ocean nobody has ever measured.',
  },
  {
    id: 'ashfall', name: 'Ashfall Basin',
    depth: 4,
    bosses: ['colossus', 'thornmaw'],
    arenaRadius: 155,
    // Named a basin, so it is one: the ground falls away from the middle into a
    // ring of ash, with hardened crests breaking the surface.
    landform: { amplitude: 6.4, scale: 60, detail: 0.36, ridged: 0.5, bowl: -5.4, terrace: 0 },
    sky: 0x2a1f26, fog: 0x3a2a2a, fogNear: 64, fogFar: 420,
    hemiSky: 0xffc9a0, hemiGround: 0x3a2418, hemiIntensity: 0.8,
    sunColor: 0xffc27a, sunIntensity: 1.75, sunDir: [50, 74, 30],
    rimColor: 0xff6a4a, rimIntensity: 0.45,
    ground: 0x574038, groundAccent: 0x77594e, rock: 0x634c41, structure: 0x8a7062,
    emissive: 0xff7a3a, particle: 0xff9a5a, particleCount: 230, particleDrift: [0.0, 0.55, 0.0],
    exposure: 1.06,
    palette: {
      grass: [0x7a6a4a, 0x8a7a56],
      foliage: [0x6a5238, 0x7a6244, 0x5a4630],
      bark: [0x3e3028, 0x4c3c32],
      rock: [0x6b5245, 0x7b6255, 0x5b4235],
      stone: [0x94806e, 0xa4907e, 0x847060],
      crystal: [0xff9a5a, 0xffb87a],
      accentProps: [0xff7a3a, 0xe06a2a],
    },
    terrain: {
      pillars: [16, 22], pillarWidth: [2.4, 5.2], pillarHeight: [4, 13],
      decks: [4, 7], rubble: [28, 42], shards: 26,
    },
    props: [
      { type: 'grass', count: 560, scale: [0.45, 0.8], wind: true },
      { type: 'deadTree', count: 54, scale: [0.8, 1.4] },
      { type: 'rockCluster', count: 60, scale: [0.8, 2.0] },
      { type: 'rock', count: 130, scale: [0.6, 2.2] },
      { type: 'crystal', count: 30, scale: [0.7, 1.5] },
      { type: 'ruinColumn', count: 22, scale: [0.8, 1.4] },
      { type: 'ruinArch', count: 7, scale: [0.9, 1.4] },
      { type: 'brokenWall', count: 12, scale: [0.9, 1.4] },
      { type: 'monolith', count: 8, scale: [0.9, 1.3] },
    ],
    lore: 'Cinders from something that burned for a very long time.',
  },
  {
    id: 'void', name: 'Void Terrace',
    depth: 5,
    bosses: ['harbinger', 'fulgurant'],
    arenaRadius: 176,
    // Terraces, as advertised — wide plates at a metre and three quarters,
    // the tallest steps in the game, walled in at the edge.
    landform: { amplitude: 9.4, scale: 78, detail: 0.28, ridged: 0.35, bowl: 2.0, terrace: 1.7 },
    sky: 0x140c22, fog: 0x22143a, fogNear: 58, fogFar: 410,
    hemiSky: 0xc4a0ff, hemiGround: 0x1a1030, hemiIntensity: 0.7,
    sunColor: 0xd0a8ff, sunIntensity: 1.45, sunDir: [-48, 70, -38],
    rimColor: 0xd94bff, rimIntensity: 0.65,
    ground: 0x3a2c54, groundAccent: 0x4c3c6c, rock: 0x42326a, structure: 0x6a5494,
    emissive: 0xd94bff, particle: 0xd08aff, particleCount: 310, particleDrift: [0.0, 0.42, 0.0],
    exposure: 1.12,
    palette: {
      grass: [0x6a4c8a, 0x7a5c9a],
      foliage: [0x5a3c7a, 0x6a4c8a, 0x4a2c6a],
      bark: [0x35284a, 0x453858],
      rock: [0x4a3a72, 0x5a4a82, 0x3a2a62],
      stone: [0x7c68a4, 0x8c78b4, 0x6c5894],
      crystal: [0xd94bff, 0xe88aff],
      accentProps: [0xff6ad0, 0xd94bff],
    },
    terrain: {
      pillars: [18, 24], pillarWidth: [2.6, 5.6], pillarHeight: [4, 14],
      decks: [5, 8], rubble: [30, 44], shards: 34,
    },
    props: [
      { type: 'grass', count: 700, scale: [0.45, 0.85], wind: true },
      { type: 'deadTree', count: 34, scale: [0.8, 1.4] },
      { type: 'crystal', count: 90, scale: [0.8, 2.2] },
      { type: 'rockCluster', count: 44, scale: [0.8, 1.8] },
      { type: 'rock', count: 90, scale: [0.6, 2.0] },
      { type: 'monolith', count: 18, scale: [0.9, 1.6] },
      { type: 'ruinArch', count: 9, scale: [1.0, 1.5] },
      { type: 'ruinColumn', count: 16, scale: [0.9, 1.4] },
    ],
    lore: 'Terraces that were not built so much as agreed upon.',
  },
  {
    id: 'ember', name: 'Ember Depths',
    depth: 5,
    bosses: ['colossus', 'harbinger'],
    arenaRadius: 166,
    // The worst footing of the descent: short-wavelength ridging, deep clefts,
    // and nowhere flat enough to hold a line for long.
    landform: { amplitude: 8.6, scale: 52, detail: 0.56, ridged: 0.85, bowl: -2.8, terrace: 0 },
    sky: 0x1a0c0a, fog: 0x36160f, fogNear: 56, fogFar: 390,
    hemiSky: 0xff9a6a, hemiGround: 0x2e1008, hemiIntensity: 0.9,
    sunColor: 0xff8a4a, sunIntensity: 2.0, sunDir: [32, 64, 52],
    rimColor: 0xff3a2a, rimIntensity: 0.75,
    ground: 0x4a2c24, groundAccent: 0x6e3a2c, rock: 0x543028, structure: 0x8a5044,
    emissive: 0xff5a2a, particle: 0xff7a3a, particleCount: 300, particleDrift: [0.1, 0.9, 0.0],
    exposure: 1.02,
    palette: {
      grass: [0x7a4a32, 0x8a5a3a],
      foliage: [0x6a3a22, 0x7a4a2e],
      bark: [0x3a2018, 0x4a2c20],
      rock: [0x5e352a, 0x6e453a, 0x4e2a20],
      stone: [0x96625a, 0xa6726a, 0x86524a],
      crystal: [0xff5a2a, 0xff8a4a],
      accentProps: [0xffb04a, 0xff8a2a],
    },
    terrain: {
      pillars: [20, 26], pillarWidth: [2.6, 5.8], pillarHeight: [5, 15],
      decks: [4, 7], rubble: [32, 46], shards: 30,
    },
    props: [
      { type: 'deadTree', count: 40, scale: [0.7, 1.2] },
      { type: 'rockCluster', count: 70, scale: [0.9, 2.4] },
      { type: 'rock', count: 150, scale: [0.7, 2.6] },
      { type: 'crystal', count: 60, scale: [0.8, 2.0] },
      { type: 'monolith', count: 14, scale: [0.9, 1.5] },
      { type: 'ruinColumn', count: 20, scale: [0.8, 1.3] },
      { type: 'brokenWall', count: 14, scale: [0.9, 1.4] },
    ],
    lore: 'Deep enough that the rock is still deciding whether to be liquid.',
  },
];

/**
 * The Null Sanctum — where the optional final fight happens.
 *
 * Not part of the descent rotation; you only ever see it by choosing to step
 * through the rift. Deliberately bare: a small, dark, close arena with almost
 * nothing to hide behind, because the whole point of the fight is that there is
 * nowhere to be except in it.
 */
export const FINAL_THEME = {
  id: 'sanctum', name: 'The Null Sanctum',
  arenaRadius: 86,
  // Almost flat, and deliberately so. The whole design of the fight is that
  // there is nowhere to be except in it, and a hill is somewhere to be.
  landform: { amplitude: 2.0, scale: 40, detail: 0.5, ridged: 0.6, bowl: 1.0, terrace: 0 },
  sky: 0x05030a, fog: 0x0a0616, fogNear: 30, fogFar: 220,
  hemiSky: 0x3a2a6a, hemiGround: 0x120a20, hemiIntensity: 0.55,
  sunColor: 0xb07aff, sunIntensity: 0.85, sunDir: [30, 90, -40],
  rimColor: 0xff2f8f, rimIntensity: 0.9,
  ground: 0x191024, groundAccent: 0x241634, rock: 0x241a34, structure: 0x2c1e40,
  emissive: 0xd94bff, particle: 0xd9a0ff, particleCount: 320, particleDrift: [0.1, 0.3, 0.1],
  exposure: 1.16,
  palette: {
    grass: [0x2a1d3c, 0x352447],
    foliage: [0x3a2456, 0x452c66],
    bark: [0x1e1428, 0x2a1c38],
    rock: [0x271b39, 0x312244],
    stone: [0x33254a, 0x3d2c56],
    crystal: [0xd94bff, 0xff2f8f, 0x8f5bff],
    accentProps: [0xff2f8f, 0xd94bff],
  },
  terrain: {
    plateauSteps: 2, plateauRise: 0.5, plateauRadius: 13,
    pillars: [8, 11], pillarWidth: [2.6, 4.2], pillarHeight: [4, 9],
    decks: [0, 0], rubble: [6, 10], shards: 14,
  },
  particleOpacity: 0.5, beamOpacity: 0.14,
  props: [
    { type: 'crystal', count: 70, scale: [0.9, 2.2] },
    { type: 'rock', count: 40, scale: [0.6, 1.6] },
    { type: 'rockCluster', count: 12, scale: [0.7, 1.4] },
    { type: 'monolith', count: 9, scale: [0.9, 1.5] },
  ],
  lore: 'Nothing grows here. Something is still awake.',
};

export const THEMES_BY_ID = Object.fromEntries(THEMES.map((t) => [t.id, t]));

/**
 * Which arena a stage is.
 *
 * It used to be `THEMES[(stage - 1) % THEMES.length]` — a fixed rotation, so
 * every run was the same six places in the same order and by the third run you
 * knew what stage four looked like before you got there. Now it is drawn at
 * random from the themes deep enough to appear, which is most of what makes one
 * descent different from the next.
 *
 * A theme is only eligible once you are deep enough for it, and drops out again
 * once you are well past it, so the descent still darkens even though the order
 * is not fixed. Stage one draws from the two calm green themes — the opening
 * minutes are the tutorial, and they should look like one.
 *
 * The *host* draws, and sends the result in the stage packet, so this is only
 * ever called on the machine that owns the world. Deriving it from the stage
 * seed instead would have been reproducible right up until somebody joined a
 * run in progress, at which point their idea of "the previous stage" and the
 * host's would differ and the party would be standing in two different places.
 */
export function themeForStage(stage, rng = null, avoidId = null) {
  if (!rng) return THEMES[(stage - 1) % THEMES.length];

  let pool = THEMES.filter((t) => {
    const depth = t.depth ?? 1;
    if (depth > stage) return false;
    // Shallow themes stop appearing once you are well past them, so the
    // descent still darkens even though the order is not fixed.
    return depth >= stage - 4;
  });
  // Never the same place twice in a row. With a pool of three or four that
  // happens about a quarter of the time otherwise, and back-to-back identical
  // stages are the one thing that makes a random order feel *less* varied than
  // a fixed one.
  if (avoidId && pool.length > 1) {
    const trimmed = pool.filter((t) => t.id !== avoidId);
    if (trimmed.length) pool = trimmed;
  }
  if (!pool.length) pool = THEMES;
  return pool[Math.floor(rng.next() * pool.length)];
}

/** The bosses a stage can call. Falls back to the whole roster. */
export function bossesForTheme(theme) {
  return theme?.bosses?.length ? theme.bosses : null;
}

/** The sanctum is reached by choice, never by descending. */
export function finalTheme() { return FINAL_THEME; }
