import { renderApp } from './app';
import type { Config } from '@/config/types';
import './styles.css';
import { formatDate } from '~lib/format';

const loadAdmin = () => import('./pages/admin');
const cfg: Config = { debug: false };
renderApp(cfg, formatDate(new Date()));
export { loadAdmin };
