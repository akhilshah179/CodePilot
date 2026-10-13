import { useEffect, useState } from 'react';
import { api } from './api.ts';

export function NoteEvents({ id }: { id: string }) {
  const [events, setEvents] = useState<string[]>([]);
  useEffect(() => {
    const source = new EventSource(api.eventsUrl(id));
    source.onmessage = (e) => setEvents((list) => [...list, e.data]);
    return () => source.close();
  }, [id]);
  return <ul>{events.map((e) => <li key={e}>{e}</li>)}</ul>;
}
