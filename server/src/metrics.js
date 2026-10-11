import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const counters = {
  journals: new client.Counter({ name: 'ledger_journals_total', help: 'Journals posted', labelNames: ['kind', 'direction'], registers: [registry] }),
  outbox: new client.Counter({ name: 'outbox_processed_total', help: 'Outbox events processed', labelNames: ['topic', 'result'], registers: [registry] }),
};
export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds', help: 'HTTP latency', labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry],
});
