import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from './api.ts';

export function NewNote() {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const handleCreate = async () => {
    setBusy(true);
    const note = await api.createNote(title);
    navigate(`/notes/${note.id}`);
  };

  return (
    <form>
      <input value={title} onChange={(e) => setTitle(e.target.value)} />
      <button type="button" onClick={handleCreate} disabled={busy}>
        Create note
      </button>
    </form>
  );
}
