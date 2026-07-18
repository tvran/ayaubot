import { readFileSync } from 'node:fs';

const defaultConfigUrl = new URL('../../config/percent-game.json', import.meta.url);
const resultKeyPrefix = 'percent-game:v1';

const configError = (message) => new Error(`Invalid percent game config: ${message}`);

const normalizedToken = (value) => String(value || '').trim().toLowerCase();

const displayMention = (user = {}) => {
  if (user.username) return `@${user.username}`;
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || String(user.id || 'unknown');
};

const renderTemplate = (template, values) =>
  template.replace(/\{(user|percent|parameter|command|parameters)\}/g, (placeholder, name) =>
    String(values[name] ?? placeholder));

const cachedResult = (value) => {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || !Number.isInteger(parsed.percent) || parsed.percent < 0 || parsed.percent > 100) return null;
  if (typeof parsed.phrase !== 'string' || !parsed.phrase) return null;
  return parsed;
};

export const loadPercentGameConfig = (url = defaultConfigUrl) => {
  const config = JSON.parse(readFileSync(url, 'utf8'));
  const command = normalizedToken(config.command);
  const ttlSeconds = Number(config.ttlSeconds);
  const messages = config.messages || {};

  if (!/^[a-z_]+$/.test(command)) throw configError('command must contain only a-z and underscore');
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw configError('ttlSeconds must be a positive integer');
  for (const name of ['usage', 'unknownParameter', 'storageUnavailable', 'missingPlayer']) {
    if (typeof messages[name] !== 'string' || !messages[name]) throw configError(`messages.${name} must be a non-empty string`);
  }
  if (!config.parameters || typeof config.parameters !== 'object' || Array.isArray(config.parameters)) {
    throw configError('parameters must be an object');
  }

  const parameters = new Map();
  const aliases = new Map();
  for (const [rawName, rawDefinition] of Object.entries(config.parameters)) {
    const name = normalizedToken(rawName);
    const definition = rawDefinition || {};
    if (!name || /\s/.test(name)) throw configError(`parameter "${rawName}" must be one token`);
    if (!Array.isArray(definition.phrases) || !definition.phrases.length ||
        definition.phrases.some((phrase) => typeof phrase !== 'string' || !phrase)) {
      throw configError(`parameters.${rawName}.phrases must contain non-empty strings`);
    }
    if (definition.aliases !== undefined && !Array.isArray(definition.aliases)) {
      throw configError(`parameters.${rawName}.aliases must be an array`);
    }

    const tokens = [name, ...(definition.aliases || []).map(normalizedToken)];
    if (tokens.some((token) => !token || /\s/.test(token))) {
      throw configError(`parameters.${rawName}.aliases must contain single tokens`);
    }
    for (const token of tokens) {
      if (aliases.has(token)) throw configError(`duplicate parameter or alias "${token}"`);
      aliases.set(token, name);
    }
    parameters.set(name, { name, phrases: [...definition.phrases] });
  }
  if (!parameters.size) throw configError('at least one parameter is required');

  return { command, ttlSeconds, messages: { ...messages }, parameters, aliases };
};

export const createPercentGameService = ({
  redis,
  config = loadPercentGameConfig(),
  random = Math.random
} = {}) => {
  const parameterNames = Array.from(config.parameters.keys());
  const templateValues = {
    command: config.command,
    parameters: parameterNames.join(', ')
  };
  const messageFromTemplate = (name) => renderTemplate(config.messages[name], templateValues);

  const playText = async (message, args) => {
    const tokens = String(args || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length !== 1) return messageFromTemplate('usage');

    const parameterName = config.aliases.get(tokens[0]);
    const parameter = config.parameters.get(parameterName);
    if (!parameter) return messageFromTemplate('unknownParameter');
    if (!redis) return messageFromTemplate('storageUnavailable');

    const user = message?.reply_to_message ? message.reply_to_message.from : message?.from;
    if (!user?.id) return messageFromTemplate('missingPlayer');

    const key = `${resultKeyPrefix}:${user.id}:${encodeURIComponent(parameter.name)}`;
    let result = cachedResult(await redis.get(key));

    if (!result) {
      const percent = Math.min(100, Math.max(0, Math.floor(random() * 101)));
      const phraseIndex = Math.min(
        parameter.phrases.length - 1,
        Math.max(0, Math.floor(random() * parameter.phrases.length))
      );
      const candidate = { percent, phrase: parameter.phrases[phraseIndex] };
      const stored = await redis.set(key, candidate, { ex: config.ttlSeconds, nx: true });
      result = stored ? candidate : cachedResult(await redis.get(key));

      if (!result) {
        await redis.set(key, candidate, { ex: config.ttlSeconds });
        result = candidate;
      }
    }

    return renderTemplate(result.phrase, {
      user: displayMention(user),
      percent: result.percent,
      parameter: parameter.name
    });
  };

  return {
    command: config.command,
    enabled: Boolean(redis),
    parameterNames,
    playText
  };
};
