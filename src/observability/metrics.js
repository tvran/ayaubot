const metricName = (value) => String(value).replace(/[^a-zA-Z0-9_:]/g, '_');

const labelKey = (labels = {}) => JSON.stringify(Object.entries(labels).sort());

const labelText = (labels = {}) => {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  return `{${entries.map(([key, value]) =>
    `${metricName(key)}="${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`;
};

export const createMetrics = ({ now = () => Date.now() } = {}) => {
  const counters = new Map();
  const gauges = new Map();
  const observations = new Map();
  const startedAt = now();

  const entry = (collection, name, labels) => {
    const key = `${name}:${labelKey(labels)}`;
    if (!collection.has(key)) collection.set(key, { name: metricName(name), labels: { ...labels }, value: 0 });
    return collection.get(key);
  };

  const increment = (name, labels = {}, amount = 1) => {
    entry(counters, name, labels).value += amount;
  };

  const setGauge = (name, value, labels = {}) => {
    entry(gauges, name, labels).value = Number(value) || 0;
  };

  const observe = (name, value, labels = {}) => {
    const key = `${name}:${labelKey(labels)}`;
    if (!observations.has(key)) {
      observations.set(key, {
        name: metricName(name),
        labels: { ...labels },
        count: 0,
        sum: 0,
        max: 0
      });
    }
    const observation = observations.get(key);
    const numeric = Math.max(0, Number(value) || 0);
    observation.count += 1;
    observation.sum += numeric;
    observation.max = Math.max(observation.max, numeric);
  };

  const render = (extraGauges = []) => {
    const memory = process.memoryUsage();
    const lines = [
      `process_uptime_seconds ${Math.max(0, (now() - startedAt) / 1000)}`,
      `process_resident_memory_bytes ${memory.rss}`,
      `process_heap_used_bytes ${memory.heapUsed}`
    ];
    for (const metric of counters.values()) lines.push(`${metric.name}${labelText(metric.labels)} ${metric.value}`);
    for (const metric of gauges.values()) lines.push(`${metric.name}${labelText(metric.labels)} ${metric.value}`);
    for (const metric of extraGauges) {
      lines.push(`${metricName(metric.name)}${labelText(metric.labels)} ${Number(metric.value) || 0}`);
    }
    for (const metric of observations.values()) {
      lines.push(`${metric.name}_count${labelText(metric.labels)} ${metric.count}`);
      lines.push(`${metric.name}_sum${labelText(metric.labels)} ${metric.sum}`);
      lines.push(`${metric.name}_max${labelText(metric.labels)} ${metric.max}`);
    }
    return `${lines.join('\n')}\n`;
  };

  return { increment, setGauge, observe, render };
};

export const startEventLoopLagMonitor = ({ metrics, intervalMs = 1_000 } = {}) => {
  if (!metrics) return () => {};
  let expected = Date.now() + intervalMs;
  const timer = setInterval(() => {
    const current = Date.now();
    metrics.setGauge('node_event_loop_lag_seconds', Math.max(0, current - expected) / 1000);
    expected = current + intervalMs;
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
};
