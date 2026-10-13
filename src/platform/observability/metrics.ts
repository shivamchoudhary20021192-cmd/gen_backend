/**
 * Prometheus metrics, without a dependency.
 *
 * Counters, gauges and histograms with labels, rendered in the text exposition
 * format at GET /metrics. Enough to alert on what matters for a platform — error
 * rate per route, job failures, webhook delivery health, queue depth — and small
 * enough to read in one sitting.
 *
 * Label cardinality is the caller's responsibility: label by route pattern and
 * job type, never by shop id or order number, or the series count explodes.
 */

type Labels = Record<string, string | number>;

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((name) => `${name}="${String(labels[name]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
    .join(',');
}

class Counter {
  value = 0;
  inc(by = 1): void {
    this.value += by;
  }
}

class Gauge {
  value = 0;
  set(value: number): void {
    this.value = value;
  }
}

class Histogram {
  readonly counts: number[];
  sum = 0;
  count = 0;
  constructor(readonly buckets: number[]) {
    this.counts = new Array(buckets.length).fill(0);
  }
  observe(value: number): void {
    this.sum += value;
    this.count += 1;
    for (let i = 0; i < this.buckets.length; i += 1) if (value <= this.buckets[i]) this.counts[i] += 1;
  }
}

interface Family<T> {
  help: string;
  series: Map<string, T>;
}

const counters = new Map<string, Family<Counter>>();
const gauges = new Map<string, Family<Gauge>>();
const histograms = new Map<string, Family<Histogram>>();
const collectors: (() => Promise<void> | void)[] = [];

function family<T>(store: Map<string, Family<T>>, name: string, help: string): Family<T> {
  let found = store.get(name);
  if (!found) {
    found = { help, series: new Map() };
    store.set(name, found);
  }
  return found;
}

export const metrics = {
  counter(name: string, labels: Labels = {}, help = name): Counter {
    const f = family(counters, name, help);
    const k = key(labels);
    let series = f.series.get(k);
    if (!series) f.series.set(k, (series = new Counter()));
    return series;
  },

  gauge(name: string, labels: Labels = {}, help = name): Gauge {
    const f = family(gauges, name, help);
    const k = key(labels);
    let series = f.series.get(k);
    if (!series) f.series.set(k, (series = new Gauge()));
    return series;
  },

  histogram(name: string, labels: Labels = {}, help = name, buckets = DEFAULT_BUCKETS): Histogram {
    const f = family(histograms, name, help);
    const k = key(labels);
    let series = f.series.get(k);
    if (!series) f.series.set(k, (series = new Histogram(buckets)));
    return series;
  },

  /** Runs before each scrape — for gauges read from the database (queue depth). */
  onCollect(collector: () => Promise<void> | void): void {
    collectors.push(collector);
  },

  async render(): Promise<string> {
    for (const collect of collectors) {
      try {
        await collect();
      } catch {
        // A failing collector must not take /metrics down with it.
      }
    }

    const lines: string[] = [];
    for (const [name, f] of counters) {
      lines.push(`# HELP ${name} ${f.help}`, `# TYPE ${name} counter`);
      for (const [labels, series] of f.series) lines.push(`${name}${labels ? `{${labels}}` : ''} ${series.value}`);
    }
    for (const [name, f] of gauges) {
      lines.push(`# HELP ${name} ${f.help}`, `# TYPE ${name} gauge`);
      for (const [labels, series] of f.series) lines.push(`${name}${labels ? `{${labels}}` : ''} ${series.value}`);
    }
    for (const [name, f] of histograms) {
      lines.push(`# HELP ${name} ${f.help}`, `# TYPE ${name} histogram`);
      for (const [labels, series] of f.series) {
        const prefix = labels ? `${labels},` : '';
        series.buckets.forEach((bucket, i) => lines.push(`${name}_bucket{${prefix}le="${bucket}"} ${series.counts[i]}`));
        lines.push(`${name}_bucket{${prefix}le="+Inf"} ${series.count}`);
        lines.push(`${name}_sum${labels ? `{${labels}}` : ''} ${series.sum}`);
        lines.push(`${name}_count${labels ? `{${labels}}` : ''} ${series.count}`);
      }
    }
    return `${lines.join('\n')}\n`;
  },
};
