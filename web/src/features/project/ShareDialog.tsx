import { Check, Copy, Link2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ErrorNotice } from '../../components/ui.tsx';
import type { ApiError, ShareLink } from '../../lib/api.ts';

/** Creates a read-only link, pinned to the current analysis. The token is shown only once. */
export function ShareDialog({ create, onClose, kind }: { create(): Promise<ShareLink>; onClose(): void; kind: 'wireframe' | 'architecture' }) {
  const [link, setLink] = useState<ShareLink | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<'url' | 'embed' | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const copy = async (what: 'url' | 'embed', text: string) => {
    await navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(what);
  };
  const embed = link ? `<iframe src="${link.embedUrl}" width="100%" height="640" style="border:0" title="CodePilot ${kind}"></iframe>` : '';
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog share-dialog glass" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <header>
          <h2 id="share-title">
            <Link2 size={16} /> Share a read-only {kind}
          </h2>
          <button ref={closeRef} className="tool-btn" aria-label="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </header>
        <p className="small muted">Anyone with the link can view this {kind} (file paths, symbol names and evidence lines) as of the current analysis. Links can be revoked. Source code is never included.</p>
        {error && <ErrorNotice error={error} />}
        {!link ? (
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setLink(await create());
              } catch (e) {
                setError(e as ApiError);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Creating…' : 'Create link'}
          </button>
        ) : (
          <div className="share-fields">
            <label className="filters-title" htmlFor="share-url">
              Link
            </label>
            <div className="share-row">
              <input id="share-url" className="input mono" readOnly value={link.url} onFocus={(e) => e.target.select()} />
              <button className="btn btn-sm" onClick={() => copy('url', link.url)}>
                {copied === 'url' ? <Check size={13} /> : <Copy size={13} />} Copy
              </button>
            </div>
            <label className="filters-title" htmlFor="share-embed">
              Embed
            </label>
            <div className="share-row">
              <input id="share-embed" className="input mono" readOnly value={embed} onFocus={(e) => e.target.select()} />
              <button className="btn btn-sm" onClick={() => copy('embed', embed)}>
                {copied === 'embed' ? <Check size={13} /> : <Copy size={13} />} Copy
              </button>
            </div>
            <p className="faint small">This link is shown once. Create a new one if you lose it.</p>
          </div>
        )}
      </div>
    </div>
  );
}
