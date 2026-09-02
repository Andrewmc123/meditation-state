/**
 * One world unit = 1000 km.
 *
 * That choice keeps the whole solar system inside float32 range while leaving
 * planetary surfaces at a sane size: Earth comes out 6.371 units across, and
 * Neptune's orbit lands at 4.5 million. Combined with a logarithmic depth
 * buffer this renders from a metre to thirty AU without z-fighting.
 */
export const KM = 0.001;              // km -> units
export const AU = 149597870.7 * KM;   // 149597.87 units
export const UNIT_KM = 1000;

export const SUN_RADIUS = 696340 * KM;

/**
 * JPL Keplerian elements, epoch J2000, valid 1800-2050.
 *   a  semi-major axis (AU)        e  eccentricity
 *   i  inclination (deg)           O  longitude of ascending node (deg)
 *   w  longitude of perihelion (deg)
 *   L  mean longitude at J2000 (deg)
 *   dL degrees per century (mean motion)
 * Physical:
 *   r  mean radius (km)   rot  sidereal rotation (hours, negative = retrograde)
 *   tilt  axial tilt (deg)
 */
export const PLANETS = [
  {
    key: 'mercury', name: 'Mercury',
    a: 0.38709927, e: 0.20563593, i: 7.00497902, O: 48.33076593, w: 77.45779628,
    L: 252.25032350, dL: 149472.67411175,
    r: 2439.7, rot: 1407.6, tilt: 0.034,
    tex: { map: 'mercury' },
    blurb: 'No atmosphere. A day here lasts two of its years.',
  },
  {
    key: 'venus', name: 'Venus',
    a: 0.72333566, e: 0.00677672, i: 3.39467605, O: 76.67984255, w: 131.60246718,
    L: 181.97909950, dL: 58517.81538729,
    r: 6051.8, rot: -5832.5, tilt: 177.36,
    tex: { map: 'venus_surface', clouds: 'venus_atmosphere' },
    cloudSpeed: 0.00012, cloudOpacity: 0.95,
    blurb: 'Rotates backwards. Surface pressure of 900 metres of ocean.',
  },
  {
    key: 'earth', name: 'Earth',
    a: 1.00000261, e: 0.01671123, i: -0.00001531, O: 0.0, w: 102.93768193,
    L: 100.46457166, dL: 35999.37244981,
    r: 6371.0, rot: 23.9345, tilt: 23.44,
    tex: { map: 'earth_daymap', night: 'earth_nightmap', clouds: 'earth_clouds', normal: 'earth_normal_map', spec: 'earth_specular_map' },
    cloudSpeed: 0.000022, cloudOpacity: 0.62,
    atmosphere: { color: 0x5a9fdb, power: 2.4, strength: 1.15 },
    moons: [{
      key: 'moon', name: 'The Moon', r: 1737.4, dist: 384399, period: 655.7, tilt: 6.68,
      tex: { map: 'moon' },
      blurb: 'Tidally locked. The same face, always.',
    }],
    blurb: 'The only place the practice was invented.',
  },
  {
    key: 'mars', name: 'Mars',
    a: 1.52371034, e: 0.09339410, i: 1.84969142, O: 49.55953891, w: -23.94362959,
    L: -4.55343205, dL: 19140.30268499,
    r: 3389.5, rot: 24.6229, tilt: 25.19,
    tex: { map: 'mars' },
    atmosphere: { color: 0xd98a5a, power: 3.2, strength: 0.4 },
    blurb: 'A day 39 minutes longer than yours.',
  },
  {
    key: 'jupiter', name: 'Jupiter',
    a: 5.20288700, e: 0.04838624, i: 1.30439695, O: 100.47390909, w: 14.72847983,
    L: 34.39644051, dL: 3034.74612775,
    r: 69911, rot: 9.925, tilt: 3.13,
    tex: { map: 'jupiter' },
    atmosphere: { color: 0xd8b48c, power: 3.0, strength: 0.5 },
    blurb: 'Turns once every ten hours. The storm is older than telescopes.',
  },
  {
    key: 'saturn', name: 'Saturn',
    a: 9.53667594, e: 0.05386179, i: 2.48599187, O: 113.66242448, w: 92.59887831,
    L: 49.95424423, dL: 1222.49362201,
    r: 58232, rot: 10.656, tilt: 26.73,
    tex: { map: 'saturn', ring: 'saturn_ring_alpha' },
    // D-ring inner edge to F-ring, in km from Saturn's centre.
    ring: { inner: 74500, outer: 140220 },
    blurb: 'The rings are twenty metres thick and two hundred thousand km wide.',
  },
  {
    key: 'uranus', name: 'Uranus',
    a: 19.18916464, e: 0.04725744, i: 0.77263783, O: 74.01692503, w: 170.95427630,
    L: 313.23810451, dL: 428.48202785,
    r: 25362, rot: -17.24, tilt: 97.77,
    tex: { map: 'uranus' },
    ring: { inner: 41837, outer: 51149, faint: true },
    atmosphere: { color: 0x9fd8e0, power: 2.8, strength: 0.7 },
    blurb: 'Tipped on its side. Each pole gets 42 years of sunlight.',
  },
  {
    key: 'neptune', name: 'Neptune',
    a: 30.06992276, e: 0.00859048, i: 1.77004347, O: 131.78422574, w: 44.96476227,
    L: -55.12002969, dL: 218.45945325,
    r: 24622, rot: 16.11, tilt: 28.32,
    tex: { map: 'neptune' },
    atmosphere: { color: 0x4a72c4, power: 2.8, strength: 0.85 },
    blurb: 'Winds of 2,100 km/h. The fastest in the solar system.',
  },
];

/** Dwarf planets, placed on simplified circular orbits. */
export const DWARFS = [
  { key: 'ceres', name: 'Ceres', a: 2.7691, r: 473, tex: 'ceres_fictional', period: 1681, blurb: 'A third of the asteroid belt, by mass.' },
  { key: 'haumea', name: 'Haumea', a: 43.13, r: 780, tex: 'haumea_fictional', period: 103410, blurb: 'Spins so fast it is stretched into an egg.' },
  { key: 'makemake', name: 'Makemake', a: 45.79, r: 715, tex: 'makemake_fictional', period: 113183, blurb: 'Named for the creator god of Rapa Nui.' },
  { key: 'eris', name: 'Eris', a: 67.78, r: 1163, tex: 'eris_fictional', period: 203830, blurb: 'Finding it is what cost Pluto its title.' },
];

export const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);
