import { fetchWithTimeout } from '../runtime/fetch.js';

const defaultBaseUrl = 'https://kino.kz';
const defaultTimeZone = 'Asia/Almaty';

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const unwrapResponse = (body) => body?.result?.data?.json ?? body?.data?.json ?? body?.data ?? body;

const errorMessage = (body, status) =>
  body?.error?.json?.message || body?.error?.message || body?.message || `HTTP ${status}`;

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

const replaceTemplate = (template, values) => template.replace(/\{([a-zA-Z]+)\}/gu, (match, key) =>
  key in values ? encodeURIComponent(String(values[key])) : match);

const balancedJsonObjects = (value, marker) => {
  const objects = [];
  let markerIndex = value.indexOf(marker);
  while (markerIndex >= 0) {
    const starts = [
      value.lastIndexOf('{"seance_id"', markerIndex),
      value.lastIndexOf('{"hall_plan"', markerIndex)
    ].filter((start) => start >= 0 && markerIndex - start < 50_000);
    for (const start of starts) {
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let index = start; index < value.length; index += 1) {
        const character = value[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') quoted = false;
          continue;
        }
        if (character === '"') quoted = true;
        else if (character === '{') depth += 1;
        else if (character === '}') {
          depth -= 1;
          if (depth === 0) {
            objects.push(value.slice(start, index + 1));
            break;
          }
        }
      }
    }
    markerIndex = value.indexOf(marker, markerIndex + marker.length);
  }
  return objects;
};

export const extractSeatPlanFromHtml = (html) => {
  const chunks = [];
  const pattern = /self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/gsu;
  for (const match of String(html || '').matchAll(pattern)) {
    try {
      chunks.push(JSON.parse(match[1]));
    } catch {}
  }
  const candidates = [String(html || ''), chunks.join('')];
  for (const candidate of candidates) {
    for (const json of balancedJsonObjects(candidate, '"hall_plan"')) {
      try {
        const parsed = JSON.parse(json);
        if (parsed?.hall_plan?.places) return parsed;
      } catch {}
    }
  }
  return null;
};

export const createKinoClient = ({
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date()
} = {}) => {
  const baseUrl = String(env.KINO_BASE_URL || defaultBaseUrl).replace(/\/+$/u, '');
  const cityId = positiveInteger(env.KINO_CITY_ID, 2);
  const timeZone = env.KINO_TIME_ZONE || defaultTimeZone;
  const timeoutMs = positiveInteger(env.KINO_REQUEST_TIMEOUT_MS, 15_000);
  const seatPlanUrlTemplate = String(env.KINO_SEAT_PLAN_URL_TEMPLATE || '').trim();
  const seatPlanProcedure = String(env.KINO_SEAT_PLAN_PROCEDURE || '').trim();
  const sessionCookie = String(env.KINO_SESSION_COOKIE || '').trim();
  const siteCookie = [
    `city=${cityId}`,
    sessionCookie
  ].filter(Boolean).join('; ');

  const requestJson = async (url, options = {}, label = 'Kino.kz request') => {
    const response = await fetchWithTimeout(fetchImpl, url, {
      ...options,
      headers: {
        accept: 'application/json',
        'user-agent': 'AyauBot/0.1 kino monitor',
        cookie: siteCookie,
        ...options.headers
      }
    }, { timeoutMs, label });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.error) {
      const error = new Error(`${label}: ${errorMessage(body, response.status)}`);
      if ([401, 403, 404].includes(response.status)) error.code = 'kino_endpoint_unavailable';
      throw error;
    }
    return unwrapResponse(body);
  };

  const trpcQuery = async (procedure, input) => {
    const url = new URL(`${baseUrl}/api/trpc/${procedure}`);
    url.searchParams.set('input', JSON.stringify({ json: input }));
    return requestJson(url, {
      headers: { 'x-trpc-source': 'nextjs-react' }
    }, `Kino.kz ${procedure}`);
  };

  const today = () => zonedDate(now(), timeZone);

  const listMovies = async ({ days = 7 } = {}) => {
    const startDate = today();
    const endDate = addDays(startDate, Math.max(0, days - 1));
    const movies = await trpcQuery('sessions.findMovies', { startDate, endDate });
    return Array.isArray(movies) ? movies : [];
  };

  const listCinemas = async () => {
    const cinemas = await trpcQuery('cinema.getCinemas', null);
    return Array.isArray(cinemas) ? cinemas : [];
  };

  const listSessions = async (movieId, date) => {
    const result = await trpcQuery('sessions.getSessions', {
      id: Number(movieId),
      date
    });
    return Array.isArray(result?.sessions) ? result.sessions : [];
  };

  const getSeatPlan = async ({ sessionId, movieId, cinemaId }) => {
    const input = {
      seance_id: Number(sessionId),
      city_id: cityId,
      client: 'web'
    };
    if (seatPlanProcedure) return trpcQuery(seatPlanProcedure, input);
    if (!seatPlanUrlTemplate && !sessionCookie) {
      const error = new Error('KINO_SESSION_COOKIE, KINO_SEAT_PLAN_URL_TEMPLATE or KINO_SEAT_PLAN_PROCEDURE is required for seat monitoring.');
      error.code = 'kino_seat_plan_not_configured';
      throw error;
    }

    const url = seatPlanUrlTemplate ? replaceTemplate(seatPlanUrlTemplate, {
      sessionId,
      seanceId: sessionId,
      movieId,
      cinemaId,
      cityId,
      input: JSON.stringify({ json: input })
    }) : `${baseUrl}/en/movie/${movieId}/tickets/${sessionId}` +
      `?cityId=${cityId}&cinemaId=${cinemaId}`;
    const response = await fetchWithTimeout(fetchImpl, url, {
      headers: {
        accept: 'application/json, text/html;q=0.9',
        'user-agent': 'AyauBot/0.1 kino monitor',
        cookie: siteCookie
      }
    }, { timeoutMs, label: 'Kino.kz seat plan' });
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('json')) {
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.error) {
        const error = new Error(`Kino.kz seat plan: ${errorMessage(body, response.status)}`);
        if ([401, 403, 404].includes(response.status)) error.code = 'kino_endpoint_unavailable';
        throw error;
      }
      return unwrapResponse(body);
    }
    const html = await response.text();
    const plan = extractSeatPlanFromHtml(html);
    if (!response.ok || !plan) {
      const error = new Error('Kino.kz seat plan is unavailable: refresh KINO_SESSION_COOKIE or configure the current read-only seat endpoint.');
      error.code = 'kino_endpoint_unavailable';
      throw error;
    }
    return plan;
  };

  return {
    baseUrl,
    cityId,
    timeZone,
    seatPlansEnabled: Boolean(seatPlanProcedure || seatPlanUrlTemplate || sessionCookie),
    today,
    addDays,
    listMovies,
    listCinemas,
    listSessions,
    getSeatPlan
  };
};
