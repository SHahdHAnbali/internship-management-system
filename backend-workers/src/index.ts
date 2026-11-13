import { createApp } from './app';
import type { Bindings } from './config';
import { createScheduledHandler } from './scheduled';

const app = createApp();

export default {
  fetch: app.fetch,
  scheduled: createScheduledHandler(),
} satisfies ExportedHandler<Bindings>;
