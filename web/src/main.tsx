import '@fontsource-variable/inter/index.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles/base.css';
import './styles/landing.css';
import './styles/landing3d.css';
import './styles/onboarding.css';
import './styles/project.css';
import './styles/workspace.css';
import './styles/architecture.css';
import './styles/wireframe.css';
import './styles/architecture-v3.css';
import './styles/intelligence.css';
import './styles/automation.css';
import './styles/collective.css';
import './styles/code.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { router } from './router.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
