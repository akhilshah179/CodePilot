import { SHAPES, shapePath, TYPE_LABELS } from '@codepilot/analyzer/shapes';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { ApiError, NodeType } from '../lib/api.ts';

export function Logo({ to = '/' }: { to?: string }) {
  return (
    <Link to={to} className="logo" aria-label="CodePilot home">
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="12" fill="none" stroke="#2e3429" strokeWidth="1.5" />
        <path d="M16 16 L16 4 A12 12 0 0 1 26.4 10 Z" fill="#ffb020" opacity=".35" />
        <path d="M16 16 L23.5 10.5 M16 16 L9.5 21" stroke="#ff5c5c" strokeWidth="1.4" />
        <circle cx="23.5" cy="10.5" r="2" fill="#eceee6" />
        <circle cx="9.5" cy="21" r="2" fill="#eceee6" />
        <circle cx="16" cy="16" r="2.6" fill="#ffb020" />
      </svg>
      CodePilot
    </Link>
  );
}

export function ShapeIcon({ type, size = 14, color }: { type: NodeType; size?: number; color?: string }) {
  const spec = SHAPES[type];
  const fill = color ?? (type === 'unresolved' ? 'var(--risk)' : type === 'external' ? '#8b9183' : 'var(--node)');
  return (
    <svg width={size} height={size} viewBox="-10 -10 20 20" aria-hidden="true" style={{ flex: 'none' }}>
      <path d={shapePath(type, 0, 0, 6.5)} fill={spec.filled ? fill : 'none'} stroke={spec.filled ? 'none' : fill} strokeWidth={spec.filled ? 0 : 1.8} />
    </svg>
  );
}

export function TypeLabel({ type, count }: { type: NodeType; count?: number }) {
  return (
    <span className="type-label">
      <ShapeIcon type={type} />
      <span>{TYPE_LABELS[type]}</span>
      {count !== undefined && <span className="faint mono">{count}</span>}
    </span>
  );
}

export function ErrorNotice({ error, onRetry }: { error: ApiError | { message: string; action?: { label: string; href: string } }; onRetry?: () => void }) {
  const body = 'body' in error ? error.body : error;
  return (
    <div className="notice notice-risk" role="alert">
      <p>{body.message}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        {body.action && (
          <a className="btn btn-sm btn-primary" href={body.action.href}>
            {body.action.label}
          </a>
        )}
        {onRetry && (
          <button className="btn btn-sm" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

export function Steps({ current }: { current: 1 | 2 | 3 | 4 }) {
  const steps = ['Sign in', 'Select repository', 'Confirm', 'Analysis'];
  return (
    <ol className="steps" aria-label="Onboarding progress">
      {steps.map((s, i) => (
        <li key={s} aria-current={i + 1 === current ? 'step' : undefined} data-done={i + 1 < current || undefined}>
          <span className="mono">{String(i + 1).padStart(2, '0')}</span> {s}
        </li>
      ))}
    </ol>
  );
}

export function EdgeLegend({ compact = false }: { compact?: boolean }) {
  return (
    <ul className={`edge-legend${compact ? ' compact' : ''}`}>
      <li>
        <svg width="34" height="10" aria-hidden="true">
          <path d="M1 5 H26" stroke="var(--dep)" strokeWidth="1.6" />
          <path d="M33 5 L25 1.5 L25 8.5 Z" fill="var(--dep)" />
        </svg>
        <span>
          <strong>Red → dependencies.</strong> {compact ? 'Arrow points to the imported file.' : 'The arrow points to the file being imported; thicker means more symbols.'}
        </span>
      </li>
      <li>
        <svg width="34" height="10" aria-hidden="true">
          <path d="M1 5 H26" stroke="var(--con)" strokeWidth="1.6" />
          <path d="M33 5 L25 1.5 L25 8.5 Z" fill="var(--con)" />
        </svg>
        <span>
          <strong>Blue → consumers.</strong> {compact ? 'Files importing the focus.' : 'Files that import the focused file (on hover or selection).'}
        </span>
      </li>
      <li>
        <svg width="34" height="10" aria-hidden="true">
          <path d="M1 5 H33" stroke="var(--dep)" strokeWidth="1.6" strokeDasharray="4 3" />
        </svg>
        <span>{compact ? 'Dashed: dynamic import()' : 'Dashed → dynamic import(), loaded on demand.'}</span>
      </li>
      <li>
        <svg width="34" height="10" aria-hidden="true">
          <path d="M1 5 H33" stroke="#8b9183" strokeWidth="1.8" strokeDasharray="0.5 4" strokeLinecap="round" />
        </svg>
        <span>{compact ? 'Dotted: unresolved specifier' : 'Dotted gray → import that could not be resolved to a file.'}</span>
      </li>
    </ul>
  );
}

// --- Workspace primitives -------------------------------------------------------------------------

/** Icon-only button with an accessible name and a tooltip that shows its shortcut. */
export function IconButton({ label, shortcut, pressed, onClick, children, disabled }: { label: string; shortcut?: string; pressed?: boolean; onClick?: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className="tool-btn" aria-label={label} aria-pressed={pressed} onClick={onClick} disabled={disabled} data-tip={shortcut ? `${label} · ${shortcut}` : label}>
      {children}
    </button>
  );
}

/** `unknown`: the repository does not show enough evidence to say. */
export type ConfidenceLevel = 'confirmed' | 'strong' | 'possible' | 'unknown';
const CONF_TEXT: Record<ConfidenceLevel, string> = { confirmed: 'Confirmed', strong: 'Strong inference', possible: 'Possible', unknown: 'Unknown' };

/** Confidence is always spelled out; colour only reinforces it (green / amber / neutral). */
export function ConfidenceBadge({ level, compact = false }: { level: ConfidenceLevel; compact?: boolean }) {
  return (
    <span className={`conf conf-${level}`} title={CONF_TEXT[level]}>
      <span className="conf-dot" aria-hidden="true" />
      {compact ? CONF_TEXT[level].split(' ')[0] : CONF_TEXT[level]}
    </span>
  );
}

export interface EvidenceLike {
  kind: string;
  file: string;
  line?: number;
  snippet?: string;
  detail: string;
}

/** A single piece of repository evidence: what it shows, where, and the (redacted) line itself. */
export function EvidenceItem({ ev, href }: { ev: EvidenceLike; href?: string | null }) {
  const where = `${ev.file}${ev.line ? `:${ev.line}` : ''}`;
  return (
    <li className="ev">
      <div className="ev-head">
        <span className="ev-kind mono">{ev.kind}</span>
        <span className="ev-detail">{ev.detail}</span>
      </div>
      {href ? (
        <a className="ev-where mono" href={href} target="_blank" rel="noreferrer" title={`Open ${where}`}>
          {where}
        </a>
      ) : (
        <span className="ev-where mono">{where}</span>
      )}
      {ev.snippet && <code className="ev-snippet">{ev.snippet}</code>}
    </li>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint faint">{hint}</div>}
    </div>
  );
}
