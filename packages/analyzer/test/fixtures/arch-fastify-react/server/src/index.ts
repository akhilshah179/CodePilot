import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { createNote, listNotes } from './notes.ts';

const app = Fastify();
await app.register(cookie);

app.addHook('onRequest', async (request) => {
  // CSRF: state-changing requests must come from our own origin.
  if (request.method !== 'GET' && request.headers.origin !== process.env.APP_ORIGIN) throw new Error('Cross-origin request rejected');
});

app.get('/api/notes', async () => {
  return { notes: await listNotes() };
});

app.post<{ Body: { title: string } }>('/api/notes', async (request) => {
  const note = await createNote(request.body.title);
  return { id: note.id, title: note.title };
});

app.get<{ Params: { id: string } }>('/api/notes/:id/events', async (request, reply) => {
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
  reply.raw.write(`data: ${request.params.id}\n\n`);
});

await app.listen({ port: 3000 });
