import { Siren } from 'lucide-react';
import { useState } from 'react';
import { ErrorNotice } from '../../components/ui.tsx';
import { api, type ApiError, type IncidentTagResult } from '../../lib/api.ts';

/**
 * Tag this node with an incident. The tag and its description stay with this project; with
 * Collective Intelligence consent, only "an incident on a <kind> element in <month>" is shared.
 */
export function IncidentTag({ projectId, nodeId }: { projectId: string; nodeId: string }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [source, setSource] = useState('manual');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<IncidentTagResult | null>(null);

  if (!open)
    return (
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(true)}>
        <Siren size={13} /> Tag an incident
      </button>
    );

  return (
    <form
      className="incident-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          setDone(await api.incidentTag(projectId, nodeId, { month, source, description: description.trim() || undefined }));
        } catch (err) {
          setError(err as ApiError);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="small muted">Record that this element was involved in an incident. The description is kept with this project only and is never shared.</p>
      {error && <ErrorNotice error={error} />}
      {done ? (
        <p className="small" role="status">
          Tagged for {done.month}. {done.note}
        </p>
      ) : (
        <>
          <div className="incident-row">
            <label className="small">
              Month
              <input className="input input-sm" type="month" value={month} onChange={(e) => setMonth(e.target.value)} required />
            </label>
            <label className="small">
              Source
              <select className="select select-sm" value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="manual">Manual</option>
                <option value="pagerduty">PagerDuty</option>
                <option value="opsgenie">Opsgenie</option>
                <option value="other">Other tracker</option>
              </select>
            </label>
          </div>
          <label className="small">
            Description (private to this project)
            <textarea className="input" rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="incident-row">
            <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save tag'}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </form>
  );
}
