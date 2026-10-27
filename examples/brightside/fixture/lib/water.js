'use strict';

// The big water inside the fixture's Columbus box (lib/routing.js BOX), so
// no synthetic home or crew base lands on a lake or a river (fix to Story
// 15.7: AD-R22 cut the land mask, and the live check found a stop on Alum
// Creek Reservoir).
//
// The outlines are rough and hand-drawn from general knowledge of the area,
// not taken from OpenStreetMap or any other map data. They are generous on
// purpose: each takes in the water plus a margin of at least 250 m on every
// side (more where the river's line is less certain), so a point outside
// one is on land with room to spare. Over-cautious is fine for a demo: a
// home redrawn off a lakeside field costs nothing.
//
// Each outline is a ring of [lat, lon] in micro-degrees (degrees x 1e6),
// whole thousands, not closed (the last vertex joins the first). The rivers
// are bands drawn around a hand-traced centre line. Small creeks (Alum Creek
// below the dam, Big Walnut, Big Darby) are left out: on the map they are a
// thin line, not a body a marker could sit in.
//
// checks/synthetic-off-water.sql holds the same rings as SQL edges; a test
// keeps the two the same.

const WATER = Object.freeze([
  {
    name: 'Alum Creek Reservoir',
    ring: [
      [40172000, -82995000], [40172000, -82940000], [40215000, -82935000], [40260000, -82937000],
      [40310000, -82945000], [40310000, -82992000], [40260000, -83002000], [40215000, -83002000],
    ],
  },
  {
    name: 'Hoover Reservoir',
    ring: [
      [40100000, -82902000], [40100000, -82862000], [40150000, -82852000],
      [40232000, -82858000], [40232000, -82896000], [40150000, -82910000],
    ],
  },
  {
    name: "O'Shaughnessy Reservoir",
    ring: [
      [40143000, -83140000], [40143000, -83106000], [40200000, -83113000],
      [40285000, -83128000], [40285000, -83165000], [40200000, -83150000],
    ],
  },
  {
    name: 'Griggs Reservoir',
    ring: [
      [39985000, -83102000], [39985000, -83074000], [40030000, -83080000],
      [40076000, -83094000], [40076000, -83122000], [40030000, -83106000],
    ],
  },
  {
    // From O'Shaughnessy's dam down through Dublin to Griggs.
    name: 'Scioto River (Dublin)',
    ring: [
      [40156000, -83120000], [40121000, -83112000], [40101000, -83106000], [40081000, -83102000], [40071000, -83100000],
      [40069000, -83112000], [40079000, -83114000], [40099000, -83118000], [40119000, -83124000], [40154000, -83132000],
    ],
  },
  {
    // From Griggs' dam past Grandview to downtown, then south to the Scioto Audubon.
    name: 'Scioto River (downtown)',
    ring: [
      [39997000, -83087000], [39994000, -83085000], [39983000, -83066000], [39973000, -83042000],
      [39967000, -83018000], [39961000, -83000000], [39945000, -82998000], [39929000, -83002000],
      [39931000, -83016000], [39945000, -83012000], [39955000, -83012000], [39957000, -83022000],
      [39963000, -83048000], [39973000, -83074000], [39986000, -83095000], [39993000, -83099000],
    ],
  },
  {
    // South of downtown to the box's south edge: wider, the line is less certain.
    name: 'Scioto River (south)',
    ring: [
      [39934000, -83001000], [39925000, -83001000], [39901000, -82991000], [39870000, -82988000],
      [39841000, -82988000], [39811000, -82984000], [39782000, -82978000], [39742000, -82971000],
      [39692000, -82961000], [39688000, -82989000], [39738000, -82999000], [39778000, -83006000],
      [39809000, -83012000], [39839000, -83016000], [39870000, -83016000], [39899000, -83019000],
      [39925000, -83019000], [39936000, -83015000],
    ],
  },
  {
    // From the Scioto confluence north past campus, Clintonville and
    // Worthington to Delaware, Antrim Lake included.
    name: 'Olentangy River',
    ring: [
      [39952000, -83016000], [39959000, -83019000], [39973000, -83028000], [39990000, -83033000],
      [40005000, -83031000], [40019000, -83035000], [40039000, -83038000], [40059000, -83043000],
      [40080000, -83045000], [40101000, -83041000], [40120000, -83038000], [40149000, -83043000],
      [40173000, -83053000], [40199000, -83063000], [40239000, -83073000], [40309000, -83083000],
      [40311000, -83067000], [40241000, -83057000], [40201000, -83047000], [40177000, -83037000],
      [40151000, -83027000], [40120000, -83022000], [40099000, -83025000], [40080000, -83029000],
      [40061000, -83027000], [40041000, -83022000], [40021000, -83019000], [40005000, -83015000],
      [39990000, -83017000], [39977000, -83012000], [39965000, -83005000], [39958000, -83000000],
    ],
  },
].map((w) => Object.freeze({ name: w.name, ring: Object.freeze(w.ring.map((v) => Object.freeze(v))) })));

// The map's grid (profile routing.map_grid_e6 default, kit/runtime/data/map.js):
// a marker is drawn at the point snapped to it, so both must be dry.
const MAP_GRID_E6 = 2000;

// The nearest multiple of `grid`, half away from zero, as DuckDB's round()
// does it in mapPoints; whole-number arithmetic, so it is exact.
function snap(v, grid = MAP_GRID_E6) {
  const a = Math.abs(v);
  const q = Math.floor(a / grid) + (a % grid >= grid / 2 ? 1 : 0);
  return Math.sign(v) * q * grid;
}

// Even-odd ray cast eastward from the point; each edge holds its lower end
// and not its upper one. Products of micro-degree differences stay far
// under 2^53, so the test is exact (the SQL check runs the same sum).
function inRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0; i < ring.length; i++) {
    const [lat1, lon1] = ring[i];
    const [lat2, lon2] = ring[(i + 1) % ring.length];
    if ((lat1 > lat) === (lat2 > lat)) continue;
    // The edge's longitude at `lat` is east of the point.
    const lhs = (lon - lon1) * (lat2 - lat1);
    const rhs = (lon2 - lon1) * (lat - lat1);
    if (lat2 > lat1 ? lhs < rhs : lhs > rhs) inside = !inside;
  }
  return inside;
}

// The water a point is in, as is or snapped to the map grid, or null.
function waterAt(lat, lon) {
  for (const w of WATER) {
    if (inRing(lat, lon, w.ring) || inRing(snap(lat), snap(lon), w.ring)) return w.name;
  }
  return null;
}

const onWater = (lat, lon) => waterAt(lat, lon) !== null;

module.exports = { WATER, MAP_GRID_E6, snap, inRing, waterAt, onWater };
