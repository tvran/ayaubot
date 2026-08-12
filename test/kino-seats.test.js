import assert from 'node:assert/strict';
import test from 'node:test';
import { findAdjacentSeatBlock } from '../src/kino/seats.js';

const seat = (row, place, status = 1, x = place * 24) => ({
  id: `${row}-${place}`,
  row: String(row),
  place: String(place),
  status,
  x,
  y: row * 24,
  width: 20,
  height: 20
});

test('findAdjacentSeatBlock ignores adjacent places below the middle of the hall', () => {
  const hallPlan = {
    places: [
      seat(1, 1), seat(1, 2),
      seat(2, 1, 0), seat(2, 2, 0),
      seat(3, 1), seat(3, 2),
      seat(4, 1, 0), seat(4, 2, 0)
    ]
  };

  assert.deepEqual(findAdjacentSeatBlock(hallPlan), {
    row: '3',
    places: ['1', '2'],
    seatIds: ['3-1', '3-2'],
    rowCount: 4
  });
});

test('findAdjacentSeatBlock rejects separated numbers and physical aisle gaps', () => {
  const hallPlan = {
    places: [
      seat(1, 1, 0),
      seat(2, 1, 1, 24),
      seat(2, 3, 1, 48),
      seat(3, 1, 1, 24),
      seat(3, 2, 1, 200)
    ]
  };

  assert.equal(findAdjacentSeatBlock(hallPlan), null);
});

test('findAdjacentSeatBlock supports a configurable group size', () => {
  const hallPlan = {
    places: [
      seat(1, 1, 0),
      seat(2, 4), seat(2, 5), seat(2, 6)
    ]
  };

  assert.deepEqual(findAdjacentSeatBlock(hallPlan, 3)?.places, ['4', '5', '6']);
});
