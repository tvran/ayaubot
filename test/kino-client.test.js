import assert from 'node:assert/strict';
import test from 'node:test';
import { createTicketonClient } from '../src/kino/client.js';

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('Ticketon client requests only Astana cinema events and rejects other categories', async () => {
  const calls = [];
  const client = createTicketonClient({
    now: () => new Date('2026-08-12T00:00:00Z'),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        data: [
          {
            event_id: 10,
            name: 'Film',
            slug: 'film',
            categories: [{ alias: 'cinema', is_main: true }]
          },
          {
            event_id: 11,
            name: 'Concert',
            slug: 'concert',
            categories: [
              { alias: 'concerts', is_main: true },
              { alias: 'cinema', is_main: false }
            ]
          }
        ],
        meta: { total_pages: 1 }
      });
    }
  });

  assert.deepEqual(await client.listMovies({ days: 2 }), [{
    id: 10,
    name: 'Film',
    slug: 'film',
    categories: [{ alias: 'cinema', is_main: true }]
  }]);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/catalog/v2/events');
  assert.equal(url.searchParams.get('city'), 'astana');
  assert.equal(url.searchParams.get('category'), 'cinema');
  assert.equal(url.searchParams.get('session_date_from'), '2026-08-12T00:00:00.000Z');
  assert.equal(url.searchParams.get('session_date_to'), '2026-08-13T23:59:59.999Z');
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.equal(calls[0].options.headers.cookie, undefined);
});

test('Ticketon client loads cinema venues and normalizes all dated sessions', async () => {
  const calls = [];
  const client = createTicketonClient({
    fetchImpl: async (url) => {
      calls.push(String(url));
      const path = new URL(url).pathname;
      if (path.includes('dynamic-filters/venues')) {
        return jsonResponse({ data: [{ venue_id: 20, name: 'Cinema', slug: 'cinema' }] });
      }
      return jsonResponse({
        data: [{
          date: '2026-08-12',
          sessions: [{
            id: 30,
            start_time: '2026-08-12T20:15:00+05:00',
            end_time: '2026-08-12T22:00:00+05:00',
            sales_status: 'on_sale',
            venue_id: 20,
            venue: 'Cinema',
            address: 'Astana',
            hall_id: 40,
            hall: 'Hall 1',
            min_price: '6000',
            currency: 'KZT'
          }]
        }]
      });
    }
  });

  assert.deepEqual(await client.listCinemas(), [{ id: 20, name: 'Cinema', slug: 'cinema' }]);
  assert.deepEqual(await client.listSessions(10), [{
    id: 30,
    date: '2026-08-12',
    startTime: '2026-08-12T20:15:00+05:00',
    endTime: '2026-08-12T22:00:00+05:00',
    salesStatus: 'on_sale',
    language: undefined,
    minPrice: '6000',
    currency: 'KZT',
    cinema: { id: 20, name: 'Cinema', address: 'Astana' },
    hall: { id: 40, name: 'Hall 1' }
  }]);
  const venueUrl = new URL(calls[0]);
  assert.equal(venueUrl.searchParams.get('category_alias'), 'cinema');
  assert.equal(venueUrl.searchParams.get('city_code'), 'astana');
  assert.match(calls[1], /event\/v1\/events\/10\/sessions/u);
});

test('Ticketon client joins public sector geometry with live availability without auth', async () => {
  const calls = [];
  const client = createTicketonClient({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      const path = new URL(url).pathname;
      if (path.endsWith('/hall/static')) {
        return jsonResponse({
          sectors: [
            { id: 50, name: 'Основной', is_unbound_seats: false },
            { id: 51, name: 'Фан-зона', is_unbound_seats: true }
          ]
        });
      }
      if (path.endsWith('/hall/dynamic')) {
        return jsonResponse({
          sectors: [
            { id: 50, status: 'active', is_unbound_seats: false },
            { id: 51, status: 'active', is_unbound_seats: true }
          ]
        });
      }
      if (path.endsWith('/sector/50/static')) {
        return jsonResponse({
          seats: [
            { id: 60, row: '7', num: '8', x: 10, y: 20, w: 30, h: 30, tariff_id: 70 },
            { id: 61, row: '7', num: '9', x: 42, y: 20, w: 30, h: 30, tariff_id: 70 }
          ]
        });
      }
      if (path.endsWith('/sector/50/dynamic')) {
        return jsonResponse({ seats: [{ id: 60, count: 1 }, { id: 61, count: 0 }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.deepEqual(await client.getSeatPlan({ sessionId: 30 }), {
    sessionId: '30',
    sections: [{
      id: '50',
      name: 'Основной',
      hallPlan: {
        places: [
          {
            id: '60', row: '7', place: '8', status: 1, x: 10, y: 20,
            width: 30, height: 30, tariffId: 70
          },
          {
            id: '61', row: '7', place: '9', status: 0, x: 42, y: 20,
            width: 30, height: 30, tariffId: 70
          }
        ]
      }
    }]
  });
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.options.headers.authorization, undefined);
    assert.equal(call.options.headers.cookie, undefined);
  }
  assert.equal(
    client.eventUrl({ slug: 'test-film' }, 30),
    'https://ticketon.kz/cinema/event/test-film/session/30'
  );
});
