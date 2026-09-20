// 📁 backend/src/utils/hexGrid.js
//
// Pointy-top hex grid, ~1.11 km per hex edge.
// Matches the SQL formula in the partner_code migration.

const R = 0.01;                       // hex edge in degrees
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;

const LAT_OFFSET = 5;                 // keeps q, r positive for Kenya
const LNG_OFFSET = 30;
const PACK = 100000;

function latLngToQR(lat, lng) {
  const q = Math.round(
    ((lng + LNG_OFFSET) * COS30 - (lat + LAT_OFFSET) * SIN30) / R
  );
  const r = Math.round((lat + LAT_OFFSET) / R);
  return { q, r };
}

function pack(q, r) {
  return q * PACK + r;
}

function unpack(hexId) {
  const q = Math.floor(hexId / PACK);
  const r = hexId - q * PACK;
  return { q, r };
}

function latLngToHex(lat, lng) {
  const { q, r } = latLngToQR(lat, lng);
  return pack(q, r);
}

function ringHexes(centerHex, ring) {
  if (ring === 0) return [centerHex];
  const { q: cq, r: cr } = unpack(centerHex);
  const out = [];
  const dirs = [
    [1, 0], [0, 1], [-1, 1],
    [-1, 0], [0, -1], [1, -1],
  ];
  let q = cq + dirs[4][0] * ring;
  let r = cr + dirs[4][1] * ring;
  for (let d = 0; d < 6; d++) {
    for (let i = 0; i < ring; i++) {
      out.push(pack(q, r));
      q += dirs[d][0];
      r += dirs[d][1];
    }
  }
  return out;
}

function hexesUpToRing(centerHex, maxRing) {
  const out = [centerHex];
  for (let r = 1; r <= maxRing; r++) out.push(...ringHexes(centerHex, r));
  return out;
}

// Rough guide: ring N covers roughly N * 2 km radius in Nairobi.
function approximateRadiusKm(ring) {
  return ring * 2;
}

// Fee policy per ring. Ring 1-3 = free; ring 4+ = +50 extended.
const EXTENDED_FEE = 50;
function extendedFeeForRing(ring) {
  return ring >= 4 ? EXTENDED_FEE : 0;
}

module.exports = {
  R,
  latLngToHex,
  ringHexes,
  hexesUpToRing,
  approximateRadiusKm,
  extendedFeeForRing,
  unpack,
  pack,
  EXTENDED_FEE,
};