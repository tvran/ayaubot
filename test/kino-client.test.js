import assert from 'node:assert/strict';
import test from 'node:test';
import { createKinoClient, extractSeatPlanFromHtml } from '../src/kino/client.js';

test('Kino client uses public catalog tRPC endpoints and city cookie', async () => {
  const calls = [];
  const client = createKinoClient({
    env: { KINO_CITY_ID: '1' },
    now: () => new Date('2026-08-12T00:00:00Z'),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ result: { data: { json: [{ id: 10, name: 'Film' }] } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  assert.deepEqual(await client.listMovies({ days: 2 }), [{ id: 10, name: 'Film' }]);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/trpc/sessions.findMovies');
  assert.deepEqual(JSON.parse(url.searchParams.get('input')), {
    json: { startDate: '2026-08-12', endDate: '2026-08-13' }
  });
  assert.equal(calls[0].options.headers.cookie, 'city=1');
});

test('Kino client expands a configurable seat plan URL', async () => {
  const calls = [];
  const client = createKinoClient({
    env: {
      KINO_CITY_ID: '2',
      KINO_SEAT_PLAN_URL_TEMPLATE: 'https://seat.example/{sessionId}?city={cityId}',
      KINO_SESSION_COOKIE: 'session=test'
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ hall_plan: { places: [] } }), { status: 200 });
    }
  });

  assert.equal(client.seatPlansEnabled, true);
  assert.deepEqual(await client.getSeatPlan({ sessionId: 44, movieId: 5, cinemaId: 6 }), {
    hall_plan: { places: [] }
  });
  assert.equal(calls[0].url, 'https://seat.example/44?city=2');
  assert.equal(calls[0].options.headers.cookie, 'city=2; session=test');
});

test('extractSeatPlanFromHtml reads a server-rendered Next flight payload', () => {
  const payload = '7:{"seance_id":"44","hall_plan":{"places":[{"id":"1","status":1}]}}';
  const html = `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`;

  assert.deepEqual(extractSeatPlanFromHtml(html), {
    seance_id: '44',
    hall_plan: { places: [{ id: '1', status: 1 }] }
  });
});

test('Kino client reads an authenticated seat page when no JSON endpoint is configured', async () => {
  const calls = [];
  const payload = '7:{"seance_id":"44","hall_plan":{"places":[]}}';
  const client = createKinoClient({
    env: { KINO_CITY_ID: '2', KINO_SESSION_COOKIE: 'session=secret' },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(
        `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    }
  });

  const plan = await client.getSeatPlan({ sessionId: 44, movieId: 5, cinemaId: 6 });

  assert.deepEqual(plan.hall_plan, { places: [] });
  assert.equal(calls[0].url, 'https://kino.kz/en/movie/5/tickets/44?cityId=2&cinemaId=6');
  assert.equal(calls[0].options.headers.cookie, 'city=2; session=secret');
});
