// ── Park Profiles + Hometown Utilities ────────────────────────────────────────
import { getTodayInAppTimeZone } from './utils.js';

export const PARK_DATA = {
  ARI:{name:"Chase Field",dims:{LF:330,LCF:376,CF:407,RCF:376,RF:335},wall:{LF:7.5,CF:25,RF:7.5},elev:1059,roof:"retractable",pf:{HR_L:0.97,HR_R:1.00,H:1.01,"2B":1.06,"3B":0.85}},
  ATL:{name:"Truist Park",dims:{LF:335,LCF:385,CF:400,RCF:375,RF:325},wall:{LF:6,CF:8,RF:6},elev:1050,roof:"open",pf:{HR_L:0.99,HR_R:1.02,H:1.00,"2B":0.99,"3B":0.90}},
  BAL:{name:"Camden Yards",dims:{LF:337,LCF:364,CF:400,RCF:373,RF:318},wall:{LF:7,CF:7,RF:21},elev:33,roof:"open",pf:{HR_L:1.18,HR_R:1.14,H:1.04,"2B":1.08,"3B":0.75}},
  BOS:{name:"Fenway Park",dims:{LF:310,LCF:379,CF:390,RCF:380,RF:302},wall:{LF:37,CF:17,RF:3},elev:21,roof:"open",pf:{HR_L:0.89,HR_R:1.12,H:1.03,"2B":1.28,"3B":0.56}},
  CHC:{name:"Wrigley Field",dims:{LF:355,LCF:368,CF:400,RCF:368,RF:353},wall:{LF:11.5,CF:11.5,RF:11.5},elev:600,roof:"open",pf:{HR_L:0.96,HR_R:0.98,H:0.99,"2B":1.01,"3B":0.90}},
  CWS:{name:"Rate Field",dims:{LF:330,LCF:375,CF:400,RCF:375,RF:335},wall:{LF:8,CF:8,RF:8},elev:595,roof:"open",pf:{HR_L:1.10,HR_R:1.08,H:1.02,"2B":0.95,"3B":0.80}},
  CIN:{name:"Great American Ball Park",dims:{LF:328,LCF:379,CF:404,RCF:370,RF:325},wall:{LF:8,CF:8,RF:8},elev:490,roof:"open",pf:{HR_L:1.15,HR_R:1.20,H:1.04,"2B":0.97,"3B":0.85}},
  CLE:{name:"Progressive Field",dims:{LF:325,LCF:370,CF:405,RCF:375,RF:325},wall:{LF:9,CF:9,RF:9},elev:653,roof:"open",pf:{HR_L:0.96,HR_R:0.95,H:0.98,"2B":1.00,"3B":0.80}},
  COL:{name:"Coors Field",dims:{LF:347,LCF:390,CF:415,RCF:375,RF:350},wall:{LF:8,CF:8,RF:8},elev:5280,roof:"open",pf:{HR_L:1.28,HR_R:1.35,H:1.15,"2B":1.35,"3B":1.90}},
  DET:{name:"Comerica Park",dims:{LF:345,LCF:370,CF:420,RCF:365,RF:330},wall:{LF:8,CF:8,RF:8},elev:600,roof:"open",pf:{HR_L:0.88,HR_R:0.90,H:0.97,"2B":1.05,"3B":1.20}},
  HOU:{name:"Daikin Park",dims:{LF:315,LCF:362,CF:409,RCF:373,RF:326},wall:{LF:19,CF:8,RF:8},elev:41,roof:"retractable",roofDefault:"closed",pf:{HR_L:1.00,HR_R:0.95,H:0.98,"2B":1.02,"3B":0.80}},
  KC:{name:"Kauffman Stadium",dims:{LF:330,LCF:375,CF:400,RCF:375,RF:330},wall:{LF:8,CF:8,RF:8},elev:820,roof:"open",pf:{HR_L:0.98,HR_R:0.95,H:1.00,"2B":1.05,"3B":1.00}},
  LAA:{name:"Angel Stadium",dims:{LF:330,LCF:387,CF:396,RCF:370,RF:330},wall:{LF:8,CF:8,RF:8},elev:160,roof:"open",pf:{HR_L:0.97,HR_R:1.00,H:0.99,"2B":0.98,"3B":0.90}},
  LAD:{name:"Dodger Stadium",dims:{LF:330,LCF:375,CF:395,RCF:375,RF:330},wall:{LF:4,CF:4,RF:4},elev:515,roof:"open",pf:{HR_L:1.05,HR_R:1.08,H:0.96,"2B":0.92,"3B":0.80}},
  MIA:{name:"loanDepot Park",dims:{LF:340,LCF:386,CF:400,RCF:392,RF:335},wall:{LF:8,CF:8,RF:8},elev:6,roof:"retractable",roofDefault:"closed",pf:{HR_L:0.87,HR_R:0.85,H:0.96,"2B":0.98,"3B":0.90}},
  MIL:{name:"American Family Field",dims:{LF:332,LCF:370,CF:400,RCF:374,RF:325},wall:{LF:8,CF:8,RF:8},elev:635,roof:"retractable",roofDefault:"closed",pf:{HR_L:1.06,HR_R:1.04,H:1.02,"2B":1.00,"3B":0.85}},
  MIN:{name:"Target Field",dims:{LF:339,LCF:377,CF:404,RCF:367,RF:328},wall:{LF:8,CF:8,RF:23},elev:840,roof:"open",pf:{HR_L:1.02,HR_R:0.88,H:0.98,"2B":1.00,"3B":0.85}},
  NYM:{name:"Citi Field",dims:{LF:335,LCF:379,CF:405,RCF:375,RF:330},wall:{LF:8,CF:8,RF:8},elev:16,roof:"open",pf:{HR_L:0.92,HR_R:0.90,H:0.97,"2B":0.98,"3B":0.95}},
  NYY:{name:"Yankee Stadium",dims:{LF:318,LCF:399,CF:404,RCF:385,RF:314},wall:{LF:8,CF:8,RF:8},elev:16,roof:"open",pf:{HR_L:0.90,HR_R:1.18,H:1.00,"2B":0.93,"3B":0.70}},
  OAK:{name:"Sutter Health Park",dims:{LF:330,LCF:370,CF:403,RCF:370,RF:325},wall:{LF:8,CF:8,RF:8},elev:26,roof:"open",pf:{HR_L:0.95,HR_R:0.95,H:0.98,"2B":1.00,"3B":1.00}},
  PHI:{name:"Citizens Bank Park",dims:{LF:329,LCF:374,CF:401,RCF:369,RF:330},wall:{LF:8,CF:10,RF:8},elev:20,roof:"open",pf:{HR_L:1.10,HR_R:1.08,H:1.02,"2B":1.00,"3B":0.80}},
  PIT:{name:"PNC Park",dims:{LF:325,LCF:389,CF:399,RCF:375,RF:320},wall:{LF:6,CF:6,RF:21},elev:730,roof:"open",pf:{HR_L:0.92,HR_R:0.98,H:0.98,"2B":1.02,"3B":1.10}},
  SD:{name:"Petco Park",dims:{LF:336,LCF:367,CF:396,RCF:387,RF:322},wall:{LF:8,CF:8,RF:8},elev:16,roof:"open",pf:{HR_L:0.88,HR_R:0.85,H:0.96,"2B":1.00,"3B":1.00}},
  SEA:{name:"T-Mobile Park",dims:{LF:331,LCF:378,CF:405,RCF:385,RF:326},wall:{LF:8,CF:8,RF:8},elev:16,roof:"retractable",pf:{HR_L:0.86,HR_R:0.85,H:0.95,"2B":1.02,"3B":1.10}},
  SF:{name:"Oracle Park",dims:{LF:339,LCF:382,CF:399,RCF:365,RF:309},wall:{LF:8,CF:8,RF:25},elev:16,roof:"open",pf:{HR_L:0.82,HR_R:0.80,H:0.96,"2B":1.05,"3B":1.20}},
  STL:{name:"Busch Stadium",dims:{LF:336,LCF:375,CF:400,RCF:375,RF:335},wall:{LF:8,CF:8,RF:8},elev:455,roof:"open",pf:{HR_L:0.93,HR_R:0.95,H:0.98,"2B":0.98,"3B":0.90}},
  TB:{name:"Tropicana Field",dims:{LF:315,LCF:370,CF:404,RCF:370,RF:322},wall:{LF:11.5,CF:10,RF:6},elev:13,roof:"dome",pf:{HR_L:0.93,HR_R:0.95,H:1.02,"2B":1.04,"3B":1.20}},
  TEX:{name:"Globe Life Field",dims:{LF:329,LCF:372,CF:407,RCF:374,RF:326},wall:{LF:8,CF:14,RF:8},elev:525,roof:"retractable",roofDefault:"closed",pf:{HR_L:1.02,HR_R:1.00,H:1.00,"2B":0.98,"3B":0.80}},
  TOR:{name:"Rogers Centre",dims:{LF:328,LCF:375,CF:400,RCF:375,RF:328},wall:{LF:10,CF:10,RF:10},elev:266,roof:"retractable",roofDefault:"closed",pf:{HR_L:1.06,HR_R:1.08,H:1.01,"2B":0.95,"3B":0.75}},
  WSH:{name:"Nationals Park",dims:{LF:336,LCF:377,CF:403,RCF:370,RF:335},wall:{LF:8,CF:8,RF:8},elev:25,roof:"open",pf:{HR_L:0.98,HR_R:1.00,H:0.99,"2B":1.00,"3B":0.90}},
};

// Stadium lat/lon — used for NWS forecast lookup
export const PARK_COORDS = {
  ARI:[33.4453,-112.0667], ATL:[33.8908,-84.4678], BAL:[39.2838,-76.6216],
  BOS:[42.3467,-71.0972],  CHC:[41.9484,-87.6553], CWS:[41.8300,-87.6339],
  CIN:[39.0975,-84.5063],  CLE:[41.4963,-81.6852], COL:[39.7559,-104.9942],
  DET:[42.3390,-83.0485],  HOU:[29.7572,-95.3553], KC:[39.0517,-94.4803],
  LAA:[33.8003,-117.8827], LAD:[34.0739,-118.2400], MIA:[25.7781,-80.2197],
  MIL:[43.0282,-87.9712],  MIN:[44.9817,-93.2781], NYM:[40.7571,-73.8458],
  NYY:[40.8296,-73.9262],  OAK:[38.5802,-121.5069], PHI:[39.9061,-75.1665],
  PIT:[40.4469,-80.0058],  SD:[32.7076,-117.1570], SEA:[47.5914,-122.3325],
  SF:[37.7786,-122.3893],  STL:[38.6226,-90.1928], TB:[27.7683,-82.6534],
  TEX:[32.7473,-97.0828],  TOR:[43.6414,-79.3894], WSH:[38.8730,-77.0074],
};

// Compass bearing from home plate toward CF (degrees from N, 0–360)
// Used to translate NWS compass wind → "Out To CF" / "In From CF" / crosswind
export const PARK_CF_BEARING = {
  ARI:330, ATL:35,  BAL:130, BOS:90,  CHC:40,  CWS:50,  CIN:10,  CLE:125,
  COL:25,  DET:300, HOU:5,   KC:35,   LAA:340, LAD:310, MIA:345, MIL:300,
  MIN:290, NYM:10,  NYY:350, OAK:285, PHI:55,  PIT:30,  SD:305,  SEA:170,
  SF:50,   STL:300, TB:0,    TEX:305, TOR:25,  WSH:30,
};

// Park cities — used for hometown proximity flag
export const PARK_CITIES = {
  ARI:"Phoenix",ATL:"Atlanta",BAL:"Baltimore",BOS:"Boston",
  CHC:"Chicago",CWS:"Chicago",CIN:"Cincinnati",CLE:"Cleveland",
  COL:"Denver",DET:"Detroit",HOU:"Houston",KC:"Kansas City",
  LAA:"Anaheim",LAD:"Los Angeles",MIA:"Miami",MIL:"Milwaukee",
  MIN:"Minneapolis",NYM:"New York",NYY:"New York",OAK:"Sacramento",
  PHI:"Philadelphia",PIT:"Pittsburgh",SD:"San Diego",SEA:"Seattle",
  SF:"San Francisco",STL:"St. Louis",TB:"Tampa",TEX:"Arlington",
  TOR:"Toronto",WSH:"Washington",
};
// Metro area aliases: if park city is in metro AND birth city is in metro → hometown flag
export const METRO_AREAS = {
  "new york":["new york","brooklyn","queens","newark","hoboken","jersey city","bronx","yonkers","manhattan"],
  "los angeles":["los angeles","anaheim","long beach","pasadena","glendale","burbank","inglewood","compton","torrance"],
  "chicago":["chicago","evanston","oak park","cicero","berwyn","waukegan"],
  "san francisco":["san francisco","san jose","oakland","berkeley","fremont","hayward","richmond","vallejo"],
  "miami":["miami","hialeah","miami beach","fort lauderdale","hollywood","pompano beach","coral springs"],
  "anaheim":["anaheim","los angeles","long beach","santa ana","garden grove","orange"],
  "sacramento":["sacramento","elk grove","roseville","folsom","rancho cordova"],
  "arlington":["arlington","fort worth","dallas","irving","plano","grand prairie","duncanville","garland","mesquite","richardson","denton","mckinney","frisco","carrollton","lewisville"],
  "minneapolis":["minneapolis","st. paul","saint paul","bloomington","plymouth","brooklyn park"],
  "st. louis":["st. louis","saint louis","clayton","chesterfield","florissant"],
  "kansas city":["kansas city","overland park","olathe","independence","lenexa"],
  "tampa":["tampa","st. petersburg","saint petersburg","clearwater","brandon","largo"],
};

// States/provinces each park's metro spans. The hometown flag requires the birth state
// to be one of these: city names alone collide across states (Brooklyn NY vs Brooklyn
// Park MN, Richmond VA vs Richmond CA, Brandon MS vs Brandon FL, Glendale AZ vs CA).
export const PARK_METRO_STATES = {
  ARI:["AZ"], ATL:["GA"], BAL:["MD"], BOS:["MA"], CHC:["IL","IN"], CWS:["IL","IN"],
  CIN:["OH","KY"], CLE:["OH"], COL:["CO"], DET:["MI"], HOU:["TX"], KC:["MO","KS"],
  LAA:["CA"], LAD:["CA"], MIA:["FL"], MIL:["WI"], MIN:["MN"], NYM:["NY","NJ"],
  NYY:["NY","NJ"], OAK:["CA"], PHI:["PA","NJ"], PIT:["PA"], SD:["CA"], SEA:["WA"],
  SF:["CA"], STL:["MO","IL"], TB:["FL"], TEX:["TX"], TOR:["ON"], WSH:["DC","MD","VA"],
};

export const _ABBREV_ALIASES = { ATH: "OAK", AZ: "ARI" }; // 2026 relocations / alternate abbreviations

// Venue-name overrides — for neutral-site / relocated home games where the live
// MLB venue does NOT match the home team's default park. Matched on a lowercase
// substring of the API venue name and checked BEFORE the abbrev lookup, so the
// authoritative per-game venue wins (e.g. an A's "home" game played in Las Vegas
// resolves to Las Vegas Ballpark, while one still at Sutter Health Park resolves
// to OAK via the abbrev fallback).
//
// Las Vegas Ballpark (Summerlin, NV, ~2,030 ft): extreme HR environment — desert
// heat + thin/dry air made it a top-tier PCL launching pad. Altitude is baked into
// the HR park factor (parkWeatherMult deliberately excludes elevFactor to avoid
// double-counting); the hot-desert temp bump (tempFactor, capped +20%) and any
// tailwind then stack ON TOP, which is how the combined HR influence can approach
// +100% on a 95°F+ night. The base PF is aggressive (~+50%) but intentionally NOT
// a raw 2.0 — the outrageous number is the weather-amplified product, not the PF.
export const VENUE_OVERRIDES = [
  {
    match: "las vegas",
    coords: [36.1969, -115.3289],   // Las Vegas Ballpark, Summerlin
    cfBearing: 20,                   // approx — CF points roughly NNE from home plate
    park: {
      name: "Las Vegas Ballpark",
      dims: { LF: 339, LCF: 375, CF: 415, RCF: 375, RF: 339 },
      wall: { LF: 8, CF: 8, RF: 8 }, elev: 2030, roof: "open",
      pf: { HR_L: 1.50, HR_R: 1.55, H: 1.08, "2B": 1.10, "3B": 1.20 },
    },
  },
];
function _venueOverride(venueName) {
  if (!venueName) return null;
  const vLow = venueName.toLowerCase();
  return VENUE_OVERRIDES.find(o => vLow.includes(o.match)) || null;
}

export function getParkData(venueName, homeAbbrev) {
  const ov = _venueOverride(venueName);
  if (ov) return ov.park;
  const abbrev = _ABBREV_ALIASES[homeAbbrev] || homeAbbrev;
  if (abbrev && PARK_DATA[abbrev]) return PARK_DATA[abbrev];
  if (!venueName) return null;
  const vLow = venueName.toLowerCase();
  return Object.values(PARK_DATA).find(p => vLow.includes(p.name.toLowerCase().split(" ")[0])) || null;
}

// Venue-aware weather lookups. Prefer the per-game venue override (so a relocated
// game fetches the correct city's forecast); otherwise normalize the abbrev through
// _ABBREV_ALIASES (so e.g. ATH → OAK coords resolve instead of returning nothing).
export function getParkCoords(venueName, homeAbbrev) {
  const ov = _venueOverride(venueName);
  if (ov?.coords) return ov.coords;
  const abbrev = _ABBREV_ALIASES[homeAbbrev] || homeAbbrev;
  return PARK_COORDS[abbrev] || null;
}
export function getParkCfBearing(venueName, homeAbbrev) {
  const ov = _venueOverride(venueName);
  if (ov?.cfBearing != null) return ov.cfBearing;
  const abbrev = _ABBREV_ALIASES[homeAbbrev] || homeAbbrev;
  return PARK_CF_BEARING[abbrev] ?? null;
}


// Given bio + split AVGs + park abbreviation, compute which personal flags apply
export function computePlayerFlags({ bio, homeAvg, awayAvg, parkAbbrev, today }) {
  const flags = {};

  // 🎂 Birthday
  if (bio?.birthDate) {
    const todayMD = (today || getTodayInAppTimeZone()).slice(5);
    if (bio.birthDate.slice(5) === todayMD) flags.birthday = true;
  }

  // 🏠 Home advantage / 🥷 Road advantage
  if (homeAvg != null && awayAvg != null) {
    const diff = homeAvg - awayAvg;
    if (diff > 0.020) flags.homeAdvantage = true;
    else if (diff < -0.020) flags.roadAdvantage = true;
  }

  // 👨‍👩‍👧 Hometown — birth city IS the park city or a city in its metro (exact names,
  // never substrings: "Evans" is not "Evanston"), and the birth state is in that metro.
  if (bio?.birthCity) {
    const abbrev = _ABBREV_ALIASES[parkAbbrev] || parkAbbrev;
    const norm = (s) => s.toLowerCase().trim().replace(/^saint /, "st. ");
    const parkCity = norm(PARK_CITIES[abbrev] || "");
    const bc = norm(bio.birthCity);
    const states = PARK_METRO_STATES[abbrev];
    const stateOk = !bio.birthState || !states || states.includes(bio.birthState);
    if (parkCity && stateOk) {
      const metroCities = new Set([parkCity]);
      for (const [metro, cities] of Object.entries(METRO_AREAS)) {
        if (parkCity === metro || cities.map(norm).includes(parkCity)) {
          metroCities.add(norm(metro));
          cities.forEach(c => metroCities.add(norm(c)));
        }
      }
      if (metroCities.has(bc)) flags.hometown = true;
    }
  }

  return flags;
}
