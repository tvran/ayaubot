const numberFromLabel = (value) => {
  const match = String(value ?? '').trim().match(/^\d+$/u);
  return match ? Number(match[0]) : null;
};

const rowKey = (place) => String(place?.row ?? '').trim();

const average = (values) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : 0;

const rowsByPosition = (places) => {
  const rows = new Map();
  for (const place of places) {
    const key = rowKey(place);
    if (!key) continue;
    const values = rows.get(key) || [];
    values.push(place);
    rows.set(key, values);
  }

  return Array.from(rows, ([key, rowPlaces]) => ({
    key,
    number: numberFromLabel(key),
    y: average(rowPlaces.map((place) => Number(place.y)).filter(Number.isFinite)),
    places: rowPlaces
  })).sort((left, right) => {
    if (left.number !== null && right.number !== null) return left.number - right.number;
    if (left.number !== null) return -1;
    if (right.number !== null) return 1;
    return left.y - right.y || left.key.localeCompare(right.key, 'ru');
  });
};

const seatsAreAdjacent = (left, right) => {
  const leftNumber = numberFromLabel(left.place);
  const rightNumber = numberFromLabel(right.place);
  if (leftNumber !== null && rightNumber !== null && rightNumber !== leftNumber + 1) return false;

  const leftX = Number(left.x);
  const rightX = Number(right.x);
  const leftWidth = Number(left.width);
  const rightWidth = Number(right.width);
  const hasGeometry = [leftX, rightX, leftWidth, rightWidth].every(Number.isFinite) &&
    leftWidth > 0 && rightWidth > 0;
  if (!hasGeometry) return leftNumber !== null && rightNumber !== null;

  const leftCenter = leftX + leftWidth / 2;
  const rightCenter = rightX + rightWidth / 2;
  const gap = Math.abs(rightCenter - leftCenter) - (leftWidth + rightWidth) / 2;
  return gap >= -Math.max(leftWidth, rightWidth) * 0.25 &&
    gap <= Math.max(leftWidth, rightWidth) * 1.5;
};

const sortSeats = (places) => [...places].sort((left, right) => {
  const leftNumber = numberFromLabel(left.place);
  const rightNumber = numberFromLabel(right.place);
  if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
  return Number(left.x) - Number(right.x) || String(left.place).localeCompare(String(right.place), 'ru');
});

export const upperHalfRowKeys = (hallPlans) => {
  const plans = Array.isArray(hallPlans) ? hallPlans : [hallPlans];
  const places = plans.flatMap((hallPlan) => Array.isArray(hallPlan?.places) ? hallPlan.places : []);
  const rows = rowsByPosition(places);
  return new Set(rows.slice(Math.floor(rows.length / 2)).map((row) => row.key));
};

export const findAdjacentSeatBlock = (hallPlan, requiredSeats = 2, { allowedRows } = {}) => {
  const required = Math.max(1, Math.floor(Number(requiredSeats)) || 2);
  const places = Array.isArray(hallPlan?.places) ? hallPlan.places : [];
  const rows = rowsByPosition(places);
  if (!rows.length) return null;

  // Ticketon numbers rows from the screen outwards. A shared set lets all price sectors
  // use the midpoint of the complete hall instead of treating each sector as a hall.
  const eligibleRows = allowedRows instanceof Set ? allowedRows : upperHalfRowKeys(hallPlan);
  const upperRows = rows.filter((row) => eligibleRows.has(row.key));
  for (const row of upperRows) {
    const available = sortSeats(row.places.filter((place) => Number(place.status) === 1));
    let block = [];
    for (const place of available) {
      if (!block.length || seatsAreAdjacent(block.at(-1), place)) {
        block.push(place);
      } else {
        block = [place];
      }
      if (block.length >= required) {
        return {
          row: row.key,
          places: block.slice(0, required).map((seat) => String(seat.place)),
          seatIds: block.slice(0, required).map((seat) => String(seat.id)),
          rowCount: rows.length
        };
      }
    }
  }

  return null;
};
