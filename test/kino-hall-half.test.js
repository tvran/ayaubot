import assert from 'node:assert/strict';
import test from 'node:test';
import { findAdjacentSeatBlock, upperHalfRowKeys } from '../src/kino/seats.js';

const seat = (row, place, status = 1) => ({
  id: `${row}-${place}`,
  row: String(row),
  place: String(place),
  status,
  x: place * 24,
  y: row * 24,
  width: 20,
  height: 20
});

test('uses the complete hall midpoint across Ticketon price sectors', () => {
  const front = { places: [seat(1, 1, 0), seat(2, 1, 0), seat(3, 1), seat(3, 2), seat(4, 1, 0)] };
  const rear = { places: [seat(5, 1), seat(5, 2), seat(6, 1, 0), seat(7, 1, 0), seat(8, 1, 0)] };
  const allowedRows = upperHalfRowKeys([front, rear]);

  assert.deepEqual([...allowedRows], ['5', '6', '7', '8']);
  assert.equal(findAdjacentSeatBlock(front, 2, { allowedRows }), null);
  assert.deepEqual(findAdjacentSeatBlock(rear, 2, { allowedRows })?.places, ['1', '2']);
});

test('keeps the middle row in the upper half for an odd row count', () => {
  const hall = { places: [seat(1, 1, 0), seat(2, 1, 0), seat(3, 1), seat(3, 2), seat(4, 1, 0), seat(5, 1, 0)] };

  assert.deepEqual([...upperHalfRowKeys(hall)], ['3', '4', '5']);
  assert.equal(findAdjacentSeatBlock(hall)?.row, '3');
});

test('supports monitoring a single available seat', () => {
  const hall = { places: [seat(1, 1, 0), seat(2, 7)] };

  assert.deepEqual(findAdjacentSeatBlock(hall, 1)?.places, ['7']);
});
