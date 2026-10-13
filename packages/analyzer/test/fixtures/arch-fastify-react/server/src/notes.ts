import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function listNotes() {
  const res = await pool.query('SELECT id, title FROM notes ORDER BY id');
  return res.rows;
}

export async function createNote(title: string) {
  const res = await pool.query('INSERT INTO notes (title) VALUES ($1) RETURNING id, title', [title]);
  return res.rows[0];
}
