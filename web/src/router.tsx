import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter } from 'react-router';
import { Analysis } from './pages/Analysis.tsx';
import { ConfirmRepo } from './pages/ConfirmRepo.tsx';
import { NotFound, SampleRedirect } from './pages/misc.tsx';
import { RepoSelect } from './pages/RepoSelect.tsx';
import { SignIn } from './pages/SignIn.tsx';

// The workspaces (canvas renderer, architecture diagram) load on demand.
const ProjectHome = lazy(() => import('./pages/ProjectHome.tsx').then((m) => ({ default: m.ProjectHome })));
const Landing = lazy(() => import('./pages/Landing.tsx').then((m) => ({ default: m.Landing })));
const SharedView = lazy(() => import('./pages/SharedView.tsx').then((m) => ({ default: m.SharedView })));
const load = (el: ReactNode) => <Suspense fallback={<div className="view-pad faint">Loading…</div>}>{el}</Suspense>;

export const router = createBrowserRouter([
  { path: '/', element: load(<Landing />) },
  { path: '/signin', element: <SignIn /> },
  { path: '/onboarding/repos', element: <RepoSelect /> },
  { path: '/onboarding/confirm/:owner/:repo', element: <ConfirmRepo /> },
  { path: '/projects/:id/analysis', element: <Analysis /> },
  { path: '/projects/:id', element: load(<ProjectHome />) },
  { path: '/sample', element: <SampleRedirect /> },
  { path: '/share/:token', element: load(<SharedView />) },
  { path: '/embed/:token', element: load(<SharedView embed />) },
  { path: '*', element: <NotFound /> },
]);
