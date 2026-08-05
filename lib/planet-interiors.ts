// Measured/modelled interior structure of every planet, used by the 3D
// cutaway (components/PlanetCutaway.tsx) and the cross-section panel
// (components/PlanetInteriorPanel.tsx).
//
// Boundary radii are REAL, in kilometres from the planet's centre, taken from
// seismology where it exists and from published interior models where it does
// not. Nothing here is invented for looks: layers whose depth is a model
// estimate rather than a measurement carry `estimated: true`, and the panel
// says so. Temperatures are kelvin, pressures gigapascals.
//
// Principal sources, per body:
//  Mercury  MESSENGER gravity + libration (Hauck 2013; Genova 2019; Sori 2018)
//  Venus    Magellan gravity + thermal-evolution models (Dumoulin 2017)
//  Earth    PREM seismic reference model (Dziewonski & Anderson 1981)
//  Mars     InSight seismology (Stähler 2021; Khan 2023; Samuel 2023)
//  Jupiter  Juno gravity harmonics — dilute core (Wahl 2017; Militzer 2022)
//  Saturn   Cassini Grand Finale gravity + ring seismology (Mankovich 2021)
//  Uranus   Voyager 2 gravity + ice-giant interior models (Nettelmann 2013)
//  Neptune  Voyager 2 gravity + ice-giant interior models (Nettelmann 2013)

export type LayerState = 'solid' | 'liquid' | 'supercritical' | 'gas';

/** Which procedural material the cutaway paints this layer with. */
export type LayerTexture = 'rock' | 'metal' | 'molten' | 'ice' | 'fluid' | 'gas';

export interface InteriorLayer {
  name: string;
  /** Outer boundary, km from the planet's centre. */
  outerKm: number;
  color: string;
  state: LayerState;
  texture: LayerTexture;
  composition: string;
  /** Temperature range across the layer, kelvin (inner → outer). */
  tempK: [number, number];
  /** Pressure range across the layer, GPa (inner → outer). */
  pressureGPa: [number, number];
  /** Self-luminous fraction — iron cores really are incandescent. */
  emissive?: number;
  /** Boundary depth is a model estimate, not a measurement. */
  estimated?: boolean;
  note: string;
}

export interface PlanetInterior {
  planet: string;
  radiusKm: number;
  source: string;
  /** Innermost first. The last layer's outerKm is the planet's radius. */
  layers: InteriorLayer[];
}

export const PLANET_INTERIORS: PlanetInterior[] = [
  // -------------------------------------------------------------------------
  // MERCURY — the most metallic planet: its core is ~85% of the radius, which
  // is why it has a magnetic field at all despite being barely bigger than
  // the Moon. MESSENGER's libration measurement proved the outer core is
  // liquid; the solid inner core radius is a model result, not a measurement.
  // -------------------------------------------------------------------------
  {
    planet: 'Mercury', radiusKm: 2440,
    source: 'MESSENGER gravity & libration (Hauck 2013, Genova 2019); crust thickness Sori 2018',
    layers: [
      {
        name: 'Solid inner core', outerKm: 1000, color: '#ffd9a0',
        state: 'solid', texture: 'metal', emissive: 0.5, estimated: true,
        composition: 'Crystallised iron with dissolved sulfur & silicon',
        tempK: [2000, 1900], pressureGPa: [40, 30],
        note: 'Still freezing out of the liquid core today — the release of latent heat is one candidate power source for Mercury’s weak magnetic field.',
      },
      {
        name: 'Liquid outer core', outerKm: 2020, color: '#ff9f3a',
        state: 'liquid', texture: 'molten', emissive: 0.35,
        composition: 'Molten Fe–S alloy',
        tempK: [1900, 1700], pressureGPa: [30, 7],
        note: 'MESSENGER’s libration measurement confirmed a molten shell here: Mercury wobbles as if its mantle were decoupled from the core. It generates a field only ~1% of Earth’s.',
      },
      {
        name: 'Silicate mantle', outerKm: 2405, color: '#7a6a5c',
        state: 'solid', texture: 'rock',
        composition: 'Magnesium-rich, iron-poor silicates (enstatite)',
        tempK: [1700, 800], pressureGPa: [7, 0.5],
        note: 'Unusually thin — only ~400 km — and remarkably iron-poor, evidence Mercury formed in a chemically reducing part of the disk or lost its outer rock in a giant impact.',
      },
      {
        name: 'Crust', outerKm: 2440, color: '#9c9488',
        state: 'solid', texture: 'rock', estimated: true,
        composition: 'Graphite-bearing basaltic & komatiitic rock',
        tempK: [800, 100], pressureGPa: [0.5, 0],
        note: 'Averages ~26 km. Global compressive ridges show the whole planet shrank by up to 7 km in radius as it cooled — the only planet visibly wrinkled by contraction.',
      },
    ],
  },

  // -------------------------------------------------------------------------
  // VENUS — Earth's near-twin by mass, with no magnetic field. All interior
  // boundaries are model estimates: there has never been a seismometer on
  // Venus, so nothing here comes from seismology.
  // -------------------------------------------------------------------------
  {
    planet: 'Venus', radiusKm: 6052,
    source: 'Magellan/PVO gravity + tidal & thermal-evolution models (Dumoulin 2017, Aitta 2012)',
    layers: [
      {
        name: 'Inner core (uncertain)', outerKm: 1200, color: '#ffe0b0',
        state: 'solid', texture: 'metal', emissive: 0.45, estimated: true,
        composition: 'Iron–nickel, possibly still entirely liquid',
        tempK: [5200, 5000], pressureGPa: [280, 250],
        note: 'It is genuinely unknown whether Venus has frozen an inner core at all. Its absence of a magnetic field suggests the core is not convecting — either fully molten and stagnant, or fully solid.',
      },
      {
        name: 'Outer core', outerKm: 3200, color: '#ff8c2a',
        state: 'liquid', texture: 'molten', emissive: 0.3, estimated: true,
        composition: 'Molten iron–nickel with light elements',
        tempK: [5000, 4200], pressureGPa: [250, 120],
        note: 'Tidal-response measurements from Magellan gravity favour a liquid core. But without a temperature gradient steep enough to drive convection, there is no dynamo — Venus has essentially no intrinsic magnetic field.',
      },
      {
        name: 'Lower mantle', outerKm: 5100, color: '#6b4a34',
        state: 'solid', texture: 'rock', estimated: true,
        composition: 'Bridgmanite-dominated silicate perovskite',
        tempK: [4200, 2000], pressureGPa: [120, 25],
        note: 'Convecting, but without plate tectonics to vent heat. Venus appears to shed heat in global resurfacing episodes instead — its entire surface is under 1 billion years old.',
      },
      {
        name: 'Upper mantle', outerKm: 6002, color: '#8a5f3c',
        state: 'solid', texture: 'rock', estimated: true,
        composition: 'Olivine & pyroxene peridotite',
        tempK: [2000, 1200], pressureGPa: [25, 1],
        note: 'Feeds over 1,600 volcanic features. Magellan and re-analysed VIRTIS data show at least some of them — Maat Mons among them — erupted within the last few decades.',
      },
      {
        name: 'Crust', outerKm: 6052, color: '#e3bb76',
        state: 'solid', texture: 'rock', estimated: true,
        composition: 'Basalt, dry and therefore stiff',
        tempK: [1200, 737], pressureGPa: [1, 0.009],
        note: 'Roughly 20–50 km thick and welded into one unbroken plate. With no water to lubricate faults it cannot subduct, which is why Venus has volcanoes but no plate tectonics.',
      },
    ],
  },

  // -------------------------------------------------------------------------
  // EARTH — the only planet whose interior is measured directly, layer by
  // layer, by seismic waves. Radii are PREM discontinuities.
  // -------------------------------------------------------------------------
  {
    planet: 'Earth', radiusKm: 6371,
    source: 'PREM seismic reference model (Dziewonski & Anderson 1981); geotherm from Anzellini 2013',
    layers: [
      {
        name: 'Inner core', outerKm: 1221, color: '#fff0c8',
        state: 'solid', texture: 'metal', emissive: 0.6,
        composition: 'Crystalline iron–nickel (hexagonal close-packed)',
        tempK: [5700, 5400], pressureGPa: [364, 329],
        note: 'As hot as the Sun’s surface, yet solid — 360 GPa of pressure forces iron to crystallise. It grows about 1 mm a year, and the latent heat released is what powers the geodynamo.',
      },
      {
        name: 'Outer core', outerKm: 3480, color: '#ff8a1e',
        state: 'liquid', texture: 'molten', emissive: 0.4,
        composition: 'Liquid iron–nickel with ~10% light elements (O, S, Si)',
        tempK: [5400, 4000], pressureGPa: [329, 136],
        note: 'A 2,260 km deep ocean of liquid metal moving at a few mm/s. Its convection generates the magnetic field that deflects the solar wind — the reason Earth kept its atmosphere and Mars did not.',
      },
      {
        name: 'Lower mantle', outerKm: 5711, color: '#7a3f2a',
        state: 'solid', texture: 'rock',
        composition: 'Bridgmanite & ferropericlase',
        tempK: [4000, 2000], pressureGPa: [136, 24],
        note: 'Solid rock that nonetheless flows, at centimetres per year. Slabs of old seafloor sink through it all the way to the core–mantle boundary, where they pile up as seismically visible graveyards.',
      },
      {
        name: 'Transition zone', outerKm: 6001, color: '#8f5433',
        state: 'solid', texture: 'rock',
        composition: 'Wadsleyite & ringwoodite (high-pressure olivine)',
        tempK: [2000, 1700], pressureGPa: [24, 14],
        note: 'Between the 410 km and 660 km seismic discontinuities. Ringwoodite here can hold water in its crystal structure — this zone may store more water than all the surface oceans combined.',
      },
      {
        name: 'Upper mantle', outerKm: 6336, color: '#a86a3d',
        state: 'solid', texture: 'rock',
        composition: 'Olivine–pyroxene peridotite; partially molten asthenosphere',
        tempK: [1700, 900], pressureGPa: [14, 1],
        note: 'Contains the asthenosphere, a weak partially-molten layer the tectonic plates slide on. Everything plate tectonics does begins here.',
      },
      {
        name: 'Crust', outerKm: 6371, color: '#3f7f4f',
        state: 'solid', texture: 'rock',
        composition: 'Granitic continents (~35 km) & basaltic ocean floor (~7 km)',
        tempK: [900, 288], pressureGPa: [1, 0],
        note: 'Proportionally thinner than an apple skin — under 0.5% of the radius. It is broken into moving plates, a configuration no other known planet has today.',
      },
    ],
  },

  // -------------------------------------------------------------------------
  // MARS — interior measured for real by InSight's seismometer (2018–2022):
  // the first direct core radius for any planet other than Earth.
  // -------------------------------------------------------------------------
  {
    planet: 'Mars', radiusKm: 3390,
    source: 'InSight seismology: Stähler 2021 (core radius), Khan 2023 (molten layer), Samuel 2023',
    layers: [
      {
        name: 'Liquid core', outerKm: 1830, color: '#ff9a3c',
        state: 'liquid', texture: 'molten', emissive: 0.35,
        composition: 'Iron–sulfur alloy, unusually sulfur-rich (~15–20% S)',
        tempK: [2000, 1900], pressureGPa: [45, 20],
        note: 'InSight timed seismic waves reflecting off this boundary and fixed the radius at 1,830 ± 40 km — over half the planet’s radius. Sulfur keeps it liquid at temperatures where pure iron would freeze.',
      },
      {
        name: 'Molten silicate layer', outerKm: 1980, color: '#c4472a',
        state: 'liquid', texture: 'molten', emissive: 0.15, estimated: true,
        composition: 'Partially molten silicate melt layer',
        tempK: [1900, 1850], pressureGPa: [20, 18],
        note: 'A 2023 re-analysis of InSight data found a ~150 km layer of molten rock sitting on the core. It insulates the core, which may be why Mars’s dynamo shut down 4 billion years ago.',
      },
      {
        name: 'Lower mantle', outerKm: 2890, color: '#6e3320',
        state: 'solid', texture: 'rock',
        composition: 'Iron-rich olivine & majorite garnet',
        tempK: [1850, 1600], pressureGPa: [18, 8],
        note: 'Mars is too small to reach the pressures that make Earth’s bridgmanite, so it has no lower mantle in Earth’s sense — the mineralogy stays comparatively simple all the way down.',
      },
      {
        name: 'Upper mantle', outerKm: 3340, color: '#9c4426',
        state: 'solid', texture: 'rock',
        composition: 'Iron-rich peridotite',
        tempK: [1600, 800], pressureGPa: [8, 0.5],
        note: 'The reservoir that built Olympus Mons — 22 km tall, the largest volcano in the Solar System. With no plate motion, a single hotspot piled lava in one place for billions of years.',
      },
      {
        name: 'Crust', outerKm: 3390, color: '#c1440e',
        state: 'solid', texture: 'rock',
        composition: 'Basalt, heavily fractured, iron-oxide rich',
        tempK: [800, 210], pressureGPa: [0.5, 0],
        note: 'InSight measured 24–72 km — two to three times thicker than Earth’s relative to planet size. The northern lowlands and southern highlands differ by kilometres, a hemispheric split still unexplained.',
      },
    ],
  },

  // -------------------------------------------------------------------------
  // JUPITER — no surface, and after Juno, no clean core boundary either: the
  // gravity harmonics only fit if the heavy elements are smeared through the
  // inner half of the planet ("dilute core").
  // -------------------------------------------------------------------------
  {
    planet: 'Jupiter', radiusKm: 69911,
    source: 'Juno gravity harmonics — dilute-core models (Wahl 2017, Militzer 2022, Debras & Chabrier 2019)',
    layers: [
      {
        name: 'Dilute core', outerKm: 21000, color: '#ffe5b0',
        state: 'supercritical', texture: 'metal', emissive: 0.5, estimated: true,
        composition: 'Rock & ice mixed into metallic hydrogen — no sharp boundary',
        tempK: [24000, 15000], pressureGPa: [4500, 1500],
        note: 'Juno’s gravity data cannot be fitted with a compact rocky core. Instead the heavy elements appear diluted through the inner ~half of the planet — likely the scar of a head-on giant impact early in its history.',
      },
      {
        name: 'Metallic hydrogen', outerKm: 55000, color: '#8a6fd0',
        state: 'liquid', texture: 'fluid', emissive: 0.12, estimated: true,
        composition: 'Hydrogen crushed into a liquid metal, with helium rain',
        tempK: [15000, 5000], pressureGPa: [1500, 100],
        note: 'Above about 100 GPa hydrogen ionises and conducts electricity like a metal. Convection in this shell generates the strongest planetary magnetic field in the Solar System — 20,000× Earth’s in energy.',
      },
      {
        name: 'Molecular hydrogen envelope', outerKm: 68500, color: '#c99a63',
        state: 'supercritical', texture: 'fluid',
        composition: 'Supercritical H₂ / He — no liquid–gas surface anywhere',
        tempK: [5000, 500], pressureGPa: [100, 0.1],
        note: 'There is no surface to land on: the gas thickens continuously into fluid. A probe descending here is crushed long before anything resembling ground appears.',
      },
      {
        name: 'Cloud decks', outerKm: 69911, color: '#b07f35',
        state: 'gas', texture: 'gas',
        composition: 'Ammonia ice, ammonium hydrosulfide, water clouds',
        tempK: [500, 165], pressureGPa: [0.1, 0],
        note: 'The visible bands — three stacked cloud decks driven by jet streams that have run for centuries. The Great Red Spot is a storm wider than Earth, tracked continuously since the 1830s.',
      },
    ],
  },

  // -------------------------------------------------------------------------
  // SATURN — Cassini's Grand Finale orbits and ring seismology gave the best
  // interior constraints of any giant planet after Jupiter, and revealed a
  // fuzzy, stably-stratified core.
  // -------------------------------------------------------------------------
  {
    planet: 'Saturn', radiusKm: 58232,
    source: 'Cassini Grand Finale gravity + ring seismology (Mankovich & Fuller 2021, Iess 2019)',
    layers: [
      {
        name: 'Fuzzy core', outerKm: 34000, color: '#ffdca8',
        state: 'supercritical', texture: 'metal', emissive: 0.42, estimated: true,
        composition: 'Rock & ice gradually blended into hydrogen–helium',
        tempK: [12000, 8000], pressureGPa: [1000, 400],
        note: 'Waves in Saturn’s own rings act as a seismometer for the planet. They revealed a stably stratified core extending 60% of the radius — diffuse, not a discrete ball of rock.',
      },
      {
        name: 'Metallic hydrogen', outerKm: 44000, color: '#9b7fd8',
        state: 'liquid', texture: 'fluid', emissive: 0.1, estimated: true,
        composition: 'Metallic hydrogen with helium separating out',
        tempK: [8000, 5000], pressureGPa: [400, 80],
        note: 'Helium is thought to be immiscible here and rains downward, releasing gravitational energy. That is the leading explanation for why Saturn radiates more heat than it absorbs from the Sun.',
      },
      {
        name: 'Molecular hydrogen envelope', outerKm: 57000, color: '#d3b47a',
        state: 'supercritical', texture: 'fluid',
        composition: 'Supercritical hydrogen & helium',
        tempK: [5000, 300], pressureGPa: [80, 0.1],
        note: 'Saturn’s mean density is only 0.69 g/cm³ — lower than water. This deep, light envelope is why: the planet is mostly hydrogen held loosely by comparatively weak gravity.',
      },
      {
        name: 'Cloud decks', outerKm: 58232, color: '#e2bf7d',
        state: 'gas', texture: 'gas',
        composition: 'Ammonia ice haze over deeper water clouds',
        tempK: [300, 134], pressureGPa: [0.1, 0],
        note: 'A thick photochemical haze mutes the banding. At the north pole a hexagonal jet stream 30,000 km across has held its six-sided shape for at least 40 years.',
      },
    ],
  },

  // -------------------------------------------------------------------------
  // URANUS — an "ice giant": most of the mass is a hot, dense, electrically
  // conducting water–ammonia–methane fluid, not hydrogen. Only ever visited
  // once, by Voyager 2 in 1986, so every boundary is a model estimate.
  // -------------------------------------------------------------------------
  {
    planet: 'Uranus', radiusKm: 25362,
    source: 'Voyager 2 gravity + ice-giant interior models (Nettelmann 2013, Helled 2020)',
    layers: [
      {
        name: 'Rocky core', outerKm: 5000, color: '#ffd0a0',
        state: 'solid', texture: 'metal', emissive: 0.35, estimated: true,
        composition: 'Silicate rock & iron, roughly half an Earth mass',
        tempK: [5000, 4700], pressureGPa: [800, 600],
        note: 'Small for such a large planet — Uranus is mostly ices, not rock. Its heat flow is anomalously low, as if the interior were still holding onto its formation heat behind an insulating layer.',
      },
      {
        name: 'Superionic ice mantle', outerKm: 18000, color: '#3f7f96',
        state: 'supercritical', texture: 'ice', estimated: true,
        composition: 'Water, ammonia & methane as a hot conducting fluid',
        tempK: [4700, 2000], pressureGPa: [600, 20],
        note: 'Not ice in any everyday sense: at these pressures water becomes superionic — oxygen locked in a lattice while hydrogen nuclei flow through it. This conducting fluid generates Uranus’s bizarre, off-centre, 59°-tilted magnetic field.',
      },
      {
        name: 'Hydrogen–helium envelope', outerKm: 24500, color: '#6aa8c8',
        state: 'supercritical', texture: 'fluid', estimated: true,
        composition: 'H₂ / He with ~2% methane',
        tempK: [2000, 100], pressureGPa: [20, 0.1],
        note: 'Under this pressure methane is expected to break down and its carbon crystallise — a slow rain of diamond falling through the mantle, reproduced in laser-shock experiments on Earth.',
      },
      {
        name: 'Atmosphere', outerKm: 25362, color: '#4b70dd',
        state: 'gas', texture: 'gas',
        composition: 'Hydrogen, helium, methane haze',
        tempK: [100, 49], pressureGPa: [0.1, 0],
        note: 'Methane absorbs red light, leaving the cyan colour. The whole planet is tipped 98°, so it rolls around the Sun on its side and each pole spends 42 years in unbroken darkness.',
      },
    ],
  },

  // -------------------------------------------------------------------------
  // NEPTUNE — structurally Uranus's twin but hotter inside and far more
  // active: it radiates 2.6× the heat it receives, and no one is sure why.
  // -------------------------------------------------------------------------
  {
    planet: 'Neptune', radiusKm: 24622,
    source: 'Voyager 2 gravity + ice-giant interior models (Nettelmann 2013, Podolak 2019)',
    layers: [
      {
        name: 'Rocky core', outerKm: 5000, color: '#ffcf9c',
        state: 'solid', texture: 'metal', emissive: 0.4, estimated: true,
        composition: 'Iron, nickel and silicates, ~1.2 Earth masses',
        tempK: [7000, 6000], pressureGPa: [900, 700],
        note: 'Hotter than Uranus’s core despite the near-identical size. Neptune emits 2.6× the energy it absorbs from the Sun — the internal heat source behind this is still an open problem.',
      },
      {
        name: 'Superionic ice mantle', outerKm: 17500, color: '#2f6f96',
        state: 'supercritical', texture: 'ice', estimated: true,
        composition: 'Water–ammonia–methane fluid, electrically conducting',
        tempK: [6000, 2500], pressureGPa: [700, 20],
        note: 'Hot, dense and conductive. Convection in a thin outer shell of this layer produces a magnetic field tilted 47° from the spin axis and offset well away from the planet’s centre.',
      },
      {
        name: 'Hydrogen–helium envelope', outerKm: 23800, color: '#4a80b0',
        state: 'supercritical', texture: 'fluid', estimated: true,
        composition: 'H₂ / He enriched in methane',
        tempK: [2500, 120], pressureGPa: [20, 0.1],
        note: 'Diamond rain is expected here too, and it may be more vigorous than at Uranus — falling diamond releases gravitational energy, one proposed explanation for Neptune’s excess heat.',
      },
      {
        name: 'Atmosphere', outerKm: 24622, color: '#274687',
        state: 'gas', texture: 'gas',
        composition: 'Hydrogen, helium, methane; hydrocarbon hazes',
        tempK: [120, 55], pressureGPa: [0.1, 0],
        note: 'Home to the fastest winds measured anywhere: 2,100 km/h, supersonic in the local atmosphere. Its storms — like the Great Dark Spot Voyager 2 saw — appear and vanish within years.',
      },
    ],
  },
];

export const INTERIOR_BY_PLANET = new Map(PLANET_INTERIORS.map((i) => [i.planet, i]));

/** Fractional radius (0–1) of a layer's outer boundary. */
export function layerFraction(interior: PlanetInterior, layer: InteriorLayer): number {
  return layer.outerKm / interior.radiusKm;
}

/** Thickness of a layer in km (its outer boundary minus the one below it). */
export function layerThicknessKm(interior: PlanetInterior, index: number): number {
  const inner = index === 0 ? 0 : interior.layers[index - 1].outerKm;
  return interior.layers[index].outerKm - inner;
}

/** Depth below the surface of a layer's outer boundary, km. */
export function layerDepthKm(interior: PlanetInterior, index: number): number {
  return interior.radiusKm - interior.layers[index].outerKm;
}

/** Fraction of the planet's VOLUME occupied by a layer (what "half the radius"
 *  actually means once you account for the cube law — the honest number). */
export function layerVolumeFraction(interior: PlanetInterior, index: number): number {
  const outer = interior.layers[index].outerKm;
  const inner = index === 0 ? 0 : interior.layers[index - 1].outerKm;
  return (outer ** 3 - inner ** 3) / interior.radiusKm ** 3;
}

const STATE_LABEL: Record<LayerState, string> = {
  solid: 'Solid',
  liquid: 'Liquid',
  supercritical: 'Supercritical fluid',
  gas: 'Gas',
};

export function stateLabel(state: LayerState): string {
  return STATE_LABEL[state];
}

/** Human-readable temperature, °C for the shallow/cold end, K when extreme. */
export function formatTempK(k: number): string {
  if (k >= 10000) return `${(k / 1000).toFixed(1)}k K`;
  if (k >= 1500) return `${k.toLocaleString()} K`;
  return `${k.toLocaleString()} K (${Math.round(k - 273.15).toLocaleString()} °C)`;
}

/** Pressure in the unit that reads best at that magnitude. */
export function formatPressure(gpa: number): string {
  if (gpa === 0) return '~0';
  if (gpa >= 1) return `${gpa.toLocaleString()} GPa`;
  if (gpa >= 0.001) return `${(gpa * 1000).toFixed(0)} MPa`;
  return `${(gpa * 1e6).toFixed(0)} kPa`;
}
