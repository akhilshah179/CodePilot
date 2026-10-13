import React from 'react';
import { Button, Card } from './components';
import { useSession } from './hooks/useSession.js';
import { missingThing } from './does-not-exist';

export function renderApp(cfg: unknown, label: string) {
  useSession();
  return (
    <Card>
      <Button />
      {String(missingThing)}
    </Card>
  );
}
