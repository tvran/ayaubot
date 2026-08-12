import { fetchWithTimeout } from '../runtime/fetch.js';

const defaultBaseUrl = 'https://ticketon.kz';
const defaultApiUrl = 'https://api-gw.ticketon.kz';
const defaultCityCode = 'astana';
const defaultTimeZone = 'Asia/Almaty';
const cinemaCategory = 'cinema';

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const zonedDate = (instant, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(instant);
  const values = Object.fromEntries(parts
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const addDays = (date, days) => {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return value.toISOString().slice(0, 10);
};

const isCinemaEvent = (event) => {
  const categories = Array.isArray(event?.categories) ? event.categories : [];
  const mainCategory = categories.find((category) => category?.is_main === true);
  if (mainCategory) return mainCategory.alias === cinemaCategory;
  return categories.some((category) => category?.alias === cinemaCategory);
};

const normalizeEvent = (event) => ({
  id: event.event_id,
  name: event.name,
  slug: event.slug,
  categories: event.categories || []
});

const normalizeSession = (session, date) => ({
  id: session.id,
  date,
  startTime: session.start_time,
  endTime: session.end_time,
  salesStatus: session.sales_status,
  language: session.language,
  minPrice: session.min_price,
  currency: session.currency,
  cinema: {
    id: session.venue_id,
    name: session.venue || session.venue_details?.name,
    address: session.address || session.venue_details?.address
  },
  hall: {
    id: session.hall_id,
    name: session.hall
  }
});

const errorMessage = (body, status) =>
  body?.message || body?.error?.message || body?.error || `HTTP ${status}`;

export const createTicketonClient = ({
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date()
} = {}) => {
  const baseUrl = String(env.TICKETON_BASE_URL || defaultBaseUrl).replace(/\/+$/u, '');
  const apiUrl = String(env.TICKETON_API_URL || defaultApiUrl).replace(/\/+$/u, '');
  const cityId = positiveInteger(env.TICKETON_CITY_ID, 1);
  const cityCode = String(env.TICKETON_CITY_CODE || defaultCityCode).trim().toLowerCase();
  const timeZone = env.TICKETON_TIME_ZONE || defaultTimeZone;
  const timeoutMs = positiveInteger(env.TICKETON_REQUEST_TIMEOUT_MS, 15_000);

  const requestJson = async (path, searchParams, label) => {
    const url = new URL(path, `${apiUrl}/`);
    for (const [key, value] of Object.entries(searchParams || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const response = await fetchWithTimeout(fetchImpl, url, {
      headers: {
        accept: 'application/json',
        'accept-language': 'ru',
        'user-agent': 'AyauBot/0.1 Ticketon cinema monitor'
      }
    }, { timeoutMs, label });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) {
      const error = new Error(`${label}: ${errorMessage(body, response.status)}`);
      error.code = 'ticketon_request_failed';
      error.status = response.status;
      throw error;
    }
    return body;
  };

  const today = () => zonedDate(now(), timeZone);

  const listMovies = async ({ days = 7 } = {}) => {
    const startDate = today();
    const endDate = addDays(startDate, Math.max(0, days - 1));
    const loadPage = (page) => requestJson('catalog/v2/events', {
      city: cityCode,
      category: cinemaCategory,
      session_date_from: `${startDate}T00:00:00.000Z`,
      session_date_to: `${endDate}T23:59:59.999Z`,
      page,
      page_size: 100,
      sort_by: 'next_session_at',
      sort_dir: 'asc'
    }, 'Ticketon cinema catalog');

    const first = await loadPage(1);
    const pages = Math.max(positiveInteger(first?.meta?.total_pages, 1), 1);
    const rest = pages > 1
      ? await Promise.all(Array.from({ length: pages - 1 }, (_, index) => loadPage(index + 2)))
      : [];
    return [first, ...rest]
      .flatMap((page) => Array.isArray(page?.data) ? page.data : [])
      .filter(isCinemaEvent)
      .map(normalizeEvent);
  };

  const listCinemas = async () => {
    const result = await requestJson('catalog/v1/dynamic-filters/venues', {
      category_alias: cinemaCategory,
      city_code: cityCode
    }, 'Ticketon cinema venues');
    return (Array.isArray(result?.data) ? result.data : []).map((venue) => ({
      id: venue.venue_id,
      name: venue.name,
      slug: venue.slug
    }));
  };

  const listSessions = async (movieId) => {
    const result = await requestJson(`event/v1/events/${encodeURIComponent(movieId)}/sessions`, {
      all_dates: 'true',
      city_id: cityId
    }, 'Ticketon movie sessions');
    return (Array.isArray(result?.data) ? result.data : []).flatMap((group) =>
      (Array.isArray(group?.sessions) ? group.sessions : [])
        .map((session) => normalizeSession(session, group.date)));
  };

  const getSeatPlan = async ({ sessionId }) => {
    const [staticHall, dynamicHall] = await Promise.all([
      requestJson(`event-widget/v1/session/${encodeURIComponent(sessionId)}/hall/static`, null,
        'Ticketon static hall'),
      requestJson(`event-widget/v1/session/${encodeURIComponent(sessionId)}/hall/dynamic`, null,
        'Ticketon hall availability')
    ]);
    const dynamicSectors = new Map((Array.isArray(dynamicHall?.sectors) ? dynamicHall.sectors : [])
      .map((sector) => [String(sector.id), sector]));
    const sectors = (Array.isArray(staticHall?.sectors) ? staticHall.sectors : []).filter((sector) => {
      const dynamic = dynamicSectors.get(String(sector.id));
      return !sector.is_unbound_seats && !dynamic?.is_unbound_seats && dynamic?.status !== 'inactive';
    });

    const sections = await Promise.all(sectors.map(async (sector) => {
      const [staticSector, dynamicSector] = await Promise.all([
        requestJson(
          `event-widget/v1/session/${encodeURIComponent(sessionId)}/sector/${encodeURIComponent(sector.id)}/static`,
          null,
          'Ticketon static sector'
        ),
        requestJson(
          `event-widget/v1/session/${encodeURIComponent(sessionId)}/sector/${encodeURIComponent(sector.id)}/dynamic`,
          null,
          'Ticketon sector availability'
        )
      ]);
      const availability = new Map((Array.isArray(dynamicSector?.seats) ? dynamicSector.seats : [])
        .map((seat) => [String(seat.id), Number(seat.count)]));
      const places = (Array.isArray(staticSector?.seats) ? staticSector.seats : []).map((seat) => ({
        id: String(seat.id),
        row: String(seat.row),
        place: String(seat.num),
        status: (availability.get(String(seat.id)) || 0) > 0 ? 1 : 0,
        x: seat.x,
        y: seat.y,
        width: seat.w,
        height: seat.h,
        tariffId: seat.tariff_id
      }));
      return {
        id: String(sector.id),
        name: sector.name,
        hallPlan: { places }
      };
    }));

    return { sessionId: String(sessionId), sections };
  };

  const eventUrl = ({ slug }, sessionId) => {
    const event = `${baseUrl}/cinema/event/${encodeURIComponent(slug)}`;
    return sessionId ? `${event}/session/${encodeURIComponent(sessionId)}` : event;
  };

  return {
    baseUrl,
    apiUrl,
    cityId,
    cityCode,
    timeZone,
    today,
    addDays,
    listMovies,
    listCinemas,
    listSessions,
    getSeatPlan,
    eventUrl
  };
};
